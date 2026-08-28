import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	anchoredView,
	formatTimestamp,
	type SessionMessage,
	SessionStore,
} from "../src/extensions/learning/sessions.ts";

let dir: string;
let sessionsDir: string;
let openStores: SessionStore[] = [];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "learning-sessions-"));
	sessionsDir = join(dir, "sessions");
	mkdirSync(sessionsDir, { recursive: true });
	openStores = [];
});

afterEach(() => {
	for (const store of openStores) store.close();
	rmSync(dir, { recursive: true, force: true });
});

function track(store: SessionStore): SessionStore {
	openStores.push(store);
	return store;
}

interface FixtureMessage {
	role: string;
	text: string;
	ts?: string;
}

function writeSession(
	fileName: string,
	options: {
		id: string;
		timestamp?: string;
		parent?: string;
		title?: string;
		model?: string;
		messages: FixtureMessage[];
	},
): string {
	const lines: string[] = [];
	lines.push(
		JSON.stringify({
			type: "session",
			version: 3,
			id: options.id,
			timestamp: options.timestamp ?? "2026-08-01T10:00:00.000Z",
			cwd: "/project",
			...(options.parent ? { parentSession: options.parent } : {}),
		}),
	);
	if (options.title) {
		lines.push(
			JSON.stringify({
				type: "session_info",
				id: "info-1",
				parentId: null,
				timestamp: options.timestamp ?? "2026-08-01T10:00:00.000Z",
				name: options.title,
			}),
		);
	}
	if (options.model) {
		lines.push(
			JSON.stringify({
				type: "model_change",
				id: "model-1",
				parentId: null,
				timestamp: options.timestamp ?? "2026-08-01T10:00:00.000Z",
				provider: "test",
				modelId: options.model,
			}),
		);
	}
	options.messages.forEach((m, i) => {
		if (m.role === "toolResult") {
			lines.push(
				JSON.stringify({
					type: "message",
					id: `entry-${i}`,
					parentId: null,
					timestamp: m.ts ?? `2026-08-01T10:${String(i).padStart(2, "0")}:00.000Z`,
					message: {
						role: "toolResult",
						toolCallId: `call-${i}`,
						toolName: "bash",
						content: [{ type: "text", text: m.text }],
						isError: false,
					},
				}),
			);
		} else if (m.role.startsWith("custom:")) {
			lines.push(
				JSON.stringify({
					type: "custom_message",
					id: `entry-${i}`,
					parentId: null,
					timestamp: m.ts ?? `2026-08-01T10:${String(i).padStart(2, "0")}:00.000Z`,
					customType: m.role.slice("custom:".length),
					content: [{ type: "text", text: m.text }],
					display: false,
				}),
			);
		} else {
			lines.push(
				JSON.stringify({
					type: "message",
					id: `entry-${i}`,
					parentId: null,
					timestamp: m.ts ?? `2026-08-01T10:${String(i).padStart(2, "0")}:00.000Z`,
					message: { role: m.role, content: [{ type: "text", text: m.text }] },
				}),
			);
		}
	});
	const path = join(sessionsDir, fileName);
	writeFileSync(path, `${lines.join("\n")}\n`, "utf-8");
	return path;
}

function chat(topic: string, extra: FixtureMessage[] = []): FixtureMessage[] {
	return [
		{ role: "user", text: `Let's work on ${topic} today` },
		{ role: "assistant", text: `Sure, starting on ${topic}` },
		{ role: "user", text: `The ${topic} keyword is zebraphrase` },
		{ role: "assistant", text: `Understood, noting zebraphrase for ${topic}` },
		{ role: "user", text: `Wrap up ${topic}` },
		{ role: "assistant", text: `${topic} is done` },
		...extra,
	];
}

const MODES: { label: string; forceScan: boolean }[] = [
	{ label: "sqlite", forceScan: false },
	{ label: "scan-fallback", forceScan: true },
];

for (const mode of MODES) {
	const makeStore = () =>
		track(new SessionStore(sessionsDir, join(dir, `state-${mode.label}.db`), { forceScan: mode.forceScan }));

	describe(`discovery (${mode.label})`, () => {
		test("finds sessions, hydrating the top result fully and later results compactly", async () => {
			writeSession("a.jsonl", { id: "sess-a", title: "Alpha work", messages: chat("alpha") });
			writeSession("b.jsonl", { id: "sess-b", title: "Beta work", messages: chat("beta") });
			const store = makeStore();
			const result = await store.search({ query: "zebraphrase" });
			expect(result).toMatchObject({ success: true, mode: "discover", detail: "adaptive" });
			const results = result.results as Record<string, unknown>[];
			expect(results.length).toBe(2);

			const top = results[0]!;
			expect(top.detail).toBe("full");
			expect((top.messages as unknown[]).length).toBeGreaterThan(1);
			expect(top.match_message_id).toBe(2);
			expect(String(top.snippet)).toContain("zebraphrase");

			const second = results[1]!;
			expect(second.detail).toBe("compact");
			expect(second.bookend_start).toEqual([]);
			expect(second.bookend_end).toEqual([]);
			const anchorOnly = second.messages as { id: number; anchor?: boolean }[];
			expect(anchorOnly.length).toBe(1);
			expect(anchorOnly[0]!.anchor).toBe(true);
		});

		test('detail="full" hydrates every result', async () => {
			writeSession("a.jsonl", { id: "sess-a", messages: chat("alpha") });
			writeSession("b.jsonl", { id: "sess-b", messages: chat("beta") });
			const store = makeStore();
			const result = await store.search({ query: "zebraphrase", detail: "full" });
			const results = result.results as Record<string, unknown>[];
			expect(results.every((r) => r.detail === "full")).toBe(true);
		});

		test("dedupes hits by session lineage (child resolves to parent root)", async () => {
			writeSession("parent.jsonl", { id: "sess-parent", messages: chat("shared") });
			writeSession("child.jsonl", { id: "sess-child", parent: "sess-parent", messages: chat("shared") });
			const store = makeStore();
			const result = await store.search({ query: "zebraphrase" });
			expect(result.count).toBe(1);
		});

		test("excludes the current session from results", async () => {
			writeSession("a.jsonl", { id: "sess-a", messages: chat("alpha") });
			writeSession("b.jsonl", { id: "sess-b", messages: chat("beta") });
			const store = makeStore();
			const result = await store.search({ query: "zebraphrase" }, "sess-a");
			const results = result.results as Record<string, unknown>[];
			expect(results.length).toBe(1);
			expect(results[0]!.session_id).toBe("sess-b");
		});

		test("returns a friendly empty result when nothing matches", async () => {
			writeSession("a.jsonl", { id: "sess-a", messages: chat("alpha") });
			const store = makeStore();
			const result = await store.search({ query: "nonexistentterm" });
			expect(result).toMatchObject({ success: true, count: 0, message: "No matching sessions found." });
		});

		test("role_filter narrows which roles match", async () => {
			writeSession("a.jsonl", {
				id: "sess-a",
				messages: [
					{ role: "user", text: "plain user turn" },
					{ role: "assistant", text: "the assistant mentions quokkaword here" },
				],
			});
			const store = makeStore();
			const userOnly = await store.search({ query: "quokkaword", role_filter: "user" });
			expect(userOnly.count).toBe(0);
			const assistantOnly = await store.search({ query: "quokkaword", role_filter: "assistant" });
			expect(assistantOnly.count).toBe(1);
		});

		test("tool results are excluded by default but reachable via role_filter 'tool'", async () => {
			writeSession("a.jsonl", {
				id: "sess-a",
				messages: [
					{ role: "user", text: "run the checker for me" },
					{ role: "toolResult", text: "rig: the access token is marmotword (see docs)" },
				],
			});
			const store = makeStore();
			expect((await store.search({ query: "marmotword" })).count).toBe(0);
			const viaTool = await store.search({ query: "marmotword", role_filter: "tool" });
			expect(viaTool.count).toBe(1);
			const top = (viaTool.results as Record<string, unknown>[])[0]!;
			expect(top.matched_role).toBe("tool");
			const combined = await store.search({ query: "marmotword", role_filter: "user,assistant,tool" });
			expect(combined.count).toBe(1);
		});

		test("custom messages are excluded by the default role filter but reachable explicitly", async () => {
			writeSession("a.jsonl", {
				id: "sess-a",
				messages: [
					{ role: "user", text: "hello there" },
					{ role: "custom:learning-nudge", text: "nudge mentions pelicanword" },
				],
			});
			const store = makeStore();
			expect((await store.search({ query: "pelicanword" })).count).toBe(0);
			const explicit = await store.search({ query: "pelicanword", role_filter: "custom:learning-nudge" });
			expect(explicit.count).toBe(1);
		});

		test("an exact title match surfaces the session as a full result", async () => {
			writeSession("a.jsonl", { id: "sess-a", title: "Payment gateway migration", messages: chat("payments") });
			const store = makeStore();
			const result = await store.search({ query: '"Payment gateway migration"' });
			const results = result.results as Record<string, unknown>[];
			expect(results.length).toBeGreaterThanOrEqual(1);
			expect(results[0]).toMatchObject({ matched_role: "session_title", detail: "full", session_id: "sess-a" });
			expect(String(results[0]!.snippet)).toContain("Payment gateway migration");
		});

		test("clamps limit to [1, 10]", async () => {
			for (let i = 0; i < 12; i++) {
				writeSession(`s${i}.jsonl`, { id: `sess-${i}`, messages: chat(`topic${i}`) });
			}
			const store = makeStore();
			const result = await store.search({ query: "zebraphrase", limit: 50 });
			expect((result.results as unknown[]).length).toBeLessThanOrEqual(10);
			const one = await store.search({ query: "zebraphrase", limit: 0 });
			expect((one.results as unknown[]).length).toBe(1);
		});

		test("truncates long window content with metadata", async () => {
			writeSession("a.jsonl", {
				id: "sess-a",
				messages: [
					{ role: "user", text: `find the walrusword please` },
					{ role: "assistant", text: `walrusword context: ${"y".repeat(6000)}` },
				],
			});
			const store = makeStore();
			const result = await store.search({ query: "walrusword" });
			const top = (result.results as Record<string, unknown>[])[0]!;
			const long = (top.messages as Record<string, unknown>[]).find((m) => m.content_truncated === true);
			expect(long).toBeDefined();
			expect(long!.original_content_chars).toBe(6020);
			expect(String(long!.content).length).toBe(4001); // 4000 + ellipsis
		});

		test("reports when and title metadata on results", async () => {
			writeSession("a.jsonl", {
				id: "sess-a",
				title: "Metadata check",
				timestamp: "2026-08-27T23:47:00.000Z",
				messages: chat("meta"),
			});
			const store = makeStore();
			const result = await store.search({ query: "zebraphrase" });
			const top = (result.results as Record<string, unknown>[])[0]!;
			expect(top.title).toBe("Metadata check");
			expect(String(top.when)).toMatch(/August 2[78], 2026 at/);
		});
	});

	describe(`scroll (${mode.label})`, () => {
		test("returns a window centered on the anchor with before/after counts", async () => {
			const messages: FixtureMessage[] = [];
			for (let i = 0; i < 20; i++)
				messages.push({ role: i % 2 === 0 ? "user" : "assistant", text: `message number ${i}` });
			writeSession("a.jsonl", { id: "sess-a", messages });
			const store = makeStore();
			const result = await store.search({ session_id: "sess-a", around_message_id: 10, window: 2 });
			expect(result).toMatchObject({ success: true, mode: "scroll", around_message_id: 10, window: 2 });
			const window = result.messages as { id: number; anchor?: boolean }[];
			expect(window.map((m) => m.id)).toEqual([8, 9, 10, 11, 12]);
			expect(window.find((m) => m.id === 10)!.anchor).toBe(true);
			expect(result.messages_before).toBe(8);
			expect(result.messages_after).toBe(7);
		});

		test("boundary ids allow scrolling forward and backward", async () => {
			const messages: FixtureMessage[] = [];
			for (let i = 0; i < 20; i++) messages.push({ role: "user", text: `message number ${i}` });
			writeSession("a.jsonl", { id: "sess-a", messages });
			const store = makeStore();
			const first = await store.search({ session_id: "sess-a", around_message_id: 5, window: 2 });
			const firstWindow = first.messages as { id: number }[];
			const next = await store.search({
				session_id: "sess-a",
				around_message_id: firstWindow[firstWindow.length - 1]!.id,
				window: 2,
			});
			const nextWindow = next.messages as { id: number }[];
			expect(nextWindow[0]!.id).toBe(5); // boundary message appears in both windows
		});

		test("rejects scrolling into the current session", async () => {
			writeSession("a.jsonl", { id: "sess-a", messages: chat("alpha") });
			const store = makeStore();
			const result = await store.search({ session_id: "sess-a", around_message_id: 0 }, "sess-a");
			expect(result.success).toBe(false);
			expect(String(result.error)).toContain("already in your active context");
		});

		test("errors on unknown session ids and out-of-range anchors", async () => {
			writeSession("a.jsonl", { id: "sess-a", messages: chat("alpha") });
			const store = makeStore();
			expect(await store.search({ session_id: "sess-nope", around_message_id: 0 })).toMatchObject({
				success: false,
				error: "session_id not found: sess-nope",
			});
			expect(await store.search({ session_id: "sess-a", around_message_id: 999 })).toMatchObject({
				success: false,
				error: "around_message_id 999 not in session_id sess-a",
			});
		});

		test("clamps window to [1, 20] and includes session_meta", async () => {
			writeSession("a.jsonl", {
				id: "sess-a",
				title: "Window test",
				model: "test-model",
				messages: chat("alpha"),
			});
			const store = makeStore();
			const result = await store.search({ session_id: "sess-a", around_message_id: 0, window: 500 });
			expect(result.window).toBe(20);
			expect(result.session_meta).toMatchObject({ title: "Window test", model: "test-model" });
		});
	});

	describe(`read (${mode.label})`, () => {
		test("returns a small session in full", async () => {
			writeSession("a.jsonl", { id: "sess-a", messages: chat("alpha") });
			const store = makeStore();
			const result = await store.search({ session_id: "sess-a" });
			expect(result).toMatchObject({ success: true, mode: "read", message_count: 6, truncated: false });
			expect((result.messages as unknown[]).length).toBe(6);
		});

		test("bounds a large session to head 20 + tail 10", async () => {
			const messages: FixtureMessage[] = [];
			for (let i = 0; i < 50; i++) messages.push({ role: "user", text: `message number ${i}` });
			writeSession("a.jsonl", { id: "sess-a", messages });
			const store = makeStore();
			const result = await store.search({ session_id: "sess-a" });
			expect(result).toMatchObject({ message_count: 50, truncated: true });
			const window = result.messages as { id: number }[];
			expect(window.length).toBe(30);
			expect(window[0]!.id).toBe(0);
			expect(window[19]!.id).toBe(19);
			expect(window[20]!.id).toBe(40);
			expect(String(result.message)).toContain("showing first 20 + last 10");
		});
	});

	describe(`browse (${mode.label})`, () => {
		test("lists recent sessions with metadata, excluding the current one", async () => {
			writeSession("a.jsonl", { id: "sess-a", title: "Older", messages: chat("alpha") });
			writeSession("b.jsonl", { id: "sess-b", title: "Newer", messages: chat("beta") });
			const store = makeStore();
			const result = await store.search({}, "sess-a");
			expect(result).toMatchObject({ success: true, mode: "browse", count: 1 });
			const rows = result.results as Record<string, unknown>[];
			expect(rows[0]).toMatchObject({ session_id: "sess-b", title: "Newer", message_count: 6 });
			expect(String(rows[0]!.preview)).toContain("Let's work on beta");
		});

		test("respects the limit", async () => {
			for (let i = 0; i < 6; i++) writeSession(`s${i}.jsonl`, { id: `sess-${i}`, messages: chat(`t${i}`) });
			const store = makeStore();
			const result = await store.search({ limit: 2 });
			expect((result.results as unknown[]).length).toBe(2);
		});
	});
}

describe("index incrementality (sqlite)", () => {
	test("new and changed session files are picked up on the next search", async () => {
		writeSession("a.jsonl", { id: "sess-a", messages: chat("alpha") });
		const store = track(new SessionStore(sessionsDir, join(dir, "state.db")));
		expect((await store.search({ query: "zebraphrase" })).count).toBe(1);

		writeSession("b.jsonl", { id: "sess-b", messages: chat("beta") });
		expect((await store.search({ query: "zebraphrase" })).count).toBe(2);

		rmSync(join(sessionsDir, "b.jsonl"));
		expect((await store.search({ query: "zebraphrase" })).count).toBe(1);
	});
});

describe("anchoredView", () => {
	const messages: SessionMessage[] = [];
	for (let i = 0; i < 12; i++) {
		messages.push({
			id: i,
			role: i % 3 === 2 ? "custom:noise" : i % 2 === 0 ? "user" : "assistant",
			content: `message ${i}`,
			timestamp: "",
		});
	}

	test("keeps the anchor even when its role is filtered out", () => {
		const view = anchoredView(messages, 2, 1, 0);
		expect(view.window.map((m) => m.id)).toContain(2);
	});

	test("bookends fall strictly outside the window and skip filtered roles", () => {
		const view = anchoredView(messages, 6, 1, 2);
		expect(view.window.map((m) => m.id)).toEqual([6, 7]); // 5 is custom:noise, filtered
		expect(view.bookendStart.every((m) => m.id < 5)).toBe(true);
		expect(view.bookendEnd.every((m) => m.id > 7)).toBe(true);
		expect(view.bookendStart.every((m) => !m.role.startsWith("custom:"))).toBe(true);
	});

	test("returns empty for a missing anchor", () => {
		const view = anchoredView(messages, 99, 5, 3);
		expect(view.window).toEqual([]);
	});

	test("counts messages before and after the raw window", () => {
		const view = anchoredView(messages, 6, 2, 0);
		expect(view.messagesBefore).toBe(4);
		expect(view.messagesAfter).toBe(3);
	});
});

describe("formatTimestamp", () => {
	test("renders a readable date and falls back gracefully", () => {
		expect(formatTimestamp("2026-08-27T15:30:00.000Z")).toMatch(/^[A-Z][a-z]+ \d{2}, 2026 at \d{2}:\d{2} [AP]M$/);
		expect(formatTimestamp(undefined)).toBe("unknown");
		expect(formatTimestamp("not-a-date")).toBe("not-a-date");
	});
});
