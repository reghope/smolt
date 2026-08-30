/**
 * The goal state machine, kept apart from the wiring so the rules can be read
 * and tested without an agent session around them.
 *
 * A goal is one objective per session, carried across turns, charged for the
 * tokens spent pursuing it, and stopped by its own budget rather than by the
 * model deciding it has done enough. The statuses exist so that "not running"
 * can say *why* it is not running: a paused goal waits for the user, a
 * budget-limited one has spent its allowance, and a blocked one hit the same
 * wall three turns running.
 */

/** Every state a goal can be in. Only `active` continues on its own. */
export type GoalStatus = "active" | "paused" | "blocked" | "budget_limited" | "usage_limited" | "complete";

/** The statuses that mean the goal is finished with, one way or another. */
const SETTLED: ReadonlySet<GoalStatus> = new Set<GoalStatus>(["complete"]);

export interface Goal {
	id: string;
	objective: string;
	status: GoalStatus;
	/** Tokens the goal may spend, or null for no ceiling. */
	tokenBudget: number | null;
	tokensUsed: number;
	/** Wall-clock seconds accumulated while the goal was active. */
	secondsUsed: number;
	createdAt: number;
	updatedAt: number;
	/**
	 * Consecutive continuation turns that reported the same blocking condition.
	 * Reaching the audit length is what lets the model call a goal blocked.
	 */
	blockedRunLength: number;
}

/** Turns the same wall must be hit before a goal may be called blocked. */
export const BLOCKED_AUDIT_TURNS = 3;

/** A goal state change either lands or explains itself; it never throws. */
export type GoalResult = { ok: true; goal: Goal } | { ok: false; error: string };

const now = (): number => Date.now();

/** Short, readable, and unique enough to tell two goals apart in a transcript. */
function goalId(): string {
	return `g${now().toString(36)}${Math.floor(Math.random() * 1296)
		.toString(36)
		.padStart(2, "0")}`;
}

/**
 * Start a goal, refusing while one is still unfinished.
 *
 * Replacing a live goal silently is how an agent talks itself onto an easier
 * objective, so the caller has to finish or clear the old one first.
 */
export function createGoal(current: Goal | null, objective: string, tokenBudget?: number | null): GoalResult {
	const text = objective.trim();
	if (text === "") return { ok: false, error: "A goal needs an objective." };
	if (current !== null && !SETTLED.has(current.status)) {
		return {
			ok: false,
			error: `A goal is already ${current.status}: "${current.objective}". Complete it, or clear it with /goal clear, before setting another.`,
		};
	}
	const budget = tokenBudget === undefined || tokenBudget === null ? null : Math.floor(tokenBudget);
	if (budget !== null && budget <= 0) return { ok: false, error: "A token budget must be a positive number." };
	const stamp = now();
	const goal: Goal = {
		id: goalId(),
		objective: text,
		// A budget already spent at creation is budget-limited from the start
		// rather than briefly active — the same end state, reached honestly.
		status: budget !== null && budget <= 0 ? "budget_limited" : "active",
		tokenBudget: budget,
		tokensUsed: 0,
		secondsUsed: 0,
		createdAt: stamp,
		updatedAt: stamp,
		blockedRunLength: 0,
	};
	return { ok: true, goal };
}

/** Whether a status can still be charged for work. */
function chargeable(status: GoalStatus): boolean {
	return status === "active" || status === "budget_limited";
}

/**
 * Charge a turn's tokens against the goal, and stop it if that spends the
 * budget.
 *
 * Cached input is free to the caller, so it is free here too — the delta is
 * what the turn actually cost. Charging a budget-limited goal keeps the
 * numbers honest for the summary turn that follows.
 */
export function chargeTokens(goal: Goal, delta: number): { goal: Goal; limitReached: boolean } {
	if (delta <= 0 || !chargeable(goal.status)) return { goal, limitReached: false };
	const tokensUsed = goal.tokensUsed + Math.floor(delta);
	const spent = goal.tokenBudget !== null && tokensUsed >= goal.tokenBudget;
	const limitReached = spent && goal.status === "active";
	return {
		goal: {
			...goal,
			tokensUsed,
			status: limitReached ? "budget_limited" : goal.status,
			updatedAt: now(),
		},
		limitReached,
	};
}

/** Add the seconds a goal spent active, for the report at the end. */
export function chargeSeconds(goal: Goal, seconds: number): Goal {
	if (seconds <= 0 || !chargeable(goal.status)) return goal;
	return { ...goal, secondsUsed: goal.secondsUsed + seconds, updatedAt: now() };
}

/** Tokens left, or null when the goal runs without a ceiling. */
export function remainingTokens(goal: Goal): number | null {
	if (goal.tokenBudget === null) return null;
	return Math.max(0, goal.tokenBudget - goal.tokensUsed);
}

/**
 * The model's own status changes, which are deliberately only two.
 *
 * Pausing, resuming and the two limit states belong to the user and to the
 * accounting; a model that could pause its own goal could stop working and
 * call it a decision.
 */
export function modelUpdate(goal: Goal | null, status: "complete" | "blocked"): GoalResult {
	if (goal === null) return { ok: false, error: "There is no goal to update." };
	if (goal.status === "complete") return { ok: false, error: "This goal is already complete." };
	if (status === "blocked" && goal.blockedRunLength < BLOCKED_AUDIT_TURNS) {
		return {
			ok: false,
			error:
				`A goal may only be marked blocked after the same blocking condition has held for ${BLOCKED_AUDIT_TURNS} ` +
				`consecutive goal turns. This one has held for ${goal.blockedRunLength}. Keep working, or report the ` +
				"obstacle and let the user decide.",
		};
	}
	return { ok: true, goal: { ...goal, status, updatedAt: now() } };
}

/** The user's own status changes, which the model cannot make. */
export function userStatus(goal: Goal | null, status: "paused" | "active" | "usage_limited"): GoalResult {
	if (goal === null) return { ok: false, error: "There is no goal." };
	if (goal.status === "complete") return { ok: false, error: "This goal is complete." };
	if (status === "active" && goal.status === "budget_limited" && remainingTokens(goal) === 0) {
		return { ok: false, error: "This goal has spent its token budget. Raise the budget to resume it." };
	}
	// A resumed goal starts its blocked audit again: the wall may have moved.
	const blockedRunLength = status === "active" ? 0 : goal.blockedRunLength;
	return { ok: true, goal: { ...goal, status, blockedRunLength, updatedAt: now() } };
}

/** Raise or lift the ceiling, which is the only way out of budget_limited. */
export function setBudget(goal: Goal | null, tokenBudget: number | null): GoalResult {
	if (goal === null) return { ok: false, error: "There is no goal to budget." };
	if (tokenBudget !== null && tokenBudget <= 0) return { ok: false, error: "A token budget must be positive." };
	const room = tokenBudget === null || tokenBudget > goal.tokensUsed;
	return {
		ok: true,
		goal: {
			...goal,
			tokenBudget: tokenBudget === null ? null : Math.floor(tokenBudget),
			// Restoring headroom to a goal stopped by its budget puts it back to
			// work; anything else keeps the status it had.
			status: goal.status === "budget_limited" && room ? "active" : goal.status,
			updatedAt: now(),
		},
	};
}

/** Note whether the turn that just ran hit the same wall as the one before. */
export function recordTurn(goal: Goal, madeProgress: boolean): Goal {
	return {
		...goal,
		blockedRunLength: madeProgress ? 0 : goal.blockedRunLength + 1,
		updatedAt: now(),
	};
}

/** Whether the goal should drive another turn on its own. */
export function shouldContinue(goal: Goal | null): boolean {
	return goal !== null && goal.status === "active";
}

/** A one-line description for the footer and the /goal status report. */
export function summarize(goal: Goal | null): string {
	if (goal === null) return "no goal";
	const budget =
		goal.tokenBudget === null
			? `${formatTokens(goal.tokensUsed)} used`
			: `${formatTokens(goal.tokensUsed)}/${formatTokens(goal.tokenBudget)}`;
	return `${goal.status} · ${budget}`;
}

/** Token counts read better rounded once they pass a thousand. */
export function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}
