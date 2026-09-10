import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * The files a chat can be pointed at with "@".
 *
 * Taken from git where there is a repository: it already knows what is source
 * and what is build output, which a directory walk has to guess at. Outside a
 * repository the walk is the fallback, capped hard — an "@" in the composer
 * must never set a home directory crawling.
 */

/** Directories a fallback walk never enters. */
const SKIP = new Set(["node_modules", ".git", "dist", "build", "out", ".next", ".venv", "__pycache__", "target"]);

/** Ceiling on the fallback walk: a list longer than this is not browsed, it is searched. */
const WALK_LIMIT = 20_000;
const WALK_DEPTH = 8;

/** How long a listing stands before it is read again. */
const CACHE_MS = 10_000;

const cache = new Map<string, { at: number; files: string[] }>();

async function gitFiles(cwd: string): Promise<string[] | undefined> {
	try {
		// Tracked and untracked, minus anything ignored: what a person would
		// call "the files in this project".
		const { stdout } = await run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
			cwd,
			maxBuffer: 32 * 1024 * 1024,
		});
		const files = stdout.split("\0").filter((line) => line !== "");
		return files.length > 0 ? files : undefined;
	} catch {
		return undefined;
	}
}

async function walk(cwd: string): Promise<string[]> {
	const files: string[] = [];
	const queue: { dir: string; depth: number }[] = [{ dir: cwd, depth: 0 }];
	while (queue.length > 0 && files.length < WALK_LIMIT) {
		const { dir, depth } = queue.shift()!;
		let entries: Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".") && entry.name !== ".github") continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (SKIP.has(entry.name) || depth >= WALK_DEPTH) continue;
				queue.push({ dir: full, depth: depth + 1 });
			} else if (entry.isFile()) {
				files.push(relative(cwd, full).split(sep).join("/"));
				if (files.length >= WALK_LIMIT) break;
			}
		}
	}
	return files;
}

async function listFiles(cwd: string): Promise<string[]> {
	const cached = cache.get(cwd);
	if (cached && Date.now() - cached.at < CACHE_MS) return cached.files;
	const files = (await gitFiles(cwd)) ?? (await walk(cwd));
	cache.set(cwd, { at: Date.now(), files });
	return files;
}

/**
 * Project files matching what has been typed after an "@", best first.
 *
 * The whole path is matched, so "ext/review" finds a file two directories
 * down, and a hit on the file's own name outranks one buried in its
 * directories: someone typing "footer" wants footer.ts, not every file under
 * a folder called footer.
 */
export async function searchProjectFiles(cwd: string, query: string, limit = 30): Promise<string[]> {
	const files = await listFiles(cwd);
	const needle = query.toLowerCase().replace(/\\/g, "/");
	// A bare "@" has nothing to rank by, so the top of the tree goes first:
	// shallow paths are the ones a person can recognise at a glance.
	if (needle === "") {
		return [...files].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b)).slice(0, limit);
	}
	const scored: { path: string; score: number }[] = [];
	for (const path of files) {
		const lower = path.toLowerCase();
		const at = lower.indexOf(needle);
		if (at === -1) continue;
		const name = lower.slice(lower.lastIndexOf("/") + 1);
		const inName = name.indexOf(needle);
		// Lower is better: the name's own start, then anywhere in the name, then
		// the path. Shorter paths win ties, which floats the top of the tree.
		const score = (inName === 0 ? 0 : inName > 0 ? 1000 : 2000) + at + path.length / 100;
		scored.push({ path, score });
		if (scored.length > 5000) break;
	}
	scored.sort((a, b) => a.score - b.score);
	return scored.slice(0, limit).map((entry) => entry.path);
}
