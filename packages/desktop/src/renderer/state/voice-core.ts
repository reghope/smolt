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

/**
 * The words a pass heard but has not settled: everything past the tail cut.
 *
 * `freshWords` holds these back because a later pass may rephrase them.
 * Holding them back from the *screen* too is what made dictation feel a
 * second and a half behind the voice, so they are returned separately and
 * shown as provisional text: the words appear the moment they are decoded
 * and are replaced wholesale by the next pass, while the settled text
 * behind them never moves.
 *
 * A final pass has no tail — the sentence is over, so every word settles.
 * Words the caller has already settled are never handed back, so a pass
 * that hears fewer words than the last cannot un-say them.
 */
export function tailWords(settled: readonly string[], text: string, final: boolean): string[] {
	if (final) return [];
	const words = text.split(/\s+/).filter((word) => word !== "");
	const unsettled = Math.max(0, words.length - UNSETTLED_TAIL);
	return words.slice(Math.max(unsettled, settled.length));
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

/**
 * What a pass changes about the run of words already on screen or waiting.
 *
 * Whisper re-reads the whole segment each pass, so most passes simply carry
 * the run further; the interesting cases are the ones that revise it.
 */
export type RunPlan =
	/** The pass only carried the run further: add these to the back of the queue. */
	| { kind: "append"; words: string[] }
	/** It revised words not yet shown: swap the queue, the screen is untouched. */
	| { kind: "requeue"; words: string[] }
	/** It revised words already shown: the run has to be redrawn as a whole. */
	| { kind: "rewrite"; words: string[] };

/** Whether `words` opens with exactly `prefix`. */
function opensWith(words: readonly string[], prefix: readonly string[]): boolean {
	if (prefix.length > words.length) return false;
	return prefix.every((word, index) => words[index] === word);
}

/**
 * Work out how a pass's words meet the ones already shown and queued.
 *
 * Words are revealed one at a time rather than in the clump a pass returns,
 * which means at any moment some of what the model has heard is still
 * waiting its turn. A pass that agrees with everything so far just adds to
 * the back of that queue. One that changes its mind about a word still
 * waiting costs nothing — it is swapped before anyone sees it. Only a pass
 * that contradicts what is already on screen forces a redraw, which is why
 * the three cases are kept apart.
 */
export function planRun(shown: readonly string[], queued: readonly string[], target: readonly string[]): RunPlan {
	const known = [...shown, ...queued];
	if (opensWith(target, known)) return { kind: "append", words: target.slice(known.length) };
	if (opensWith(target, shown)) return { kind: "requeue", words: target.slice(shown.length) };
	return { kind: "rewrite", words: [...target] };
}

/**
 * Put the dictated run at the end of the draft, replacing the last one.
 *
 * The draft is otherwise appended to, never rebuilt: dictation holds no copy
 * of the text it has produced, so sending or editing mid-dictation just
 * works, and the next words land in whatever the composer holds at that
 * moment. The run is the one exception, and it is reclaimed only when the
 * draft still ends with exactly what was written. If the user has typed
 * since, or sent, `reclaimed` comes back false: those words are theirs, and
 * the caller starts a new run after them rather than eating them.
 */
export function renderRun(
	draft: string,
	rendered: string,
	text: string,
): { draft: string; rendered: string; reclaimed: boolean } {
	let base = draft;
	const reclaimed = rendered === "" || base.endsWith(rendered);
	if (reclaimed && rendered !== "") base = base.slice(0, base.length - rendered.length);
	base = base.replace(/\s+$/, "");
	const next = text === "" ? base : base === "" ? text : `${base} ${text}`;
	return { draft: next, rendered: text, reclaimed };
}

/**
 * What Whisper says when it is handed something that is not speech.
 *
 * The model never answers "nothing". Given a fan, a keyboard, or a room
 * with someone breathing in it, it reaches for the commonest thing it has
 * ever heard over quiet — which is how a composer nobody was talking to
 * filled up with "You you Okay."
 *
 * These are the stock answers, kept lowercase and unpunctuated so a pass is
 * matched however the model dressed it up.
 */
const STOCK_ANSWERS_TO_QUIET = new Set([
	"",
	"you",
	"thank you",
	"thanks",
	"thank you very much",
	"thanks for watching",
	"thank you for watching",
	"okay",
	"ok",
	"bye",
	"yeah",
	"yep",
	"uh",
	"um",
	"hmm",
	"mhm",
	"so",
	"oh",
	"please subscribe",
	"subscribe",
]);

/**
 * Whether a whole pass is one of those stock answers.
 *
 * Only ever consulted for a segment that has settled nothing yet: mid
 * sentence these are ordinary words, and someone who answers a question
 * with "okay" must be heard. It is the segment that opens with one, out of
 * audio the microphone barely registered, that the model invented.
 */
export function isStockAnswer(text: string, settled: readonly string[]): boolean {
	if (settled.length > 0) return false;
	const bare = text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}' ]/gu, "")
		.replace(/\s+/g, " ")
		.trim();
	return STOCK_ANSWERS_TO_QUIET.has(bare);
}
