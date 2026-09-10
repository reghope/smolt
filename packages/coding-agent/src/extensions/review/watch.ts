import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { watchClaimFile } from "./config.ts";

/** A pull request event worth reviewing. */
export interface PullRequestEvent {
	number: number;
	title: string;
	headSha: string;
	/** "owner/name" of the repo the pull request is on. */
	repo: string;
}

/** Actions that mean the code to review has changed. */
const REVIEWABLE = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);

/**
 * The comment that asks for a review by hand.
 *
 * Anywhere in the comment, so "@smolt review please" and a sentence ending in
 * it both work; the mention must lead, so quoting someone else's request in a
 * reply does not fire a second review.
 */
const MENTION = /(^|\s)@smolt\s+review\b/i;

function ghJson<T>(args: string[]): T | undefined {
	try {
		const out = execFileSync("gh", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
		return JSON.parse(out) as T;
	} catch {
		return undefined;
	}
}

/**
 * owner/name of the repo in cwd, taken from the `origin` remote.
 *
 * Deliberately not `gh repo view`: in a fork that resolves to the upstream
 * parent, so watching a fork reported needing admin on someone else's
 * repository rather than on the one the reader actually pushes to.
 */
export function currentRepo(): string | undefined {
	let url: string;
	try {
		url = execFileSync("git", ["remote", "get-url", "origin"], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return undefined;
	}
	// https://github.com/owner/name(.git) and git@github.com:owner/name(.git)
	return /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url)?.[1];
}

/**
 * Whether the reader is an admin of this repo.
 *
 * Watching creates a webhook, and GitHub reserves webhook management for
 * admins — write and even maintain are not enough. Asking first means a repo
 * we cannot watch is reported as such rather than failing at spawn time.
 */
export function isAdmin(repo: string): boolean {
	return ghJson<{ permissions?: { admin?: boolean } }>(["api", `repos/${repo}`])?.permissions?.admin === true;
}

/**
 * Repos the reader could watch: the ones GitHub will let them add a webhook to.
 *
 * Deliberately not `gh repo list`, which lists only what the reader OWNS: most
 * people administer their team's repositories through an organisation, and the
 * repo open in the session is very often one of those. `user/repos` with the
 * affiliations spelled out returns those too, each carrying the permission
 * bits, so admin is read rather than guessed.
 */
export function adminRepos(): string[] {
	const repos = ghJson<{ full_name?: string; permissions?: { admin?: boolean } }[]>([
		"api",
		"-H",
		"accept: application/vnd.github+json",
		"user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member",
	]);
	const names = new Set(
		(repos ?? [])
			.filter((repo) => repo.permissions?.admin === true)
			.map((repo) => repo.full_name)
			.filter((name): name is string => typeof name === "string"),
	);
	// The repo open here matters more than any of the others, and one page of
	// results may not reach it, so it is asked about directly rather than hoped for.
	const here = currentRepo();
	if (here !== undefined && !names.has(here) && isAdmin(here)) names.add(here);
	return [...names].sort();
}

/** Is the webhook-forwarding extension installed? */
export function forwardingAvailable(): boolean {
	try {
		execFileSync("gh", ["webhook", "--help"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/** The events the forwarder's webhook must carry for both triggers to work. */
const FORWARDED_EVENTS = ["pull_request", "issue_comment"];

/**
 * Remove the forwarder's webhook from a previous run, if one is still there.
 *
 * `gh webhook forward` cannot reuse an existing hook: the relay's websocket
 * address is only handed out in the creation response, and GitHub allows one
 * forwarder hook per repository, so a hook left behind by a killed session
 * makes every later run die with "Hook already exists" until the relay quietly
 * reclaims it. Deleting first makes each connection create a fresh hook that
 * is genuinely ours and carries the events we asked for.
 */
function removeStaleForwarderHook(repo: string): void {
	const hooks = ghJson<{ id?: number; config?: { url?: string } }[]>(["api", `repos/${repo}/hooks`]);
	for (const hook of hooks ?? []) {
		if (!hook.config?.url?.includes("webhook-forwarder.github.com") || typeof hook.id !== "number") continue;
		try {
			execFileSync("gh", ["api", "--method", "DELETE", `repos/${repo}/hooks/${hook.id}`], { stdio: "ignore" });
		} catch {
			// not ours to remove, or admin revoked: creation below will report it
		}
	}
}

interface Hooks {
	/** A pull request needs reviewing. */
	review: (event: PullRequestEvent) => void;
	/** Something the reader should see: connected, disconnected, failed. */
	notice: (message: string, kind: "info" | "warning") => void;
}

interface WatchClaim {
	pid: number;
	at: number;
}

function readClaim(file: string): WatchClaim | undefined {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<WatchClaim>;
		if (typeof parsed.pid !== "number") return undefined;
		return { pid: parsed.pid, at: parsed.at ?? 0 };
	} catch {
		return undefined;
	}
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Take (or re-take) the claim on a repo's webhook.
 *
 * GitHub allows one forwarder hook per repository, and installing one deletes
 * any other, so two sessions watching the same repo would take turns silently
 * destroying each other's connection — the loser looks healthy and receives
 * nothing. The claim file gives the webhook an owner: a watcher without it
 * stands down and says so, and a claim left by a dead process is free to take.
 */
function claimWebhook(repo: string): boolean {
	const file = watchClaimFile(repo);
	const claim = readClaim(file);
	if (claim !== undefined && claim.pid !== process.pid && processAlive(claim.pid)) return false;
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify({ pid: process.pid, at: Date.now() } satisfies WatchClaim)}\n`, "utf-8");
	return true;
}

/** Release our own claim, leaving everyone else's alone. */
function releaseWebhook(repo: string): void {
	const file = watchClaimFile(repo);
	if (!existsSync(file)) return;
	const claim = readClaim(file);
	if (claim !== undefined && claim.pid !== process.pid) return;
	try {
		unlinkSync(file);
	} catch {
		// already gone
	}
}

/**
 * Watch a repo for pull requests, and review them as they arrive.
 *
 * `gh webhook forward` holds an OUTBOUND connection to GitHub's forwarder and
 * prints each delivery to stdout as one JSON line. Because this machine does
 * the dialling, there is no address to expose, no port to open, no tunnel and
 * no webhook secret to verify: nothing can reach us that we did not ask for.
 * The cost is that GitHub must accept a webhook on the repo, which is why the
 * caller checks for admin first.
 */
export function watchAll(repos: string[], hooks: Hooks): () => void {
	let stops = repos.map((repo) => startWatching(repo, hooks));
	const stopAll = (): void => {
		for (const stop of stops) stop();
		stops = [];
	};
	// A clean shutdown already calls this, but smolt does not always get one:
	// an orphaned forwarder holds the relay connection and swallows deliveries,
	// which looks exactly like a working webhook that never fires.
	process.once("exit", stopAll);

	// A signal is a request to end the process, not to stop watching, and simply
	// having a listener for one suppresses Node's own answer to it. With a repo
	// watched, Ctrl+C therefore killed the forwarders and left smolt running
	// with no way to quit: the listener that existed only to tidy up had taken
	// the terminate away. What the handler does now depends on who else is
	// listening, because that is what the signal would have done without us.
	const handlers = new Map<NodeJS.Signals, () => void>();
	const onSignal = (signal: NodeJS.Signals): void => {
		// Our own listener was a 'once' and has already gone, so this counts the
		// others. One of them owns the signal — the TUI ignores SIGINT for as
		// long as it is suspended, and quitting has its own handler — and a
		// suspend is not a shutdown, so watching is left running and armed. It
		// is torn down by 'exit' if the process does end up going.
		if (process.listenerCount(signal) > 0) {
			const handler = handlers.get(signal);
			if (handler) process.once(signal, handler);
			return;
		}
		// Nobody else is listening, so terminating is what this signal meant
		// before we came along. The forwarders go first, then the process.
		stopAll();
		// Re-raising is the faithful way to do that, but only where a signal can
		// be raised on oneself: on Windows process.kill against our own pid does
		// not run handlers at all, it destroys the process on the spot, which
		// would take the terminal's cooked mode down with it. There the exit
		// code a shell reports for the signal is used instead.
		if (process.platform === "win32") process.exit(signal === "SIGINT" ? 130 : 143);
		process.kill(process.pid, signal);
	};
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		const handler = (): void => onSignal(signal);
		handlers.set(signal, handler);
		process.once(signal, handler);
	}

	return () => {
		process.off("exit", stopAll);
		for (const [signal, handler] of handlers) process.off(signal, handler);
		stopAll();
	};
}

// No silence timeout: an idle forwarder prints nothing at all — its only
// output is the line it writes per delivery — so treating quiet as a broken
// pipe killed a healthy watcher every fifteen minutes on a repo nobody had
// opened a pull request against. A dead connection ends the child, and that
// is what reconnects.

/**
 * How many times a forward may die almost immediately before we stop trying.
 *
 * Retrying for ever is how a revoked admin right or an expired `gh` login
 * turns into a warning a minute for the rest of the session. A connection that
 * survived a while and then dropped is a different thing — that is the network,
 * and it is worth reconnecting for ever — so only short-lived attempts count.
 */
const MAX_FAILED_ATTEMPTS = 5;
const SETTLED_MS = 60_000;

/**
 * How often a session that stood down re-tries the claim.
 *
 * Standing down for ever meant that when the session holding the claim died
 * badly — killed, crashed, machine slept — nobody took the repo over. The
 * claim file pointed at a dead process, its orphaned forwarder went on
 * swallowing deliveries, and every later session reported itself as watching
 * while receiving nothing. Checking back means the first live session picks
 * the repo up within a minute of the owner going.
 */
const STANDBY_RETRY_MS = 60_000;

function startWatching(repo: string, hooks: Hooks): () => void {
	let stopped = false;
	let child: ReturnType<typeof spawn> | undefined;
	let retry: ReturnType<typeof setTimeout> | undefined;
	let backoffMs = 2000;
	let failures = 0;
	let connectedAt = 0;
	/** Whether the reader has already been told this session is on standby. */
	let announcedStandby = false;

	const reconnect = (why: string): void => {
		if (stopped) return;
		child?.kill();
		child = undefined;
		failures = Date.now() - connectedAt > SETTLED_MS ? 0 : failures + 1;
		if (failures >= MAX_FAILED_ATTEMPTS) {
			stopped = true;
			// The claim goes with the watcher. Kept after giving up, it names a
			// process that is alive and no longer watching, so every standby
			// session on this machine waits behind it for as long as smolt runs
			// — an expired 'gh' login here locked the repo out of all of them.
			releaseWebhook(repo);
			hooks.notice(
				`Gave up watching ${repo}: the forwarder failed ${failures} times in a row. Check 'gh auth status' ` +
					"and that you still have admin on it, then run /review setup again.",
				"warning",
			);
			return;
		}
		hooks.notice(`${why} watching ${repo}; reconnecting.`, "warning");
		retry = setTimeout(connect, backoffMs);
		backoffMs = Math.min(backoffMs * 2, 60_000);
	};

	const connect = (): void => {
		if (stopped) return;
		// Every connect re-takes the claim: this process losing it (another
		// session took the repo over after a crash left a stale claim) must end
		// the watcher instead of silently deleting the new owner's hook.
		if (!claimWebhook(repo)) {
			// Standby, not stopped: the claim is re-tried until the session that
			// holds it exits, and this one takes over the moment it does.
			if (!announcedStandby) {
				announcedStandby = true;
				hooks.notice(
					`Another smolt session is already watching ${repo}; this one is on standby and takes over when that session exits.`,
					"info",
				);
			}
			retry = setTimeout(connect, STANDBY_RETRY_MS);
			return;
		}
		if (announcedStandby) {
			announcedStandby = false;
			hooks.notice(`Watching ${repo}: the session that held it has gone.`, "info");
		}
		removeStaleForwarderHook(repo);
		child = spawn("gh", ["webhook", "forward", `--events=${FORWARDED_EVENTS.join(",")}`, `--repo=${repo}`], {
			// Not detached: the forwarder must die with smolt. An orphan keeps the
			// relay connection open and swallows every delivery into a stdout
			// nobody reads, so the next session sees a healthy hook and no events.
			detached: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		connectedAt = Date.now();
		// Without this, a spawn that fails (gh upgraded out from under us, no file
		// handles left) emits 'error' with no listener, which EventEmitter rethrows
		// and nothing catches: the whole session dies for a background watcher.
		child.on("error", (error: Error) => reconnect(`Could not start the forwarder (${error.message})`));
		let buffer = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf-8");
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				// The forwarder interleaves its own '[LOG] ...' lines with payloads;
				// a payload is simply the line that parses as a pull_request event.
				if (!line.startsWith("{")) continue;
				let payload: {
					action?: string;
					number?: number;
					pull_request?: Record<string, unknown>;
					issue?: { number?: number; title?: string; pull_request?: unknown };
					comment?: { body?: string };
				};
				try {
					payload = JSON.parse(line);
				} catch {
					continue;
				}
				// "@smolt review" on a pull request: a review asked for by hand, on
				// code that has not changed since the last one, which is why it is not
				// folded into the pull_request path above.
				const issue = payload.issue;
				if (payload.comment && issue?.pull_request && typeof issue.number === "number") {
					if (payload.action !== "created" && payload.action !== "edited") continue;
					if (!MENTION.test(payload.comment.body ?? "")) continue;
					backoffMs = 2000;
					failures = 0;
					hooks.review({
						number: issue.number,
						title: typeof issue.title === "string" ? issue.title : `#${issue.number}`,
						headSha: "",
						repo,
					});
					continue;
				}
				const pr = payload.pull_request;
				if (!pr || typeof payload.action !== "string" || !REVIEWABLE.has(payload.action)) continue;
				if (pr.draft === true) continue;
				const number = typeof payload.number === "number" ? payload.number : Number(pr.number);
				const head = pr.head as { sha?: string } | undefined;
				if (!Number.isFinite(number)) continue;
				// A live connection has proved itself; forget any earlier backoff.
				backoffMs = 2000;
				failures = 0;
				hooks.review({
					number,
					title: typeof pr.title === "string" ? pr.title : `#${number}`,
					headSha: head?.sha ?? "",
					repo,
				});
			}
		});
		child.on("exit", () => reconnect("Lost the connection"));
	};

	connect();
	return () => {
		stopped = true;
		if (retry) clearTimeout(retry);
		child?.kill();
		releaseWebhook(repo);
	};
}
