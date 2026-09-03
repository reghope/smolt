import { describe, expect, test } from "vitest";
import {
	dropSamples,
	freshWords,
	isEcho,
	isStockAnswer,
	planRun,
	renderRun,
	type SampleBuffer,
	tailWords,
	UNSETTLED_TAIL,
} from "../src/renderer/state/voice-core.ts";

/**
 * The pure half of dictation: word settling and segment audio bookkeeping.
 *
 * These are the rules that keep live text from churning while it is being
 * spoken, and keep every transcription pass short no matter how long the
 * microphone has been open.
 */

describe("freshWords", () => {
	test("holds back the tail still being spoken", () => {
		expect(freshWords([], "the quick brown fox", false)).toEqual(["the", "quick"]);
	});

	test("contributes only what a pass adds beyond the settled words", () => {
		expect(freshWords(["the", "quick"], "the quick brown fox jumps", false)).toEqual(["brown"]);
	});

	test("a final pass commits everything, tail included", () => {
		expect(freshWords(["the", "quick"], "the quick brown fox", true)).toEqual(["brown", "fox"]);
	});

	test("never takes words back when a pass hears less than before", () => {
		// A later pass sometimes rephrases into fewer words; the words already
		// on screen must stay put.
		expect(freshWords(["the", "quick", "brown"], "the quick", true)).toEqual([]);
	});

	test("a short clip settles nothing until it grows past the tail", () => {
		expect(freshWords([], "hello there", false)).toEqual([]);
		expect(UNSETTLED_TAIL).toBe(2);
	});

	test("ignores stray whitespace from the model", () => {
		expect(freshWords([], "  one   two three  four ", false)).toEqual(["one", "two"]);
	});
});

describe("tailWords", () => {
	test("shows the words a pass has not settled, so text keeps up with the voice", () => {
		expect(tailWords([], "the quick brown fox", false)).toEqual(["brown", "fox"]);
	});

	test("never repeats a word the caller has already settled", () => {
		// freshWords contributes "brown"; the tail picks up strictly after it.
		expect(tailWords(["the", "quick"], "the quick brown fox jumps", false)).toEqual(["fox", "jumps"]);
	});

	test("shows everything while the clip is still shorter than the tail", () => {
		// freshWords settles nothing this early, so without a tail these two
		// words would sit unseen until more audio arrived.
		expect(freshWords([], "hello there", false)).toEqual([]);
		expect(tailWords([], "hello there", false)).toEqual(["hello", "there"]);
	});

	test("a final pass has no tail, because every word settles", () => {
		expect(tailWords(["the"], "the quick brown fox", true)).toEqual([]);
	});

	test("offers nothing back when a pass hears fewer words than are settled", () => {
		expect(tailWords(["the", "quick", "brown"], "the quick", false)).toEqual([]);
	});

	test("ignores stray whitespace from the model", () => {
		expect(tailWords([], "  one   two three  four ", false)).toEqual(["three", "four"]);
	});
});

describe("isEcho", () => {
	test("catches the model repeating the last word into trailing quiet", () => {
		expect(isEcho(["one", "two", "three", "four"], ["four"])).toBe(true);
		expect(isEcho(["one", "two", "three", "four"], ["four", "four", "four"])).toBe(true);
	});

	test("sees through punctuation and case on the repeated word", () => {
		expect(isEcho(["testing", "four."], ["Four", "four!"])).toBe(true);
	});

	test("lets genuinely new words through", () => {
		expect(isEcho(["one", "two"], ["three"])).toBe(false);
		expect(isEcho(["one", "four"], ["four", "five"])).toBe(false);
	});

	test("never fires with nothing settled or nothing fresh", () => {
		expect(isEcho([], ["four"])).toBe(false);
		expect(isEcho(["four"], [])).toBe(false);
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

	test("treats an empty pass as one of them", () => {
		expect(isStockAnswer("", [])).toBe(true);
		expect(isStockAnswer("  ", [])).toBe(true);
	});

	test("lets anything with real content through", () => {
		expect(isStockAnswer("okay so refactor the middleware", [])).toBe(false);
		expect(isStockAnswer("you should check the token", [])).toBe(false);
	});

	test("never second-guesses a segment that is already under way", () => {
		// Mid sentence these are ordinary words, and someone answering a
		// question with "okay" has to be heard.
		expect(isStockAnswer("okay", ["and", "then"])).toBe(false);
		expect(isStockAnswer("you", ["thank"])).toBe(false);
	});
});

describe("planRun", () => {
	test("a pass that only carries the run further just adds to the queue", () => {
		expect(planRun(["the", "quick"], ["brown"], ["the", "quick", "brown", "fox"])).toEqual({
			kind: "append",
			words: ["fox"],
		});
	});

	test("revising a word still waiting costs nothing, because nobody saw it", () => {
		// "ther" was queued but not shown; the pass corrects it to "there".
		expect(planRun(["hello"], ["ther"], ["hello", "there", "friend"])).toEqual({
			kind: "requeue",
			words: ["there", "friend"],
		});
	});

	test("contradicting a word already on screen forces a redraw", () => {
		expect(planRun(["hello", "ther"], [], ["hello", "there"])).toEqual({
			kind: "rewrite",
			words: ["hello", "there"],
		});
	});

	test("a pass that says nothing new queues nothing", () => {
		expect(planRun(["the", "quick"], [], ["the", "quick"])).toEqual({ kind: "append", words: [] });
	});

	test("a pass that hears fewer words than are shown redraws rather than truncating silently", () => {
		expect(planRun(["the", "quick", "brown"], [], ["the", "quick"])).toEqual({
			kind: "rewrite",
			words: ["the", "quick"],
		});
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

function buffer(...lengths: number[]): SampleBuffer {
	return {
		samples: lengths.map((length, index) => new Float32Array(length).fill(index + 1)),
		total: lengths.reduce((sum, length) => sum + length, 0),
	};
}

describe("dropSamples", () => {
	test("drops whole chunks that have been transcribed", () => {
		const b = buffer(4, 4, 4);
		dropSamples(b, 8);
		expect(b.total).toBe(4);
		expect(b.samples.length).toBe(1);
		expect(b.samples[0][0]).toBe(3);
	});

	test("splits a chunk when the cut lands inside it", () => {
		const b = buffer(4, 4);
		dropSamples(b, 6);
		expect(b.total).toBe(2);
		expect(b.samples.length).toBe(1);
		expect(b.samples[0].length).toBe(2);
		expect(b.samples[0][0]).toBe(2);
	});

	test("keeps audio that arrived while the pass was in flight", () => {
		// The pass consumed 8 samples; 4 more landed meanwhile. Those 4 are the
		// start of the next segment and must survive.
		const b = buffer(4, 4);
		dropSamples(b, 8);
		b.samples.push(new Float32Array(4).fill(9));
		b.total += 4;
		expect(b.total).toBe(4);
		expect(b.samples[0][0]).toBe(9);
	});

	test("dropping more than the buffer holds empties it and no further", () => {
		const b = buffer(4);
		dropSamples(b, 100);
		expect(b.total).toBe(0);
		expect(b.samples.length).toBe(0);
	});
});
