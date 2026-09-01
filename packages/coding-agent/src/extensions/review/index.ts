import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
// Type-only import: a standalone install of this module outside the smolt
// tree switches this single line to `from "smolt"`.
import type { ExtensionAPI } from "../../core/extensions/types.ts";
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
 * `/review setup` wires the current GitHub repo so every PR gets the same
 * review automatically: it writes a GitHub Actions workflow that runs smolt
 * headless (`smolt -p`) on pull_request events and posts one consolidated,
 * self-updating review comment. One manual step remains for the user —
 * adding the model credential as a repo secret — and the command says so.
 */

function reviewRoot(): string {
	return join(process.cwd(), ".smolt", "review");
}

const WORKFLOW_PATH = join(".github", "workflows", "smolt-review.yml");

/** The marker the CI comment carries so re-runs update it instead of stacking. */
const COMMENT_MARKER = "<!-- smolt-review -->";

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

function reviewPrompt(target: string): string {
	const named = target === "" ? "No target was given: review the pending work." : `The target, as given: ${target}`;
	return `Review code changes for real defects. ${named}

${doctrine()}

Then show me the review here in chat: findings grouped by severity, each as file:line, the claim, and the failure scenario in a sentence — plus the standing findings you re-verified and anything you marked fixed. I must be able to act on your message without opening the record (it lives under .smolt/review/).`;
}

/** The prompt the CI workflow feeds to headless smolt. Kept as one line per gh constraint-free quoting. */
function ciPrompt(): string {
	return `You are reviewing pull request #\${PR_NUMBER} in CI. ${doctrine()}

Then POST the review to the pull request as ONE comment:
- Build the comment body: start it with the exact marker line '${COMMENT_MARKER}', then '## Smolt review', then findings grouped by severity as '- **file:line** claim — failure scenario', then one summary line. If there are zero findings, the body says the diff was reviewed and nothing worth flagging was found.
- Look for an existing comment containing '${COMMENT_MARKER}' via 'gh api repos/\${GITHUB_REPOSITORY}/issues/\${PR_NUMBER}/comments'. If one exists, update it with 'gh api -X PATCH repos/\${GITHUB_REPOSITORY}/issues/comments/<id> -f body=@<file>'; otherwise create it with 'gh pr comment \${PR_NUMBER} --body-file <file>'. Never post a second marker comment.
- At most 10 findings in the comment; if more survived verification, the worst 10 plus a count of the rest.
- Plain, specific, courteous wording. No praise padding, no tool or model attribution beyond the heading.`;
}

/** The env-var name a provider's API key is conventionally read from. */
function providerSecretName(provider: string): string {
	const known: Record<string, string> = {
		anthropic: "ANTHROPIC_API_KEY",
		openai: "OPENAI_API_KEY",
		google: "GEMINI_API_KEY",
		groq: "GROQ_API_KEY",
		openrouter: "OPENROUTER_API_KEY",
		xai: "XAI_API_KEY",
		mistral: "MISTRAL_API_KEY",
	};
	return known[provider] ?? `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

/** The GitHub Actions workflow `/review setup` writes, pinned to the chosen model. */
function workflowYaml(choice: { provider: string; model: string; secret: string }): string {
	return `# Written by smolt's /review setup. Re-running the command updates it;
# /review setup --remove deletes it.
name: Smolt review

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

concurrency:
  group: smolt-review-\${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  review:
    if: \${{ !github.event.pull_request.draft }}
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Install smolt
        run: npm install -g smolt
      - name: Review the pull request
        env:
          GH_TOKEN: \${{ github.token }}
          PR_NUMBER: \${{ github.event.pull_request.number }}
          # The credential for the chosen provider, from a repository secret.
          ${choice.secret}: \${{ secrets.${choice.secret} }}
          # The model /review setup was told to use; repo variables override.
          SMOLT_PROVIDER: \${{ vars.SMOLT_PROVIDER || '${choice.provider}' }}
          SMOLT_MODEL: \${{ vars.SMOLT_MODEL || '${choice.model}' }}
        run: smolt -p "$(node -e "process.stdout.write(require('fs').readFileSync('.github/smolt-review-prompt.md','utf8'))")"
`;
}

const PROMPT_PATH = join(".github", "smolt-review-prompt.md");

function git(args: string[]): string | undefined {
	try {
		return execFileSync("git", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return undefined;
	}
}

export default function reviewExtension(smolt: ExtensionAPI): void {
	const store = new ReviewStore(reviewRoot());

	smolt.registerTool({
		name: "review",
		label: "Review",
		description:
			"Record and consult code reviews: verified findings stored under the project's .smolt/review/ " +
			"directory, one review per resolved target.\n\n" +
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
		description: "Review code changes: /review (pending work), /review <PR|branch|range|path>, /review setup",
		getArgumentCompletions: (argumentPrefix) => {
			const items = [
				{
					value: "setup",
					label: "setup",
					description: "Wire this GitHub repo: every PR gets reviewed automatically",
				},
				{ value: "setup --remove", label: "setup --remove", description: "Remove the automatic PR review" },
			];
			const prefix = argumentPrefix.trim().toLowerCase();
			return items.filter((item) => item.value.startsWith(prefix));
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const [first = ""] = trimmed.split(/\s+/);

			if (first.toLowerCase() === "setup") {
				const remove = /\s--remove\b/.test(trimmed);
				if (git(["rev-parse", "--is-inside-work-tree"]) !== "true") {
					ctx.ui.notify("This folder is not a git repository, so there is nothing to wire up.", "error");
					return;
				}
				const workflowFile = join(process.cwd(), WORKFLOW_PATH);
				const promptFile = join(process.cwd(), PROMPT_PATH);
				if (remove) {
					if (!existsSync(workflowFile)) {
						ctx.ui.notify("Automatic PR review is not set up here — nothing to remove.", "info");
						return;
					}
					rmSync(workflowFile);
					rmSync(promptFile, { force: true });
					ctx.ui.notify(
						"Automatic PR review removed. Commit the deletion and PRs will stop being reviewed.",
						"info",
					);
					return;
				}
				const remote = git(["remote", "get-url", "origin"]) ?? "";
				if (!remote.includes("github.com")) {
					ctx.ui.notify(
						remote === ""
							? "No 'origin' remote found. Add a GitHub remote first, then run /review setup again."
							: `The 'origin' remote (${remote}) is not on github.com — automatic PR review currently supports GitHub only.`,
						"error",
					);
					return;
				}
				// The CI reviewer runs on whatever the user picks here — never a
				// silent default. The session's own provider leads the list.
				const current = ctx.model;
				const providers = [...new Set(ctx.modelRegistry.getAll().map((model) => model.provider))].sort((a, b) =>
					a === current?.provider ? -1 : b === current?.provider ? 1 : a.localeCompare(b),
				);
				if (providers.length === 0) {
					ctx.ui.notify(
						"No providers are configured, so there is no model the PR reviewer could run on.",
						"error",
					);
					return;
				}
				const provider = await ctx.ui.select(
					"Which provider should review PRs?",
					providers.map((name) => (name === current?.provider ? `${name} (current)` : name)),
				);
				if (provider === undefined) {
					ctx.ui.notify("Setup cancelled — nothing was written.", "info");
					return;
				}
				const chosenProvider = provider.replace(/ \(current\)$/, "");
				const models = ctx.modelRegistry
					.getAll()
					.filter((model) => model.provider === chosenProvider)
					.map((model) => model.id)
					.sort((a, b) => (a === current?.id ? -1 : b === current?.id ? 1 : a.localeCompare(b)));
				const model = await ctx.ui.select(
					`Which ${chosenProvider} model?`,
					models.map((id) =>
						id === current?.id && chosenProvider === current?.provider ? `${id} (current)` : id,
					),
				);
				if (model === undefined) {
					ctx.ui.notify("Setup cancelled — nothing was written.", "info");
					return;
				}
				const choice = {
					provider: chosenProvider,
					model: model.replace(/ \(current\)$/, ""),
					secret: providerSecretName(chosenProvider),
				};
				const existed = existsSync(workflowFile);
				const upToDate =
					existed &&
					readFileSync(workflowFile, "utf-8") === workflowYaml(choice) &&
					existsSync(promptFile) &&
					readFileSync(promptFile, "utf-8") === ciPrompt();
				if (upToDate) {
					ctx.ui.notify(
						`Automatic PR review is already set up for ${choice.provider}/${choice.model}. If PRs are ` +
							`not being reviewed, check that the ${choice.secret} secret is set on the repo.`,
						"info",
					);
					return;
				}
				mkdirSync(join(process.cwd(), ".github", "workflows"), { recursive: true });
				writeFileSync(workflowFile, workflowYaml(choice), "utf-8");
				writeFileSync(promptFile, ciPrompt(), "utf-8");
				ctx.ui.notify(
					`${existed ? "Updated" : "Wrote"} ${WORKFLOW_PATH}: PRs will be reviewed by ${choice.provider}/${choice.model}. Two steps left:\n` +
						`1. Give the workflow its credential: gh secret set ${choice.secret}\n` +
						"2. Commit and push both files.\n" +
						"After that, every opened or updated PR gets one self-updating review comment.",
					"info",
				);
				return;
			}

			smolt.sendUserMessage(reviewPrompt(trimmed));
		},
	});
}
