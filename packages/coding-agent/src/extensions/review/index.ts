import type { Api, Model } from "@smolt/ai";
import { Type } from "typebox";
// Type-only import: a standalone install of this module outside the smolt
// tree switches this single line to `from "smolt"`.
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { projectStore } from "../../core/project-store.ts";
import { openBrowser } from "../../utils/open-browser.ts";
import { DEFAULT_MAX_FINDINGS, loadReviewSettings, type ReviewSettings, saveReviewSettings } from "./config.ts";
import { clearToken, connectedAccount, logIn } from "./github-login.ts";
import {
	FINDING_CATEGORIES,
	FINDING_CONFIDENCES,
	FINDING_SEVERITIES,
	FINDING_STATUSES,
	ReviewStore,
	reviewTool,
} from "./store.ts";
import { currentRepo, forwardingAvailable, isAdmin, startWatching } from "./watch.ts";

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
function postingInstructions(pr: string, maxFindings: number): string {
	return `

Then POST the review to pull request #${pr} as ONE comment, using gh on this machine:
- Write the body to a file. It opens with the exact marker line '${COMMENT_MARKER}', a blank line, then the branded heading:
  ${COMMENT_HEADING}
  Then the findings grouped by severity as '- **file:line** claim — failure scenario', then one summary line. With zero findings the body says the diff was reviewed and nothing worth flagging was found. Put the commits and files reviewed in a collapsed '<details><summary>Review details</summary>' block at the end.
- Look for an existing comment carrying '${COMMENT_MARKER}' via 'gh pr view ${pr} --json comments'. If one exists, update it in place with 'gh api -X PATCH repos/{owner}/{repo}/issues/comments/<id> -f body=@<file>'; otherwise create it with 'gh pr comment ${pr} --body-file <file>'. Never post a second comment carrying the marker.
- At most ${maxFindings} findings in the comment; if more survived verification, the worst ${maxFindings} plus a count of the rest.
- Plain, specific, courteous wording. No praise padding, and no model or vendor attribution beyond the heading.`;
}

function reviewPrompt(target: string, settings: ReviewSettings): string {
	const named = target === "" ? "No target was given: review the pending work." : `The target, as given: ${target}`;
	const pr = settings.post === false ? undefined : pullRequestNumber(target);
	const max = settings.maxFindings ?? DEFAULT_MAX_FINDINGS;
	return `Review code changes for real defects. ${named}

${doctrine()}

Then show me the review here in chat: findings grouped by severity, each as file:line, the claim, and the failure scenario in a sentence — plus the standing findings you re-verified and anything you marked fixed. I must be able to act on your message without opening the record (it lives in this project's review store, outside the repo).${pr === undefined ? "" : postingInstructions(pr, max)}`;
}

export default function reviewExtension(smolt: ExtensionAPI): void {
	const store = new ReviewStore(reviewRoot());
	let stopWatching: (() => void) | undefined;
	let sessionCtx: ExtensionContext | undefined;

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
			"SETTINGS: 'settings' reports how reviews are configured here and whether this repo can be " +
			"watched; 'configure' (model?, post?, watch?) changes it and starts or stops watching " +
			"immediately.\n\n" +
			"WHEN: driving a /review lap, when the user asks what past reviews found, or when fixing " +
			"findings — mark them 'fixed' as they are dealt with. Also when the user asks in plain words " +
			"for automatic or CodeRabbit-style reviews on their pull requests: call 'settings' to see " +
			"where things stand, then 'configure' to turn it on, rather than telling them to run a command.",
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
					Type.Literal("settings"),
					Type.Literal("configure"),
				],
				{ description: "Operation to perform" },
			),
			model: Type.Optional(
				Type.String({
					description:
						"For 'configure': 'provider/id' of the model reviews run on, e.g. 'anthropic/claude-sonnet-4'. " +
						"Omit to leave it as it is.",
				}),
			),
			post: Type.Optional(
				Type.Boolean({
					description: "For 'configure': naming a pull request posts the review to it as a comment.",
				}),
			),
			watch: Type.Optional(
				Type.Boolean({
					description:
						"For 'configure': review pull requests on this repo as they arrive, while smolt runs. " +
						"Needs admin on the repo.",
				}),
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
			const reply = (value: unknown) => ({
				content: [{ type: "text" as const, text: JSON.stringify(value) }],
				details: {},
			});
			if (params.action === "settings" || params.action === "configure") {
				const repo = currentRepo();
				if (params.action === "configure") {
					const update: ReviewSettings = {};
					if (typeof params.model === "string") {
						const slash = params.model.indexOf("/");
						const found =
							slash > 0
								? sessionCtx?.modelRegistry.find(params.model.slice(0, slash), params.model.slice(slash + 1))
								: undefined;
						if (found === undefined) return reply({ error: `No such model: ${params.model}` });
						update.model = params.model;
					}
					if (typeof params.post === "boolean") update.post = params.post;
					if (typeof params.watch === "boolean") update.watch = params.watch;
					saveReviewSettings(update);
					if (params.watch === false) {
						stopWatching?.();
						stopWatching = undefined;
					}
				}
				const settings = loadReviewSettings(process.cwd());
				const watching = sessionCtx ? beginWatching(sessionCtx) : "no session yet";
				return reply({
					githubAccount: (await connectedAccount()) ?? "not connected — tell the user to run /review setup",
					model: settings.model ?? "the session's own model",
					postsToPullRequests: settings.post !== false,
					watch: settings.watch === true,
					maxFindings: settings.maxFindings ?? DEFAULT_MAX_FINDINGS,
					repo: repo ?? "not a GitHub repo",
					admin: repo === undefined ? false : isAdmin(repo),
					forwardingInstalled: forwardingAvailable(),
					watching,
				});
			}
			const result = reviewTool(store, params);
			return reply(result);
		},
	});

	// A review that runs on a different model switches the session to it and
	// hands it straight back when the turn settles, so choosing a cheap
	// reviewer never leaves the reader's chat on the wrong model.
	let restoreModel: Model<Api> | undefined;
	// A pull request arriving mid-thought must not seize the session, so a
	// review waits for the reader's turn to finish and goes one at a time.
	let busy = false;
	const pending: number[] = [];

	const drain = (): void => {
		if (busy || pending.length === 0) return;
		const next = pending.shift();
		if (next === undefined) return;
		smolt.sendUserMessage(reviewPrompt(String(next), loadReviewSettings(process.cwd())));
	};

	smolt.on("turn_start", async () => {
		busy = true;
	});
	smolt.on("turn_end", async () => {
		busy = false;
		const previous = restoreModel;
		restoreModel = undefined;
		if (previous) await smolt.setModel(previous);
		drain();
	});

	// Kept so the tool can start watching the moment it is configured, rather
	// than making the reader restart to get what they just asked for.
	const beginWatching = (ctx: ExtensionContext): string => {
		if (stopWatching !== undefined) return "already watching";
		if (loadReviewSettings(process.cwd()).watch !== true) return "watching is off";
		const repo = currentRepo();
		if (repo === undefined) return "this folder is not a GitHub repo";
		if (!forwardingAvailable()) return "needs: gh extension install cli/gh-webhook";
		if (!isAdmin(repo)) return `needs admin on ${repo}`;
		stopWatching = startWatching(repo, {
			review: (event) => {
				ctx.ui.notify(`Reviewing pull request #${event.number}: ${event.title}`, "info");
				pending.push(event.number);
				drain();
			},
			notice: (message, kind) => ctx.ui.notify(message, kind),
		});
		ctx.ui.setStatus("review-watch", `watching ${repo}`);
		return `watching ${repo}`;
	};

	smolt.on("session_start", async (_event, ctx) => {
		sessionCtx = ctx;
		if (loadReviewSettings(process.cwd()).watch !== true) return;
		const repo = currentRepo();
		if (repo === undefined) return;
		if (!forwardingAvailable()) {
			ctx.ui.notify(
				"Reviewing pull requests as they arrive needs the webhook extension: gh extension install cli/gh-webhook",
				"warning",
			);
			return;
		}
		if (!isAdmin(repo)) {
			ctx.ui.notify(`Watching ${repo} needs admin on it, which this account does not have.`, "warning");
			return;
		}
		stopWatching = startWatching(repo, {
			review: (event) => {
				ctx.ui.notify(`Reviewing pull request #${event.number}: ${event.title}`, "info");
				pending.push(event.number);
				drain();
			},
			notice: (message, kind) => ctx.ui.notify(message, kind),
		});
		ctx.ui.setStatus("review-watch", `watching ${repo}`);
	});

	smolt.on("session_shutdown", async () => {
		stopWatching?.();
		stopWatching = undefined;
	});

	smolt.registerCommand("review", {
		description: "Review code changes: /review (pending work), /review <PR|branch|range|path>, /review setup",
		getArgumentCompletions: (argumentPrefix) => {
			const items = [
				{
					value: "setup",
					label: "setup",
					description: "Connect GitHub, choose the review model and how reviews are posted",
				},
				{ value: "logout", label: "logout", description: "Disconnect the GitHub account reviews are posted from" },
			];
			const prefix = argumentPrefix.trim().toLowerCase();
			return items.filter((item) => item.value.startsWith(prefix));
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();

			if (trimmed.toLowerCase() === "logout") {
				clearToken();
				ctx.ui.notify("Disconnected the GitHub account smolt was using for reviews.", "info");
				return;
			}

			if (trimmed.toLowerCase() === "setup") {
				const settings = loadReviewSettings(process.cwd());
				// Connecting an account is the first thing setup does, because every
				// answer after it is about a repo smolt may not be able to see yet.
				const already = await connectedAccount();
				if (already === undefined) {
					const connect = await ctx.ui.confirm(
						"Connect a GitHub account?",
						"Smolt needs GitHub access to read pull request diffs and post reviews as you. It opens a browser and shows you a short code to approve.",
					);
					if (connect) {
						try {
							const login = await logIn((prompt) => {
								// GitHub has no way to prefill the code, so the reader has to
								// type it: open the page for them and keep the code on screen
								// in the status line, since a notification scrolls away while
								// they are still looking at the browser.
								openBrowser(prompt.verificationUri);
								ctx.ui.setStatus("review-login", `GitHub code ${prompt.userCode}`);
								ctx.ui.notify(
									`Enter code ${prompt.userCode} at ${prompt.verificationUri} — the browser should have opened.`,
									"info",
								);
							}, new AbortController().signal);
							ctx.ui.setStatus("review-login", undefined);
							ctx.ui.notify(`Connected to GitHub as ${login}.`, "info");
						} catch (error) {
							ctx.ui.setStatus("review-login", undefined);
							ctx.ui.notify(`GitHub login failed: ${error instanceof Error ? error.message : error}`, "error");
						}
					}
				}
				// Every model is on offer: the review runs here, on this machine,
				// so a subscription login is as usable as an API key.
				const providers = [...new Set(ctx.modelRegistry.getAll().map((model) => model.provider))].sort();
				if (providers.length === 0) {
					ctx.ui.notify("Smolt has no models available. Log in with /login first.", "error");
					return;
				}
				const provider = await ctx.ui.select("Which provider should reviews run on?", providers);
				if (provider === undefined) {
					ctx.ui.notify("Setup cancelled — nothing changed.", "info");
					return;
				}
				const models = ctx.modelRegistry
					.getAll()
					.filter((model) => model.provider === provider)
					.map((model) => model.id)
					.sort();
				const model = await ctx.ui.select(`Which ${provider} model?`, models);
				if (model === undefined) {
					ctx.ui.notify("Setup cancelled — nothing changed.", "info");
					return;
				}
				const post = await ctx.ui.confirm(
					"Post reviews to pull requests?",
					"When you run /review on a pull request, smolt writes the review to it as a comment, from this machine, authored by your GitHub account.",
				);
				// Watching only works where GitHub will accept a webhook, so a repo
				// we cannot watch says so here rather than failing silently later.
				const repo = currentRepo();
				let watch = false;
				if (repo !== undefined && post) {
					if (!isAdmin(repo)) {
						ctx.ui.notify(
							`Reviewing pull requests as they arrive needs admin on ${repo}, which this account does not have. Run /review <number> by hand instead.`,
							"info",
						);
					} else if (!forwardingAvailable()) {
						ctx.ui.notify(
							"Reviewing pull requests as they arrive needs the webhook extension: gh extension install cli/gh-webhook",
							"info",
						);
					} else {
						watch =
							(await ctx.ui.confirm(
								`Review pull requests on ${repo} as they arrive?`,
								"Smolt holds an outbound connection to GitHub while it runs and reviews each pull request as it opens or gets new commits. It adds a webhook to the repo; nothing listens on your machine.",
							)) === true;
					}
				}
				saveReviewSettings({ model: `${provider}/${model}`, post, watch });
				ctx.ui.notify(
					`Reviews will run on ${provider}/${model}, and ${post ? "post to" : "stay out of"} pull requests. ` +
						`${watch ? "New pull requests are reviewed as they arrive, while smolt is open. " : ""}` +
						`At most ${settings.maxFindings ?? DEFAULT_MAX_FINDINGS} findings per comment. Settings live in review.json.`,
					"info",
				);
				return;
			}

			const settings = loadReviewSettings(process.cwd());
			const selector = settings.model ?? "";
			const slash = selector.indexOf("/");
			if (slash > 0) {
				const wanted = ctx.modelRegistry.find(selector.slice(0, slash), selector.slice(slash + 1));
				if (wanted === undefined) {
					ctx.ui.notify(
						`The review model ${selector} is not available; reviewing with the session's model.`,
						"warning",
					);
				} else if (ctx.model && wanted.id === ctx.model.id && wanted.provider === ctx.model.provider) {
					// already on it
				} else if (await smolt.setModel(wanted)) {
					restoreModel = ctx.model;
				}
			}
			smolt.sendUserMessage(reviewPrompt(trimmed, settings));
		},
	});
}
