import type { ThinkingLevel } from "@smolt/agent-core";

/**
 * The classifier behind the auto thinking mode.
 *
 * Pure text-and-signals heuristics: no model calls, no usage. Each task's
 * prompt lands in one of three bands — clearly trivial, clearly heavy, or
 * no strong signal — and the uncertain band runs the model's lowest thinking
 * level rather than paying for a classification. A misclassification is
 * cheap in the trivial direction (a few wasted thinking tokens) and self-
 * correcting in the heavy direction (the escalation ladder bumps the level
 * when the task starts failing).
 */

/** Ordered canonical thinking levels, cheapest first. */
export const CANONICAL_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export type Confidence = "confident" | "uncertain";

export interface Classification {
	level: ThinkingLevel;
	confidence: Confidence;
	/** Why this level was picked; shown in the footer and the session record. */
	reason: string;
}

export interface ClassifyOptions {
	/** Level the previous task ran at; "do the same again" prompts inherit it. */
	previousLevel?: ThinkingLevel;
}

/** Bare conversational tokens (one or several): nothing to think about. */
const TRIVIAL =
	/^(?:(?:hi|hey|hello|yo|thanks|thank you|ty|ok|okay|kk|sure|yes|yeah|no|nope|go|go on|continue|proceed|stop|abort|cancel|nice|great|perfect|cool|done)\b[.!?,\s]*)+$/i;

/** Requests that name their own smallness. */
const QUICK = /\b(quick|simple|tiny|small|fast|brief|short|one[ -]?liner|tldr|tl;dr)\b/i;

/** Verbs and nouns that historically need real reasoning. */
const HEAVY =
	/\b(debug|debugging|diagnose|diagnosing|investigate|investigating|root[ -]?cause|architect|architecture|redesign|refactor|refactoring|migrate|migration|optimize|optimizing|performance|bottleneck|race condition|thread[ -]safe|memory leak|security|vulnerability|regression|debug why|figure out why)\b/i;

/** "Why does X fail" questions, which are diagnosis in disguise. */
const WHY = /^(why|how come)\b/i;

/** Pasted failure output. */
const STACK_TRACE = /Traceback \(most recent call last\)|^\s*at .+ \(?.+:\d+:\d+\)?/m;

/** Prompts that reference the previous task. */
const FOLLOW_UP = /\b(same|again|another one|next one|one more|likewise)\b/i;

/** A path to a source file, implying a scoped edit. */
const FILE_PATH =
	/[\w.@/-]+\.(tsx?|jsx?|py|go|rs|java|kt|swift|rb|php|c|cpp|h|hpp|cs|sql|sh|ya?ml|toml|json|md|html|css)\b/;

/** A numbered list, implying several distinct steps. */
const NUMBERED_LIST = /^\s*\d+[.)]\s+\S/m;

/** Above this length the prompt is doing the talking: plan for moderate work. */
const LONG_PROMPT_CHARS = 2000;

/** QUICK only applies to genuinely short prompts. */
const QUICK_MAX_CHARS = 120;

/** FILE_PATH only implies a small edit on short prompts. */
const SCOPED_EDIT_MAX_CHARS = 200;

export function classify(text: string, options: ClassifyOptions = {}): Classification {
	const trimmed = text.trim();

	if (options.previousLevel !== undefined && FOLLOW_UP.test(trimmed)) {
		return { level: options.previousLevel, confidence: "confident", reason: "follow-up on previous task" };
	}
	if (TRIVIAL.test(trimmed)) {
		return { level: "off", confidence: "confident", reason: "conversational" };
	}
	if (STACK_TRACE.test(text)) {
		return { level: "high", confidence: "confident", reason: "failure trace to diagnose" };
	}
	if (HEAVY.test(trimmed) || WHY.test(trimmed)) {
		return { level: "high", confidence: "confident", reason: "reasoning-heavy request" };
	}
	if (QUICK.test(trimmed) && trimmed.length <= QUICK_MAX_CHARS && !hasCodeFence(trimmed)) {
		return { level: "minimal", confidence: "confident", reason: "quick request" };
	}
	if (trimmed.length > LONG_PROMPT_CHARS) {
		return { level: "medium", confidence: "confident", reason: "long, multi-part prompt" };
	}
	if (NUMBERED_LIST.test(text)) {
		return { level: "medium", confidence: "confident", reason: "multi-step request" };
	}
	if (hasCodeFence(trimmed)) {
		return { level: "medium", confidence: "confident", reason: "code to review" };
	}
	if (FILE_PATH.test(trimmed) && trimmed.length <= SCOPED_EDIT_MAX_CHARS) {
		return { level: "low", confidence: "confident", reason: "small scoped edit" };
	}
	return { level: "minimal", confidence: "uncertain", reason: "no strong signal; starting cheap" };
}

function hasCodeFence(text: string): boolean {
	return text.includes("```");
}

/**
 * The levels escalation may use: the model's supported levels up to `cap`.
 * Above the cap the classification is trusted; escalations never reach the
 * top bands on their own.
 */
export function escalationLadder(supported: readonly ThinkingLevel[], cap: ThinkingLevel = "medium"): ThinkingLevel[] {
	const capIndex = CANONICAL_LEVELS.indexOf(cap);
	return CANONICAL_LEVELS.filter((level) => supported.includes(level) && CANONICAL_LEVELS.indexOf(level) <= capIndex);
}

/** One rung up the ladder, or undefined when `current` is outside it. */
export function nextRung(ladder: readonly ThinkingLevel[], current: ThinkingLevel): ThinkingLevel | undefined {
	const index = ladder.indexOf(current);
	if (index === -1) return undefined;
	return ladder[index + 1];
}
