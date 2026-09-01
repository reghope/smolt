import { describe, expect, test } from "vitest";
import {
	dropSamples,
	freshWords,
	isEcho,
	type SampleBuffer,
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
