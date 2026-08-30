import { describe, expect, test } from "vitest";
import {
	BLOCKED_AUDIT_TURNS,
	chargeTokens,
	createGoal,
	formatTokens,
	type Goal,
	modelUpdate,
	recordTurn,
	remainingTokens,
	setBudget,
	shouldContinue,
	userStatus,
} from "../src/extensions/goal/state.ts";

/**
 * The goal rules exist to stop a self-continuing session from talking itself
 * into a finish: a budget it cannot spend past, an audit it must pass before
 * claiming completion, and a set of statuses only the user can reach.
 */

function start(objective = "Ship the parser", budget: number | null = null): Goal {
	const result = createGoal(null, objective, budget);
	if (!result.ok) throw new Error(result.error);
	return result.goal;
}

describe("creating", () => {
	test("a goal starts active and unspent", () => {
		const goal = start();
		expect(goal.status).toBe("active");
		expect(goal.tokensUsed).toBe(0);
		expect(remainingTokens(goal)).toBeNull();
		expect(shouldContinue(goal)).toBe(true);
	});

	test("an unfinished goal refuses to be replaced", () => {
		const first = start("Ship the parser");
		const second = createGoal(first, "Something easier");
		expect(second.ok).toBe(false);
		if (!second.ok) expect(second.error).toContain("already active");
	});

	test("a completed goal makes way for the next one", () => {
		const done: Goal = { ...start(), status: "complete" };
		const next = createGoal(done, "The next thing");
		expect(next.ok).toBe(true);
	});

	test("an empty objective is not a goal", () => {
		expect(createGoal(null, "   ").ok).toBe(false);
	});
});

describe("budget", () => {
	test("cached input is not charged", () => {
		// The charge is whatever the turn actually cost, which is what the
		// caller was billed for — cache reads were free to them.
		const goal = start("Ship it", 1000);
		const { goal: charged } = chargeTokens(goal, 400);
		expect(charged.tokensUsed).toBe(400);
		expect(remainingTokens(charged)).toBe(600);
	});

	test("spending the budget stops the goal, once", () => {
		let goal = start("Ship it", 500);
		const first = chargeTokens(goal, 500);
		goal = first.goal;
		expect(first.limitReached).toBe(true);
		expect(goal.status).toBe("budget_limited");
		expect(shouldContinue(goal)).toBe(false);
		// The closing turn still charges, but does not re-announce the limit.
		const second = chargeTokens(goal, 90);
		expect(second.limitReached).toBe(false);
		expect(second.goal.tokensUsed).toBe(590);
	});

	test("raising the ceiling puts a stopped goal back to work", () => {
		let goal = start("Ship it", 500);
		goal = chargeTokens(goal, 600).goal;
		expect(goal.status).toBe("budget_limited");
		const raised = setBudget(goal, 2000);
		expect(raised.ok).toBe(true);
		if (raised.ok) expect(raised.goal.status).toBe("active");
	});

	test("lifting the ceiling entirely also resumes it", () => {
		let goal = start("Ship it", 100);
		goal = chargeTokens(goal, 100).goal;
		const lifted = setBudget(goal, null);
		expect(lifted.ok).toBe(true);
		if (lifted.ok) {
			expect(lifted.goal.status).toBe("active");
			expect(remainingTokens(lifted.goal)).toBeNull();
		}
	});

	test("a paused goal is not charged", () => {
		const paused = userStatus(start(), "paused");
		expect(paused.ok).toBe(true);
		if (!paused.ok) return;
		expect(chargeTokens(paused.goal, 500).goal.tokensUsed).toBe(0);
	});
});

describe("what the model may change", () => {
	test("it cannot call a goal blocked until the wall has held three turns", () => {
		let goal = start();
		const early = modelUpdate(goal, "blocked");
		expect(early.ok).toBe(false);
		if (!early.ok) expect(early.error).toContain("consecutive");
		for (let turn = 0; turn < BLOCKED_AUDIT_TURNS; turn++) goal = recordTurn(goal, false);
		const now = modelUpdate(goal, "blocked");
		expect(now.ok).toBe(true);
		if (now.ok) expect(now.goal.status).toBe("blocked");
	});

	test("a turn that got somewhere resets the audit", () => {
		let goal = start();
		goal = recordTurn(goal, false);
		goal = recordTurn(goal, false);
		goal = recordTurn(goal, true);
		expect(modelUpdate(goal, "blocked").ok).toBe(false);
	});

	test("completing is always allowed, and stops the continuation", () => {
		const done = modelUpdate(start(), "complete");
		expect(done.ok).toBe(true);
		if (done.ok) expect(shouldContinue(done.goal)).toBe(false);
	});

	test("a complete goal cannot be updated again", () => {
		const done = modelUpdate(start(), "complete");
		if (!done.ok) throw new Error("expected completion");
		expect(modelUpdate(done.goal, "complete").ok).toBe(false);
	});
});

describe("what the user may change", () => {
	test("resuming a blocked goal starts its audit over", () => {
		let goal = start();
		for (let turn = 0; turn < BLOCKED_AUDIT_TURNS; turn++) goal = recordTurn(goal, false);
		const blocked = modelUpdate(goal, "blocked");
		if (!blocked.ok) throw new Error("expected block");
		const resumed = userStatus(blocked.goal, "active");
		expect(resumed.ok).toBe(true);
		if (resumed.ok) {
			expect(resumed.goal.status).toBe("active");
			// The wall may have moved; the model has to prove it again.
			expect(modelUpdate(resumed.goal, "blocked").ok).toBe(false);
		}
	});

	test("a goal stopped by its budget cannot simply be resumed", () => {
		let goal = start("Ship it", 100);
		goal = chargeTokens(goal, 100).goal;
		const resumed = userStatus(goal, "active");
		expect(resumed.ok).toBe(false);
		if (!resumed.ok) expect(resumed.error).toContain("budget");
	});
});

describe("formatting", () => {
	test("token counts round once they get long", () => {
		expect(formatTokens(940)).toBe("940");
		expect(formatTokens(1500)).toBe("1.5k");
		expect(formatTokens(48_000)).toBe("48k");
		expect(formatTokens(2_400_000)).toBe("2.4M");
	});
});
