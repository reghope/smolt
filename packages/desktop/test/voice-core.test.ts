import { describe, expect, test } from "vitest";
import {
	collapseRepeats,
	isRunaway,
	isStockAnswer,
	renderRun,
	SEGMENT_MAX_SECONDS,
	SEGMENT_SECONDS,
	shouldCutSegment,
} from "../src/renderer/state/voice-core.ts";

/**
 * The pure half of dictation: how a finished transcription is appended to
 * the draft, and how a bad answer from the model is recognised.
 */

describe("shouldCutSegment", () => {
	test("keeps a short segment whole, pause or no pause", () => {
		expect(shouldCutSegment(5, 0)).toBe(false);
		expect(shouldCutSegment(5, 3)).toBe(false);
		expect(shouldCutSegment(SEGMENT_SECONDS - 1, 3)).toBe(false);
	});

	test("cuts a grown segment at a pause in speech", () => {
		expect(shouldCutSegment(SEGMENT_SECONDS, 0.5)).toBe(true);
		// Mid-sentence it waits, however long the segment has grown.
		expect(shouldCutSegment(SEGMENT_SECONDS + 20, 0)).toBe(false);
		expect(shouldCutSegment(SEGMENT_SECONDS + 20, 0.1)).toBe(false);
	});

	test("cuts unbroken speech at the ceiling, so nothing grows without bound", () => {
		expect(shouldCutSegment(SEGMENT_MAX_SECONDS, 0)).toBe(true);
		// An hour of it is just more segments: every one is cut at the ceiling.
		expect(shouldCutSegment(3600, 0)).toBe(true);
	});
});

describe("isStockAnswer", () => {
	test("catches what the model says when handed a fan or a keyboard", () => {
		// The exact output that filled a composer nobody was talking to.
		expect(isStockAnswer("You", [])).toBe(true);
		expect(isStockAnswer("Okay.", [])).toBe(true);
		expect(isStockAnswer("Thank you.", [])).toBe(true);
		expect(isStockAnswer("Thanks for watching!", [])).toBe(true);
	});

	test("treats an empty transcription as one of them", () => {
		expect(isStockAnswer("", [])).toBe(true);
		expect(isStockAnswer("  ", [])).toBe(true);
	});

	test("lets anything with real content through", () => {
		expect(isStockAnswer("okay so refactor the middleware", [])).toBe(false);
		expect(isStockAnswer("you should check the token", [])).toBe(false);
	});

	test("never second-guesses a sitting that produced more than one answer", () => {
		// Mid-text these are ordinary words, and someone answering a question
		// with "okay" has to be heard.
		expect(isStockAnswer("okay", ["and", "then"])).toBe(false);
		expect(isStockAnswer("you", ["thank"])).toBe(false);
	});
});

describe("renderRun", () => {
	test("writes the run at the end of an empty draft", () => {
		expect(renderRun("", "", "The quick")).toEqual({ draft: "The quick", rendered: "The quick", reclaimed: true });
	});

	test("gives the opening word a capital, which the model does not", () => {
		// Whisper reads the first clip of a sitting as mid-thought and answers
		// in lowercase; a message starts with a capital.
		expect(renderRun("", "", "refactor the middleware").draft).toBe("Refactor the middleware");
	});

	test("keeps the capital stable as the run is redrawn", () => {
		const first = renderRun("", "", "refactor the");
		const second = renderRun(first.draft, first.rendered, "refactor the middleware");
		expect(second.draft).toBe("Refactor the middleware");
		expect(second.reclaimed).toBe(true);
	});

	test("leaves the rest of the words as the model said them", () => {
		expect(renderRun("", "", "refactor the JWT check").draft).toBe("Refactor the JWT check");
	});

	test("raises the first letter, not the first character", () => {
		expect(renderRun("", "", '"refactor it"').draft).toBe('"Refactor it"');
	});

	test("never capitalises a run that continues what is already there", () => {
		expect(renderRun("see also:", "", "the quick").draft).toBe("see also: the quick");
	});

	test("replaces the previous run rather than repeating it", () => {
		const first = renderRun("", "", "hello ther");
		expect(renderRun(first.draft, first.rendered, "hello there friend")).toEqual({
			draft: "Hello there friend",
			rendered: "Hello there friend",
			reclaimed: true,
		});
	});

	test("keeps what the user typed before dictation started", () => {
		expect(renderRun("see also:", "", "the quick").draft).toBe("see also: the quick");
	});

	test("refuses to reclaim once the user has typed past the run", () => {
		// The draft no longer ends with what was written, so those words are
		// the user's; the caller starts a new run instead of eating them.
		const out = renderRun("hello ther — never mind", "hello ther", "hello there");
		expect(out.reclaimed).toBe(false);
	});

	test("survives the draft being sent mid-dictation", () => {
		const out = renderRun("", "the quick", "the quick brown");
		expect(out.reclaimed).toBe(false);
	});

	test("empties cleanly when the run is taken back", () => {
		expect(renderRun("the quick brown", "brown", "")).toEqual({
			draft: "the quick",
			rendered: "",
			reclaimed: true,
		});
	});
});

describe("runaway repeats", () => {
	test("folds a word said three or more times to one, and leaves a double alone", () => {
		expect(collapseRepeats("the the the the cat")).toBe("the cat");
		expect(collapseRepeats("no, no, never")).toBe("no, no, never");
		expect(collapseRepeats("send send send send send")).toBe("send");
	});

	test("folds a repeated phrase as a phrase", () => {
		expect(collapseRepeats("and then and then and then we left")).toBe("and then we left");
		expect(collapseRepeats("I think so. I think so. I think so.")).toBe("I think so.");
	});

	test("recognises a transcription that is mostly one word as the loop it is", () => {
		expect(isRunaway("yes yes yes yes yes yes yes")).toBe(true);
		expect(isRunaway("okay okay okay okay okay and then we")).toBe(true);
		expect(isRunaway("please open the file and read it")).toBe(false);
		expect(isRunaway("yes yes")).toBe(false);
	});
});
