import { describe, expect, test } from "vitest";
import { firstSentence, thinkingSummary, toolStage } from "../src/extensions/telegram/stage.ts";

/**
 * Unit tests for the Telegram status-line distillers: the reasoning condenser
 * (kept in step with the desktop renderer's thinking.ts), the acknowledgment
 * sentence, and tool stages.
 */

describe("thinkingSummary", () => {
	test("returns the last complete sentence with self-talk stripped", () => {
		expect(thinkingSummary("The user wants an alarm. I need to create the alarm now. And then I wi")).toBe(
			"create the alarm now",
		);
	});

	test("ignores a stream with no complete sentence yet", () => {
		expect(thinkingSummary("Let me think about how to")).toBe("");
	});

	test("maps overly long sentences to a stable stage", () => {
		const long = `I should carefully read and inspect every file in the existing code base to understand how the current behavior works before touching anything. `;
		expect(thinkingSummary(long)).toBe("reviewing the relevant code and current behavior");
	});

	test("drops code fences", () => {
		expect(thinkingSummary("```js\nconst x = 1;\n```\nRun the tests next.")).toBe("run the tests next");
	});
});

describe("firstSentence", () => {
	test("takes the first complete sentence, markdown stripped", () => {
		expect(firstSentence("**I'll set up an alarm at 6pm.** Then I'll confirm it works.")).toBe(
			"I'll set up an alarm at 6pm.",
		);
	});

	test("waits until a terminator exists", () => {
		expect(firstSentence("I'll set up an alarm at")).toBe("");
	});
});

describe("toolStage", () => {
	test("maps known tools to human stages", () => {
		expect(toolStage("bash")).toBe("running a command");
		expect(toolStage("edit")).toBe("editing files");
		expect(toolStage("frobnicate")).toBe("using frobnicate");
	});
});
