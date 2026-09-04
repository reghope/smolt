import * as fs from "node:fs";
import type { Api, Model } from "@smolt/ai";
import { Type } from "typebox";
// Type-only import: a standalone install of this module outside the smolt
// tree switches this single line to `from "smolt"`.
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { projectStore } from "../../core/project-store.ts";
import { openBrowser } from "../../utils/open-browser.ts";
import { spawnChildSession } from "../battletest/spawn.ts";
import {
	DEFAULT_MAX_FINDINGS,
	loadReviewSettings,
	type ReviewSettings,
	reviewSettingsFile,
	saveReviewSettings,
} from "./config.ts";
import { ACCESS_URL, awaitApproval, clearToken, connectedAccount, requestDeviceCode } from "./github-login.ts";
import {
	FINDING_CATEGORIES,
	FINDING_CONFIDENCES,
	FINDING_SEVERITIES,
	FINDING_STATUSES,
	type ReviewFinding,
	ReviewStore,
	reviewTool,
} from "./store.ts";
import { adminRepos, currentRepo, forwardingAvailable, isAdmin, watchAll } from "./watch.ts";

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

/**
 * The picker entry that leads to GitHub's own access page.
 *
 * The commonest thing to go wrong in setup is a repo that is simply not in the
 * list, and the fix is never in smolt: it is granting the app access to that
 * organisation, on a page nobody remembers the address of. Offering it here
 * turns a dead end into one more click.
 */
const MANAGE_ACCESS = "Add or change repo access on GitHub…";

/**
 * What the hidden fixing session is told.
 *
 * It is a child session: it has never seen the review, cannot call the review
 * tool, and knows only what is written here — so each finding travels whole,
 * with the failure scenario that justifies it and the fix if one was named.
 */
function fixBrief(findings: ReviewFinding[]): string {
	const items = findings
		.map((finding, index) => {
			const where = finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`;
			return (
				`${index + 1}. [${finding.severity}] ${where} — ${finding.title}\n` +
				`   Claim: ${finding.claim}\n` +
				`   Failure scenario: ${finding.failureScenario}\n` +
				(finding.suggestedFix ? `   Suggested fix: ${finding.suggestedFix}\n` : "")
			);
		})
		.join("\n");
	return `A code review of this repository recorded the findings below. Fix them in the working tree.

${items}
HOW TO WORK
- Read the code around each finding before changing it; the finding names a file and usually a line.
- Fix the cause, not the symptom, and keep each fix as small as the problem.
- Follow the conventions of the code you are editing.
- If a finding turns out to be wrong, or the fix would need a decision that is not yours to make, leave the code alone and say so.
- Do NOT commit, push, or run any git command that changes the working tree or history. Other work may be in progress in these files.
- Do not touch anything the findings do not cover.

Finish with a short report: what you changed, file by file, and what you left alone and why.`;
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

/**
 * Reviewing a pull request in a repo that is not the one open here.
 *
 * The diff alone is not enough to judge a change, so rather than review it
 * blind, clone the repo somewhere temporary and read the code around it. The
 * clone is the price of reviewing a repo you do not happen to have open.
 */
function elsewhereInstructions(repo: string, pr: string): string {
	return `

This pull request is on ${repo}, which is NOT the repository open in this session. Before reviewing it: clone ${repo} into a temporary directory ('gh repo clone ${repo} <tmp> -- --filter=blob:none'), fetch the pull request there ('git -C <tmp> fetch origin pull/${pr}/head'), and do the whole review inside that clone so you can read the code around the diff. Delete the clone when you are done. Never touch the working tree of the repository open here.`;
}

function reviewPrompt(target: string, settings: ReviewSettings, elsewhere?: string): string {
	const named = target === "" ? "No target was given: review the pending work." : `The target, as given: ${target}`;
	const pr = pullRequestNumber(target);
	const max = settings.maxFindings ?? DEFAULT_MAX_FINDINGS;
	return `Review code changes for real defects. ${named}

${doctrine()}

Then show me the review here in chat: findings grouped by severity, each as file:line, the claim, and the failure scenario in a sentence — plus the standing findings you re-verified and anything you marked fixed. I must be able to act on your message without opening the record (it lives in this project's review store, outside the repo).${elsewhere !== undefined && pr !== undefined ? elsewhereInstructions(elsewhere, pr) : ""}${pr === undefined ? "" : postingInstructions(pr, max)}`;
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
			"watched; 'configure' (model?, watchRepos?, watch?, autoFix?) changes it and starts or stops watching " +
			"immediately. autoFix is off unless the user asks for it: with it on, a finished review hands its " +
			"findings to a hidden background session that fixes them in the working tree.\n\n" +
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
			watchRepos: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"For 'configure': repos as 'owner/name' that may be watched. Watching also needs 'watch' on. " +
						"smolt runs. Needs admin on each. Pass [] to stop watching.",
				}),
			),
			watch: Type.Optional(
				Type.Boolean({
					description:
						"For 'configure': whether pull requests on the watched repos are reviewed as they arrive " +
						"while smolt runs. Off by default.",
				}),
			),
			autoFix: Type.Optional(
				Type.Boolean({
					description:
						"For 'configure': whether a finished review hands its findings to a hidden session that fixes " +
						"them in the working tree. Off by default; turn it on only when the user asks.",
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
					if (Array.isArray(params.watchRepos)) update.watchRepos = params.watchRepos;
					if (typeof params.watch === "boolean") update.watch = params.watch;
					if (typeof params.autoFix === "boolean") update.autoFix = params.autoFix;
					saveReviewSettings(update);
				}
				const settings = loadReviewSettings(process.cwd());
				// Only 'configure' restarts the watchers. Restarting them to answer a
				// question about them drops the forwarder's connection, and a pull
				// request opened during the gap is delivered to a process that has gone.
				const watching =
					params.action === "configure" && sessionCtx ? beginWatching(sessionCtx) : describeWatching(settings);
				return reply({
					githubAccount: (await connectedAccount()) ?? "not connected — tell the user to run /review setup",
					model: settings.model ?? "the session's own model",
					watchRepos: settings.watchRepos ?? [],
					watch: settings.watch === true,
					maxFindings: settings.maxFindings ?? DEFAULT_MAX_FINDINGS,
					autoFix: settings.autoFix === true,
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
	// hands it straight back when the run settles, so choosing a cheap reviewer
	// never leaves the reader's chat on the wrong model. Not on turn_end: that
	// fires after every assistant message, so restoring there handed the model
	// back after the review's first reply and left the rest of the review — the
	// reading, the verifying, the posting — on the model it was meant to avoid.
	let restoreModel: Model<Api> | undefined;
	// A pull request arriving mid-thought must not seize the session, so a
	// review waits for the run to settle and goes one at a time. turn_end is not
	// that moment either: the agent run is still active there, so a user message
	// sent from it is refused outright ("Agent is already processing") and the
	// review is lost without a word. agent_settled is the first moment the
	// session is genuinely free.
	const pending: { number: number; repo: string }[] = [];
	// The target of the review the session is running, so auto-fix knows one
	// just finished and which record holds its findings.
	let reviewing: number | undefined;

	/**
	 * Switch to the configured review model, remembering what to hand back.
	 * Returns what to tell the reader when the model they chose is not there.
	 */
	const useReviewModel = async (
		settings: ReviewSettings,
		ctx: ExtensionContext | undefined,
	): Promise<string | undefined> => {
		const selector = settings.model ?? "";
		const slash = selector.indexOf("/");
		if (slash <= 0) return undefined;
		const current = ctx?.model;
		const wanted = ctx?.modelRegistry.find(selector.slice(0, slash), selector.slice(slash + 1));
		if (wanted === undefined)
			return `The review model ${selector} is not available; reviewing with the session's model.`;
		if (current && wanted.id === current.id && wanted.provider === current.provider) return undefined;
		if (await smolt.setModel(wanted)) restoreModel = current;
		return undefined;
	};

	const drain = async (): Promise<void> => {
		const next = pending.shift();
		if (next === undefined) return;
		const settings = loadReviewSettings(process.cwd());
		// Only say "this is elsewhere" when it really is: a pull request on the
		// repo open here is reviewed in place, with no clone.
		const here = currentRepo();
		const warning = await useReviewModel(settings, sessionCtx);
		if (warning !== undefined) sessionCtx?.ui.notify(warning, "warning");
		reviewing = Date.now();
		// followUp rather than an unqualified send: anything still in flight makes
		// the session queue this behind it instead of refusing it.
		smolt.sendUserMessage(reviewPrompt(String(next.number), settings, next.repo === here ? undefined : next.repo), {
			deliverAs: "followUp",
		});
	};

	smolt.on("agent_settled", async (_event, ctx) => {
		// Every event carries the live context, and the captured one goes stale the
		// moment the session is replaced or reloaded — after which using it throws.
		// The watcher reaches for this context minutes or hours after session_start,
		// so it is refreshed here rather than only in the command handler.
		sessionCtx = ctx;
		const previous = restoreModel;
		restoreModel = undefined;
		if (previous) await smolt.setModel(previous);
		const startedAt = reviewing;
		reviewing = undefined;
		// Not awaited: the fixer is a background chat, and agent_settled is awaited
		// before the session counts as settled, so waiting here kept the session
		// visibly busy for the whole fix and held a headless run open.
		if (startedAt !== undefined) void autoFix(startedAt);
		await drain();
	});

	// Kept so the tool can start watching the moment it is configured, rather
	// than making the reader restart to get what they just asked for.
	// Restartable, so choosing repos in setup or settings takes effect at once
	// rather than at the next launch.
	/** What watching is doing right now, said without disturbing it. */
	const describeWatching = (settings: ReviewSettings): string => {
		const repos = settings.watchRepos ?? [];
		if (settings.watch !== true) return "off";
		if (repos.length === 0) return "not watching anything";
		if (stopWatching === undefined) return `configured to watch ${repos.join(", ")}, not started yet`;
		return `watching ${repos.join(", ")}`;
	};

	/**
	 * Hand a finished review's findings to a session that fixes them.
	 *
	 * It runs as a background child session, in memory and never written to
	 * disk, so the reader's chat is not taken over by a stream of edits they did
	 * not ask to watch: the review lands in chat, the fixing happens out of
	 * sight, and a notice says what came of it. Off unless asked for — a review
	 * that edits code on its own is a bigger promise than one that reports.
	 */
	const autoFix = async (startedAt: number): Promise<void> => {
		if (loadReviewSettings(process.cwd()).autoFix !== true) return;
		const ctx = sessionCtx;
		if (ctx === undefined) return;
		// The record the session just opened: the newest one, and only if this run
		// is what created it. A review that recorded nothing leaves nothing to fix.
		const review = store.listReviews().pop();
		if (review === undefined || Date.parse(review.created) < startedAt) return;
		const open = store.listFindings(review.slug).filter((finding) => finding.status === "open");
		if (open.length === 0) return;
		ctx.ui.notify(
			`Auto-fix: working through ${open.length} finding${open.length === 1 ? "" : "s"} from ${review.slug} in a hidden chat. ` +
				'Set "showHiddenChats": true in settings.json to read it afterwards.',
			"info",
		);
		try {
			await spawnChildSession(
				{ task: fixBrief(open), customTools: [], ctx, defaultThinkingLevel: "medium", hidden: true },
				(status, detail) =>
					ctx.ui.notify(
						status === "completed" ? `Auto-fix finished: ${detail}` : `Auto-fix failed: ${detail}`,
						status === "completed" ? "info" : "warning",
					),
			);
		} catch (error) {
			ctx.ui.notify(`Auto-fix could not start: ${error instanceof Error ? error.message : error}`, "warning");
		}
	};

	const beginWatching = (ctx: ExtensionContext): string => {
		stopWatching?.();
		stopWatching = undefined;
		ctx.ui.setStatus("review-watch", undefined);
		const settings = loadReviewSettings(process.cwd());
		const repos = settings.watchRepos ?? [];
		if (settings.watch !== true) return "off";
		if (repos.length === 0) return "not watching anything";
		if (!forwardingAvailable()) return "needs: gh extension install cli/gh-webhook";
		// These run inside the forwarder's stdout listener, where a throw is an
		// uncaught exception that takes the session with it. They speak through
		// whichever context is current rather than the one captured here, because
		// this one is stale as soon as the session is replaced or reloaded.
		const say = (message: string, kind: "info" | "warning"): void => {
			try {
				sessionCtx?.ui.notify(message, kind);
			} catch {
				// a context that has outlived its session says nothing; the review still runs
			}
		};
		stopWatching = watchAll(repos, {
			review: (event) => {
				say(`Reviewing ${event.repo} #${event.number}: ${event.title}`, "info");
				pending.push({ number: event.number, repo: event.repo });
				void drain().catch(() => undefined);
			},
			notice: (message, kind) => say(message, kind),
		});
		const label = repos.length === 1 ? repos[0] : `${repos.length} repos`;
		ctx.ui.setStatus("review-watch", `watching ${label}`);
		return `watching ${repos.join(", ")}`;
	};

	// The settings file is watched so the toggle in the desktop settings page
	// takes effect at once. That page writes review.json from the RPC process
	// and has no way to reach into this extension, so without this a reader who
	// turned watching on would see nothing happen until the next launch.
	let stopSettingsWatch: (() => void) | undefined;
	const followSettings = (ctx: ExtensionContext): void => {
		let last =
			JSON.stringify(loadReviewSettings(process.cwd()).watchRepos ?? []) + loadReviewSettings(process.cwd()).watch;
		try {
			const watcher = fs.watch(reviewSettingsFile(), () => {
				const settings = loadReviewSettings(process.cwd());
				const next = JSON.stringify(settings.watchRepos ?? []) + settings.watch;
				if (next === last) return;
				last = next;
				beginWatching(ctx);
			});
			stopSettingsWatch = () => watcher.close();
		} catch {
			// no settings file yet: nothing to follow, and setup restarts watching itself
		}
	};

	smolt.on("session_start", async (_event, ctx) => {
		sessionCtx = ctx;
		beginWatching(ctx);
		followSettings(ctx);
	});

	smolt.on("session_shutdown", async () => {
		stopWatching?.();
		stopWatching = undefined;
		stopSettingsWatch?.();
		stopSettingsWatch = undefined;
	});

	smolt.registerCommand("review", {
		description:
			"Review code changes: /review (pending work), /review <PR|branch|range|path>, /review setup, /review autofix",
		getArgumentCompletions: (argumentPrefix) => {
			const items = [
				{
					value: "setup",
					label: "setup",
					description: "Connect GitHub, choose the review model and how reviews are posted",
				},
				{ value: "logout", label: "logout", description: "Disconnect the GitHub account reviews are posted from" },
				{
					value: "autofix",
					label: "autofix",
					description: "Fix what a review finds, in a hidden chat: toggle | on | off | status",
				},
			];
			const prefix = argumentPrefix.trim().toLowerCase();
			return items.filter((item) => item.value.startsWith(prefix));
		},
		handler: async (args, ctx) => {
			// The command's ctx is the live one. The captured session ctx goes stale
			// whenever the session is replaced or reloaded, and using a stale ctx
			// throws — which killed a whole run when a review was asked for right
			// after a replacement. Refreshing here keeps the watcher's later use of
			// it (notices, auto-fix) pointed at the session that actually exists.
			sessionCtx = ctx;
			const trimmed = args.trim();

			// Auto-fix is off until it is asked for, and this is where it is asked
			// for: editing review.json by hand is not a setting anyone finds, and
			// the question inside setup is answered once and then buried.
			if (trimmed.toLowerCase().startsWith("autofix")) {
				const current = loadReviewSettings(process.cwd()).autoFix === true;
				const word = trimmed.slice("autofix".length).trim().toLowerCase();
				if (word === "status") {
					ctx.ui.notify(`Auto-fix is ${current ? "on" : "off"}.`, "info");
					return;
				}
				if (word !== "" && word !== "on" && word !== "off" && word !== "toggle") {
					ctx.ui.notify(`Say '/review autofix' with nothing, or on, off, or status — not '${word}'.`, "warning");
					return;
				}
				const next = word === "on" ? true : word === "off" ? false : !current;
				saveReviewSettings({ autoFix: next });
				ctx.ui.notify(
					next
						? "Auto-fix is on: when a review records findings, a hidden chat fixes them in your working tree and reports back. It never commits or pushes."
						: "Auto-fix is off: reviews report their findings and change nothing.",
					"info",
				);
				return;
			}

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
							const prompt = await requestDeviceCode();
							// GitHub cannot prefill the code, so open the page and put the
							// code in a dialog. Polling runs alongside rather than before:
							// awaiting it first would block the command for as long as the
							// reader takes, leaving them at a page asking for a code that
							// was never drawn.
							openBrowser(prompt.verificationUri);
							ctx.ui.setStatus("review-login", `GitHub code ${prompt.userCode}`);
							const cancel = new AbortController();
							// Settled rather than thrown: nothing awaits this promise while the
							// dialog is up, and a rejection with no handler in the meantime — the
							// reader denies the code, or leaves it until it expires — is an
							// unhandled rejection, which Node raises as an uncaught exception and
							// smolt exits on.
							const approval = awaitApproval(prompt, cancel.signal).then(
								(login) => ({ login }) as const,
								(error: unknown) => ({ error }) as const,
							);
							const approved = await ctx.ui.confirm(
								`GitHub code: ${prompt.userCode}`,
								`Enter ${prompt.userCode} at ${prompt.verificationUri} to connect GitHub. The browser should have opened there already. Press OK once you have approved it.`,
							);
							// Cancelling stops the polling instead of leaving it to run for the
							// fifteen minutes the code lives.
							if (!approved) cancel.abort();
							const outcome = await approval;
							ctx.ui.setStatus("review-login", undefined);
							if ("error" in outcome) {
								const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
								ctx.ui.notify(
									approved ? `GitHub login failed: ${message}` : "GitHub login cancelled.",
									approved ? "error" : "info",
								);
							} else {
								ctx.ui.notify(`Connected to GitHub as ${outcome.login}.`, "info");
							}
						} catch (error) {
							ctx.ui.setStatus("review-login", undefined);
							ctx.ui.notify(`GitHub login failed: ${error instanceof Error ? error.message : error}`, "error");
						}
					}
				}
				// No model question: reviews follow the chat model unless the reader
				// changes it in settings. Asking here made setup longer without
				// telling anyone anything they did not already have a default for.
				if (!forwardingAvailable()) {
					ctx.ui.notify(
						"Reviewing pull requests as they arrive needs the webhook extension: gh extension install cli/gh-webhook",
						"info",
					);
					return;
				}
				// Only repos GitHub will accept a webhook on are offered, so nobody
				// picks one that then silently never works. The repo open here sorts
				// first, since it is what the reader is almost always after.
				// Asked before the repo list, but written after it: cancelling the picker
				// says nothing changed, and nothing may change.
				const autoFixAnswer = await ctx.ui.confirm(
					"Fix what a review finds?",
					"Off by default. With it on, a finished review hands its findings to a hidden background session that fixes them in your working tree and reports what it changed. It never commits or pushes.",
				);
				const here = currentRepo();
				const candidates = adminRepos().sort((a, b) => (a === here ? -1 : b === here ? 1 : 0));
				if (candidates.length === 0) {
					ctx.ui.notify(
						"You are not an admin of any repo GitHub will let smolt watch, so pull requests need /review <number>.",
						"info",
					);
					return;
				}
				let chosen: string[] | undefined;
				let offered = candidates;
				for (;;) {
					const picked = await ctx.ui.multiselect(
						"Which repos should smolt review pull requests on?",
						[...offered, MANAGE_ACCESS],
						settings.watchRepos ?? [],
					);
					if (picked === undefined) break;
					if (!picked.includes(MANAGE_ACCESS)) {
						chosen = picked;
						break;
					}
					// Access changed on GitHub, so the list is asked for again rather
					// than reused: the whole point was that it was missing something.
					openBrowser(ACCESS_URL);
					await ctx.ui.confirm(
						"Change repo access on GitHub",
						"Grant or revoke smolt's access to your repositories and organisations in the browser, then press OK to pick from the updated list.",
					);
					offered = adminRepos().sort((a, b) => (a === here ? -1 : b === here ? 1 : 0));
				}
				if (chosen === undefined) {
					ctx.ui.notify("Setup cancelled — nothing changed.", "info");
					return;
				}
				saveReviewSettings({ watchRepos: chosen, watch: chosen.length > 0, autoFix: autoFixAnswer });
				const state = sessionCtx ? beginWatching(sessionCtx) : "not watching yet";
				ctx.ui.notify(
					`Reviews run on ${settings.model ?? "the chat model"}, post to the pull request, and list at most ` +
						`${settings.maxFindings ?? DEFAULT_MAX_FINDINGS} findings. Now ${state}. ` +
						"Commenting '@smolt review' on a pull request asks for one by hand. " +
						"A pull request on a repo you do not have open here is cloned to a temporary folder, so its review still reads the code around the diff.",
					"info",
				);
				return;
			}

			const settings = loadReviewSettings(process.cwd());
			const warning = await useReviewModel(settings, ctx);
			if (warning !== undefined) ctx.ui.notify(warning, "warning");
			reviewing = Date.now();
			smolt.sendUserMessage(reviewPrompt(trimmed, settings), { deliverAs: "followUp" });
		},
	});
}
