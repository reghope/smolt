import { execFileSync, spawn } from "node:child_process";

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

interface Hooks {
	/** A pull request needs reviewing. */
	review: (event: PullRequestEvent) => void;
	/** Something the reader should see: connected, disconnected, failed. */
	notice: (message: string, kind: "info" | "warning") => void;
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
	const stops = repos.map((repo) => startWatching(repo, hooks));
	const stopAll = (): void => {
		for (const stop of stops) stop();
	};
	// A clean shutdown already calls this, but smolt does not always get one:
	// an orphaned forwarder holds the relay connection and swallows deliveries,
	// which looks exactly like a working webhook that never fires.
	process.once("exit", stopAll);
	process.once("SIGINT", stopAll);
	process.once("SIGTERM", stopAll);
	return () => {
		process.off("exit", stopAll);
		process.off("SIGINT", stopAll);
		process.off("SIGTERM", stopAll);
		stopAll();
	};
}

/**
 * How long total silence is allowed before the connection is presumed dead.
 *
 * A forwarder whose relay connection has dropped keeps running and keeps
 * printing nothing, so judging health by "is the process alive" misses it
 * completely: a pull request arrived, GitHub's relay answered OK, and the
 * event went nowhere. The forwarder emits keep-alive chatter, so a gap this
 * long with no bytes at all means the pipe is broken, not that the repo is
 * quiet.
 */
const SILENCE_TIMEOUT_MS = 15 * 60 * 1000;

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

function startWatching(repo: string, hooks: Hooks): () => void {
	let stopped = false;
	let child: ReturnType<typeof spawn> | undefined;
	let retry: ReturnType<typeof setTimeout> | undefined;
	let silence: ReturnType<typeof setTimeout> | undefined;
	let backoffMs = 2000;
	let failures = 0;
	let connectedAt = 0;

	const reconnect = (why: string): void => {
		if (stopped) return;
		if (silence) clearTimeout(silence);
		child?.kill();
		child = undefined;
		failures = Date.now() - connectedAt > SETTLED_MS ? 0 : failures + 1;
		if (failures >= MAX_FAILED_ATTEMPTS) {
			stopped = true;
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

	// Any output at all proves the pipe is alive, so the clock restarts on it.
	const heardSomething = (): void => {
		if (silence) clearTimeout(silence);
		silence = setTimeout(() => reconnect("Heard nothing for fifteen minutes"), SILENCE_TIMEOUT_MS);
	};

	const connect = (): void => {
		if (stopped) return;
		child = spawn("gh", ["webhook", "forward", "--events=pull_request", `--repo=${repo}`], {
			// Not detached: the forwarder must die with smolt. An orphan keeps the
			// relay connection open and swallows every delivery into a stdout
			// nobody reads, so the next session sees a healthy hook and no events.
			detached: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		connectedAt = Date.now();
		heardSomething();
		// Without this, a spawn that fails (gh upgraded out from under us, no file
		// handles left) emits 'error' with no listener, which EventEmitter rethrows
		// and nothing catches: the whole session dies for a background watcher.
		child.on("error", (error: Error) => reconnect(`Could not start the forwarder (${error.message})`));
		child.stderr?.on("data", heardSomething);
		let buffer = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			heardSomething();
			buffer += chunk.toString("utf-8");
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				// The forwarder interleaves its own '[LOG] ...' lines with payloads;
				// a payload is simply the line that parses as a pull_request event.
				if (!line.startsWith("{")) continue;
				let payload: { action?: string; number?: number; pull_request?: Record<string, unknown> };
				try {
					payload = JSON.parse(line);
				} catch {
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
		if (silence) clearTimeout(silence);
		child?.kill();
	};
}
