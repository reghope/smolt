import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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

export interface UsageStats {
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

export function collectStats(cwd: string, root: string = sessionsDir()): UsageStats {
	const empty: UsageStats = {
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

	const walk = (dir: string): void => {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of entries) {
			const full = join(dir, name);
			let isDir = false;
			try {
				isDir = statSync(full).isDirectory();
			} catch {
				continue;
			}
			if (isDir) {
				walk(full);
				continue;
			}
			if (!name.endsWith(".jsonl")) continue;
			let raw: string;
			try {
				raw = readFileSync(full, "utf-8");
			} catch {
				continue;
			}
			sessions += 1;
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
				messages += 1;
				if (role !== "assistant") continue;

				const when = parseWhen(entry.message.timestamp, entry.timestamp);
				if (when) {
					byDay[dayKey(when)] = (byDay[dayKey(when)] ?? 0) + 1;
					byHour[when.getHours()] += 1;
				}
				const usage = entry.message.usage as
					| { totalTokens?: unknown; input?: unknown; output?: unknown; cost?: { total?: unknown } }
					| undefined;
				const used = typeof usage?.totalTokens === "number" ? usage.totalTokens : 0;
				const inTokens = typeof usage?.input === "number" ? usage.input : 0;
				const outTokens = typeof usage?.output === "number" ? usage.output : 0;
				tokens += used;
				if (typeof usage?.cost?.total === "number") cost += usage.cost.total;

				const modelId = entry.message.model;
				if (typeof modelId === "string" && modelId !== "") {
					const seen = models.get(modelId) ?? { messages: 0, tokens: 0, input: 0, output: 0 };
					seen.messages += 1;
					seen.tokens += used;
					seen.input += inTokens;
					seen.output += outTokens;
					models.set(modelId, seen);
					if (when) {
						const key = dayKey(when);
						const day = byDayModel[key] ?? {};
						day[modelId] = (day[modelId] ?? 0) + used;
						byDayModel[key] = day;
					}
				}
			}
		}
	};
	walk(scoped);

	const days = Object.keys(byDay);
	const { current, longest } = streaks(days);
	const peak = byHour.reduce((best, count, hour) => (count > byHour[best]! ? hour : best), 0);
	const byModel = [...models.entries()]
		.map(([model, seen]) => ({ model, ...seen }))
		.sort((a, b) => b.messages - a.messages);

	return {
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
