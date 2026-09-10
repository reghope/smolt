/**
 * The pure half of dictation: how a finished transcription is appended to
 * the draft, and how a bad answer from the model is recognised.
 *
 * Kept free of the audio graph and the app state so it can be tested
 * without a microphone.
 */

/**
 * How much audio a segment holds before it is cut at the next pause.
 *
 * Long enough that cuts are rare and each decode has plenty of sentence
 * around it to work from, short enough that words appear while the user is
 * still talking and a stop has little left to wait for.
 */
export const SEGMENT_SECONDS = 30;
/**
 * The length at which a segment is cut whether or not anyone has paused.
 *
 * Someone reading aloud may not leave a gap for minutes, and a segment that
 * grew without bound would put back every limit segmenting removes. A cut
 * here can land mid-word, costing that word its edges; at this length it
 * happens only to speech with no pauses at all.
 */
export const SEGMENT_MAX_SECONDS = 75;
/** Quiet for this long, and a segment that has grown enough is closed here. */
export const CUT_AFTER_QUIET_SECONDS = 0.4;

/**
 * Whether the segment being captured should be closed off and decoded.
 *
 * This is what lets a sitting run for hours: the audio in hand is handed
 * over at every pause, so nothing accumulates — not memory, not the size of
 * a message to the decoder, not the length of a single decode.
 */
export function shouldCutSegment(seconds: number, quietSeconds: number): boolean {
	if (seconds >= SEGMENT_MAX_SECONDS) return true;
	return seconds >= SEGMENT_SECONDS && quietSeconds >= CUT_AFTER_QUIET_SECONDS;
}

/**
 * Put dictated text at the end of the draft, replacing a previous run.
 *
 * The draft is otherwise appended to, never rebuilt. The run is the one
 * exception, and it is reclaimed only when the draft still ends with exactly
 * what was written. If the user has typed since, `reclaimed` comes back
 * false: those words are theirs, and the caller starts a new run after them
 * rather than eating them.
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
	// Whisper hands back a lowercase first word when the clip it read began
	// mid-thought, which it always does at the start of a sitting. A message
	// starts with a capital, so one is given here — at the point the run is
	// drawn, so it survives every redraw rather than being applied once to a
	// word a later pass goes on to replace.
	const shown = base === "" ? capitaliseFirst(text) : text;
	const next = shown === "" ? base : base === "" ? shown : `${base} ${shown}`;
	return { draft: next, rendered: shown, reclaimed };
}

/** Raise the first letter of a run, leaving the rest of it alone. */
function capitaliseFirst(text: string): string {
	// The first character is not always a letter — a run can open on a quote
	// or a bracket — so the first one that can be raised is the one raised.
	const characters = [...text];
	const at = characters.findIndex((character) => character.toLowerCase() !== character.toUpperCase());
	if (at === -1) return text;
	characters[at] = characters[at].toUpperCase();
	return characters.join("");
}

/**
 * What Whisper says when it is handed something that is not speech.
 *
 * The model never answers "nothing". Given a fan, a keyboard, or a room
 * with someone breathing in it, it reaches for the commonest thing it has
 * ever heard over quiet — which is how a composer nobody was talking to
 * filled up with "You you Okay."
 *
 * These are the stock answers, kept lowercase and unpunctuated so an answer
 * is matched however the model dressed it up.
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
 * Whether a whole transcription is one of those stock answers.
 *
 * Mid-text these are ordinary words, and someone who answers a question
 * with "okay" must be heard. It is a whole sitting that decodes to one —
 * out of audio the microphone barely registered — that the model invented.
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

/**
 * A speech model on a bad clip can fall into a loop and answer with
 * one word, or one short phrase, over and over. Nobody dictates a word
 * three times running, so a run of three or more identical words, or of
 * the same two-to-four-word phrase, collapses to a single copy. A genuine
 * double ("no, no") is left alone.
 */
export function collapseRepeats(text: string): string {
	const words = text.split(/\s+/).filter((word) => word !== "");
	const same = (a: string, b: string): boolean =>
		a.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "") === b.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
	const out: string[] = [];
	let i = 0;
	while (i < words.length) {
		let collapsed = false;
		// Longest phrase first, so "a b a b a b" folds as a phrase rather
		// than being left as alternating singles.
		for (let size = 4; size >= 1; size -= 1) {
			if (i + size > words.length) continue;
			let repeats = 1;
			while (i + (repeats + 1) * size <= words.length) {
				let match = true;
				for (let k = 0; k < size; k += 1) {
					if (!same(words[i + k]!, words[i + repeats * size + k]!)) {
						match = false;
						break;
					}
				}
				if (!match) break;
				repeats += 1;
			}
			if (repeats >= 3) {
				out.push(...words.slice(i, i + size));
				i += repeats * size;
				collapsed = true;
				break;
			}
		}
		if (!collapsed) {
			out.push(words[i]!);
			i += 1;
		}
	}
	return out.join(" ");
}

/**
 * Whether an answer is the loop itself rather than speech with a stammer in
 * it: several words, most of them the same one. Such an answer says nothing
 * about what was said and is dropped whole.
 */
export function isRunaway(text: string): boolean {
	const words = text
		.toLowerCase()
		.split(/\s+/)
		.map((word) => word.replace(/[^\p{L}\p{N}']/gu, ""))
		.filter((word) => word !== "");
	if (words.length < 6) return false;
	const counts = new Map<string, number>();
	for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
	const top = Math.max(...counts.values());
	return top / words.length >= 0.6;
}
