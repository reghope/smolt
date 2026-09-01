/**
 * The pure half of dictation: which words a pass contributes, and how a
 * segment's audio is let go once it has become text.
 *
 * Kept free of the audio graph and the app state so it can be tested
 * without a microphone.
 */

/**
 * Words held back from the end of each pass.
 *
 * The last word or two of a clip are the ones still being spoken, and the
 * ones the next pass is most likely to change. Holding them back until
 * more audio has arrived is what keeps the committed text from churning.
 */
export const UNSETTLED_TAIL = 2;

/**
 * Take from a pass only what it adds beyond the words already committed.
 *
 * On a final pass everything counts, including the tail — the sentence is
 * over, so nothing more is coming to change it. Returns the fresh words;
 * the caller appends them to both its record and the composer.
 */
export function freshWords(settled: readonly string[], text: string, final: boolean): string[] {
	const words = text.split(/\s+/).filter((word) => word !== "");
	const usable = final ? words.length : Math.max(0, words.length - UNSETTLED_TAIL);
	if (usable <= settled.length) return [];
	return words.slice(settled.length, usable);
}

/** A word stripped to its sound, for spotting the model stuttering. */
function bareWord(word: string): string {
	return word.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
}

/**
 * Whether a pass's fresh words are just the last settled word again.
 *
 * Whisper handed trailing quiet does not stay quiet: it echoes the last
 * word it heard, once per pass, forever. A pass whose entire contribution
 * is the previous word repeated is that echo and is refused; a genuinely
 * repeated word still lands when its segment is committed whole, since
 * final passes never consult this.
 */
export function isEcho(settled: readonly string[], fresh: readonly string[]): boolean {
	if (fresh.length === 0 || settled.length === 0) return false;
	const last = bareWord(settled[settled.length - 1]);
	if (last === "") return false;
	return fresh.every((word) => bareWord(word) === last);
}

/** The audio a segment still holds, in capture order. */
export interface SampleBuffer {
	samples: Float32Array[];
	total: number;
}

/**
 * Drop the first `count` samples: the audio a finished pass has already
 * turned into text. What survives is whatever arrived while that pass was
 * in flight, so the next segment starts exactly where the last one ended
 * rather than losing or re-hearing anything.
 */
export function dropSamples(buffer: SampleBuffer, count: number): void {
	let remaining = Math.min(count, buffer.total);
	buffer.total -= remaining;
	while (remaining > 0 && buffer.samples.length > 0) {
		const first = buffer.samples[0];
		if (first.length <= remaining) {
			remaining -= first.length;
			buffer.samples.shift();
		} else {
			buffer.samples[0] = first.subarray(remaining);
			remaining = 0;
		}
	}
}
