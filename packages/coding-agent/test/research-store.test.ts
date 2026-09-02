import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	ANGLES,
	generateResearchers,
	generateResearchTeam,
	parseAnglePick,
	type Researcher,
} from "../src/extensions/research/angles.ts";
import { CLAIM_TTL_MS, ResearchStore, researchTool } from "../src/extensions/research/store.ts";

/**
 * The store is the run's record: team, diaries, findings, the question map,
 * report — all markdown on disk. These tests cover the round-trips, the
 * question map's frontier/claim/cycle rules, and the dispatcher's validation.
 */

let dir: string;
let store: ResearchStore;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "research-store-"));
	store = new ResearchStore(join(dir, "research"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function seededRng(): () => number {
	let state = 42;
	return () => {
		state = (state * 1103515245 + 12345) % 2147483648;
		return state / 2147483648;
	};
}

function team(count: number): Researcher[] {
	return generateResearchers(count, seededRng());
}

describe("angles", () => {
	test("a team smaller than the deck gets all-distinct angles", () => {
		const researchers = generateResearchers(ANGLES.length, seededRng());
		expect(new Set(researchers.map((researcher) => researcher.angle)).size).toBe(ANGLES.length);
		expect(new Set(researchers.map((researcher) => researcher.slug)).size).toBe(ANGLES.length);
	});

	test("a supervisor-picked team is the named angles, a focus narrowing each", () => {
		const picked = generateResearchTeam(
			[{ angle: "network-sleuth", focus: "the checkout flow" }, { angle: "verifier" }, { angle: "network-sleuth" }],
			seededRng(),
		);
		expect(picked.map((researcher) => researcher.angle)).toEqual(["network-sleuth", "verifier", "network-sleuth"]);
		expect(new Set(picked.map((researcher) => researcher.slug)).size).toBe(3);
		expect(picked[0]!.lens).toContain("especially the checkout flow");
		expect(picked[0]!.traits.tenacity).toBe("relentless");
		expect(picked[2]!.lens).not.toContain("especially");
		expect(() => generateResearchTeam([{ angle: "wizard" }], seededRng())).toThrow(/unknown angle/);
	});

	test("picks parse the way a supervisor writes them", () => {
		expect(parseAnglePick("network sleuth")).toEqual({ angle: "network-sleuth" });
		expect(parseAnglePick("Source-Diver: the pricing bundle")).toEqual({
			angle: "source-diver",
			focus: "the pricing bundle",
		});
		expect(parseAnglePick("generalist")).toBeUndefined();
	});
});

describe("runs and notes", () => {
	test("a run round-trips its subject, team, notes and fog", () => {
		const run = store.createRun({
			subject: "How example.dev builds its search",
			researchers: team(2),
			notes: "We use it daily",
		});
		expect(run.slug).toContain("how-example-dev-builds");
		const read = store.readRun(run.slug)!;
		expect(read.subject).toBe("How example.dev builds its search");
		expect(read.notes).toBe("We use it daily");
		expect(read.researchers.length).toBe(2);
		expect(read.wave).toBe(1);
		store.updateRun(run.slug, { addFog: ["something about caching", "maybe an edge worker"] });
		expect(store.readRun(run.slug)!.fog.length).toBe(2);
		const removed = store.updateRun(run.slug, { removeFog: ["caching"] });
		expect(removed.success).toBe(true);
		expect(store.readRun(run.slug)!.fog).toEqual(["maybe an edge worker"]);
		expect(store.updateRun(run.slug, { removeFog: ["nothing"] }).success).toBe(false);
	});

	test("notes append in the researcher's voice and the latest topic is readable", () => {
		const researchers = team(1);
		const run = store.createRun({ subject: "x", researchers });
		store.appendNote(run.slug, researchers[0]!, "search endpoint", "Found /api/search in the network log.");
		store.appendNote(run.slug, researchers[0]!, "bundle", "Reading app.js now.");
		const diary = readFileSync(store.notesPath(run.slug, researchers[0]!.slug), "utf-8");
		expect(diary).toContain(`# Notes — ${researchers[0]!.name} the ${researchers[0]!.angle}`);
		expect(diary).toContain("Found /api/search");
		expect(store.latestNoteTopic(run.slug, researchers[0]!.slug)).toBe("bundle");
	});
});

describe("findings", () => {
	test("a finding round-trips with confidence, kind, sources and question link", () => {
		const run = store.createRun({ subject: "x", researchers: team(1) });
		store.addQuestion(run.slug, {
			title: "What serves the search results?",
			question: "Which endpoint?",
			askedBy: "user",
		});
		const filed = store.addFinding(run.slug, {
			title: "Search hits /api/search on the same origin",
			researcher: "ada-network-sleuth",
			confidence: "confirmed",
			kind: "mechanism",
			topic: "search",
			what: "Typing in the box fires GET /api/search?q=",
			evidence: "GET https://example.dev/api/search?q=abc — 200 xhr",
			sources: ["https://example.dev/"],
			question: "what-serves-the-search-results",
		});
		expect(filed.success).toBe(true);
		const view = store.viewFinding(run.slug, String(filed.finding));
		expect(view.confidence).toBe("confirmed");
		expect(view.kind).toBe("mechanism");
		expect(view.sources).toEqual(["https://example.dev/"]);
		expect(view.question).toBe("what-serves-the-search-results");
		expect(store.listFindings(run.slug).length).toBe(1);
		const question = store.viewQuestion(run.slug, "what-serves-the-search-results");
		expect((question.findings as unknown[]).length).toBe(1);
	});

	test("similar findings are detected, appended to, and can be marked duplicate or refuted", () => {
		const run = store.createRun({ subject: "x", researchers: team(2) });
		const first = store.addFinding(run.slug, {
			title: "Prices come from a JSON endpoint",
			researcher: "a",
			confidence: "likely",
			kind: "source",
			topic: "pricing",
			what: "x",
			evidence: "",
			sources: [],
		});
		expect(store.findSimilarFinding(run.slug, "pricing", "The prices come from a json endpoint")).toBeDefined();
		expect(store.findSimilarFinding(run.slug, "checkout", "Totally unrelated thing here")).toBeUndefined();
		const appended = store.appendToFinding(run.slug, String(first.finding), "b", "Saw it too, at /v2/prices", [
			"https://example.dev/v2/prices",
		]);
		expect(appended.success).toBe(true);
		const view = store.viewFinding(run.slug, String(first.finding));
		expect(view.alsoSeen).toContain("**b:** Saw it too");
		expect(view.sources).toEqual(["https://example.dev/v2/prices"]);
		const second = store.addFinding(run.slug, {
			title: "Prices come from a JSON endpoint (v2)",
			researcher: "b",
			confidence: "unverified",
			kind: "fact",
			topic: "pricing",
			what: "y",
			evidence: "",
			sources: [],
		});
		expect(store.updateFinding(run.slug, String(second.finding), { status: "duplicate" }).success).toBe(false);
		expect(
			store.updateFinding(run.slug, String(second.finding), {
				status: "duplicate",
				duplicate_of: String(first.finding),
			}).success,
		).toBe(true);
		const refuted = store.updateFinding(run.slug, String(first.finding), { status: "refuted" });
		expect(refuted.confidence).toBe("contradicted");
		expect(store.viewRun(run.slug).duplicates).toHaveLength(1);
	});
});

describe("question map", () => {
	test("frontier is open, unblocked, unclaimed; answering unblocks; cycles are rejected", () => {
		const run = store.createRun({ subject: "x", researchers: team(2) });
		const a = store.addQuestion(run.slug, {
			title: "Which framework renders the page?",
			question: "",
			askedBy: "user",
		});
		const b = store.addQuestion(run.slug, {
			title: "How does the framework hydrate the pricing table?",
			question: "",
			askedBy: "user",
			blockedBy: [String(a.question)],
		});
		expect(b.blocked).toBe(true);
		expect(store.frontier(run.slug).map((q) => q.slug)).toEqual([String(a.question)]);
		expect(store.updateQuestion(run.slug, String(a.question), { blocked_by: [String(b.question)] }).success).toBe(
			false,
		);
		const dup = store.addQuestion(run.slug, {
			title: "Which framework renders the page",
			question: "",
			askedBy: "b",
		});
		expect(dup.success).toBe(false);
		expect(dup.duplicate_of).toBe(String(a.question));

		const claim = store.claimQuestion(run.slug, String(a.question), "ada");
		expect(claim.success).toBe(true);
		expect(store.frontier(run.slug).length).toBe(0);
		expect(store.claimQuestion(run.slug, String(a.question), "alan").success).toBe(false);
		expect(store.claimQuestion(run.slug, String(b.question), "alan").success).toBe(false);
		// A stale claim rejoins the frontier.
		expect(store.frontier(run.slug, Date.now() + CLAIM_TTL_MS + 1).length).toBe(1);

		const answered = store.answerQuestion(
			run.slug,
			String(a.question),
			"ada",
			"It is Next.js: see https://example.dev/_next/",
			"Next.js",
		);
		expect(answered.success).toBe(true);
		expect(answered.unblocked).toEqual([String(b.question)]);
		expect(store.answerQuestion(run.slug, String(a.question), "ada", "again").success).toBe(false);
		const map = store.questionMap(run.slug);
		expect(map.answered).toBe(1);
		expect(map.open).toBe(1);
		expect(map.frontier.map((q) => q.slug)).toEqual([String(b.question)]);
		const view = store.viewQuestion(run.slug, String(a.question));
		expect(view.gist).toBe("Next.js");
		expect(view.answeredBy).toBe("ada");

		const dead = store.answerQuestion(
			run.slug,
			String(b.question),
			"alan",
			"Bundle is obfuscated; tried source maps, archive, repo",
			undefined,
			"dead-end",
		);
		expect(dead.status).toBe("dead-end");
		expect(store.questionMap(run.slug).deadEnds).toBe(1);
	});

	test("update_question can rule a question out of scope and reopen it", () => {
		const run = store.createRun({ subject: "x", researchers: team(1) });
		const q = store.addQuestion(run.slug, { title: "Who founded the company?", question: "", askedBy: "b" });
		const out = store.updateQuestion(run.slug, String(q.question), {
			status: "out-of-scope",
			reason: "Not about the mechanism",
		});
		expect(out.status).toBe("out-of-scope");
		expect(store.viewQuestion(run.slug, String(q.question)).gist).toBe("Not about the mechanism");
		expect(store.updateQuestion(run.slug, String(q.question), { status: "answered" }).success).toBe(false);
		expect(store.updateQuestion(run.slug, String(q.question), { status: "open" }).status).toBe("open");
		expect(store.frontier(run.slug).length).toBe(1);
	});
});

describe("performance and report", () => {
	test("performance names the best researcher and appends to form.jsonl", () => {
		const run = store.createRun({ subject: "x", researchers: team(2) });
		const result = store.writePerformance(run.slug, [
			{
				slug: "a",
				name: "A",
				angle: "observer",
				traits: {},
				status: "completed",
				findings: 2,
				points: 6,
				questionsAnswered: 0,
				actions: 10,
				tokens: 100,
				wallMs: 1,
				brief: "brief a",
			},
			{
				slug: "b",
				name: "B",
				angle: "verifier",
				traits: {},
				status: "completed",
				findings: 1,
				points: 9,
				questionsAnswered: 1,
				actions: 12,
				tokens: 200,
				wallMs: 1,
				brief: "brief b",
			},
		]);
		expect(result.best).toBe("b");
		const performance = JSON.parse(readFileSync(join(store.root, run.slug, "performance.json"), "utf-8")) as {
			researchers: { brief: string }[];
		};
		expect(performance.researchers[1]!.brief).toBe("brief b");
		expect(existsSync(join(store.root, "form.jsonl"))).toBe(true);
	});

	test("write_report completes the run and readReport returns it", () => {
		const run = store.createRun({ subject: "x", researchers: team(1) });
		expect(store.writeReport(run.slug, "## Answer\n\nYes.").success).toBe(true);
		expect(store.readRun(run.slug)!.status).toBe("complete");
		expect(store.readReport(run.slug)).toContain("## Answer");
	});
});

describe("researchTool dispatcher", () => {
	test("validates enums and required fields, and reads the map", () => {
		const run = store.createRun({ subject: "x", researchers: team(1) });
		expect(researchTool(store, { action: "add_finding", title: "t" }).success).toBe(false);
		expect(researchTool(store, { action: "add_finding", title: "t", what: "w", confidence: "sure" }).error).toContain(
			"invalid confidence",
		);
		expect(researchTool(store, { action: "add_finding", title: "t", what: "w", kind: "rumour" }).error).toContain(
			"invalid kind",
		);
		const added = researchTool(store, { action: "add_finding", title: "t", what: "w", sources: ["https://a"] });
		expect(added.success).toBe(true);
		expect(
			researchTool(store, { action: "update_finding", finding: String(added.finding), status: "maybe" }).error,
		).toContain("invalid status");
		expect(researchTool(store, { action: "add_question", title: "Q1?" }).success).toBe(true);
		expect(
			researchTool(store, { action: "answer", question: "q1", answer: "A", researcher: "synthesis" }).success,
		).toBe(true);
		expect(researchTool(store, { action: "update_question", question: "q1", status: "later" }).error).toContain(
			"invalid status",
		);
		expect(researchTool(store, { action: "update_run", add_fog: ["x"] }).fog).toEqual(["x"]);
		const list = researchTool(store, { action: "list" });
		expect((list.runs as { run: string; findings: number; questions_answered: number }[])[0]).toMatchObject({
			run: run.slug,
			findings: 1,
			questions_answered: 1,
		});
		const view = researchTool(store, { action: "view" });
		expect(view.subject).toBe("x");
		expect((view.questions as { answered: number }).answered).toBe(1);
		expect(researchTool(store, { action: "bogus" }).error).toContain("unknown action");
	});
});
