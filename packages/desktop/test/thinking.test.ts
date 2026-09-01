import { describe, expect, test } from "vitest";
import { briefSummary, thinkingSummary } from "../src/renderer/thinking.ts";

/**
 * The reasoning→status-line condenser, ported from the imagined web agent
 * along with its test suite. It sees half-written clauses, quoted code and
 * markdown mid-token, and must never produce something that reads as
 * gibberish in the UI — a bad phrase is worse than the static "Thinking"
 * it replaces.
 */
describe("thinkingSummary", () => {
	test("uses the last complete sentence, not the half-written tail", () => {
		const out = thinkingSummary("We are asked to build a form. The user wants validation. Now I should check");
		expect(out).toBe("The user wants validation");
	});

	test("does not expose the partial buffer before its first terminator", () => {
		expect(thinkingSummary("We are working out the layout")).toBe("");
	});

	test("a fully-terminated buffer uses its last sentence", () => {
		expect(thinkingSummary("First thought. Second thought.")).toBe("Second thought");
	});

	test("summarises a long sentence instead of clipping it", () => {
		const out = thinkingSummary(
			"I need to carefully consider every single one of the many possible implementation approaches before deciding which option best fits the existing architecture.",
		);
		expect(out).toBe("Choosing the next implementation approach");
		expect(out.endsWith("…")).toBe(false);
		expect(out.endsWith("...")).toBe(false);
	});

	test("removes reasoning self-talk from a stage", () => {
		expect(thinkingSummary("Now I should check the existing component before changing it.")).toBe(
			"Check the existing component before changing it",
		);
	});

	test("fenced code is stripped", () => {
		expect(thinkingSummary("Looking at the file. ```ts\nconst x = 1\n```")).not.toContain("const");
	});

	test("inline backticks are stripped", () => {
		expect(thinkingSummary("The `useEffect` hook is wrong")).not.toContain("`");
	});

	test("markdown emphasis is stripped", () => {
		expect(thinkingSummary("**Bold** thinking here now")).not.toContain("*");
	});

	test("an unclosed code fence is stripped", () => {
		expect(thinkingSummary("Checking it. ```ts\nconst y =")).not.toContain("const");
	});

	test("presentation: capitalised, no trailing punctuation, whitespace collapsed", () => {
		expect(thinkingSummary("checking the imports.").startsWith("C")).toBe(true);
		expect(thinkingSummary("Now I check the file.").endsWith(".")).toBe(false);
		expect(thinkingSummary("a\n\n  b   c.")).toBe("A b c");
	});

	test("degenerate input yields '' so the UI keeps its static label", () => {
		expect(thinkingSummary("")).toBe("");
		expect(thinkingSummary("   \n  ")).toBe("");
		expect(thinkingSummary("```\nconst a = 1\n```")).toBe("");
		expect(thinkingSummary("***")).toBe("");
	});

	test("every prefix of a realistic token stream yields a sane phrase", () => {
		const full =
			"We need to add a contact form. The user wants name, email and message fields. " +
			"I should check whether `src/App.tsx` already imports anything relevant. " +
			"Then I will write the component.";
		let buffer = "";
		for (const token of full.split(/(\s+)/)) {
			buffer += token;
			const summary = thinkingSummary(buffer);
			// Partial sentences stay hidden; completed summaries never leak
			// markdown or collapse to punctuation.
			expect(summary).not.toContain("`");
			expect(/^[^A-Za-z0-9]+$/.test(summary || "x")).toBe(false);
		}
	});
});

describe("briefSummary", () => {
	test("takes the opening sentence of a brief", () => {
		expect(briefSummary("Review code changes for real defects. No target was given.\n\nHOW TO REVIEW\n1. ...")).toBe(
			"Review code changes for real defects.",
		);
	});

	test("skips leading blank lines", () => {
		expect(briefSummary("\n\n  Chart a wayfinder map. Then stop.")).toBe("Chart a wayfinder map.");
	});

	test("falls back to the first line when it has no sentence end", () => {
		expect(briefSummary("Synthesize run '20260901-1532'\nnext line")).toBe("Synthesize run '20260901-1532'");
	});

	test("truncates a very long unpunctuated opening", () => {
		const summary = briefSummary("x".repeat(300));
		expect(summary).toHaveLength(120);
		expect(summary.endsWith("...")).toBe(true);
	});

	test("an empty brief summarises to nothing", () => {
		expect(briefSummary("")).toBe("");
	});
});
