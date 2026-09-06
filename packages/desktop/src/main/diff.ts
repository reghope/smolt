import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
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
	/** Everything this branch changed: every commit on it, plus the working tree. */
	files: DiffFile[];
	/** How many files were already modified when the chat began. */
	preexisting: number;
	/** Files changed in all, counting any the list leaves out. */
	changed: number;
	/** Lines added and removed across every changed file, listed or not. */
	added: number;
	removed: number;
	/** Untracked files counted in the totals but left off the list. */
	unlisted: number;
	/** Current branch, for the composer's repository bar. */
	branch?: string;
	/** The branch this one is measured against, when it has one. */
	baseBranch?: string;
	/** True when the branch has commits of its own beyond the working tree. */
	hasCommits?: boolean;
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
 * Untracked files whose lines are counted, in git's listing order.
 *
 * The same ceiling Claude Code's changes bar uses, so the two agree on a
 * tree: the next as many are listed as files with no lines, and anything
 * past that is left out altogether. A tree with hundreds of untracked files
 * is a dump, and totalling every line of it says more about the dump than
 * about the branch.
 */
const UNTRACKED_COUNT_LIMIT = 200;
/** Untracked files listed at all; past this they are omitted from the diff. */
const UNTRACKED_LIST_LIMIT = UNTRACKED_COUNT_LIMIT * 2;
/**
 * Untracked files whose full body is rendered as a diff. Only this many get
 * a body, because the pane has to hold whatever it is handed and a build's
 * output directory is not reading matter.
 */
const UNTRACKED_BODY_LIMIT = 100;
/** Files listed in the pane at all; the totals still count the rest. */
const LIST_LIMIT = 2000;
/** An untracked file bigger than this is counted, never rendered. */
const UNTRACKED_BODY_MAX_BYTES = 256 * 1024;
/** An untracked file bigger than this is not read at all: one file, no lines. */
const UNTRACKED_READ_MAX_BYTES = 16 * 1024 * 1024;
/** Untracked files read at once while counting. */
const READ_CONCURRENCY = 32;

const NOT_A_REPO = "This folder is not a git repository, so there is nothing to compare against.";

/** What the branch is measured from: its merge base with its base branch, or HEAD. */
interface DiffScope {
	branch?: string;
	since: string;
	baseBranch?: string;
}

/**
 * The base among the refs git listed: the remote's default first, then the
 * usual names in the order a repository is likely to use them.
 *
 * `listing` is `for-each-ref` output, one `name<TAB>symref-target` per line.
 * A branch that is itself the default has no base, and says so with undefined.
 */
export function baseBranchAmong(listing: string, head: string): string | undefined {
	const present = new Set<string>();
	const candidates: string[] = [];
	for (const line of listing.split("\n")) {
		const [name, target] = line.split("\t");
		if (!name) continue;
		if (name === "origin/HEAD") {
			// The remote's own default is the honest answer when it is known.
			if (target) {
				candidates.push(target);
				present.add(target);
			}
			continue;
		}
		present.add(name);
	}
	candidates.push("origin/main", "origin/master", "main", "master");
	for (const candidate of candidates) {
		// The branch cannot be its own base; that would diff to nothing and
		// hide every uncommitted change on the default branch.
		if (candidate === head || candidate === `origin/${head}`) continue;
		if (present.has(candidate)) return candidate;
	}
	return undefined;
}

/**
 * Where the branch is measured from, in two rounds of git rather than one
 * per candidate ref: every ref that could be the base is listed in a single
 * call, and only the winner goes on to merge-base.
 */
async function resolveScope(cwd: string): Promise<DiffScope> {
	const [headRef, refs] = await Promise.all([
		run("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd),
		run(
			"git",
			[
				"for-each-ref",
				"--format=%(refname:short)\t%(symref:short)",
				"refs/remotes/origin/HEAD",
				"refs/remotes/origin/main",
				"refs/remotes/origin/master",
				"refs/heads/main",
				"refs/heads/master",
			],
			cwd,
		),
	]);
	const branch = headRef.code === 0 ? headRef.out.trim() : undefined;
	const base = branch ? baseBranchAmong(refs.out, branch) : undefined;
	if (!base) return { branch, since: "HEAD" };
	const mergeBase = await run("git", ["merge-base", "HEAD", base], cwd);
	const since = mergeBase.out.trim();
	if (mergeBase.code !== 0 || since === "") return { branch, since: "HEAD" };
	return { branch, since, baseBranch: base };
}

/** The repository's top directory, or undefined outside one (or without git). */
async function repoRoot(cwd: string): Promise<string | undefined> {
	const top = await run("git", ["rev-parse", "--show-toplevel"], cwd);
	const root = top.out.trim();
	return top.code === 0 && root !== "" ? root : undefined;
}

/**
 * Lines in a file's contents, or undefined when it is binary.
 *
 * Git's own rule: a NUL in the first 8000 bytes means binary. A last line
 * with no newline after it still counts, as `git diff` counts it.
 */
export function countLines(bytes: Uint8Array): number | undefined {
	if (bytes.subarray(0, 8000).includes(0)) return undefined;
	let lines = 0;
	for (let at = bytes.indexOf(10); at !== -1; at = bytes.indexOf(10, at + 1)) lines++;
	if (bytes.length > 0 && bytes[bytes.length - 1] !== 10) lines++;
	return lines;
}

/** A whole new file as one hunk, the way `git diff --no-index` would show it. */
export function additionHunk(text: string): string {
	const lines = text.split("\n");
	const newlineAtEnd = lines[lines.length - 1] === "";
	if (newlineAtEnd) lines.pop();
	if (lines.length === 0) return "";
	const body = lines.map((line) => `+${line}`).join("\n");
	return `@@ -0,0 +1,${lines.length} @@\n${body}\n${newlineAtEnd ? "" : "\\ No newline at end of file\n"}`;
}

interface UntrackedFile {
	/** Repo-relative, forward slashes, as git reports it. */
	path: string;
	/** Lines in the file; 0 for a binary, an unreadable one, or one too big to read. */
	lines: number;
	/** The file's text, for the few that get a body. */
	text?: string;
}

/** Every untracked path from the repository root, whatever directory git ran in. */
async function listUntracked(cwd: string): Promise<string[]> {
	const listed = await run(
		"git",
		["ls-files", "--others", "--exclude-standard", "--full-name", "-z", "--", ":/"],
		cwd,
	);
	return listed.out.split("\0").filter((path) => path !== "");
}

/**
 * Count the untracked files, reading them here rather than asking git.
 *
 * This used to spawn `git diff --no-index` once per file, which cost a
 * process each. Reading the bytes directly is cheap. The first
 * UNTRACKED_COUNT_LIMIT files in git's order are counted, the next as many
 * are listed with no lines, and the rest are dropped, which is the rule
 * Claude Code's bar follows. Bodies go to the first `bodies` counted files
 * that are small enough to show.
 */
/**
 * Line counts already taken, by file, with the size and mtime they were
 * taken at. The bar is re-read every few seconds and on every turn, and a
 * tree with hundreds of untracked files was being read in full each time;
 * a file whose size and mtime have not moved has the same number of lines
 * it had, so only a stat is spent on it.
 */
const lineCounts = new Map<string, { size: number; mtimeMs: number; lines: number | undefined }>();

async function readUntracked(root: string, paths: string[], bodies: number): Promise<UntrackedFile[]> {
	// Listed to one ceiling, counted to a lower one: the files past the count
	// limit stay in the list with no lines, and those past the list limit are
	// not the diff's business at all.
	const files: UntrackedFile[] = paths.slice(0, UNTRACKED_LIST_LIMIT).map((path) => ({ path, lines: 0 }));
	const counted = Math.min(files.length, UNTRACKED_COUNT_LIMIT);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < counted) {
			const index = next++;
			const file = files[index]!;
			const absolute = join(root, file.path);
			try {
				const info = await stat(absolute);
				const size = info.size;
				if (size > UNTRACKED_READ_MAX_BYTES) continue;
				const wantBody = index < bodies && size <= UNTRACKED_BODY_MAX_BYTES;
				const known = lineCounts.get(absolute);
				if (!wantBody && known && known.size === size && known.mtimeMs === info.mtimeMs) {
					if (known.lines !== undefined) file.lines = known.lines;
					continue;
				}
				const bytes = await readFile(absolute);
				const lines = countLines(bytes);
				lineCounts.set(absolute, { size, mtimeMs: info.mtimeMs, lines });
				if (lines === undefined) continue;
				file.lines = lines;
				if (wantBody) file.text = bytes.toString("utf8");
			} catch {
				// Vanished or unreadable mid-scan: listed, with no lines.
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, counted) }, worker));
	return files;
}

/**
 * Everything differing from `since`, including untracked files.
 *
 * With a merge-base as `since` this is the whole branch: every commit on it
 * as well as the working tree. With HEAD it is the working tree alone.
 */
async function collectRaw(cwd: string, since = "HEAD"): Promise<DiffFile[] | undefined> {
	const root = await repoRoot(cwd);
	if (!root) return undefined;
	const [tracked, untracked] = await Promise.all([
		run("git", ["diff", "-M", "--no-color", since], cwd),
		listUntracked(cwd).then((paths) => readUntracked(root, paths, UNTRACKED_BODY_LIMIT)),
	]);
	const files = parseDiff(tracked.out);
	for (const file of untracked) {
		files.push({
			path: file.path,
			hunks: file.text === undefined ? "" : additionHunk(file.text),
			added: file.lines,
			removed: 0,
			status: "untracked",
		});
	}
	files.sort(byPath);
	return files;
}

function byPath(a: DiffFile, b: DiffFile): number {
	return a.path.localeCompare(b.path);
}

/** Snapshot the tree so later diffs can report only what changed since. */
export async function captureDiffBaseline(cwd: string): Promise<DiffBaseline> {
	const files = await collectRaw(cwd);
	return new Map((files ?? []).map((file) => [file.path, file.hunks]));
}

function run(
	command: string,
	args: string[],
	cwd: string,
	timeoutMs = 15_000,
): Promise<{ code: number; out: string; err: string }> {
	return new Promise((resolve) => {
		const child = spawn(command, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		// Kept, not dropped: git says nothing useful here, but gh reports every
		// refusal on stderr, and a button that fails owes the reason.
		let err = "";
		const timer = setTimeout(() => child.kill(), timeoutMs);
		child.stdout?.on("data", (chunk: Buffer) => {
			out += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			err += chunk.toString();
		});
		child.on("error", () => {
			clearTimeout(timer);
			resolve({ code: -1, out: "", err: "" });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code: code ?? -1, out, err });
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

/** What a pull request for the current branch would need, and what blocks it. */
export interface PrReadiness {
	branch?: string;
	baseBranch?: string;
	/** Commits on the branch that the base does not have. */
	ahead: number;
	/** Uncommitted work that would not be part of the pull request. */
	uncommitted: number;
	/** Whether the branch exists on the remote yet. */
	pushed: boolean;
	/** The GitHub compare URL, for opening one by hand. */
	compareUrl?: string;
	/** Why a pull request cannot be opened from here, if it cannot. */
	blocked?: string;
}

/** Turn a remote URL, SSH or HTTPS, into its https://host/owner/repo form. */
export function webUrlOf(remote: string): string | undefined {
	const trimmed = remote.trim().replace(/\.git$/, "");
	const ssh = /^git@([^:]+):(.+)$/.exec(trimmed);
	if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
	if (/^https?:\/\//.test(trimmed)) return trimmed;
	return undefined;
}

/** This checkout's `origin` as a page to open, or undefined without one. */
export async function remoteWebUrl(cwd: string): Promise<string | undefined> {
	const remote = await run("git", ["remote", "get-url", "origin"], cwd);
	if (remote.code !== 0) return undefined;
	return webUrlOf(remote.out);
}

/**
 * Everything the pull-request controls need to know, read straight from git.
 *
 * Gathered in one pass so the button can say what it will do before it is
 * pressed: a branch with nothing to merge, or one that has never been pushed,
 * is a different situation from one that is ready, and each deserves its own
 * words rather than a failure after the click.
 */
export async function prReadiness(cwd: string): Promise<PrReadiness> {
	if (!(await repoRoot(cwd))) {
		return { ahead: 0, uncommitted: 0, pushed: false, blocked: "Not a git repository." };
	}

	const { branch, since, baseBranch } = await resolveScope(cwd);
	if (!branch || branch === "HEAD") {
		return { ahead: 0, uncommitted: 0, pushed: false, blocked: "No branch is checked out." };
	}
	if (!baseBranch) {
		return {
			branch,
			ahead: 0,
			uncommitted: 0,
			pushed: false,
			blocked: `${branch} is the default branch, so there is nothing to merge it into.`,
		};
	}

	const [aheadOut, status, remoteBranch, remote] = await Promise.all([
		run("git", ["rev-list", "--count", `${since}..HEAD`], cwd),
		run("git", ["status", "--porcelain"], cwd),
		run("git", ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], cwd),
		run("git", ["remote", "get-url", "origin"], cwd),
	]);
	const ahead = aheadOut.code === 0 ? Number(aheadOut.out.trim()) || 0 : 0;
	const uncommitted = status.out.split("\n").filter((line) => line.trim() !== "").length;
	const pushed = remoteBranch.code === 0 && remoteBranch.out.trim() !== "";
	const web = remote.code === 0 ? webUrlOf(remote.out) : undefined;
	const compareUrl = web ? `${web}/compare/${baseBranch.replace(/^origin\//, "")}...${branch}?expand=1` : undefined;

	return {
		branch,
		baseBranch,
		ahead,
		uncommitted,
		pushed,
		compareUrl,
		blocked: ahead === 0 ? `${branch} has no commits that ${baseBranch} does not already have.` : undefined,
	};
}

/**
 * Open a pull request for the current branch with the GitHub CLI.
 *
 * The branch is pushed first when the remote has never seen it, because
 * `gh pr create` fails outright on an unpushed branch, and "set an upstream
 * first" is not an error worth handing back to someone who just pressed a
 * button marked Create PR.
 */
export async function createPullRequest(
	cwd: string,
	draft: boolean,
): Promise<{ ok: boolean; url?: string; error?: string }> {
	const ready = await prReadiness(cwd);
	if (ready.blocked) return { ok: false, error: ready.blocked };
	if (!ready.pushed && ready.branch) {
		const push = await run("git", ["push", "--set-upstream", "origin", ready.branch], cwd, 120_000);
		if (push.code !== 0) {
			const said = push.err.trim().split("\n").slice(0, 2).join(" ");
			return { ok: false, error: said || `Could not push ${ready.branch} to origin.` };
		}
	}
	const args = ["pr", "create", "--fill"];
	if (draft) args.push("--draft");
	const created = await run("gh", args, cwd, 120_000);
	if (created.code === -1) return { ok: false, error: "The GitHub CLI (gh) is not installed or not on PATH." };
	if (created.code !== 0) {
		const said = (created.err.trim() || created.out.trim()).split("\n").slice(0, 3).join(" ");
		return { ok: false, error: said || "Could not create the pull request." };
	}
	return { ok: true, url: /https:\/\/\S+/.exec(created.out)?.[0] };
}

/** Whether the branch carries commits of its own beyond `since`. */
async function branchHasCommits(cwd: string, since: string): Promise<boolean> {
	const count = await run("git", ["rev-list", "--count", `${since}..HEAD`], cwd);
	return count.code === 0 && Number(count.out.trim()) > 0;
}

/**
 * Everything the current branch has changed: its commits and its working tree.
 *
 * The scope is the branch, not the chat. A branch is what gets reviewed and
 * what becomes a pull request, so measuring against the branch's base answers
 * the question actually being asked — "what would I be merging?" — rather
 * than "what did this particular conversation touch", which splits one piece
 * of work across however many chats it took.
 *
 * On the default branch itself there is no base to measure from, so the scope
 * falls back to the working tree against HEAD.
 */
export async function collectDiff(cwd: string): Promise<DiffResult> {
	const scope = await resolveScope(cwd);
	const [files, hasCommits] = await Promise.all([
		collectRaw(cwd, scope.since),
		// Whether the branch carries commits decides what a pull request would
		// even contain, so the bar can offer one only when there is something
		// to open it with.
		scope.baseBranch ? branchHasCommits(cwd, scope.since) : false,
	]);
	if (!files) {
		return { files: [], preexisting: 0, changed: 0, added: 0, removed: 0, unlisted: 0, unavailable: NOT_A_REPO };
	}

	let added = 0;
	let removed = 0;
	for (const file of files) {
		added += file.added;
		removed += file.removed;
	}

	// The list has a ceiling the totals do not. Past it the untracked files
	// go first: a tree with thousands of them is a dump, and the tracked
	// changes are what a reader came to see.
	let listed = files;
	if (files.length > LIST_LIMIT) {
		const tracked = files.filter((file) => file.status !== "untracked");
		const untracked = files.filter((file) => file.status === "untracked");
		listed = [...tracked, ...untracked.slice(0, Math.max(0, LIST_LIMIT - tracked.length))].sort(byPath);
	}

	return {
		files: listed,
		preexisting: 0,
		branch: scope.branch,
		baseBranch: scope.baseBranch,
		hasCommits,
		changed: files.length,
		added,
		removed,
		unlisted: files.length - listed.length,
	};
}

/** The changes bar's figures: everything the branch changed, counted but not rendered. */
export interface DiffStats {
	branch?: string;
	baseBranch?: string;
	hasCommits: boolean;
	changed: number;
	added: number;
	removed: number;
	/** Set when the directory is not a git repository, or git is missing. */
	unavailable?: string;
}

/** Totals from `git diff --numstat`; a binary file counts as changed, with no lines. */
export function parseNumstat(raw: string): { changed: number; added: number; removed: number } {
	let changed = 0;
	let added = 0;
	let removed = 0;
	for (const line of raw.split("\n")) {
		const [plus, minus, path] = line.split("\t");
		if (plus === undefined || minus === undefined || path === undefined) continue;
		changed++;
		added += Number(plus) || 0;
		removed += Number(minus) || 0;
	}
	return { changed, added, removed };
}

/**
 * The bar's figures without the bodies behind them.
 *
 * The pane needs every hunk, which for a long branch is megabytes of text
 * through a pipe and a parse. The bar needs three numbers: git totals the
 * tracked side itself in a fraction of the time, and the untracked side is
 * a read of each file. Both paths count the same way, so the bar and the
 * pane never disagree.
 */
export async function collectDiffStats(cwd: string): Promise<DiffStats> {
	const [root, scope] = await Promise.all([repoRoot(cwd), resolveScope(cwd)]);
	if (!root) return { hasCommits: false, changed: 0, added: 0, removed: 0, unavailable: NOT_A_REPO };
	const [numstat, untracked, hasCommits] = await Promise.all([
		run("git", ["diff", "--numstat", "-M", scope.since], cwd),
		listUntracked(cwd).then((paths) => readUntracked(root, paths, 0)),
		scope.baseBranch ? branchHasCommits(cwd, scope.since) : false,
	]);
	const tracked = parseNumstat(numstat.out);
	let untrackedLines = 0;
	for (const file of untracked) untrackedLines += file.lines;
	return {
		branch: scope.branch,
		baseBranch: scope.baseBranch,
		hasCommits,
		changed: tracked.changed + untracked.length,
		added: tracked.added + untrackedLines,
		removed: tracked.removed,
	};
}
