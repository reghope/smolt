import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { projectDirName, sessionsDir } from "./sessions.ts";

/**
 * Usage figures for the home screen, read straight from the session log.
 *
 * Every assistant message carries its own `usage`, so totals come from the
 * transcripts themselves rather than a counter we would have to keep in sync.
 * Scoped to one project like the sidebar, so the numbers describe the work in
 * front of you rather than every folder smolt has ever run in.
 */

/** What the agent has written down for itself, for the home screen. */
export interface LearnedSummary {
	/** Number of § entries in the global MEMORY.md; 0 when the file is absent. */
	memoryEntries: number;
	/** The most recent memory entry, verbatim. */
	latestMemory: string | null;
	/** Absolute path of MEMORY.md, for the reveal affordance. */
	memoryPath: string;
	/** Epoch ms of the last MEMORY.md write; null when absent. */
	memoryUpdatedAt: number | null;
	/** Directory names of self-authored skills under the agent's skills root. */
	skills: string[];
}

export interface UsageStats {
	learned: LearnedSummary;
	sessions: number;
	messages: number;
	tokens: number;
	cost: number;
	activeDays: number;
	currentStreak: number;
	longestStreak: number;
	/** Hour of day, 0-23, with the most assistant replies; null when idle. */
	peakHour: number | null;
	favouriteModel: string | null;
	/** Replies per day, `YYYY-MM-DD` → count, for the activity grid. */
	byDay: Record<string, number>;
	byModel: { model: string; messages: number; tokens: number; input: number; output: number }[];
	/** `YYYY-MM-DD` → model → tokens, for the stacked usage chart. */
	byDayModel: Record<string, Record<string, number>>;
	/** Replies per hour of day, index 0–23, for the rhythm chart. */
	byHour: number[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** One transcript's contribution to the totals, cacheable by mtime. */
interface SessionScan {
	messages: number;
	tokens: number;
	cost: number;
	byDay: Record<string, number>;
	byHour: number[];
	models: Record<string, { messages: number; tokens: number; input: number; output: number }>;
	byDayModel: Record<string, Record<string, number>>;
}

/**
 * Per-file scan results, keyed off mtime. Stats refresh after every settled
 * turn, and re-reading and re-parsing a hundred megabytes of unchanged
 * transcripts each time blocked the main process — which is the window's UI
 * thread — for seconds at a time. Only files that actually changed are
 * re-scanned.
 */
const scanCache = new Map<string, { mtime: number; scan: SessionScan | undefined }>();

function scanSession(path: string, mtime: number): SessionScan | undefined {
	const cached = scanCache.get(path);
	if (cached && cached.mtime === mtime) return cached.scan;
	const scan = scanSessionUncached(path);
	scanCache.set(path, { mtime, scan });
	return scan;
}

function scanSessionUncached(path: string): SessionScan | undefined {
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch {
		return undefined;
	}
	const scan: SessionScan = {
		messages: 0,
		tokens: 0,
		cost: 0,
		byDay: {},
		byHour: new Array(24).fill(0) as number[],
		models: {},
		byDayModel: {},
	};
	for (const line of raw.split("\n")) {
		if (line.trim() === "") continue;
		let entry: { type?: string; timestamp?: string; message?: Record<string, unknown> };
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type !== "message" || !entry.message) continue;
		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") continue;
		scan.messages += 1;
		if (role !== "assistant") continue;

		const when = parseWhen(entry.message.timestamp, entry.timestamp);
		if (when) {
			scan.byDay[dayKey(when)] = (scan.byDay[dayKey(when)] ?? 0) + 1;
			scan.byHour[when.getHours()] += 1;
		}
		const usage = entry.message.usage as
			| { totalTokens?: unknown; input?: unknown; output?: unknown; cost?: { total?: unknown } }
			| undefined;
		const used = typeof usage?.totalTokens === "number" ? usage.totalTokens : 0;
		const inTokens = typeof usage?.input === "number" ? usage.input : 0;
		const outTokens = typeof usage?.output === "number" ? usage.output : 0;
		scan.tokens += used;
		if (typeof usage?.cost?.total === "number") scan.cost += usage.cost.total;

		const modelId = entry.message.model;
		if (typeof modelId === "string" && modelId !== "") {
			const seen = scan.models[modelId] ?? { messages: 0, tokens: 0, input: 0, output: 0 };
			seen.messages += 1;
			seen.tokens += used;
			seen.input += inTokens;
			seen.output += outTokens;
			scan.models[modelId] = seen;
			if (when) {
				const key = dayKey(when);
				const day = scan.byDayModel[key] ?? {};
				day[modelId] = (day[modelId] ?? 0) + used;
				scan.byDayModel[key] = day;
			}
		}
	}
	return scan;
}

/**
 * Session logs carry both shapes: the entry's ISO string and the message's
 * epoch milliseconds. Stringifying the number yields an invalid Date, so each
 * form is parsed on its own terms.
 */
function parseWhen(...candidates: unknown[]): Date | undefined {
	for (const candidate of candidates) {
		if (typeof candidate === "number" && Number.isFinite(candidate)) {
			const date = new Date(candidate);
			if (!Number.isNaN(date.getTime())) return date;
		}
		if (typeof candidate === "string" && candidate.trim() !== "") {
			const date = new Date(candidate);
			if (!Number.isNaN(date.getTime())) return date;
		}
	}
	return undefined;
}

function dayKey(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Longest and current run of consecutive days ending today or yesterday. */
function streaks(days: string[]): { current: number; longest: number } {
	if (days.length === 0) return { current: 0, longest: 0 };
	const set = new Set(days);
	let longest = 0;
	for (const day of set) {
		const previous = new Date(`${day}T00:00:00`);
		previous.setDate(previous.getDate() - 1);
		// Only count from the start of a run, so each run is measured once.
		if (set.has(dayKey(previous))) continue;
		let length = 0;
		const cursor = new Date(`${day}T00:00:00`);
		while (set.has(dayKey(cursor))) {
			length += 1;
			cursor.setDate(cursor.getDate() + 1);
		}
		longest = Math.max(longest, length);
	}
	let current = 0;
	const cursor = new Date();
	if (!set.has(dayKey(cursor))) cursor.setTime(cursor.getTime() - DAY_MS);
	while (set.has(dayKey(cursor))) {
		current += 1;
		cursor.setTime(cursor.getTime() - DAY_MS);
	}
	return { current, longest };
}

/** The learning extension's stores, read the same way stats reads sessions:
 * straight from the files the agent itself writes. Entries in MEMORY.md are
 * separated by lines carrying a lone `§`. */
export function collectLearned(): LearnedSummary {
	const memoryPath = join(homedir(), ".smolt", "memories", "MEMORY.md");
	const summary: LearnedSummary = {
		memoryEntries: 0,
		latestMemory: null,
		memoryPath,
		memoryUpdatedAt: null,
		skills: [],
	};
	try {
		const raw = readFileSync(memoryPath, "utf-8");
		const entries = raw
			.split(/\n?§\n?/)
			.map((entry) => entry.trim())
			.filter((entry) => entry !== "");
		summary.memoryEntries = entries.length;
		summary.latestMemory = entries.at(-1) ?? null;
		summary.memoryUpdatedAt = statSync(memoryPath).mtimeMs;
	} catch {
		// no memory yet
	}
	try {
		// Skills live beside the sessions dir under the agent root.
		const skillsRoot = join(sessionsDir(), "..", "skills");
		summary.skills = readdirSync(skillsRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch {
		// no skills yet
	}
	return summary;
}

export function collectStats(cwd: string, root: string = sessionsDir()): UsageStats {
	const empty: UsageStats = {
		learned: collectLearned(),
		sessions: 0,
		messages: 0,
		tokens: 0,
		cost: 0,
		activeDays: 0,
		currentStreak: 0,
		longestStreak: 0,
		peakHour: null,
		favouriteModel: null,
		byDay: {},
		byModel: [],
		byDayModel: {},
		byHour: new Array(24).fill(0) as number[],
	};
	const scoped = join(root, projectDirName(cwd));
	if (!existsSync(scoped)) return empty;

	const byDay: Record<string, number> = {};
	const byHour = new Array(24).fill(0) as number[];
	const models = new Map<string, { messages: number; tokens: number; input: number; output: number }>();
	const byDayModel: Record<string, Record<string, number>> = {};
	let sessions = 0;
	let messages = 0;
	let tokens = 0;
	let cost = 0;

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
	walk(scoped);

	for (const file of files) {
		const scanned = scanSession(file.path, file.mtime);
		if (!scanned) continue;
		sessions += 1;
		messages += scanned.messages;
		tokens += scanned.tokens;
		cost += scanned.cost;
		for (const [day, count] of Object.entries(scanned.byDay)) byDay[day] = (byDay[day] ?? 0) + count;
		for (let hour = 0; hour < 24; hour++) byHour[hour] += scanned.byHour[hour] ?? 0;
		for (const [model, seen] of Object.entries(scanned.models)) {
			const total = models.get(model) ?? { messages: 0, tokens: 0, input: 0, output: 0 };
			total.messages += seen.messages;
			total.tokens += seen.tokens;
			total.input += seen.input;
			total.output += seen.output;
			models.set(model, total);
		}
		for (const [day, perModel] of Object.entries(scanned.byDayModel)) {
			const merged = byDayModel[day] ?? {};
			for (const [model, used] of Object.entries(perModel)) merged[model] = (merged[model] ?? 0) + used;
			byDayModel[day] = merged;
		}
	}

	const days = Object.keys(byDay);
	const { current, longest } = streaks(days);
	const peak = byHour.reduce((best, count, hour) => (count > byHour[best]! ? hour : best), 0);
	const byModel = [...models.entries()]
		.map(([model, seen]) => ({ model, ...seen }))
		.sort((a, b) => b.messages - a.messages);

	return {
		learned: empty.learned,
		sessions,
		messages,
		tokens,
		cost,
		activeDays: days.length,
		currentStreak: current,
		longestStreak: longest,
		peakHour: byHour[peak]! > 0 ? peak : null,
		favouriteModel: byModel[0]?.model ?? null,
		byDay,
		byModel,
		byDayModel,
		byHour,
	};
}
