/**
 * Distills live progress for the Telegram status line.
 *
 * `thinkingSummary` is kept in step with the desktop renderer's
 * `packages/desktop/src/renderer/thinking.ts`: reasoning models emit hundreds
 * of token deltas before any visible output, so the status line shows only a
 * condensed, COMPLETE sentence from the stream — never a half-written clause —
 * and maps overly long sentences to a stable high-level stage.
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
		.replace(/^let['']s\s+/i, "")
		.trim();
	if (!phrase) return "";
	if (phrase.split(/\s+/).length > 18) {
		const lower = phrase.toLowerCase();
		if (/\b(error|bug|issue|cause|failure|broken)\b/.test(lower)) return "tracing the cause of the issue";
		if (/\b(test|verify|validate|check)\b/.test(lower)) return "planning how to verify the change";
		if (/\b(plan|approach|decide|choose|consider|option)\b/.test(lower))
			return "choosing the next implementation approach";
		if (/\b(read|inspect|review|file|code|existing)\b/.test(lower))
			return "reviewing the relevant code and current behavior";
		if (/\b(fix|change|update|implement|write|add|remove|build)\b/.test(lower)) return "preparing the next change";
		return "working through the next step";
	}
	return phrase.charAt(0).toLowerCase() + phrase.slice(1);
}

/** The first complete sentence of the streamed reply, for the acknowledgment line. */
export function firstSentence(text: string): string {
	const clean = text
		.replace(/```[\s\S]*?(```|$)/g, " ")
		.replace(/[*_#>`]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	const match = /^.*?[.!?](?=\s|$)/.exec(clean);
	if (!match) return "";
	const pick = match[0].trim();
	return pick.length > 140 ? `${pick.slice(0, 137)}…` : pick;
}

/** Coarse stage for a tool call, used between completed thoughts. */
export function toolStage(toolName: string): string {
	switch (toolName) {
		case "bash":
		case "powershell":
			return "running a command";
		case "edit":
		case "write":
			return "editing files";
		case "read":
			return "reading files";
		case "grep":
		case "find":
		case "ls":
			return "searching the project";
		case "telegram":
			return "messaging you";
		case "wayfinder":
			return "updating the map";
		default:
			return `using ${toolName}`;
	}
}
