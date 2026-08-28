import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { createLearningExtension, type LearningStores } from "../src/extensions/learning/index.ts";

/**
 * Wiring tests for the learning extension: system-prompt injection with a
 * frozen memory snapshot, the periodic persistence nudge, and end-to-end
 * tool dispatch through the registered tool definitions.
 */

interface RegisteredTool {
	name: string;
	description: string;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: unknown,
		onUpdate?: unknown,
		ctx?: unknown,
	): Promise<{ content: { type: string; text: string }[] }>;
}

class FakeSmolt {
	handlers = new Map<string, ((event: Record<string, unknown>) => Promise<unknown>)[]>();
	tools = new Map<string, RegisteredTool>();

	on(event: string, handler: (event: Record<string, unknown>) => Promise<unknown>): void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
	}

	registerTool(tool: RegisteredTool): void {
		this.tools.set(tool.name, tool);
	}

	async fire(event: string, payload: Record<string, unknown> = {}): Promise<unknown> {
		let result: unknown;
		for (const handler of this.handlers.get(event) ?? []) {
			result = await handler({ type: event, ...payload });
		}
		return result;
	}

	async runTool(
		name: string,
		params: Record<string, unknown>,
		sessionId = "current-session",
	): Promise<Record<string, unknown>> {
		const tool = this.tools.get(name);
		if (!tool) throw new Error(`tool not registered: ${name}`);
		const ctx = { sessionManager: { getSessionId: () => sessionId } };
		const result = await tool.execute("call-1", params, undefined, undefined, ctx);
		return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
	}
}

let dir: string;
let smolt: FakeSmolt;
let stores: LearningStores;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "learning-ext-"));
	smolt = new FakeSmolt();
	stores = createLearningExtension(smolt as unknown as ExtensionAPI, {
		memoriesDir: join(dir, "memories"),
		skillsRoot: join(dir, "skills"),
		sessionsRoot: join(dir, "sessions"),
		stateDbPath: join(dir, "state.db"),
	});
});

afterEach(() => {
	stores.sessions.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("system prompt injection", () => {
	test("appends the self-learning instructions", async () => {
		await smolt.fire("session_start");
		const result = (await smolt.fire("before_agent_start", { systemPrompt: "BASE" })) as { systemPrompt: string };
		expect(result.systemPrompt.startsWith("BASE")).toBe(true);
		expect(result.systemPrompt).toContain("## Self-learning");
		expect(result.systemPrompt).toContain("session_search");
	});

	test("includes memory blocks and freezes them for the whole session", async () => {
		mkdirSync(join(dir, "memories"), { recursive: true });
		writeFileSync(join(dir, "memories", "MEMORY.md"), "the deploy target is fly.io", "utf-8");

		await smolt.fire("session_start");
		const first = (await smolt.fire("before_agent_start", { systemPrompt: "BASE" })) as { systemPrompt: string };
		expect(first.systemPrompt).toContain("MEMORY (your personal notes)");
		expect(first.systemPrompt).toContain("the deploy target is fly.io");

		// A mid-session write lands on disk but not in the frozen prompt.
		await smolt.runTool("memory", { action: "add", content: "a brand new fact" });
		const second = (await smolt.fire("before_agent_start", { systemPrompt: "BASE" })) as { systemPrompt: string };
		expect(second.systemPrompt).not.toContain("a brand new fact");

		// The next session refreshes the snapshot.
		await smolt.fire("session_start");
		const third = (await smolt.fire("before_agent_start", { systemPrompt: "BASE" })) as { systemPrompt: string };
		expect(third.systemPrompt).toContain("a brand new fact");
	});
});

describe("periodic nudge", () => {
	test("injects a persistence reminder every 8 turns", async () => {
		await smolt.fire("session_start");
		for (let turn = 1; turn <= 7; turn++) await smolt.fire("turn_end", { turnIndex: turn });
		let result = (await smolt.fire("before_agent_start", { systemPrompt: "BASE" })) as Record<string, unknown>;
		expect(result.message).toBeUndefined();

		await smolt.fire("turn_end", { turnIndex: 8 });
		result = (await smolt.fire("before_agent_start", { systemPrompt: "BASE" })) as Record<string, unknown>;
		expect(result.message).toMatchObject({ customType: "learning-nudge", display: false });

		// The nudge is one-shot until the next multiple of 8.
		result = (await smolt.fire("before_agent_start", { systemPrompt: "BASE" })) as Record<string, unknown>;
		expect(result.message).toBeUndefined();
	});
});

describe("registered tools", () => {
	test("memory tool round-trips through JSON results", async () => {
		const add = await smolt.runTool("memory", { action: "add", content: "tool-registered fact" });
		expect(add).toMatchObject({ success: true, done: true, target: "memory", entry_count: 1 });

		const batch = await smolt.runTool("memory", {
			operations: [
				{ action: "replace", old_text: "tool-registered", content: "updated fact" },
				{ action: "add", content: "second fact" },
			],
		});
		expect(batch).toMatchObject({ success: true, entry_count: 2, message: "Applied 2 operation(s)." });
	});

	test("skill_manage tool creates and patches a skill", async () => {
		const content = [
			"---",
			"name: quick-skill",
			"description: Do the thing quickly.",
			"---",
			"",
			"## When to Use",
			"- Whenever.",
			"",
			"## Procedure",
			"1. Do it.",
		].join("\n");
		const create = await smolt.runTool("skill_manage", { action: "create", name: "quick-skill", content });
		expect(create).toMatchObject({ success: true, message: "Skill 'quick-skill' created." });

		const patch = await smolt.runTool("skill_manage", {
			action: "patch",
			name: "quick-skill",
			old_string: "1. Do it.",
			new_string: "1. Do it carefully.",
		});
		expect(patch).toMatchObject({ success: true });
	});

	test("session_search excludes the current session and searches the rest", async () => {
		const sessionsDir = join(dir, "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		const mkSession = (id: string, text: string): string =>
			[
				JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-08-01T10:00:00.000Z", cwd: "/p" }),
				JSON.stringify({
					type: "message",
					id: "e0",
					parentId: null,
					timestamp: "2026-08-01T10:01:00.000Z",
					message: { role: "user", content: [{ type: "text", text }] },
				}),
			].join("\n");
		writeFileSync(join(sessionsDir, "old.jsonl"), mkSession("old-session", "we fixed the flamingo bug"), "utf-8");
		writeFileSync(
			join(sessionsDir, "cur.jsonl"),
			mkSession("current-session", "the flamingo bug reappears"),
			"utf-8",
		);

		const result = await smolt.runTool("session_search", { query: "flamingo" });
		expect(result).toMatchObject({ success: true, mode: "discover", count: 1 });
		expect((result.results as Record<string, unknown>[])[0]!.session_id).toBe("old-session");

		const browse = await smolt.runTool("session_search", {});
		expect(browse).toMatchObject({ mode: "browse", count: 1 });
	});
});
