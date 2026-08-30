import { beforeEach, describe, expect, test } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { createGoalExtension, GOAL_ENTRY, turnCost, usedTools } from "../src/extensions/goal/index.ts";

/**
 * Wiring tests for the goal extension: the loop that keeps a session working,
 * and the four things that stop it — a met objective, a spent budget, a turn
 * that did nothing, and the user.
 */

interface RegisteredTool {
	name: string;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: unknown,
		onUpdate?: unknown,
		ctx?: unknown,
	): Promise<{ content: { type: string; text: string }[] }>;
}

interface RegisteredCommand {
	handler: (args: string, ctx: unknown) => Promise<void>;
}

/** A tool call and its result, in the shape agent_end reports them. */
const TOOL_RUN = [
	{ role: "assistant", content: [{ type: "toolCall", name: "read" }], usage: { input: 100, output: 20 } },
	{ role: "toolResult", content: [] },
];
/** A turn that only talked. */
const TALK_ONLY = [
	{ role: "assistant", content: [{ type: "text", text: "done I think" }], usage: { input: 50, output: 10 } },
];

class FakeSmolt {
	handlers = new Map<string, ((event: Record<string, unknown>, ctx?: unknown) => Promise<unknown>)[]>();
	tools = new Map<string, RegisteredTool>();
	commands = new Map<string, RegisteredCommand>();
	sent: string[] = [];
	entries: { type: "custom"; customType: string; data?: unknown }[] = [];

	on(event: string, handler: (event: Record<string, unknown>, ctx?: unknown) => Promise<unknown>): void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
	}

	registerTool(tool: RegisteredTool): void {
		this.tools.set(tool.name, tool);
	}

	registerCommand(name: string, options: RegisteredCommand): void {
		this.commands.set(name, options);
	}

	sendUserMessage(content: string): void {
		this.sent.push(content);
	}

	appendEntry(customType: string, data?: unknown): void {
		this.entries.push({ type: "custom", customType, data });
	}

	async fire(event: string, payload: Record<string, unknown> = {}): Promise<unknown> {
		let result: unknown;
		for (const handler of this.handlers.get(event) ?? [])
			result = await handler({ type: event, ...payload }, this.ctx());
		return result;
	}

	notices: string[] = [];
	pending = false;
	contextPercent = 0;

	ctx(): unknown {
		return {
			mode: "tui",
			isIdle: () => true,
			hasPendingMessages: () => this.pending,
			getContextUsage: () => ({ percent: this.contextPercent }),
			compact: () => undefined,
			sessionManager: { getSessionId: () => "s1", getEntries: () => this.entries },
			ui: {
				notify: (message: string) => this.notices.push(message),
				setStatus: () => undefined,
				setWidget: () => undefined,
			},
		};
	}

	async runTool(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const tool = this.tools.get("goal");
		if (!tool) throw new Error("goal tool not registered");
		const result = await tool.execute("call-1", params, undefined, undefined, this.ctx());
		return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
	}

	async runCommand(args: string): Promise<void> {
		await this.commands.get("goal")!.handler(args, this.ctx());
	}
}

let smolt: FakeSmolt;
let handle: ReturnType<typeof createGoalExtension>;

beforeEach(async () => {
	smolt = new FakeSmolt();
	handle = createGoalExtension(smolt as unknown as ExtensionAPI);
	await smolt.fire("session_start");
});

/** One full turn: prompt, run, settle. */
async function turn(messages: unknown[] = TOOL_RUN): Promise<void> {
	await smolt.fire("before_agent_start", { systemPrompt: "BASE" });
	await smolt.fire("agent_end", { messages });
	await smolt.fire("agent_settled");
}

describe("accounting", () => {
	test("a turn costs its uncached input plus its output", () => {
		expect(turnCost([{ role: "assistant", usage: { input: 900, cacheRead: 700, output: 40 } }])).toBe(240);
	});

	test("tool results and user messages cost nothing", () => {
		expect(turnCost([{ role: "toolResult" }, { role: "user" }])).toBe(0);
	});

	test("a turn counts as work when it called a tool", () => {
		expect(usedTools(TOOL_RUN)).toBe(true);
		expect(usedTools(TALK_ONLY)).toBe(false);
	});
});

describe("the continuation loop", () => {
	test("no goal means no continuation", async () => {
		await turn();
		expect(smolt.sent).toHaveLength(0);
	});

	test("setting a goal starts work and keeps it going", async () => {
		await smolt.runCommand("Ship the parser");
		expect(smolt.sent).toHaveLength(1);
		expect(smolt.sent[0]).toContain("Ship the parser");
		await turn();
		expect(smolt.sent).toHaveLength(2);
		expect(smolt.sent[1]).toContain("Continue working toward the active goal");
	});

	test("the objective rides in the system prompt while active", async () => {
		await smolt.runCommand("Ship the parser");
		const result = (await smolt.fire("before_agent_start", { systemPrompt: "BASE" })) as { systemPrompt: string };
		expect(result.systemPrompt.startsWith("BASE")).toBe(true);
		expect(result.systemPrompt).toContain("Ship the parser");
	});

	test("a queued user message wins over the continuation", async () => {
		await smolt.runCommand("Ship the parser");
		smolt.sent = [];
		smolt.pending = true;
		await turn();
		expect(smolt.sent).toHaveLength(0);
	});

	test("completing the goal ends the loop", async () => {
		await smolt.runCommand("Ship the parser");
		smolt.sent = [];
		await smolt.runTool({ action: "update", status: "complete" });
		await turn();
		expect(smolt.sent).toHaveLength(0);
		expect(handle.current()?.status).toBe("complete");
	});
});

describe("the spin guard", () => {
	test("a continuation that called no tool suppresses the next one", async () => {
		await smolt.runCommand("Ship the parser");
		smolt.sent = [];
		// The continuation only talked, so the loop stops rather than asking
		// the same question again and getting the same answer.
		await turn(TALK_ONLY);
		expect(smolt.sent).toHaveLength(0);
	});

	test("a turn the user asked for clears the guard", async () => {
		await smolt.runCommand("Ship the parser");
		smolt.sent = [];
		await turn(TALK_ONLY);
		expect(smolt.sent).toHaveLength(0);
		// A turn the user started is their answer to the stall; the loop is
		// allowed one more go, and stalls again if that one also does nothing.
		await turn(TALK_ONLY);
		expect(smolt.sent).toHaveLength(1);
	});

	test("a continuation that did work keeps going", async () => {
		await smolt.runCommand("Ship the parser");
		smolt.sent = [];
		await turn(TOOL_RUN);
		expect(smolt.sent).toHaveLength(1);
	});
});

describe("budget", () => {
	test("a spent budget gets one closing turn, then silence", async () => {
		await smolt.runTool({ action: "create", objective: "Ship the parser", token_budget: 100 });
		smolt.sent = [];
		// The first continuation spends the lot.
		await turn([{ role: "assistant", content: [{ type: "toolCall" }], usage: { input: 200, output: 50 } }]);
		expect(handle.current()?.status).toBe("budget_limited");
		expect(smolt.sent).toHaveLength(1);
		expect(smolt.sent[0]).toContain("reached its token budget");
		// The closing turn itself does not start another.
		await turn(TOOL_RUN);
		expect(smolt.sent).toHaveLength(1);
	});

	test("the user can raise the ceiling and carry on", async () => {
		await smolt.runTool({ action: "create", objective: "Ship the parser", token_budget: 100 });
		await turn([{ role: "assistant", content: [{ type: "toolCall" }], usage: { input: 200, output: 50 } }]);
		smolt.sent = [];
		await smolt.runCommand("budget 100000");
		expect(handle.current()?.status).toBe("active");
		await turn();
		expect(smolt.sent).toHaveLength(1);
	});
});

describe("the user's own controls", () => {
	test("pause stops the loop and resume restarts it", async () => {
		await smolt.runCommand("Ship the parser");
		await smolt.runCommand("pause");
		smolt.sent = [];
		await turn();
		expect(smolt.sent).toHaveLength(0);
		await smolt.runCommand("resume");
		expect(smolt.sent).toHaveLength(1);
	});

	test("clear drops the goal", async () => {
		await smolt.runCommand("Ship the parser");
		await smolt.runCommand("clear");
		expect(handle.current()).toBeNull();
		smolt.sent = [];
		await turn();
		expect(smolt.sent).toHaveLength(0);
	});

	test("status reports without a goal", async () => {
		await smolt.runCommand("");
		expect(smolt.notices[0]).toContain("No goal");
	});
});

describe("persistence", () => {
	test("the goal comes back from the session entries", async () => {
		await smolt.runCommand("Ship the parser");
		await turn();
		expect(smolt.entries.some((entry) => entry.customType === GOAL_ENTRY)).toBe(true);
		// A reload replays session_start against the same entries.
		const reloaded = createGoalExtension(smolt as unknown as ExtensionAPI);
		await smolt.fire("session_start");
		expect(reloaded.current()?.objective).toBe("Ship the parser");
	});
});

describe("what the model may not do", () => {
	test("it cannot start a second goal over a live one", async () => {
		await smolt.runCommand("Ship the parser");
		const result = await smolt.runTool({ action: "create", objective: "Something easier" });
		expect(result.success).toBe(false);
		expect(handle.current()?.objective).toBe("Ship the parser");
	});

	test("it cannot declare a goal blocked on the first wall", async () => {
		await smolt.runCommand("Ship the parser");
		const result = await smolt.runTool({ action: "update", status: "blocked" });
		expect(result.success).toBe(false);
		expect(handle.current()?.status).toBe("active");
	});
});
