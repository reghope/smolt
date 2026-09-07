/**
 * The footer's live tokens-per-second figure.
 *
 * Providers disagree about when they report what they have written: most
 * count output tokens once, at the end of a request. A rate waiting for that
 * would read zero for the whole of every response. So the figure is measured
 * from what actually streams in — text, reasoning and tool arguments, at the
 * usual four characters a token — and the provider's own count takes over
 * whenever it is the larger number.
 */

const CHARS_PER_TOKEN = 4;

/** How much of the recent past one reading covers. */
const WINDOW_MS = 5000;

interface Sample {
	at: number;
	tokens: number;
}

/**
 * Turns a running token total into a rate over the last few seconds. A window
 * rather than the whole turn, so a burst after a long tool call reads as the
 * burst it is; a few seconds rather than one, so a stuttering stream does not
 * flicker between 0 and 900.
 */
export class ThroughputMeter {
	private samples: Sample[] = [];

	reset(): void {
		this.samples = [];
	}

	/**
	 * Record the total so far and return the current rate in tokens per
	 * second, or undefined until two samples at least a second apart exist.
	 */
	sample(at: number, tokens: number): number | undefined {
		// A total that went down is a new request: start over, or the drop
		// would print as a negative rate.
		const last = this.samples.at(-1);
		if (last && tokens < last.tokens) this.samples = [];
		this.samples.push({ at, tokens });
		while (this.samples.length > 1 && at - this.samples[0]!.at > WINDOW_MS) this.samples.shift();
		const first = this.samples[0]!;
		const seconds = (at - first.at) / 1000;
		if (seconds < 1) return undefined;
		return Math.max(0, Math.round((tokens - first.tokens) / seconds));
	}
}

/** A rough token count for streamed text, the same estimate everywhere. */
export function estimateTokens(chars: number): number {
	return Math.round(chars / CHARS_PER_TOKEN);
}

/** "345 tps", "1.2k tps" — the footer's rate, sized like its token counts. */
export function formatRate(tps: number): string {
	return tps >= 1000 ? `${(tps / 1000).toFixed(1)}k tps` : `${tps} tps`;
}
