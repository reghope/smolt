import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Per-session git worktrees.
 *
 * An isolated session gets its own checkout and branch, so an agent working
 * in one cannot disturb the files another session (or the user) has open.
 * Worktrees live under `<repo>/.smolt/worktrees/<name>`, and the agent is
 * started with that directory as its cwd.
 */

export interface Worktree {
	name: string;
	branch: string;
	path: string;
}

function run(args: string[], cwd: string, timeoutMs = 30_000): Promise<{ code: number; out: string; err: string }> {
	return new Promise((resolve) => {
		const child = spawn("git", args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";
		const timer = setTimeout(() => child.kill(), timeoutMs);
		child.stdout?.on("data", (chunk: Buffer) => {
			out += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			err += chunk.toString();
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ code: -1, out: "", err: error.message });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code: code ?? -1, out, err });
		});
	});
}

/** Repository root for a directory, or undefined when it is not a repo. */
export async function repoRoot(cwd: string): Promise<string | undefined> {
	const result = await run(["rev-parse", "--show-toplevel"], cwd);
	if (result.code !== 0) return undefined;
	const root = result.out.trim();
	return root === "" ? undefined : root;
}

export function worktreesDir(root: string): string {
	return join(root, ".smolt", "worktrees");
}

/** Sanitise a session name into something usable as a branch and directory. */
export function worktreeName(label: string, fallback: string): string {
	const slug = label
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return slug === "" ? fallback : slug;
}

/** Create a worktree on a new branch cut from the current HEAD. */
export async function createWorktree(cwd: string, label: string, branchPrefix = "smolt/"): Promise<Worktree> {
	const root = await repoRoot(cwd);
	if (!root) throw new Error("Not a git repository, so sessions cannot be isolated in worktrees.");

	const base = worktreeName(label, `session-${Date.now().toString(36)}`);
	let name = base;
	let index = 2;
	while (existsSync(join(worktreesDir(root), name))) {
		name = `${base}-${index++}`;
	}
	const path = join(worktreesDir(root), name);
	const branch = `${branchPrefix}${name}`;

	const result = await run(["worktree", "add", "-b", branch, path], root);
	if (result.code !== 0) {
		throw new Error(
			`Could not create the worktree: ${result.err.trim().split("\n")[0] || `git exited ${result.code}`}`,
		);
	}
	return { name, branch, path };
}

/** Existing worktrees under the repository's smolt directory. */
export async function listWorktrees(cwd: string): Promise<Worktree[]> {
	const root = await repoRoot(cwd);
	if (!root) return [];
	const result = await run(["worktree", "list", "--porcelain"], root);
	if (result.code !== 0) return [];

	const worktrees: Worktree[] = [];
	const dir = worktreesDir(root);
	// git reports POSIX separators even on Windows, where `join` produces
	// backslashes, so compare on a normalised form.
	const key = (value: string): string => {
		const slashed = value.replace(/\\/g, "/");
		return process.platform === "win32" ? slashed.toLowerCase() : slashed;
	};
	const dirKey = key(dir);
	let current: { path?: string; branch?: string } = {};
	const flush = (): void => {
		if (current.path && key(current.path).startsWith(`${dirKey}/`)) {
			worktrees.push({
				name: key(current.path).slice(dirKey.length + 1),
				branch: current.branch ?? "",
				path: current.path,
			});
		}
		current = {};
	};
	for (const line of result.out.split("\n")) {
		if (line.startsWith("worktree ")) {
			flush();
			current.path = line.slice("worktree ".length).trim();
		} else if (line.startsWith("branch ")) {
			current.branch = line.slice("branch ".length).replace("refs/heads/", "").trim();
		}
	}
	flush();
	return worktrees;
}

/** Remove a worktree; its branch is left alone so work is never silently lost. */
export async function removeWorktree(cwd: string, path: string, force = false): Promise<void> {
	const root = await repoRoot(cwd);
	if (!root) throw new Error("Not a git repository.");
	const args = ["worktree", "remove", path];
	if (force) args.push("--force");
	const result = await run(args, root);
	if (result.code !== 0) {
		const detail = result.err.trim().split("\n")[0] ?? "";
		throw new Error(
			detail.includes("contains modified") || detail.includes("is dirty")
				? "That worktree has uncommitted changes. Commit them, or remove it again to discard."
				: `Could not remove the worktree: ${detail || `git exited ${result.code}`}`,
		);
	}
}
