import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

/**
 * Where the agent keeps what it writes *about* a project.
 *
 * Runs, findings and maps used to live in the project's own `.smolt/`
 * directory, which put the agent's bookkeeping straight into the reader's
 * diff: one battletest run left hundreds of ticket files sitting between
 * them and the handful of files they had actually changed, and a review or a
 * map added more. None of it is source, and none of it should be reviewed as
 * if it were.
 *
 * It lives under the home directory instead, one directory per project:
 * `~/.smolt/projects/<folder name>/battletest`. Named after the folder so a
 * person can find it by hand, and never directly under `~/.smolt`, where a
 * project called `agent` or `memories` would land on top of the agent's own
 * state.
 *
 * What the *reader* writes — settings, prompts, skills, subagents — stays in
 * the project where they put it. Only what the agent generates moves.
 */

const CONFIG_DIR_NAME = ".smolt";
/** Records which project a directory belongs to, so names can collide safely. */
const MARKER = "project.json";

/** All per-project directories: `~/.smolt/projects`. */
export function projectsRoot(): string {
	return join(homedir(), CONFIG_DIR_NAME, "projects");
}

function samePath(a: string, b: string): boolean {
	return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** The project a directory was made for, if it says. */
function claimant(dir: string): string | undefined {
	try {
		const raw: unknown = JSON.parse(readFileSync(join(dir, MARKER), "utf-8"));
		const path = (raw as { path?: unknown }).path;
		return typeof path === "string" ? path : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The directory this project's records live in.
 *
 * Two projects can share a folder name — every `web` and `api` on a machine
 * — so each directory records the path it was made for, and a second project
 * of that name takes a suffix from its own path rather than writing into the
 * first one's records.
 */
export function projectDir(cwd: string): string {
	const path = resolve(cwd);
	const name = basename(path) || "project";
	const root = projectsRoot();
	const first = join(root, name);
	if (!existsSync(first)) return first;
	const held = claimant(first);
	// An unmarked directory is from before this marker existed: it belongs to
	// whoever asks first, which is the project that has been using it.
	if (held === undefined || samePath(held, path)) return first;
	return join(root, `${name}-${createHash("sha256").update(path).digest("hex").slice(0, 8)}`);
}

function countFiles(dir: string): number {
	let total = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		total += entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1;
	}
	return total;
}

/**
 * Carry an old in-repo store to its new home, once.
 *
 * Only ever when the new home is empty, so it cannot overwrite records the
 * agent has already written there, and only removing the old copy once the
 * new one is verified to hold the same number of files. The old directory is
 * usually committed, so the removal shows up as an ordinary deletion the
 * reader can look at, and undo, in git.
 */
export function migrateLegacyStore(legacy: string, store: string): number {
	if (!existsSync(legacy)) return 0;
	try {
		if (countFiles(store) > 0) return 0;
		const expected = countFiles(legacy);
		if (expected === 0) {
			rmSync(legacy, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
			return 0;
		}
		cpSync(legacy, store, { recursive: true });
		if (countFiles(store) < expected) return 0;
		rmSync(legacy, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
		return expected;
	} catch {
		// A store that will not move is left where it is and keeps working.
		return 0;
	}
}

/**
 * The directory for one kind of record about this project, ready to write to,
 * with anything the project already had under `.smolt/<name>` carried into it.
 */
export function projectStore(cwd: string, name: string): string {
	const path = resolve(cwd);
	const dir = projectDir(path);
	const store = join(dir, name);
	mkdirSync(store, { recursive: true });
	if (claimant(dir) === undefined) {
		try {
			writeFileSync(join(dir, MARKER), `${JSON.stringify({ path }, null, "\t")}\n`);
		} catch {
			// The marker is a convenience; without it the directory still works.
		}
	}
	const moved = migrateLegacyStore(join(path, CONFIG_DIR_NAME, name), store);
	if (moved > 0) {
		console.error(`smolt: moved ${moved} ${name} files out of the project into ${store}`);
	}
	return store;
}
