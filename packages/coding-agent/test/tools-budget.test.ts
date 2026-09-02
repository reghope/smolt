import { describe, expect, test } from "vitest";
import { applyOutputBudget, approxTokens, truncateMiddleByTokens } from "../src/extensions/tools/budget.ts";

/**
 * The budget: four bytes a token, half the budget from the head,
 * half from the tail, and a marker that names what was dropped.
 */

describe("output budget", () => {
	test("text within budget is returned as is", () => {
		const text = "a".repeat(400);
		expect(truncateMiddleByTokens(text, 100)).toEqual({ text, removedTokens: 0 });
		expect(approxTokens(text)).toBe(100);
	});

	test("over budget keeps head and tail and names the removed tokens", () => {
		const text = `${"h".repeat(1000)}${"m".repeat(2000)}${"t".repeat(1000)}`;
		const cut = truncateMiddleByTokens(text, 500); // 2000 bytes: 1000 head, 1000 tail
		expect(cut.removedTokens).toBe(500);
		expect(cut.text.startsWith("h".repeat(1000))).toBe(true);
		expect(cut.text.endsWith("t".repeat(1000))).toBe(true);
		expect(cut.text).toContain("…500 tokens truncated…");
		expect(cut.text).not.toContain("m");
	});

	test("a cut never splits a multi-byte character", () => {
		const text = "é".repeat(3000); // 6000 bytes
		const cut = truncateMiddleByTokens(text, 100); // 400 bytes: cut lands mid-character unless stepped
		expect(cut.text).not.toContain("\uFFFD");
		expect(cut.text).toMatch(/^é+\n…\d+ tokens truncated…\né+$/);
	});

	test("applyOutputBudget leaves images and short text alone", () => {
		const content = [
			{ type: "text" as const, text: "short" },
			{ type: "image" as const, data: "x", mimeType: "image/png" },
		];
		expect(applyOutputBudget(content, 10)).toBeUndefined();
		const long = [{ type: "text" as const, text: "x".repeat(1000) }];
		const cut = applyOutputBudget(long, 10);
		expect(cut).toBeDefined();
		expect((cut?.[0] as { text: string }).text).toContain("tokens truncated");
	});
});
