/**
 * Condenses a reasoning stream into one short, complete stage summary.
 *
 * Ported from the imagined web agent, which settled this treatment: reasoning
 * models emit hundreds of token-level deltas before any visible output, which
 * is why a long turn shows a static "Thinking" and nothing else. Rather than
 * render that prose into the transcript (it's verbose, half-written while it
 * streams, and can echo the system prompt), the working line shows only the
 * condensed phrase, and the transcript keeps none of it.
 *
 * Only complete sentences are eligible. Showing the buffer before its first
 * terminator was the source of chopped "thoughts" in the UI: every tick
 * exposed a different half-written clause. Long sentences are mapped to a
 * stable high-level stage instead of being cut after an arbitrary word.
 */
export function thinkingSummary(reasoning: string): string {
	if (!reasoning) return "";
	// Drop fenced code and inline backticks: reasoning often quotes source, and
	// a fragment of a code block makes a poor status line.
	const prose = reasoning
		.replace(/```[\s\S]*?(```|$)/g, " ")
		.replace(/`[^`]*`/g, " ")
		.replace(/[*_#>]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!prose) return "";
	// Sentence-ish boundaries. The tail is deliberately ignored until it has a
	// terminator, so token streaming can never expose a half-written message.
	const sentences = prose.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim());
	const complete = /[.!?]\s*$/.test(prose) ? sentences : sentences.slice(0, -1);
	const pick = complete[complete.length - 1]?.trim().replace(/[.,;:!?]+$/, "") ?? "";
	if (!pick) return "";

	// Short reasoning sentences already make useful stage summaries. Remove the
	// common self-talk preamble so they read like product status, not a transcript.
	const phrase = pick
		.replace(/^(?:now|next|then),?\s+/i, "")
		.replace(/^(?:i|we)\s+(?:(?:need|want|have)\s+to|(?:should|will|can))\s+/i, "")
		.replace(/^let['’]s\s+/i, "")
		.trim();
	if (!phrase) return "";
	if (phrase.split(/\s+/).length > 18) {
		const lower = phrase.toLowerCase();
		if (/\b(error|bug|issue|cause|failure|broken)\b/.test(lower)) return "Tracing the cause of the issue";
		if (/\b(test|verify|validate|check)\b/.test(lower)) return "Planning how to verify the change";
		if (/\b(plan|approach|decide|choose|consider|option)\b/.test(lower))
			return "Choosing the next implementation approach";
		if (/\b(read|inspect|review|file|code|existing)\b/.test(lower))
			return "Reviewing the relevant code and current behavior";
		if (/\b(fix|change|update|implement|write|add|remove|build)\b/.test(lower))
			return "Preparing the next code change";
		return "Working through the next implementation step";
	}
	return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

/** The selector entry the auto-thinking extension registers, as it arrives over RPC. */
export const AUTO_THINKING_ENTRY = "auto";

/**
 * Display name for a thinking level or selector entry.
 *
 * Real levels are single lowercase words the UI title-cases itself. The auto
 * entry arrives as the bare value "auto", which reads as a mode rather than a
 * point on the effort axis, so it gets its full name — and its own casing,
 * since `capitalize` would render it "Auto Thinking".
 */
export function thinkingLabel(level: string): string {
	return level === AUTO_THINKING_ENTRY ? "Auto thinking" : level;
}
