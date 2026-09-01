/**
 * Degeneration detection: recognizes a model whose stream has collapsed into
 * a repetition loop (the same sentence or fragment emitted over and over).
 *
 * Small models in long agentic contexts can enter a self-reinforcing
 * attractor — once a sentence repeats a couple of times, the repetition
 * itself becomes the strongest pattern in context and generation never
 * escapes. Detection is purely mechanical and deliberately conservative:
 * legitimate output (code fixtures, tables, lists) repeats too, so a trip
 * requires many consecutive identical units of real prose-like content.
 *
 * Pure functions + a small stateful watcher; no I/O. Wired into
 * AgentSession, which aborts the request and retries it once on a trip.
 */

/** Minimum characters a repeated unit needs before it can count. */
const MIN_UNIT_LENGTH = 12;
/** How much tail to examine for newline-free periodic loops. */
const PERIODIC_TAIL_WINDOW = 2400;
/** Longest period considered for the periodic-tail check. */
const MAX_PERIOD = 300;
/** Ignore accumulations shorter than this — loops need room to show. */
const MIN_TEXT_LENGTH = 600;
/** Re-check cadence: only after this much new text since the last check. */
const CHECK_GROWTH = 400;

const HAS_LETTER = /\p{L}/u;

function normalizeLine(line: string): string {
	return line.trim().replace(/\s+/g, " ");
}

function isCountableUnit(unit: string): boolean {
	return unit.length >= MIN_UNIT_LENGTH && HAS_LETTER.test(unit);
}

function clip(unit: string): string {
	return unit.length > 60 ? `${unit.slice(0, 57)}...` : unit;
}

/**
 * Trip when the same normalized non-empty line closes the text `minRepeats`
 * times in a row (blank lines between repeats are ignored — degenerate
 * output often loops whole markdown paragraphs).
 */
function detectRepeatedLines(text: string, minRepeats: number): string | undefined {
	const lines = text.split("\n");
	let last: string | undefined;
	let run = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = normalizeLine(lines[i]!);
		if (line === "") continue;
		if (last === undefined) {
			last = line;
			run = 1;
			continue;
		}
		if (line !== last) break;
		run += 1;
		if (run >= minRepeats) break;
	}
	if (last !== undefined && run >= minRepeats && isCountableUnit(last)) {
		return `the line "${clip(last)}" repeated ${run}+ times`;
	}
	return undefined;
}

/**
 * Trip when the tail of the text is at least `minRepeats` exact repetitions
 * of one unit — catches loops that never emit a newline. Smallest period
 * wins, so a doubled unit reports its true length.
 */
function detectPeriodicTail(text: string, minRepeats: number): string | undefined {
	const tail = text.slice(-PERIODIC_TAIL_WINDOW);
	const maxPeriod = Math.min(MAX_PERIOD, Math.floor(tail.length / minRepeats));
	for (let period = MIN_UNIT_LENGTH; period <= maxPeriod; period++) {
		const unit = tail.slice(-period);
		if (!isCountableUnit(unit.trim())) continue;
		let repeats = 1;
		while (repeats < minRepeats && tail.slice(-(repeats + 1) * period, -repeats * period) === unit) {
			repeats += 1;
		}
		if (repeats >= minRepeats) {
			return `the fragment "${clip(unit.trim())}" repeated ${repeats}+ times`;
		}
	}
	return undefined;
}

/**
 * Inspect accumulated stream text for a repetition collapse.
 * Returns a human-readable reason, or undefined when the text looks sane.
 */
export function detectDegeneration(text: string, minRepeats: number): string | undefined {
	if (text.length < MIN_TEXT_LENGTH) return undefined;
	return detectRepeatedLines(text, minRepeats) ?? detectPeriodicTail(text, minRepeats);
}

/**
 * Incremental wrapper for the streaming path: throttles re-checks to every
 * CHECK_GROWTH new characters and remembers a trip so the session asks once.
 */
export class DegenerationWatcher {
	private readonly minRepeats: number;
	private lastCheckedLength = 0;

	constructor(minRepeats: number) {
		this.minRepeats = minRepeats;
	}

	/** Call at the start of each assistant message. */
	reset(): void {
		this.lastCheckedLength = 0;
	}

	/** Feed the full accumulated text; returns a reason on the check that trips. */
	check(accumulated: string): string | undefined {
		if (accumulated.length < MIN_TEXT_LENGTH) return undefined;
		if (accumulated.length - this.lastCheckedLength < CHECK_GROWTH) return undefined;
		this.lastCheckedLength = accumulated.length;
		return detectDegeneration(accumulated, this.minRepeats);
	}
}
