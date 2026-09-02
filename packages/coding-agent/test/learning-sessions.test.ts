import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type Embedder, normalizeVector } from "../src/extensions/learning/embeddings.ts";
import {
	anchoredView,
	CHUNK_CHARS,
	chunkText,
	formatTimestamp,
	fuseRankings,
	MAX_CHUNKS_PER_MESSAGE,
	type SessionMessage,
	SessionStore,
} from "../src/extensions/learning/sessions.ts";
import { VectorStore } from "../src/extensions/learning/vectors.ts";

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

/**
 * Hybrid discovery. The fake embedder maps text to a concept vector by
 * keyword, with unrelated words sharing a concept — which is the property
 * real embeddings have and FTS5 does not, and the whole reason for the
 * semantic path.
 */
const CONCEPTS: string[][] = [
	["econnreset", "reconnect", "socket"],
	["auth", "login", "credential"],
	["css", "layout", "style"],
	["gardening", "compost"],
];

class FakeEmbedder implements Embedder {
	readonly modelId = "fake-concepts-v1";
	readonly dim = CONCEPTS.length;
	calls: string[][] = [];
	failNext = false;

	async embed(texts: string[]): Promise<Float32Array[]> {
		if (this.failNext) {
			this.failNext = false;
			throw new Error("embedding server unavailable");
		}
		this.calls.push(texts);
		return texts.map((text) => {
			const lower = text.toLowerCase();
			const vec = new Float32Array(CONCEPTS.length);
			CONCEPTS.forEach((words, dim) => {
				for (const word of words) if (lower.includes(word)) vec[dim] = vec[dim]! + 1;
			});
			return normalizeVector(vec);
		});
	}
}

describe("hybrid discovery", () => {
	let embedder: FakeEmbedder;
	let vectors: VectorStore;

	function hybridStore(): SessionStore {
		return track(new SessionStore(sessionsDir, join(dir, "state.db"), { embedder, vectors, minScore: 0.25 }));
	}

	beforeEach(() => {
		embedder = new FakeEmbedder();
		vectors = new VectorStore(join(dir, "state.db"));
	});

	afterEach(() => {
		vectors.close();
	});

	test("finds a session that shares no words with the query", async () => {
		writeSession("a.jsonl", {
			id: "sess-a",
			messages: [
				{ role: "user", text: "the rpc client keeps dying" },
				{ role: "assistant", text: "ECONNRESET on the rpc client; added backoff and it settled" },
			],
		});
		const store = hybridStore();
		await store.backfill({ maxChunks: 100 });

		// Lexical search alone finds nothing: FTS5 ANDs the quoted terms and
		// neither word appears in the session.
		const lexicalOnly = track(new SessionStore(sessionsDir, join(dir, "lexical.db")));
		expect((await lexicalOnly.search({ query: "reconnect socket" })).count).toBe(0);

		const result = await store.search({ query: "reconnect socket" });
		expect(result.count).toBe(1);
		const top = (result.results as Record<string, unknown>[])[0]!;
		expect(top.session_id).toBe("sess-a");
		expect(top.matched_by).toBe("vector");
		expect(String(top.snippet)).toContain("ECONNRESET");
	});

	test("a chunk both retrievers find outranks one found by either alone", async () => {
		writeSession("both.jsonl", {
			id: "sess-both",
			messages: [{ role: "assistant", text: "added backoff after the socket dropped" }],
		});
		writeSession("vector.jsonl", {
			id: "sess-vector",
			messages: [{ role: "assistant", text: "ECONNRESET from the rpc client" }],
		});
		writeSession("lexical.jsonl", {
			id: "sess-lexical",
			messages: [{ role: "assistant", text: "backoff on the css layout job" }],
		});
		const store = hybridStore();
		await store.backfill({ maxChunks: 100 });

		const result = await store.search({ query: "backoff OR socket", limit: 5 });
		const results = result.results as Record<string, unknown>[];
		expect(results[0]!.session_id).toBe("sess-both");
		expect(results[0]!.matched_by).toBe("both");
		const found = results.map((r) => r.session_id);
		expect(found).toContain("sess-vector");
		expect(found).toContain("sess-lexical");
	});

	test("an unrelated query returns nothing rather than the nearest neighbour", async () => {
		writeSession("a.jsonl", {
			id: "sess-a",
			messages: [{ role: "assistant", text: "ECONNRESET from the rpc client" }],
		});
		const store = hybridStore();
		await store.backfill({ maxChunks: 100 });
		const result = await store.search({ query: "compost gardening" });
		expect(result.count).toBe(0);
	});

	test("a failing embedder degrades to lexical results", async () => {
		writeSession("a.jsonl", { id: "sess-a", messages: chat("alpha") });
		const store = hybridStore();
		await store.backfill({ maxChunks: 100 });
		embedder.failNext = true;
		const result = await store.search({ query: "zebraphrase" });
		expect(result.count).toBe(1);
		expect((result.results as Record<string, unknown>[])[0]!.matched_by).toBe("fts");
	});
});

describe("backfill", () => {
	let embedder: FakeEmbedder;
	let vectors: VectorStore;

	function hybridStore(): SessionStore {
		return track(new SessionStore(sessionsDir, join(dir, "state.db"), { embedder, vectors }));
	}

	beforeEach(() => {
		embedder = new FakeEmbedder();
		vectors = new VectorStore(join(dir, "state.db"));
	});

	afterEach(() => {
		vectors.close();
	});

	test("embeds user and assistant messages but not tool output", async () => {
		writeSession("a.jsonl", {
			id: "sess-a",
			messages: [
				{ role: "user", text: "run the socket test" },
				{ role: "toolResult", text: "econnreset in the log" },
				{ role: "assistant", text: "the socket test passed" },
			],
		});
		const store = hybridStore();
		const result = await store.backfill({ maxChunks: 100 });
		expect(result.embedded).toBe(2);
		expect(await vectors.count()).toBe(2);
	});

	test("is incremental across runs and re-embeds only what changed", async () => {
		writeSession("a.jsonl", { id: "sess-a", messages: chat("alpha") });
		const store = hybridStore();
		expect((await store.backfill({ maxChunks: 100 })).embedded).toBe(6);

		expect((await store.backfill({ maxChunks: 100 })).embedded).toBe(0);

		writeSession("b.jsonl", { id: "sess-b", messages: chat("beta") });
		const third = await store.backfill({ maxChunks: 100 });
		expect(third.embedded).toBe(6);
		expect(third.filesTouched).toBe(1);
	});

	test("stops at the chunk cap and reports itself incomplete", async () => {
		writeSession("a.jsonl", { id: "sess-a", messages: chat("alpha") });
		const store = hybridStore();
		const first = await store.backfill({ maxChunks: 2 });
		expect(first.embedded).toBe(2);
		expect(first.incomplete).toBe(true);
		const second = await store.backfill({ maxChunks: 100 });
		expect(second.embedded).toBe(4);
		expect(second.incomplete).toBe(false);
	});

	test("prunes vectors for session files that no longer exist", async () => {
		writeSession("a.jsonl", { id: "sess-a", messages: chat("alpha") });
		writeSession("b.jsonl", { id: "sess-b", messages: chat("beta") });
		const store = hybridStore();
		await store.backfill({ maxChunks: 100 });
		expect(await vectors.count()).toBe(12);

		rmSync(join(sessionsDir, "b.jsonl"));
		const result = await store.backfill({ maxChunks: 100 });
		expect(result.pathsPruned).toBe(1);
		expect(await vectors.count()).toBe(6);
	});

	test("splits a long message into chunks, stores them as a set, and skips the file next time", async () => {
		const paragraphs = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} about auth and login. `.repeat(12));
		writeSession("a.jsonl", {
			id: "sess-a",
			messages: [
				{ role: "user", text: "tell me about auth" },
				{ role: "assistant", text: paragraphs.join("\n\n") },
			],
		});
		const store = hybridStore();
		const expectedChunks = 1 + chunkText(paragraphs.join("\n\n")).length;
		expect(expectedChunks).toBeGreaterThan(2);
		const first = await store.backfill({ maxChunks: 100 });
		expect(first.embedded).toBe(expectedChunks);
		expect(await vectors.count()).toBe(expectedChunks);

		// Nothing changed: the file is not even read.
		const parse = vi.spyOn(store, "parseSessionFile");
		const second = await store.backfill({ maxChunks: 100 });
		expect(second).toMatchObject({ embedded: 0, filesTouched: 0 });
		expect(parse).not.toHaveBeenCalled();

		// It grew: read again, embed only the new message.
		writeSession("a.jsonl", {
			id: "sess-a",
			messages: [
				{ role: "user", text: "tell me about auth" },
				{ role: "assistant", text: paragraphs.join("\n\n") },
				{ role: "user", text: "thanks" },
			],
		});
		const third = await store.backfill({ maxChunks: 100 });
		expect(parse).toHaveBeenCalledTimes(1);
		expect(third.embedded).toBe(1);
	});

	test("a run cut by the cap does not mark the file complete", async () => {
		writeSession("a.jsonl", { id: "sess-a", messages: chat("alpha") });
		const store = hybridStore();
		await store.backfill({ maxChunks: 2 });
		expect((await vectors.fileState(join(sessionsDir, "a.jsonl")))?.complete ?? false).toBe(false);
		await store.backfill({ maxChunks: 100 });
		expect((await vectors.fileState(join(sessionsDir, "a.jsonl")))?.complete).toBe(true);
	});

	test("does nothing when no embedder is configured", async () => {
		writeSession("a.jsonl", { id: "sess-a", messages: chat("alpha") });
		const store = track(new SessionStore(sessionsDir, join(dir, "state.db")));
		expect(store.semanticEnabled).toBe(false);
		expect(await store.backfill({ maxChunks: 100 })).toMatchObject({ embedded: 0 });
	});
});

describe("chunkText", () => {
	test("a short message is one chunk, trimmed", () => {
		expect(chunkText("  hello world  ")).toEqual(["hello world"]);
	});

	test("cuts at a paragraph break in the back half of the window", () => {
		const a = "a".repeat(1200);
		const b = "b".repeat(1200);
		expect(chunkText(`${a}\n\n${b}`)).toEqual([a, b]);
	});

	test("falls back to a line break, then a sentence end, then a hard cut", () => {
		const line = `${"x".repeat(1000)}\n${"y".repeat(1000)}`;
		expect(chunkText(line).map((c) => c.length)).toEqual([1000, 1000]);
		const sentence = `${"s".repeat(1000)}. ${"t".repeat(1000)}`;
		expect(chunkText(sentence).map((c) => c.length)).toEqual([1001, 1000]);
		const solid = "z".repeat(CHUNK_CHARS * 2 + 10);
		expect(chunkText(solid).map((c) => c.length)).toEqual([CHUNK_CHARS, CHUNK_CHARS, 10]);
	});

	test("caps the number of chunks per message", () => {
		const huge = "q".repeat(CHUNK_CHARS * (MAX_CHUNKS_PER_MESSAGE + 5));
		expect(chunkText(huge)).toHaveLength(MAX_CHUNKS_PER_MESSAGE);
	});
});

describe("fuseRankings", () => {
	function hit(path: string, idx: number, matchedBy: "fts" | "vector"): Parameters<typeof fuseRankings>[0][number] {
		return { path, idx, sessionId: `s-${idx}`, role: "user", ts: "", snippet: "", matchedBy };
	}

	test("a chunk in both lists beats a chunk ranked first in one", () => {
		const lexical = [hit("a", 1, "fts"), hit("a", 2, "fts")];
		const semantic = [hit("a", 3, "vector"), hit("a", 2, "vector")];
		const fused = fuseRankings(lexical, semantic);
		expect(fused[0]!.idx).toBe(2);
		expect(fused[0]!.matchedBy).toBe("both");
	});

	test("keeps the marked-up lexical snippet over a synthesized one", () => {
		const lexical = [{ ...hit("a", 1, "fts"), snippet: ">>>match<<<" }];
		const semantic = [hit("a", 1, "vector")];
		expect(fuseRankings(lexical, semantic)[0]!.snippet).toBe(">>>match<<<");
	});

	test("returns one list unchanged when the other is empty", () => {
		const lexical = [hit("a", 1, "fts"), hit("a", 2, "fts")];
		expect(fuseRankings(lexical, []).map((h) => h.idx)).toEqual([1, 2]);
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
