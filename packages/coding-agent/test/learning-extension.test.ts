import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { DEFAULT_EMBEDDING_CONFIG, type Embedder } from "../src/extensions/learning/embeddings.ts";
import type { ToolCallRow } from "../src/extensions/learning/hindsight.ts";
import { createLearningExtension, type LearningStores, renderSkillUsage } from "../src/extensions/learning/index.ts";
import { provideSemanticRecall, type SemanticRecall, takeSemanticRecall } from "../src/extensions/learning/semantic.ts";
import { VectorStore } from "../src/extensions/learning/vectors.ts";

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

interface RegisteredCommand {
	description?: string;
	handler(args: string, ctx: { ui: { notify(text: string, level?: string): void } }): Promise<void>;
}

class FakeSmolt {
	handlers = new Map<string, ((event: Record<string, unknown>) => Promise<unknown>)[]>();
	tools = new Map<string, RegisteredTool>();
	commands = new Map<string, RegisteredCommand>();
	sentMessages: Record<string, unknown>[] = [];
	sentOptions: (Record<string, unknown> | undefined)[] = [];
	notifications: string[] = [];

	on(event: string, handler: (event: Record<string, unknown>) => Promise<unknown>): void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
	}

	registerTool(tool: RegisteredTool): void {
		this.tools.set(tool.name, tool);
	}

	registerCommand(name: string, command: RegisteredCommand): void {
		this.commands.set(name, command);
	}

	sendMessage(message: Record<string, unknown>, options?: Record<string, unknown>): void {
		this.sentMessages.push(message);
		this.sentOptions.push(options);
	}

	sendUserMessage(): void {}

	async runCommand(name: string, args = ""): Promise<void> {
		const command = this.commands.get(name);
		if (!command) throw new Error(`command not registered: ${name}`);
		await command.handler(args, { ui: { notify: (text: string) => this.notifications.push(text) } });
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
	stores.hindsight.close();
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

describe("skill attribution", () => {
	function skillRead(id: string, skill: string): ToolCallRow {
		return {
			toolCallId: id,
			sessionId: "s1",
			turnIndex: 0,
			tool: "read",
			argKey: `${skill}/SKILL.md`,
			argDetail: `/skills/${skill}/SKILL.md`,
			cwd: "",
			startedAt: 1_700_000_000_000,
			durationMs: 3,
			isError: false,
			errorClass: undefined,
			retryOf: undefined,
			exitCode: undefined,
		};
	}

	test("renderSkillUsage separates loaded skills from never-loaded ones", () => {
		const report = renderSkillUsage(
			[
				{ name: "battletest", writtenAt: 1_700_000_000_000 },
				{ name: "idle-one", writtenAt: 1_700_000_000_000 },
			],
			[{ skill: "battletest", loads: 4, lastAt: 1_700_000_000_000 }],
		);
		expect(report).toContain("2 skills · 1 ever loaded · 1 never loaded");
		expect(report).toContain("battletest — 4 loads");
		expect(report).toContain("idle-one — written");
		expect(report).toContain("Never loaded does not mean useless");
	});

	test("renderSkillUsage says so when there are no skills at all", () => {
		expect(renderSkillUsage([], [])).toBe("No skills have been recorded yet.");
	});

	test("/skills pairs authored skills against measured loads", async () => {
		await smolt.runTool("skill_manage", {
			action: "create",
			name: "used-skill",
			content:
				"---\nname: used-skill\ndescription: A skill that gets loaded\n---\n\n" +
				"## When to Use\nAlways\n\n## Procedure\nDo it\n\n## Pitfalls\nNone\n\n## Verification\nCheck\n",
		});
		await smolt.runTool("skill_manage", {
			action: "create",
			name: "idle-skill",
			content:
				"---\nname: idle-skill\ndescription: A skill nothing ever loads\n---\n\n" +
				"## When to Use\nNever\n\n## Procedure\nDo it\n\n## Pitfalls\nNone\n\n## Verification\nCheck\n",
		});
		await stores.hindsight.flush([skillRead("call-a", "used-skill")]);

		await smolt.runCommand("skills");
		const report = String(smolt.sentMessages.at(-1)?.content ?? "");
		expect(report).toContain("2 skills · 1 ever loaded · 1 never loaded");
		expect(report).toContain("used-skill — 1 loads");
		expect(report).toContain("idle-skill — written");
	});
});

// ---------------------------------------------------------------------------
// Semantic recall wiring
// ---------------------------------------------------------------------------

class ConstantEmbedder implements Embedder {
	readonly modelId = "fake-v1";
	readonly dim = 3;
	async embed(texts: string[]): Promise<Float32Array[]> {
		return texts.map(() => new Float32Array([1, 0, 0]));
	}
}

function semanticIn(root: string): SemanticRecall {
	return {
		config: { ...DEFAULT_EMBEDDING_CONFIG, engine: "server", model: "fake-v1", minScore: 0.25 },
		embedder: new ConstantEmbedder(),
		vectors: new VectorStore(join(root, "state.db")),
	};
}

function lastReport(fake: FakeSmolt): string {
	const message = fake.sentMessages.at(-1) as { content?: unknown } | undefined;
	return typeof message?.content === "string" ? message.content : "";
}

describe("semantic recall wiring", () => {
	test("stays lexical, and says so, when nothing was handed over", async () => {
		expect(stores.sessions.semanticEnabled).toBe(false);
		expect(stores.vectors).toBeUndefined();
		expect(smolt.tools.get("session_search")?.description).not.toContain("SEMANTIC RECALL");
		await smolt.runCommand("embeddings");
		expect(lastReport(smolt)).toContain("off");
		expect(lastReport(smolt)).toContain("semantic-recall");
	});

	test("reports are for the reader, never steered into a running turn", async () => {
		await smolt.runCommand("embeddings");
		await smolt.runCommand("skills");
		expect(smolt.sentOptions).toHaveLength(2);
		for (const options of smolt.sentOptions) expect(options).toEqual({ triggerTurn: false });
	});

	test("wires a handed-over embedder into search and reports it", async () => {
		const other = new FakeSmolt();
		const semantic = semanticIn(dir);
		const wired = createLearningExtension(
			other as unknown as ExtensionAPI,
			{
				memoriesDir: join(dir, "memories"),
				skillsRoot: join(dir, "skills"),
				sessionsRoot: join(dir, "sessions"),
				stateDbPath: join(dir, "state.db"),
			},
			{ semantic },
		);
		try {
			expect(wired.sessions.semanticEnabled).toBe(true);
			expect(wired.vectors).toBe(semantic.vectors);
			expect(other.tools.get("session_search")?.description).toContain("SEMANTIC RECALL");
			await other.runCommand("embeddings");
			expect(lastReport(other)).toContain("on");
			expect(lastReport(other)).toContain("fake-v1");
			expect(lastReport(other)).toContain("not yet started");
			await other.fire("session_start");
			await other.fire("session_shutdown");
			await other.runCommand("embeddings");
			expect(lastReport(other)).toContain("Last index run");
		} finally {
			wired.sessions.close();
			wired.hindsight.close();
			// The report after shutdown reopened the store to count rows.
			semantic.vectors.close();
		}
	});

	test("takes the extension's handoff when no option is given, once", () => {
		const other = new FakeSmolt();
		const semantic = semanticIn(dir);
		provideSemanticRecall(semantic);
		const wired = createLearningExtension(other as unknown as ExtensionAPI, {
			memoriesDir: join(dir, "memories"),
			skillsRoot: join(dir, "skills"),
			sessionsRoot: join(dir, "sessions"),
			stateDbPath: join(dir, "state.db"),
		});
		try {
			expect(wired.sessions.semanticEnabled).toBe(true);
			expect(takeSemanticRecall()).toBeUndefined();
		} finally {
			wired.sessions.close();
			wired.hindsight.close();
			semantic.vectors.close();
		}
	});
});
