import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import {
	classifyError,
	DEFAULT_HINDSIGHT_CONFIG,
	deriveArgKey,
	extractErrorText,
	HindsightStore,
	type HindsightWiring,
	readHindsightConfig,
	type ToolCallRow,
	wireHindsight,
} from "../src/extensions/learning/hindsight.ts";
import { createLearningExtension, type LearningStores } from "../src/extensions/learning/index.ts";
import { SessionStore } from "../src/extensions/learning/sessions.ts";

/**
 * Hindsight tests: error classification, the SQLite store (shared state.db,
 * additive self-versioned tables), and the event wiring — collection,
 * retry linkage, frozen notes injection, and reactive hints.
 */

interface FakeCommand {
	description?: string;
	handler(args: string, ctx: unknown): Promise<void>;
}

class FakeSmolt {
	handlers = new Map<string, ((event: Record<string, unknown>) => Promise<unknown>)[]>();
	commands = new Map<string, FakeCommand>();
	sentMessages: Record<string, unknown>[] = [];
	sentUserMessages: string[] = [];
	notifications: string[] = [];

	on(event: string, handler: (event: Record<string, unknown>) => Promise<unknown>): void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
	}

	registerTool(): void {}

	registerCommand(name: string, command: FakeCommand): void {
		this.commands.set(name, command);
	}

	sendMessage(message: Record<string, unknown>): void {
		this.sentMessages.push(message);
	}

	sendUserMessage(content: string): void {
		this.sentUserMessages.push(content);
	}

	async runCommand(name: string, args: string): Promise<void> {
		const command = this.commands.get(name);
		if (!command) throw new Error(`command not registered: ${name}`);
		const ctx = { ui: { notify: (message: string) => this.notifications.push(message) } };
		await command.handler(args, ctx);
	}

	async fire(event: string, payload: Record<string, unknown> = {}): Promise<unknown> {
		let result: unknown;
		for (const handler of this.handlers.get(event) ?? []) {
			result = await handler({ type: event, ...payload });
		}
		return result;
	}
}

let dir: string;
let dbPath: string;
let openStores: { close(): void }[];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hindsight-"));
	dbPath = join(dir, "state.db");
	openStores = [];
});

afterEach(() => {
	for (const store of openStores) store.close();
	rmSync(dir, { recursive: true, force: true });
});

function track<T extends { close(): void }>(store: T): T {
	openStores.push(store);
	return store;
}

let rowSeq = 0;

function mkRow(id: string, over: Partial<ToolCallRow> = {}): ToolCallRow {
	rowSeq += 1;
	return {
		toolCallId: id,
		sessionId: "s1",
		turnIndex: 0,
		tool: "write",
		argKey: "a.txt",
		argDetail: "a.txt",
		cwd: "",
		startedAt: 1_000_000 + rowSeq,
		durationMs: 5,
		isError: false,
		errorClass: undefined,
		retryOf: undefined,
		...over,
	};
}

/** Three ebusy failures on `write`, each retried successfully. */
function remedyRows(): ToolCallRow[] {
	const rows: ToolCallRow[] = [];
	for (let i = 0; i < 3; i++) {
		rows.push(mkRow(`fail-${i}`, { isError: true, errorClass: "ebusy" }));
		rows.push(mkRow(`retry-${i}`, { retryOf: `fail-${i}` }));
	}
	return rows;
}

async function queryRows(path: string): Promise<Record<string, unknown>[]> {
	const specifier = "node:sqlite";
	const mod = (await import(specifier)) as {
		DatabaseSync: new (
			p: string,
		) => {
			prepare(sql: string): { all(): unknown[] };
			close(): void;
		};
	};
	const db = new mod.DatabaseSync(path);
	try {
		return db.prepare("SELECT * FROM hindsight_tool_calls ORDER BY started_at").all() as Record<string, unknown>[];
	} finally {
		db.close();
	}
}

describe("error classification", () => {
	test("maps known error strings to classes", () => {
		expect(classifyError("write", "EBUSY: resource busy or locked")).toBe("ebusy");
		expect(classifyError("read", "ENOENT: no such file or directory")).toBe("enoent");
		expect(classifyError("bash", "permission denied")).toBe("eacces");
		expect(classifyError("bash", "the operation timed out")).toBe("timeout");
		expect(classifyError("bash", "zsh: command not found: foo")).toBe("command-not-found");
		expect(classifyError("bash", "'foo' is not recognized as an internal or external command")).toBe(
			"command-not-found",
		);
		expect(classifyError("edit", "old_string not found in file")).toBe("edit-mismatch");
		expect(classifyError("bash", "SyntaxError: unexpected token")).toBe("syntax-error");
		expect(classifyError("memory", "invalid params: required parameter 'target'")).toBe("schema-rejection");
		expect(classifyError("bash", "connect ECONNREFUSED 127.0.0.1:3000")).toBe("network");
		expect(classifyError("write", "ENOSPC: no space left on device")).toBe("disk-space");
		expect(classifyError("bash", "process aborted")).toBe("interrupted");
	});

	test("refines shell exit codes after the generic table misses", () => {
		expect(classifyError("bash", "Command exited with code 127")).toBe("exit-127");
		expect(classifyError("bash", "Command exited with code 126")).toBe("exit-126");
		expect(classifyError("bash", "Command exited with code 1")).toBe("exit-nonzero");
		// A generic class wins over the exit-code fallback.
		expect(classifyError("bash", "ENOENT\nCommand exited with code 1")).toBe("enoent");
		// Exit codes only apply to shell tools.
		expect(classifyError("write", "Command exited with code 1")).toBe("unclassified");
	});

	test("falls back to unclassified", () => {
		expect(classifyError("bash", "something completely novel went wrong")).toBe("unclassified");
	});

	test("extractErrorText joins only text blocks", () => {
		expect(
			extractErrorText([
				{ type: "text", text: "line one" },
				{ type: "image", data: "..." },
				{ type: "text", text: "line two" },
			]),
		).toBe("line one\nline two");
		expect(extractErrorText("plain")).toBe("plain");
		expect(extractErrorText(undefined)).toBe("");
	});
});

describe("arg keys", () => {
	test("shell commands group by leading tokens", () => {
		expect(deriveArgKey("bash", { command: "npm test --verbose" }).argKey).toBe("npm test");
		expect(deriveArgKey("bash", { command: "ls -la" }).argKey).toBe("ls");
		expect(deriveArgKey("bash", { command: "cd /some/dir && npm test" }).argKey).toBe("npm test");
		expect(deriveArgKey("bash", { command: "FOO=1 BAR=2 git push origin" }).argKey).toBe("git push");
	});

	test("file tools group by basename", () => {
		expect(deriveArgKey("write", { path: "/deep/nested/file.ts" }).argKey).toBe("file.ts");
		expect(deriveArgKey("edit", { file_path: "C:\\repo\\thing.md" }).argKey).toBe("thing.md");
	});

	test("detail keeps the raw arg, truncated", () => {
		const long = "x".repeat(300);
		const { argKey, argDetail } = deriveArgKey("bash", { command: long });
		expect(argDetail.length).toBe(200);
		expect(argKey.length).toBeLessThanOrEqual(80);
	});

	test("missing args yield empty keys", () => {
		expect(deriveArgKey("bash", undefined)).toEqual({ argKey: "", argDetail: "" });
	});
});

describe("config", () => {
	test("missing and malformed files yield defaults", () => {
		expect(readHindsightConfig(join(dir, "absent.json"))).toEqual(DEFAULT_HINDSIGHT_CONFIG);
		const bad = join(dir, "bad.json");
		writeFileSync(bad, "{not json", "utf-8");
		expect(readHindsightConfig(bad)).toEqual(DEFAULT_HINDSIGHT_CONFIG);
		expect(readHindsightConfig(undefined)).toEqual(DEFAULT_HINDSIGHT_CONFIG);
	});

	test("valid fields override defaults", () => {
		const file = join(dir, "hindsight.json");
		writeFileSync(file, JSON.stringify({ enabled: false, minSamples: 2 }), "utf-8");
		const config = readHindsightConfig(file);
		expect(config.enabled).toBe(false);
		expect(config.minSamples).toBe(2);
		expect(config.notesBudgetChars).toBe(DEFAULT_HINDSIGHT_CONFIG.notesBudgetChars);
	});
});

describe("store", () => {
	test("flush persists rows and survives reopen without dropping", async () => {
		const store = track(new HindsightStore(dbPath));
		await store.flush([mkRow("a"), mkRow("b", { isError: true, errorClass: "ebusy" })]);
		store.close();
		const reopened = track(new HindsightStore(dbPath));
		await reopened.flush([mkRow("c")]);
		const rows = await queryRows(dbPath);
		expect(rows.length).toBe(3);
	});

	test("flush is idempotent per tool_call_id", async () => {
		const store = track(new HindsightStore(dbPath));
		await store.flush([mkRow("a")]);
		await store.flush([mkRow("a", { isError: true, errorClass: "ebusy" })]);
		const rows = await queryRows(dbPath);
		expect(rows.length).toBe(1);
		expect(rows[0]!.is_error).toBe(1);
	});

	test("shares state.db with the session index without loss", async () => {
		const store = track(new HindsightStore(dbPath));
		await store.flush(remedyRows());
		// The session index initializes (and version-stamps) the same file.
		const sessions = track(new SessionStore(join(dir, "sessions"), dbPath));
		await sessions.search({}, "current");
		const rows = await queryRows(dbPath);
		expect(rows.length).toBe(6);
	});

	test("loadRemedyStats links retries to their failures", async () => {
		const store = track(new HindsightStore(dbPath));
		await store.flush(remedyRows());
		const stats = await store.loadRemedyStats();
		expect(stats.get("write|ebusy")).toEqual({ seen: 3, attempts: 3, successes: 3 });
	});

	test("distillNotes renders counts, remedies, and top args", async () => {
		const store = track(new HindsightStore(dbPath));
		await store.flush(remedyRows());
		const notes = await store.distillNotes({ ...DEFAULT_HINDSIGHT_CONFIG, minSamples: 1 });
		expect(notes).toContain("## Tool field notes");
		expect(notes).toContain("- write: ebusy 3x");
		expect(notes).toContain("(most often `a.txt`)");
		expect(notes).toContain("retry succeeded 3/3");
		expect(notes).toContain("retry the same call once");
	});

	test("distillNotes honors minSamples and excludes unclassified", async () => {
		const store = track(new HindsightStore(dbPath));
		await store.flush([
			mkRow("u1", { isError: true, errorClass: "unclassified" }),
			mkRow("u2", { isError: true, errorClass: "unclassified" }),
			mkRow("e1", { isError: true, errorClass: "ebusy" }),
		]);
		expect(await store.distillNotes({ ...DEFAULT_HINDSIGHT_CONFIG, minSamples: 2 })).toBe("");
		const notes = await store.distillNotes({ ...DEFAULT_HINDSIGHT_CONFIG, minSamples: 1 });
		expect(notes).toContain("ebusy");
		expect(notes).not.toContain("unclassified");
	});

	test("distillNotes stays within the char budget, whole lines only", async () => {
		const store = track(new HindsightStore(dbPath));
		const rows: ToolCallRow[] = [];
		for (let t = 0; t < 10; t++) {
			for (let i = 0; i < 3; i++) {
				rows.push(mkRow(`t${t}-${i}`, { tool: `tool-${t}`, isError: true, errorClass: "ebusy" }));
			}
		}
		await store.flush(rows);
		const budget = 400;
		const notes = await store.distillNotes({ enabled: true, notesBudgetChars: budget, minSamples: 1 });
		expect(notes.length).toBeLessThanOrEqual(budget);
		for (const line of notes.split("\n").slice(2)) {
			expect(line).toMatch(/^- tool-\d+: ebusy 3x/);
		}
	});

	test("empty database distills to the empty string", async () => {
		const store = track(new HindsightStore(dbPath));
		expect(await store.distillNotes(DEFAULT_HINDSIGHT_CONFIG)).toBe("");
	});

	test("degrades silently when sqlite cannot open the path", async () => {
		const poisoned = join(dir, "as-dir.db");
		mkdirSync(poisoned, { recursive: true });
		const store = track(new HindsightStore(poisoned));
		await store.flush([mkRow("a")]);
		expect(await store.distillNotes(DEFAULT_HINDSIGHT_CONFIG)).toBe("");
		expect((await store.loadRemedyStats()).size).toBe(0);
	});

	test("close is safe when never opened", () => {
		const store = new HindsightStore(dbPath);
		expect(() => store.close()).not.toThrow();
	});
});

interface ToolCallFire {
	id: string;
	tool: string;
	args?: Record<string, unknown>;
	isError?: boolean;
	errorText?: string;
}

async function fireCall(smolt: FakeSmolt, call: ToolCallFire): Promise<unknown> {
	const content = call.isError ? [{ type: "text", text: call.errorText ?? "boom" }] : [{ type: "text", text: "ok" }];
	await smolt.fire("tool_execution_start", { toolCallId: call.id, toolName: call.tool, args: call.args ?? {} });
	const resultReturn = await smolt.fire("tool_result", {
		toolCallId: call.id,
		toolName: call.tool,
		input: call.args ?? {},
		content,
		isError: call.isError === true,
	});
	await smolt.fire("tool_execution_end", {
		toolCallId: call.id,
		toolName: call.tool,
		result: {},
		isError: call.isError === true,
	});
	return resultReturn;
}

describe("wiring", () => {
	let smolt: FakeSmolt;
	let wiring: HindsightWiring;

	function wire(configPath?: string): void {
		smolt = new FakeSmolt();
		wiring = wireHindsight(smolt as unknown as ExtensionAPI, { dbPath, configPath });
		track(wiring.store);
	}

	test("collects a row per tool call and flushes at turn end", async () => {
		wire();
		await smolt.fire("session_start");
		await fireCall(smolt, { id: "c1", tool: "bash", args: { command: "npm test" } });
		await fireCall(smolt, {
			id: "c2",
			tool: "write",
			args: { path: "/tmp/a.txt" },
			isError: true,
			errorText: "EBUSY: resource busy",
		});
		await smolt.fire("turn_end", { turnIndex: 0 });
		const rows = await queryRows(dbPath);
		expect(rows.length).toBe(2);
		const [first, second] = rows as [Record<string, unknown>, Record<string, unknown>];
		expect(first.tool).toBe("bash");
		expect(first.arg_key).toBe("npm test");
		expect(first.is_error).toBe(0);
		expect(typeof first.duration_ms).toBe("number");
		expect(second.tool).toBe("write");
		expect(second.error_class).toBe("ebusy");
	});

	test("finalizes regardless of end/result event order", async () => {
		wire();
		await smolt.fire("session_start");
		// End before result.
		await smolt.fire("tool_execution_start", { toolCallId: "c1", toolName: "bash", args: { command: "ls" } });
		await smolt.fire("tool_execution_end", { toolCallId: "c1", toolName: "bash", result: {}, isError: false });
		await smolt.fire("tool_result", {
			toolCallId: "c1",
			toolName: "bash",
			input: { command: "ls" },
			content: [{ type: "text", text: "ok" }],
			isError: false,
		});
		await smolt.fire("turn_end", {});
		const rows = await queryRows(dbPath);
		expect(rows.length).toBe(1);
		expect(rows[0]!.arg_key).toBe("ls");
	});

	test("stragglers flush with what they have", async () => {
		wire();
		await smolt.fire("session_start");
		// Result half only — tool_execution_end never arrives.
		await smolt.fire("tool_result", {
			toolCallId: "lost",
			toolName: "bash",
			input: { command: "npm test" },
			content: [{ type: "text", text: "Command exited with code 1" }],
			isError: true,
		});
		await smolt.fire("turn_end", {});
		const rows = await queryRows(dbPath);
		expect(rows.length).toBe(1);
		expect(rows[0]!.duration_ms).toBeNull();
		expect(rows[0]!.error_class).toBe("exit-nonzero");
	});

	test("session_shutdown flushes without a turn_end", async () => {
		wire();
		await smolt.fire("session_start");
		await fireCall(smolt, { id: "c1", tool: "bash", args: { command: "ls" } });
		await smolt.fire("session_shutdown", { reason: "quit" });
		const rows = await queryRows(dbPath);
		expect(rows.length).toBe(1);
	});

	test("links a retry to the failure it retries", async () => {
		wire();
		await smolt.fire("session_start");
		await fireCall(smolt, {
			id: "f1",
			tool: "bash",
			args: { command: "npm test" },
			isError: true,
			errorText: "Command exited with code 1",
		});
		// An unrelated call between failure and retry does not break the link.
		await fireCall(smolt, { id: "other", tool: "read", args: { path: "x.txt" } });
		await fireCall(smolt, { id: "r1", tool: "bash", args: { command: "npm test" } });
		await smolt.fire("turn_end", {});
		const rows = await queryRows(dbPath);
		const retry = rows.find((r) => r.tool_call_id === "r1");
		expect(retry?.retry_of).toBe("f1");
	});

	test("does not link beyond the lookback window", async () => {
		wire();
		await smolt.fire("session_start");
		await fireCall(smolt, { id: "f1", tool: "bash", args: { command: "npm test" }, isError: true });
		await fireCall(smolt, { id: "o1", tool: "read", args: { path: "a" } });
		await fireCall(smolt, { id: "o2", tool: "read", args: { path: "b" } });
		await fireCall(smolt, { id: "o3", tool: "read", args: { path: "c" } });
		await fireCall(smolt, { id: "late", tool: "bash", args: { command: "npm test" } });
		await smolt.fire("turn_end", {});
		const rows = await queryRows(dbPath);
		const late = rows.find((r) => r.tool_call_id === "late");
		expect(late?.retry_of).toBeNull();
	});

	test("injects frozen field notes standalone", async () => {
		const seed = track(new HindsightStore(dbPath));
		await seed.flush(remedyRows());
		seed.close();
		const configPath = join(dir, "hindsight.json");
		writeFileSync(configPath, JSON.stringify({ minSamples: 1 }), "utf-8");
		wire(configPath);
		await smolt.fire("session_start");
		const first = (await smolt.fire("before_agent_start", { systemPrompt: "BASE" })) as { systemPrompt: string };
		expect(first.systemPrompt.startsWith("BASE")).toBe(true);
		expect(first.systemPrompt).toContain("## Tool field notes");
		// New rows mid-session do not change the frozen block.
		await fireCall(smolt, { id: "n1", tool: "edit", args: { path: "z.ts" }, isError: true, errorText: "EBUSY" });
		await smolt.fire("turn_end", {});
		const second = (await smolt.fire("before_agent_start", { systemPrompt: "BASE" })) as { systemPrompt: string };
		expect(second.systemPrompt).toBe(first.systemPrompt);
	});

	test("leaves the prompt untouched when there are no notes", async () => {
		wire();
		await smolt.fire("session_start");
		const result = await smolt.fire("before_agent_start", { systemPrompt: "BASE" });
		expect(result).toBeUndefined();
	});

	test("appends a hint once per tool+class when the remedy record qualifies", async () => {
		const seed = track(new HindsightStore(dbPath));
		await seed.flush(remedyRows());
		seed.close();
		wire();
		await smolt.fire("session_start");
		const first = (await fireCall(smolt, {
			id: "h1",
			tool: "write",
			args: { path: "b.txt" },
			isError: true,
			errorText: "EBUSY: resource busy",
		})) as { content: { type: string; text: string }[] };
		expect(first.content.length).toBe(2);
		expect(first.content[0]!.text).toContain("EBUSY");
		expect(first.content[1]!.text).toContain("[hindsight] Known error pattern: write + ebusy");
		expect(first.content[1]!.text).toContain("retry succeeded 3/3");
		// Second occurrence of the same pair stays silent.
		const second = await fireCall(smolt, {
			id: "h2",
			tool: "write",
			args: { path: "c.txt" },
			isError: true,
			errorText: "EBUSY: resource busy",
		});
		expect(second).toBeUndefined();
		// A new session resets the budget.
		await smolt.fire("session_start");
		const third = (await fireCall(smolt, {
			id: "h3",
			tool: "write",
			args: { path: "d.txt" },
			isError: true,
			errorText: "EBUSY: resource busy",
		})) as { content: unknown[] };
		expect(third.content.length).toBe(2);
	});

	test("stays silent below the remedy thresholds", async () => {
		const seed = track(new HindsightStore(dbPath));
		// Two attempts only — below HINT_MIN_ATTEMPTS.
		await seed.flush([
			mkRow("f0", { isError: true, errorClass: "ebusy" }),
			mkRow("r0", { retryOf: "f0" }),
			mkRow("f1", { isError: true, errorClass: "ebusy" }),
			mkRow("r1", { retryOf: "f1" }),
		]);
		seed.close();
		wire();
		await smolt.fire("session_start");
		const result = await fireCall(smolt, {
			id: "h1",
			tool: "write",
			args: { path: "b.txt" },
			isError: true,
			errorText: "EBUSY",
		});
		expect(result).toBeUndefined();
	});

	test("enabled:false registers nothing", async () => {
		const configPath = join(dir, "hindsight.json");
		writeFileSync(configPath, JSON.stringify({ enabled: false }), "utf-8");
		wire(configPath);
		expect(smolt.handlers.size).toBe(0);
	});

	test("absorbs everything silently when sqlite is unavailable", async () => {
		const poisoned = join(dir, "as-dir.db");
		mkdirSync(poisoned, { recursive: true });
		smolt = new FakeSmolt();
		wiring = wireHindsight(smolt as unknown as ExtensionAPI, { dbPath: poisoned });
		track(wiring.store);
		await smolt.fire("session_start");
		await fireCall(smolt, { id: "c1", tool: "bash", args: { command: "ls" }, isError: true });
		await smolt.fire("turn_end", {});
		expect(await smolt.fire("before_agent_start", { systemPrompt: "BASE" })).toBeUndefined();
	});
});

describe("/hindsight command", () => {
	let smolt: FakeSmolt;

	function wire(): void {
		smolt = new FakeSmolt();
		track(wireHindsight(smolt as unknown as ExtensionAPI, { dbPath }).store);
	}

	test("summary aggregates totals, failures, and tools", async () => {
		const store = track(new HindsightStore(dbPath));
		await store.flush([...remedyRows(), mkRow("ok1", { tool: "read" }), mkRow("ok2", { tool: "read" })]);
		const summary = await store.summary();
		expect(summary?.calls).toBe(8);
		expect(summary?.errors).toBe(3);
		expect(summary?.sessions).toBe(1);
		expect(summary?.topFailures[0]).toMatchObject({ tool: "write", error_class: "ebusy", count: 3, successes: 3 });
		expect(summary?.topTools[0]).toMatchObject({ tool: "write", calls: 6 });
	});

	test("no args posts a breakdown message without triggering a turn", async () => {
		const seed = track(new HindsightStore(dbPath));
		await seed.flush(remedyRows());
		seed.close();
		wire();
		await smolt.runCommand("hindsight", "");
		expect(smolt.sentUserMessages.length).toBe(0);
		expect(smolt.sentMessages.length).toBe(1);
		const message = smolt.sentMessages[0]!;
		expect(message.customType).toBe("hindsight-report");
		expect(message.display).toBe(true);
		const content = message.content as string;
		expect(content).toContain("## Hindsight — observed tool usage");
		expect(content).toContain("6 calls");
		expect(content).toContain("- write: ebusy 3x — retry succeeded 3/3");
		expect(content).toContain("**Busiest tools**");
	});

	test("empty database notifies instead of posting", async () => {
		wire();
		await smolt.runCommand("hindsight", "");
		expect(smolt.sentMessages.length).toBe(0);
		expect(smolt.notifications[0]).toContain("No hindsight data yet");
	});

	test("a question becomes a user prompt carrying matching data", async () => {
		const seed = track(new HindsightStore(dbPath));
		await seed.flush([...remedyRows(), mkRow("npm1", { tool: "bash", argKey: "npm test", argDetail: "npm test" })]);
		seed.close();
		wire();
		await smolt.runCommand("hindsight", "what keeps failing with ebusy?");
		expect(smolt.sentMessages.length).toBe(0);
		expect(smolt.sentUserMessages.length).toBe(1);
		const prompt = smolt.sentUserMessages[0]!;
		expect(prompt).toContain('telemetry: "what keeps failing with ebusy?"');
		expect(prompt).toContain("Overall: 7 calls, 3 errors");
		expect(prompt).toContain("Calls matching the question");
		expect(prompt).toContain("→ ebusy");
		expect(prompt).not.toContain("npm test");
	});

	test("a question with no matching calls still prompts from overall stats", async () => {
		const seed = track(new HindsightStore(dbPath));
		await seed.flush(remedyRows());
		seed.close();
		wire();
		await smolt.runCommand("hindsight", "anything about kubernetes?");
		const prompt = smolt.sentUserMessages[0]!;
		expect(prompt).toContain("No individual calls matched");
	});
});

describe("learning integration", () => {
	test("field notes ride inside the learning frozen block", async () => {
		const seed = track(new HindsightStore(dbPath));
		await seed.flush(remedyRows());
		seed.close();
		const configPath = join(dir, "hindsight.json");
		writeFileSync(configPath, JSON.stringify({ minSamples: 1 }), "utf-8");
		const smolt = new FakeSmolt();
		const stores: LearningStores = createLearningExtension(smolt as unknown as ExtensionAPI, {
			memoriesDir: join(dir, "memories"),
			skillsRoot: join(dir, "skills"),
			sessionsRoot: join(dir, "sessions"),
			stateDbPath: dbPath,
			hindsightConfigPath: configPath,
		});
		track(stores.sessions);
		track(stores.hindsight);
		await smolt.fire("session_start");
		const result = (await smolt.fire("before_agent_start", { systemPrompt: "BASE" })) as { systemPrompt: string };
		expect(result.systemPrompt).toContain("## Self-learning");
		expect(result.systemPrompt).toContain("## Tool field notes");
		expect(result.systemPrompt.indexOf("## Self-learning")).toBeLessThan(
			result.systemPrompt.indexOf("## Tool field notes"),
		);
	});
});
