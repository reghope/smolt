import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * Working-tree changes for the diff pane.
 *
 * Runs git in the session's directory from the main process rather than
 * through the agent, so opening the pane never consumes context or competes
 * with a running turn. Untracked files are included via `--no-index` against
 * an empty tree, which is how they show up as additions.
 */

export interface DiffFile {
	path: string;
	/** Unified diff body for this file, without the leading `diff --git` line. */
	hunks: string;
	added: number;
	removed: number;
	status: "modified" | "added" | "deleted" | "renamed" | "untracked";
}

export interface DiffResult {
	/** Files this chat changed: the tree now, minus how it started. */
	files: DiffFile[];
	/** How many files were already modified when the chat began. */
	preexisting: number;
	/** Current branch, for the composer's repository bar. */
	branch?: string;
	/** Set when the directory is not a git repository, or git is missing. */
	unavailable?: string;
}

/**
 * What the working tree looked like when a chat began, as path → diff body.
 *
 * Without this the pane reports the folder's state rather than the chat's, so
 * a brand new chat in a repository with uncommitted work opens already
 * claiming changes it had nothing to do with.
 */
export type DiffBaseline = Map<string, string>;

/**
 * What the chat's own turns touched.
 *
 * Differing from the chat-open snapshot is not enough to pin a change on the
 * chat: the tree also moves under editors, builds and other sessions while a
 * chat sits open. A file is the chat's only if an agent turn moved it.
 */
export interface DiffAttribution {
	/** Paths a settled turn changed, accumulated across the chat. */
	paths: ReadonlySet<string>;
	/** The tree as a still-running turn found it, so its edits count live. */
	turnStart?: DiffBaseline;
}

/** Tools that write only where their arguments point; attributable without snapshots. */
const PATHED_WRITERS = new Set(["edit", "write"]);
/** Tools that can write anywhere; their work is found by comparing tree snapshots. */
const SWEEPING_WRITERS = new Set(["bash", "powershell"]);

/**
 * What one finished tool call means for attribution: a file it names, a tree
 * sweep, or nothing.
 *
 * Read-only and unknown tools attribute nothing. That errs quiet on purpose:
 * a bar that misses an exotic tool's write beats one that blames the chat for
 * whatever the editor, a build or another session did during the turn.
 */
export function classifyToolCall(name: string, args: unknown): { target?: string; sweeping: boolean } {
	if (SWEEPING_WRITERS.has(name)) return { sweeping: true };
	if (!PATHED_WRITERS.has(name)) return { sweeping: false };
	let record: unknown = args;
	if (typeof args === "string") {
		try {
			record = JSON.parse(args);
		} catch {
			record = undefined;
		}
	}
	const fields = record as { path?: unknown; file_path?: unknown } | undefined;
	const target =
		typeof fields?.path === "string"
			? fields.path
			: typeof fields?.file_path === "string"
				? fields.file_path
				: undefined;
	// An edit whose arguments cannot be read still wrote somewhere: sweep for it.
	return target !== undefined ? { target, sweeping: false } : { sweeping: true };
}

/** A tool-argument path as git will report it: relative to the repo root, forward slashes. */
export function toGitPath(target: string, cwd: string, root: string): string {
	return relative(root, resolve(cwd, target)).replaceAll("\\", "/");
}

/** Paths whose diff body differs between two snapshots, including appearances and disappearances. */
export function changedBetween(before: DiffBaseline, after: DiffBaseline): string[] {
	const paths = new Set([...before.keys(), ...after.keys()]);
	return [...paths].filter((path) => before.get(path) !== after.get(path));
}

/** The baseline and attribution subtraction collectDiff performs, separated from git. */
export function attributeChanges(
	files: DiffFile[],
	baseline?: DiffBaseline,
	attribution?: DiffAttribution,
): { mine: DiffFile[]; preexisting: number } {
	// A file counts as changed-since-open only if its diff differs from the
	// snapshot: untouched pre-existing work is left out, further edits kept.
	const since = baseline ? files.filter((file) => baseline.get(file.path) !== file.hunks) : files;
	const mine = attribution
		? since.filter(
				(file) =>
					attribution.paths.has(file.path) ||
					(attribution.turnStart !== undefined && attribution.turnStart.get(file.path) !== file.hunks),
			)
		: since;
	return { mine, preexisting: files.length - since.length };
}

/**
 * Untracked files whose full body is rendered as a diff. Beyond this the pane
 * lists paths without bodies: a working tree can hold thousands of untracked
 * files (a tool dumped a browser profile, a build wrote an output dir), and
 * one `git diff --no-index` spawn per file froze the whole app.
 */
const UNTRACKED_BODY_LIMIT = 100;
/** Untracked files listed at all; past this the tree is a dump, not a diff. */
const UNTRACKED_LIST_LIMIT = 500;
/** An untracked file bigger than this gets listed, not rendered. */
const UNTRACKED_BODY_MAX_BYTES = 256 * 1024;

/** Everything currently differing from HEAD, including untracked files. */
async function collectRaw(cwd: string): Promise<DiffFile[] | undefined> {
	const inside = await run("git", ["rev-parse", "--is-inside-work-tree"], cwd);
	if (inside.code !== 0 || inside.out.trim() !== "true") return undefined;

	const tracked = await run("git", ["diff", "HEAD", "--no-color"], cwd);
	const files = parseDiff(tracked.out);

	// Untracked files are absent from `git diff`; add them as whole-file
	// additions — bounded, because this used to spawn git once per file with
	// no cap and locked the app when a tool littered thousands of them.
	const untracked = await run("git", ["ls-files", "--others", "--exclude-standard"], cwd);
	const paths = untracked.out
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	let bodies = 0;
	for (const path of paths.slice(0, UNTRACKED_LIST_LIMIT)) {
		let small = false;
		try {
			small = statSync(join(cwd, path)).size <= UNTRACKED_BODY_MAX_BYTES;
		} catch {
			// Unreadable or vanished mid-scan: list it without a body.
		}
		if (small && bodies < UNTRACKED_BODY_LIMIT) {
			bodies++;
			const shown = await run("git", ["diff", "--no-index", "--no-color", "/dev/null", path], cwd);
			const entry = parseDiff(shown.out)[0];
			if (entry) {
				files.push({ ...entry, path, status: "untracked" });
				continue;
			}
		}
		files.push({ path, hunks: "", added: 0, removed: 0, status: "untracked" });
	}
	files.sort((a, b) => a.path.localeCompare(b.path));
	return files;
}

/** Snapshot the tree so later diffs can report only what changed since. */
export async function captureDiffBaseline(cwd: string): Promise<DiffBaseline> {
	const files = await collectRaw(cwd);
	return new Map((files ?? []).map((file) => [file.path, file.hunks]));
}

function run(command: string, args: string[], cwd: string, timeoutMs = 15_000): Promise<{ code: number; out: string }> {
	return new Promise((resolve) => {
		const child = spawn(command, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		const timer = setTimeout(() => child.kill(), timeoutMs);
		child.stdout?.on("data", (chunk: Buffer) => {
			out += chunk.toString();
		});
		child.stderr?.on("data", () => {});
		child.on("error", () => {
			clearTimeout(timer);
			resolve({ code: -1, out: "" });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code: code ?? -1, out });
		});
	});
}

function statusFor(header: string): DiffFile["status"] {
	// These markers sit on their own line, and the first of them starts the
	// header, so anchor per line rather than looking for a leading newline.
	if (/^new file mode/m.test(header)) return "added";
	if (/^deleted file mode/m.test(header)) return "deleted";
	if (/^rename from /m.test(header)) return "renamed";
	return "modified";
}

/** Split `git diff` output into per-file entries. */
export function parseDiff(raw: string): DiffFile[] {
	const files: DiffFile[] = [];
	// Each file section starts at a `diff --git` line.
	const sections = raw.split(/^diff --git /m).slice(1);
	for (const section of sections) {
		const newline = section.indexOf("\n");
		if (newline < 0) continue;
		const pathLine = section.slice(0, newline);
		const body = section.slice(newline + 1);
		// `a/path b/path`; take the second, which is the current name.
		const match = /^"?a\/(.+?)"? "?b\/(.+?)"?$/.exec(pathLine.trim());
		const path = match?.[2] ?? pathLine.trim();
		const hunkStart = body.indexOf("\n@@");
		const hunks = hunkStart >= 0 ? body.slice(hunkStart + 1) : "";
		let added = 0;
		let removed = 0;
		for (const line of hunks.split("\n")) {
			if (line.startsWith("+") && !line.startsWith("+++")) added++;
			else if (line.startsWith("-") && !line.startsWith("---")) removed++;
		}
		files.push({
			path,
			hunks,
			added,
			removed,
			status: statusFor(body.slice(0, hunkStart < 0 ? undefined : hunkStart)),
		});
	}
	return files;
}

/** Changes the chat's turns made since the baseline, plus a count of earlier ones. */
export async function collectDiff(
	cwd: string,
	baseline?: DiffBaseline,
	attribution?: DiffAttribution,
): Promise<DiffResult> {
	const files = await collectRaw(cwd);
	if (!files) {
		return {
			files: [],
			preexisting: 0,
			unavailable: "Not a git repository — the diff pane shows working-tree changes.",
		};
	}

	const { mine, preexisting } = attributeChanges(files, baseline, attribution);
	const branch = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd);
	return {
		files: mine,
		preexisting,
		branch: branch.code === 0 ? branch.out.trim() : undefined,
	};
}
