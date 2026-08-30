import { formatTokens, type Goal, remainingTokens } from "./state.ts";

/**
 * What the agent is told, and when.
 *
 * A goal only works if the objective survives contact with a long session:
 * the danger is not that the model forgets the objective but that it quietly
 * shrinks it — declares a narrower thing done and stops. Most of the text
 * below exists to make that harder: work from evidence, not from the
 * conversation; prove completion rather than assert it; never substitute an
 * easier problem.
 */

function budgetLine(goal: Goal): string {
	const left = remainingTokens(goal);
	if (left === null) return `Spent so far: ${formatTokens(goal.tokensUsed)} tokens. No budget ceiling is set.`;
	return `Budget: ${formatTokens(goal.tokensUsed)} of ${formatTokens(goal.tokenBudget ?? 0)} tokens spent, ${formatTokens(left)} remaining.`;
}

/** The block appended to the system prompt while a goal is active. */
export function objectiveBlock(goal: Goal): string {
	return `## Active goal

An objective is in force for this session. It is the user's, not yours to renegotiate.

<objective>
${goal.objective}
</objective>

${budgetLine(goal)}

- Keep the objective whole. Do not redefine success smaller than it was stated.
- Work from evidence in the working tree, not from what the conversation claims.
- Treat completion as unproven until you have checked it requirement by requirement.
- Call the goal tool with action 'update' and status 'complete' only once that audit passes.`;
}

/** The message that starts each automatic continuation turn. */
export function continuationPrompt(goal: Goal): string {
	return `Continue working toward the active goal.

<objective>
${goal.objective}
</objective>

${budgetLine(goal)}

Continuation behaviour
- The objective above is the whole objective. Do not substitute a narrower or easier version of it, and do not treat a partial result as the finish.
- Work from evidence. The working tree is authoritative: inspect files, run things, read output. What the earlier conversation asserts is a claim, not a fact.

Check your last turn before doing anything else, and say which of these it was:
- progress — something concrete changed or was learnt.
- verified wait — you are polling something you have confirmed is live and still running.
- no progress — neither of the above. If so, re-check the obstacle rather than repeating the attempt: an approach that failed once fails the same way twice. Take the next safe action instead.

Blockers that are the same obstacle in different words count as one obstacle, not several.

Finishing
- If the objective is met, audit it requirement by requirement against the evidence, then call the goal tool with action 'update', status 'complete'.
- If you are genuinely at an impasse and have been for three turns running, call it with status 'blocked' and say plainly what is in the way.
- Hard, slow, or uncertain is not blocked.`;
}

/** Sent once, when a charge takes the goal past its budget. */
export function budgetLimitPrompt(goal: Goal): string {
	return `The goal has reached its token budget (${formatTokens(goal.tokensUsed)} of ${formatTokens(goal.tokenBudget ?? 0)}).

Stop here. Do not start new substantive work. Summarise what was achieved toward the objective, what remains, any blockers, and the single next step you would take. Do not mark the goal complete unless it genuinely is — a spent budget is not a finish.`;
}

/** Sent when the user edits the objective while work is under way. */
export function objectiveUpdatedPrompt(goal: Goal): string {
	return `The user has edited the goal's objective. This supersedes the previous one:

<objective>
${goal.objective}
</objective>

Carry on from where you are, against the new objective.`;
}

/** The tool description, which is where the model learns the rules. */
export const GOAL_TOOL_DESCRIPTION =
	"Read and change the session's goal: one standing objective the harness carries across turns, charges " +
	"tokens against, and continues automatically until it is met.\n\n" +
	"ACTIONS: 'get' returns the current goal, its status, and remaining budget. 'create' (objective, " +
	"token_budget?) starts a goal. 'update' (status) marks the current goal 'complete' or 'blocked'.\n\n" +
	"RULES: Create a goal only when the user explicitly asks for one — never infer a goal from an ordinary " +
	"task. Set token_budget only when the user asks for a budget. Creating fails while an unfinished goal " +
	"exists. Mark complete only when the objective is achieved with no work remaining, and never because " +
	"the budget is nearly spent. Mark blocked only at a genuine impasse where the same obstacle has held " +
	"for three consecutive goal turns. You cannot pause, resume, or budget-limit a goal with this tool — " +
	"those belong to the user.";
