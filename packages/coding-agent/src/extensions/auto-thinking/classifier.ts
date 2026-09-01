import type { ThinkingLevel } from "@smolt/agent-core";

/**
 * The classifier behind the auto thinking mode.
 *
 * Pure text-and-signals heuristics: no model calls, no usage. Each task's
 * prompt lands in a band by what kind of work it asks for:
 *
 *   - off      — conversational tokens with nothing to think about
 *   - minimal  — requests that name their own smallness, or short vague asks
 *   - low      — cosmetic edits, and substantial prompts with no other signal
 *   - medium   — substantive change requests (implement/add/update/…),
 *                design-shaped work (refactor/architecture/migration),
 *                multi-step prompts, pasted code, long prompts
 *   - high     — diagnosis: failure traces, described misbehavior, fixes
 *                paired with failure language, cause-hunting verbs
 *
 * The bias is deliberately upward: under-thinking a diagnosis costs a failed
 * task and an escalation round-trip, while over-thinking a small edit costs a
 * few thinking tokens. Misclassification in the cheap direction is also
 * self-correcting — the escalation ladder bumps the level when a task starts
 * failing.
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

/**
 * Cause-hunting: the wrong behavior exists and its origin is unknown. This
 * is the work that genuinely needs the top band — under-thinking it costs a
 * failed diagnosis.
 */
const DIAGNOSIS =
	/\b(debug|debugging|diagnose|diagnosing|investigate|investigating|root[ -]?cause|bottleneck|race condition|deadlock|thread[ -]safe|memory leak|vulnerability|regression|figure out|track down)\b/i;

/**
 * Design-shaped work: real thinking, but planning rather than detective
 * work. Medium, not high — these words also ride along in ordinary prose
 * ("the design of the page", "for performance"), and pinning every mention
 * to the top band made auto thinking read as "always maxed". Escalation
 * still bumps a genuinely hard one.
 */
const DESIGN =
	/\b(architect|architecture|design|redesign|refactor|refactoring|migrate|migration|optimize|optimizing|performance|security)\b/i;

/** "Why does X fail" questions, which are diagnosis in disguise. */
const WHY = /^(why|how come)\b/i;

/** Pasted failure output. */
const STACK_TRACE = /Traceback \(most recent call last\)|^\s*at .+ \(?.+:\d+:\d+\)?/m;

/** Fix-shaped verbs: the cause has to be found before the change is made. */
const FIX = /\b(fix|fixing|repair|resolve|resolving|sort out|unbreak)\b/i;

/** Failure nouns; only diagnostic when paired with a fix verb. */
const FAILURE_NOUN = /\b(bug|error|failure|issue|problem|crash|regression|glitch|fault)s?\b/i;

/**
 * Described misbehavior: the prompt narrates something going wrong. Diagnostic
 * on its own — a bug report without the word "fix" is still a bug report.
 */
const FAILURE_BEHAVIOR =
	/\b(crash(es|ed|ing)?|hangs?|hanging|freez(es|ing)|is broken|breaks?|broke|stopped working|(doesn'?t|does not|won'?t|isn'?t|is not)\s+\w*\s*work(ing)?|keeps? failing|fails?|failing|throws? (an? )?(error|exception)|infinite loop)\b/i;

/**
 * Expectation mismatch: "it seems to always…", "it should be… but". Paired
 * with a fix verb this is a behavior bug, not a feature request.
 */
const MISMATCH =
	/\b(seems? to|supposed to|should(n'?t| not)?\s+(be|have|use|do)|instead of|rather than|but it|expected)\b/i;

/**
 * Substantive change requests: real work, planned before the first edit.
 * Verbs that double as everyday nouns ("build", "support") are left out —
 * "the build output" and "support for X" are not change requests.
 */
const IMPLEMENT =
	/\b(implement|create|add|write|introduce|integrate|extend|convert|port|rework|revamp|improve|enhance|update|change|modify|adjust|rewrite|replace|fix)\b/i;

/** Cosmetic, mechanical targets: no reasoning in the work itself. */
const SMALL_TARGET =
	/\b(typo|spelling|rename|comment|docstring|whitespace|formatting|indent(ation)?|lint|import order|version bump|bump (the )?version|log line|todo)\b/i;

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

/** SMALL_TARGET and FILE_PATH only imply a small edit on short prompts. */
const SCOPED_EDIT_MAX_CHARS = 200;

/** A no-signal prompt this long is still asking for real work. */
const SUBSTANTIAL_WORDS = 12;

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
	if (DIAGNOSIS.test(trimmed) || WHY.test(trimmed)) {
		return { level: "high", confidence: "confident", reason: "diagnosis needed" };
	}
	if (FIX.test(trimmed) && (FAILURE_NOUN.test(trimmed) || FAILURE_BEHAVIOR.test(trimmed) || MISMATCH.test(trimmed))) {
		return { level: "high", confidence: "confident", reason: "failure to diagnose and fix" };
	}
	if (FAILURE_BEHAVIOR.test(trimmed)) {
		return { level: "high", confidence: "confident", reason: "misbehavior described" };
	}
	if (QUICK.test(trimmed) && trimmed.length <= QUICK_MAX_CHARS && !hasCodeFence(trimmed)) {
		return { level: "minimal", confidence: "confident", reason: "quick request" };
	}
	if (SMALL_TARGET.test(trimmed) && trimmed.length <= SCOPED_EDIT_MAX_CHARS) {
		return { level: "low", confidence: "confident", reason: "cosmetic edit" };
	}
	if (DESIGN.test(trimmed)) {
		return { level: "medium", confidence: "confident", reason: "design work" };
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
	if (IMPLEMENT.test(trimmed)) {
		return { level: "medium", confidence: "confident", reason: "substantive change requested" };
	}
	if (FILE_PATH.test(trimmed) && trimmed.length <= SCOPED_EDIT_MAX_CHARS) {
		return { level: "low", confidence: "confident", reason: "small scoped edit" };
	}
	if (wordCount(trimmed) >= SUBSTANTIAL_WORDS) {
		return { level: "low", confidence: "uncertain", reason: "substantial prompt, no clear signal" };
	}
	return { level: "minimal", confidence: "uncertain", reason: "no strong signal; starting cheap" };
}

function hasCodeFence(text: string): boolean {
	return text.includes("```");
}

function wordCount(text: string): number {
	return text.split(/\s+/).filter(Boolean).length;
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
