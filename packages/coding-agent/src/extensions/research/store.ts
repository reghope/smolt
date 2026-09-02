import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import type { Researcher } from "./angles.ts";

/**
 * Research: a team of investigators works a subject and everything they
 * learn is recorded as markdown under the project's `.smolt/research/`
 * directory, so a run's evidence travels with the repo the same way code
 * does.
 *
 * A run holds the subject, the team, one notes file per researcher (their
 * raw investigation diary, written as they go), the findings they filed, the
 * question map — the sharp sub-questions the subject decomposes into, with
 * blocking edges, claims, and a computed frontier, the part of wayfinder
 * worth keeping — and the synthesized report written after everyone
 * finishes. Findings follow the battletest ticket shape (frontmatter plus
 * `##` sections) so anyone who can read one tracker can read the other.
 *
 * Every operation reads from disk and writes atomically, so several
 * researcher sessions filing at once do not tread on each other.
 */

export type Confidence = "confirmed" | "likely" | "unverified" | "contradicted";
export type FindingKind = "fact" | "mechanism" | "source" | "observation" | "lead" | "dead-end" | "contradiction";
export type FindingStatus = "open" | "verified" | "refuted" | "duplicate";
export type RunStatus = "researching" | "stopped" | "complete";
export type QuestionStatus = "open" | "answered" | "dead-end" | "out-of-scope";

export const CONFIDENCES: readonly Confidence[] = ["confirmed", "likely", "unverified", "contradicted"];
export const FINDING_KINDS: readonly FindingKind[] = [
	"fact",
	"mechanism",
	"source",
	"observation",
	"lead",
	"dead-end",
	"contradiction",
];
export const FINDING_STATUSES: readonly FindingStatus[] = ["open", "verified", "refuted", "duplicate"];
export const QUESTION_STATUSES: readonly QuestionStatus[] = ["open", "answered", "dead-end", "out-of-scope"];

/** A claim older than this is treated as abandoned and the question rejoins the frontier. */
export const CLAIM_TTL_MS = 2 * 60 * 60 * 1000;

export type ResearchResult = Record<string, unknown>;

/** One researcher's end-of-run record: who they were, what they found, what it cost. */
export interface ResearcherPerformance {
	slug: string;
	name: string;
	angle: string;
	traits: Record<string, string>;
	status: string;
	/** Non-duplicate findings filed. */
	findings: number;
	/** Confidence-weighted score of those findings, plus answered questions. */
	points: number;
	questionsAnswered: number;
	actions: number;
	tokens: number;
	wallMs: number;
	/** The full brief this researcher ran under. */
	brief: string;
}

export interface ResearchFinding {
	slug: string;
	title: string;
	/** The researcher who filed it, by slug. */
	researcher: string;
	confidence: Confidence;
	kind: FindingKind;
	/** Where in the subject: a component, mechanism, page, or theme name. */
	topic: string;
	status: FindingStatus;
	/** When status is 'duplicate': the slug of the finding this repeats. */
	duplicateOf?: string;
	/** The question this finding bears on, when it bears on one. */
	question?: string;
	/** URLs, files, or commands the evidence came from. */
	sources: string[];
	created: string;
	what: string;
	evidence: string;
	/** Extra observations from other researchers who hit the same thing. */
	alsoSeen?: string;
}

export interface ResearchQuestion {
	slug: string;
	title: string;
	status: QuestionStatus;
	blockedBy: string[];
	claimedBy?: string;
	claimedAt?: string;
	/** Who raised it: a researcher slug, 'user', or 'synthesis'. */
	askedBy: string;
	created: string;
	closed?: string;
	/** One line: the answer as the report's index will show it. */
	gist?: string;
	question: string;
	answer?: string;
	/** Who answered it. */
	answeredBy?: string;
}

export interface ResearchRun {
	slug: string;
	title: string;
	status: RunStatus;
	created: string;
	updated: string;
	/** What the user asked to have researched. */
	subject: string;
	/** Standing context: what is known going in, constraints, preferences. */
	notes: string;
	/** Things sensed but not yet phrased as sharp questions. */
	fog: string[];
	researchers: Researcher[];
	/** How many dispatches this run has had: 1 for the first team, +1 per continuation. */
	wave: number;
}

interface RunFrontmatter {
	title?: string;
	status?: string;
	created?: string;
	updated?: string;
	researchers?: unknown;
	fog?: unknown;
	wave?: unknown;
}

interface FindingFrontmatter {
	title?: string;
	researcher?: string;
	confidence?: string;
	kind?: string;
	topic?: string;
	status?: string;
	duplicateOf?: string;
	question?: string;
	sources?: unknown;
	created?: string;
}

interface QuestionFrontmatter {
	title?: string;
	status?: string;
	blockedBy?: unknown;
	claimedBy?: string;
	claimedAt?: string;
	askedBy?: string;
	created?: string;
	closed?: string;
	gist?: string;
	answeredBy?: string;
}

function err(error: string): ResearchResult {
	return { success: false, error };
}

function slugify(text: string): string {
	const slug = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64)
		.replace(/-+$/g, "");
	return slug || "item";
}

function atomicWrite(path: string, content: string): void {
	const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(temp, content, "utf-8");
	renameSync(temp, path);
}

function splitFrontmatter(content: string): { yaml: string | null; body: string } {
	const normalized = content.replace(/\r\n/g, "\n").replace(/^﻿/, "");
	if (!normalized.startsWith("---")) return { yaml: null, body: normalized };
	const end = normalized.indexOf("\n---", 3);
	if (end === -1) return { yaml: null, body: normalized };
	return { yaml: normalized.slice(4, end), body: normalized.slice(end + 4).trim() };
}

/** Split a markdown body into its `## Heading` sections. */
function parseSections(body: string): Record<string, string> {
	const sections: Record<string, string> = {};
	let current: string | undefined;
	let buffer: string[] = [];
	const flush = () => {
		if (current !== undefined) sections[current] = buffer.join("\n").trim();
		buffer = [];
	};
	for (const line of body.split("\n")) {
		const heading = /^## (.+)$/.exec(line);
		if (heading) {
			flush();
			current = heading[1]!.trim();
		} else if (current !== undefined) {
			buffer.push(line);
		}
	}
	flush();
	return sections;
}

function firstLine(text: string): string {
	const line = text.split("\n")[0] ?? "";
	return line.length > 140 ? `${line.slice(0, 137)}...` : line;
}

function stringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

function parseResearchers(value: unknown): Researcher[] {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(entry): entry is Researcher =>
			typeof entry === "object" && entry !== null && typeof (entry as Researcher).slug === "string",
	);
}

const CONFIDENCE_ORDER: Record<Confidence, number> = { confirmed: 0, likely: 1, unverified: 2, contradicted: 3 };

function normText(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

function textTokens(text: string): Set<string> {
	return new Set(
		normText(text)
			.split(" ")
			.filter((word) => word.length > 2),
	);
}

/**
 * Whether two filings read like the same finding: an identical title
 * anywhere, or the same topic with most of the same title words. Deliberately
 * mechanical and conservative — a false match costs one `force` refile, a
 * missed match costs one duplicate the synthesis folds.
 */
function sameFinding(candidate: { topic: string; title: string }, existing: { topic: string; title: string }): boolean {
	if (normText(existing.title) === normText(candidate.title)) return true;
	if (normText(existing.topic) !== normText(candidate.topic)) return false;
	const want = textTokens(candidate.title);
	if (want.size === 0) return false;
	const theirs = textTokens(existing.title);
	let overlap = 0;
	for (const word of want) if (theirs.has(word)) overlap++;
	const needed = Math.max(2, Math.ceil(Math.min(want.size, theirs.size) * 0.6));
	return overlap >= needed;
}

export class ResearchStore {
	readonly root: string;

	constructor(root: string) {
		this.root = root;
	}

	// ------------------------------------------------------------------
	// Disk layout:
	//   <root>/<run-slug>/run.md
	//   <root>/<run-slug>/notes/<researcher-slug>.md
	//   <root>/<run-slug>/findings/<slug>.md
	//   <root>/<run-slug>/questions/<slug>.md
	//   <root>/<run-slug>/report.md
	//   <root>/<run-slug>/metrics/<researcher-slug>.jsonl (+ .summary.json)
	//   <root>/<run-slug>/performance.json
	//   <root>/form.jsonl
	// ------------------------------------------------------------------

	private runDir(runSlug: string): string {
		return join(this.root, runSlug);
	}

	private findingsDir(runSlug: string): string {
		return join(this.runDir(runSlug), "findings");
	}

	private questionsDir(runSlug: string): string {
		return join(this.runDir(runSlug), "questions");
	}

	notesDir(runSlug: string): string {
		return join(this.runDir(runSlug), "notes");
	}

	notesPath(runSlug: string, researcherSlug: string): string {
		return join(this.notesDir(runSlug), `${researcherSlug}.md`);
	}

	reportPath(runSlug: string): string {
		return join(this.runDir(runSlug), "report.md");
	}

	/**
	 * A directory a researcher may use for browser profiles, cloned repos,
	 * downloaded bundles and scratch scripts. Under the OS temp dir, never
	 * inside the project: a browser profile is tens of thousands of files.
	 */
	profileDir(runSlug: string, researcherSlug: string): string {
		return join(tmpdir(), "smolt-research", runSlug, researcherSlug);
	}

	metricsDir(runSlug: string): string {
		return join(this.runDir(runSlug), "metrics");
	}

	metricsPath(runSlug: string, researcherSlug: string): string {
		return join(this.metricsDir(runSlug), `${researcherSlug}.jsonl`);
	}

	metricsSummaryPath(runSlug: string, researcherSlug: string): string {
		return join(this.metricsDir(runSlug), `${researcherSlug}.summary.json`);
	}

	writeMetricsSummary(runSlug: string, researcherSlug: string, summary: unknown): void {
		mkdirSync(this.metricsDir(runSlug), { recursive: true });
		atomicWrite(this.metricsSummaryPath(runSlug, researcherSlug), `${JSON.stringify(summary, null, "\t")}\n`);
	}

	// ------------------------------------------------------------------
	// Runs
	// ------------------------------------------------------------------

	readRun(runSlug: string): ResearchRun | undefined {
		const path = join(this.runDir(runSlug), "run.md");
		if (!existsSync(path)) return undefined;
		const { yaml, body } = splitFrontmatter(readFileSync(path, "utf-8"));
		const fm = (yaml ? (parse(yaml) as RunFrontmatter) : {}) ?? {};
		const sections = parseSections(body);
		const status: RunStatus =
			fm.status === "complete" ? "complete" : fm.status === "stopped" ? "stopped" : "researching";
		return {
			slug: runSlug,
			title: fm.title ?? runSlug,
			status,
			created: fm.created ?? "",
			updated: fm.updated ?? "",
			subject: sections.Subject ?? "",
			notes: sections.Notes ?? "",
			fog: stringList(fm.fog),
			researchers: parseResearchers(fm.researchers),
			wave: typeof fm.wave === "number" && fm.wave > 0 ? fm.wave : 1,
		};
	}

	private writeRun(run: ResearchRun): void {
		mkdirSync(this.runDir(run.slug), { recursive: true });
		const frontmatter = stringify({
			title: run.title,
			status: run.status,
			created: run.created,
			updated: run.updated,
			wave: run.wave,
			fog: run.fog,
			researchers: run.researchers,
		});
		const body = `## Subject\n\n${run.subject}\n\n## Notes\n\n${run.notes}\n`;
		atomicWrite(join(this.runDir(run.slug), "run.md"), `---\n${frontmatter}---\n\n${body}`);
	}

	listRunSlugs(): string[] {
		if (!existsSync(this.root)) return [];
		return readdirSync(this.root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && existsSync(join(this.root, entry.name, "run.md")))
			.map((entry) => entry.name)
			.sort();
	}

	listRuns(): ResearchRun[] {
		return this.listRunSlugs()
			.map((slug) => this.readRun(slug))
			.filter((run): run is ResearchRun => run !== undefined);
	}

	/** The run a reference names: exact slug, else the newest run when ref is empty. */
	resolveRun(ref: string): ResearchRun | undefined {
		const needle = ref.trim().toLowerCase();
		if (needle !== "") {
			return this.readRun(needle) ?? this.readRun(slugify(ref));
		}
		const slugs = this.listRunSlugs();
		const last = slugs[slugs.length - 1];
		return last ? this.readRun(last) : undefined;
	}

	createRun(params: { subject: string; researchers: Researcher[]; notes?: string; now?: Date }): ResearchRun {
		const now = params.now ?? new Date();
		const stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
		const subjectPart = params.subject.trim() === "" ? "" : `-${slugify(params.subject).slice(0, 32)}`;
		let slug = `${stamp}${subjectPart}`;
		for (let n = 2; this.readRun(slug); n++) slug = `${stamp}${subjectPart}-${n}`;
		const run: ResearchRun = {
			slug,
			title:
				params.subject.trim() === ""
					? `Research ${now.toISOString().slice(0, 10)}`
					: `Research: ${firstLine(params.subject.trim())}`,
			status: "researching",
			created: now.toISOString(),
			updated: now.toISOString(),
			subject: params.subject.trim(),
			notes: (params.notes ?? "").trim(),
			fog: [],
			researchers: params.researchers,
			wave: 1,
		};
		this.writeRun(run);
		mkdirSync(this.notesDir(slug), { recursive: true });
		mkdirSync(this.findingsDir(slug), { recursive: true });
		mkdirSync(this.questionsDir(slug), { recursive: true });
		return run;
	}

	setRunStatus(runSlug: string, status: RunStatus): ResearchResult {
		const run = this.readRun(runSlug);
		if (!run) return err(`Unknown run '${runSlug}'. Runs: ${this.listRunSlugs().join(", ") || "(none)"}`);
		run.status = status;
		run.updated = new Date().toISOString();
		this.writeRun(run);
		return { success: true, run: runSlug, status };
	}

	/** Notes, fog, and the team change as a run learns; the subject never does. */
	updateRun(
		runSlug: string,
		params: {
			notes?: string;
			addFog?: string[];
			removeFog?: string[];
			researchers?: Researcher[];
			wave?: number;
		},
	): ResearchResult {
		const run = this.readRun(runSlug);
		if (!run) return err(`Unknown run '${runSlug}'`);
		if (params.notes !== undefined) run.notes = params.notes.trim();
		for (const entry of params.addFog ?? []) {
			const text = entry.trim();
			if (text !== "" && !run.fog.includes(text)) run.fog.push(text);
		}
		for (const needle of params.removeFog ?? []) {
			const key = needle.trim().toLowerCase();
			if (key === "") continue;
			const matches = run.fog.filter((entry) => entry.toLowerCase().includes(key));
			if (matches.length === 1) run.fog = run.fog.filter((entry) => entry !== matches[0]);
			else if (matches.length > 1)
				return err(`remove_fog '${needle}' matches ${matches.length} entries; be more specific`);
			else return err(`remove_fog '${needle}' matches no fog entry`);
		}
		if (params.researchers !== undefined) run.researchers = params.researchers;
		if (params.wave !== undefined) run.wave = params.wave;
		run.updated = new Date().toISOString();
		this.writeRun(run);
		return { success: true, run: runSlug, fog: run.fog, wave: run.wave };
	}

	// ------------------------------------------------------------------
	// Notes: one append-only diary per researcher.
	// ------------------------------------------------------------------

	appendNote(runSlug: string, researcher: Researcher, topic: string, text: string): ResearchResult {
		const run = this.readRun(runSlug);
		if (!run) return err(`Unknown run '${runSlug}'`);
		mkdirSync(this.notesDir(runSlug), { recursive: true });
		const path = this.notesPath(runSlug, researcher.slug);
		if (!existsSync(path)) {
			atomicWrite(path, `# Notes — ${researcher.name} the ${researcher.angle}\n`);
		}
		const stamp = new Date().toISOString().slice(11, 19);
		appendFileSync(path, `\n### ${stamp} — ${topic.trim() || "general"}\n\n${text.trim()}\n`, "utf-8");
		return { success: true, run: runSlug, notes: path };
	}

	/** The topic heading of a researcher's most recent diary note — "where they are now". */
	latestNoteTopic(runSlug: string, researcherSlug: string): string | undefined {
		try {
			const raw = readFileSync(this.notesPath(runSlug, researcherSlug), "utf-8");
			const headings = raw.match(/^### [\d:]+ — (.+)$/gm);
			const last = headings?.[headings.length - 1];
			return last ? /— (.+)$/.exec(last)?.[1] : undefined;
		} catch {
			return undefined;
		}
	}

	// ------------------------------------------------------------------
	// Findings
	// ------------------------------------------------------------------

	private readFinding(runSlug: string, slug: string): ResearchFinding | undefined {
		const path = join(this.findingsDir(runSlug), `${slug}.md`);
		if (!existsSync(path)) return undefined;
		const { yaml, body } = splitFrontmatter(readFileSync(path, "utf-8"));
		const fm = (yaml ? (parse(yaml) as FindingFrontmatter) : {}) ?? {};
		const sections = parseSections(body);
		const finding: ResearchFinding = {
			slug,
			title: fm.title ?? slug,
			researcher: fm.researcher ?? "",
			confidence: CONFIDENCES.includes(fm.confidence as Confidence) ? (fm.confidence as Confidence) : "unverified",
			kind: FINDING_KINDS.includes(fm.kind as FindingKind) ? (fm.kind as FindingKind) : "fact",
			topic: fm.topic ?? "",
			status: FINDING_STATUSES.includes(fm.status as FindingStatus) ? (fm.status as FindingStatus) : "open",
			sources: stringList(fm.sources),
			created: fm.created ?? "",
			what: sections["What we found"] ?? "",
			evidence: sections.Evidence ?? "",
		};
		if (fm.duplicateOf) finding.duplicateOf = fm.duplicateOf;
		if (fm.question) finding.question = fm.question;
		if (sections["Also seen"]) finding.alsoSeen = sections["Also seen"];
		return finding;
	}

	private writeFinding(runSlug: string, finding: ResearchFinding): void {
		mkdirSync(this.findingsDir(runSlug), { recursive: true });
		const fm: Record<string, unknown> = {
			title: finding.title,
			researcher: finding.researcher,
			confidence: finding.confidence,
			kind: finding.kind,
			topic: finding.topic,
			status: finding.status,
			sources: finding.sources,
			created: finding.created,
		};
		if (finding.duplicateOf) fm.duplicateOf = finding.duplicateOf;
		if (finding.question) fm.question = finding.question;
		const sources =
			finding.sources.length === 0 ? "(none recorded)" : finding.sources.map((s) => `- ${s}`).join("\n");
		const body =
			`## What we found\n\n${finding.what}\n\n## Evidence\n\n${finding.evidence}\n\n## Sources\n\n${sources}\n` +
			(finding.alsoSeen ? `\n## Also seen\n\n${finding.alsoSeen}\n` : "");
		atomicWrite(join(this.findingsDir(runSlug), `${finding.slug}.md`), `---\n${stringify(fm)}---\n\n${body}`);
	}

	/** Strongest confidence first, then by slug: the reading order of a synthesis. */
	listFindings(runSlug: string): ResearchFinding[] {
		const dir = this.findingsDir(runSlug);
		if (!existsSync(dir)) return [];
		return readdirSync(dir)
			.filter((name) => name.endsWith(".md"))
			.sort()
			.map((name) => this.readFinding(runSlug, name.slice(0, -3)))
			.filter((finding): finding is ResearchFinding => finding !== undefined)
			.sort(
				(a, b) => CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence] || a.slug.localeCompare(b.slug),
			);
	}

	/**
	 * An existing finding that reads like the same thing: same topic and most
	 * of the same title words, or an identical title anywhere. Duplicates
	 * don't count; the original they point at does.
	 */
	findSimilarFinding(runSlug: string, topic: string, title: string): ResearchFinding | undefined {
		for (const finding of this.listFindings(runSlug)) {
			if (finding.status === "duplicate") continue;
			if (sameFinding({ topic, title }, finding)) return finding;
		}
		return undefined;
	}

	/** Another researcher's observations, appended to a finding they did not file. */
	appendToFinding(
		runSlug: string,
		ref: string,
		researcherSlug: string,
		text: string,
		sources?: string[],
	): ResearchResult {
		const run = this.readRun(runSlug);
		if (!run) return err(`Unknown run '${runSlug}'`);
		const finding = this.readFinding(runSlug, ref.trim()) ?? this.readFinding(runSlug, slugify(ref));
		if (!finding) {
			const slugs = this.listFindings(runSlug).map((f) => f.slug);
			return err(`Unknown finding '${ref}'. Findings: ${slugs.join(", ") || "(none)"}`);
		}
		const entry = `**${researcherSlug}:** ${text.trim()}`;
		finding.alsoSeen = finding.alsoSeen ? `${finding.alsoSeen}\n\n${entry}` : entry;
		for (const source of sources ?? []) {
			if (source.trim() !== "" && !finding.sources.includes(source.trim())) finding.sources.push(source.trim());
		}
		this.writeFinding(runSlug, finding);
		return { success: true, run: runSlug, finding: finding.slug };
	}

	addFinding(
		runSlug: string,
		params: {
			title: string;
			researcher: string;
			confidence: Confidence;
			kind: FindingKind;
			topic: string;
			what: string;
			evidence: string;
			sources: string[];
			question?: string;
		},
	): ResearchResult {
		const run = this.readRun(runSlug);
		if (!run) return err(`Unknown run '${runSlug}'`);
		if (params.question !== undefined && params.question.trim() !== "") {
			const question = this.lookupQuestion(runSlug, params.question);
			if (!question) return err(`Unknown question '${params.question}'`);
			params.question = question.slug;
		}
		const existing = new Set(this.listFindings(runSlug).map((finding) => finding.slug));
		let slug = slugify(params.title);
		for (let n = 2; existing.has(slug); n++) slug = `${slugify(params.title)}-${n}`;
		this.writeFinding(runSlug, {
			slug,
			title: params.title,
			researcher: params.researcher,
			confidence: params.confidence,
			kind: params.kind,
			topic: params.topic.trim(),
			status: "open",
			sources: params.sources.map((s) => s.trim()).filter((s) => s !== ""),
			created: new Date().toISOString(),
			what: params.what.trim(),
			evidence: params.evidence.trim(),
			...(params.question ? { question: params.question } : {}),
		});
		return { success: true, run: runSlug, finding: slug };
	}

	viewFinding(runRef: string, ref: string): ResearchResult {
		const run = this.resolveRun(runRef);
		if (!run) return err(`Unknown run '${runRef}'`);
		const finding = this.readFinding(run.slug, ref.trim()) ?? this.readFinding(run.slug, slugify(ref));
		if (!finding) {
			const slugs = this.listFindings(run.slug).map((f) => f.slug);
			return err(`Unknown finding '${ref}' on run '${run.slug}'. Findings: ${slugs.join(", ") || "(none)"}`);
		}
		return { success: true, run: run.slug, ...finding };
	}

	updateFinding(
		runRef: string,
		ref: string,
		params: { status?: FindingStatus; duplicate_of?: string; confidence?: Confidence },
	): ResearchResult {
		const run = this.resolveRun(runRef);
		if (!run) return err(`Unknown run '${runRef}'`);
		const finding = this.readFinding(run.slug, ref.trim()) ?? this.readFinding(run.slug, slugify(ref));
		if (!finding) return err(`Unknown finding '${ref}' on run '${run.slug}'`);
		if (params.status === "duplicate") {
			const target = params.duplicate_of?.trim() ?? "";
			if (target === "") return err("marking a finding 'duplicate' requires 'duplicate_of'");
			const canonical = this.readFinding(run.slug, target) ?? this.readFinding(run.slug, slugify(target));
			if (!canonical) return err(`duplicate_of: unknown finding '${target}'`);
			if (canonical.slug === finding.slug) return err("a finding cannot be a duplicate of itself");
			finding.duplicateOf = canonical.slug;
		}
		if (params.status !== undefined) finding.status = params.status;
		if (params.confidence !== undefined) finding.confidence = params.confidence;
		// A refuted finding is by definition no longer something we believe.
		if (params.status === "refuted") finding.confidence = "contradicted";
		this.writeFinding(run.slug, finding);
		return {
			success: true,
			run: run.slug,
			finding: finding.slug,
			status: finding.status,
			confidence: finding.confidence,
		};
	}

	// ------------------------------------------------------------------
	// Questions: the map of what the subject decomposes into. Sharp questions
	// with blocking edges, claims so two researchers never chase the same
	// one, and a computed frontier — open, unblocked, unclaimed — that says
	// what is takeable right now. Kept from wayfinder; the judgment about
	// what to ask stays with the model, the bookkeeping lives here.
	// ------------------------------------------------------------------

	private readQuestion(runSlug: string, slug: string): ResearchQuestion | undefined {
		const path = join(this.questionsDir(runSlug), `${slug}.md`);
		if (!existsSync(path)) return undefined;
		const { yaml, body } = splitFrontmatter(readFileSync(path, "utf-8"));
		const fm = (yaml ? (parse(yaml) as QuestionFrontmatter) : {}) ?? {};
		const sections = parseSections(body);
		const question: ResearchQuestion = {
			slug,
			title: fm.title ?? slug,
			status: QUESTION_STATUSES.includes(fm.status as QuestionStatus) ? (fm.status as QuestionStatus) : "open",
			blockedBy: stringList(fm.blockedBy),
			askedBy: fm.askedBy ?? "",
			created: fm.created ?? "",
			question: sections.Question ?? "",
		};
		if (fm.claimedBy) question.claimedBy = fm.claimedBy;
		if (fm.claimedAt) question.claimedAt = fm.claimedAt;
		if (fm.closed) question.closed = fm.closed;
		if (fm.gist) question.gist = fm.gist;
		if (fm.answeredBy) question.answeredBy = fm.answeredBy;
		if (sections.Answer) question.answer = sections.Answer;
		return question;
	}

	private writeQuestion(runSlug: string, question: ResearchQuestion): void {
		mkdirSync(this.questionsDir(runSlug), { recursive: true });
		const fm: Record<string, unknown> = {
			title: question.title,
			status: question.status,
			blockedBy: question.blockedBy,
			askedBy: question.askedBy,
			created: question.created,
		};
		if (question.claimedBy) fm.claimedBy = question.claimedBy;
		if (question.claimedAt) fm.claimedAt = question.claimedAt;
		if (question.closed) fm.closed = question.closed;
		if (question.gist) fm.gist = question.gist;
		if (question.answeredBy) fm.answeredBy = question.answeredBy;
		const body =
			`## Question\n\n${question.question}\n` + (question.answer ? `\n## Answer\n\n${question.answer}\n` : "");
		atomicWrite(join(this.questionsDir(runSlug), `${question.slug}.md`), `---\n${stringify(fm)}---\n\n${body}`);
	}

	listQuestions(runSlug: string): ResearchQuestion[] {
		const dir = this.questionsDir(runSlug);
		if (!existsSync(dir)) return [];
		return readdirSync(dir)
			.filter((name) => name.endsWith(".md"))
			.sort()
			.map((name) => this.readQuestion(runSlug, name.slice(0, -3)))
			.filter((question): question is ResearchQuestion => question !== undefined)
			.sort((a, b) => a.created.localeCompare(b.created) || a.slug.localeCompare(b.slug));
	}

	private lookupQuestion(runSlug: string, ref: string): ResearchQuestion | undefined {
		const needle = ref.trim();
		if (needle === "") return undefined;
		const direct = this.readQuestion(runSlug, needle) ?? this.readQuestion(runSlug, slugify(needle));
		if (direct) return direct;
		const lower = needle.toLowerCase();
		return this.listQuestions(runSlug).find((question) => question.title.toLowerCase() === lower);
	}

	private claimFresh(question: ResearchQuestion, now: number): boolean {
		if (!question.claimedBy || !question.claimedAt) return false;
		const at = Date.parse(question.claimedAt);
		return Number.isFinite(at) && now - at < CLAIM_TTL_MS;
	}

	private isUnblocked(question: ResearchQuestion, bySlug: Map<string, ResearchQuestion>): boolean {
		return question.blockedBy.every((slug) => {
			const blocker = bySlug.get(slug);
			return blocker === undefined || blocker.status !== "open";
		});
	}

	/** Open, unblocked, unclaimed (or stale-claimed): what a researcher can take right now. */
	frontier(runSlug: string, now = Date.now()): ResearchQuestion[] {
		const all = this.listQuestions(runSlug);
		const bySlug = new Map(all.map((question) => [question.slug, question]));
		return all.filter(
			(question) =>
				question.status === "open" && this.isUnblocked(question, bySlug) && !this.claimFresh(question, now),
		);
	}

	/** Reject a blockedBy edit that would make a question depend on itself, directly or transitively. */
	private detectCycle(runSlug: string, slug: string, blockedBy: string[]): string | undefined {
		const bySlug = new Map(this.listQuestions(runSlug).map((question) => [question.slug, question.blockedBy]));
		bySlug.set(slug, blockedBy);
		const seen = new Set<string>();
		const stack = [...blockedBy];
		while (stack.length > 0) {
			const current = stack.pop()!;
			if (current === slug) return `blocking '${current}' would create a cycle`;
			if (seen.has(current)) continue;
			seen.add(current);
			stack.push(...(bySlug.get(current) ?? []));
		}
		return undefined;
	}

	addQuestion(
		runSlug: string,
		params: { title: string; question: string; askedBy: string; blockedBy?: string[] },
	): ResearchResult {
		const run = this.readRun(runSlug);
		if (!run) return err(`Unknown run '${runSlug}'`);
		const title = params.title.trim();
		if (title === "") return err("a question needs a title");
		// The same question asked twice by two researchers is one question.
		const existing = this.listQuestions(runSlug);
		const same = existing.find(
			(question) =>
				normText(question.title) === normText(title) ||
				(question.status === "open" && sameFinding({ topic: "", title }, { topic: "", title: question.title })),
		);
		if (same) {
			return {
				success: false,
				duplicate_of: same.slug,
				existing_title: same.title,
				status: same.status,
				error: `'${same.slug}' already asks this${same.status === "open" ? "" : ` (${same.status})`}`,
			};
		}
		const taken = new Set(existing.map((question) => question.slug));
		let slug = slugify(title);
		for (let n = 2; taken.has(slug); n++) slug = `${slugify(title)}-${n}`;
		const blockedBy: string[] = [];
		for (const ref of params.blockedBy ?? []) {
			const blocker = this.lookupQuestion(runSlug, ref);
			if (!blocker) return err(`blocked_by: unknown question '${ref}'`);
			if (!blockedBy.includes(blocker.slug)) blockedBy.push(blocker.slug);
		}
		this.writeQuestion(runSlug, {
			slug,
			title,
			status: "open",
			blockedBy,
			askedBy: params.askedBy,
			created: new Date().toISOString(),
			question: params.question.trim() || title,
		});
		return { success: true, run: runSlug, question: slug, blocked: blockedBy.length > 0 };
	}

	viewQuestion(runRef: string, ref: string): ResearchResult {
		const run = this.resolveRun(runRef);
		if (!run) return err(`Unknown run '${runRef}'`);
		const question = this.lookupQuestion(run.slug, ref);
		if (!question) {
			const slugs = this.listQuestions(run.slug).map((q) => q.slug);
			return err(`Unknown question '${ref}' on run '${run.slug}'. Questions: ${slugs.join(", ") || "(none)"}`);
		}
		const findings = this.listFindings(run.slug)
			.filter((finding) => finding.question === question.slug && finding.status !== "duplicate")
			.map((finding) => ({ finding: finding.slug, title: finding.title, confidence: finding.confidence }));
		return { success: true, run: run.slug, ...question, findings };
	}

	updateQuestion(
		runRef: string,
		ref: string,
		params: { blocked_by?: string[]; question?: string; status?: QuestionStatus; reason?: string },
	): ResearchResult {
		const run = this.resolveRun(runRef);
		if (!run) return err(`Unknown run '${runRef}'`);
		const question = this.lookupQuestion(run.slug, ref);
		if (!question) return err(`Unknown question '${ref}' on run '${run.slug}'`);
		if (params.blocked_by !== undefined) {
			const blockedBy: string[] = [];
			for (const blockerRef of params.blocked_by) {
				const blocker = this.lookupQuestion(run.slug, blockerRef);
				if (!blocker) return err(`blocked_by: unknown question '${blockerRef}'`);
				if (blocker.slug === question.slug) return err("a question cannot block itself");
				if (!blockedBy.includes(blocker.slug)) blockedBy.push(blocker.slug);
			}
			const cycle = this.detectCycle(run.slug, question.slug, blockedBy);
			if (cycle) return err(cycle);
			question.blockedBy = blockedBy;
		}
		if (params.question !== undefined && params.question.trim() !== "") question.question = params.question.trim();
		if (params.status !== undefined) {
			if (params.status === "answered") return err("use 'answer' to answer a question; it needs the answer text");
			question.status = params.status;
			if (params.status === "open") {
				question.closed = undefined;
				question.answer = undefined;
				question.gist = undefined;
				question.answeredBy = undefined;
			} else {
				question.closed = new Date().toISOString();
				if (params.reason?.trim()) question.gist = firstLine(params.reason.trim());
				if (params.reason?.trim()) question.answer = params.reason.trim();
			}
		}
		this.writeQuestion(run.slug, question);
		return {
			success: true,
			run: run.slug,
			question: question.slug,
			status: question.status,
			blocked_by: question.blockedBy,
		};
	}

	/** Take a question for one researcher; a fresh claim by another is honoured unless forced. */
	claimQuestion(runSlug: string, ref: string, by: string, force = false, now = Date.now()): ResearchResult {
		const question = this.lookupQuestion(runSlug, ref);
		if (!question) return err(`Unknown question '${ref}'`);
		if (question.status !== "open") return err(`'${question.slug}' is ${question.status}; nothing to claim`);
		if (question.claimedBy && question.claimedBy !== by && this.claimFresh(question, now) && !force) {
			return {
				success: false,
				error: `'${question.slug}' is being worked by ${question.claimedBy}. Take a different frontier question, or pass force only if that claim is clearly dead.`,
				claimed_by: question.claimedBy,
			};
		}
		const bySlug = new Map(this.listQuestions(runSlug).map((q) => [q.slug, q]));
		const openBlockers = question.blockedBy.filter((slug) => bySlug.get(slug)?.status === "open");
		if (openBlockers.length > 0 && !force) {
			return err(`'${question.slug}' waits on: ${openBlockers.join(", ")}. Answer those first, or pass force.`);
		}
		question.claimedBy = by;
		question.claimedAt = new Date(now).toISOString();
		this.writeQuestion(runSlug, question);
		return { success: true, run: runSlug, question: question.slug, claimed_by: by, text: question.question };
	}

	releaseQuestion(runSlug: string, ref: string, by: string): ResearchResult {
		const question = this.lookupQuestion(runSlug, ref);
		if (!question) return err(`Unknown question '${ref}'`);
		if (question.claimedBy && question.claimedBy !== by) {
			return err(`'${question.slug}' is claimed by ${question.claimedBy}, not you`);
		}
		question.claimedBy = undefined;
		question.claimedAt = undefined;
		this.writeQuestion(runSlug, question);
		return { success: true, run: runSlug, question: question.slug };
	}

	/**
	 * Answer a question and report what it just unblocked. The gist is the
	 * line the report's index shows; the answer carries the substance and
	 * the URLs that back it.
	 */
	answerQuestion(
		runSlug: string,
		ref: string,
		by: string,
		answer: string,
		gist?: string,
		status: "answered" | "dead-end" = "answered",
	): ResearchResult {
		const question = this.lookupQuestion(runSlug, ref);
		if (!question) return err(`Unknown question '${ref}'`);
		if (question.status !== "open") return err(`'${question.slug}' is already ${question.status}`);
		if (answer.trim() === "") return err("an answer needs text");
		const before = new Set(this.frontier(runSlug).map((q) => q.slug));
		question.status = status;
		question.answer = answer.trim();
		question.gist = (gist ?? "").trim() || firstLine(answer.trim());
		question.answeredBy = by;
		question.closed = new Date().toISOString();
		question.claimedBy = undefined;
		question.claimedAt = undefined;
		this.writeQuestion(runSlug, question);
		const unblocked = this.frontier(runSlug)
			.filter((q) => !before.has(q.slug))
			.map((q) => q.slug);
		return { success: true, run: runSlug, question: question.slug, status, unblocked };
	}

	/** The question map at a glance, for briefs, waits, and the view. */
	questionMap(runSlug: string): {
		open: number;
		answered: number;
		deadEnds: number;
		outOfScope: number;
		frontier: ResearchQuestion[];
		blocked: ResearchQuestion[];
		claimed: ResearchQuestion[];
		closed: ResearchQuestion[];
	} {
		const all = this.listQuestions(runSlug);
		const bySlug = new Map(all.map((q) => [q.slug, q]));
		const now = Date.now();
		const frontier = this.frontier(runSlug, now);
		const frontierSlugs = new Set(frontier.map((q) => q.slug));
		const open = all.filter((q) => q.status === "open");
		return {
			open: open.length,
			answered: all.filter((q) => q.status === "answered").length,
			deadEnds: all.filter((q) => q.status === "dead-end").length,
			outOfScope: all.filter((q) => q.status === "out-of-scope").length,
			frontier,
			blocked: open.filter((q) => !this.isUnblocked(q, bySlug)),
			claimed: open.filter((q) => this.claimFresh(q, now) && !frontierSlugs.has(q.slug)),
			closed: all.filter((q) => q.status !== "open"),
		};
	}

	// ------------------------------------------------------------------
	// Performance, report and views
	// ------------------------------------------------------------------

	writePerformance(runSlug: string, entries: ResearcherPerformance[]): ResearchResult {
		const run = this.readRun(runSlug);
		if (!run) return err(`Unknown run '${runSlug}'`);
		const best = [...entries].sort((a, b) => b.points - a.points || a.tokens - b.tokens)[0];
		const payload = {
			run: runSlug,
			wave: run.wave,
			recorded: new Date().toISOString(),
			best: best && best.points > 0 ? best.slug : null,
			researchers: entries,
		};
		atomicWrite(join(this.runDir(runSlug), "performance.json"), `${JSON.stringify(payload, null, "\t")}\n`);
		const lines = entries
			.map(({ brief: _brief, ...rest }) =>
				JSON.stringify({ run: runSlug, best: payload.best !== null && rest.slug === payload.best, ...rest }),
			)
			.join("\n");
		try {
			appendFileSync(join(this.root, "form.jsonl"), `${lines}\n`, "utf-8");
		} catch {
			// The cumulative record is best-effort; the per-run file stands.
		}
		return { success: true, run: runSlug, best: payload.best };
	}

	writeReport(runRef: string, content: string): ResearchResult {
		const run = this.resolveRun(runRef);
		if (!run) return err(`Unknown run '${runRef}'`);
		atomicWrite(this.reportPath(run.slug), `${content.trim()}\n`);
		this.setRunStatus(run.slug, "complete");
		return { success: true, run: run.slug, report: this.reportPath(run.slug) };
	}

	/** The report of an earlier run, for a new run on a related subject to start from. */
	readReport(runSlug: string): string | undefined {
		const path = this.reportPath(runSlug);
		if (!existsSync(path)) return undefined;
		try {
			return readFileSync(path, "utf-8");
		} catch {
			return undefined;
		}
	}

	/** The full picture of one run: team, question map, findings by confidence, note files. */
	viewRun(runRef: string): ResearchResult {
		const run = this.resolveRun(runRef);
		if (!run) {
			return err(`Unknown run '${runRef}'. Runs: ${this.listRunSlugs().join(", ") || "(none)"}`);
		}
		const findings = this.listFindings(run.slug);
		const map = this.questionMap(run.slug);
		const notes = run.researchers
			.map((researcher) => ({
				researcher: researcher.slug,
				name: researcher.name,
				angle: researcher.angle,
				path: this.notesPath(run.slug, researcher.slug),
				exists: existsSync(this.notesPath(run.slug, researcher.slug)),
			}))
			.map((entry) => ({ ...entry, path: entry.exists ? entry.path : `${entry.path} (no notes yet)` }));
		const metrics = run.researchers
			.map((researcher) => this.metricsSummaryPath(run.slug, researcher.slug))
			.filter((path) => existsSync(path));
		const brief = (question: ResearchQuestion) => ({
			question: question.slug,
			title: question.title,
			...(question.claimedBy ? { claimed_by: question.claimedBy } : {}),
			...(question.blockedBy.length > 0 ? { blocked_by: question.blockedBy } : {}),
		});
		return {
			success: true,
			run: run.slug,
			title: run.title,
			status: run.status,
			wave: run.wave,
			subject: run.subject,
			notes: run.notes,
			fog: run.fog,
			researchers: run.researchers.map((researcher) => ({
				slug: researcher.slug,
				name: researcher.name,
				angle: researcher.angle,
				traits: researcher.traits,
			})),
			questions: {
				open: map.open,
				answered: map.answered,
				dead_ends: map.deadEnds,
				out_of_scope: map.outOfScope,
				frontier: map.frontier.map(brief),
				claimed: map.claimed.map(brief),
				blocked: map.blocked.map(brief),
				closed: map.closed.map((question) => ({
					question: question.slug,
					title: question.title,
					status: question.status,
					gist: question.gist ?? "",
					...(question.answeredBy ? { answered_by: question.answeredBy } : {}),
				})),
			},
			findings: findings
				.filter((finding) => finding.status !== "duplicate")
				.map((finding) => ({
					finding: finding.slug,
					title: finding.title,
					confidence: finding.confidence,
					kind: finding.kind,
					topic: finding.topic,
					status: finding.status,
					researcher: finding.researcher,
					...(finding.question ? { question: finding.question } : {}),
					sources: finding.sources.length,
				})),
			duplicates: findings
				.filter((finding) => finding.status === "duplicate")
				.map((finding) => ({ finding: finding.slug, title: finding.title, duplicate_of: finding.duplicateOf })),
			notes_files: notes,
			metrics_summaries: metrics,
			report: existsSync(this.reportPath(run.slug)) ? this.reportPath(run.slug) : undefined,
		};
	}
}

// ------------------------------------------------------------------
// Tool dispatcher for the parent-session `research` tool. The run/wait
// lifecycle actions live in index.ts, where the team roster is; everything
// that only touches disk is dispatched here.
// ------------------------------------------------------------------

export interface ResearchToolParams {
	action?: string;
	run?: string | null;
	finding?: string | null;
	question?: string | null;
	title?: string | null;
	researcher?: string | null;
	confidence?: string | null;
	kind?: string | null;
	topic?: string | null;
	what?: string | null;
	evidence?: string | null;
	sources?: string[] | null;
	status?: string | null;
	duplicate_of?: string | null;
	text?: string | null;
	answer?: string | null;
	gist?: string | null;
	blocked_by?: string[] | null;
	reason?: string | null;
	notes?: string | null;
	add_fog?: string[] | null;
	remove_fog?: string[] | null;
	content?: string | null;
	seconds?: number | null;
}

export function researchTool(store: ResearchStore, params: ResearchToolParams): ResearchResult {
	const action = params.action ?? "";
	const need = (name: keyof ResearchToolParams): string | undefined => {
		const value = params[name];
		return typeof value === "string" && value.trim() !== "" ? value : undefined;
	};
	const list = (name: keyof ResearchToolParams): string[] | undefined => {
		const value = params[name];
		return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
	};

	switch (action) {
		case "list": {
			const runs = store.listRuns().map((run) => {
				const findings = store.listFindings(run.slug);
				const map = store.questionMap(run.slug);
				return {
					run: run.slug,
					title: run.title,
					status: run.status,
					wave: run.wave,
					researchers: run.researchers.length,
					findings: findings.filter((finding) => finding.status !== "duplicate").length,
					questions_open: map.open,
					questions_answered: map.answered,
					report: existsSync(store.reportPath(run.slug)),
				};
			});
			return { success: true, runs };
		}
		case "view":
			return store.viewRun(need("run") ?? "");
		case "view_finding": {
			const finding = need("finding");
			if (!finding) return err("view_finding requires 'finding'");
			return store.viewFinding(need("run") ?? "", finding);
		}
		case "view_question": {
			const question = need("question");
			if (!question) return err("view_question requires 'question'");
			return store.viewQuestion(need("run") ?? "", question);
		}
		case "add_finding": {
			const title = need("title");
			const what = need("what");
			if (!title || !what) return err("add_finding requires 'title' and 'what'");
			const run = store.resolveRun(need("run") ?? "");
			if (!run) return err(`Unknown run '${need("run") ?? ""}'`);
			const confidence = need("confidence") ?? "unverified";
			const kind = need("kind") ?? "fact";
			if (!CONFIDENCES.includes(confidence as Confidence)) {
				return err(`invalid confidence '${confidence}'; one of: ${CONFIDENCES.join(", ")}`);
			}
			if (!FINDING_KINDS.includes(kind as FindingKind)) {
				return err(`invalid kind '${kind}'; one of: ${FINDING_KINDS.join(", ")}`);
			}
			return store.addFinding(run.slug, {
				title,
				researcher: need("researcher") ?? "synthesis",
				confidence: confidence as Confidence,
				kind: kind as FindingKind,
				topic: need("topic") ?? "",
				what,
				evidence: need("evidence") ?? "",
				sources: list("sources") ?? [],
				question: need("question"),
			});
		}
		case "update_finding": {
			const finding = need("finding");
			if (!finding) return err("update_finding requires 'finding'");
			const status = need("status");
			if (status !== undefined && !FINDING_STATUSES.includes(status as FindingStatus)) {
				return err(`invalid status '${status}'; one of: ${FINDING_STATUSES.join(", ")}`);
			}
			const confidence = need("confidence");
			if (confidence !== undefined && !CONFIDENCES.includes(confidence as Confidence)) {
				return err(`invalid confidence '${confidence}'; one of: ${CONFIDENCES.join(", ")}`);
			}
			return store.updateFinding(need("run") ?? "", finding, {
				status: status as FindingStatus | undefined,
				duplicate_of: need("duplicate_of"),
				confidence: confidence as Confidence | undefined,
			});
		}
		case "add_question": {
			const title = need("title");
			if (!title) return err("add_question requires 'title'");
			const run = store.resolveRun(need("run") ?? "");
			if (!run) return err(`Unknown run '${need("run") ?? ""}'`);
			return store.addQuestion(run.slug, {
				title,
				question: need("text") ?? title,
				askedBy: need("researcher") ?? "synthesis",
				blockedBy: list("blocked_by"),
			});
		}
		case "update_question": {
			const question = need("question");
			if (!question) return err("update_question requires 'question'");
			const status = need("status");
			if (status !== undefined && !QUESTION_STATUSES.includes(status as QuestionStatus)) {
				return err(`invalid status '${status}'; one of: ${QUESTION_STATUSES.join(", ")}`);
			}
			return store.updateQuestion(need("run") ?? "", question, {
				blocked_by: list("blocked_by"),
				question: need("text"),
				status: status as QuestionStatus | undefined,
				reason: need("reason"),
			});
		}
		case "answer": {
			const question = need("question");
			const answer = need("answer");
			if (!question || !answer) return err("answer requires 'question' and 'answer'");
			const run = store.resolveRun(need("run") ?? "");
			if (!run) return err(`Unknown run '${need("run") ?? ""}'`);
			return store.answerQuestion(run.slug, question, need("researcher") ?? "synthesis", answer, need("gist"));
		}
		case "update_run": {
			const run = store.resolveRun(need("run") ?? "");
			if (!run) return err(`Unknown run '${need("run") ?? ""}'`);
			return store.updateRun(run.slug, {
				notes: need("notes"),
				addFog: list("add_fog"),
				removeFog: list("remove_fog"),
			});
		}
		case "write_report": {
			const content = need("content");
			if (!content) return err("write_report requires 'content'");
			return store.writeReport(need("run") ?? "", content);
		}
		default:
			return err(
				`unknown action '${action}'; one of: list, view, view_finding, view_question, add_finding, ` +
					"update_finding, add_question, update_question, answer, update_run, write_report, wait",
			);
	}
}
