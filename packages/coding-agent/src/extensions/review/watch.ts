import { execFileSync, spawn } from "node:child_process";

/** A pull request event worth reviewing. */
export interface PullRequestEvent {
	number: number;
	title: string;
	headSha: string;
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
export function startWatching(repo: string, hooks: Hooks): () => void {
	let stopped = false;
	let child: ReturnType<typeof spawn> | undefined;
	let retry: ReturnType<typeof setTimeout> | undefined;
	let backoffMs = 2000;

	const connect = (): void => {
		if (stopped) return;
		child = spawn("gh", ["webhook", "forward", "--events=pull_request", `--repo=${repo}`], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let buffer = "";
		child.stdout?.on("data", (chunk: Buffer) => {
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
				hooks.review({
					number,
					title: typeof pr.title === "string" ? pr.title : `#${number}`,
					headSha: head?.sha ?? "",
				});
			}
		});
		child.on("exit", () => {
			if (stopped) return;
			hooks.notice(`Lost the connection watching ${repo}; reconnecting.`, "warning");
			retry = setTimeout(connect, backoffMs);
			backoffMs = Math.min(backoffMs * 2, 60_000);
		});
	};

	connect();
	return () => {
		stopped = true;
		if (retry) clearTimeout(retry);
		child?.kill();
	};
}
