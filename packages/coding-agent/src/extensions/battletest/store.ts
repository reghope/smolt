import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import type { Persona } from "./personas.ts";

/**
 * Battletest: simulated users run the app and everything they experience is
 * recorded as markdown under the project's `.smolt/battletest/` directory, so
 * a run's evidence travels with the repo the same way code does.
 *
 * A run holds the team of personas, one notes file per tester (their raw
 * experience diary, written as they go), the tickets they filed, and the
 * synthesized report written after everyone finishes. Tickets follow the
 * wayfinder ticket shape — frontmatter plus `##` sections — so anyone who can
 * read one tracker can read the other.
 *
 * Every operation reads from disk and writes atomically, so several tester
 * sessions filing tickets at once do not tread on each other.
 */

export type TicketSeverity = "blocker" | "major" | "minor" | "polish";
export type TicketCategory = "bug" | "ui" | "ux" | "performance" | "copy" | "accessibility" | "other";
export type TicketStatus = "open" | "fixed" | "wont-fix" | "duplicate";
export type RunStatus = "testing" | "stopped" | "complete";

export const TICKET_SEVERITIES: readonly TicketSeverity[] = ["blocker", "major", "minor", "polish"];
export const TICKET_CATEGORIES: readonly TicketCategory[] = [
	"bug",
	"ui",
	"ux",
	"performance",
	"copy",
	"accessibility",
	"other",
];
export const TICKET_STATUSES: readonly TicketStatus[] = ["open", "fixed", "wont-fix", "duplicate"];

export type BattleTestResult = Record<string, unknown>;

/** One tester's end-of-run record: who they were, what they found, what it cost. */
export interface TesterPerformance {
	slug: string;
	name: string;
	archetype: string;
	viewport: string;
	traits: Record<string, string>;
	status: string;
	/** Non-duplicate tickets filed. */
	tickets: number;
	/** Severity-weighted score of those tickets. */
	points: number;
	actions: number;
	tokens: number;
	wallMs: number;
	/** The full brief this tester ran under. */
	brief: string;
}

export interface BattleTestTicket {
	slug: string;
	title: string;
	/** The tester who filed it, by persona slug. */
	persona: string;
	severity: TicketSeverity;
	category: TicketCategory;
	/** Where in the app: a screen, flow, or component name. */
	area: string;
	status: TicketStatus;
	/** When status is 'duplicate': the slug of the ticket this repeats. */
	duplicateOf?: string;
	created: string;
	what: string;
	expected: string;
	steps: string;
	/** Extra observations from other testers who hit the same problem. */
	alsoSeen?: string;
}

export interface BattleTestRun {
	slug: string;
	title: string;
	status: RunStatus;
	created: string;
	updated: string;
	/** What the user asked this run to concentrate on, when they did. */
	focus: string;
	personas: Persona[];
}

interface RunFrontmatter {
	title?: string;
	status?: string;
	created?: string;
	updated?: string;
	personas?: unknown;
}

interface TicketFrontmatter {
	title?: string;
	persona?: string;
	severity?: string;
	category?: string;
	area?: string;
	status?: string;
	duplicateOf?: string;
	created?: string;
}

function err(error: string): BattleTestResult {
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

function parsePersonas(value: unknown): Persona[] {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(entry): entry is Persona =>
			typeof entry === "object" && entry !== null && typeof (entry as Persona).slug === "string",
	);
}

const SEVERITY_ORDER: Record<TicketSeverity, number> = { blocker: 0, major: 1, minor: 2, polish: 3 };

export class BattleTestStore {
	readonly root: string;

	constructor(root: string) {
		this.root = root;
	}

	// ------------------------------------------------------------------
	// Disk layout:
	//   <root>/<run-slug>/run.md
	//   <root>/<run-slug>/notes/<persona-slug>.md
	//   <root>/<run-slug>/tickets/<slug>.md
	//   <root>/<run-slug>/report.md
	//   <root>/<run-slug>/profiles/<persona-slug>/   (scratch, tester-owned)
	// ------------------------------------------------------------------

	private runDir(runSlug: string): string {
		return join(this.root, runSlug);
	}

	private ticketsDir(runSlug: string): string {
		return join(this.runDir(runSlug), "tickets");
	}

	notesDir(runSlug: string): string {
		return join(this.runDir(runSlug), "notes");
	}

	notesPath(runSlug: string, personaSlug: string): string {
		return join(this.notesDir(runSlug), `${personaSlug}.md`);
	}

	reportPath(runSlug: string): string {
		return join(this.runDir(runSlug), "report.md");
	}

	/**
	 * A directory a tester may use for an isolated app profile or scratch files.
	 *
	 * Under the OS temp dir, NOT the run dir: tester browsers write tens of
	 * thousands of files and gigabytes of cache, and inside the project that
	 * junk was scanned by git surfaces, synced by OneDrive, and once ballooned
	 * the desktop app to 9GB. Scratch has no business living beside the
	 * artifacts.
	 */
	profileDir(runSlug: string, personaSlug: string): string {
		return join(tmpdir(), "smolt-battletest", runSlug, personaSlug);
	}

	// ------------------------------------------------------------------
	// Metrics: one JSONL of timed actions per tester, plus a summary, so a
	// run can answer "where did the time go" after the fact.
	// ------------------------------------------------------------------

	metricsDir(runSlug: string): string {
		return join(this.runDir(runSlug), "metrics");
	}

	metricsPath(runSlug: string, personaSlug: string): string {
		return join(this.metricsDir(runSlug), `${personaSlug}.jsonl`);
	}

	metricsSummaryPath(runSlug: string, personaSlug: string): string {
		return join(this.metricsDir(runSlug), `${personaSlug}.summary.json`);
	}

	writeMetricsSummary(runSlug: string, personaSlug: string, summary: unknown): void {
		mkdirSync(this.metricsDir(runSlug), { recursive: true });
		atomicWrite(this.metricsSummaryPath(runSlug, personaSlug), `${JSON.stringify(summary, null, "\t")}\n`);
	}

	readRun(runSlug: string): BattleTestRun | undefined {
		const path = join(this.runDir(runSlug), "run.md");
		if (!existsSync(path)) return undefined;
		const { yaml, body } = splitFrontmatter(readFileSync(path, "utf-8"));
		const fm = (yaml ? (parse(yaml) as RunFrontmatter) : {}) ?? {};
		const sections = parseSections(body);
		const status: RunStatus = fm.status === "complete" ? "complete" : fm.status === "stopped" ? "stopped" : "testing";
		return {
			slug: runSlug,
			title: fm.title ?? runSlug,
			status,
			created: fm.created ?? "",
			updated: fm.updated ?? "",
			focus: sections.Focus ?? "",
			personas: parsePersonas(fm.personas),
		};
	}

	private writeRun(run: BattleTestRun): void {
		mkdirSync(this.runDir(run.slug), { recursive: true });
		const frontmatter = stringify({
			title: run.title,
			status: run.status,
			created: run.created,
			updated: run.updated,
			personas: run.personas,
		});
		const body = `## Focus\n\n${run.focus}\n`;
		atomicWrite(join(this.runDir(run.slug), "run.md"), `---\n${frontmatter}---\n\n${body}`);
	}

	listRunSlugs(): string[] {
		if (!existsSync(this.root)) return [];
		return readdirSync(this.root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && existsSync(join(this.root, entry.name, "run.md")))
			.map((entry) => entry.name)
			.sort();
	}

	listRuns(): BattleTestRun[] {
		return this.listRunSlugs()
			.map((slug) => this.readRun(slug))
			.filter((run): run is BattleTestRun => run !== undefined);
	}

	/** The run a reference names: exact slug, else the newest run when ref is empty. */
	resolveRun(ref: string): BattleTestRun | undefined {
		const needle = ref.trim().toLowerCase();
		if (needle !== "") {
			return this.readRun(needle) ?? this.readRun(slugify(ref));
		}
		const slugs = this.listRunSlugs();
		const last = slugs[slugs.length - 1];
		return last ? this.readRun(last) : undefined;
	}

	createRun(params: { focus?: string; personas: Persona[]; now?: Date }): BattleTestRun {
		const now = params.now ?? new Date();
		const stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
		const focusPart = params.focus ? `-${slugify(params.focus).slice(0, 24)}` : "";
		let slug = `${stamp}${focusPart}`;
		for (let n = 2; this.readRun(slug); n++) slug = `${stamp}${focusPart}-${n}`;
		const run: BattleTestRun = {
			slug,
			title: params.focus
				? `Battletest: ${firstLine(params.focus)}`
				: `Battletest ${now.toISOString().slice(0, 10)}`,
			status: "testing",
			created: now.toISOString(),
			updated: now.toISOString(),
			focus: (params.focus ?? "").trim(),
			personas: params.personas,
		};
		this.writeRun(run);
		mkdirSync(this.notesDir(slug), { recursive: true });
		mkdirSync(this.ticketsDir(slug), { recursive: true });
		return run;
	}

	setRunStatus(runSlug: string, status: RunStatus): BattleTestResult {
		const run = this.readRun(runSlug);
		if (!run) return err(`Unknown run '${runSlug}'. Runs: ${this.listRunSlugs().join(", ") || "(none)"}`);
		run.status = status;
		run.updated = new Date().toISOString();
		this.writeRun(run);
		return { success: true, run: runSlug, status };
	}

	// ------------------------------------------------------------------
	// Notes: one append-only diary per tester.
	// ------------------------------------------------------------------

	appendNote(runSlug: string, persona: Persona, area: string, text: string): BattleTestResult {
		const run = this.readRun(runSlug);
		if (!run) return err(`Unknown run '${runSlug}'`);
		mkdirSync(this.notesDir(runSlug), { recursive: true });
		const path = this.notesPath(runSlug, persona.slug);
		if (!existsSync(path)) {
			atomicWrite(path, `# Notes — ${persona.name} the ${persona.archetype}\n`);
		}
		const stamp = new Date().toISOString().slice(11, 19);
		appendFileSync(path, `\n### ${stamp} — ${area.trim() || "general"}\n\n${text.trim()}\n`, "utf-8");
		return { success: true, run: runSlug, notes: path };
	}

	/** The area heading of a tester's most recent diary note — "where they are now". */
	latestNoteArea(runSlug: string, personaSlug: string): string | undefined {
		try {
			const raw = readFileSync(this.notesPath(runSlug, personaSlug), "utf-8");
			const headings = raw.match(/^### [\d:]+ — (.+)$/gm);
			const last = headings?.[headings.length - 1];
			return last ? /— (.+)$/.exec(last)?.[1] : undefined;
		} catch {
			return undefined;
		}
	}

	// ------------------------------------------------------------------
	// Tickets
	// ------------------------------------------------------------------

	private readTicket(runSlug: string, ticketSlug: string): BattleTestTicket | undefined {
		const path = join(this.ticketsDir(runSlug), `${ticketSlug}.md`);
		if (!existsSync(path)) return undefined;
		const { yaml, body } = splitFrontmatter(readFileSync(path, "utf-8"));
		const fm = (yaml ? (parse(yaml) as TicketFrontmatter) : {}) ?? {};
		const sections = parseSections(body);
		const severity = TICKET_SEVERITIES.includes(fm.severity as TicketSeverity)
			? (fm.severity as TicketSeverity)
			: "minor";
		const category = TICKET_CATEGORIES.includes(fm.category as TicketCategory)
			? (fm.category as TicketCategory)
			: "other";
		const status = TICKET_STATUSES.includes(fm.status as TicketStatus) ? (fm.status as TicketStatus) : "open";
		const ticket: BattleTestTicket = {
			slug: ticketSlug,
			title: fm.title ?? ticketSlug,
			persona: fm.persona ?? "",
			severity,
			category,
			area: fm.area ?? "",
			status,
			created: fm.created ?? "",
			what: sections["What happened"] ?? "",
			expected: sections.Expected ?? "",
			steps: sections["Steps to reproduce"] ?? "",
		};
		if (fm.duplicateOf) ticket.duplicateOf = fm.duplicateOf;
		if (sections["Also seen"]) ticket.alsoSeen = sections["Also seen"];
		return ticket;
	}

	private writeTicket(runSlug: string, ticket: BattleTestTicket): void {
		mkdirSync(this.ticketsDir(runSlug), { recursive: true });
		const fm: Record<string, unknown> = {
			title: ticket.title,
			persona: ticket.persona,
			severity: ticket.severity,
			category: ticket.category,
			area: ticket.area,
			status: ticket.status,
			created: ticket.created,
		};
		if (ticket.duplicateOf) fm.duplicateOf = ticket.duplicateOf;
		const body =
			`## What happened\n\n${ticket.what}\n\n## Expected\n\n${ticket.expected}\n\n` +
			`## Steps to reproduce\n\n${ticket.steps}\n` +
			(ticket.alsoSeen ? `\n## Also seen\n\n${ticket.alsoSeen}\n` : "");
		atomicWrite(join(this.ticketsDir(runSlug), `${ticket.slug}.md`), `---\n${stringify(fm)}---\n\n${body}`);
	}

	listTickets(runSlug: string): BattleTestTicket[] {
		const dir = this.ticketsDir(runSlug);
		if (!existsSync(dir)) return [];
		return readdirSync(dir)
			.filter((name) => name.endsWith(".md"))
			.sort()
			.map((name) => this.readTicket(runSlug, name.slice(0, -3)))
			.filter((ticket): ticket is BattleTestTicket => ticket !== undefined)
			.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.slug.localeCompare(b.slug));
	}

	/**
	 * How each tester did, written when the run finishes: score, spend, the
	 * exact brief they ran under, and who came out on top. The per-run file
	 * keeps everything including the brief; `form.jsonl` at the root
	 * accumulates one compact line per tester per run, so future team
	 * selection can weigh which archetypes, traits, and briefs have a record
	 * of finding real problems.
	 */
	writePerformance(runSlug: string, entries: TesterPerformance[]): BattleTestResult {
		const run = this.readRun(runSlug);
		if (!run) return err(`Unknown run '${runSlug}'`);
		const best = [...entries].sort((a, b) => b.points - a.points || a.tokens - b.tokens)[0];
		const payload = {
			run: runSlug,
			recorded: new Date().toISOString(),
			best: best && best.points > 0 ? best.slug : null,
			testers: entries,
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

	/**
	 * An existing ticket that reads like the same problem: same area and most
	 * of the same title words, or an identical title anywhere. Deliberately
	 * mechanical and conservative — a false match costs a tester one `force`
	 * refile, a missed match costs one duplicate, and the parent's triage
	 * still dedupes at synthesis. Duplicate-marked tickets don't count; the
	 * original they point at does.
	 */
	findSimilarTicket(runSlug: string, area: string, title: string): BattleTestTicket | undefined {
		const norm = (text: string): string =>
			text
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, " ")
				.trim();
		const tokens = (text: string): Set<string> =>
			new Set(
				norm(text)
					.split(" ")
					.filter((word) => word.length > 2),
			);
		const wantArea = norm(area);
		const wantTitle = norm(title);
		const wantTokens = tokens(title);
		for (const ticket of this.listTickets(runSlug)) {
			if (ticket.status === "duplicate") continue;
			if (norm(ticket.title) === wantTitle) return ticket;
			if (norm(ticket.area) !== wantArea || wantTokens.size === 0) continue;
			const theirs = tokens(ticket.title);
			let overlap = 0;
			for (const word of wantTokens) if (theirs.has(word)) overlap++;
			const needed = Math.max(2, Math.ceil(Math.min(wantTokens.size, theirs.size) * 0.6));
			if (overlap >= needed) return ticket;
		}
		return undefined;
	}

	/** Another tester's observations, appended to a ticket they did not file. */
	appendToTicket(runSlug: string, ticketRef: string, personaSlug: string, text: string): BattleTestResult {
		const run = this.readRun(runSlug);
		if (!run) return err(`Unknown run '${runSlug}'`);
		const ticket = this.readTicket(runSlug, ticketRef.trim()) ?? this.readTicket(runSlug, slugify(ticketRef));
		if (!ticket) {
			const slugs = this.listTickets(runSlug).map((t) => t.slug);
			return err(`Unknown ticket '${ticketRef}'. Tickets: ${slugs.join(", ") || "(none)"}`);
		}
		const entry = `**${personaSlug}:** ${text.trim()}`;
		ticket.alsoSeen = ticket.alsoSeen ? `${ticket.alsoSeen}\n\n${entry}` : entry;
		this.writeTicket(runSlug, ticket);
		return { success: true, run: runSlug, ticket: ticket.slug };
	}

	addTicket(
		runSlug: string,
		params: {
			title: string;
			persona: string;
			severity: TicketSeverity;
			category: TicketCategory;
			area: string;
			what: string;
			expected: string;
			steps: string;
		},
	): BattleTestResult {
		const run = this.readRun(runSlug);
		if (!run) return err(`Unknown run '${runSlug}'`);
		const existing = new Set(this.listTickets(runSlug).map((ticket) => ticket.slug));
		let slug = slugify(params.title);
		for (let n = 2; existing.has(slug); n++) slug = `${slugify(params.title)}-${n}`;
		this.writeTicket(runSlug, {
			slug,
			title: params.title,
			persona: params.persona,
			severity: params.severity,
			category: params.category,
			area: params.area.trim(),
			status: "open",
			created: new Date().toISOString(),
			what: params.what.trim(),
			expected: params.expected.trim(),
			steps: params.steps.trim(),
		});
		return { success: true, run: runSlug, ticket: slug };
	}

	viewTicket(runRef: string, ticketRef: string): BattleTestResult {
		const run = this.resolveRun(runRef);
		if (!run) return err(`Unknown run '${runRef}'`);
		const ticket = this.readTicket(run.slug, ticketRef.trim()) ?? this.readTicket(run.slug, slugify(ticketRef));
		if (!ticket) {
			const slugs = this.listTickets(run.slug).map((t) => t.slug);
			return err(`Unknown ticket '${ticketRef}' on run '${run.slug}'. Tickets: ${slugs.join(", ") || "(none)"}`);
		}
		return { success: true, run: run.slug, ...ticket };
	}

	updateTicket(
		runRef: string,
		ticketRef: string,
		params: { status?: TicketStatus; duplicate_of?: string; severity?: TicketSeverity },
	): BattleTestResult {
		const run = this.resolveRun(runRef);
		if (!run) return err(`Unknown run '${runRef}'`);
		const ticket = this.readTicket(run.slug, ticketRef.trim()) ?? this.readTicket(run.slug, slugify(ticketRef));
		if (!ticket) return err(`Unknown ticket '${ticketRef}' on run '${run.slug}'`);
		if (params.status === "duplicate") {
			const target = params.duplicate_of?.trim() ?? "";
			if (target === "") return err("marking a ticket 'duplicate' requires 'duplicate_of'");
			const canonical = this.readTicket(run.slug, target) ?? this.readTicket(run.slug, slugify(target));
			if (!canonical) return err(`duplicate_of: unknown ticket '${target}'`);
			if (canonical.slug === ticket.slug) return err("a ticket cannot be a duplicate of itself");
			ticket.duplicateOf = canonical.slug;
		}
		if (params.status !== undefined) ticket.status = params.status;
		if (params.severity !== undefined) ticket.severity = params.severity;
		this.writeTicket(run.slug, ticket);
		return { success: true, run: run.slug, ticket: ticket.slug, status: ticket.status };
	}

	// ------------------------------------------------------------------
	// Report and views
	// ------------------------------------------------------------------

	writeReport(runRef: string, content: string): BattleTestResult {
		const run = this.resolveRun(runRef);
		if (!run) return err(`Unknown run '${runRef}'`);
		atomicWrite(this.reportPath(run.slug), `${content.trim()}\n`);
		this.setRunStatus(run.slug, "complete");
		return { success: true, run: run.slug, report: this.reportPath(run.slug) };
	}

	/** The full picture of one run: personas, tickets by severity, note files. */
	viewRun(runRef: string): BattleTestResult {
		const run = this.resolveRun(runRef);
		if (!run) {
			return err(`Unknown run '${runRef}'. Runs: ${this.listRunSlugs().join(", ") || "(none)"}`);
		}
		const tickets = this.listTickets(run.slug);
		const active = tickets.filter((ticket) => ticket.status === "open");
		const notes = run.personas
			.map((persona) => ({
				persona: persona.slug,
				name: persona.name,
				archetype: persona.archetype,
				path: this.notesPath(run.slug, persona.slug),
				exists: existsSync(this.notesPath(run.slug, persona.slug)),
			}))
			.map((entry) => ({ ...entry, path: entry.exists ? entry.path : `${entry.path} (no notes yet)` }));
		const metrics = run.personas
			.map((persona) => this.metricsSummaryPath(run.slug, persona.slug))
			.filter((path) => existsSync(path));
		return {
			success: true,
			run: run.slug,
			title: run.title,
			status: run.status,
			focus: run.focus,
			personas: run.personas.map((persona) => ({
				slug: persona.slug,
				name: persona.name,
				archetype: persona.archetype,
				traits: persona.traits,
			})),
			open_tickets: active.map((ticket) => ({
				ticket: ticket.slug,
				title: ticket.title,
				severity: ticket.severity,
				category: ticket.category,
				area: ticket.area,
				persona: ticket.persona,
			})),
			closed_tickets: tickets
				.filter((ticket) => ticket.status !== "open")
				.map((ticket) => ({
					ticket: ticket.slug,
					title: ticket.title,
					status: ticket.status,
					...(ticket.duplicateOf ? { duplicate_of: ticket.duplicateOf } : {}),
				})),
			notes,
			metrics_summaries: metrics,
			report: existsSync(this.reportPath(run.slug)) ? this.reportPath(run.slug) : undefined,
		};
	}
}

// ------------------------------------------------------------------
// Tool dispatcher for the parent-session `battletest` tool. The run/wait
// lifecycle actions live in index.ts, where the tester roster is; everything
// that only touches disk is dispatched here.
// ------------------------------------------------------------------

export interface BattleTestToolParams {
	action?: string;
	run?: string | null;
	ticket?: string | null;
	title?: string | null;
	persona?: string | null;
	severity?: string | null;
	category?: string | null;
	area?: string | null;
	what?: string | null;
	expected?: string | null;
	steps?: string | null;
	status?: string | null;
	duplicate_of?: string | null;
	content?: string | null;
	seconds?: number | null;
}

export function battleTestTool(store: BattleTestStore, params: BattleTestToolParams): BattleTestResult {
	const action = params.action ?? "";
	const need = (name: keyof BattleTestToolParams): string | undefined => {
		const value = params[name];
		return typeof value === "string" && value.trim() !== "" ? value : undefined;
	};

	switch (action) {
		case "list": {
			const runs = store.listRuns().map((run) => {
				const tickets = store.listTickets(run.slug);
				return {
					run: run.slug,
					title: run.title,
					status: run.status,
					testers: run.personas.length,
					open_tickets: tickets.filter((ticket) => ticket.status === "open").length,
					tickets: tickets.length,
				};
			});
			return { success: true, runs };
		}
		case "view":
			return store.viewRun(need("run") ?? "");
		case "view_ticket": {
			const ticket = need("ticket");
			if (!ticket) return err("view_ticket requires 'ticket'");
			return store.viewTicket(need("run") ?? "", ticket);
		}
		case "add_ticket": {
			const title = need("title");
			const what = need("what");
			if (!title || !what) return err("add_ticket requires 'title' and 'what'");
			const run = store.resolveRun(need("run") ?? "");
			if (!run) return err(`Unknown run '${need("run") ?? ""}'`);
			const severity = need("severity") ?? "minor";
			const category = need("category") ?? "other";
			if (!TICKET_SEVERITIES.includes(severity as TicketSeverity)) {
				return err(`invalid severity '${severity}'; one of: ${TICKET_SEVERITIES.join(", ")}`);
			}
			if (!TICKET_CATEGORIES.includes(category as TicketCategory)) {
				return err(`invalid category '${category}'; one of: ${TICKET_CATEGORIES.join(", ")}`);
			}
			return store.addTicket(run.slug, {
				title,
				persona: need("persona") ?? "synthesis",
				severity: severity as TicketSeverity,
				category: category as TicketCategory,
				area: need("area") ?? "",
				what,
				expected: need("expected") ?? "",
				steps: need("steps") ?? "",
			});
		}
		case "update_ticket": {
			const ticket = need("ticket");
			if (!ticket) return err("update_ticket requires 'ticket'");
			const status = need("status");
			if (status !== undefined && !TICKET_STATUSES.includes(status as TicketStatus)) {
				return err(`invalid status '${status}'; one of: ${TICKET_STATUSES.join(", ")}`);
			}
			const severity = need("severity");
			if (severity !== undefined && !TICKET_SEVERITIES.includes(severity as TicketSeverity)) {
				return err(`invalid severity '${severity}'; one of: ${TICKET_SEVERITIES.join(", ")}`);
			}
			return store.updateTicket(need("run") ?? "", ticket, {
				status: status as TicketStatus | undefined,
				duplicate_of: need("duplicate_of"),
				severity: severity as TicketSeverity | undefined,
			});
		}
		case "write_report": {
			const content = need("content");
			if (!content) return err("write_report requires 'content'");
			return store.writeReport(need("run") ?? "", content);
		}
		default:
			return err(
				`unknown action '${action}'; one of: list, view, view_ticket, add_ticket, update_ticket, write_report, wait`,
			);
	}
}
