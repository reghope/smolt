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
import {
	type BrowseDriver,
	type BrowseDriverFactory,
	defaultBrowseDriverFactory,
	VIEWPORT_PRESETS,
} from "../battletest/cdp.ts";
import { parseBattletestInvocation, pickAmbiguousModel, resolveModelOverride } from "../battletest/parse.ts";
import { CHILD_SHELL_TIMEOUT_SECONDS, type ChildDriver, spawnChildSession } from "../battletest/spawn.ts";
import {
	ANGLE_NAMES,
	type AnglePick,
	describeResearcher,
	generateResearchers,
	generateResearchTeam,
	parseAnglePick,
	type Researcher,
} from "./angles.ts";
import {
	CONFIDENCES,
	FINDING_KINDS,
	FINDING_STATUSES,
	QUESTION_STATUSES,
	type ResearchFinding,
	type ResearchQuestion,
	type ResearchRun,
	ResearchStore,
	researchTool,
} from "./store.ts";
import { DEFAULT_MAX_CHARS, type FetchAs, type FetchImpl, fetchPage, webSearch } from "./web.ts";

/**
 * Research: a team of investigators goes after a subject and stops at
 * nothing short of the answer.
 *
 * `/research <subject>` deals a team — a source diver, an observer, a
 * network sleuth, a historian, whoever the deck turns up — and spawns each
 * as its own background agent session on the same foundation as battletest:
 * a private browser, a diary, a shared record, a supervisor watching the
 * roster. Where a tester files tickets, a researcher files findings, each
 * with a confidence and its sources; and the team works a question map —
 * the sharp sub-questions the subject decomposes into, with blocking edges,
 * claims, and a computed frontier — the part of wayfinder worth keeping.
 *
 * Every researcher climbs the same ladder: fetch the raw page and its
 * source; browse it headless and read what the page renders, requests, and
 * runs; relaunch a visible browser when a site refuses the headless one;
 * pull repositories, packages, bundles, source maps and archives from the
 * shell; reproduce and measure. A lead is exhausted only when the reason is
 * on record. When the last researcher finishes, the parent synthesizes: the
 * answer first, then the evidence, the contradictions, the dead ends, and
 * what is still open — and, if open questions remain takeable, dispatches
 * the next wave instead of settling for a partial answer.
 */

/** More researchers than this stops being a team and starts being a crawler farm. */
const MAX_RESEARCHERS = 25;

const DEFAULT_RESEARCHERS = 3;

/** Longest a single `wait` blocks before reporting researchers still at it. */
const DEFAULT_WAIT_SECONDS = 120;
const MAX_WAIT_SECONDS = 600;

/** Base for per-researcher debugging ports, offset by index; clear of battletest's range. */
const DEBUG_PORT_BASE = 9433;

/** Waves beyond this on one run mean the subject is not converging; the supervisor reports instead. */
const MAX_WAVES = 4;

/**
 * Researchers run at medium thinking by default: unlike a tester clicking
 * through screens, a researcher's work is judgment — what to chase, what
 * counts as proof, when a lead is dead — and low thinking measurably gave up
 * early. A per-run model/thinking override still wins.
 */
const RESEARCHER_THINKING: ThinkingLevel = "medium";

/** Action budget per tenacity — tool actions, one per step of the investigation. */
const ACTION_BUDGETS: Record<Researcher["traits"]["tenacity"], number> = {
	dogged: 70,
	relentless: 100,
	obsessive: 140,
};

/** Confidence weighting for the end-of-run score: what a researcher's findings are worth. */
const CONFIDENCE_POINTS: Record<string, number> = { confirmed: 4, likely: 2, unverified: 1, contradicted: 1 };
/** An answered question is the run's real product; weighted accordingly. */
const QUESTION_POINTS = 5;

/**
 * The newest extension instance in this process. Reloading a session re-runs
 * every extension factory while the old instance's researchers may still be
 * running in the background — the new instance reaches the old one through
 * this module slot, so a resume or a stop can drain the leftovers.
 */
let latestInstance: ResearchHandle | undefined;

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
}

// ------------------------------------------------------------------
// Roster
// ------------------------------------------------------------------

export type ResearcherStatus = "researching" | "completed" | "errored" | "stopped";

export type ResearcherDriver = ChildDriver;

export interface ResearcherSlot {
	researcher: Researcher;
	status: ResearcherStatus;
	/** The researcher's closing summary. */
	summary: string;
	error: string;
	/** The full brief this researcher ran under, kept for the end-of-run record. */
	task?: string;
	driver?: ResearcherDriver;
}

function budgetFor(tenacity: Researcher["traits"]["tenacity"]): number {
	return ACTION_BUDGETS[tenacity];
}

export type ResearcherSpawner = (
	options: {
		researcher: Researcher;
		task: string;
		customTools: ToolDefinition[];
		ctx: ExtensionContext;
		model?: Model<Api>;
		thinkingLevel?: ThinkingLevel;
		metricsPath?: string;
	},
	onFinish: (status: "completed" | "errored", detail: string) => void,
) => Promise<ResearcherDriver>;

/**
 * The real spawner: one background AgentSession per researcher. `edit` is
 * excluded — a researcher never patches the project it runs in; everything
 * it builds or clones lives under its own scratch directory, where `write`
 * and the shell are enough.
 */
const defaultSpawner: ResearcherSpawner = (options, onFinish) =>
	spawnChildSession(
		{
			task: options.task,
			customTools: options.customTools,
			ctx: options.ctx,
			model: options.model,
			thinkingLevel: options.thinkingLevel,
			defaultThinkingLevel: RESEARCHER_THINKING,
			metricsPath: options.metricsPath,
			excludeTools: ["edit"],
			shellTimeoutSeconds: CHILD_SHELL_TIMEOUT_SECONDS,
		},
		onFinish,
	);

// ------------------------------------------------------------------
// Prompts
// ------------------------------------------------------------------

/** A hosted target named in the subject, resolved once so every brief points at it. */
export function extractTargetUrls(subject: string): string[] {
	return [...new Set([...subject.matchAll(/(https?:\/\/[^\s"'<>)]+)/g)].map((match) => match[1]!))];
}

export interface ResumeBrief {
	spent: number;
	diary: string;
	filed: string[];
}

const DIARY_LIMIT = 6000;

function trimDiary(raw: string): string {
	const text = raw.trim();
	if (text.length <= DIARY_LIMIT) return text;
	return `(older entries trimmed)\n${text.slice(text.length - DIARY_LIMIT)}`;
}

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

function readDiary(path: string): string {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return "";
	}
}

function resumeSection(brief: ResumeBrief, profileDir: string): string {
	const filed =
		brief.filed.length === 0 ? "(none so far)" : `\n${brief.filed.map((line) => `  - ${line}`).join("\n")}`;
	return `

RESUMING AN INTERRUPTED SESSION
Your previous session was cut off mid-investigation — the machine running you restarted — and you are the same researcher, continuing the same run. Everything you recorded survived:
- Your diary so far; this is exactly where you left off:
${brief.diary}
- Findings you already filed (never refile these):${filed}
You already spent about ${brief.spent} actions before the interruption; the budget below is what remains. Any browser you had is gone — the browse tool relaunches on its first call, on the same port and profile under '${profileDir}', so cookies and cache from before are still yours. Re-read the question map, re-claim what you were working, and continue where your diary stops.`;
}

/** What earlier runs already learned about a related subject, so the team starts from it. */
function priorKnowledgeBrief(store: ResearchStore, run: ResearchRun): string {
	const tokens = new Set(
		run.subject
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((word) => word.length > 3),
	);
	if (tokens.size === 0) return "";
	const related = store
		.listRuns()
		.filter((other) => other.slug !== run.slug && other.status === "complete" && store.readReport(other.slug))
		.map((other) => {
			const words = other.subject
				.toLowerCase()
				.split(/[^a-z0-9]+/)
				.filter((word) => word.length > 3);
			const overlap = words.filter((word) => tokens.has(word)).length;
			return { other, overlap };
		})
		.filter((entry) => entry.overlap >= 2)
		.sort((a, b) => b.overlap - a.overlap)
		.slice(0, 3);
	if (related.length === 0) return "";
	const lines = related
		.map((entry) => `- '${entry.other.title}' — report: ${store.reportPath(entry.other.slug)}`)
		.join("\n");
	return `\n\nWHAT EARLIER RUNS ALREADY FOUND\nThis project has researched related subjects before. Read these reports FIRST (with the read tool) and build on them — re-confirming what they settled is wasted budget, but a claim they left unverified or a question they left open is exactly where to dig:\n${lines}`;
}

/** The question map as a brief sees it: what is settled, what is takeable, what waits. */
function questionMapBrief(store: ResearchStore, runSlug: string): string {
	const map = store.questionMap(runSlug);
	if (map.open + map.closed.length === 0) {
		return "The question map is empty so far: the first thing the team does is decompose the subject into sharp questions (notebook action 'question'), then claim and work them.";
	}
	const line = (question: ResearchQuestion, extra = ""): string => `- [${question.slug}] ${question.title}${extra}`;
	const parts: string[] = [];
	if (map.closed.length > 0) {
		parts.push(
			`Settled (${map.answered} answered, ${map.deadEnds} dead ends, ${map.outOfScope} out of scope):\n${map.closed
				.slice(0, 20)
				.map((question) => line(question, ` — ${question.status}: ${question.gist ?? ""}`))
				.join("\n")}`,
		);
	}
	if (map.frontier.length > 0) {
		parts.push(
			`TAKEABLE NOW (open, unblocked, unclaimed):\n${map.frontier.map((question) => line(question)).join("\n")}`,
		);
	}
	if (map.claimed.length > 0) {
		parts.push(
			`Being worked by someone else (do not take):\n${map.claimed.map((question) => line(question, ` — ${question.claimedBy}`)).join("\n")}`,
		);
	}
	if (map.blocked.length > 0) {
		parts.push(
			`Waiting on other questions:\n${map.blocked.map((question) => line(question, ` — after ${question.blockedBy.join(", ")}`)).join("\n")}`,
		);
	}
	return parts.join("\n\n");
}

function researcherPrompt(
	researcher: Researcher,
	run: ResearchRun,
	index: number,
	teamSize: number,
	profileDir: string,
	port: number,
	resume: ResumeBrief | undefined,
	priorKnowledge: string,
	questionMap: string,
): string {
	const traits = researcher.traits;
	const targets = extractTargetUrls(run.subject);
	const budget =
		resume === undefined ? budgetFor(traits.tenacity) : Math.max(20, budgetFor(traits.tenacity) - resume.spent);
	const notes = run.notes.trim() === "" ? "" : `\nStanding context from the person who asked:\n${run.notes.trim()}`;
	const targetLine =
		targets.length === 0
			? ""
			: `\nThe subject names ${targets.length === 1 ? "a site" : "sites"} directly — ${targets.join(", ")} — so that is where the answer lives: use it, read it, read its source, watch its traffic. Launch nothing locally unless you are reproducing something.`;
	const fogLine =
		run.fog.length === 0 ? "" : `\nThings sensed but not yet sharp enough to be questions: ${run.fog.join("; ")}.`;
	return `You are ${researcher.name}, an investigator on a research team. Someone needs a real answer and has asked this team to find it, whatever it takes. You are not writing an essay from what you already know: you go and look.

THE SUBJECT
${run.subject}${notes}${targetLine}${fogLine}

WHO YOU ARE
${researcher.description}
You especially look for: ${researcher.lens}.
You are ${traits.tenacity} (${traits.tenacity === "dogged" ? "you keep going past the first wall" : traits.tenacity === "relentless" ? "a blocked route is a reason to find another, not to stop" : "you do not stop until the thing is nailed down or every route is on record as exhausted"}); you are ${traits.rigor} about evidence (${traits.rigor === "accepting" ? "a credible source is enough for a 'likely'" : traits.rigor === "careful" ? "two independent sources, or one primary source, before you call anything confirmed" : "nothing is confirmed until you have seen it yourself — the code, the request, the behavior"}); and your scope is ${traits.scope} (${traits.scope === "narrow" ? "you go deep on your own angle and leave the rest to the team" : traits.scope === "wide" ? "you sweep the whole subject before going deep anywhere" : "you balance breadth and depth"}). Stay in character for the whole session — your traits should be visible in what you chase, how long you persist, and how you grade what you find.${resume === undefined ? "" : resumeSection(resume, profileDir)}${priorKnowledge}

THE QUESTION MAP — HOW THE TEAM DIVIDES THE WORK
The subject decomposes into sharp sub-questions, kept on a shared map with blocking edges and claims. You are researcher #${index + 1} of ${teamSize}. The map right now:
${questionMap}
Rules of the map:
- Before working a question, CLAIM it (notebook action 'claim', question = its slug). A fresh claim by someone else means it is theirs: take another. If the frontier is empty, ask new sharp questions or work leads from findings.
- When the subject's map is thin, ADD questions (notebook action 'question': title, text, blocked_by?). A good question is one whose answer would settle part of the subject and can be stated precisely now; vague hunches go in your diary, not on the map. Prefer questions from your own angle — that is why you are on the team.
- When you have the answer, ANSWER it (notebook action 'answer': question, answer, gist). The answer carries the substance AND the URLs, files, or commands that back it; the gist is one line the report's index shows. If a question turns out unanswerable by any route, answer it with status 'dead-end' and the record of everything you tried.
- Every finding you file should name the question it bears on when it bears on one.

YOUR TOOLS AND THE LADDER YOU CLIMB — STOP AT NOTHING
You have four tools beyond the shell, and a ladder of escalation. A route that fails is a reason to take the next rung, never a reason to stop:
1. search (query): find where things live — docs, repos, packages, discussions, archived pages. Vary the query; search the exact error text, the exact phrase, the site: operator (site:github.com), the product plus "source", "api", "changelog", "reverse engineer".
2. fetch (url, as = text | html | json | links | scripts | headers): the raw page as a crawler sees it. 'text' to read it; 'html' for the markup; 'scripts' for the bundle URLs a page loads (then fetch each bundle as 'text' and read the code); 'links' to map a site; 'json' for APIs; 'headers' for server, caching, and security headers. Big pages truncate — pass max_chars, or fetch the specific page you need.
3. browse: your own real Chrome, headless, on port ${port} with a profile under '${profileDir}' (the other ${teamSize - 1} researchers have their own). 'goto' a URL and STUDY the screenshot; 'text' for the rendered content (what fetch cannot see on a script-built page); 'html' for the live DOM; 'links'; 'network' for every request the page has made since you last asked — endpoints, methods, status codes, types: this is how you see the API behind a UI; 'eval' to read page state (window.__DATA__, localStorage, performance.getEntries()); 'click' / 'type' / 'press' / 'scroll' to use the thing the way its users do; 'viewport' to resize.
4. When a site refuses you — 403, 429, a "just a moment" page, an empty shell, content that only appears for a real browser — do NOT give up and do NOT hammer it. Climb: fetch blocked → browse it headless. Headless refused → browse action 'relaunch' with headed = true: a visible Chrome window, which most bot checks accept, then carry on exactly as before. Still refused → the shell: curl with a browser user agent and the right Accept headers, the site's public API if one exists, its sitemap, its RSS, web.archive.org/web/2025/<url> for an archived copy, a cached copy in a search engine, a mirror, the same content in the product's public repository or package. Something always shows the mechanism; find it. Never solve or bypass a CAPTCHA, never log in, never pay, never pretend to be someone — those are walls you record, not walls you climb.
5. The shell is for what the web tools cannot do: git clone public repositories into '${profileDir}', download and unpack packages (npm pack, pip download, a release tarball), grep a bundle for the strings you saw in the UI, follow a //# sourceMappingURL to the source map and read its sourcesContent, run code to reproduce a behavior, call an endpoint with curl and compare with what the browser sent, time things. Keep every file under '${profileDir}'.
6. Cross-check. A claim in a blog post is 'unverified' until the code, the traffic, or an independent source agrees; then it is 'likely' or 'confirmed'. Two sources that disagree are a 'contradiction' finding — file it, do not pick a side silently.
A lead is exhausted only when your diary says WHY, and a route you could not take is a 'dead-end' finding with what you tried, so the supervisor can send someone else down it.

RECORD EVERYTHING with the notebook tool as you go:
- action 'note' (topic, text): your running diary in your own voice — what you tried, what you found, what it means, what you will try next. Note after every meaningful step, not in one dump at the end. The topic is where in the subject you are; it is shown live to the person watching.
- action 'finding' (title, confidence, kind, topic, what, evidence, sources, question?): one finding per distinct thing learned. confidence: confirmed (you saw it yourself: the code, the request, the behavior, or two independent primary sources agree) / likely (one primary source, or several credible secondary ones) / unverified (a single claim you could not check) / contradicted (sources disagree, or you disproved it). kind: fact / mechanism (how it works) / source (where the code or data lives) / observation (what you saw it do) / lead (worth chasing, not yet chased) / dead-end (what could not be reached, and why) / contradiction. 'sources' is a list of the URLs, files, or commands the evidence came from — a finding without sources is an opinion. 'what' says the thing; 'evidence' quotes it: the line of code, the request, the exact text, the number you measured.
- One thing, one finding, across the whole team: if your filing comes back with duplicate_of, another researcher has it. Add what is new with action 'append' (finding, text, sources?) and move on. Refile with force = true only when yours is really a different thing.
- Cite as you go: exact URLs, not "the docs". The report is only as good as its sources.

YOUR BUDGET
About ${budget} tool actions, fitting how ${traits.tenacity} you are. Two stop rules, whichever comes first: the budget runs low, or your last ~12 actions taught you nothing new AND every route you can think of is on record. Then file outstanding findings, answer or release your claimed questions, write the closing note, and finish — the supervisor dispatches another wave if questions remain, so an honest handoff beats a heroic overrun.

SAY WHAT YOU ARE DOING, IN THE CALL ITSELF
The run's live roster shows what each researcher is doing right now, straight from your tool calls:
- Every browse, fetch, and search call: fill the 'doing' argument with 2-5 present-tense words ("reading the checkout bundle", "watching login requests").
- Every shell command: start it with a comment line naming the intent, e.g. \`# cloning the SDK repo\` then the command. Same for powershell.
Keep it honest and specific — a person watching the run reads it.

HARD RULES
- Never modify this project's source, config, or data. You are investigating, not building; everything you make lives under '${profileDir}'.
- Be a polite visitor: one request at a time to a host, a pause between them, back off when a site rate-limits you, never parallel-bomb a site from the shell. Research reads; it never floods.
- Never sleep longer than 5 seconds in one call: poll in short calls so the supervisor sees you moving. Shell calls are stopped after ${CHILD_SHELL_TIMEOUT_SECONDS} seconds unless you pass a timeout.
- Do not pad findings with what you already believed. If you did not look, you do not know.

SAFETY — JUDGE EVERY ACTION YOURSELF, NEVER ASK A HUMAN
No human watches this run, and it must not stop for permission. Before every action, judge it yourself; when you are genuinely unsure whether an action crosses a line, request clearance (notebook action 'clearance': topic, text = the exact action, risk = why it might be unsafe) — a supervising agent rules on it, your session pauses until the ruling arrives, and you obey it either way. Forbidden outright, never escalated:
- Logging in anywhere, creating accounts, entering credentials, personal data, or payment details; using anyone's session or cookies but your own fresh profile's.
- Solving, bypassing, or automating past CAPTCHAs, bot checks, paywalls, or authentication — a wall like that is a dead-end finding, and the ladder goes AROUND it (public API, archive, repository, mirror), never through it.
- Sending anything that reaches a real person or service: forms, messages, sign-ups, uploads, orders, comments.
- Collecting private or personal information about individuals; the subject is a thing, not a person.
- Anything destructive or disruptive: no deleting or changing data anywhere, no load that could hurt a site, no probing for vulnerabilities.
Reading what a site serves to any visitor, in a real browser if it insists on one, is research; everything above is not.

When you have taken the subject as far as your angle can, file any remaining findings, answer or release your claimed questions, write one final 'note' (topic 'overall') with your closing view, then finish. Your final reply is read by another agent: three to five sentences — the answer to the subject as you now see it and how confident you are, how many findings you filed and questions you answered, and the biggest thing still open.`;
}

/** `/research` with no count: the supervising agent picks the team first. */
function teamPlanPrompt(subject: string, modelRef?: string): string {
	return `Plan a research team, then start the run.

The subject: ${subject}

1. Scout for a minute — what kind of question is this? A site or product whose mechanism is wanted (then the answer is in its pages, source, and traffic), a technology or practice (docs, repos, discussions), a market or comparison (many sources, cross-checked), or something in this repository (read it first). If the subject names a URL, open it once yourself with the fetch tool to see what you are dealing with. A look, not a study.
2. Pick the team from the angle deck, one to three researchers, each an angle chosen for THIS subject: ${ANGLE_NAMES.join(", ")}. Match angles to the kind of question — a site or product's mechanism wants an observer (uses it and watches), a network-sleuth (reads its traffic) and a source-diver (reads its code); a technology or practice wants a documentarian, a source-diver and an experimenter; a market or comparison wants a documentarian, a community-listener and a comparator; a "how did it get this way" wants a historian. Add a verifier whenever the answer will rest on claims that need checking against each other. Narrow an angle to the subject with a focus after a colon: 'network-sleuth: the checkout flow'. One well-aimed researcher is enough for a narrow question; three when the subject has distinct halves. Past runs' form is in .smolt/research/form.jsonl if it exists — weigh which angles have actually found things before.
3. Optionally seed the question map: pass 'questions' — up to 6 sharp sub-questions whose answers would settle the subject — so the team starts on the frontier instead of decomposing from scratch. Only questions you can state precisely now; the team adds the rest.
4. Start the run: research action 'start' with your angles array, subject: '${subject.replace(/'/g, "\\'")}'${modelRef ? `, model: '${modelRef}'` : ""}. ${modelRef ? "" : "Do NOT pass a model — researchers run on the session's own model unless the user names one. "}The kickoff brief for supervising the run arrives as a follow-up message.`;
}

/** Shared tail of the kickoff and settle prompts: how to synthesize a finished wave. */
function synthesisInstructions(runSlug: string): string {
	return `Synthesize run '${runSlug}':
1. Orient: research action 'view' for the team, the question map, the findings by confidence, the notes paths, and the metrics summaries. Read every researcher's notes file, and view_finding / view_question anything you need in full.
2. Judge the map: is the subject answered? Look at the open questions and the 'lead' and 'dead-end' findings. If takeable questions remain and the run is under its wave limit, DISPATCH ANOTHER WAVE — research action 'continue' with 'angles' picked for the open questions and dead ends (a source-diver for an unread bundle, a historian for a "since when", a verifier for contested claims) — and go back to the wait loop; write no report yet. Stop at nothing means the team keeps going while there is somewhere left to go. Do write the report when the map is settled, when what remains is out of scope or a wall no legitimate route gets around, or when the wave limit is reached — and say which.
3. Dedupe and grade: where researchers found the same thing, keep the best-evidenced finding and mark the rest update_finding status 'duplicate' plus duplicate_of. Where a finding was disproved by another, mark it 'refuted'. Promote a finding to 'verified' only when the evidence across researchers supports it. Answer any open question the findings actually settle (action 'answer').
4. Time the run: read the metrics summaries (per researcher: wall clock, actions, time inside tools vs thinking, per-tool totals and error counts, the slowest actions). Name the bottlenecks. performance.json scores every researcher; name the strongest so future teams can be picked on form.
5. Write the report with action 'write_report': ## Answer (the direct answer to the subject, first, in plain language — what someone who asked this wants to know, with the confidence you have in it), ## How it works / What we found (the substance by theme, every claim carrying its source as a markdown link), ## Evidence (each non-duplicate finding: title, confidence, kind, who found it, one line, its sources), ## Questions (every question on the map with its status and gist; open ones flagged), ## Contradictions and open questions, ## Dead ends (what could not be reached and why — the walls, so nobody re-runs into them), ## Sources (every URL, deduplicated), ## Run performance, ## What to do next.
6. Then show me the findings here in chat: THE ANSWER first, then the key evidence with markdown links, then what is still open, and where the report and findings live. "Recorded in the report" is not a summary — I must be able to judge the answer from your message alone, without opening anything.`;
}

function teamList(run: ResearchRun, wave: number): string {
	return run.researchers
		.filter((researcher) => (researcher.wave ?? 1) === wave)
		.map((researcher) => `- ${describeResearcher(researcher)}`)
		.join("\n");
}

function watchLoopInstructions(): string {
	return `While they work, stay on watch: call the research tool with action 'wait' (seconds up to ${MAX_WAIT_SECONDS}) and keep calling it each time it returns with researchers still going — do not start unrelated work between waits. Every wait returns the run's deltas: new findings, newly answered questions, and each researcher's activity and current topic. KEEP ME POSTED: after each wait that reports anything new, give me a compact plain-language progress update (two or three lines — the notable new findings with their confidence, which questions fell, who is where) before waiting again; if a check-in has nothing new, a single quiet line is enough. Use the remaining gap to triage: mark obvious duplicates with update_finding status 'duplicate' as they appear, add sharp questions the findings raise (action 'add_question') so the frontier stays stocked, and answer questions the findings already settle — never let triage delay a clearance ruling. If a straggler drags on long after the rest have finished, send it action 'wrap_up'. 'wait' also returns early when a researcher requests clearance for a possibly-risky action: judge each request against the safety doctrine (deny anything that logs in, creates accounts, pays, bypasses a bot check or paywall, sends real data anywhere, collects personal data, or could disrupt a site — deny when in doubt; allow reading what a site serves any visitor, a visible browser included), record every ruling with action 'decide', and go straight back to 'wait' — the researcher is paused until you answer.`;
}

function kickoffPrompt(run: ResearchRun, model?: Model<Api>): string {
	const modelNote = model ? ` Every researcher runs on ${model.provider}/${model.id}.` : "";
	const wave = run.wave;
	const team = run.researchers.filter((researcher) => (researcher.wave ?? 1) === wave);
	const heading =
		wave === 1
			? `A research run '${run.slug}' has started: ${team.length} investigator${team.length === 1 ? "" : "s"} ${team.length === 1 ? "is" : "are"} working the subject right now, each in their own background session.`
			: `Wave ${wave} of research run '${run.slug}' has started: ${team.length} fresh investigator${team.length === 1 ? "" : "s"} dispatched at the open frontier, each in their own background session.`;
	return `${heading}${modelNote}

The subject: ${run.subject}

The team:
${teamList(run, wave)}

${watchLoopInstructions()}

When 'wait' reports every researcher finished, ${synthesisInstructions(run.slug)}`;
}

function resumeKickoffPrompt(run: ResearchRun, drained: number): string {
	return `A research run '${run.slug}' was interrupted mid-investigation — the session hosting its researchers was lost — and has now been resumed: the wave ${run.wave} team re-spawned from their own diaries, findings, and remaining budgets, continuing where they left off.${drained > 0 ? ` ${drained} leftover researcher(s) from the previous session instance were stopped first.` : ""}

The subject: ${run.subject}

The team:
${teamList(run, run.wave)}

${watchLoopInstructions()}

When 'wait' reports every researcher finished, ${synthesisInstructions(run.slug)}`;
}

// ------------------------------------------------------------------
// The notebook tool: a researcher's only line back to the run's record.
// ------------------------------------------------------------------

interface ClearanceRequest {
	action: string;
	risk: string;
	topic: string;
}

interface ClearanceVerdict {
	allowed: boolean;
	guidance: string;
}

const DEFAULT_CLEARANCE_TIMEOUT_MS = 5 * 60 * 1000;

const CLEARANCE_TIMEOUT_VERDICT: ClearanceVerdict = {
	allowed: false,
	guidance:
		"No supervisor ruling arrived in time. Treat this as denied: note it in your diary and take another route.",
};

function makeNotebookTool(
	store: ResearchStore,
	runSlug: string,
	researcher: Researcher,
	onChange: () => void,
	onClearance: (request: ClearanceRequest) => Promise<ClearanceVerdict>,
): ToolDefinition {
	return defineTool({
		name: "notebook",
		label: "Notebook",
		description:
			"Your record of the investigation and your line to the shared question map. Action 'note' (topic, " +
			"text) appends to your running diary — use it after every meaningful step. Action 'finding' " +
			"(title, confidence, kind, topic, what, evidence, sources, question?) files one distinct thing " +
			"learned, with the URLs/files/commands it came from; a filing that matches an existing finding is " +
			"bounced with its slug — 'append' (finding, text, sources?) what is new and move on, or refile with " +
			"force=true only if yours is truly different. Action 'question' (title, text, blocked_by?) adds a " +
			"sharp sub-question to the map; 'claim' (question) takes one before you work it; 'release' " +
			"(question) gives it back; 'answer' (question, answer, gist, status? answered|dead-end) closes it " +
			"with the substance and its sources. Action 'clearance' (topic, text = the exact action, risk) " +
			"asks the supervising agent to rule on a gray-zone action BEFORE you take it; the call blocks " +
			"until the ruling arrives, and you obey it. Never escalate the outright-forbidden (logins, " +
			"CAPTCHAs, payments, real submissions) — those are always denied.",
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("note"),
					Type.Literal("finding"),
					Type.Literal("append"),
					Type.Literal("question"),
					Type.Literal("claim"),
					Type.Literal("release"),
					Type.Literal("answer"),
					Type.Literal("clearance"),
				],
				{ description: "What to record" },
			),
			topic: Type.Optional(
				Type.String({ description: "Where in the subject: a component, mechanism, page, or theme name" }),
			),
			text: Type.Optional(
				Type.String({
					description:
						"For 'note': what you tried and found. For 'append': your new observations. For 'question': " +
						"the precise question. For 'clearance': the exact action you want to take.",
				}),
			),
			risk: Type.Optional(Type.String({ description: "For 'clearance': why this action might be unsafe" })),
			title: Type.Optional(Type.String({ description: "For 'finding' / 'question': one line naming it" })),
			confidence: Type.Optional(
				Type.Union(
					CONFIDENCES.map((confidence) => Type.Literal(confidence)),
					{
						description:
							"confirmed = seen yourself or two independent primary sources; likely = one primary or several credible secondary; unverified = a single unchecked claim; contradicted = sources disagree or disproved",
					},
				),
			),
			kind: Type.Optional(
				Type.Union(
					FINDING_KINDS.map((kind) => Type.Literal(kind)),
					{ description: "fact / mechanism / source / observation / lead / dead-end / contradiction" },
				),
			),
			what: Type.Optional(Type.String({ description: "For 'finding': the thing learned, stated plainly" })),
			evidence: Type.Optional(
				Type.String({
					description: "For 'finding': the proof, quoted — the code, the request, the exact text, the number",
				}),
			),
			sources: Type.Optional(
				Type.Array(Type.String(), { description: "URLs, file paths, or commands the evidence came from" }),
			),
			question: Type.Optional(
				Type.String({
					description: "Question slug: for 'claim' / 'release' / 'answer', or the question a 'finding' bears on",
				}),
			),
			answer: Type.Optional(
				Type.String({ description: "For 'answer': the full answer with the URLs that back it" }),
			),
			gist: Type.Optional(Type.String({ description: "For 'answer': one line for the report's index" })),
			status: Type.Optional(
				Type.Union([Type.Literal("answered"), Type.Literal("dead-end")], {
					description: "For 'answer': dead-end when no legitimate route reaches an answer (say what you tried)",
				}),
			),
			blocked_by: Type.Optional(
				Type.Array(Type.String(), { description: "For 'question': slugs that must be answered first" }),
			),
			finding: Type.Optional(Type.String({ description: "For 'append': the slug of the existing finding" })),
			force: Type.Optional(
				Type.Boolean({
					description:
						"For 'finding': file even though a similar finding exists — only when yours is genuinely different, with a title naming the difference. For 'claim': take over a stale claim.",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const topic = (params.topic ?? "").trim();
			if (params.action === "note") {
				if ((params.text ?? "").trim() === "")
					return textResult(JSON.stringify({ success: false, error: "a note needs 'text'" }));
				const result = store.appendNote(runSlug, researcher, topic, params.text ?? "");
				onChange();
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
					topic,
				});
				store.appendNote(
					runSlug,
					researcher,
					topic,
					`Requested clearance: ${(params.text ?? "").trim()} — ${verdict.allowed ? "ALLOWED" : "DENIED"}. ${verdict.guidance}`,
				);
				return textResult(JSON.stringify({ success: true, ...verdict }));
			}
			if (params.action === "append") {
				if ((params.finding ?? "").trim() === "" || (params.text ?? "").trim() === "")
					return textResult(JSON.stringify({ success: false, error: "append needs 'finding' and 'text'" }));
				const appended = store.appendToFinding(
					runSlug,
					params.finding ?? "",
					researcher.slug,
					params.text ?? "",
					params.sources,
				);
				if (appended.success === true) {
					onChange();
					return textResult(
						JSON.stringify({
							...appended,
							message: "Your observations were added. That is covered — move on to what nobody has found.",
						}),
					);
				}
				return textResult(JSON.stringify(appended));
			}
			if (params.action === "question") {
				const title = (params.title ?? "").trim();
				if (title === "") return textResult(JSON.stringify({ success: false, error: "a question needs 'title'" }));
				const result = store.addQuestion(runSlug, {
					title,
					question: (params.text ?? "").trim() || title,
					askedBy: researcher.slug,
					blockedBy: params.blocked_by,
				});
				onChange();
				return textResult(JSON.stringify(result));
			}
			if (params.action === "claim") {
				const result = store.claimQuestion(runSlug, params.question ?? "", researcher.slug, params.force === true);
				onChange();
				return textResult(JSON.stringify(result));
			}
			if (params.action === "release") {
				const result = store.releaseQuestion(runSlug, params.question ?? "", researcher.slug);
				onChange();
				return textResult(JSON.stringify(result));
			}
			if (params.action === "answer") {
				if ((params.question ?? "").trim() === "" || (params.answer ?? "").trim() === "")
					return textResult(JSON.stringify({ success: false, error: "answer needs 'question' and 'answer'" }));
				const result = store.answerQuestion(
					runSlug,
					params.question ?? "",
					researcher.slug,
					params.answer ?? "",
					params.gist,
					params.status === "dead-end" ? "dead-end" : "answered",
				);
				if (result.success === true) {
					store.appendNote(
						runSlug,
						researcher,
						topic || "questions",
						`${params.status === "dead-end" ? "Dead end" : "Answered"} [${String(result.question)}]: ${(params.gist ?? "").trim() || ((params.answer ?? "").split("\n")[0] ?? "")}`,
					);
					onChange();
					const unblocked = Array.isArray(result.unblocked) ? (result.unblocked as string[]) : [];
					return textResult(
						JSON.stringify({
							...result,
							message:
								unblocked.length > 0
									? `Recorded. That unblocked: ${unblocked.join(", ")} — claim one if it is in your angle.`
									: "Recorded. Take the next frontier question, or raise the ones your findings opened.",
						}),
					);
				}
				return textResult(JSON.stringify(result));
			}
			// finding
			const missing = ["title", "what"].filter(
				(field) => (((params as Record<string, unknown>)[field] as string | undefined) ?? "").trim() === "",
			);
			if (missing.length > 0) {
				return textResult(JSON.stringify({ success: false, error: `a finding needs: ${missing.join(", ")}` }));
			}
			const sources = (params.sources ?? []).map((source) => source.trim()).filter((source) => source !== "");
			if (params.force !== true) {
				const dup = store.findSimilarFinding(runSlug, topic, params.title ?? "");
				if (dup) {
					return textResult(
						JSON.stringify({
							success: false,
							duplicate_of: dup.slug,
							filed_by: dup.researcher,
							existing_title: dup.title,
							existing_confidence: dup.confidence,
							message:
								`${dup.researcher === researcher.slug ? "You" : `Researcher '${dup.researcher}'`} already filed this as ` +
								`'${dup.slug}'. If you have NEW evidence or a different confidence, add it with action 'append' ` +
								"(finding, text, sources). If yours is a truly different thing, refile with force=true and a " +
								"title naming the difference. Either way, move on to what nobody has found.",
						}),
					);
				}
			}
			const result = store.addFinding(runSlug, {
				title: params.title ?? "",
				researcher: researcher.slug,
				confidence: params.confidence ?? "unverified",
				kind: params.kind ?? "fact",
				topic,
				what: params.what ?? "",
				evidence: params.evidence ?? "",
				sources,
				question: params.question,
			});
			if (result.success === true) {
				onChange();
				const warnings: string[] = [];
				if (sources.length === 0) {
					warnings.push(
						"No sources recorded: a finding without sources is an opinion. Append the URL, file, or command it came from.",
					);
				}
				if (params.confidence === "confirmed" && (params.evidence ?? "").trim() === "") {
					warnings.push(
						"Marked confirmed with no evidence quoted — quote the code, request, or text that confirms it.",
					);
				}
				const neighbours = store
					.listFindings(runSlug)
					.filter(
						(finding) =>
							finding.slug !== result.finding &&
							finding.status !== "duplicate" &&
							finding.topic.trim().toLowerCase() === topic.toLowerCase(),
					)
					.slice(0, 5)
					.map((finding) => `${finding.slug}: ${finding.title} (${finding.researcher}, ${finding.confidence})`);
				return textResult(
					JSON.stringify({
						...result,
						...(warnings.length > 0 ? { warnings } : {}),
						...(neighbours.length > 0
							? {
									also_in_topic: neighbours,
									note: "This topic already has the findings above — if your NEXT find here matches one, 'append' to it instead of filing.",
								}
							: {}),
					}),
				);
			}
			return textResult(JSON.stringify(result));
		},
	});
}

// ------------------------------------------------------------------
// The browse tool: a researcher's private browser, headless until a site
// refuses it, then visible. Every rung of the ladder a page can need.
// ------------------------------------------------------------------

export interface BrowserSlot {
	driver?: BrowseDriver;
	headed?: boolean;
}

function makeBrowseTool(options: {
	slot: BrowserSlot;
	port: number;
	profileDir: string;
	factory: BrowseDriverFactory;
}): ToolDefinition {
	const { slot } = options;

	const launch = async (headed: boolean): Promise<BrowseDriver> => {
		slot.driver?.dispose();
		slot.driver = await options.factory({
			port: options.port,
			userDataDir: join(options.profileDir, "browser"),
			viewport: VIEWPORT_PRESETS.desktop,
			headed,
			captureNetwork: true,
		});
		slot.headed = headed;
		return slot.driver;
	};

	const ensure = async (): Promise<BrowseDriver> => slot.driver ?? launch(slot.headed === true);

	const clip = (text: string, limit: number): string =>
		text.length > limit
			? `${text.slice(0, limit)}\n...(${text.length - limit} more chars; narrow with a selector or fetch the specific page)`
			: text;

	return defineTool({
		name: "browse",
		label: "Browse",
		description:
			"Your own real Chrome (headless until you relaunch it visible), on your own port and profile. " +
			"One call = one action. Navigation and interaction actions return a screenshot of the page NOW " +
			"plus its URL/title and console errors — study each image.\n\n" +
			"ACTIONS: 'goto' (url) — call this first; 'text' (selector?) — the rendered text of the page or " +
			"one element, what a crawler cannot see; 'html' (selector?) — the live DOM; 'links'; 'network' — " +
			"every request the page has made since you last asked (method, URL, status, type: the API " +
			"behind the UI); 'eval' (js) — read page state; 'click' (selector, or x+y); 'type' (text); " +
			"'press' (key); 'scroll' (dy); 'screenshot'; 'viewport' (width, height, mobile?); 'relaunch' " +
			"(headed: true) — restart as a VISIBLE browser window when a site refuses the headless one, same " +
			"profile, then continue.",
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("goto"),
					Type.Literal("text"),
					Type.Literal("html"),
					Type.Literal("links"),
					Type.Literal("network"),
					Type.Literal("eval"),
					Type.Literal("click"),
					Type.Literal("type"),
					Type.Literal("press"),
					Type.Literal("scroll"),
					Type.Literal("screenshot"),
					Type.Literal("viewport"),
					Type.Literal("relaunch"),
				],
				{ description: "The action to perform" },
			),
			url: Type.Optional(Type.String({ description: "For 'goto'" })),
			selector: Type.Optional(
				Type.String({ description: "For 'click' / 'text' / 'html': CSS selector of the element" }),
			),
			x: Type.Optional(Type.Number({ description: "For 'click': viewport x when not using a selector" })),
			y: Type.Optional(Type.Number({ description: "For 'click': viewport y when not using a selector" })),
			text: Type.Optional(Type.String({ description: "For 'type'" })),
			key: Type.Optional(Type.String({ description: "For 'press': Enter, Tab, Escape, ArrowDown, ..." })),
			dy: Type.Optional(Type.Number({ description: "For 'scroll': pixels down (negative scrolls up)" })),
			js: Type.Optional(Type.String({ description: "For 'eval': expression evaluated in the page" })),
			max_chars: Type.Optional(
				Type.Number({
					description: `For 'text' / 'html' / 'links' / 'eval': cap on the result (default ${DEFAULT_MAX_CHARS})`,
				}),
			),
			width: Type.Optional(Type.Number({ description: "For 'viewport'" })),
			height: Type.Optional(Type.Number({ description: "For 'viewport'" })),
			mobile: Type.Optional(Type.Boolean({ description: "For 'viewport': emulate touch/mobile" })),
			headed: Type.Optional(
				Type.Boolean({ description: "For 'relaunch': true = a visible window; false = back to headless" }),
			),
			doing: Type.Optional(
				Type.String({
					description:
						"Include on every call: 2-5 words on what you are doing right now, present tense, " +
						"e.g. 'watching the login requests' — shown live on the run roster",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const limit = Math.max(500, Math.min(params.max_chars ?? DEFAULT_MAX_CHARS, 200_000));
			try {
				if (params.action === "relaunch") {
					const headed = params.headed ?? true;
					await launch(headed);
					return textResult(
						`Browser relaunched ${headed ? "as a visible window" : "headless"} on port ${options.port}, same profile. Continue with 'goto'.`,
					);
				}
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
					case "text": {
						const selector = JSON.stringify(params.selector ?? "");
						const value = await driver.eval(
							`(() => { const sel = ${selector}; const el = sel ? document.querySelector(sel) : document.body; if (!el) return "NOTFOUND"; return (el.innerText || el.textContent || ""); })()`,
						);
						if (value === "NOTFOUND") return textResult(`no element matches selector ${params.selector}`);
						const state = await driver.state();
						return textResult(
							`${state.url} — ${state.title}\n\n${clip(value.replace(/\n{3,}/g, "\n\n"), limit)}`,
						);
					}
					case "html": {
						const selector = JSON.stringify(params.selector ?? "");
						const value = await driver.eval(
							`(() => { const sel = ${selector}; const el = sel ? document.querySelector(sel) : document.documentElement; if (!el) return "NOTFOUND"; return el.outerHTML; })()`,
						);
						if (value === "NOTFOUND") return textResult(`no element matches selector ${params.selector}`);
						return textResult(clip(value, limit));
					}
					case "links": {
						const value = await driver.eval(
							`JSON.stringify([...new Map([...document.querySelectorAll("a[href]")].map(a => [a.href, (a.innerText || a.getAttribute("aria-label") || "").trim().replace(/\\s+/g, " ").slice(0, 120)])).entries()].slice(0, 400))`,
						);
						let lines: string;
						try {
							lines = (JSON.parse(value) as [string, string][])
								.map(([href, text]) => (text === "" ? href : `${text} — ${href}`))
								.join("\n");
						} catch {
							lines = value;
						}
						return textResult(clip(lines, limit));
					}
					case "network": {
						if (!driver.requests) return textResult("This browser does not capture network requests.");
						const requests = await driver.requests();
						if (requests.length === 0) return textResult("No requests since the last check.");
						const lines = requests.map(
							(request) =>
								`${request.method} ${request.url} — ${request.status ?? "pending"} ${request.type}${request.mimeType ? ` ${request.mimeType}` : ""}`,
						);
						return textResult(clip(`${requests.length} request(s):\n${lines.join("\n")}`, limit));
					}
					case "eval": {
						if (!params.js) return textResult("eval needs 'js'");
						const value = await driver.eval(params.js);
						return textResult(clip(value, limit));
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
				const wall = /just a moment|attention required|access denied|verify you are human|are you a robot/i.test(
					state.title,
				)
					? "\nThis looks like a bot check. Do not solve it: try 'relaunch' with headed=true if you are headless, else go around it (public API, archive, repository, mirror) and file a dead-end finding if nothing works."
					: "";
				return {
					content: [
						{
							type: "text" as const,
							text: `${note ? `${note} · ` : ""}${state.url} — ${state.title}${slot.headed ? " (visible browser)" : ""}${consoleBlock}${wall}`,
						},
						{ type: "image" as const, data: shot, mimeType: "image/jpeg" },
					],
					details: {},
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textResult(
					`browse failed: ${message}. If the browser cannot launch at all, fall back to driving Chrome/Edge yourself from the shell (CDP on port ${options.port}, profile under '${options.profileDir}'), or to fetch and curl.`,
				);
			}
		},
	});
}

// ------------------------------------------------------------------
// fetch and search: the first rung of the ladder.
// ------------------------------------------------------------------

function makeFetchTool(fetchImpl: FetchImpl): ToolDefinition {
	return defineTool({
		name: "fetch",
		label: "Fetch",
		description:
			"Fetch a URL the way a crawler does — no JavaScript runs. 'as' shapes the result: 'text' (default: " +
			"the page as readable text), 'html' (raw markup), 'json' (pretty-printed), 'links' (every link on the " +
			"page), 'scripts' (the script bundles the page loads — fetch those as 'text' to read the code), " +
			"'headers' (response headers only). Big bodies truncate at max_chars. A blocked response is " +
			"flagged: then climb — browse it, relaunch the browser visible, curl, archive, repository.",
		parameters: Type.Object({
			url: Type.String({ description: "The URL to fetch" }),
			as: Type.Optional(
				Type.Union(
					[
						Type.Literal("text"),
						Type.Literal("html"),
						Type.Literal("json"),
						Type.Literal("links"),
						Type.Literal("scripts"),
						Type.Literal("headers"),
					],
					{ description: "How to shape the response (default text)" },
				),
			),
			max_chars: Type.Optional(Type.Number({ description: `Cap on the body (default ${DEFAULT_MAX_CHARS})` })),
			headers: Type.Optional(
				Type.Record(Type.String(), Type.String(), { description: "Extra request headers, e.g. Accept" }),
			),
			method: Type.Optional(
				Type.Union([Type.Literal("GET"), Type.Literal("HEAD"), Type.Literal("POST")], {
					description: "HTTP method (default GET; POST only against public APIs that document it)",
				}),
			),
			body: Type.Optional(Type.String({ description: "For POST: the request body" })),
			doing: Type.Optional(
				Type.String({ description: "Include on every call: 2-5 words on what you are doing, shown on the roster" }),
			),
		}),
		async execute(_toolCallId, params) {
			try {
				const result = await fetchPage(
					{
						url: params.url,
						as: params.as as FetchAs | undefined,
						maxChars: params.max_chars,
						headers: params.headers,
						method: params.method,
						body: params.body,
					},
					fetchImpl,
				);
				const head =
					`HTTP ${result.status} ${result.url}${result.contentType ? ` (${result.contentType})` : ""}` +
					(result.truncated ? ` — ${result.length} chars, showing ${result.body.length}` : "") +
					(result.blocked
						? `\nBLOCKED: ${result.blocked}. Climb the ladder: browse it (then 'relaunch' headed if refused), curl with browser headers, the site's public API, web.archive.org, a repository or mirror.`
						: "");
				return textResult(`${head}\n\n${result.body}`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textResult(`fetch failed: ${message}. Try the browse tool, or curl from the shell.`);
			}
		},
	});
}

function makeSearchTool(fetchImpl: FetchImpl): ToolDefinition {
	return defineTool({
		name: "search",
		label: "Search",
		description:
			"Search the web (DuckDuckGo, then Bing) and get titles, URLs, and snippets. Vary the query: exact " +
			"phrases in quotes, site:github.com, the product name plus 'source', 'api', 'changelog', 'how does', " +
			"the exact error text. When both engines fail, search from the browse tool instead.",
		parameters: Type.Object({
			query: Type.String({ description: "The search query" }),
			limit: Type.Optional(Type.Number({ description: "Results to return (default 10, max 25)" })),
			doing: Type.Optional(
				Type.String({ description: "Include on every call: 2-5 words on what you are doing, shown on the roster" }),
			),
		}),
		async execute(_toolCallId, params) {
			const limit = Math.max(1, Math.min(params.limit ?? 10, 25));
			const outcome = await webSearch(params.query, fetchImpl, limit);
			if (outcome.results.length === 0) {
				return textResult(
					`No results. ${(outcome.errors ?? []).join("; ")}\nSearch from the browse tool instead: goto https://www.bing.com/search?q=${encodeURIComponent(params.query)} (or duckduckgo.com), then 'links'.`,
				);
			}
			const lines = outcome.results.map(
				(result, index) =>
					`${index + 1}. ${result.title}\n   ${result.url}${result.snippet ? `\n   ${result.snippet}` : ""}`,
			);
			return textResult(
				`${outcome.results.length} result(s) via ${outcome.engine} for "${params.query}":\n\n${lines.join("\n")}`,
			);
		},
	});
}

// ------------------------------------------------------------------
// Extension
// ------------------------------------------------------------------

/**
 * The angles a supervisor named, validated against the deck. Returns the
 * picks, undefined when none were given, or an error message naming the deck.
 */
function readPicks(raw: string[] | undefined): AnglePick[] | undefined | string {
	if (raw === undefined) return undefined;
	const entries = raw.map((entry) => entry.trim()).filter((entry) => entry !== "");
	if (entries.length === 0) return `'angles' needs at least one entry; the deck: ${ANGLE_NAMES.join(", ")}.`;
	if (entries.length > MAX_RESEARCHERS) return `At most ${MAX_RESEARCHERS} researchers.`;
	const picks: AnglePick[] = [];
	for (const entry of entries) {
		const pick = parseAnglePick(entry);
		if (!pick) {
			return `Unknown angle '${entry}'. The deck: ${ANGLE_NAMES.join(", ")} — optionally with a focus after a colon.`;
		}
		picks.push(pick);
	}
	return picks;
}

export interface ResearchPaths {
	root: string;
	clearanceTimeoutMs?: number;
}

export default function researchExtension(smolt: ExtensionAPI): void {
	createResearchExtension(smolt, { root: join(process.cwd(), ".smolt", "research") });
}

export interface ResearchHandle {
	researchers(): ResearcherSlot[];
	activeRun(): string | undefined;
	stop(): Promise<number>;
}

export type ActionLabeler = (raw: string, ctx: ExtensionContext) => Promise<string | undefined>;

const LABEL_SYSTEM =
	"You caption what a research investigator is doing right now. Given one raw tool action, answer with a single " +
	'present-tense phrase of 2 to 6 words, e.g. "reading the checkout bundle" or "searching for the api docs". ' +
	"Lowercase, no punctuation, no quotes, nothing but the phrase.";

const CHEAP_MODEL_HINT = /haiku|flash|mini|nano|lite|small/i;
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

export function createResearchExtension(
	smolt: ExtensionAPI,
	paths: ResearchPaths,
	spawn: ResearcherSpawner = defaultSpawner,
	browseFactory: BrowseDriverFactory = defaultBrowseDriverFactory,
	fetchImpl: FetchImpl = fetch as unknown as FetchImpl,
	labeler: ActionLabeler = defaultActionLabeler,
): ResearchHandle {
	const store = new ResearchStore(paths.root);
	const previous = latestInstance;
	const clearanceTimeoutMs = paths.clearanceTimeoutMs ?? DEFAULT_CLEARANCE_TIMEOUT_MS;
	let researchers: ResearcherSlot[] = [];
	let activeRun: string | undefined;
	let synthesisDue = false;
	interface PendingClearance extends ClearanceRequest {
		id: string;
		researcher: string;
		settle: (verdict: ClearanceVerdict) => void;
	}
	const clearances = new Map<string, PendingClearance>();
	let clearanceSeq = 0;
	const browsers = new Map<string, BrowserSlot>();
	const wrappedUp = new Set<string>();

	const recordPerformance = (run: ResearchRun): void => {
		try {
			const findings = store.listFindings(run.slug);
			const questions = store.listQuestions(run.slug);
			store.writePerformance(
				run.slug,
				researchers.map((slot) => {
					const filed = findings.filter(
						(finding) => finding.researcher === slot.researcher.slug && finding.status !== "duplicate",
					);
					const answered = questions.filter(
						(question) => question.answeredBy === slot.researcher.slug && question.status === "answered",
					).length;
					const tokens = slot.driver?.tokens?.();
					const timing = slot.driver?.metricsSummary?.();
					return {
						slug: slot.researcher.slug,
						name: slot.researcher.name,
						angle: slot.researcher.angle,
						traits: { ...slot.researcher.traits },
						status: slot.status,
						findings: filed.length,
						points:
							filed.reduce((sum, finding) => sum + (CONFIDENCE_POINTS[finding.confidence] ?? 1), 0) +
							answered * QUESTION_POINTS,
						questionsAnswered: answered,
						actions: timing?.actions ?? slot.driver?.actions?.() ?? 0,
						tokens: tokens ? tokens.input + tokens.output : 0,
						wallMs: timing?.wallMs ?? 0,
						brief: slot.task ?? "",
					};
				}),
			);
		} catch {
			// Record-keeping must never take the run down.
		}
	};

	let reportedFindings = new Set<string>();
	let reportedAnswers = new Set<string>();
	const reportedActions = new Map<string, number>();
	const reportedTokens = { input: 0, output: 0, cost: 0 };

	const tokenTotals = (): { input: number; output: number; cost: number } => {
		const totals = { input: 0, output: 0, cost: 0 };
		for (const slot of researchers) {
			const tokens = slot.driver?.tokens?.();
			if (!tokens) continue;
			totals.input += tokens.input;
			totals.output += tokens.output;
			totals.cost += tokens.cost;
		}
		return totals;
	};

	const running = (): ResearcherSlot[] => researchers.filter((slot) => slot.status === "researching");
	const allFinished = (): boolean => researchers.length > 0 && running().length === 0;

	const tokenLabel = (slot: ResearcherSlot): string => {
		const tokens = slot.driver?.tokens?.();
		if (!tokens) return "";
		const total = tokens.input + tokens.output;
		return total > 0 ? `${(total / 1000).toFixed(1)}k tokens` : "";
	};

	const shorten = (raw: string): string => {
		const text = raw.replace(/^https?:\/\//, "").trim();
		return text.length > 40 ? `${text.slice(0, 39)}…` : text;
	};

	const humanizeAction = (action: string | undefined): string | undefined => {
		if (!action) return undefined;
		const match = /^(\w+): (\S+)\s*(.*)$/.exec(action);
		if (!match) return action;
		const [, tool, verb, rest] = match as unknown as [string, string, string, string];
		if (tool === "browse") {
			if (verb === "goto") return `opening ${shorten(rest)}`;
			if (verb === "text" || verb === "html") return "reading the page";
			if (verb === "links") return "mapping the page's links";
			if (verb === "network") return "watching the requests";
			if (verb === "click") return `clicking ${shorten(rest) || "the page"}`;
			if (verb === "type") return "typing";
			if (verb === "press") return "pressing keys";
			if (verb === "scroll") return "scrolling";
			if (verb === "screenshot") return "looking at the page";
			if (verb === "eval") return "inspecting page state";
			if (verb === "viewport") return "resizing the window";
			if (verb === "relaunch") return "relaunching the browser visible";
			return `${verb} ${shorten(rest)}`.trim();
		}
		if (tool === "fetch") return `fetching ${shorten(`${verb} ${rest}`)}`;
		if (tool === "search") return `searching: ${shorten(`${verb} ${rest}`)}`;
		if (tool === "notebook") {
			if (verb === "finding") return `filing: ${shorten(rest) || "a finding"}`;
			if (verb === "question") return `asking: ${shorten(rest) || "a question"}`;
			if (verb === "answer") return "answering a question";
			if (verb === "claim") return "claiming a question";
			if (verb === "clearance") return "asking for clearance";
			return "writing notes";
		}
		if (tool === "bash" || tool === "powershell") return `running ${shorten(`${verb} ${rest}`)}`;
		if (tool === "read") return `reading ${shorten(`${verb} ${rest}`)}`;
		return action;
	};

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

	const describeAction = (raw: string | undefined, ctx: ExtensionContext): string | undefined => {
		if (raw === undefined) return undefined;
		if (!/^\w+: /.test(raw)) return raw;
		const cached = actionLabels.get(raw);
		if (cached !== undefined) return cached;
		requestLabel(raw, ctx);
		return humanizeAction(raw);
	};

	const paint = (ctx: ExtensionContext): void => {
		try {
			paintUnchecked(ctx);
		} catch {
			// Ignore — the live session repaints on its next tick.
		}
	};

	const paintUnchecked = (ctx: ExtensionContext): void => {
		if (activeRun === undefined || researchers.length === 0) {
			ctx.ui.setStatus("research", undefined);
			ctx.ui.setWidget("research", undefined);
			return;
		}
		for (const slot of running()) {
			if (wrappedUp.has(slot.researcher.slug) || !slot.driver?.send) continue;
			const spent = slot.driver.actions?.() ?? 0;
			if (spent <= Math.round(budgetFor(slot.researcher.traits.tenacity) * 1.2)) continue;
			wrappedUp.add(slot.researcher.slug);
			void slot.driver
				.send(
					"Supervisor: your action budget is spent. Stop exploring now — file any outstanding findings, " +
						"answer or release your claimed questions, write your final 'overall' diary note, and finish " +
						"with your summary reply. Start nothing new; another wave takes what is left.",
				)
				.catch(() => {});
		}
		const findings = store.listFindings(activeRun).filter((finding) => finding.status !== "duplicate");
		const map = store.questionMap(activeRun);
		const live = running().length;
		const pending = clearances.size > 0 ? `, ${clearances.size} clearance pending` : "";
		const totals = tokenTotals();
		const spentTokens = totals.input + totals.output;
		const spentLabel = spentTokens > 0 ? `, ${(spentTokens / 1000).toFixed(1)}k researcher tokens` : "";
		const questions = `${map.answered}/${map.answered + map.open} questions`;
		ctx.ui.setStatus(
			"research",
			live > 0
				? `research: ${live}/${researchers.length} researching, ${findings.length} findings, ${questions}${pending}${spentLabel}`
				: `research: done, ${findings.length} findings, ${questions}${spentLabel}`,
		);
		const filedBy = new Map<string, ResearchFinding[]>();
		for (const finding of findings) {
			const list = filedBy.get(finding.researcher) ?? [];
			list.push(finding);
			filedBy.set(finding.researcher, list);
		}
		const lines: string[] = [];
		// Same structured shadow as battletest, so the desktop's expandable
		// roster works unchanged: `tickets` carries the findings here.
		const details: { testers: { tickets: string[]; actions: string[] }[] } = { testers: [] };
		for (const slot of researchers) {
			const filed = filedBy.get(slot.researcher.slug) ?? [];
			const actions = slot.driver?.actions?.() ?? 0;
			const doing =
				slot.status === "researching"
					? (describeAction(slot.driver?.currentAction?.(), ctx) ??
						(activeRun !== undefined
							? ((topic) => (topic ? `on ${topic}` : undefined))(
									store.latestNoteTopic(activeRun, slot.researcher.slug),
								)
							: undefined) ??
						"researching")
					: slot.status;
			const spent = tokenLabel(slot);
			const line =
				`${slot.researcher.name} (${slot.researcher.angle}) · ` +
				`${actions} action${actions === 1 ? "" : "s"}` +
				(spent !== "" ? ` · ${spent}` : "") +
				` · ${filed.length} finding${filed.length === 1 ? "" : "s"} · ${doing}`;
			lines.push(slot.status === "errored" ? `${line} — ${slot.error.split("\n")[0]?.slice(0, 50) ?? ""}` : line);
			details.testers.push({
				tickets: filed.map(
					(finding) => `[${finding.confidence}/${finding.kind}] ${finding.title} — ${finding.topic}`,
				),
				actions: (slot.driver?.recentActions?.() ?? []).map(
					(action) => actionLabels.get(action) ?? humanizeAction(action) ?? action,
				),
			});
		}
		ctx.ui.setWidget("research", lines, { details });
	};

	const stopAll = async (mark: boolean): Promise<number> => {
		for (const entry of [...clearances.values()]) {
			entry.settle({ allowed: false, guidance: "The run is stopping; do nothing further." });
		}
		const live = running();
		for (const slot of live) {
			await slot.driver?.abort();
			slot.status = "stopped";
		}
		for (const slot of researchers) slot.driver?.dispose();
		for (const slot of browsers.values()) slot.driver?.dispose();
		browsers.clear();
		if (mark && activeRun !== undefined && live.length > 0) store.setRunStatus(activeRun, "stopped");
		return live.length;
	};

	const startRun = async (
		count: number,
		subject: string,
		ctx: ExtensionContext,
		model?: Model<Api>,
		thinkingLevel?: ThinkingLevel,
		picks?: AnglePick[],
		questions?: string[],
		notes?: string,
	): Promise<ResearchRun> => {
		const team = picks !== undefined ? generateResearchTeam(picks) : generateResearchers(count);
		for (const researcher of team) researcher.wave = 1;
		const run = store.createRun({ subject, researchers: team, notes });
		for (const question of questions ?? []) {
			if (question.trim() !== "")
				store.addQuestion(run.slug, { title: question.trim(), question: question.trim(), askedBy: "user" });
		}
		activeRun = run.slug;
		await dispatchResearchers(run, undefined, ctx, model, thinkingLevel);
		smolt.sendUserMessage(kickoffPrompt(store.readRun(run.slug) ?? run, model), { deliverAs: "followUp" });
		return run;
	};

	/** Another wave on the same run: a fresh team dispatched at the open frontier. */
	const continueRun = async (
		ref: string,
		ctx: ExtensionContext,
		picks: AnglePick[] | undefined,
		count: number | undefined,
		model?: Model<Api>,
		thinkingLevel?: ThinkingLevel,
	): Promise<string> => {
		const run = store.resolveRun(ref);
		if (!run) return `Unknown run '${ref}'. Runs: ${store.listRunSlugs().join(", ") || "(none)"}`;
		if (running().length > 0) {
			return `This session already has ${running().length} researcher(s) running; wait for them or 'stop' first.`;
		}
		if (run.wave >= MAX_WAVES) {
			return `Run '${run.slug}' has had ${run.wave} waves already — the subject is not converging on more researchers. Write the report with what there is and name what stays open.`;
		}
		const map = store.questionMap(run.slug);
		if (map.frontier.length === 0 && map.blocked.length === 0 && (picks === undefined || picks.length === 0)) {
			return "No open questions remain on the map. Add questions first (action 'add_question'), or pass 'angles' aimed at what is still unknown.";
		}
		const drained = (await previous?.stop()) ?? 0;
		const wave = run.wave + 1;
		const team =
			picks !== undefined
				? generateResearchTeam(picks)
				: generateResearchers(Math.max(1, Math.min(count ?? DEFAULT_RESEARCHERS, MAX_RESEARCHERS)));
		// Names and slugs must stay unique across waves: notes and metrics are keyed by slug.
		const taken = new Set(run.researchers.map((researcher) => researcher.slug));
		for (const researcher of team) {
			researcher.wave = wave;
			let slug = researcher.slug;
			for (let n = 2; taken.has(slug); n++) slug = `${researcher.slug}-w${wave}${n > 2 ? `-${n}` : ""}`;
			researcher.slug = slug;
			taken.add(slug);
		}
		store.updateRun(run.slug, { researchers: [...run.researchers, ...team], wave });
		store.setRunStatus(run.slug, "researching");
		activeRun = run.slug;
		const updated = store.readRun(run.slug) ?? run;
		await dispatchResearchers(updated, undefined, ctx, model, thinkingLevel);
		smolt.sendUserMessage(
			`${drained > 0 ? `${drained} leftover researcher(s) from a previous session instance were stopped first. ` : ""}${kickoffPrompt(updated, model)}`,
			{ deliverAs: "followUp" },
		);
		return "";
	};

	const resumeBriefs = (run: ResearchRun, team: Researcher[]): ResumeBrief[] =>
		team.map((researcher) => ({
			spent: countSpentActions(store.metricsPath(run.slug, researcher.slug)),
			diary: trimDiary(readDiary(store.notesPath(run.slug, researcher.slug))),
			filed: store
				.listFindings(run.slug)
				.filter((finding) => finding.researcher === researcher.slug)
				.map((finding) => `${finding.title} — ${finding.confidence}/${finding.kind} — ${finding.topic}`),
		}));

	const resumeRun = async (ref: string, ctx: ExtensionContext): Promise<string> => {
		const run = store.resolveRun(ref);
		if (!run) return `Unknown run '${ref}'. Runs: ${store.listRunSlugs().join(", ") || "(none)"}`;
		if (run.status === "complete") return `Run '${run.slug}' is already complete; nothing to resume.`;
		const team = run.researchers.filter((researcher) => (researcher.wave ?? 1) === run.wave);
		if (team.length === 0) return `Run '${run.slug}' has no recorded researchers; it cannot be resumed.`;
		if (running().length > 0) {
			return `This session already has ${running().length} researcher(s) running; 'stop' first, then resume.`;
		}
		const drained = (await previous?.stop()) ?? 0;
		activeRun = run.slug;
		store.setRunStatus(run.slug, "researching");
		await dispatchResearchers(run, resumeBriefs(run, team), ctx);
		smolt.sendUserMessage(resumeKickoffPrompt(run, drained), { deliverAs: "followUp" });
		return "";
	};

	const dispatchResearchers = async (
		run: ResearchRun,
		resume: ResumeBrief[] | undefined,
		ctx: ExtensionContext,
		model?: Model<Api>,
		thinkingLevel?: ThinkingLevel,
	): Promise<void> => {
		synthesisDue = false;
		reportedFindings = new Set(store.listFindings(run.slug).map((finding) => finding.slug));
		reportedAnswers = new Set(
			store
				.listQuestions(run.slug)
				.filter((question) => question.status !== "open")
				.map((question) => question.slug),
		);
		reportedActions.clear();
		reportedTokens.input = 0;
		reportedTokens.output = 0;
		reportedTokens.cost = 0;
		wrappedUp.clear();
		const team = run.researchers.filter((researcher) => (researcher.wave ?? 1) === run.wave);
		researchers = team.map((researcher) => ({ researcher, status: "researching" as const, summary: "", error: "" }));
		const priorKnowledge = priorKnowledgeBrief(store, run);
		const questionMap = questionMapBrief(store, run.slug);
		for (const [index, slot] of researchers.entries()) {
			const port = DEBUG_PORT_BASE + index;
			const profileDir = store.profileDir(run.slug, slot.researcher.slug);
			const task = researcherPrompt(
				slot.researcher,
				run,
				index,
				researchers.length,
				profileDir,
				port,
				resume?.[index],
				priorKnowledge,
				questionMap,
			);
			slot.task = task;
			const onFinish = (status: "completed" | "errored", detail: string): void => {
				if (slot.status !== "researching") return;
				slot.status = status;
				if (status === "errored") slot.error = detail;
				else slot.summary = detail;
				browsers.get(slot.researcher.slug)?.driver?.dispose();
				browsers.delete(slot.researcher.slug);
				const timing = slot.driver?.metricsSummary?.();
				if (timing) store.writeMetricsSummary(run.slug, slot.researcher.slug, timing);
				if (allFinished()) {
					synthesisDue = true;
					recordPerformance(run);
				}
				paint(ctx);
			};
			const onClearance = (request: ClearanceRequest): Promise<ClearanceVerdict> =>
				new Promise((resolve) => {
					clearanceSeq += 1;
					const id = `c${clearanceSeq}`;
					const settle = (verdict: ClearanceVerdict): void => {
						if (clearances.delete(id)) resolve(verdict);
					};
					clearances.set(id, { id, researcher: slot.researcher.name, settle, ...request });
					ctx.ui.notify(
						`research · ${slot.researcher.name} requests clearance [${id}]: ${request.action}`,
						"warning",
					);
					paint(ctx);
					setTimeout(() => settle(CLEARANCE_TIMEOUT_VERDICT), clearanceTimeoutMs);
				});
			const browserSlot: BrowserSlot = {};
			browsers.set(slot.researcher.slug, browserSlot);
			try {
				slot.driver = await spawn(
					{
						researcher: slot.researcher,
						task,
						metricsPath: store.metricsPath(run.slug, slot.researcher.slug),
						customTools: [
							makeNotebookTool(store, run.slug, slot.researcher, () => paint(ctx), onClearance),
							makeBrowseTool({ slot: browserSlot, port, profileDir, factory: browseFactory }),
							makeFetchTool(fetchImpl),
							makeSearchTool(fetchImpl),
						],
						ctx,
						model,
						thinkingLevel,
					},
					onFinish,
				);
			} catch (error) {
				slot.status = "errored";
				slot.error = error instanceof Error ? error.message : String(error);
			}
		}
		paint(ctx);
	};

	smolt.on("session_start", async (_event, ctx) => {
		researchers = [];
		activeRun = undefined;
		synthesisDue = false;
		paint(ctx);
	});

	smolt.on("session_shutdown", async () => {
		await stopAll(true);
	});

	let lastRunAborted = false;
	smolt.on("agent_end", async (event) => {
		const last = [...event.messages].reverse().find((message) => message.role === "assistant");
		lastRunAborted = (last as { stopReason?: string } | undefined)?.stopReason === "aborted";
	});

	/**
	 * Safety net: the kickoff turn normally waits the run out and synthesizes
	 * in place, but if it was interrupted the finished wave would otherwise
	 * sit unreported. A user's Stop is the exception: an aborted turn stays
	 * stopped, and the run stays reportable through /research report.
	 */
	smolt.on("agent_settled", async (_event, ctx) => {
		paint(ctx);
		if (lastRunAborted) return;
		if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
		if (ctx.hasPendingMessages()) return;
		if (clearances.size > 0) {
			smolt.sendUserMessage(
				`${clearances.size} research clearance request(s) are pending and the researcher is paused on your ruling. ` +
					"Call research action 'wait' to see them, rule with 'decide' (deny when in doubt), then keep waiting out the run.",
			);
			return;
		}
		if (!synthesisDue || activeRun === undefined) return;
		if (store.readRun(activeRun)?.status !== "researching") {
			synthesisDue = false;
			return;
		}
		synthesisDue = false;
		smolt.sendUserMessage(
			`All ${researchers.length} researchers have finished while you were idle. ${synthesisInstructions(activeRun)}`,
		);
	});

	// Deliberately no system-prompt orientation block: research runs are
	// one-off questions, and telling every fresh session about the last one
	// once had a Telegram chat greet the user with another chat's subject.
	// Earlier runs are reachable on request through the tool's 'list' and
	// 'view', and a new run on a related subject gets their reports in its
	// briefs.

	smolt.registerTool({
		name: "research",
		label: "Research",
		description:
			"Inspect and manage research runs: investigator teams whose diaries, findings, question maps and " +
			"reports live under the project's .smolt/research/ directory.\n\n" +
			"ACTIONS: 'list' all runs; 'view' one run (team, question map, findings by confidence, notes paths — " +
			"omit 'run' for the latest); 'view_finding' (finding, run?) and 'view_question' (question, run?) for " +
			"full bodies; 'add_finding' (title, what, confidence?, kind?, topic?, evidence?, sources?, question?); " +
			"'update_finding' (finding, status open/verified/refuted/duplicate, duplicate_of?, confidence?); " +
			"'add_question' (title, text?, blocked_by?) to put a sharp sub-question on the map; 'update_question' " +
			"(question, blocked_by?, text?, status open/dead-end/out-of-scope, reason?); 'answer' (question, answer, " +
			"gist?) to close a question with its answer; 'update_run' (notes?, add_fog?, remove_fog?); " +
			"'write_report' (content, run?) writes the synthesized report and completes the run; 'wait' (seconds?) " +
			"blocks while this session's researchers are working and reports the deltas when it returns — it also " +
			"returns early whenever a researcher requests clearance; 'decide' (clearance, verdict allow|deny, " +
			"guidance?) rules on such a request — rule promptly, deny when in doubt; 'wrap_up' (researcher?) tells " +
			"stragglers to file what they have and finish; 'continue' (run?, angles?, count?, model?) dispatches " +
			"the next wave at the open frontier — this is how a run stops at nothing: keep going while questions " +
			`remain takeable, up to ${MAX_WAVES} waves.\n\n` +
			"WHEN: after /research dispatches a run (wait for it, then synthesize or continue), or when the user " +
			"asks about earlier research, wants findings triaged, or wants a subject taken further. Start new runs " +
			"with action 'start' (subject, angles? or count?, questions?, notes?, model?) or the /research " +
			"command in plain language; resume interrupted ones with 'resume'.",
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("list"),
					Type.Literal("view"),
					Type.Literal("view_finding"),
					Type.Literal("view_question"),
					Type.Literal("add_finding"),
					Type.Literal("update_finding"),
					Type.Literal("add_question"),
					Type.Literal("update_question"),
					Type.Literal("answer"),
					Type.Literal("update_run"),
					Type.Literal("write_report"),
					Type.Literal("wait"),
					Type.Literal("decide"),
					Type.Literal("wrap_up"),
					Type.Literal("start"),
					Type.Literal("continue"),
					Type.Literal("resume"),
				],
				{ description: "Operation to perform" },
			),
			run: Type.Optional(Type.String({ description: "Run slug. Omit to mean the latest run." })),
			finding: Type.Optional(Type.String({ description: "Finding slug (view_finding, update_finding)" })),
			question: Type.Optional(
				Type.String({
					description:
						"Question slug (view_question, update_question, answer; or the question an add_finding bears on)",
				}),
			),
			title: Type.Optional(Type.String({ description: "One line naming a finding or question" })),
			researcher: Type.Optional(
				Type.String({
					description:
						"add_finding / add_question / answer: who (defaults to 'synthesis'). wrap_up: which researcher to nudge (name or slug; omit for all).",
				}),
			),
			confidence: Type.Optional(Type.String({ description: `One of: ${CONFIDENCES.join(", ")}` })),
			kind: Type.Optional(Type.String({ description: `One of: ${FINDING_KINDS.join(", ")}` })),
			topic: Type.Optional(Type.String({ description: "Where in the subject a finding belongs" })),
			what: Type.Optional(Type.String({ description: "What was found (add_finding)" })),
			evidence: Type.Optional(Type.String({ description: "The proof, quoted (add_finding)" })),
			sources: Type.Optional(Type.Array(Type.String(), { description: "URLs/files/commands (add_finding)" })),
			status: Type.Optional(
				Type.String({
					description: `Finding status (${FINDING_STATUSES.join("/")}) for update_finding; question status (${QUESTION_STATUSES.join("/")}) for update_question`,
				}),
			),
			duplicate_of: Type.Optional(Type.String({ description: "Canonical finding when marking a duplicate" })),
			text: Type.Optional(Type.String({ description: "The precise question (add_question / update_question)" })),
			answer: Type.Optional(Type.String({ description: "The full answer with sources (answer)" })),
			gist: Type.Optional(Type.String({ description: "One line for the report's index (answer)" })),
			blocked_by: Type.Optional(Type.Array(Type.String(), { description: "Question slugs that must close first" })),
			reason: Type.Optional(
				Type.String({ description: "Why a question is a dead end or out of scope (update_question)" }),
			),
			notes: Type.Optional(Type.String({ description: "Standing context for the run (update_run / start)" })),
			add_fog: Type.Optional(
				Type.Array(Type.String(), { description: "Hunches not yet sharp enough to be questions (update_run)" }),
			),
			remove_fog: Type.Optional(
				Type.Array(Type.String(), { description: "Fog entries to remove, by unique substring (update_run)" }),
			),
			content: Type.Optional(Type.String({ description: "Full report markdown (write_report)" })),
			subject: Type.Optional(Type.String({ description: "For 'start': what to research, in the user's words" })),
			count: Type.Optional(
				Type.Number({
					description: `For 'start' / 'continue': how many researchers to deal from the deck (1-${MAX_RESEARCHERS}, default ${DEFAULT_RESEARCHERS})`,
				}),
			),
			angles: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"For 'start' / 'continue': pick the team yourself, one entry per researcher, each an angle from the " +
						`deck (${ANGLE_NAMES.join(", ")}) optionally narrowed with a focus after a colon, e.g. ` +
						"'network-sleuth: the checkout flow'. Overrides 'count'.",
				}),
			),
			questions: Type.Optional(
				Type.Array(Type.String(), {
					description: "For 'start': seed the question map with sharp sub-questions (up to 6)",
				}),
			),
			model: Type.Optional(
				Type.String({
					description:
						"For 'start' / 'continue': ONLY when the user explicitly named a model, pass it through verbatim. " +
						"NEVER pick a model yourself — researchers inherit the session's model by default.",
				}),
			),
			seconds: Type.Optional(
				Type.Number({
					description: `For 'wait': how long to block. Default ${DEFAULT_WAIT_SECONDS}, max ${MAX_WAIT_SECONDS}.`,
				}),
			),
			clearance: Type.Optional(Type.String({ description: "For 'decide': the pending clearance id (e.g. c1)" })),
			verdict: Type.Optional(
				Type.Union([Type.Literal("allow"), Type.Literal("deny")], {
					description: "For 'decide': allow only reading what a site serves any visitor; deny when in doubt",
				}),
			),
			guidance: Type.Optional(
				Type.String({ description: "For 'decide': one line the researcher reads with the ruling" }),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (params.action === "wrap_up") {
				const targets = running().filter(
					(slot) =>
						!params.researcher ||
						slot.researcher.slug === params.researcher.trim() ||
						slot.researcher.name.toLowerCase() === params.researcher.trim().toLowerCase(),
				);
				if (targets.length === 0) return textResult("No matching researchers are still running.");
				for (const slot of targets) {
					await slot.driver?.send?.(
						"Supervisor: time is up. Stop exploring now — file any outstanding findings, answer or release " +
							"your claimed questions, write your final 'overall' diary note, and finish with your summary reply.",
					);
				}
				return textResult(
					`Asked ${targets.length} researcher(s) to wrap up: ${targets.map((slot) => slot.researcher.name).join(", ")}. Call 'wait' to see them finish.`,
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
							: "Do not do this; note it in your diary and take another route."),
				});
				ctx.ui.notify(`research · clearance ${entry.id} (${entry.researcher}): ${params.verdict}`, "info");
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
				const subject = (params.subject ?? "").trim();
				if (subject === "") return textResult("'start' needs a subject: what to research.");
				if (running().length > 0) {
					return textResult(
						`A run is already going (${running().length} researchers). Wait for it, or /research stop first.`,
					);
				}
				const picks = readPicks(params.angles);
				if (typeof picks === "string") return textResult(picks);
				const count = picks !== undefined ? picks.length : Math.floor(params.count ?? DEFAULT_RESEARCHERS);
				if (count < 1 || count > MAX_RESEARCHERS) {
					return textResult(`Researcher count must be between 1 and ${MAX_RESEARCHERS}.`);
				}
				const override = resolveModelOverride((params.model ?? "").trim(), ctx, "researcher");
				if (typeof override === "string") return textResult(override);
				const run = await startRun(
					count,
					subject,
					ctx,
					override?.model,
					override?.thinkingLevel,
					picks,
					params.questions?.slice(0, 6),
					params.notes,
				);
				return textResult(
					`Run '${run.slug}' started: ${count} researcher(s) dispatched; the kickoff brief arrives as a follow-up message. Call 'wait' to follow the run.`,
				);
			}

			if (params.action === "continue") {
				const picks = readPicks(params.angles);
				if (typeof picks === "string") return textResult(picks);
				const override = resolveModelOverride((params.model ?? "").trim(), ctx, "researcher");
				if (typeof override === "string") return textResult(override);
				const error = await continueRun(
					params.run ?? activeRun ?? "",
					ctx,
					picks,
					params.count,
					override?.model,
					override?.thinkingLevel,
				);
				return textResult(
					error !== ""
						? error
						: "Next wave dispatched at the open frontier; the kickoff brief arrives as a follow-up message. Call 'wait' to follow it.",
				);
			}

			if (params.action === "resume") {
				const error = await resumeRun(params.run ?? "", ctx);
				return textResult(
					error !== ""
						? error
						: "Resumed: the researchers were re-spawned from their diaries; the kickoff brief arrives as a follow-up message. Call 'wait' to follow the run.",
				);
			}

			if (params.action === "wait") {
				const diskStatus = activeRun === undefined ? undefined : store.readRun(activeRun)?.status;
				if (researchers.length === 0 || (diskStatus !== undefined && diskStatus !== "researching")) {
					const interrupted = store
						.listRuns()
						.filter((run) => run.status !== "complete")
						.map((run) => run.slug);
					return textResult(
						"No researchers are running in this session." +
							(interrupted.length > 0
								? ` Unfinished run(s) on disk: ${interrupted.join(", ")} — resume one with action 'resume' (or /research resume <slug>), or dispatch the next wave with 'continue'.`
								: " Start a run with /research <subject>."),
					);
				}
				const limit = Math.max(1, Math.min(params.seconds ?? DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS)) * 1000;
				const deadline = Date.now() + limit;
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
								`- [${entry.id}] ${entry.researcher} wants to: ${entry.action}${entry.risk ? ` — risk: ${entry.risk}` : ""} (topic: ${entry.topic})`,
						)
						.join("\n");
					return textResult(
						`${clearances.size} clearance request(s) pending — the researcher is paused until you rule:\n${requests}\n\n` +
							"Judge each against the safety doctrine: deny anything that logs in, creates an account, pays, bypasses a " +
							"bot check or paywall, sends real data anywhere, collects personal data, or could disrupt a site — deny " +
							"when in doubt. Allow reading what a site serves any visitor, a visible browser included. Record each " +
							"ruling with action 'decide' (clearance, verdict allow|deny, guidance?), then call 'wait' again.",
					);
				}
				const run = activeRun === undefined ? undefined : store.readRun(activeRun);
				const allFindings = activeRun === undefined ? [] : store.listFindings(activeRun);
				const filed = new Map<string, number>();
				for (const finding of allFindings) {
					if (finding.status === "duplicate") continue;
					filed.set(finding.researcher, (filed.get(finding.researcher) ?? 0) + 1);
				}
				const fresh = allFindings.filter((finding) => !reportedFindings.has(finding.slug));
				for (const finding of fresh) reportedFindings.add(finding.slug);
				const questions = activeRun === undefined ? [] : store.listQuestions(activeRun);
				const newlyClosed = questions.filter(
					(question) => question.status !== "open" && !reportedAnswers.has(question.slug),
				);
				for (const question of newlyClosed) reportedAnswers.add(question.slug);
				const map = activeRun === undefined ? undefined : store.questionMap(activeRun);
				const findingsBlock =
					fresh.length === 0
						? "No new findings since the last check."
						: `NEW FINDINGS since the last check:\n${fresh
								.map(
									(finding) =>
										`- [${finding.confidence}/${finding.kind}] ${finding.title} — ${finding.researcher} on ${finding.topic || "?"}${finding.sources.length > 0 ? ` (${finding.sources.length} source${finding.sources.length === 1 ? "" : "s"})` : " (NO SOURCES)"}`,
								)
								.join("\n")}`;
				const answersBlock =
					newlyClosed.length === 0
						? ""
						: `\n\nQUESTIONS CLOSED since the last check:\n${newlyClosed
								.map(
									(question) =>
										`- [${question.status}] ${question.title} — ${question.gist ?? ""} (${question.answeredBy ?? "?"})`,
								)
								.join("\n")}`;
				const mapBlock = map
					? `\n\nQUESTION MAP: ${map.answered} answered, ${map.deadEnds} dead ends, ${map.open} open (${map.frontier.length} takeable, ${map.claimed.length} claimed, ${map.blocked.length} blocked)${
							map.frontier.length > 0
								? `\nTakeable: ${map.frontier.map((question) => question.title).join("; ")}`
								: ""
						}`
					: "";
				const roster = researchers
					.map((slot) => {
						const count = filed.get(slot.researcher.slug) ?? 0;
						const actions = slot.driver?.actions?.() ?? 0;
						const delta = actions - (reportedActions.get(slot.researcher.slug) ?? 0);
						reportedActions.set(slot.researcher.slug, actions);
						const timing = slot.driver?.metricsSummary?.();
						const activity = timing ? describeSummary(timing) : `${actions} actions`;
						const spent = tokenLabel(slot);
						const topic =
							activeRun !== undefined && slot.status === "researching"
								? store.latestNoteTopic(activeRun, slot.researcher.slug)
								: undefined;
						const line =
							`- ${slot.researcher.name} (${slot.researcher.angle}): ${activity}` +
							(spent !== "" ? ` · ${spent}` : "") +
							` (+${delta}), ${count} finding${count === 1 ? "" : "s"}${topic ? `, now on '${topic}'` : ""} · ${slot.status}`;
						if (slot.status === "completed" && slot.summary !== "") return `${line} — ${slot.summary}`;
						if (slot.status === "errored") return `${line} — ${slot.error.split("\n")[0] ?? ""}`;
						return line;
					})
					.join("\n");
				const totals = tokenTotals();
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
				const total = allFindings.filter((finding) => finding.status !== "duplicate").length;
				if (!allFinished()) {
					return {
						...textResult(
							`${running().length} of ${researchers.length} researchers still going after ${Math.round(limit / 1000)}s; ${total} findings total.\n\n${findingsBlock}${answersBlock}${mapBlock}\n\nROSTER:\n${roster}\n\nGive the user a compact progress update now — two or three plain-language lines drawn from the new findings, closed questions, and roster above — then call 'wait' again.`,
						),
						usage,
					};
				}
				synthesisDue = false;
				const wave = run?.wave ?? 1;
				const more =
					map && map.frontier.length + map.blocked.length > 0 && wave < MAX_WAVES
						? `\n\n${map.open} question(s) are still open (${map.frontier.length} takeable) and this is wave ${wave} of at most ${MAX_WAVES}: stopping at nothing means dispatching the next wave with action 'continue' (pick angles for the open questions and dead ends) unless what remains is a wall no legitimate route gets around — then write the report and say so.`
						: map && map.open > 0
							? `\n\n${map.open} question(s) remain open but the wave limit is reached: write the report with what there is and name exactly what stays open and why.`
							: "";
				return {
					...textResult(
						`All ${researchers.length} researchers have finished; ${total} findings filed.\n\n${findingsBlock}${answersBlock}${mapBlock}\n\nROSTER:\n${roster}${more}\n\nNow synthesize as instructed: view the run, read the notes, judge the map, dedupe and grade the findings, and either continue or write the report.`,
					),
					usage,
				};
			}
			return textResult(JSON.stringify(researchTool(store, params)));
		},
	});

	smolt.registerCommand("research", {
		description:
			"Send a team of investigators after a subject and stop at nothing short of the answer, in plain " +
			"language: e.g. /research how stripe.com renders its pricing table, or /research 3 researchers using " +
			"opencode minimax-m3 into X. /research resume [slug] continues an interrupted run; /research continue dispatches the next wave",
		getArgumentCompletions: (argumentPrefix) => {
			const items = [
				{ value: "status", label: "status", description: "How the current run is going" },
				{ value: "stop", label: "stop", description: "Halt every researcher in the current run" },
				{ value: "continue", label: "continue", description: "Dispatch the next wave at the open questions" },
				{ value: "resume", label: "resume", description: "Continue an interrupted run from its diaries" },
				{ value: "report", label: "report", description: "Synthesize the latest finished run now" },
				{ value: "list", label: "list", description: "Every research run on record, with its state" },
			];
			const prefix = argumentPrefix.trim().toLowerCase();
			return items.filter((item) => item.value.startsWith(prefix));
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const [first = "", ...rest] = trimmed.split(/\s+/);
			const verb = first.toLowerCase();

			if (verb === "status") {
				if (researchers.length === 0) {
					ctx.ui.notify("No research run in this session. Start one with /research <subject>.", "info");
					return;
				}
				const findings =
					activeRun === undefined
						? 0
						: store.listFindings(activeRun).filter((f) => f.status !== "duplicate").length;
				const map = activeRun === undefined ? undefined : store.questionMap(activeRun);
				ctx.ui.notify(
					`Run ${activeRun}: ${running().length}/${researchers.length} still researching, ${findings} findings${map ? `, ${map.answered} answered / ${map.open} open questions` : ""}.\n` +
						researchers
							.map((slot) => `${slot.researcher.name} (${slot.researcher.angle}): ${slot.status}`)
							.join("\n"),
					"info",
				);
				return;
			}

			if (verb === "list") {
				if (store.listRunSlugs().length === 0) {
					ctx.ui.notify("No research runs yet. Start one with /research <subject>.", "info");
					return;
				}
				smolt.sendUserMessage(
					"Show me the research runs on record: call the research tool, action 'list', and present each run's subject, status, wave, findings, and answered/open questions in a table, newest first. Do not start anything this turn.",
				);
				return;
			}

			if (verb === "stop") {
				const drained = (await previous?.stop()) ?? 0;
				const stopped = await stopAll(true);
				synthesisDue = false;
				paint(ctx);
				let message = stopped === 0 ? "No researchers were running." : `Stopped ${stopped} researcher(s).`;
				if (drained > 0)
					message += ` Also stopped ${drained} leftover researcher(s) from a previous session instance.`;
				ctx.ui.notify(message, "info");
				return;
			}

			if (verb === "resume") {
				const error = await resumeRun(rest.join(" "), ctx);
				ctx.ui.notify(
					error !== ""
						? error
						: `Resumed ${activeRun}: researchers re-spawned from their diaries; follow with the research 'wait' action.`,
					error === "" ? "info" : "error",
				);
				return;
			}

			if (verb === "continue") {
				const error = await continueRun(rest.join(" "), ctx, undefined, undefined);
				ctx.ui.notify(
					error !== "" ? error : `Next wave dispatched on ${activeRun}; follow with the research 'wait' action.`,
					error === "" ? "info" : "error",
				);
				return;
			}

			if (verb === "report") {
				const run = store.resolveRun(rest.join(" "));
				if (!run) {
					ctx.ui.notify("No research runs exist yet.", "info");
					return;
				}
				synthesisDue = false;
				smolt.sendUserMessage(synthesisInstructions(run.slug));
				return;
			}

			if (running().length > 0) {
				ctx.ui.notify(
					`A run is already going (${running().length} researchers). /research stop first, or wait for it.`,
					"warning",
				);
				return;
			}

			if (trimmed === "") {
				ctx.ui.notify(
					"What should the team research? /research <subject>, e.g. /research how example.com builds its search suggestions.",
					"info",
				);
				return;
			}

			// Plain language: an optional count ("3 researchers"), an optional
			// model ("using opencode minimax-m3"), the rest is the subject.
			const parsed = parseBattletestInvocation(trimmed, ctx.modelRegistry.getAll());
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
					`No API key configured for provider "${parsed.model.provider}" — every researcher would fail. Configure it first.`,
					"error",
				);
				return;
			}
			// "/research into X" / "/research on X": the preposition belonged to the phrasing.
			const subject = parsed.focus.replace(/^(into|on|about|of)\s+/i, "").trim();
			if (subject === "") {
				ctx.ui.notify("What should the team research? /research <subject>.", "error");
				return;
			}
			if (parsed.count === undefined) {
				smolt.sendUserMessage(
					teamPlanPrompt(subject, parsed.model ? `${parsed.model.provider}/${parsed.model.id}` : undefined),
				);
				return;
			}
			if (parsed.count < 1 || parsed.count > MAX_RESEARCHERS) {
				ctx.ui.notify(`Researcher count must be between 1 and ${MAX_RESEARCHERS}.`, "error");
				return;
			}
			await startRun(parsed.count, subject, ctx, parsed.model, parsed.thinkingLevel);
		},
	});

	const handle: ResearchHandle = {
		researchers: () => researchers,
		activeRun: () => activeRun,
		stop: async () => stopAll(false),
	};
	latestInstance = handle;
	return handle;
}
