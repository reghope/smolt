import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { listSessions, projectDirName } from "./sessions.ts";

/**
 * One-click prompt suggestions for the empty new-chat screen.
 *
 * Generated once per project per sitting by the user's own default model —
 * a one-shot `smolt -p --no-session` run, so auth, provider and model choice
 * are exactly what the agent would use anyway, and no transcript is written.
 * Context given to the model is what this process can read cheaply: recent
 * session titles, the top of the README, git state, and the newest line the
 * agent wrote into MEMORY.md.
 *
 * Nothing here is allowed to delay or break the empty state: any failure
 * resolves to no starters and the card simply never appears.
 */

export interface Starter {
	/** The prompt text, inserted into the composer on click. */
	label: string;
	/** Short right-aligned context, e.g. "from 2h ago" or "3 files changed". */
	meta: string;
}

const CACHE_TTL_MS = 30 * 60 * 1000;
const GENERATE_TIMEOUT_MS = 60 * 1000;

const cache = new Map<string, { at: number; starters: Starter[] }>();
const inflight = new Map<string, Promise<Starter[]>>();

/** First non-empty lines of a file, or null when it cannot be read. */
async function readHead(path: string, lines: number): Promise<string | null> {
	try {
		const text = await readFile(path, "utf8");
		return text.split("\n").slice(0, lines).join("\n").trim() || null;
	} catch {
		return null;
	}
}

/** Newest `§` entry in the agent's global MEMORY.md, single line, or null. */
async function latestMemoryLine(): Promise<string | null> {
	const memoryPath = join(homedir(), ".smolt", "agent", "MEMORY.md");
	const text = await readHead(memoryPath, 200);
	if (!text) return null;
	const entries = text.split("\n").filter((line) => line.startsWith("§"));
	return entries.at(-1)?.slice(0, 200) ?? null;
}

function git(args: string[], cwd: string): Promise<string | null> {
	return new Promise((resolve) => {
		execFile("git", args, { cwd, timeout: 4000 }, (err, stdout) => {
			resolve(err ? null : stdout.toString().trim() || null);
		});
	});
}

function buildPrompt(cwd: string): string {
	const dirName = projectDirName(cwd);
	const recent = listSessions(undefined, 5)
		.map((s) => `- ${s.title} (${s.preview ?? "no preview"})`)
		.join("\n");

	return [
		`You generate exactly 3 short prompt suggestions for the user's next coding session in the project "${dirName}".`,
		`Each suggestion is something the user would type to a coding agent as their first message. Ground them in the context below when it gives something concrete; otherwise prefer generally useful software tasks (run tests and fix failures, review uncommitted changes, continue recent work).`,
		`Reply with ONLY a JSON array of 3 objects, each {"label": string, "meta": string}. "label" is the prompt itself, max 60 characters, no quotes around it. "meta" is a 2-4 word right-aligned hint (e.g. "from 2h ago", "3 files changed"). No markdown, no commentary.`,
		``,
		`Recent sessions (newest first):`,
		recent || `- none yet; first session in this project`,
	].join("\n");
}

/** The base prompt, with git, README and memory context appended. */
async function buildContextualPrompt(cwd: string): Promise<string> {
	const prompt = buildPrompt(cwd);
	const [branch, status, readme, memory] = await Promise.all([
		git(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
		git(["status", "--porcelain"], cwd),
		readHead(join(cwd, "README.md"), 25),
		latestMemoryLine(),
	]);

	const statusLines = status?.split("\n") ?? [];
	const changed = statusLines.length;
	const parts = [
		prompt,
		``,
		`Git branch: ${branch ?? "unknown"}`,
		changed > 0 ? `${changed} uncommitted change(s):` : `Working tree clean.`,
		...(changed > 0 && changed <= 15
			? statusLines.map((l) => `  ${l}`)
			: changed > 15
				? [`  (${changed} files)…]`]
				: []),
		readme ? `\nREADME excerpt:\n${readme}` : ``,
		memory ? `\nNewest memory entry: ${memory}` : ``,
	];
	return parts.filter(Boolean).join("\n");
}

function parseStarters(stdout: string): Starter[] {
	// The model may wrap the array in prose or fences; take the outermost [...] span.
	const start = stdout.indexOf("[");
	const end = stdout.lastIndexOf("]");
	if (start === -1 || end <= start) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout.slice(start, end + 1));
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const starters: Starter[] = [];
	for (const item of parsed) {
		if (typeof item !== "object" || item === null) continue;
		const label = String((item as Record<string, unknown>).label ?? "").trim();
		const meta = String((item as Record<string, unknown>).meta ?? "").trim();
		if (label === "") continue;
		starters.push({ label: label.slice(0, 120), meta: meta.slice(0, 40) });
		if (starters.length === 3) break;
	}
	return starters;
}

/**
 * Suggestions for a project directory, cached per cwd. A cached result inside
 * the TTL window is returned as-is; a stale one is served immediately while a
 * refresh runs underneath, so re-openings never wait on the model.
 */
export function suggestStarters(
	cwd: string,
	runCli: (args: string[], cwd: string) => Promise<string>,
): Promise<Starter[]> {
	const cached = cache.get(cwd);
	if (cached && Date.now() - cached.at < CACHE_TTL_MS) return Promise.resolve(cached.starters);
	const running = inflight.get(cwd);
	if (running) {
		// A stale cache beats a wait: serve it and let the refresh land later.
		if (cached) return Promise.resolve(cached.starters);
		return running;
	}

	const job = (async () => {
		try {
			const prompt = await buildContextualPrompt(cwd);
			const stdout = await runCli(["-p", prompt, "--no-session"], cwd);
			const starters = parseStarters(stdout);
			if (starters.length > 0) cache.set(cwd, { at: Date.now(), starters });
			return starters;
		} catch {
			// No starters is a fine answer; the empty state just stays as it was.
			return [];
		} finally {
			inflight.delete(cwd);
		}
	})();
	inflight.set(cwd, job);
	return job;
}

/** Test seam: run the bundled CLI in print mode and capture stdout. */
export function makeCliRunner(cliPath: string, execPath: string | undefined, env: NodeJS.ProcessEnv) {
	return (args: string[], cwd: string): Promise<string> =>
		new Promise((resolve, reject) => {
			execFile(
				execPath ?? "node",
				execPath ? [cliPath, ...args] : args,
				{ cwd, timeout: GENERATE_TIMEOUT_MS, env, maxBuffer: 1024 * 1024 },
				(err, stdout) => {
					if (err) reject(err);
					else resolve(stdout.toString());
				},
			);
		});
}
