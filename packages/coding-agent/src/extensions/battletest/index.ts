import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "@smolt/agent-core";
import type { Api, Model } from "@smolt/ai";
import { Type } from "typebox";
import { describeSummary } from "../../core/action-metrics.ts";
// Type-only import: a standalone install of this module outside the smolt
// tree switches this single line to `from "smolt"`.
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../../core/extensions/types.ts";
import { defineTool } from "../../core/extensions/types.ts";
import { type BrowseDriver, type BrowseDriverFactory, defaultBrowseDriverFactory, VIEWPORT_PRESETS } from "./cdp.ts";
import { parseBattletestInvocation, pickAmbiguousModel, resolveModelOverride } from "./parse.ts";
import { describePersona, generatePersonas, generateTeam, type Persona } from "./personas.ts";
import { CHILD_SHELL_TIMEOUT_SECONDS, type ChildDriver, spawnChildSession } from "./spawn.ts";
import {
	type BattleTestRun,
	BattleTestStore,
	type BattleTestTicket,
	battleTestTool,
	type LedgerEntry,
	TICKET_CATEGORIES,
	TICKET_SEVERITIES,
} from "./store.ts";

/**
 * Battletest: a team of simulated users runs the app the way real users
 * would, and everything they notice comes back as tickets and a report.
 *
 * `/battletest <n>` deals n personas — a first-timer, a power user, a chaos
 * monkey, an accessibility advocate, whoever the deck turns up — and spawns
 * each one as its own background agent session. The command also takes plain
 * language: `/battletest 15 subagents using opencode minimax-m3 to test a
 * feature` sets the tester count, runs every tester on that model, and uses
 * the rest as the run's focus. They discover how to launch
 * the app, use it in character, keep a running diary of the experience, and
 * file a ticket for every bug, rough edge, slow moment, and odd bit of
 * wording they hit. Personas are non-deterministic on purpose: archetypes are
 * dealt without replacement so a run covers distinct angles, but the traits
 * on top are rolled fresh every time, the way a real user base is.
 *
 * When the last tester finishes, the parent session synthesizes: duplicates
 * are folded, findings are grouped by severity and theme, and a report lands
 * next to the tickets in `.smolt/battletest/<run>/` — shared through the
 * repo, ready for later sessions to fix from.
 */

/** More testers than this stops being a user base and starts being a DDoS. */
const MAX_TESTERS = 25;

const DEFAULT_TESTERS = 3;

/** Longest a single `wait` blocks before reporting testers still at it. */
const DEFAULT_WAIT_SECONDS = 120;
const MAX_WAIT_SECONDS = 600;

/** Base for per-tester debugging ports, offset by tester index. */
const DEBUG_PORT_BASE = 9333;

/**
 * The newest extension instance in this process. Reloading a session re-runs
 * every extension factory while the old instance's testers may still be
 * running in the background — the new instance reaches the old one through
 * this module slot, so a resume or a stop can drain the leftovers instead of
 * doubling the fleet.
 */
let latestInstance: BattleTestHandle | undefined;

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
}

// ------------------------------------------------------------------
// Tester roster: like subagents' ThreadPool, but scoped to one run and
// keyed by persona — a tester is who they are, not a numbered slot.
// ------------------------------------------------------------------

export type TesterStatus = "testing" | "completed" | "errored" | "stopped";

/** What a running tester can be driven with, once it exists. */
export type TesterDriver = ChildDriver;

export interface Tester {
	persona: Persona;
	status: TesterStatus;
	/** The tester's closing summary of their experience. */
	summary: string;
	error: string;
	/** The full brief this tester ran under, kept for the end-of-run record. */
	task?: string;
	driver?: TesterDriver;
}

/** The action ceiling a tester's thoroughness earns it, as the brief states. */
function budgetFor(thoroughness: Persona["traits"]["thoroughness"]): number {
	return thoroughness === "skims" ? 40 : thoroughness === "exhaustive" ? 110 : 70;
}

/** Severity weighting for the end-of-run score: what a tester's tickets are worth. */
const SEVERITY_POINTS: Record<string, number> = { blocker: 8, major: 4, minor: 2, polish: 1 };

/**
 * Testers run at low thinking by default: the run's own metrics showed the
 * model deliberating for one to two minutes per browse click at the session's
 * thinking level, and thinking time was ~70% of an 80-minute run's wall
 * clock. Persona work is judgment-light; an explicit model/thinking override
 * on the run still wins.
 */
const TESTER_THINKING: ThinkingLevel = "low";

/**
 * Start one tester as a real child agent session.
 *
 * Kept behind an injectable seam so the lifecycle can be tested without a
 * provider: tests supply their own spawner, and the default one below is the
 * only place that touches the SDK.
 */
export type TesterSpawner = (
	options: {
		persona: Persona;
		task: string;
		customTools: ToolDefinition[];
		ctx: ExtensionContext;
		/** Run the tester on this model instead of the session's own. */
		model?: Model<Api>;
		/** Thinking level for the model override, when one was stated. */
		thinkingLevel?: ThinkingLevel;
		/** JSONL file every timed action is appended to as it happens. */
		metricsPath?: string;
	},
	onFinish: (status: "completed" | "errored", detail: string) => void,
) => Promise<TesterDriver>;

/** Testers never wait on a shell call longer than this; the brief says so. */
const TESTER_SHELL_TIMEOUT_SECONDS = CHILD_SHELL_TIMEOUT_SECONDS;

/**
 * The real spawner: one background AgentSession per tester, measured action
 * by action, with `edit` excluded — a tester never patches the app it is
 * judging. Write stays available for scratch driver scripts.
 */
const defaultSpawner: TesterSpawner = (options, onFinish) =>
	spawnChildSession(
		{
			task: options.task,
			customTools: options.customTools,
			ctx: options.ctx,
			model: options.model,
			thinkingLevel: options.thinkingLevel,
			defaultThinkingLevel: TESTER_THINKING,
			metricsPath: options.metricsPath,
			excludeTools: ["edit"],
			shellTimeoutSeconds: TESTER_SHELL_TIMEOUT_SECONDS,
		},
		onFinish,
	);

// ------------------------------------------------------------------
// Prompts
// ------------------------------------------------------------------

/** How the tester's assigned viewport translates into concrete driving. */
function viewportBrief(viewport: Persona["viewport"]): string {
	if (viewport === "mobile") {
		return (
			"You use this app on a phone-sized screen, and your browse tool is already locked to 375x812 with " +
			"touch emulation (setDeviceMetricsOverride is applied for you) — every screenshot you see is the " +
			"phone view. Judge everything at that size: tap-target size, horizontal overflow, text truncation, " +
			"menus that assume a pointer, layouts that only work wide. If something is unusable on mobile, that " +
			"is a finding even if a bigger screen would save it; say in your tickets that you were on mobile."
		);
	}
	if (viewport === "tablet") {
		return (
			"You use this app on a tablet-sized screen; your browse tool is already locked to 768x1024. Watch " +
			"for layouts stuck between the phone and desktop designs: sidebars that half-collapse, grids with " +
			"awkward gaps, controls that assume either more or less space than you have. Note in your tickets " +
			"that you were on a tablet-sized screen."
		);
	}
	return (
		"You use this app on a normal desktop-sized screen (your browse tool starts at 1440x900). At least " +
		"once mid-session, use browse action 'viewport' to narrow to ~500 wide and back — real users resize — " +
		"and note anything that breaks, overflows, or vanishes on the way."
	);
}

/** A hosted target named in the focus, resolved once here so no tester rediscovers it. */
export function extractTargetUrl(focus: string): string | undefined {
	return /(https?:\/\/[^\s"'<>)]+)/.exec(focus)?.[1];
}

/** Action budget per thoroughness — browse-tool actions, one per user action. */
const ACTION_BUDGETS: Record<Persona["traits"]["thoroughness"], number> = {
	skims: 40,
	balanced: 70,
	exhaustive: 110,
};

/**
 * What a resumed tester knows about its own previous session: everything it
 * recorded before the run's host was lost, condensed into its brief.
 */
export interface ResumeBrief {
	/** Actions the tester already spent before the interruption. */
	spent: number;
	/** The tester's diary so far, trimmed to what fits a brief. */
	diary: string;
	/** Tickets the tester already filed, one line each. */
	filed: string[];
}

/** A diary longer than this loses its oldest entries when embedded in a brief. */
const DIARY_LIMIT = 6000;

function trimDiary(raw: string): string {
	const text = raw.trim();
	if (text.length <= DIARY_LIMIT) return text;
	return `(older entries trimmed)\n${text.slice(text.length - DIARY_LIMIT)}`;
}

/** Count the tool spans a previous session already logged for a tester. */
function countSpentActions(path: string): number {
	try {
		let count = 0;
		for (const line of readFileSync(path, "utf-8").split("\n")) {
			if (line.trim() === "") continue;
			try {
				if ((JSON.parse(line) as { kind?: string }).kind === "tool") count++;
			} catch {
				// A torn final line from a killed run — skip it.
			}
		}
		return count;
	} catch {
		return 0;
	}
}

/** A tester's diary, or "" when they never wrote one. */
function readDiary(path: string): string {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return "";
	}
}

/** The insert that turns a fresh mission into a continuation of one. */
function resumeSection(brief: ResumeBrief, profileDir: string): string {
	const filed =
		brief.filed.length === 0 ? "(none so far)" : `\n${brief.filed.map((line) => `  - ${line}`).join("\n")}`;
	return `

RESUMING AN INTERRUPTED SESSION
Your previous session was cut off mid-run — the machine running you restarted — and you are the same tester, continuing the same run. Everything you recorded survived:
- Your diary so far; this is exactly where you left off:
${brief.diary}
- Tickets you already filed (never refile these):${filed}
You already spent about ${brief.spent} browse actions before the interruption; the budget below is what remains. The app instance you were driving is gone: launch it again exactly as this brief says — same ports and profile directory as before, so your scratch data is still yours. If the debug port is busy, a stale app instance from the interrupted session is still holding it; that instance is yours (launched with a --user-data-dir under '${profileDir}'), so kill it and relaunch. First re-establish the state you were in, then continue coverage where your diary stops.`;
}

/** The mission each tester session starts from. It sees nothing else. */
/**
 * The section of a tester brief that carries what past runs already know, so
 * budget goes to fresh territory: the still-open issues (a filing against one
 * bounces into a hit), and the recently-fixed ones worth a verification pass.
 */
function knownIssuesBrief(store: BattleTestStore): string {
	const entries = store.listLedger();
	const open = entries.filter((entry) => entry.status === "open" || entry.status === "regressed");
	const fixed = entries.filter((entry) => entry.status === "fixed");
	if (open.length === 0 && fixed.length === 0) return "";
	const line = (entry: LedgerEntry): string =>
		`- ${entry.title} (${entry.area}${entry.hits.length > 1 ? `, seen ${entry.hits.length}x` : ""})`;
	const openBlock =
		open.length === 0
			? ""
			: `\nPrevious runs already found ${open.length} problem(s) that are still open — the most-hit:\n${open
					.slice(0, 12)
					.map(line)
					.join(
						"\n",
					)}\nIf you hit one of these, filing it costs nothing — the filing bounces and your sighting is recorded as a hit, which is itself useful evidence. But do NOT investigate it: your budget belongs to problems nobody has found.`;
	const fixedBlock =
		fixed.length === 0
			? ""
			: `\n${fixed.length} problem(s) were recently marked fixed:\n${fixed
					.slice(0, 6)
					.map(line)
					.join(
						"\n",
					)}\nIf your path naturally crosses one, verify the fix — a fixed problem that reappears is the most valuable ticket this run can produce.`;
	return `\n\nKNOWN ISSUES — WHAT PAST RUNS ALREADY FOUND${openBlock}${fixedBlock}`;
}

function testerPrompt(
	persona: Persona,
	run: BattleTestRun,
	index: number,
	profileDir: string,
	resume?: ResumeBrief,
	knownIssues = "",
): string {
	const traits = persona.traits;
	const focus =
		run.focus === "" ? "" : `\n\nThe developer asked this run to pay particular attention to: ${run.focus}`;
	const target = extractTargetUrl(run.focus);
	const budget =
		resume === undefined
			? ACTION_BUDGETS[traits.thoroughness]
			: Math.max(15, ACTION_BUDGETS[traits.thoroughness] - resume.spent);
	return `You are ${persona.name}, a real user trying out the app that lives in this repository. You are not a developer on it and you never act like one.

WHO YOU ARE
${persona.description}
You especially notice: ${persona.lens}.
Your patience is ${traits.patience}; you are ${traits.expertise} with software like this; your feedback style is ${traits.temperament}; and you ${traits.thoroughness === "skims" ? "skim, moving fast and covering breadth over depth" : traits.thoroughness === "exhaustive" ? "are exhaustive, working every corner before moving on" : "balance breadth and depth"}. Stay in character for the whole session — your traits should be visible in what you try, how long you persist, and how you phrase what you find.${focus}${resume === undefined ? "" : resumeSection(resume, profileDir)}${knownIssues}

DRIVE THE APP WITH THE browse TOOL
You have a browse tool: your own private browser, already locked to your screen size, on your own port and profile so the other ${run.personas.length - 1} testers never collide with you. ${
		target
			? `Your target is already known: start with browse action 'goto' to ${target} — test the deployed site directly and launch nothing locally.`
			: `First work out what kind of project this is and how its real users run it (README, package scripts, launch configs, docs), then test it with whatever fits — battletest is not just for the web:
- Web app or site: start its server isolated on a port derived from ${3100 + index}, then use your browse tool.
- Desktop/Electron app: launch it yourself with --remote-debugging-port=${DEBUG_PORT_BASE + index} and a --user-data-dir under your profile dir, and drive it over CDP from the shell instead of the browse tool.
- CLI or TUI: skip browse; run the binary in the shell and work through its commands, flags, and prompts the way its user would — first-run experience, help text, error messages, weird arguments.
- Library, API, or SDK: its user is a developer, and today that is you. Follow the README quickstart in a scratch project under your profile dir, try the documented examples exactly as written, and judge the developer experience — install friction, time to first success, how errors read — the way an app tester judges screens.
If the project truly cannot be run or used, file that as a blocker ticket — it is the first thing a real user would hit — and investigate as far as you can.`
	} Keep every scratch file under '${profileDir}'. Do NOT hand-build a browser harness with shell scripts while the browse tool works — that is what it is for; fall back to the shell only if browse itself reports it cannot launch a browser.

YOUR SCREEN
${viewportBrief(persona.viewport)}

SEE IT LIKE A USER
Every browse action returns a screenshot of the page as it looks right now — STUDY each one before your next move; that is you seeing the app. Judge from the pixels: layout, alignment, spacing, contrast, what is cut off, what looks broken, what draws the eye first. A visual claim in a ticket (misaligned, overlapping, truncated, ugly, hidden) must come from an image you actually looked at, and your diary should say what the screen looked like, not what the DOM contained. Use 'eval' only to read state, never as a substitute for looking. When the project has no visual surface (a CLI, a library), your evidence is what it actually printed — quote exact output and error text in tickets the way a visual tester quotes a screenshot.

USE IT LIKE A USER
Go through the app in character: first impressions, navigation, core flows end to end, settings, edge inputs, resizing, cancelling things halfway, errors, and how it feels — speed, responsiveness, wording, visual consistency. Judge it as an experience, not as code. Do not read the source to explain away a problem; if the app confused you, it confused you.
After any action that claims to change state — a save, an add, a remove, a setting — verify the app's own story matches reality: re-open the screen, re-list the items, check the file if the app names one. "It said saved but nothing changed" and "status disagrees with what's on disk" are among the best tickets a run produces.

YOUR COVERAGE PLAN AND BUDGET
You are tester #${index + 1} of ${run.personas.length}. Work in two passes so the whole team covers everything without ten people re-testing the same front page:
1. Breadth first (~15 actions): a quick pass over everything reachable, in character, noting first impressions.
2. Your territory: enumerate the project's top-level areas in their natural order — pages, screens, commands, or API surfaces, whatever this project's map is — and take the ${index + 1}${["st", "nd", "rd"][index] ?? "th"} of ${run.personas.length} roughly equal slices (wrap around if there are fewer areas than testers — then take your area from your persona's angle). Go deep there: every control, every state you can reach safely.
3. If budget remains, revisit whatever bothered you most.
Your budget is about ${budget} browse actions, fitting how ${traits.thoroughness === "skims" ? "quickly you move" : traits.thoroughness === "exhaustive" ? "thorough you are" : "you balance speed and depth"}. Two stop rules, whichever comes first: the budget runs low, or your last ~10 actions taught you nothing new. Then file outstanding tickets, write the closing note, and finish — an on-time report beats an exhaustive late one.

SAY WHAT YOU ARE DOING, IN THE CALL ITSELF
The run's live roster shows what each tester is doing right now, straight from your tool calls — no narration turns into a blank line:
- Every browse call: fill the 'doing' argument with 2-5 present-tense words ("checking the docs button", "trying an empty search").
- Every shell command: start it with a comment line naming the intent, e.g. \`# looking for the launch script\` then the command. Same for powershell.
Keep it honest and specific — it is read by a person watching the run.

RECORD EVERYTHING with the testlog tool as you go:
- action 'note' (area, text): your running diary, written in your own voice — what you tried, what you expected, how it actually went, including what worked well. Note after every meaningful step, not in one dump at the end.
- action 'ticket' (title, severity, category, area, what, expected, steps): one ticket per distinct problem — bugs, UI inconsistencies, awkward UX, performance issues, weird or inconsistent wording, accessibility failures. Severities: blocker (cannot proceed), major (badly hurts the experience), minor (noticeable friction), polish (small but real). Steps must let someone reproduce it without you.
- One problem, one ticket, across the whole team: if your filing comes back with duplicate_of, another tester already has it. STOP investigating that problem — the time is better spent elsewhere. Add anything genuinely new with action 'append' (ticket, text), then move to territory nobody has covered. Refile with force=true only when yours is really a different problem wearing a similar name.

HARD RULES
- Never modify the app's source, config, or data outside your profile directory. You are a user; users cannot edit the code.
- Do not fix, work around, or improve anything — report it.
- File the ticket when you hit the problem, not at the end.
- Never sleep longer than 5 seconds in one call: wait in short polls (sleep 3-5s, check, repeat) so a wait can end the moment the thing is ready. Chain quick related shell commands into one call rather than paying a full round-trip for each.
- Shell calls are stopped after ${TESTER_SHELL_TIMEOUT_SECONDS} seconds unless you pass a timeout. Never wait on the app with one long blocking command (a sleep, a poll, a watch): poll in short calls instead, so the supervisor sees you moving.

SAFETY — JUDGE EVERY ACTION YOURSELF, NEVER ASK
No human watches this run, and it must not stop for permission. Before every action, judge it yourself; if it could plausibly be destructive, irreversible, or have a real-world side effect, do not do it. When you are genuinely unsure whether an action crosses the line, request clearance (testlog action 'clearance': area, text = the exact action, risk = why it might be unsafe) — a supervising agent rules on it, your session pauses until the ruling arrives, and you obey it either way. Do not escalate the outright-forbidden list below; those are always denied. Forbidden outright, no matter what the app offers or asks:
- Buying anything, entering payment details, starting trials or subscriptions.
- Creating accounts on real services, or entering real credentials, emails, or personal data anywhere.
- Sending anything that reaches a real person or service: contact forms, newsletter sign-ups, chat messages, uploads. Filling a form to test its validation is fine, and submitting clearly-invalid data to see the error is fine — never submit valid data that would actually create, send, or order something.
- Deleting, wiping, or corrupting anything that is not yours inside your own profile directory: no destructive shell commands, no dropping or clearing databases, no deleting user data, files, or settings the app manages — even where the app's own UI offers it. Test that a delete flow exists and is discoverable; stop at its confirmation step and note what it says.
A checkout you never place, a delete dialog you never confirm, a form you never submit — walking up to the edge and recording what you saw there IS the test.

When you have covered the app as your persona would, file any remaining tickets, write one final 'note' (area 'overall') with your closing impressions, then finish. Your final reply is read by another agent: two or three sentences on the overall experience in character, plus how many tickets you filed and the worst thing you found.`;
}

/** `/battletest` with no count: the supervising agent picks the team first. */
function teamPlanPrompt(focus: string, modelRef?: string): string {
	return `Plan a battletest team, then start the run.

1. Scout the project for a minute — README, structure, what kind of app this is${focus !== "" ? `. The requested focus: ${focus}` : ""}. A look, not a study.
1b. PREFLIGHT the target before anyone is dispatched. If the testers will run a built artifact (a dist/, a bundle, a packaged app), confirm the build is CURRENT — newest source mtime vs newest build mtime, or a version probe. A stale build once burned a third of a fleet on "missing" features that were simply unbuilt, including the run's only blocker ticket. Rebuild first, then dispatch.
1c. Ask: can a FIXTURE exercise the core behavior under test? Features gated on real external state (credentials, paid accounts, live services) often have a test seam in the codebase already — a faux provider, a mock transport, a scripted error. Wiring one up turns "untestable, covered by unit tests only" into the run's main event. If a fixture exists or is cheap, name it in the focus so the testers use it.
2. Decide the team, at most 3 testers. Default to just the balanced generalist — battletest action 'start' with specialists: [] — one thorough tester covering everything is enough for most projects. Before adding anyone, ask whether the generalist already handles it: viewports (desktop vs mobile vs tablet), walking every screen, ordinary error paths, and general wording/consistency are all inside one generalist's pass — none of those justify a second tester. A specialist earns a seat only for a concentrated domain that rewards sustained expert attention the generalist cannot spare: security posture and hostile input, deep accessibility (keyboard/screen-reader), a payment or data-loss flow, a protocol or offline edge. Up to 2, each as a short focus phrase. Past runs' form is in .smolt/battletest/form.jsonl if it exists — weigh what has actually found problems before.
3. Start the run: battletest action 'start' with your specialists array${focus !== "" ? `, focus: '${focus}'` : ""}${modelRef ? `, model: '${modelRef}'` : ""}. ${modelRef ? "" : "Do NOT pass a model — testers run on the session's own model unless the user names one. "}The kickoff brief for supervising the run arrives as a follow-up message.`;
}

/** How the agent presents the cross-run ledger when the user asks for it. */
function ledgerPrompt(): string {
	return `Show me the battletest ledger: the cross-run record of every distinct problem runs have found.
1. Call the battletest tool, action 'ledger'. (It folds in runs that predate the ledger automatically; if the result says it backfilled, mention that in one line.)
2. Present it here in chat, readable at a glance: the counts first (open / regressed / fixed / won't-fix); then any REGRESSIONS, each called out loudly; then the open issues worst-first — severity, title, area, and how many times each has been seen. Use a table if it helps.
3. Close with the one or two issues you would fix first and why — hit counts are evidence.
Do not fix anything this turn.`;
}

/** Shared tail of the kickoff and settle prompts: how to synthesize a finished run. */
function synthesisInstructions(runSlug: string): string {
	return `Synthesize run '${runSlug}':
1. Orient: battletest action 'view' for the personas, tickets, notes paths, and metrics summaries. Read every tester's notes file, and view_ticket anything you need in full.
2. Dedupe: where testers hit the same underlying issue, keep the clearest ticket and mark the rest with update_ticket status 'duplicate' plus duplicate_of. Adjust a severity only when the evidence across testers clearly supports it.
3. Time the run: read the metrics summaries (per tester: wall clock, action count, time inside tools vs time the model spent thinking, per-tool totals and error counts, the slowest individual actions). Name the bottlenecks — which tool ate the run, whether tools or the model dominated, which testers were pathologically slow and why (the per-action JSONL beside each summary has the raw spans if a summary looks odd). The run folder's performance.json scores every tester (severity-weighted tickets, spend, their full brief); name the strongest tester in the report so future teams can be picked on form.
4. Write the report with action 'write_report': ## Overview (what was tested and by whom), ## Experience by persona (a short capsule per tester, in their voice), ## Findings by severity (every non-duplicate ticket: title, area, persona, one line — REGRESSIONS first and loudest), ## Ratchet (what the cross-run ledger says: fresh problems vs hits on known issues this run, every regression by name, and the most-hit still-open issues — battletest action 'ledger' has the numbers), ## Themes (recurring UX/UI/performance/wording patterns across testers), ## Run performance (the bottleneck findings from step 3 — where future runs can be made faster), ## Suggested fix order.
5. Then show me the findings here in chat: the headline issues with severities, the themes, what the testers actually said, and where the report and tickets live. I must be able to judge the state of the app from your message alone.
Do not fix anything this turn — the tickets are for later sessions.`;
}

function teamList(run: BattleTestRun): string {
	return run.personas.map((persona) => `- ${describePersona(persona)}`).join("\n");
}

/** How the supervising session shepherds a live run. Shared by both kickoffs. */
function watchLoopInstructions(): string {
	return `While they test, stay on watch: call the battletest tool with action 'wait' (seconds up to ${MAX_WAIT_SECONDS}) and keep calling it each time it returns with testers still going — do not start unrelated work between waits. Every wait returns the run's deltas: new tickets since the last check, and each tester's activity and current area. KEEP ME POSTED: after each wait that reports anything new, give me a compact plain-language progress update (two or three lines — the notable new findings, who is where) before waiting again; if a check-in has nothing new, a single quiet line is enough. Use the remaining gap to triage: mark obvious duplicates with update_ticket status 'duplicate' as they appear, so the final synthesis is mostly done when the last tester finishes (never let triage delay a clearance ruling). If a straggler drags on long after the rest have finished, send it action 'wrap_up'. 'wait' also returns early when a tester requests clearance for a possibly-risky action: you are the supervisor, so judge each request against the safety doctrine (deny anything that buys, subscribes, creates real accounts, sends real data, or deletes/changes data the app manages — deny when in doubt; allow only actions with no real-world footprint), record every ruling with action 'decide', and go straight back to 'wait' — the tester is paused until you answer.`;
}

function kickoffPrompt(run: BattleTestRun, model?: Model<Api>): string {
	const modelNote = model ? ` Every tester runs on ${model.provider}/${model.id}.` : "";
	return `A battletest run '${run.slug}' has started: ${run.personas.length} simulated users are exploring this project's app right now, each in their own background session.${modelNote}

The team:
${teamList(run)}

STALE-BUILD WATCH: if the testers run a built artifact and start reporting features as missing that you know exist, suspect an outdated build before believing the tickets — check newest source mtime vs newest build mtime. If it is stale: 'stop' the run, rebuild, then 'resume' — a stale build once cost a fleet a third of its budget and its only blocker ticket.

${watchLoopInstructions()}

When 'wait' reports every tester finished, ${synthesisInstructions(run.slug)}`;
}

function resumeKickoffPrompt(run: BattleTestRun, drained: number): string {
	return `A battletest run '${run.slug}' was interrupted mid-run — the session hosting its testers was lost — and has now been resumed: ${run.personas.length} testers re-spawned from their own diaries, tickets, and remaining budgets, continuing where they left off.${drained > 0 ? ` ${drained} leftover tester(s) from the previous session instance were stopped first.` : ""}

The team:
${teamList(run)}

${watchLoopInstructions()}

When 'wait' reports every tester finished, ${synthesisInstructions(run.slug)}`;
}

// ------------------------------------------------------------------
// The tool testers get: their only line back to the run's record.
// ------------------------------------------------------------------

/** What a freshly filed ticket announces to the parent TUI. */
interface TicketAnnouncement {
	title: string;
	severity: string;
	category: string;
	area: string;
}

/** A tester asking the supervising agent whether a gray-zone action is safe. */
interface ClearanceRequest {
	action: string;
	risk: string;
	area: string;
}

interface ClearanceVerdict {
	allowed: boolean;
	guidance: string;
}

/** A clearance nobody ruled on in time is denied — the run never stalls on it. */
const DEFAULT_CLEARANCE_TIMEOUT_MS = 5 * 60 * 1000;

const CLEARANCE_TIMEOUT_VERDICT: ClearanceVerdict = {
	allowed: false,
	guidance: "No supervisor ruling arrived in time. Treat this as denied: note it in your diary and move on.",
};

function makeTestlogTool(
	store: BattleTestStore,
	runSlug: string,
	persona: Persona,
	onTicket: (ticket: TicketAnnouncement) => void,
	onClearance: (request: ClearanceRequest) => Promise<ClearanceVerdict>,
): ToolDefinition {
	return defineTool({
		name: "testlog",
		label: "Test log",
		description:
			"Record your experience as you test. Action 'note' (area, text) appends to your running diary — " +
			"use it after every meaningful step, in your own voice. Action 'ticket' (title, severity, " +
			"category, area, what, expected, steps) files one distinct problem: a bug, UI inconsistency, " +
			"awkward UX, performance issue, odd wording, or accessibility failure. File tickets the moment " +
			"you hit the problem. Steps must let a stranger reproduce it. A filing that matches an existing " +
			"ticket is bounced with its slug: stop working that problem, 'append' (ticket, text) anything " +
			"new you saw, and move on — or refile with force=true only if yours is truly different. " +
			"Action 'clearance' (area, text = " +
			"the exact action you want to take, risk = why it might be unsafe) asks the supervising agent " +
			"to rule on a gray-zone action BEFORE you take it; the call blocks until the ruling arrives, " +
			"and you obey it. Never escalate the outright-forbidden (buying, deleting real data, real " +
			"submissions) — those are always denied.",
		parameters: Type.Object({
			action: Type.Union(
				[Type.Literal("note"), Type.Literal("ticket"), Type.Literal("append"), Type.Literal("clearance")],
				{
					description:
						"note = diary entry; ticket = one distinct problem; append = add your observations to " +
						"another tester's ticket; clearance = ask before a risky action",
				},
			),
			area: Type.String({ description: "Where in the app: a screen, flow, or component name" }),
			text: Type.Optional(
				Type.String({
					description:
						"For 'note': what you tried and how it went. For 'append': your new observations about the " +
						"existing ticket. For 'clearance': the exact action you want to take.",
				}),
			),
			risk: Type.Optional(Type.String({ description: "For 'clearance': why this action might be unsafe" })),
			title: Type.Optional(Type.String({ description: "For 'ticket': one line naming the problem" })),
			severity: Type.Optional(
				Type.Union(
					TICKET_SEVERITIES.map((severity) => Type.Literal(severity)),
					{
						description:
							"blocker = cannot proceed; major = badly hurts; minor = friction; polish = small but real",
					},
				),
			),
			category: Type.Optional(
				Type.Union(
					TICKET_CATEGORIES.map((category) => Type.Literal(category)),
					{ description: "What kind of problem this is" },
				),
			),
			what: Type.Optional(Type.String({ description: "For 'ticket': what actually happened" })),
			expected: Type.Optional(Type.String({ description: "For 'ticket': what you expected instead" })),
			steps: Type.Optional(Type.String({ description: "For 'ticket': exact steps to reproduce" })),
			ticket: Type.Optional(Type.String({ description: "For 'append': the slug of the existing ticket" })),
			force: Type.Optional(
				Type.Boolean({
					description:
						"For 'ticket': file even though a similar ticket exists — only when yours is genuinely " +
						"a different problem, with a title that names the difference",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			if (params.action === "note") {
				if ((params.text ?? "").trim() === "")
					return textResult(JSON.stringify({ success: false, error: "a note needs 'text'" }));
				const result = store.appendNote(runSlug, persona, params.area, params.text ?? "");
				return textResult(JSON.stringify(result));
			}
			if (params.action === "clearance") {
				if ((params.text ?? "").trim() === "")
					return textResult(
						JSON.stringify({ success: false, error: "a clearance request needs 'text': the exact action" }),
					);
				const verdict = await onClearance({
					action: (params.text ?? "").trim(),
					risk: (params.risk ?? "").trim(),
					area: params.area,
				});
				store.appendNote(
					runSlug,
					persona,
					params.area,
					`Requested clearance: ${(params.text ?? "").trim()} — ${verdict.allowed ? "ALLOWED" : "DENIED"}. ${verdict.guidance}`,
				);
				return textResult(JSON.stringify({ success: true, ...verdict }));
			}
			if (params.action === "append") {
				if ((params.ticket ?? "").trim() === "" || (params.text ?? "").trim() === "")
					return textResult(JSON.stringify({ success: false, error: "append needs 'ticket' and 'text'" }));
				const appended = store.appendToTicket(runSlug, params.ticket ?? "", persona.slug, params.text ?? "");
				if (appended.success === true) {
					return textResult(
						JSON.stringify({
							...appended,
							message: "Your observations were added. That problem is covered — move on to fresh territory.",
						}),
					);
				}
				return textResult(JSON.stringify(appended));
			}
			const missing = ["title", "what", "expected", "steps"].filter(
				(field) => (((params as Record<string, unknown>)[field] as string | undefined) ?? "").trim() === "",
			);
			if (missing.length > 0) {
				return textResult(JSON.stringify({ success: false, error: `a ticket needs: ${missing.join(", ")}` }));
			}
			const filing: Parameters<BattleTestStore["addTicket"]>[1] = {
				title: params.title ?? "",
				persona: persona.slug,
				severity: params.severity ?? "minor",
				category: params.category ?? "other",
				area: params.area,
				what: params.what ?? "",
				expected: params.expected ?? "",
				steps: params.steps ?? "",
			};
			// One problem, one ticket, however many testers hit it: a filing that
			// reads like an existing ticket is bounced with a pointer instead of
			// creating a duplicate, and the bounced tester is told to stand down
			// from the bug rather than spend budget re-proving it.
			if (params.force !== true) {
				const dup = store.findSimilarTicket(runSlug, params.area, params.title ?? "");
				if (dup) {
					return textResult(
						JSON.stringify({
							success: false,
							duplicate_of: dup.slug,
							filed_by: dup.persona,
							existing_title: dup.title,
							message:
								`${dup.persona === persona.slug ? "You" : `Tester '${dup.persona}'`} already filed this as ` +
								`'${dup.slug}'. Do NOT investigate this problem further — it is covered. If you noticed ` +
								"something genuinely new about it, add it with action 'append' (ticket, text). If yours " +
								"is a truly different problem, refile with force=true and a title naming the difference. " +
								"Either way, move on to territory nobody has covered.",
						}),
					);
				}
				// The ledger remembers what past runs already found. A known open
				// problem costs one bounced filing instead of a re-investigation —
				// the hit count IS the severity evidence. A fixed problem that
				// reappears files loudly as a regression.
				const known = store.findLedgerMatch(params.area, filing.title);
				if (known !== undefined && known.status !== "fixed") {
					const hit = store.recordLedgerHit(
						known.slug,
						{ run: runSlug, persona: persona.slug, date: new Date().toISOString() },
						params.severity,
						filing.what,
					);
					return textResult(
						JSON.stringify({
							success: false,
							known_issue: known.slug,
							known_status: known.status,
							first_seen: known.origin.run,
							times_seen: hit?.entry.hits.length ?? known.hits.length + 1,
							message:
								known.status === "wont-fix"
									? `A previous run already found this, and it is deliberately not being fixed ` +
										`('${known.slug}'). Your sighting is recorded — spend nothing more on it.`
									: `A previous run already found this: '${known.slug}' (first seen in ` +
										`'${known.origin.run}', still ${known.status}). Your sighting is recorded as a ` +
										"hit — that IS the contribution; every hit is evidence of how much it hurts. " +
										"Do NOT investigate further. Refile with force=true only if yours is truly a " +
										"different problem.",
						}),
					);
				}
				if (known !== undefined && known.status === "fixed") {
					// A fixed issue sighted again: file it in this run, flip the
					// ledger entry to regressed, and tell the tester what they hold.
					const refiled = store.addTicket(runSlug, filing);
					if (refiled.success === true) {
						store.recordLedgerHit(
							known.slug,
							{ run: runSlug, persona: persona.slug, date: new Date().toISOString() },
							params.severity,
							filing.what,
						);
						store.linkTicket(runSlug, String(refiled.ticket), known.slug);
						onTicket({
							title: filing.title,
							severity: filing.severity,
							category: filing.category,
							area: params.area,
						});
						return textResult(
							JSON.stringify({
								...refiled,
								regression_of: known.slug,
								was_fixed_in: known.fixedIn ?? "unrecorded",
								message:
									"REGRESSION — this problem was marked fixed and you just hit it again. Your " +
									"ticket is filed and flagged. Nail the reproduction steps: this is the most " +
									"valuable ticket a run can produce. Then move on.",
							}),
						);
					}
					return textResult(JSON.stringify(refiled));
				}
			}
			const result = store.addTicket(runSlug, filing);
			if (result.success === true) {
				// Every fresh problem enters the cross-run ledger the moment it
				// is filed, so the next run starts knowing about it.
				store.promoteTicket(runSlug, String(result.ticket));
				onTicket({
					title: params.title ?? "",
					severity: params.severity ?? "minor",
					category: params.category ?? "other",
					area: params.area,
				});
				// Show the neighbourhood the ticket landed in: testers file blind
				// to each other, and awareness of what this area already holds is
				// what turns the next near-duplicate into an 'append' instead.
				const neighbours = store
					.listTickets(runSlug)
					.filter(
						(ticket) =>
							ticket.slug !== result.ticket &&
							ticket.status !== "duplicate" &&
							ticket.area.trim().toLowerCase() === params.area.trim().toLowerCase(),
					)
					.slice(0, 5)
					.map((ticket) => `${ticket.slug}: ${ticket.title} (${ticket.persona})`);
				if (neighbours.length > 0) {
					return textResult(
						JSON.stringify({
							...result,
							also_in_area: neighbours,
							note: "This area already has the tickets above — if your NEXT find here matches one, 'append' to it instead of filing.",
						}),
					);
				}
			}
			return textResult(JSON.stringify(result));
		},
	});
}

// ------------------------------------------------------------------
// The browse tool: a tester's private browser, one action per user action.
// ------------------------------------------------------------------

/** Holds the lazily launched driver so the run can dispose it later. */
export interface BrowserSlot {
	driver?: BrowseDriver;
}

function makeBrowseTool(options: {
	slot: BrowserSlot;
	port: number;
	profileDir: string;
	viewport: Persona["viewport"];
	factory: BrowseDriverFactory;
}): ToolDefinition {
	const { slot } = options;

	const ensure = async (): Promise<BrowseDriver> => {
		if (!slot.driver) {
			slot.driver = await options.factory({
				port: options.port,
				userDataDir: join(options.profileDir, "browser"),
				viewport: VIEWPORT_PRESETS[options.viewport],
			});
		}
		return slot.driver;
	};

	return defineTool({
		name: "browse",
		label: "Browse",
		description:
			"Your own private browser, already locked to your persona's screen size. One call = one user " +
			"action, and every action except 'eval' returns a screenshot of what the page looks like NOW, " +
			"plus the page URL/title and any console errors — study each image before your next move.\n\n" +
			"ACTIONS: 'goto' (url) — call this first; 'click' (selector, or x+y in viewport pixels); " +
			"'type' (text — types into the focused element; click a field first); 'press' (key: Enter, " +
			"Tab, Escape, Backspace, arrows...); 'scroll' (dy pixels, negative = up); 'screenshot' for a " +
			"fresh look; 'eval' (js — returns the value, for reading state, never for clicking around the " +
			"UI); 'viewport' (width, height, mobile?) to resize mid-session.",
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("goto"),
					Type.Literal("click"),
					Type.Literal("type"),
					Type.Literal("press"),
					Type.Literal("scroll"),
					Type.Literal("screenshot"),
					Type.Literal("eval"),
					Type.Literal("viewport"),
				],
				{ description: "The user action to perform" },
			),
			url: Type.Optional(Type.String({ description: "For 'goto'" })),
			selector: Type.Optional(Type.String({ description: "For 'click': CSS selector of the element" })),
			x: Type.Optional(Type.Number({ description: "For 'click': viewport x when not using a selector" })),
			y: Type.Optional(Type.Number({ description: "For 'click': viewport y when not using a selector" })),
			text: Type.Optional(Type.String({ description: "For 'type'" })),
			key: Type.Optional(Type.String({ description: "For 'press': Enter, Tab, Escape, ArrowDown, ..." })),
			dy: Type.Optional(Type.Number({ description: "For 'scroll': pixels down (negative scrolls up)" })),
			js: Type.Optional(Type.String({ description: "For 'eval': expression evaluated in the page" })),
			width: Type.Optional(Type.Number({ description: "For 'viewport'" })),
			height: Type.Optional(Type.Number({ description: "For 'viewport'" })),
			mobile: Type.Optional(Type.Boolean({ description: "For 'viewport': emulate touch/mobile" })),
			doing: Type.Optional(
				Type.String({
					description:
						"Include on every call: 2-5 words on what you are doing right now, present tense, " +
						"e.g. 'checking the docs button' — shown live on the run roster",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			try {
				if (params.action !== "goto" && !slot.driver) {
					return textResult("No page open yet: start with action 'goto' and a URL.");
				}
				const driver = await ensure();
				let note = "";
				switch (params.action) {
					case "goto": {
						if (!params.url) return textResult("goto needs 'url'");
						await driver.goto(params.url);
						break;
					}
					case "click": {
						if (params.selector) {
							const clicked = await driver.clickSelector(params.selector);
							note = clicked === "" ? "clicked" : `clicked "${clicked}"`;
						} else if (params.x !== undefined && params.y !== undefined) {
							await driver.clickAt(params.x, params.y);
							note = `clicked at ${params.x},${params.y}`;
						} else {
							return textResult("click needs 'selector' or 'x'+'y'");
						}
						break;
					}
					case "type": {
						if (params.text === undefined) return textResult("type needs 'text'");
						await driver.type(params.text);
						break;
					}
					case "press": {
						if (!params.key) return textResult("press needs 'key'");
						await driver.press(params.key);
						break;
					}
					case "scroll": {
						await driver.scroll(params.dy ?? 600);
						break;
					}
					case "screenshot":
						break;
					case "eval": {
						if (!params.js) return textResult("eval needs 'js'");
						const value = await driver.eval(params.js);
						return textResult(value.length > 4000 ? `${value.slice(0, 4000)}...` : value);
					}
					case "viewport": {
						if (!params.width || !params.height) return textResult("viewport needs 'width' and 'height'");
						await driver.setViewport({
							width: params.width,
							height: params.height,
							deviceScaleFactor: params.mobile ? 3 : 1,
							mobile: params.mobile ?? false,
						});
						note = `viewport now ${params.width}x${params.height}${params.mobile ? " (mobile)" : ""}`;
						break;
					}
				}
				const state = await driver.state();
				const shot = await driver.screenshot();
				const consoleBlock =
					state.console.length > 0 ? `\nConsole since last action:\n${state.console.join("\n")}` : "";
				return {
					content: [
						{
							type: "text" as const,
							text: `${note ? `${note} · ` : ""}${state.url} — ${state.title}${consoleBlock}`,
						},
						{ type: "image" as const, data: shot, mimeType: "image/jpeg" },
					],
					details: {},
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textResult(
					`browse failed: ${message}. If the browser cannot launch at all, fall back to driving headless ` +
						`Chrome/Edge yourself from the shell (CDP on port ${options.port}, profile under '${options.profileDir}').`,
				);
			}
		},
	});
}

// ------------------------------------------------------------------
// Extension
// ------------------------------------------------------------------

export interface BattleTestPaths {
	root: string;
	/** How long a clearance request waits for a ruling before auto-denying. */
	clearanceTimeoutMs?: number;
}

export default function battleTestExtension(smolt: ExtensionAPI): void {
	createBattleTestExtension(smolt, { root: join(process.cwd(), ".smolt", "battletest") });
}

export interface BattleTestHandle {
	testers(): Tester[];
	activeRun(): string | undefined;
	/** Abort and dispose every tester this instance owns; returns how many were live. */
	stop(): Promise<number>;
}

/**
 * Classify one raw tool action into the few words a person would use —
 * "searching the repo for battletest" instead of the grep command line.
 * Injectable so tests never touch a provider.
 */
export type ActionLabeler = (raw: string, ctx: ExtensionContext) => Promise<string | undefined>;

const LABEL_SYSTEM =
	"You caption what a simulated app tester is doing right now. Given one raw tool action, answer with a single " +
	'present-tense phrase of 2 to 6 words, e.g. "searching the repo for battletest" or "opening the docs page". ' +
	"Lowercase, no punctuation, no quotes, nothing but the phrase.";

/** Model names that advertise the cheap tier; a label is not worth a flagship call. */
const CHEAP_MODEL_HINT = /haiku|flash|mini|nano|lite|small/i;

/** The classification is decoration; a slow provider must never hold a paint. */
const LABEL_TIMEOUT_MS = 10_000;

const defaultActionLabeler: ActionLabeler = async (raw, ctx) => {
	const authed = ctx.modelRegistry.getAvailable().filter((model) => ctx.modelRegistry.hasConfiguredAuth(model));
	const cheap = authed.filter((model) => CHEAP_MODEL_HINT.test(model.id));
	const model = cheap.find((candidate) => candidate.provider === ctx.model?.provider) ?? cheap[0] ?? ctx.model;
	if (!model) return undefined;
	const result = await ctx.modelRegistry.complete(
		model,
		{
			systemPrompt: LABEL_SYSTEM,
			messages: [{ role: "user", content: [{ type: "text", text: raw }], timestamp: Date.now() }],
		},
		{ maxTokens: 24, signal: AbortSignal.timeout(LABEL_TIMEOUT_MS) },
	);
	const text = (result.content ?? [])
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join(" ")
		.replace(/["'.]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 48);
	return text === "" ? undefined : text;
};

export function createBattleTestExtension(
	smolt: ExtensionAPI,
	paths: BattleTestPaths,
	spawn: TesterSpawner = defaultSpawner,
	browseFactory: BrowseDriverFactory = defaultBrowseDriverFactory,
	labeler: ActionLabeler = defaultActionLabeler,
): BattleTestHandle {
	const store = new BattleTestStore(paths.root);
	const previous = latestInstance;
	const clearanceTimeoutMs = paths.clearanceTimeoutMs ?? DEFAULT_CLEARANCE_TIMEOUT_MS;
	let testers: Tester[] = [];
	let activeRun: string | undefined;
	/** All testers finished but the run has not been synthesized yet. */
	let synthesisDue = false;
	/** Clearance requests awaiting the supervising agent's ruling. */
	interface PendingClearance extends ClearanceRequest {
		id: string;
		persona: string;
		settle: (verdict: ClearanceVerdict) => void;
	}
	const clearances = new Map<string, PendingClearance>();
	let clearanceSeq = 0;
	/** One lazily launched browser per tester, torn down with the run. */
	const browsers = new Map<string, BrowserSlot>();
	/** Testers already told to wrap up for blowing their budget — told once. */
	const wrappedUp = new Set<string>();

	/**
	 * The end-of-run record: how each tester did, under which brief, at what
	 * cost, and who came out on top — the raw material for picking stronger
	 * teams later. Written the moment the last tester finishes, while every
	 * driver is still around to answer for its numbers.
	 */
	const recordPerformance = (run: BattleTestRun): void => {
		try {
			const tickets = store.listTickets(run.slug);
			store.writePerformance(
				run.slug,
				testers.map((tester) => {
					const filed = tickets.filter(
						(ticket) => ticket.persona === tester.persona.slug && ticket.status !== "duplicate",
					);
					const tokens = tester.driver?.tokens?.();
					const timing = tester.driver?.metricsSummary?.();
					return {
						slug: tester.persona.slug,
						name: tester.persona.name,
						archetype: tester.persona.archetype,
						viewport: tester.persona.viewport,
						traits: { ...tester.persona.traits },
						status: tester.status,
						tickets: filed.length,
						points: filed.reduce((sum, ticket) => sum + (SEVERITY_POINTS[ticket.severity] ?? 1), 0),
						actions: timing?.actions ?? tester.driver?.actions?.() ?? 0,
						tokens: tokens ? tokens.input + tokens.output : 0,
						wallMs: timing?.wallMs ?? 0,
						brief: tester.task ?? "",
					};
				}),
			);
		} catch {
			// Record-keeping must never take the run down.
		}
	};

	/** What the parent has already been told, so each wait reports only deltas. */
	let reportedTickets = new Set<string>();
	const reportedActions = new Map<string, number>();
	/** Tester tokens already handed to the parent's accounting via wait results. */
	const reportedTokens = { input: 0, output: 0, cost: 0 };

	const testerTokenTotals = (): { input: number; output: number; cost: number } => {
		const totals = { input: 0, output: 0, cost: 0 };
		for (const tester of testers) {
			const tokens = tester.driver?.tokens?.();
			if (!tokens) continue;
			totals.input += tokens.input;
			totals.output += tokens.output;
			totals.cost += tokens.cost;
		}
		return totals;
	};

	const running = (): Tester[] => testers.filter((tester) => tester.status === "testing");
	const allFinished = (): boolean => testers.length > 0 && running().length === 0;

	/** "12.4k tokens" — a tester's own spend, for the per-tester roster lines. */
	const testerTokenLabel = (tester: Tester): string => {
		const tokens = tester.driver?.tokens?.();
		if (!tokens) return "";
		const total = tokens.input + tokens.output;
		return total > 0 ? `${(total / 1000).toFixed(1)}k tokens` : "";
	};

	/** Trim a URL or selector down to the part a human scans for. */
	const shorten = (raw: string): string => {
		const text = raw.replace(/^https?:\/\//, "").trim();
		return text.length > 40 ? `${text.slice(0, 39)}…` : text;
	};

	/**
	 * The roster asked for "testing docs button", not "browse: click .docs" —
	 * translate the raw in-flight action into the line a person would say.
	 */
	const humanizeAction = (action: string | undefined): string | undefined => {
		if (!action) return undefined;
		const match = /^(\w+): (\S+)\s*(.*)$/.exec(action);
		if (!match) return action;
		const [, tool, verb, rest] = match as unknown as [string, string, string, string];
		if (tool === "browse") {
			if (verb === "goto") return `opening ${shorten(rest)}`;
			if (verb === "click") return `clicking ${shorten(rest) || "the page"}`;
			if (verb === "type") return "typing";
			if (verb === "press") return "pressing keys";
			if (verb === "scroll") return "scrolling";
			if (verb === "screenshot") return "looking at the page";
			if (verb === "eval") return "inspecting the page";
			if (verb === "viewport") return "resizing the window";
			return `${verb} ${shorten(rest)}`.trim();
		}
		if (tool === "testlog") {
			if (verb === "ticket") return `filing: ${shorten(rest) || "a ticket"}`;
			if (verb === "clearance") return "asking for clearance";
			return "writing notes";
		}
		if (tool === "bash" || tool === "powershell") return `running ${shorten(`${verb} ${rest}`)}`;
		if (tool === "read") return `reading ${shorten(`${verb} ${rest}`)}`;
		return action;
	};

	// Every action gets one cheap model call turning it into a few words for
	// the roster ("searching the repo for battletest"), cached by raw action
	// so a repeated grep never pays twice. The heuristic humanizer stands in
	// while the call is in flight, and stays if the call fails.
	const actionLabels = new Map<string, string>();
	const labelsInFlight = new Set<string>();
	const LABEL_CACHE_MAX = 600;

	const requestLabel = (raw: string, ctx: ExtensionContext): void => {
		if (actionLabels.has(raw) || labelsInFlight.has(raw)) return;
		labelsInFlight.add(raw);
		void labeler(raw, ctx)
			.then((text) => {
				if (text === undefined || text === "") return;
				if (actionLabels.size >= LABEL_CACHE_MAX) actionLabels.clear();
				actionLabels.set(raw, text);
				paint(ctx);
			})
			.catch(() => {
				// The humanizer's line stands; a label is never worth an error.
			})
			.finally(() => labelsInFlight.delete(raw));
	};

	/** The words for one raw action: the model's label, or the humanizer meanwhile. */
	const describeAction = (raw: string | undefined, ctx: ExtensionContext): string | undefined => {
		if (raw === undefined) return undefined;
		// The tester said it itself (a 'doing' argument, a # comment on a shell
		// command): the phrase arrives without a `tool:` prefix and is already
		// the label — no model call, no cache entry, no cost.
		if (!/^\w+: /.test(raw)) return raw;
		const cached = actionLabels.get(raw);
		if (cached !== undefined) return cached;
		requestLabel(raw, ctx);
		return humanizeAction(raw);
	};

	const paint = (ctx: ExtensionContext): void => {
		// A drained previous instance still paints from its finish callbacks;
		// status furniture is best-effort and must never take the run down.
		try {
			paintUnchecked(ctx);
		} catch {
			// Ignore — the live session repaints on its next tick.
		}
	};

	const paintUnchecked = (ctx: ExtensionContext): void => {
		if (activeRun === undefined || testers.length === 0) {
			ctx.ui.setStatus("battletest", undefined);
			ctx.ui.setWidget("battletest", undefined);
			return;
		}
		// The budget is a ceiling, not a suggestion: a tester well past it gets
		// one automatic supervisor steer to file and finish — stragglers are
		// what turn a thirty-minute run into an eighty-minute one.
		for (const tester of running()) {
			if (wrappedUp.has(tester.persona.slug) || !tester.driver?.send) continue;
			const spent = tester.driver.actions?.() ?? 0;
			if (spent <= Math.round(budgetFor(tester.persona.traits.thoroughness) * 1.2)) continue;
			wrappedUp.add(tester.persona.slug);
			void tester.driver
				.send(
					"Supervisor: your action budget is spent. Stop exploring now — file any outstanding tickets, " +
						"write your final 'overall' diary note, and finish with your summary reply. Start nothing new.",
				)
				.catch(() => {});
		}
		const tickets = store.listTickets(activeRun);
		const live = running().length;
		const pending = clearances.size > 0 ? `, ${clearances.size} clearance pending` : "";
		const spentTotals = testerTokenTotals();
		const spentTokens = spentTotals.input + spentTotals.output;
		const spentLabel = spentTokens > 0 ? `, ${(spentTokens / 1000).toFixed(1)}k tester tokens` : "";
		ctx.ui.setStatus(
			"battletest",
			live > 0
				? `battletest: ${live}/${testers.length} testing, ${tickets.length} tickets${pending}${spentLabel}`
				: `battletest: done, ${tickets.length} tickets${spentLabel}`,
		);
		const filedBy = new Map<string, BattleTestTicket[]>();
		for (const ticket of tickets) {
			const list = filedBy.get(ticket.persona) ?? [];
			list.push(ticket);
			filedBy.set(ticket.persona, list);
		}
		const lines: string[] = [];
		// Structured shadow of each line: the desktop app lets the ticket and
		// action counts expand into the actual lists. Index-aligned with lines.
		const details: { testers: { tickets: string[]; actions: string[] }[] } = { testers: [] };
		for (const tester of testers) {
			const filed = filedBy.get(tester.persona.slug) ?? [];
			const actions = tester.driver?.actions?.() ?? 0;
			// Say WHAT the tester is doing, not just that it is: the model's
			// label for the live action first (humanizer while it classifies),
			// the diary's current area as fallback, the bare status only when
			// neither is known.
			const doing =
				tester.status === "testing"
					? (describeAction(tester.driver?.currentAction?.(), ctx) ??
						(activeRun !== undefined
							? ((area) => (area ? `testing ${area}` : undefined))(
									store.latestNoteArea(activeRun, tester.persona.slug),
								)
							: undefined) ??
						"testing")
					: tester.status;
			const spent = testerTokenLabel(tester);
			const line =
				`${tester.persona.name} (${tester.persona.archetype}, ${tester.persona.viewport}) · ` +
				`${actions} action${actions === 1 ? "" : "s"}` +
				// The tester's own spend on the line running it: the aggregated
				// status figure says nothing about who is burning the tokens.
				(spent !== "" ? ` · ${spent}` : "") +
				` · ${filed.length} ticket${filed.length === 1 ? "" : "s"} · ${doing}`;
			lines.push(
				tester.status === "errored" ? `${line} — ${tester.error.split("\n")[0]?.slice(0, 50) ?? ""}` : line,
			);
			details.testers.push({
				tickets: filed.map((ticket) => `[${ticket.severity}/${ticket.category}] ${ticket.title} — ${ticket.area}`),
				// Cached labels only here — the expandable list must not trigger
				// a burst of thirty classification calls per tester per paint.
				actions: (tester.driver?.recentActions?.() ?? []).map(
					(action) => actionLabels.get(action) ?? humanizeAction(action) ?? action,
				),
			});
		}
		ctx.ui.setWidget("battletest", lines, { details });
	};

	const stopAll = async (mark: boolean): Promise<number> => {
		// Nothing may sit awaiting a ruling once the run is going down.
		for (const entry of [...clearances.values()]) {
			entry.settle({ allowed: false, guidance: "The run is stopping; do nothing further." });
		}
		const live = running();
		for (const tester of live) {
			await tester.driver?.abort();
			tester.status = "stopped";
		}
		for (const tester of testers) tester.driver?.dispose();
		for (const slot of browsers.values()) slot.driver?.dispose();
		browsers.clear();
		if (mark && activeRun !== undefined && live.length > 0) store.setRunStatus(activeRun, "stopped");
		return live.length;
	};

	const startRun = async (
		count: number,
		focus: string,
		ctx: ExtensionContext,
		model?: Model<Api>,
		thinkingLevel?: ThinkingLevel,
		specialists?: string[],
	): Promise<BattleTestRun> => {
		// A supervisor-picked team is a balanced generalist plus its named
		// specialists; a counted run still deals archetypes from the deck.
		const personas = specialists !== undefined ? generateTeam(specialists) : generatePersonas(count);
		const run = store.createRun({ focus: focus === "" ? undefined : focus, personas });
		activeRun = run.slug;
		await dispatchTesters(run, undefined, ctx, model, thinkingLevel);
		// The tool-driven start happens mid-turn: a bare send throws ("agent is
		// already processing") and the bridge swallows it, so the kickoff brief
		// silently never arrived. followUp queues it for right after this turn,
		// and sends immediately when the command path calls this while idle.
		smolt.sendUserMessage(kickoffPrompt(run, model), { deliverAs: "followUp" });
		return run;
	};

	/**
	 * What each resumed tester knows about its own previous session: spent
	 * actions from the metrics JSONL, the diary, the tickets it filed.
	 */
	const resumeBriefs = (run: BattleTestRun): ResumeBrief[] =>
		run.personas.map((persona) => ({
			spent: countSpentActions(store.metricsPath(run.slug, persona.slug)),
			diary: trimDiary(readDiary(store.notesPath(run.slug, persona.slug))),
			filed: store
				.listTickets(run.slug)
				.filter((ticket) => ticket.persona === persona.slug)
				.map((ticket) => `${ticket.title} — ${ticket.severity}/${ticket.category} — ${ticket.area}`),
		}));

	/**
	 * Re-spawn the testers of an interrupted run: same recorded personas, same
	 * profile dirs and ports, each primed with its own diary, tickets, and
	 * remaining budget. Returns an error message, or "" on success.
	 */
	const resumeRun = async (ref: string, ctx: ExtensionContext): Promise<string> => {
		const run = store.resolveRun(ref);
		if (!run) return `Unknown run '${ref}'. Runs: ${store.listRunSlugs().join(", ") || "(none)"}`;
		if (run.status === "complete") return `Run '${run.slug}' is already complete; nothing to resume.`;
		if (run.personas.length === 0) return `Run '${run.slug}' has no recorded personas; it cannot be resumed.`;
		if (running().length > 0) {
			return `This session already has ${running().length} tester(s) running; 'stop' first, then resume.`;
		}
		// A reloaded session leaves the previous instance's testers running in
		// the background; drain them so the resume does not double the fleet.
		const drained = (await previous?.stop()) ?? 0;
		activeRun = run.slug;
		store.setRunStatus(run.slug, "testing");
		await dispatchTesters(run, resumeBriefs(run), ctx);
		smolt.sendUserMessage(resumeKickoffPrompt(run, drained), { deliverAs: "followUp" });
		return "";
	};

	const dispatchTesters = async (
		run: BattleTestRun,
		resume: ResumeBrief[] | undefined,
		ctx: ExtensionContext,
		model?: Model<Api>,
		thinkingLevel?: ThinkingLevel,
	): Promise<void> => {
		synthesisDue = false;
		// Deltas report only what arrives after (re)dispatch: a resumed run's
		// existing tickets must not re-announce themselves as new findings.
		reportedTickets = new Set(store.listTickets(run.slug).map((ticket) => ticket.slug));
		reportedActions.clear();
		reportedTokens.input = 0;
		reportedTokens.output = 0;
		reportedTokens.cost = 0;
		wrappedUp.clear();
		testers = run.personas.map((persona) => ({ persona, status: "testing" as const, summary: "", error: "" }));
		const knownIssues = knownIssuesBrief(store);
		for (const [index, tester] of testers.entries()) {
			const task = testerPrompt(
				tester.persona,
				run,
				index,
				store.profileDir(run.slug, tester.persona.slug),
				resume?.[index],
				knownIssues,
			);
			tester.task = task;
			const onFinish = (status: "completed" | "errored", detail: string): void => {
				if (tester.status !== "testing") return;
				tester.status = status;
				if (status === "errored") tester.error = detail;
				else tester.summary = detail;
				// A finished tester's browser has nothing left to show.
				browsers.get(tester.persona.slug)?.driver?.dispose();
				browsers.delete(tester.persona.slug);
				// Freeze the timing totals beside the raw rows, so synthesis can
				// name the run's bottlenecks without replaying the JSONL.
				const timing = tester.driver?.metricsSummary?.();
				if (timing) store.writeMetricsSummary(run.slug, tester.persona.slug, timing);
				if (allFinished()) {
					synthesisDue = true;
					recordPerformance(run);
				}
				paint(ctx);
			};
			// A gray-zone action pauses the tester until the supervising agent
			// rules on it; an unanswered request denies itself so nothing hangs.
			const onClearance = (request: ClearanceRequest): Promise<ClearanceVerdict> =>
				new Promise((resolve) => {
					clearanceSeq += 1;
					const id = `c${clearanceSeq}`;
					const settle = (verdict: ClearanceVerdict): void => {
						if (clearances.delete(id)) resolve(verdict);
					};
					clearances.set(id, { id, persona: tester.persona.name, settle, ...request });
					ctx.ui.notify(
						`battletest · ${tester.persona.name} requests clearance [${id}]: ${request.action}`,
						"warning",
					);
					paint(ctx);
					setTimeout(() => settle(CLEARANCE_TIMEOUT_VERDICT), clearanceTimeoutMs);
				});
			// Repaint on each ticket so the roster counts tick up live. No
			// notification: a busy run would bury the user in toasts, and the
			// roster's ticket count (expandable to titles) already tells the story.
			const onTicket = (_ticket: TicketAnnouncement): void => {
				paint(ctx);
			};
			const slot: BrowserSlot = {};
			browsers.set(tester.persona.slug, slot);
			try {
				tester.driver = await spawn(
					{
						persona: tester.persona,
						task,
						metricsPath: store.metricsPath(run.slug, tester.persona.slug),
						customTools: [
							makeTestlogTool(store, run.slug, tester.persona, onTicket, onClearance),
							makeBrowseTool({
								slot,
								port: DEBUG_PORT_BASE + index,
								profileDir: store.profileDir(run.slug, tester.persona.slug),
								viewport: tester.persona.viewport,
								factory: browseFactory,
							}),
						],
						ctx,
						model,
						thinkingLevel,
					},
					onFinish,
				);
			} catch (error) {
				tester.status = "errored";
				tester.error = error instanceof Error ? error.message : String(error);
			}
		}
		paint(ctx);
	};

	smolt.on("session_start", async (_event, ctx) => {
		testers = [];
		activeRun = undefined;
		synthesisDue = false;
		paint(ctx);
	});

	// Testers outlive a turn but never the session that dispatched them.
	smolt.on("session_shutdown", async () => {
		await stopAll(true);
	});

	/** The run now settling was aborted by the user; Stop means stop. */
	let lastRunAborted = false;
	smolt.on("agent_end", async (event) => {
		const last = [...event.messages].reverse().find((message) => message.role === "assistant");
		lastRunAborted = (last as { stopReason?: string } | undefined)?.stopReason === "aborted";
	});

	/**
	 * Safety net: the kickoff turn normally waits the run out and synthesizes
	 * in place, but if it was interrupted — the wait budget ran dry, a crash —
	 * the finished run would otherwise sit unreported. Same shape as
	 * wayfinder's research continuation. A user's Stop is the exception: an
	 * aborted turn must stay stopped, and the run stays reportable through
	 * /battletest report whenever they come back to it.
	 */
	smolt.on("agent_settled", async (_event, ctx) => {
		paint(ctx);
		if (lastRunAborted) return;
		if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
		if (ctx.hasPendingMessages()) return;
		// A tester is paused on a ruling and the parent went idle: pull it back.
		if (clearances.size > 0) {
			smolt.sendUserMessage(
				`${clearances.size} battletest clearance request(s) are pending and the tester is paused on your ruling. ` +
					"Call battletest action 'wait' to see them, rule with 'decide' (deny when in doubt), then keep waiting out the run.",
			);
			return;
		}
		if (!synthesisDue || activeRun === undefined) return;
		if (store.readRun(activeRun)?.status !== "testing") {
			synthesisDue = false;
			return;
		}
		synthesisDue = false;
		smolt.sendUserMessage(
			`All ${testers.length} battletest testers have finished while you were idle. ${synthesisInstructions(activeRun)}`,
		);
	});

	smolt.registerTool({
		name: "battletest",
		label: "Battletest",
		description:
			"Inspect and manage battletest runs: simulated-user test sessions whose notes, tickets, and " +
			"reports live under the project's .smolt/battletest/ directory.\n\n" +
			"ACTIONS: 'list' all runs; 'view' one run (personas, tickets by status, notes paths — omit " +
			"'run' for the latest); 'view_ticket' (ticket, run?) for a ticket's full body; 'add_ticket' " +
			"(title, what, severity?, category?, area?, expected?, steps?) to file an issue yourself; " +
			"'update_ticket' (ticket, status?, severity?, duplicate_of?) — status one of open/fixed/" +
			"wont-fix/duplicate, and 'duplicate' requires duplicate_of; 'ledger' (status?) lists the " +
			"cross-run issue ledger — every distinct problem past runs found, with hit counts and " +
			"regressions; 'update_ledger' (ticket = the ledger slug, status open/fixed/wont-fix/regressed) " +
			"resolves a ledger entry — mark entries 'fixed' as the user fixes them, so future runs verify " +
			"instead of re-discovering; 'sync_ledger' backfills the ledger from every run on disk; " +
			"'write_report' (content, run?) " +
			"writes the synthesized report and completes the run; 'wait' (seconds?) blocks while testers " +
			"from this session's active run are still working and reports the roster when it returns — it " +
			"also returns early whenever a tester requests clearance for a possibly-risky action; 'decide' " +
			"(clearance, verdict allow|deny, guidance?) rules on such a request: the tester is paused on " +
			"your answer, so rule promptly, and deny when in doubt; 'wrap_up' (persona?) tells straggling " +
			"testers to file what they have and finish — use it when a run drags well past its worth.\n\n" +
			"WHEN: after /battletest dispatches a run (wait for it, then synthesize), or when the user asks " +
			"about earlier runs, wants tickets triaged, or is fixing what a run found — mark tickets " +
			"'fixed' as they are dealt with. Start new runs with action 'start' (or the /battletest command " +
			"in plain language: '/battletest 15 subagents using opencode minimax-m3 to test a feature'); " +
			"resume interrupted ones with 'resume'.",
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("list"),
					Type.Literal("view"),
					Type.Literal("view_ticket"),
					Type.Literal("add_ticket"),
					Type.Literal("update_ticket"),
					Type.Literal("ledger"),
					Type.Literal("update_ledger"),
					Type.Literal("sync_ledger"),
					Type.Literal("write_report"),
					Type.Literal("wait"),
					Type.Literal("decide"),
					Type.Literal("wrap_up"),
					Type.Literal("start"),
					Type.Literal("resume"),
				],
				{ description: "Operation to perform" },
			),
			run: Type.Optional(Type.String({ description: "Run slug. Omit to mean the latest run." })),
			ticket: Type.Optional(Type.String({ description: "Ticket slug (view_ticket, update_ticket)" })),
			title: Type.Optional(Type.String({ description: "One line naming the problem (add_ticket)" })),
			persona: Type.Optional(
				Type.String({
					description:
						"add_ticket: who found it (defaults to 'synthesis'). wrap_up: which tester to nudge (name or slug; omit for all).",
				}),
			),
			severity: Type.Optional(Type.String({ description: `One of: ${TICKET_SEVERITIES.join(", ")}` })),
			category: Type.Optional(Type.String({ description: `One of: ${TICKET_CATEGORIES.join(", ")}` })),
			area: Type.Optional(Type.String({ description: "Where in the app: a screen, flow, or component" })),
			what: Type.Optional(Type.String({ description: "What actually happened (add_ticket)" })),
			expected: Type.Optional(Type.String({ description: "What should have happened (add_ticket)" })),
			steps: Type.Optional(Type.String({ description: "Steps to reproduce (add_ticket)" })),
			status: Type.Optional(
				Type.String({
					description: "New ticket status (update_ticket) or ledger status (update_ledger, ledger filter)",
				}),
			),
			duplicate_of: Type.Optional(
				Type.String({ description: "Canonical ticket when marking a duplicate (update_ticket)" }),
			),
			content: Type.Optional(Type.String({ description: "Full report markdown (write_report)" })),
			count: Type.Optional(
				Type.Number({
					description: `For 'start': how many testers (1-${MAX_TESTERS}, default ${DEFAULT_TESTERS})`,
				}),
			),
			specialists: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"For 'start': pick the team yourself instead of dealing from the deck — the run gets one " +
						"balanced generalist who goes over everything, plus one specialist per entry (each entry a " +
						"short focus phrase, e.g. 'keyboard-only accessibility'). Pass [] for just the generalist; " +
						"at most 2 specialists. Overrides 'count'.",
				}),
			),
			model: Type.Optional(
				Type.String({
					description:
						"For 'start': ONLY when the user explicitly named a model for this run, pass it through " +
						"verbatim (e.g. 'opencode/minimax-m3'). NEVER pick a model yourself — testers inherit the " +
						"session's own model by default, which is what the user expects.",
				}),
			),
			focus: Type.Optional(Type.String({ description: "For 'start': what this run should concentrate on" })),
			seconds: Type.Optional(
				Type.Number({
					description: `For 'wait': how long to block. Default ${DEFAULT_WAIT_SECONDS}, max ${MAX_WAIT_SECONDS}.`,
				}),
			),
			clearance: Type.Optional(Type.String({ description: "For 'decide': the pending clearance id (e.g. c1)" })),
			verdict: Type.Optional(
				Type.Union([Type.Literal("allow"), Type.Literal("deny")], {
					description: "For 'decide': allow only actions with no real-world footprint; deny when in doubt",
				}),
			),
			guidance: Type.Optional(
				Type.String({ description: "For 'decide': one line the tester reads with the ruling" }),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (params.action === "wrap_up") {
				const targets = running().filter(
					(tester) =>
						!params.persona ||
						tester.persona.slug === params.persona.trim() ||
						tester.persona.name.toLowerCase() === params.persona.trim().toLowerCase(),
				);
				if (targets.length === 0) return textResult("No matching testers are still running.");
				for (const tester of targets) {
					await tester.driver?.send?.(
						"Supervisor: time is up. Stop exploring now — file any outstanding tickets, write your final " +
							"'overall' diary note with your closing impressions, and finish with your summary reply.",
					);
				}
				return textResult(
					`Asked ${targets.length} tester(s) to wrap up: ${targets.map((tester) => tester.persona.name).join(", ")}. Call 'wait' to see them finish.`,
				);
			}

			if (params.action === "decide") {
				const entry = clearances.get((params.clearance ?? "").trim());
				if (!entry) {
					const ids = [...clearances.keys()].join(", ") || "(none)";
					return textResult(JSON.stringify({ success: false, error: `unknown clearance id; pending: ${ids}` }));
				}
				if (params.verdict !== "allow" && params.verdict !== "deny") {
					return textResult(JSON.stringify({ success: false, error: "verdict must be 'allow' or 'deny'" }));
				}
				const allowed = params.verdict === "allow";
				entry.settle({
					allowed,
					guidance:
						(params.guidance ?? "").trim() ||
						(allowed
							? "Proceed carefully and record what happens."
							: "Do not do this; note it in your diary and move on."),
				});
				ctx.ui.notify(`battletest · clearance ${entry.id} (${entry.persona}): ${params.verdict}`, "info");
				paint(ctx);
				return textResult(
					JSON.stringify({
						success: true,
						clearance: entry.id,
						verdict: params.verdict,
						still_pending: clearances.size,
					}),
				);
			}

			if (params.action === "start") {
				const specialists = params.specialists?.map((focus) => focus.trim()).filter((focus) => focus !== "");
				if (specialists !== undefined && specialists.length > 2) {
					return textResult("At most 2 specialists — the generalist makes the third.");
				}
				const count =
					specialists !== undefined ? 1 + specialists.length : Math.floor(params.count ?? DEFAULT_TESTERS);
				if (count < 1 || count > MAX_TESTERS) {
					return textResult(`Tester count must be between 1 and ${MAX_TESTERS}.`);
				}
				const override = resolveModelOverride((params.model ?? "").trim(), ctx);
				if (typeof override === "string") return textResult(override);
				const run = await startRun(
					count,
					(params.focus ?? "").trim(),
					ctx,
					override?.model,
					override?.thinkingLevel,
					specialists,
				);
				return textResult(
					`Run '${run.slug}' started: ${count} testers dispatched; the kickoff brief arrives as a follow-up message. Call 'wait' to follow the run.`,
				);
			}

			if (params.action === "resume") {
				const error = await resumeRun(params.run ?? "", ctx);
				return textResult(
					error !== ""
						? error
						: "Resumed: the testers were re-spawned from their diaries; the kickoff brief arrives as a follow-up message. Call 'wait' to follow the run.",
				);
			}

			if (params.action === "wait") {
				const diskStatus = activeRun === undefined ? undefined : store.readRun(activeRun)?.status;
				// Nothing dispatched here, or the run was stopped underneath the
				// roster: point the supervisor at the resume path, not a wait loop.
				if (testers.length === 0 || (diskStatus !== undefined && diskStatus !== "testing")) {
					const interrupted = store
						.listRuns()
						.filter((run) => run.status !== "complete")
						.map((run) => run.slug);
					return textResult(
						"No testers are running in this session." +
							(interrupted.length > 0
								? ` Interrupted run(s) on disk: ${interrupted.join(", ")} — resume one with action 'resume' (or /battletest resume <slug>).`
								: " Start a run with /battletest."),
					);
				}
				const limit = Math.max(1, Math.min(params.seconds ?? DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS)) * 1000;
				const deadline = Date.now() + limit;
				// Repaint every few seconds so per-tester ticket counts tick up
				// live in the widget while the parent sits in this wait.
				let polls = 0;
				while (!allFinished() && clearances.size === 0 && Date.now() < deadline && signal?.aborted !== true) {
					await new Promise((resolve) => setTimeout(resolve, 500));
					if (++polls % 8 === 0) paint(ctx);
				}
				paint(ctx);
				if (clearances.size > 0) {
					const requests = [...clearances.values()]
						.map(
							(entry) =>
								`- [${entry.id}] ${entry.persona} wants to: ${entry.action}${entry.risk ? ` — risk: ${entry.risk}` : ""} (area: ${entry.area})`,
						)
						.join("\n");
					return textResult(
						`${clearances.size} clearance request(s) pending — the tester is paused until you rule:\n${requests}\n\n` +
							"Judge each against the safety doctrine: deny anything that buys, subscribes, creates a real " +
							"account, sends real data anywhere, or deletes/changes data the app manages — deny when in " +
							"doubt. Allow only actions with no real-world footprint. Record each ruling with action " +
							"'decide' (clearance, verdict allow|deny, guidance?), then call 'wait' again.",
					);
				}
				const filed = new Map<string, number>();
				const allTickets = activeRun === undefined ? [] : store.listTickets(activeRun);
				for (const ticket of allTickets) filed.set(ticket.persona, (filed.get(ticket.persona) ?? 0) + 1);
				const tickets = allTickets.length;
				// Deltas since the last wait, so the parent can narrate the run
				// to the user instead of everyone flying blind until the report.
				const fresh = allTickets.filter((ticket) => !reportedTickets.has(ticket.slug));
				for (const ticket of fresh) reportedTickets.add(ticket.slug);
				const findings =
					fresh.length === 0
						? "No new tickets since the last check."
						: `NEW FINDINGS since the last check:\n${fresh
								.map((t) => `- [${t.severity}/${t.category}] ${t.title} — ${t.persona} in ${t.area || "?"}`)
								.join("\n")}`;
				const roster = testers
					.map((tester) => {
						const count = filed.get(tester.persona.slug) ?? 0;
						const actions = tester.driver?.actions?.() ?? 0;
						const delta = actions - (reportedActions.get(tester.persona.slug) ?? 0);
						reportedActions.set(tester.persona.slug, actions);
						const timing = tester.driver?.metricsSummary?.();
						const activity = timing ? describeSummary(timing) : `${actions} actions`;
						const spent = testerTokenLabel(tester);
						const area =
							activeRun !== undefined && tester.status === "testing"
								? store.latestNoteArea(activeRun, tester.persona.slug)
								: undefined;
						const line =
							`- ${tester.persona.name} (${tester.persona.archetype}): ${activity}` +
							(spent !== "" ? ` · ${spent}` : "") +
							` (+${delta}), ${count} ticket${count === 1 ? "" : "s"}${area ? `, now in '${area}'` : ""} · ${tester.status}`;
						if (tester.status === "completed" && tester.summary !== "") return `${line} — ${tester.summary}`;
						if (tester.status === "errored") return `${line} — ${tester.error.split("\n")[0] ?? ""}`;
						return line;
					})
					.join("\n");
				// The testers' spend since the last wait rides back as this tool
				// call's own usage, so the turn's token counter and the session
				// stats carry the WHOLE run's cost, not just the parent's chatter.
				const totals = testerTokenTotals();
				const spent = {
					input: Math.max(0, totals.input - reportedTokens.input),
					output: Math.max(0, totals.output - reportedTokens.output),
					cost: Math.max(0, totals.cost - reportedTokens.cost),
				};
				reportedTokens.input = totals.input;
				reportedTokens.output = totals.output;
				reportedTokens.cost = totals.cost;
				const usage =
					spent.input + spent.output > 0
						? {
								input: spent.input,
								output: spent.output,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: spent.input + spent.output,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: spent.cost },
							}
						: undefined;
				if (!allFinished()) {
					return {
						...textResult(
							`${running().length} of ${testers.length} testers still going after ${Math.round(limit / 1000)}s; ${tickets} tickets total.\n\n${findings}\n\nROSTER:\n${roster}\n\nGive the user a compact progress update now — two or three plain-language lines drawn from the new findings and roster above — then call 'wait' again.`,
						),
						usage,
					};
				}
				synthesisDue = false;
				return {
					...textResult(
						`All ${testers.length} testers have finished; ${tickets} tickets filed.\n\n${findings}\n\nROSTER:\n${roster}\n\nNow synthesize as instructed: view the run, read the notes, dedupe the tickets, write the report.`,
					),
					usage,
				};
			}
			return textResult(JSON.stringify(battleTestTool(store, params)));
		},
	});

	smolt.registerCommand("battletest", {
		description:
			"Send simulated users through the app, in plain language: e.g. /battletest 15 subagents " +
			"using opencode minimax-m3 to test a feature. /battletest resume [slug] continues an interrupted run",
		getArgumentCompletions: (argumentPrefix) => {
			const items = [
				{ value: "3", label: "3", description: "A small team (default)" },
				{ value: "5", label: "5", description: "A broader spread of personas" },
				{
					value: "using",
					label: "using",
					description: "Plain language: /battletest 15 subagents using provider model to test X",
				},
				{ value: "status", label: "status", description: "How the current run is going" },
				{ value: "stop", label: "stop", description: "Halt every tester in the current run" },
				{ value: "resume", label: "resume", description: "Continue an interrupted run from its diaries" },
				{ value: "report", label: "report", description: "Synthesize the latest finished run now" },
				{ value: "ledger", label: "ledger", description: "The cross-run issue ledger: open, fixed, regressed" },
			];
			const prefix = argumentPrefix.trim().toLowerCase();
			return items.filter((item) => item.value.startsWith(prefix));
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const [first = "", ...rest] = trimmed.split(/\s+/);
			const verb = first.toLowerCase();

			if (verb === "status") {
				if (testers.length === 0) {
					ctx.ui.notify("No battletest run in this session. Start one with /battletest <count>.", "info");
					return;
				}
				const tickets = activeRun === undefined ? 0 : store.listTickets(activeRun).length;
				ctx.ui.notify(
					`Run ${activeRun}: ${running().length}/${testers.length} still testing, ${tickets} tickets.\n` +
						testers
							.map((tester) => `${tester.persona.name} (${tester.persona.archetype}): ${tester.status}`)
							.join("\n"),
					"info",
				);
				return;
			}

			if (verb === "ledger") {
				// Real content belongs in the chat, not a toast: the agent reads
				// the ledger and presents it. A truly empty project (no runs at
				// all) is the one case a quiet notify answers better.
				if (store.listLedger().length === 0 && store.listRunSlugs().length === 0) {
					ctx.ui.notify(
						"Nothing in the ledger yet — it builds itself as battletest runs file tickets. Start a run with /battletest and it fills in on its own.",
						"info",
					);
					return;
				}
				smolt.sendUserMessage(ledgerPrompt());
				return;
			}

			if (verb === "stop") {
				const drained = (await previous?.stop()) ?? 0;
				const stopped = await stopAll(true);
				synthesisDue = false;
				paint(ctx);
				let message = stopped === 0 ? "No testers were running." : `Stopped ${stopped} tester(s).`;
				if (drained > 0) {
					message += ` Also stopped ${drained} leftover tester(s) from a previous session instance.`;
				}
				ctx.ui.notify(message, "info");
				return;
			}

			if (verb === "resume") {
				const error = await resumeRun(rest.join(" "), ctx);
				ctx.ui.notify(
					error !== ""
						? error
						: `Resumed ${activeRun}: testers re-spawned from their diaries; follow with the battletest 'wait' action.`,
					error === "" ? "info" : "error",
				);
				return;
			}

			if (verb === "report") {
				const run = store.resolveRun(rest.join(" "));
				if (!run) {
					ctx.ui.notify("No battletest runs exist yet.", "info");
					return;
				}
				synthesisDue = false;
				smolt.sendUserMessage(synthesisInstructions(run.slug));
				return;
			}

			if (running().length > 0) {
				ctx.ui.notify(
					`A run is already going (${running().length} testers). /battletest stop first, or wait for it.`,
					"warning",
				);
				return;
			}

			// Plain language first, historic positional forms kept working by
			// the same parser: leading digits stay a bare count.
			const parsed = parseBattletestInvocation(trimmed, ctx.modelRegistry.getAll());
			// A model several providers carry is picked, not asked about: the
			// session's own provider first, then subscriptions, aggregators last.
			if (parsed.error !== undefined && parsed.ambiguous !== undefined) {
				const picked = pickAmbiguousModel(parsed.ambiguous, ctx);
				if (picked) {
					parsed.model = picked;
					parsed.error = undefined;
					ctx.ui.notify(`Model resolved to ${picked.provider}/${picked.id}.`, "info");
				}
			}
			if (parsed.error !== undefined) {
				ctx.ui.notify(parsed.error, "error");
				return;
			}
			if (parsed.model !== undefined && !ctx.modelRegistry.hasConfiguredAuth(parsed.model)) {
				ctx.ui.notify(
					`No API key configured for provider "${parsed.model.provider}" — every tester would fail. Configure it first.`,
					"error",
				);
				return;
			}
			// No count stated: the supervising agent sizes the team itself.
			// Most projects need one balanced generalist; a few earn a
			// specialist or two — that judgment needs a look at the project,
			// which the parent can take and a slash command cannot.
			if (parsed.count === undefined) {
				smolt.sendUserMessage(
					teamPlanPrompt(parsed.focus, parsed.model ? `${parsed.model.provider}/${parsed.model.id}` : undefined),
				);
				return;
			}
			const count = parsed.count;
			if (count < 1 || count > MAX_TESTERS) {
				ctx.ui.notify(`Tester count must be between 1 and ${MAX_TESTERS}.`, "error");
				return;
			}
			await startRun(count, parsed.focus, ctx, parsed.model, parsed.thinkingLevel);
		},
	});

	const handle: BattleTestHandle = {
		testers: () => testers,
		activeRun: () => activeRun,
		stop: async () => stopAll(false),
	};
	latestInstance = handle;
	return handle;
}
