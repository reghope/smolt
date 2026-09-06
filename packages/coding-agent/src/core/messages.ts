/**
 * Custom message types and transformers for the coding agent.
 *
 * Extends the base AgentMessage type with coding-agent specific message types,
 * and provides a transformer to convert them to LLM-compatible messages.
 */

import type { AgentMessage } from "@smolt/agent-core";
import type { ImageContent, Message, TextContent } from "@smolt/ai";

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;

export const BRANCH_SUMMARY_SUFFIX = `</summary>`;

/**
 * Message type for bash executions via the ! command.
 */
export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	timestamp: number;
	/** If true, this message is excluded from LLM context (!! prefix) */
	excludeFromContext?: boolean;
}

/**
 * Message type for extension-injected messages via sendMessage().
 * These are custom messages that extensions can inject into the conversation.
 */
export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	timestamp: number;
}

export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string;
	timestamp: number;
}

export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	timestamp: number;
}

// Extend CustomAgentMessages via declaration merging
declare module "@smolt/agent-core" {
	interface CustomAgentMessages {
		bashExecution: BashExecutionMessage;
		custom: CustomMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
	}
}

/**
 * Convert a BashExecutionMessage to user message text for LLM context.
 */
export function bashExecutionToText(msg: BashExecutionMessage): string {
	let text = `Ran \`${msg.command}\`\n`;
	if (msg.output) {
		text += `\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(command cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\nCommand exited with code ${msg.exitCode}`;
	}
	if (msg.truncated && msg.fullOutputPath) {
		text += `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`;
	}
	return text;
}

export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary,
		fromId,
		timestamp: new Date(timestamp).getTime(),
	};
}

export function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	timestamp: string,
): CompactionSummaryMessage {
	return {
		role: "compactionSummary",
		summary: summary,
		tokensBefore,
		timestamp: new Date(timestamp).getTime(),
	};
}

/** Convert CustomMessageEntry to AgentMessage format */
export function createCustomMessage(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: unknown | undefined,
	timestamp: string,
): CustomMessage {
	return {
		role: "custom",
		customType,
		content,
		display,
		details,
		timestamp: new Date(timestamp).getTime(),
	};
}

/**
 * Transform AgentMessages (including custom types) to LLM-compatible Messages.
 *
 * This is used by:
 * - Agent's transormToLlm option (for prompt calls and queued messages)
 * - Compaction's generateSummary (for summarization)
 * - Custom extensions and tools
 *
 * Every one of those builds a request, which is why the image cap lives
 * here rather than in the agent loop: a summarisation call carries the same
 * history, and hits the same provider ceiling, as the turn that prompted it.
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	const converted = messages
		.map((m): Message | undefined => {
			switch (m.role) {
				case "bashExecution":
					// Skip messages excluded from context (!! prefix)
					if (m.excludeFromContext) {
						return undefined;
					}
					return {
						role: "user",
						content: [{ type: "text", text: bashExecutionToText(m) }],
						timestamp: m.timestamp,
					};
				case "custom": {
					const content = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
					return {
						role: "user",
						content,
						timestamp: m.timestamp,
					};
				}
				case "branchSummary":
					return {
						role: "user",
						content: [{ type: "text" as const, text: BRANCH_SUMMARY_PREFIX + m.summary + BRANCH_SUMMARY_SUFFIX }],
						timestamp: m.timestamp,
					};
				case "compactionSummary":
					return {
						role: "user",
						content: [
							{ type: "text" as const, text: COMPACTION_SUMMARY_PREFIX + m.summary + COMPACTION_SUMMARY_SUFFIX },
						],
						timestamp: m.timestamp,
					};
				case "user":
				case "assistant":
				case "toolResult":
					return m;
				default:
					// biome-ignore lint/correctness/noSwitchDeclarations: fine
					const _exhaustiveCheck: never = m;
					return undefined;
			}
		})
		.filter((m) => m !== undefined);

	return capImages(converted);
}

/**
 * How many images a single request may carry.
 *
 * Providers put a ceiling on this and answer past it with a flat refusal —
 * one of them stops at thirty — so a session that reads screenshots walks
 * into a wall it cannot see: every turn from there on dies with a 400
 * before the model reads a token, and no amount of rephrasing helps because
 * the pictures are in the history, not the message. Ten sits well under
 * every cap we know of and still holds a before-and-after series, so the
 * model keeps the pictures the work is actually about.
 */
export const MAX_IMAGES_PER_REQUEST = 10;

const OMITTED_IMAGE_TEXT = "[Older image omitted: only the most recent images are sent with each request.]";

/**
 * How many images these messages carry, wherever they sit in them.
 *
 * Images arrive as parts of a user message or of a tool result, so the
 * count is never obvious from the number of messages — which is the whole
 * problem: a chat can be carrying thirty screenshots into every request
 * with nothing on screen to say so.
 */
export function countImages(messages: readonly { role: string; content?: unknown }[]): number {
	let total = 0;
	for (const message of messages) {
		if (message.role !== "user" && message.role !== "toolResult") continue;
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (typeof part === "object" && part !== null && (part as { type?: unknown }).type === "image") total++;
		}
	}
	return total;
}

/**
 * Keep the newest images and leave a note where the rest were.
 *
 * Newest wins because that is what a turn is about: the screenshot just
 * taken is the one being discussed, the one from three hours ago is
 * scenery. A placeholder stands in for each image dropped so the history
 * still reads as though something was looked at, rather than a tool result
 * appearing to have come back empty.
 */
export function capImages(messages: Message[], limit = MAX_IMAGES_PER_REQUEST): Message[] {
	const total = countImages(messages);
	// The common case: nothing to do, and nothing copied to do it with.
	if (total <= limit) return messages;

	// Everything but the last `limit` images goes, oldest first — which is
	// why this counts down through a forward pass rather than walking back.
	let remaining = total - limit;
	return messages.map((message) => {
		if (remaining === 0) return message;
		if (message.role !== "user" && message.role !== "toolResult") return message;
		if (!Array.isArray(message.content)) return message;
		if (!message.content.some((part) => part.type === "image")) return message;
		const content = message.content.map((part) => {
			if (part.type !== "image" || remaining === 0) return part;
			remaining--;
			return { type: "text" as const, text: OMITTED_IMAGE_TEXT };
		});
		return { ...message, content };
	});
}
