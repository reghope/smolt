import { existsSync, mkdirSync, readdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Where a chat works when the reader has no project folder open.
 *
 * Such a chat still has to be able to write a file, and it used to run in
 * one hidden directory shared by every chat that ever ran without a folder.
 * Everything piled into the same drawer: a wiki dump from one conversation
 * beside a half-finished site from another, in a place no one would think to
 * look.
 *
 * Instead each of these chats gets a folder of its own, under the reader's
 * documents, dated, and named after the message that opened the chat —
 * `~/Documents/smolt/2026-09-02/fix-the-changes-bar`. It is somewhere they
 * can find later, and one chat's work never lands on another's.
 */

/** How many words of the opening message a folder name keeps. */
const SLUG_WORDS = 6;
/** And how long it may get, so the path stays workable on Windows. */
const SLUG_LENGTH = 32;

/**
 * The opening message as a folder name: `fix the changes bar, it lies` turns
 * into `fix-the-changes-bar-it`. Lowercase and plain, cut at a word.
 */
export function folderSlug(message: string): string {
	const words = message
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.split(" ")
		.filter((word) => word !== "");
	const kept: string[] = [];
	for (const word of words) {
		if (kept.length >= SLUG_WORDS) break;
		if (kept.length > 0 && [...kept, word].join("-").length > SLUG_LENGTH) break;
		kept.push(word);
	}
	const slug = kept.join("-").slice(0, SLUG_LENGTH);
	// A message of nothing but punctuation, or an empty one.
	return slug === "" ? "chat" : slug;
}

/** `2026-09-02`, in the reader's own day rather than UTC's. */
export function dayStamp(when: Date): string {
	const pad = (part: number): string => String(part).padStart(2, "0");
	return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
}

function isEmptyDir(path: string): boolean {
	try {
		return readdirSync(path).length === 0;
	} catch {
		return false;
	}
}

/**
 * The folder this chat should work in, made ready to work in.
 *
 * Asking the same thing twice in a day reuses the folder while it is still
 * empty, and otherwise takes the next number along, so a second attempt
 * never writes into the first one's results.
 */
export function createChatFolder(root: string, when: Date, message: string): string {
	const day = join(root, dayStamp(when));
	const slug = folderSlug(message);
	for (let attempt = 1; ; attempt += 1) {
		const path = join(day, attempt === 1 ? slug : `${slug}-${attempt}`);
		if (existsSync(path) && !isEmptyDir(path)) continue;
		mkdirSync(path, { recursive: true });
		return path;
	}
}

/**
 * Drop the folders of chats that never wrote anything.
 *
 * Most chats with no folder open are conversations, not work, and each one
 * would otherwise leave an empty folder behind for ever. Called at startup,
 * when no agent is standing in any of them: a directory that is some running
 * program's working directory cannot be removed on Windows, and one that is
 * not empty is somebody's work and is never touched.
 */
export function sweepEmptyChatFolders(root: string): number {
	let swept = 0;
	let days: string[];
	try {
		days = readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return 0;
	}
	for (const day of days) {
		const dayPath = join(root, day);
		let chats: string[];
		try {
			chats = readdirSync(dayPath, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name);
		} catch {
			continue;
		}
		for (const chat of chats) {
			const path = join(dayPath, chat);
			if (!isEmptyDir(path)) continue;
			try {
				rmdirSync(path);
				swept += 1;
			} catch {
				// Something is holding it; it can go next time.
			}
		}
		if (isEmptyDir(dayPath)) {
			try {
				rmdirSync(dayPath);
			} catch {
				// As above.
			}
		}
	}
	return swept;
}

/** What the app knows when a chat's first message arrives. */
export interface ChatFolderState {
	/** A working directory was forced on the app from outside. */
	forcedCwd: boolean;
	/** The reader has a project folder open, so the chat already has a home. */
	hasProject: boolean;
	/** This chat has a folder of its own already. */
	settled: boolean;
	/** Never prompted, and not resumed from the session list. */
	fresh: boolean;
	/** This chat's own agent is mid-turn. */
	busy: boolean;
}

/**
 * Whether this chat should be moved into a folder of its own.
 *
 * Moving means restarting this chat's agent, because a working directory is
 * fixed when a process starts. That is why the answer is no more often than
 * yes: a chat with history would be stranded away from the folder it has been
 * writing in, and a restart mid-turn would kill that turn. Only this chat's
 * agent counts — other chats keep their own folders and are not restarted.
 */
export function needsChatFolder(state: ChatFolderState): boolean {
	if (state.forcedCwd || state.hasProject) return false;
	if (state.settled || !state.fresh) return false;
	return !state.busy;
}
