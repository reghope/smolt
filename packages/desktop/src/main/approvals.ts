import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { requestsDir } from "../../../coding-agent/src/extensions/permissions/index.ts";

/**
 * Carries permission questions from the agent process to the window.
 *
 * The agent runs as its own process and cannot call into the renderer, so it
 * writes a request file and waits for a reply beside it. This watches that
 * directory and hands each new request to the window; the answer is written
 * back as the file the agent is polling for.
 */

export interface PermissionRequest {
	id: string;
	tool: string;
	summary: string;
	mode: string;
	createdAt: number;
}

function readRequest(dir: string, name: string): PermissionRequest | undefined {
	try {
		const parsed = JSON.parse(readFileSync(join(dir, name), "utf-8")) as PermissionRequest;
		return typeof parsed.id === "string" && typeof parsed.tool === "string" ? parsed : undefined;
	} catch {
		// A half-written file simply arrives on the next event.
		return undefined;
	}
}

/** The owning agent's pid, from a request id of the form `<pid>-<counter>`. */
export function requestPid(id: string): number | undefined {
	const pid = Number.parseInt(id, 10);
	return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * Watch for new requests, replaying any already waiting, and report removals:
 * a request whose file disappeared was answered elsewhere or expired, and a
 * window still showing its card would be inviting a decision that no longer
 * exists.
 */
export function watchPermissionRequests(
	onRequest: (request: PermissionRequest) => void,
	onRemoved?: (id: string) => void,
): () => void {
	const dir = requestsDir();
	mkdirSync(dir, { recursive: true });
	const seen = new Set<string>();

	const sweep = (): void => {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of names) {
			if (!name.endsWith(".json") || seen.has(name)) continue;
			const request = readRequest(dir, name);
			if (!request) continue;
			seen.add(name);
			onRequest(request);
		}
		for (const name of [...seen]) {
			if (names.includes(name)) continue;
			seen.delete(name);
			if (onRemoved) onRemoved(name.replace(/\.json$/, ""));
		}
	};

	sweep();
	const watcher = watch(dir, () => sweep());
	// fs.watch misses events on some filesystems; a slow poll covers the gap.
	const timer = setInterval(sweep, 1000);
	return () => {
		watcher.close();
		clearInterval(timer);
	};
}

/** Requests already on disk, for a window that started after they arrived. */
export function pendingPermissionRequests(): PermissionRequest[] {
	const dir = requestsDir();
	try {
		return readdirSync(dir)
			.filter((name) => name.endsWith(".json"))
			.map((name) => readRequest(dir, name))
			.filter((request): request is PermissionRequest => request !== undefined)
			.sort((a, b) => a.createdAt - b.createdAt);
	} catch {
		return [];
	}
}

export function writePermissionReply(id: string, answer: string): void {
	const allowed = answer === "allow" || answer === "always" || answer === "deny";
	if (!allowed) throw new Error(`Unknown permission answer: ${answer}`);
	// Guard the id so a reply can never be written outside the directory.
	if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Unsafe request id: ${id}`);
	const dir = requestsDir();
	// A decision needs a live question to attach to. Writing a reply for a
	// vanished request would linger unread and could answer a later reuse of
	// the id — the file-based equivalent of clicking a button nobody asked about.
	if (!existsSync(join(dir, `${id}.json`))) throw new Error(`No pending permission request "${id}"`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${id}.reply`), answer, "utf-8");
}

/** Remove a request and its reply, used when the window gives up on one. */
export function clearPermissionRequest(id: string): void {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) return;
	const dir = requestsDir();
	rmSync(join(dir, `${id}.json`), { force: true });
	rmSync(join(dir, `${id}.reply`), { force: true });
}
