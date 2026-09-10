import type { AgentMessage } from "@smolt/agent-core";
import type { ImageContent, TextContent } from "@smolt/ai";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { applyOutputBudget, DEFAULT_OUTPUT_TOKEN_LIMIT } from "../tools/budget.ts";
import { toolHabitsPrompt } from "../tools/index.ts";

/**
 * What keeps a child session lean: the three places a tester's or
 * researcher's context grows without anyone deciding it should.
 *
 * 1. Every tool result is cut to a token budget as it enters history — the
 *    same boundary the tools extension puts on the parent, which children
 *    never got because they run with no extensions loaded.
 * 2. Old tool results are shed before each model call. A child's durable
 *    memory is its diary and its filings, not its transcript: a page read
 *    twenty actions ago, or a screenshot from the last screen but six, is
 *    re-sent on every turn for nothing. The recent results stay whole; the
 *    rest collapse to a short stub that says what was there.
 * 3. The calls behind shed results are trimmed with them: the prose a child
 *    writes into a notebook or ticket call is history too, and it never
 *    left on its own.
 * 4. Earlier turns' thinking is dropped. Providers that take reasoning back
 *    in history (opencode-go's GLM, DeepSeek, llama.cpp) get every past
 *    turn's thinking re-sent as input, and a researcher at medium thinking
 *    writes hundreds of tokens of it a turn. Only the newest assistant
 *    message keeps its thinking: that is the one a tool loop needs.
 * 5. The habits that make a model read less — search with rg, read ranges,
 *    parallel calls — ride on the system prompt.
 *
 * Shedding is done in batches on purpose: a result stays whole until a
 * whole batch behind the recent window is ready to go, then the batch is
 * stubbed together. Prefix caching keys on the prompt being byte-identical
 * up to the change, so stubbing one result per turn would break the cache
 * at the window's edge every turn; stubbing eight at a time breaks it once
 * every eight turns.
 */

export interface LeanChildOptions {
	/** Token budget for every tool result. Default 10,000. */
	outputTokenLimit?: number;
	/** Tool results kept whole, counted from the newest. Default 6. */
	keepRecentToolResults?: number;
	/** Older results are stubbed in batches of this size. Default 8. */
	shedBatchSize?: number;
	/** Characters of an old text result kept in its stub. Default 240. */
	stubChars?: number;
	/**
	 * Characters kept of each string argument of a shed tool call. Default
	 * 200. The call that produced a shed result is trimmed with it: a diary
	 * entry or a finding's evidence is prose the child wrote into a tool
	 * call, and it rode along on every turn afterwards — a researcher's
	 * notebook filings came to more context than the results being shed.
	 * The filing is on disk; the call keeps its head, enough to remember
	 * what was filed.
	 */
	argChars?: number;
}

export const DEFAULT_KEEP_RECENT_TOOL_RESULTS = 6;
export const DEFAULT_SHED_BATCH_SIZE = 8;
export const DEFAULT_STUB_CHARS = 240;
export const DEFAULT_ARG_CHARS = 200;

type Block = TextContent | ImageContent;

interface ToolResultLike {
	role: "toolResult";
	toolName: string;
	toolCallId?: string;
	content: Block[];
}

interface ToolCallLike {
	type: "toolCall";
	id: string;
	arguments: Record<string, unknown>;
}

interface AssistantLike {
	role: "assistant";
	content: unknown[];
}

function isToolResult(message: AgentMessage): message is AgentMessage & ToolResultLike {
	const candidate = message as { role?: unknown; content?: unknown };
	return candidate.role === "toolResult" && Array.isArray(candidate.content);
}

function isAssistant(message: AgentMessage): message is AgentMessage & AssistantLike {
	const candidate = message as { role?: unknown; content?: unknown };
	return candidate.role === "assistant" && Array.isArray(candidate.content);
}

const ARG_TRIM_MARK = /…\(\d+ more chars trimmed\)$/;

/**
 * A shed tool call's arguments with every long string cut to its head.
 * Returns the same object when nothing was long enough to trim, so an
 * already-trimmed call stays byte-identical for the prompt cache.
 */
export function trimToolCallArguments(args: Record<string, unknown>, argChars: number): Record<string, unknown> {
	let changed = false;
	const trimmed: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args)) {
		if (typeof value === "string" && value.length > argChars && !ARG_TRIM_MARK.test(value)) {
			trimmed[key] = `${value.slice(0, argChars)}…(${value.length - argChars} more chars trimmed)`;
			changed = true;
		} else {
			trimmed[key] = value;
		}
	}
	return changed ? trimmed : args;
}

const STUB_MARK = "[earlier output trimmed";

function isStubbed(content: Block[]): boolean {
	return content.length === 1 && content[0]?.type === "text" && content[0].text.startsWith(STUB_MARK);
}

/** One old result, collapsed: its first line or so, and a note of what was dropped. */
export function stubToolResult(content: Block[], stubChars: number): Block[] {
	let text = "";
	let chars = 0;
	let images = 0;
	for (const block of content) {
		if (block.type === "image") {
			images++;
			continue;
		}
		chars += block.text.length;
		if (text === "") text = block.text;
	}
	const head = text.replace(/\s+/g, " ").trim().slice(0, stubChars);
	const dropped: string[] = [];
	if (chars > head.length) dropped.push(`${chars - head.length} chars`);
	if (images > 0) dropped.push(`${images} screenshot${images === 1 ? "" : "s"}`);
	const note =
		dropped.length === 0 ? "" : ` — ${dropped.join(" and ")} no longer shown; what mattered is in your diary`;
	return [{ type: "text", text: `${STUB_MARK}${note}]${head === "" ? "" : `\n${head}`}` }];
}

/**
 * Shed old tool results from the messages about to be sent. Returns the
 * same array when nothing changes, so a caller can skip a no-op.
 */
export function shedOldToolResults(messages: AgentMessage[], options: LeanChildOptions = {}): AgentMessage[] {
	const keep = Math.max(0, options.keepRecentToolResults ?? DEFAULT_KEEP_RECENT_TOOL_RESULTS);
	const batch = Math.max(1, options.shedBatchSize ?? DEFAULT_SHED_BATCH_SIZE);
	const stubChars = Math.max(0, options.stubChars ?? DEFAULT_STUB_CHARS);
	const argChars = Math.max(0, options.argChars ?? DEFAULT_ARG_CHARS);
	const indices: number[] = [];
	for (const [index, message] of messages.entries()) {
		if (isToolResult(message)) indices.push(index);
	}
	const candidates = indices.slice(0, Math.max(0, indices.length - keep));
	const shed = Math.floor(candidates.length / batch) * batch;
	if (shed === 0) return messages;
	let changed = false;
	const next = [...messages];
	const shedCalls = new Set<string>();
	for (const index of candidates.slice(0, shed)) {
		const message = next[index] as AgentMessage & ToolResultLike;
		if (message.toolCallId) shedCalls.add(message.toolCallId);
		if (isStubbed(message.content)) continue;
		next[index] = { ...message, content: stubToolResult(message.content, stubChars) } as AgentMessage;
		changed = true;
	}
	// The calls behind the shed results go with them — same batch, so the
	// cached prefix breaks once, not once per call.
	const last = candidates[shed - 1] ?? 0;
	for (let index = 0; index < last; index++) {
		const message = next[index] as AgentMessage;
		if (!isAssistant(message)) continue;
		let touched = false;
		const content = message.content.map((block) => {
			const call = block as Partial<ToolCallLike>;
			if (call.type !== "toolCall" || !call.id || !shedCalls.has(call.id) || !call.arguments) return block;
			const args = trimToolCallArguments(call.arguments, argChars);
			if (args === call.arguments) return block;
			touched = true;
			return { ...(block as object), arguments: args };
		});
		if (!touched) continue;
		next[index] = { ...message, content } as AgentMessage;
		changed = true;
	}
	return changed ? next : messages;
}

/**
 * Drop thinking blocks from every assistant message but the newest. Returns
 * the same array when nothing changes. The newest keeps its thinking because
 * a provider continuing a tool loop may require it (Anthropic does); earlier
 * turns' thinking is never required and, where it is replayed at all, is
 * paid for on every later turn.
 */
export function shedOldThinking(messages: AgentMessage[]): AgentMessage[] {
	let newest = -1;
	for (let index = messages.length - 1; index >= 0; index--) {
		if (isAssistant(messages[index] as AgentMessage)) {
			newest = index;
			break;
		}
	}
	let changed = false;
	const next = [...messages];
	for (let index = 0; index < newest; index++) {
		const message = next[index] as AgentMessage;
		if (!isAssistant(message)) continue;
		if (!message.content.some((block) => (block as { type?: string }).type === "thinking")) continue;
		const content = message.content.filter((block) => (block as { type?: string }).type !== "thinking");
		// A message that was only thinking keeps an empty text block rather
		// than vanishing: providers reject an assistant turn with no content.
		next[index] = {
			...message,
			content: content.length > 0 ? content : [{ type: "text", text: "" }],
		} as AgentMessage;
		changed = true;
	}
	return changed ? next : messages;
}

/** The inline extension a child session runs with, so it stays lean without loading any others. */
export function createLeanChildExtension(options: LeanChildOptions = {}) {
	const outputTokenLimit = Math.max(500, options.outputTokenLimit ?? DEFAULT_OUTPUT_TOKEN_LIMIT);
	return {
		name: "lean-child",
		hidden: true,
		factory: (smolt: ExtensionAPI): void => {
			smolt.on("tool_result", async (event) => {
				if (event.isError) return;
				const content = applyOutputBudget(event.content, outputTokenLimit);
				return content ? { content } : undefined;
			});
			smolt.on("context", async (event) => {
				const messages = shedOldThinking(shedOldToolResults(event.messages, options));
				return messages === event.messages ? undefined : { messages };
			});
			smolt.on("before_agent_start", async (event) => ({
				systemPrompt: `${event.systemPrompt}\n\n${toolHabitsPrompt({ read: "tool", outputTokenLimit })}\n- Older tool results are trimmed from your context as you go, so record what matters when you see it — in your diary where you keep one, in your reply otherwise — rather than planning to re-read it.`,
			}));
		},
	};
}
