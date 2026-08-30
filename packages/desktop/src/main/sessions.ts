import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Lightweight listing of stored sessions for the sidebar. */

export interface SessionSummary {
	path: string;
	id: string;
	title: string;
	preview: string;
	lastActive: number;
	messageCount: number;
	/** The working directory the chat ran in, from its own opening record. */
	cwd: string;
}

export function sessionsDir(): string {
	const envDir = process.env.SMOLT_CODING_AGENT_DIR;
	const agentDir = envDir && envDir !== "" ? envDir : join(homedir(), ".smolt", "agent");
	return join(agentDir, "sessions");
}

/**
 * Session directory name for a working directory, matching the agent's own
 * encoding (`~/.smolt/agent/sessions/--C--Users-me-project--`).
 */
export function projectDirName(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * Every stored session, newest first, whatever folder it ran in.
 *
 * The list is deliberately not filtered by the active folder: a folder is
 * where the agent works, not a compartment for chats, and hiding the rest
 * reads as having lost them. Each row carries its own cwd so opening one can
 * follow it back to the files it ran against.
 *
 * Sessions whose folder no longer exists are dropped, which is what keeps the
 * throwaway directories the test suite leaves behind out of the sidebar.
 */
export function listSessions(root: string = sessionsDir(), limit = 50): SessionSummary[] {
	if (!existsSync(root)) return [];
	return listSessionsIn(root, limit);
}

function listSessionsIn(root: string, limit: number): SessionSummary[] {
	const files: { path: string; mtime: number }[] = [];
	const walk = (dir: string): void => {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of entries) {
			const full = join(dir, name);
			try {
				const st = statSync(full);
				if (st.isDirectory()) walk(full);
				else if (name.endsWith(".jsonl")) files.push({ path: full, mtime: st.mtimeMs });
			} catch {
				// unreadable entry
			}
		}
	};
	walk(root);
	files.sort((a, b) => b.mtime - a.mtime);

	// One stat per folder rather than per session: a busy folder holds hundreds.
	const folderLives = new Map<string, boolean>();
	const folderExists = (dir: string): boolean => {
		let known = folderLives.get(dir);
		if (known === undefined) {
			known = dir !== "" && existsSync(dir);
			folderLives.set(dir, known);
		}
		return known;
	};

	const out: SessionSummary[] = [];
	// Dead sessions are skipped rather than counted, so a run of them cannot
	// starve the list; the ceiling stops a huge history being read in full.
	const ceiling = Math.min(files.length, limit * 8);
	for (let index = 0; index < ceiling && out.length < limit; index++) {
		const file = files[index]!;
		const summary = summarize(file.path, file.mtime);
		if (summary && folderExists(summary.cwd)) out.push(summary);
	}
	return out;
}

function summarize(path: string, mtime: number): SessionSummary | undefined {
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch {
		return undefined;
	}
	let id = "";
	let cwd = "";
	let title = "";
	let preview = "";
	let messageCount = 0;
	for (const line of raw.split("\n")) {
		if (line.trim() === "") continue;
		let entry: {
			type?: string;
			id?: string;
			cwd?: string;
			name?: string;
			message?: { role?: string; content?: unknown };
		};
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type === "session") {
			id = entry.id ?? "";
			cwd = entry.cwd ?? "";
		} else if (entry.type === "session_info") title = entry.name || title;
		else if (entry.type === "message" && entry.message) {
			const role = entry.message.role;
			if (role === "user" || role === "assistant") {
				messageCount++;
				if (preview === "" && role === "user") preview = extractText(entry.message.content).slice(0, 120);
			}
		}
	}
	if (id === "") return undefined;
	return {
		path,
		id,
		cwd,
		title: title || preview.slice(0, 40) || "(untitled)",
		preview,
		lastActive: mtime,
		messageCount,
	};
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
			const text = (block as { text?: string }).text;
			if (typeof text === "string") parts.push(text);
		}
	}
	return parts.join(" ");
}
/** A slice of a stored transcript, with enough context to ask for the one above it. */
export interface SessionPage {
	/** The window itself, oldest first. */
	messages: Record<string, unknown>[];
	/** Where the window begins in the whole chat; above 0 there is more above it. */
	start: number;
	/** User messages before the window, so a rewind still counts to the right one. */
	userStart: number;
}

/**
 * A window onto a stored transcript: the newest messages, unless asked for the
 * page before a given point.
 *
 * Reading the file directly is not a duplicate of asking the agent: switching
 * a session inside the agent takes seconds, and the transcript is on disk the
 * whole time. The window renders from here and lets the agent catch up.
 *
 * A long chat runs to thousands of messages, and handing the whole lot to the
 * window so it can show the last few is both a slow read and a slow render.
 * Only the window is kept; scrolling up asks for the page above it.
 */
export function readSessionMessages(path: string, options: { limit?: number; before?: number } = {}): SessionPage {
	const limit = Math.max(1, options.limit ?? 60);
	const before = options.before;
	const first = before === undefined ? 0 : Math.max(0, before - limit);
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch {
		return { messages: [], start: 0, userStart: 0 };
	}
	const held: Record<string, unknown>[] = [];
	let total = 0;
	let userStart = 0;
	for (const line of raw.split("\n")) {
		if (line.trim() === "") continue;
		let entry: { type?: string; message?: unknown };
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type !== "message") continue;
		if (entry.message === null || typeof entry.message !== "object") continue;
		const message = entry.message as Record<string, unknown>;
		const index = total++;
		if (before === undefined) {
			// Where the tail begins is not known until the end, so hold a rolling
			// window and count what falls out of the front of it.
			held.push(message);
			if (held.length > limit && held.shift()?.role === "user") userStart += 1;
		} else if (index < first) {
			if (message.role === "user") userStart += 1;
		} else if (index < before) {
			held.push(message);
		}
	}
	return { messages: held, start: before === undefined ? total - held.length : first, userStart };
}
