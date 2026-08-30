import { Type } from "typebox";
// Type-only import: a standalone install of this module outside the smolt
// tree switches this single line to `from "smolt"`.
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import {
	budgetLimitPrompt,
	continuationPrompt,
	GOAL_TOOL_DESCRIPTION,
	objectiveBlock,
	objectiveUpdatedPrompt,
} from "./prompts.ts";
import {
	chargeSeconds,
	chargeTokens,
	createGoal,
	formatTokens,
	type Goal,
	modelUpdate,
	recordTurn,
	remainingTokens,
	setBudget,
	shouldContinue,
	summarize,
	userStatus,
} from "./state.ts";

/**
 * Goal: one objective the session keeps working toward on its own.
 *
 * An ordinary turn ends when the model decides it has said enough. A goal
 * moves that decision out of the model's hands: the objective is held by the
 * harness, every settled turn is asked whether the objective is met, and if
 * it is not the session continues by itself. What makes it safe rather than a
 * runaway loop is the accounting — a token budget that stops it, an audit the
 * model must pass before it can call the work done, and a spin guard that
 * refuses to continue a turn that did nothing.
 *
 * The goal lives in the session file as a custom entry, so it survives a
 * reload or a resume without ever entering the model's context as history.
 */

/** The custom entry type the goal is persisted under. */
export const GOAL_ENTRY = "goal-state";

/**
 * Below this share of the context window the continuation skips compaction:
 * a short session is already fresh, and summarizing it would cost a call to
 * save nothing. Matched to the wayfinder extension, which continues the same way.
 */
const COMPACT_MIN_PERCENT = 25;

const COMPACT_INSTRUCTIONS =
	"This session is continuing toward a standing goal. Preserve: the objective, what has actually been " +
	"verified against the working tree, obstacles hit and what was tried, and any decision the user made. " +
	"Exploratory back-and-forth can be dropped.";

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
}

/** Usage as the providers report it, of which only some fields are charged. */
interface MessageUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
}

/**
 * What a turn cost the goal.
 *
 * Cached input is not charged: the user did not pay for it, so the goal
 * should not either. Reasoning tokens are inside `output` and do count —
 * thinking hard toward the objective is still spending the budget on it.
 */
export function turnCost(messages: { role?: string; usage?: MessageUsage }[]): number {
	let total = 0;
	for (const message of messages) {
		if (message.role !== "assistant" || !message.usage) continue;
		const input = message.usage.input ?? 0;
		const cached = message.usage.cacheRead ?? 0;
		total += Math.max(0, input - cached) + (message.usage.output ?? 0);
	}
	return total;
}

/** Whether a run did anything, which is what separates work from spinning. */
export function usedTools(messages: { role?: string; content?: unknown }[]): boolean {
	for (const message of messages) {
		if (message.role === "toolResult") return true;
		const content = message.content;
		if (!Array.isArray(content)) continue;
		if (content.some((block) => (block as { type?: string })?.type === "toolCall")) return true;
	}
	return false;
}

export default function goalExtension(smolt: ExtensionAPI): void {
	createGoalExtension(smolt);
}

export interface GoalHandle {
	/** The goal as it currently stands, for tests and for other callers. */
	current(): Goal | null;
}

export function createGoalExtension(smolt: ExtensionAPI): GoalHandle {
	let goal: Goal | null = null;
	/**
	 * Suppresses exactly one automatic continuation.
	 *
	 * Set when a continuation turn ends without calling a single tool: the
	 * model had nothing to do and said so, and asking it again immediately
	 * would just get the same answer. Any real user turn clears it.
	 */
	let deferNextContinuation = false;
	/** The run now settling was started by the goal, not by the user. */
	let runIsContinuation = false;
	/** When the current turn began, for the wall-clock part of the report. */
	let turnStartedAt = 0;
	/** The budget notice is sent once per goal, not once per charge. */
	let budgetLimitReported = "";

	const persist = (): void => {
		smolt.appendEntry(GOAL_ENTRY, goal);
	};

	const paint = (ctx: ExtensionContext): void => {
		if (goal === null) {
			ctx.ui.setStatus("goal", undefined);
			ctx.ui.setWidget("goal", undefined);
			return;
		}
		ctx.ui.setStatus("goal", `goal: ${summarize(goal)}`);
		// The widget is for the states that need a decision from the user. An
		// active goal is already visible in the work itself.
		if (goal.status === "active" || goal.status === "complete") {
			ctx.ui.setWidget("goal", undefined);
			return;
		}
		ctx.ui.setWidget("goal", [`goal ${goal.status}: ${goal.objective}`, "/goal resume | /goal clear"]);
	};

	/**
	 * Restore the goal from the session file.
	 *
	 * Every change appends an entry, so the last one on the branch is the
	 * current state — which also means a rewind to an earlier point in the
	 * conversation rewinds the goal with it, as it should.
	 */
	smolt.on("session_start", async (_event, ctx) => {
		goal = null;
		deferNextContinuation = false;
		runIsContinuation = false;
		budgetLimitReported = "";
		try {
			for (const entry of ctx.sessionManager.getEntries()) {
				if (entry.type !== "custom" || entry.customType !== GOAL_ENTRY) continue;
				goal = (entry.data as Goal | null) ?? null;
			}
		} catch {
			// A session without readable entries simply starts without a goal.
		}
		paint(ctx);
	});

	// A prompt the user actually typed clears the spin guard: they have seen
	// the last turn and asked for more, which is the signal the guard waits for.
	smolt.on("before_agent_start", async (event, ctx) => {
		turnStartedAt = Date.now();
		if (!runIsContinuation) deferNextContinuation = false;
		paint(ctx);
		if (goal === null || goal.status !== "active") return;
		return { systemPrompt: `${event.systemPrompt}\n\n${objectiveBlock(goal)}` };
	});

	smolt.on("agent_end", async (event, ctx) => {
		if (goal === null) return;
		const messages = event.messages as { role?: string; usage?: MessageUsage; content?: unknown }[];
		const charged = chargeTokens(goal, turnCost(messages));
		goal = charged.goal;
		if (turnStartedAt > 0) goal = chargeSeconds(goal, Math.round((Date.now() - turnStartedAt) / 1000));
		// A turn that called no tool made no contact with the world; count it
		// toward the blocked audit rather than as progress.
		goal = recordTurn(goal, usedTools(messages));
		if (runIsContinuation && !usedTools(messages)) deferNextContinuation = true;
		if (charged.limitReached && budgetLimitReported !== goal.id) {
			budgetLimitReported = goal.id;
			ctx.ui.notify(`Goal reached its token budget (${formatTokens(goal.tokensUsed)}).`, "warning");
		}
		persist();
		paint(ctx);
	});

	smolt.on("agent_settled", async (_event, ctx) => {
		runIsContinuation = false;
		if (goal === null) return;
		paint(ctx);
		// Only where a conversation exists to continue, and never over a message
		// the user has already queued behind this turn.
		if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
		if (ctx.hasPendingMessages()) return;
		// Whoever spent the budget — the user driving or the loop itself — the
		// goal gets one turn to say where it got to before it goes quiet.
		if (goal.status === "budget_limited" && budgetLimitReported === goal.id) {
			// One closing turn to report where the goal got to, then silence.
			budgetLimitReported = `${goal.id}:reported`;
			runIsContinuation = true;
			smolt.sendUserMessage(budgetLimitPrompt(goal));
			return;
		}
		if (!shouldContinue(goal)) return;
		if (deferNextContinuation) {
			deferNextContinuation = false;
			return;
		}
		const active = goal;
		const send = (): void => {
			runIsContinuation = true;
			smolt.sendUserMessage(continuationPrompt(active));
		};
		const percent = ctx.getContextUsage()?.percent;
		if (percent !== null && percent !== undefined && percent >= COMPACT_MIN_PERCENT) {
			ctx.compact({ customInstructions: COMPACT_INSTRUCTIONS, onComplete: send, onError: send });
		} else {
			send();
		}
	});

	smolt.registerTool({
		name: "goal",
		label: "Goal",
		description: GOAL_TOOL_DESCRIPTION,
		parameters: Type.Object({
			action: Type.Union([Type.Literal("get"), Type.Literal("create"), Type.Literal("update")], {
				description: "Operation to perform",
			}),
			objective: Type.Optional(
				Type.String({ description: "What the goal is working toward, in full. Required for 'create'." }),
			),
			token_budget: Type.Optional(
				Type.Number({ description: "Token ceiling for the goal. Only when the user asked for a budget." }),
			),
			status: Type.Optional(
				Type.Union([Type.Literal("complete"), Type.Literal("blocked")], {
					description: "For 'update': the new status. Complete only when achieved; blocked only at an impasse.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.action === "get") {
				return textResult(JSON.stringify({ goal, remaining_tokens: goal ? remainingTokens(goal) : null }));
			}
			if (params.action === "create") {
				const result = createGoal(goal, params.objective ?? "", params.token_budget ?? null);
				if (!result.ok) return textResult(JSON.stringify({ success: false, error: result.error }));
				goal = result.goal;
				budgetLimitReported = "";
				persist();
				paint(ctx);
				return textResult(JSON.stringify({ success: true, goal, remaining_tokens: remainingTokens(goal) }));
			}
			const result = modelUpdate(goal, params.status ?? "complete");
			if (!result.ok) return textResult(JSON.stringify({ success: false, error: result.error }));
			goal = result.goal;
			persist();
			paint(ctx);
			return textResult(
				JSON.stringify({
					success: true,
					goal,
					completion_budget_report:
						goal.status === "complete"
							? `Tell the user what this goal cost: ${formatTokens(goal.tokensUsed)} tokens over ${goal.secondsUsed}s.`
							: undefined,
				}),
			);
		},
	});

	smolt.registerCommand("goal", {
		description: "Set a standing objective the session works toward on its own",
		getArgumentCompletions: (argumentPrefix) => {
			const items = [
				{ value: "pause", label: "pause", description: "Stop continuing on its own" },
				{ value: "resume", label: "resume", description: "Carry on toward the objective" },
				{ value: "clear", label: "clear", description: "Drop the goal entirely" },
				{ value: "budget", label: "budget <tokens>", description: "Set or lift the token ceiling" },
			];
			const prefix = argumentPrefix.trim().toLowerCase();
			return items.filter((item) => item.value.startsWith(prefix));
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const [word, ...rest] = trimmed.split(/\s+/);
			const verb = (word ?? "").toLowerCase();

			if (trimmed === "") {
				if (goal === null) {
					ctx.ui.notify("No goal. Set one with /goal <what you want done>.", "info");
					return;
				}
				const left = remainingTokens(goal);
				ctx.ui.notify(
					`Goal (${goal.status}): ${goal.objective} — ${formatTokens(goal.tokensUsed)} tokens spent${
						left === null ? "" : `, ${formatTokens(left)} left`
					}, ${goal.secondsUsed}s.`,
					"info",
				);
				return;
			}

			if (verb === "pause" || verb === "resume") {
				const result = userStatus(goal, verb === "pause" ? "paused" : "active");
				if (!result.ok) {
					ctx.ui.notify(result.error, "warning");
					return;
				}
				goal = result.goal;
				persist();
				paint(ctx);
				ctx.ui.notify(verb === "pause" ? "Goal paused." : "Goal resumed.", "info");
				// Resuming while idle should start work, not wait for a prompt.
				if (verb === "resume" && ctx.isIdle() && !ctx.hasPendingMessages()) {
					runIsContinuation = true;
					smolt.sendUserMessage(continuationPrompt(goal));
				}
				return;
			}

			if (verb === "clear") {
				goal = null;
				deferNextContinuation = false;
				budgetLimitReported = "";
				persist();
				paint(ctx);
				ctx.ui.notify("Goal cleared.", "info");
				return;
			}

			if (verb === "budget") {
				const raw = rest.join(" ").trim();
				const value = raw === "" || raw === "none" || raw === "off" ? null : Number(raw);
				if (value !== null && !Number.isFinite(value)) {
					ctx.ui.notify("Give a token count, or 'none' to lift the ceiling.", "warning");
					return;
				}
				const result = setBudget(goal, value);
				if (!result.ok) {
					ctx.ui.notify(result.error, "warning");
					return;
				}
				goal = result.goal;
				persist();
				paint(ctx);
				ctx.ui.notify(
					value === null ? "Goal budget lifted." : `Goal budget: ${formatTokens(value)} tokens.`,
					"info",
				);
				return;
			}

			// Anything else is the objective itself, in the user's own words.
			if (goal !== null && goal.status !== "complete") {
				// Editing a live objective replaces it rather than being refused:
				// the user is the one who set it, and a refusal here would just
				// make them clear and retype.
				goal = { ...goal, objective: trimmed, status: "active", blockedRunLength: 0, updatedAt: Date.now() };
				persist();
				paint(ctx);
				ctx.ui.notify("Goal updated.", "info");
				runIsContinuation = true;
				smolt.sendUserMessage(objectiveUpdatedPrompt(goal));
				return;
			}
			const result = createGoal(null, trimmed, null);
			if (!result.ok) {
				ctx.ui.notify(result.error, "warning");
				return;
			}
			goal = result.goal;
			budgetLimitReported = "";
			persist();
			paint(ctx);
			runIsContinuation = true;
			smolt.sendUserMessage(continuationPrompt(goal));
		},
	});

	return { current: () => goal };
}
