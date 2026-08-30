import { describe, expect, test } from "vitest";
import { attachToolResult, type ChatMessage, fromAgentMessage } from "../src/renderer/store.ts";

describe("image content", () => {
	test("user messages keep their attached images as blocks", () => {
		const mapped = fromAgentMessage({
			role: "user",
			content: [
				{ type: "text", text: "what is this?" },
				{ type: "image", data: "aGk=", mimeType: "image/png" },
			],
		});
		expect(mapped?.blocks).toEqual([
			{ kind: "text", text: "what is this?" },
			{ kind: "image", data: "aGk=", mimeType: "image/png" },
		]);
	});

	test("assistant image content becomes an image block", () => {
		const mapped = fromAgentMessage({
			role: "assistant",
			content: [{ type: "image", data: "aGk=", mimeType: "image/jpeg" }],
		});
		expect(mapped?.blocks).toEqual([{ kind: "image", data: "aGk=", mimeType: "image/jpeg" }]);
	});

	test("tool results carry their images onto the tool block", () => {
		const messages: ChatMessage[] = [
			{
				role: "assistant",
				blocks: [{ kind: "tool", id: "t1", name: "read", args: "{}", output: "", isError: false, running: true }],
			},
		];
		attachToolResult(messages, {
			role: "toolResult",
			toolCallId: "t1",
			content: [
				{ type: "text", text: "a screenshot" },
				{ type: "image", data: "aGk=", mimeType: "image/png" },
			],
		});
		const block = messages[0]!.blocks[0]!;
		expect(block.kind).toBe("tool");
		if (block.kind === "tool") {
			expect(block.output).toBe("a screenshot");
			expect(block.images).toEqual([{ data: "aGk=", mimeType: "image/png" }]);
		}
	});
});
