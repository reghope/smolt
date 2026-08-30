import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { projectDirName } from "../src/main/sessions.ts";
import { collectStats } from "../src/main/stats.ts";

/**
 * Home-screen usage figures, read back out of the session log.
 *
 * The timestamp cases matter: entries carry an ISO string while the messages
 * inside them carry epoch milliseconds, and treating the number as a string
 * silently yields an invalid date — which showed up as zero active days on a
 * screen full of real token counts.
 */

let root: string;
const PROJECT = String.raw`C:\Users\dev\project`;

function iso(daysAgo: number, hour = 12): string {
	const date = new Date();
	date.setDate(date.getDate() - daysAgo);
	date.setHours(hour, 0, 0, 0);
	return date.toISOString();
}

function epoch(daysAgo: number, hour = 12): number {
	return new Date(iso(daysAgo, hour)).getTime();
}

interface Reply {
	/** epoch ms on the message, the shape the agent actually writes */
	at?: number;
	/** ISO string on the entry, used when the message has no timestamp */
	entryAt?: string;
	tokens?: number;
	cost?: number;
	model?: string;
}

function writeSession(name: string, replies: Reply[], cwd = PROJECT): void {
	const dir = join(root, projectDirName(cwd));
	mkdirSync(dir, { recursive: true });
	const lines = [JSON.stringify({ type: "session", id: name })];
	for (const reply of replies) {
		lines.push(
			JSON.stringify({
				type: "message",
				timestamp: reply.entryAt,
				message: {
					role: "assistant",
					timestamp: reply.at,
					model: reply.model ?? "test-model",
					usage: { totalTokens: reply.tokens ?? 100, cost: { total: reply.cost ?? 0.01 } },
					content: [{ type: "text", text: "ok" }],
				},
			}),
		);
	}
	writeFileSync(join(dir, `${name}.jsonl`), `${lines.join("\n")}\n`);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "smolt-stats-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("collectStats", () => {
	test("is all zeroes for a project with no sessions", () => {
		const stats = collectStats(PROJECT, root);
		expect(stats.sessions).toBe(0);
		expect(stats.activeDays).toBe(0);
		expect(stats.peakHour).toBeNull();
	});

	test("counts sessions, replies, tokens, and spend", () => {
		writeSession("a", [
			{ tokens: 500, cost: 0.02 },
			{ tokens: 250, cost: 0.01 },
		]);
		writeSession("b", [{ tokens: 250, cost: 0.01 }]);
		const stats = collectStats(PROJECT, root);
		expect(stats.sessions).toBe(2);
		expect(stats.messages).toBe(3);
		expect(stats.tokens).toBe(1000);
		expect(stats.cost).toBeCloseTo(0.04, 5);
	});

	test("reads epoch-millisecond timestamps, not just ISO strings", () => {
		writeSession("a", [{ at: epoch(0, 14) }]);
		const stats = collectStats(PROJECT, root);
		expect(stats.activeDays).toBe(1);
		expect(stats.peakHour).toBe(14);
	});

	test("falls back to the entry's ISO timestamp when the message has none", () => {
		writeSession("a", [{ entryAt: iso(0, 9) }]);
		const stats = collectStats(PROJECT, root);
		expect(stats.activeDays).toBe(1);
		expect(stats.peakHour).toBe(9);
	});

	test("counts each distinct day once and reports the busiest hour", () => {
		writeSession("a", [{ at: epoch(0, 20) }, { at: epoch(0, 20) }, { at: epoch(1, 8) }]);
		const stats = collectStats(PROJECT, root);
		expect(stats.activeDays).toBe(2);
		expect(stats.peakHour).toBe(20);
	});

	test("measures a streak running up to today", () => {
		writeSession("a", [{ at: epoch(0) }, { at: epoch(1) }, { at: epoch(2) }]);
		const stats = collectStats(PROJECT, root);
		expect(stats.currentStreak).toBe(3);
		expect(stats.longestStreak).toBe(3);
	});

	test("keeps the longest past streak even when the current one has lapsed", () => {
		// A four-day run a fortnight ago, then nothing until yesterday.
		writeSession("old", [{ at: epoch(14) }, { at: epoch(15) }, { at: epoch(16) }, { at: epoch(17) }]);
		writeSession("recent", [{ at: epoch(1) }]);
		const stats = collectStats(PROJECT, root);
		expect(stats.longestStreak).toBe(4);
		expect(stats.currentStreak).toBe(1);
	});

	test("ranks models by how often they replied", () => {
		writeSession("a", [
			{ model: "opus", tokens: 300 },
			{ model: "opus", tokens: 300 },
			{ model: "haiku", tokens: 50 },
		]);
		const stats = collectStats(PROJECT, root);
		expect(stats.favouriteModel).toBe("opus");
		expect(stats.byModel[0]).toMatchObject({ model: "opus", messages: 2, tokens: 600 });
	});

	test("ignores other projects' sessions", () => {
		writeSession("mine", [{ tokens: 100 }]);
		writeSession("theirs", [{ tokens: 999 }], String.raw`C:\Users\dev\other`);
		expect(collectStats(PROJECT, root).tokens).toBe(100);
	});
});
