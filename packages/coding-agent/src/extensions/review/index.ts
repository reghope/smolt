import { Type } from "typebox";
// Type-only import: a standalone install of this module outside the smolt
// tree switches this single line to `from "smolt"`.
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { projectStore } from "../../core/project-store.ts";
import {
	FINDING_CATEGORIES,
	FINDING_CONFIDENCES,
	FINDING_SEVERITIES,
	FINDING_STATUSES,
	ReviewStore,
	reviewTool,
} from "./store.ts";

/**
 * Review: CodeRabbit-grade code review as a smolt extension.
 *
 * `/review` reviews the repo's current pending changes; `/review <target>`
 * reviews whatever the user names — a PR number, a branch, a commit range, a
 * path. The engine is the supervising session itself, driven by a doctrine
 * prompt: resolve the target to a diff, read the change with its surrounding
 * context, hunt real defects across fixed dimensions, and put every
 * candidate through a verification bar before it may be recorded. The store
 * (store.ts) holds that bar as machinery: a finding without a concrete
 * failure scenario and evidence is rejected at the door, and a finding an
 * earlier review of the same target already holds open bounces instead of
 * being re-reported — a re-review speaks only about what is new.
 *
 * When the target is a pull request the review is also posted to it, as one
 * self-updating comment sent by smolt from this machine through `gh`. The
 * comment is authored by whoever is logged in rather than by a bot, and no
 * CI, workflow file or uploaded credential is involved anywhere.
 */

function reviewRoot(): string {
	return projectStore(process.cwd(), "review");
}

/** The marker the posted comment carries so a re-review updates it instead of stacking. */
const COMMENT_MARKER = "<!-- smolt-review -->";

/** The comment's masthead: the pixelfish beside the name, so a review is recognisable at a glance. */
const COMMENT_HEADING =
	'<img src="https://raw.githubusercontent.com/reghope/smolt/main/packages/desktop/build/icon.png" width="22" align="top" alt=""> **Smolt review**';

/**
 * The review doctrine: how a session turns "review X" into verified
 * findings. Shared verbatim between the local command and the CI entrypoint,
 * so a PR gets exactly the review a lap of /review gives.
 */
function doctrine(): string {
	return `HOW TO REVIEW
1. RESOLVE the target to an exact diff and name it honestly:
   - No target: pending work — staged + unstaged + untracked files, diffed against the merge-base with the default branch (git merge-base HEAD origin/HEAD or main/master). target_key: the current branch name, or 'worktree' when detached.
   - A number (or #number / a PR URL): that pull request via 'gh pr diff <n>' and 'gh pr view <n>'. target_key: 'pr-<n>'.
   - A branch name: its diff against the merge-base with the default branch. target_key: the branch name.
   - A range A..B: exactly that. target_key: the range.
   - A path: the pending-work diff limited to it. target_key: the branch name.
   - Anything else is plain language — interpret it against the repo, say what you resolved it to.
   An empty diff is a real answer: say so and stop; no review record for nothing.
2. START the record: review tool action 'start' (target, target_key). It returns the standing findings from earlier reviews of the same target — verify each against the current code, mark the gone ones 'fixed' (update_finding), and never re-report one that still stands.
3. READ the change properly. The diff alone lies: for every non-trivial hunk read the enclosing function, the callers of what changed, and the tests that cover it. Understand what the change is trying to do before judging how.
4. HUNT across these dimensions, in this order of importance: correctness (broken logic, wrong edge cases, races), security (injection, secrets, unsafe input, permissions), data loss (destructive paths, missing guards, bad migrations), API/contract breaks (signatures, wire formats, persisted shapes), performance (only where it plausibly matters), simplification (dead code, needless complexity — sparingly), test gaps (only for risky changed behavior).
5. VERIFY before recording. For each candidate: trace the concrete inputs or state that produce the wrong outcome. If you cannot name them, it is not a finding — drop it. Style opinions, hypotheticals, and "consider..." advice are not findings.
6. RECORD what survives: review tool action 'add_finding' (title, file, line, severity blocker/major/minor/polish, category, confidence certain/likely/possible, claim, failure_scenario, evidence, suggested_fix?). The tool rejects findings without a failure scenario and bounces ones an earlier review holds open — obey the bounce.
7. CLOSE: action 'complete' with a short summary (what was reviewed, the shape of what was found, what is fine).
QUALITY BAR: fewer, harder findings beat many soft ones. No praise padding, no restating the diff, no nitpicks the codebase's own style contradicts. If the change is good, a clean review with zero findings is the correct and complete result.`;
}

/** A target naming a pull request: 5, #5, or any .../pull/5 URL. */
function pullRequestNumber(target: string): string | undefined {
	return /^#?(\d+)$/.exec(target)?.[1] ?? /\/pull\/(\d+)\b/.exec(target)?.[1];
}

/**
 * Posting is smolt's own job, done from this machine with the `gh` the reader
 * already logged in: no CI runs it, so the comment is authored by them rather
 * than by a bot, and no credential is uploaded anywhere.
 */
function postingInstructions(pr: string): string {
	return `

Then POST the review to pull request #${pr} as ONE comment, using gh on this machine:
- Write the body to a file. It opens with the exact marker line '${COMMENT_MARKER}', a blank line, then the branded heading:
  ${COMMENT_HEADING}
  Then the findings grouped by severity as '- **file:line** claim — failure scenario', then one summary line. With zero findings the body says the diff was reviewed and nothing worth flagging was found. Put the commits and files reviewed in a collapsed '<details><summary>Review details</summary>' block at the end.
- Look for an existing comment carrying '${COMMENT_MARKER}' via 'gh pr view ${pr} --json comments'. If one exists, update it in place with 'gh api -X PATCH repos/{owner}/{repo}/issues/comments/<id> -f body=@<file>'; otherwise create it with 'gh pr comment ${pr} --body-file <file>'. Never post a second comment carrying the marker.
- At most 10 findings in the comment; if more survived verification, the worst 10 plus a count of the rest.
- Plain, specific, courteous wording. No praise padding, and no model or vendor attribution beyond the heading.`;
}

function reviewPrompt(target: string): string {
	const named = target === "" ? "No target was given: review the pending work." : `The target, as given: ${target}`;
	const pr = pullRequestNumber(target);
	return `Review code changes for real defects. ${named}

${doctrine()}

Then show me the review here in chat: findings grouped by severity, each as file:line, the claim, and the failure scenario in a sentence — plus the standing findings you re-verified and anything you marked fixed. I must be able to act on your message without opening the record (it lives in this project's review store, outside the repo).${pr === undefined ? "" : postingInstructions(pr)}`;
}

export default function reviewExtension(smolt: ExtensionAPI): void {
	const store = new ReviewStore(reviewRoot());

	smolt.registerTool({
		name: "review",
		label: "Review",
		description:
			"Record and consult code reviews: verified findings stored in this project's review store, outside " +
			"the repo, one review per resolved target.\n\n" +
			"ACTIONS: 'list' all reviews; 'start' (target, target_key, title?) opens a review record and " +
			"returns the standing findings from earlier reviews of the same target — the ratchet; 'view' " +
			"one review (omit 'review' for the latest); 'view_finding' (finding, review?) for a finding's " +
			"full body; 'add_finding' (title, file, line?, severity, category, confidence, claim, " +
			"failure_scenario, evidence, suggested_fix?) records a VERIFIED finding — it is rejected " +
			"without a concrete failure scenario, and bounces when an earlier review of the target holds " +
			"the same problem open; 'update_finding' (finding, status open/fixed/wont-fix/stale, review?) — " +
			"mark standing findings 'fixed' when the code shows them gone; 'complete' (summary, review?) " +
			"closes the review.\n\n" +
			"WHEN: driving a /review lap, when the user asks what past reviews found, or when fixing " +
			"findings — mark them 'fixed' as they are dealt with.",
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("list"),
					Type.Literal("start"),
					Type.Literal("view"),
					Type.Literal("view_finding"),
					Type.Literal("add_finding"),
					Type.Literal("update_finding"),
					Type.Literal("complete"),
				],
				{ description: "Operation to perform" },
			),
			review: Type.Optional(Type.String({ description: "Review slug. Omit to mean the latest review." })),
			finding: Type.Optional(Type.String({ description: "Finding slug (view_finding, update_finding)" })),
			target: Type.Optional(Type.String({ description: "For 'start': the target as the user named it" })),
			target_key: Type.Optional(
				Type.String({
					description:
						"For 'start': normalized identity of what is reviewed — a branch name, 'pr-123', " +
						"'worktree', a range. Reviews sharing a key ratchet against each other.",
				}),
			),
			title: Type.Optional(Type.String({ description: "For 'start': a human-readable review title" })),
			file: Type.Optional(Type.String({ description: "Repo-relative path the finding anchors to" })),
			line: Type.Optional(Type.Number({ description: "1-indexed line, when one line pins the finding down" })),
			severity: Type.Optional(Type.String({ description: `One of: ${FINDING_SEVERITIES.join(", ")}` })),
			category: Type.Optional(Type.String({ description: `One of: ${FINDING_CATEGORIES.join(", ")}` })),
			confidence: Type.Optional(Type.String({ description: `One of: ${FINDING_CONFIDENCES.join(", ")}` })),
			claim: Type.Optional(Type.String({ description: "The defect, stated as a claim about behavior" })),
			failure_scenario: Type.Optional(
				Type.String({
					description: "Concrete inputs or state that produce the wrong outcome. Required for add_finding.",
				}),
			),
			evidence: Type.Optional(
				Type.String({ description: "What in the code supports the claim. Required for add_finding." }),
			),
			suggested_fix: Type.Optional(Type.String({ description: "How to fix it, when the fix is clear" })),
			status: Type.Optional(Type.String({ description: `New finding status: ${FINDING_STATUSES.join(", ")}` })),
			summary: Type.Optional(Type.String({ description: "For 'complete': what was reviewed and found" })),
			force: Type.Optional(
				Type.Boolean({
					description:
						"For 'add_finding': record even though a standing finding matches — only when this is " +
						"genuinely a different problem",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const result = reviewTool(store, params);
			return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
		},
	});

	smolt.registerCommand("review", {
		description: "Review code changes: /review (pending work), /review <PR|branch|range|path>",
		handler: async (args) => {
			smolt.sendUserMessage(reviewPrompt(args.trim()));
		},
	});
}
