import * as fs from "node:fs";
import * as path from "node:path";
import type { ThinkingLevel } from "@smolt/agent-core";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@smolt/ai/compat";
import { getAgentDir } from "../../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { CANONICAL_LEVELS, type Classification, classify, escalationLadder, nextRung } from "./classifier.ts";

/**
 * Auto thinking: the session classifies how much thinking each task needs
 * instead of running one static level.
 *
 * When the "auto" entry is selected in the thinking selector, every real user
 * message is classified by a zero-usage heuristic (classifier.ts) before the
 * first request goes out. Conversational noise runs without thinking,
 * diagnosis and design requests run high, substantive change requests run
 * medium, and only prompts with no work signal at all start at the bottom
 * bands rather than paying for a classification call. If a task then
 * struggles, escalation
 * bumps the level one rung at a time: two consecutive tool errors, or a
 * burst of provider error responses, move minimal → low → medium, capped at
 * medium and never down-escalating mid-task. Every decision is visible in
 * the footer and recorded as a custom session entry.
 *
 * Manual picks always win: choosing any concrete level stands auto down
 * until "auto" is selected again. Model switches rewrite the level as a side
 * effect; those do not stand auto down. Subagent threads spawn with
 * `agent.thinking ?? ctx.thinkingLevel` (subagents extension), so they
 * inherit the current task's level for free.
 */

/** Custom entry type the decisions are recorded under (not sent to the LLM). */
export const AUTO_THINKING_ENTRY = "auto-thinking";

/** The selector entry id. Distinct from every ThinkingLevel value. */
const ENTRY_VALUE = "auto";

/**
 * What the mode is called wherever a person reads it: the selector entry, the
 * footer status, the command output. The entry *value* stays "auto" — it is
 * persisted as a default and matched by `/thinking auto`, so renaming that
 * would break both.
 */
const MODE_NAME = "auto thinking";

/** Footer status key. */
const STATUS_KEY = "auto-thinking";

/** Consecutive tool errors that count as struggling. */
const ERROR_ESCALATION_THRESHOLD = 2;

/** Provider error responses within a task that count as struggling. */
const API_ERROR_BURST = 3;

/** Where the startup preference lives (whether fresh sessions start on auto). */
const PREF_FILE = "auto-thinking.json";

interface AutoThinkingPref {
	enabled?: boolean;
}

interface AutoThinkingState {
	/** Whether the mode is active for this session. */
	autoMode: boolean;
	/** Level applied to the current task, or null before the first one. */
	taskLevel: ThinkingLevel | null;
	/** Why the current level was chosen; shown in the footer. */
	reason: string;
	/** Whether the current level was reached by escalation. */
	escalated: boolean;
	/** Consecutive failed tool results in the current task. */
	consecutiveToolErrors: number;
	/** Provider error responses seen in the current task. */
	apiErrorCount: number;
	/**
	 * The level the extension itself applied last. thinking_level_select
	 * events carrying this level are the extension's own changes; anything
	 * else is a manual pick and stands auto down.
	 */
	expectedLevel: ThinkingLevel | null;
	/** Model identity last seen; a change means the level moved by a model switch. */
	knownModelId: string | null;
}

function readPref(): AutoThinkingPref {
	try {
		return JSON.parse(fs.readFileSync(path.join(getAgentDir(), PREF_FILE), "utf8")) as AutoThinkingPref;
	} catch {
		return {};
	}
}

function writePref(enabled: boolean): void {
	try {
		fs.mkdirSync(getAgentDir(), { recursive: true });
		fs.writeFileSync(path.join(getAgentDir(), PREF_FILE), `${JSON.stringify({ enabled }, null, 2)}\n`);
	} catch {
		// Best effort: an unwritable agent dir must not break selection.
	}
}

/** Whether the current model has any thinking to tune. */
function supportsThinking(ctx: ExtensionContext): boolean {
	return ctx.model?.reasoning === true;
}

function modelId(ctx: ExtensionContext): string | null {
	const model = ctx.model;
	return model ? `${model.provider}/${model.id}` : null;
}

export default function autoThinkingExtension(smolt: ExtensionAPI): void {
	createAutoThinkingExtension(smolt);
}

export interface AutoThinkingHandle {
	/** Current state, for tests and for other callers. */
	state(): AutoThinkingState;
}

export function createAutoThinkingExtension(smolt: ExtensionAPI): AutoThinkingHandle {
	const state: AutoThinkingState = {
		autoMode: true,
		taskLevel: null,
		reason: "",
		escalated: false,
		consecutiveToolErrors: 0,
		apiErrorCount: 0,
		expectedLevel: null,
		knownModelId: null,
	};

	const footerText = (): string => {
		if (!state.autoMode) return "";
		if (state.taskLevel === null) return `${MODE_NAME}: on`;
		const level = state.escalated
			? `${state.taskLevel} (escalated: ${state.reason})`
			: `${state.taskLevel} · ${state.reason}`;
		return `${MODE_NAME}: ${level}`;
	};

	const paint = (ctx: ExtensionContext): void => {
		if (!state.autoMode || !supportsThinking(ctx)) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.setWidget(STATUS_KEY, undefined);
			return;
		}
		const text = supportsThinking(ctx) ? footerText() : `${MODE_NAME}: model has no thinking`;
		ctx.ui.setStatus(STATUS_KEY, text);
		// Status only: a widget for this used to render as stray "auto: on"
		// text below the TUI footer, and no surface shows a standalone widget
		// for a non-tool key — the footer status is the whole story.
		ctx.ui.setWidget(STATUS_KEY, undefined);
	};

	/**
	 * The level the session will actually hold: the classification, fitted to
	 * the model. The core's own clamp rounds UP when a model lacks the
	 * requested level, which on sparsely-mapped models collapsed every
	 * classification into the top band — the opposite of what auto thinking
	 * is for. Prefer the nearest supported level at or below the
	 * classification ("off" only when off was asked for), and round up only
	 * when nothing cheaper exists.
	 */
	const effectiveLevel = (level: ThinkingLevel, ctx: ExtensionContext): ThinkingLevel => {
		const model = ctx.model;
		if (!model) return level;
		const supported = getSupportedThinkingLevels(model) as ThinkingLevel[];
		if (supported.includes(level)) return level;
		for (let i = CANONICAL_LEVELS.indexOf(level) - 1; i > 0; i--) {
			const candidate = CANONICAL_LEVELS[i]!;
			if (supported.includes(candidate)) return candidate;
		}
		return clampThinkingLevel(model, level) as ThinkingLevel;
	};

	/** Apply a classification to the session, deduplicating no-op sets. */
	const applyLevel = (classification: Classification, ctx: ExtensionContext): void => {
		const previous = smolt.getThinkingLevel();
		const effective = effectiveLevel(classification.level, ctx);
		state.taskLevel = effective;
		state.reason = classification.reason;
		state.escalated = false;
		state.consecutiveToolErrors = 0;
		state.apiErrorCount = 0;
		state.expectedLevel = effective === previous ? null : effective;
		if (effective !== previous) {
			// Set the fitted level, not the raw classification: the core's own
			// clamp would round the raw one up on models missing that level.
			smolt.setThinkingLevel(effective);
		}
		paint(ctx);
		smolt.appendEntry(AUTO_THINKING_ENTRY, {
			level: effective,
			classified: classification.level,
			confidence: classification.confidence,
			reason: classification.reason,
		});
	};

	/** Bump one rung up the escalation ladder when the task is struggling. */
	const escalate = (cause: string, ctx: ExtensionContext): void => {
		if (state.taskLevel === null) return;
		const supported = (ctx.model ? getSupportedThinkingLevels(ctx.model) : []) as ThinkingLevel[];
		const rung = nextRung(escalationLadder(supported), state.taskLevel);
		if (!rung || rung === state.taskLevel) return;
		const previous = smolt.getThinkingLevel();
		const effective = effectiveLevel(rung, ctx);
		if (effective === previous) {
			// The session already sits at this level (e.g. clamped earlier).
			state.expectedLevel = null;
			return;
		}
		state.expectedLevel = effective;
		smolt.setThinkingLevel(effective);
		state.taskLevel = effective;
		state.reason = cause;
		state.escalated = true;
		paint(ctx);
		smolt.appendEntry(AUTO_THINKING_ENTRY, { level: effective, escalated: true, reason: cause });
	};

	smolt.on("session_start", (_event, ctx) => {
		state.autoMode = readPref().enabled !== false;
		state.taskLevel = null;
		state.reason = "";
		state.escalated = false;
		state.consecutiveToolErrors = 0;
		state.apiErrorCount = 0;
		state.expectedLevel = null;
		state.knownModelId = modelId(ctx);
		paint(ctx);
	});

	smolt.on("model_select", (_event, ctx) => {
		state.knownModelId = modelId(ctx);
		paint(ctx);
	});

	smolt.on("input", (event, ctx) => {
		if (!state.autoMode) return;
		// Continuations of the running task (steer/follow-up deliveries and
		// prompts sent by other extensions) keep the current level: the task
		// was already classified, and re-reading every queued message would
		// churn the level mid-task.
		if (event.source === "extension" || event.streamingBehavior !== undefined) return;
		// Slash input expands into skills and templates later; classifying the
		// command text would classify the wrong thing.
		if (event.text.trim().startsWith("/")) return;
		if (!supportsThinking(ctx)) {
			paint(ctx);
			return;
		}
		applyLevel(classify(event.text, { previousLevel: state.taskLevel ?? undefined }), ctx);
	});

	smolt.on("thinking_level_select", (event, ctx) => {
		const currentModelId = modelId(ctx);
		if (currentModelId !== state.knownModelId) {
			// Model switches rewrite the level as a side effect; auto stays on.
			state.knownModelId = currentModelId;
			return;
		}
		if (state.expectedLevel !== null && event.level === state.expectedLevel) {
			state.expectedLevel = null;
			return;
		}
		if (!state.autoMode) return;
		// A level the extension did not apply is a manual pick: stand down.
		state.autoMode = false;
		state.taskLevel = null;
		state.expectedLevel = null;
		paint(ctx);
		smolt.appendEntry(AUTO_THINKING_ENTRY, { manual: true, level: event.level });
	});

	smolt.on("tool_result", (event, ctx) => {
		if (!state.autoMode || state.taskLevel === null) return;
		if (event.isError) {
			state.consecutiveToolErrors++;
		} else {
			state.consecutiveToolErrors = 0;
		}
		if (state.consecutiveToolErrors >= ERROR_ESCALATION_THRESHOLD) {
			state.consecutiveToolErrors = 0;
			escalate("repeated tool errors", ctx);
		}
	});

	smolt.on("after_provider_response", (event, ctx) => {
		if (!state.autoMode || state.taskLevel === null) return;
		if (event.status < 400) return;
		state.apiErrorCount++;
		if (state.apiErrorCount >= API_ERROR_BURST) {
			state.apiErrorCount = 0;
			escalate("provider errors", ctx);
		}
	});

	smolt.registerCommand("auto-thinking", {
		description: "Auto thinking mode: classify thinking per task (on | off | status)",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "off") {
				state.autoMode = false;
				paint(ctx);
				ctx.ui.notify("Auto thinking off for this session. Turn it back on with /thinking auto.");
				return;
			}
			if (arg === "status") {
				ctx.ui.notify(state.autoMode ? `Auto thinking on. ${footerText()}` : "Auto thinking off.");
				return;
			}
			if (arg === "" || arg === "on") {
				state.autoMode = true;
				state.taskLevel = null;
				state.expectedLevel = null;
				paint(ctx);
				ctx.ui.notify("Auto thinking on: each task's level is classified before its first request.");
				return;
			}
			ctx.ui.notify("Usage: /auto-thinking [on | off | status]");
		},
	});

	smolt.registerThinkingLevelEntry({
		value: ENTRY_VALUE,
		label: MODE_NAME,
		description: "Classify thinking per task · no extra usage",
		isCurrent: () => state.autoMode,
		onSelect: (ctx) => {
			state.autoMode = true;
			state.taskLevel = null;
			state.expectedLevel = null;
			paint(ctx);
			ctx.ui.notify("Auto thinking on: each task's level is classified before its first request.");
		},
		onSelectAsDefault: (ctx) => {
			writePref(true);
			state.autoMode = true;
			state.taskLevel = null;
			paint(ctx);
			ctx.ui.notify("Auto thinking will be on in new sessions.");
		},
	});

	return { state: () => state };
}
