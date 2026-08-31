import { describe, expect, test } from "vitest";
import { fromAgentMessage, initialState, reduce, type ToolBlock } from "../src/renderer/store.ts";

function feed(events: unknown[]) {
	const state = initialState();
	for (const event of events) reduce(state, event);
	return state;
}

describe("streaming text assembly", () => {
	test("assembles text deltas into one assistant message", () => {
		const state = feed([
			{ type: "agent_start" },
			{ type: "message_start", message: { role: "assistant", content: [] } },
			{ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello " } },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "world" } },
		]);
		expect(state.streaming).toBe(true);
		expect(state.messages).toHaveLength(1);
		expect(state.messages[0]!.blocks[0]).toMatchObject({ kind: "text", text: "Hello world" });
	});

	test("text_end content is authoritative for the block", () => {
		const state = feed([
			{ type: "message_start", message: { role: "assistant", content: [] } },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "partial" } },
			{
				type: "message_update",
				assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "final text" },
			},
		]);
		expect(state.messages[0]!.blocks[0]).toMatchObject({ kind: "text", text: "final text" });
	});

	test("user message_start is captured with its text", () => {
		const state = feed([
			{ type: "message_start", message: { role: "user", content: [{ type: "text", text: "hi there" }] } },
		]);
		expect(state.messages[0]).toMatchObject({ role: "user" });
		expect(state.messages[0]!.blocks[0]).toMatchObject({ kind: "text", text: "hi there" });
	});

	test("thinking deltas build a thinking block separate from text", () => {
		const state = feed([
			{ type: "message_start", message: { role: "assistant", content: [] } },
			{ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
			{ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hmm" } },
			{ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 1 } },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "answer" } },
		]);
		expect(state.messages[0]!.blocks[0]).toMatchObject({ kind: "thinking", text: "hmm" });
		expect(state.messages[0]!.blocks[1]).toMatchObject({ kind: "text", text: "answer" });
	});
});

describe("tool call lifecycle", () => {
	const toolEvents = [
		{ type: "agent_start" },
		{ type: "message_start", message: { role: "assistant", content: [] } },
		{
			type: "message_update",
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "call_1", toolName: "bash" },
		},
		{
			type: "message_update",
			assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '{"command":"ls"' },
		},
		{ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "}" } },
		{
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: { id: "call_1", name: "bash", arguments: { command: "ls" } },
			},
		},
	];

	test("assembles the tool call and marks it running", () => {
		const state = feed(toolEvents);
		const block = state.messages[0]!.blocks[0] as ToolBlock;
		expect(block).toMatchObject({ kind: "tool", id: "call_1", name: "bash", running: true });
		expect(JSON.parse(block.args)).toEqual({ command: "ls" });
	});

	test("tool_execution_end attaches output and clears running", () => {
		const state = feed([
			...toolEvents,
			{
				type: "tool_execution_end",
				toolCallId: "call_1",
				result: { content: [{ type: "text", text: "file-a\nfile-b" }], isError: false },
			},
		]);
		const block = state.messages[0]!.blocks[0] as ToolBlock;
		expect(block.running).toBe(false);
		expect(block.isError).toBe(false);
		expect(block.output).toBe("file-a\nfile-b");
	});

	test("message_end preserves attached tool output", () => {
		const state = feed([
			...toolEvents,
			{
				type: "tool_execution_end",
				toolCallId: "call_1",
				result: { content: [{ type: "text", text: "output kept" }], isError: false },
			},
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "Done." },
						{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
					],
				},
			},
		]);
		const tool = state.messages[0]!.blocks.find((b): b is ToolBlock => b.kind === "tool")!;
		expect(tool.output).toBe("output kept");
		expect(state.messages[0]!.blocks[0]).toMatchObject({ kind: "text", text: "Done." });
	});

	test("errored tools are flagged", () => {
		const state = feed([
			...toolEvents,
			{
				type: "tool_execution_end",
				toolCallId: "call_1",
				result: { content: [{ type: "text", text: "boom" }], isError: true },
			},
		]);
		expect((state.messages[0]!.blocks[0] as ToolBlock).isError).toBe(true);
	});
});

describe("run lifecycle", () => {
	test("agent_settled ends streaming", () => {
		const state = feed([
			{ type: "agent_start" },
			{ type: "message_start", message: { role: "assistant", content: [] } },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" } },
			{ type: "agent_settled" },
		]);
		expect(state.streaming).toBe(false);
		expect(state.messages[0]!.streaming).toBe(false);
	});

	test("usage from message_update is tracked", () => {
		const state = feed([
			{
				type: "message_update",
				usage: { input: 1200, output: 40, cost: { total: 0.01 } },
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" },
			},
		]);
		expect(state.usage).toEqual({ input: 1200, output: 40, cost: 0.01 });
	});

	test("compaction leaves a system message in the transcript", () => {
		const state = feed([{ type: "compaction_start" }, { type: "compaction_end" }]);
		expect(state.messages.at(-1)).toMatchObject({ role: "system" });
	});

	test("unknown events are ignored safely", () => {
		const state = feed([{ type: "totally_unknown" }, null, "garbage", 42]);
		expect(state.messages).toHaveLength(0);
	});
});

describe("fromAgentMessage", () => {
	test("maps assistant content blocks, skipping empties", () => {
		const mapped = fromAgentMessage({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "let me think" },
				{ type: "text", text: "  " },
				{ type: "text", text: "visible" },
				{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
			],
		})!;
		expect(mapped.blocks.map((b) => b.kind)).toEqual(["thinking", "text", "tool"]);
	});

	test("returns null for tool-result roles", () => {
		expect(fromAgentMessage({ role: "toolResult", content: [] })).toBeNull();
	});
});

describe("a turn that settles mid-flight", () => {
	test("closes every assistant message, not only the last", () => {
		// A turn can emit several assistant messages. When only the last was
		// closed, each earlier one kept a live footer for the rest of the
		// session, pulsing under a turn that had long since finished.
		const state = feed([
			{ type: "agent_start" },
			{ type: "message_start", message: { role: "assistant", content: [] } },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "one" } },
			{ type: "message_start", message: { role: "assistant", content: [] } },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "two" } },
			{ type: "agent_settled" },
		]);
		expect(state.messages).toHaveLength(2);
		for (const message of state.messages) expect(message.streaming).toBe(false);
	});

	test("stops a tool that was still running when the turn ended", () => {
		// Aborting mid-tool used to leave the call spinning for ever.
		const state = feed([
			{ type: "agent_start" },
			{ type: "message_start", message: { role: "assistant", content: [] } },
			{
				type: "message_update",
				assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "t1", toolName: "bash" },
			},
			{ type: "tool_execution_start", toolCallId: "t1" },
			{ type: "agent_settled" },
		]);
		const block = state.messages[0]!.blocks[0]!;
		expect(block).toMatchObject({ kind: "tool", running: false });
		expect(block.kind === "tool" && block.output).toContain("Interrupted");
	});

	test("records the turn's duration and cost on its closing message", () => {
		const state = feed([
			{ type: "agent_start" },
			{ type: "message_start", message: { role: "assistant", content: [] } },
			{
				type: "message_update",
				usage: { input: 900, output: 100, cost: { total: 0.02 } },
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "done" },
			},
			{ type: "agent_settled" },
		]);
		const last = state.messages.at(-1)!;
		expect(last.tokens).toBe(1000);
		expect(typeof last.tookMs).toBe("number");
	});

	test("only the closing message carries the cost, so a turn shows one footer", () => {
		const state = feed([
			{ type: "agent_start" },
			{ type: "message_start", message: { role: "assistant", content: [] } },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "a" } },
			{ type: "message_start", message: { role: "assistant", content: [] } },
			{
				type: "message_update",
				usage: { input: 10, output: 5, cost: { total: 0 } },
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "b" },
			},
			{ type: "agent_settled" },
		]);
		expect(state.messages[0]!.tokens).toBeUndefined();
		expect(state.messages[1]!.tokens).toBe(15);
	});
});

describe("turn usage accounting", () => {
	test("usage accumulates across a turn's requests instead of showing only the newest", () => {
		const state = feed([
			{ type: "agent_start" },
			// Request 1: streams a snapshot, then finishes with final usage.
			{ type: "message_start", message: { role: "assistant", content: [] } },
			{
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "a" },
				usage: { input: 100, output: 10, cost: { total: 0.01 } },
			},
			{
				type: "message_end",
				message: { role: "assistant", content: [], usage: { input: 100, output: 12, cost: { total: 0.012 } } },
			},
			// Request 2: its snapshot stacks on top of request 1's banked total.
			{ type: "message_start", message: { role: "assistant", content: [] } },
			{
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "b" },
				usage: { input: 150, output: 5, cost: { total: 0.02 } },
			},
		]);
		expect(state.usage).toMatchObject({ input: 250, output: 17 });
		expect(state.usage?.cost).toBeCloseTo(0.032);
	});

	test("a new turn counts from zero", () => {
		const state = feed([
			{ type: "agent_start" },
			{ type: "message_start", message: { role: "assistant", content: [] } },
			{
				type: "message_end",
				message: { role: "assistant", content: [], usage: { input: 500, output: 50, cost: { total: 0.1 } } },
			},
			{ type: "agent_settled" },
			{ type: "agent_start" },
		]);
		expect(state.usage).toBeNull();
		expect(state.turnBase).toMatchObject({ input: 0, output: 0, cost: 0 });
	});
});
