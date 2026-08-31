import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ARCHETYPES, generatePersonas, type Persona } from "../src/extensions/battletest/personas.ts";
import { BattleTestStore, battleTestTool } from "../src/extensions/battletest/store.ts";

/**
 * The store is the run's record: personas, diaries, tickets, report — all
 * markdown on disk. These tests cover the round-trips and the dispatcher's
 * validation, plus the persona generator's coverage guarantee.
 */

let dir: string;
let store: BattleTestStore;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "battletest-store-"));
	store = new BattleTestStore(join(dir, "battletest"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** A deterministic rng so tests never flake on trait rolls. */
function seededRng(): () => number {
	let state = 42;
	return () => {
		state = (state * 1103515245 + 12345) % 2147483648;
		return state / 2147483648;
	};
}

function fixturePersonas(count: number): Persona[] {
	return generatePersonas(count, seededRng());
}

describe("personas", () => {
	test("a run smaller than the deck gets all-distinct archetypes", () => {
		const personas = generatePersonas(ARCHETYPES.length, seededRng());
		expect(new Set(personas.map((persona) => persona.archetype)).size).toBe(ARCHETYPES.length);
	});

	test("a run larger than the deck repeats archetypes but not names", () => {
		const personas = generatePersonas(ARCHETYPES.length + 2, seededRng());
		expect(personas.length).toBe(ARCHETYPES.length + 2);
		expect(new Set(personas.map((persona) => persona.name)).size).toBe(personas.length);
		expect(new Set(personas.map((persona) => persona.slug)).size).toBe(personas.length);
	});

	test("viewports cycle so mobile and tablet are always covered", () => {
		const four = generatePersonas(4, seededRng());
		expect(four.map((persona) => persona.viewport)).toEqual(["desktop", "mobile", "desktop", "tablet"]);
		const two = generatePersonas(2, seededRng());
		expect(two.some((persona) => persona.viewport === "mobile")).toBe(true);
	});

	test("traits come from the declared pools", () => {
		for (const persona of generatePersonas(6, seededRng())) {
			expect(["low", "medium", "high"]).toContain(persona.traits.patience);
			expect(["novice", "comfortable", "expert"]).toContain(persona.traits.expertise);
			expect(["forgiving", "blunt", "exacting"]).toContain(persona.traits.temperament);
			expect(["skims", "balanced", "exhaustive"]).toContain(persona.traits.thoroughness);
		}
	});
});

describe("runs", () => {
	test("createRun round-trips personas and focus through disk", () => {
		const personas = fixturePersonas(3);
		const run = store.createRun({ focus: "the settings screens", personas });
		const read = store.readRun(run.slug)!;
		expect(read.status).toBe("testing");
		expect(read.focus).toBe("the settings screens");
		expect(read.personas.map((persona) => persona.slug)).toEqual(personas.map((persona) => persona.slug));
		expect(read.personas[0]!.traits.patience).toBe(personas[0]!.traits.patience);
		expect(read.personas.map((persona) => persona.viewport)).toEqual(personas.map((persona) => persona.viewport));
	});

	test("profile scratch lives outside the run directory entirely", () => {
		const run = store.createRun({ personas: fixturePersonas(1) });
		const profile = store.profileDir(run.slug, "tess-auditor");
		expect(profile.startsWith(store.root)).toBe(false);
		expect(profile).toContain("smolt-battletest");
		expect(profile).toContain(run.slug);
	});

	test("resolveRun with an empty ref finds the newest run", () => {
		store.createRun({ personas: fixturePersonas(1), now: new Date("2026-01-01T10:00:00Z") });
		const later = store.createRun({ personas: fixturePersonas(1), now: new Date("2026-06-01T10:00:00Z") });
		expect(store.resolveRun("")?.slug).toBe(later.slug);
	});

	test("two runs in the same minute get distinct slugs", () => {
		const now = new Date("2026-03-01T09:30:00Z");
		const first = store.createRun({ personas: fixturePersonas(1), now });
		const second = store.createRun({ personas: fixturePersonas(1), now });
		expect(second.slug).not.toBe(first.slug);
		expect(store.readRun(second.slug)).toBeDefined();
	});
});

describe("notes", () => {
	test("appendNote creates the diary with a header, then appends", () => {
		const personas = fixturePersonas(1);
		const run = store.createRun({ personas });
		const persona = personas[0]!;
		store.appendNote(run.slug, persona, "launch", "It started, eventually.");
		store.appendNote(run.slug, persona, "settings", "Where is the save button?");
		const diary = readFileSync(store.notesPath(run.slug, persona.slug), "utf-8");
		expect(diary).toContain(`# Notes — ${persona.name} the ${persona.archetype}`);
		expect(diary).toContain("It started, eventually.");
		expect(diary.indexOf("It started")).toBeLessThan(diary.indexOf("Where is the save button?"));
	});
});

describe("tickets", () => {
	function fileTicket(runSlug: string, title: string, severity: "blocker" | "minor" = "minor") {
		return store.addTicket(runSlug, {
			title,
			persona: "tess-auditor",
			severity,
			category: "ui",
			area: "settings",
			what: "The toggle label is misaligned.",
			expected: "Label aligned with its toggle.",
			steps: "Open settings, look at the second toggle.",
		});
	}

	test("addTicket round-trips and duplicate titles get numbered slugs", () => {
		const run = store.createRun({ personas: fixturePersonas(1) });
		const first = fileTicket(run.slug, "Misaligned toggle");
		const second = fileTicket(run.slug, "Misaligned toggle");
		expect(first.ticket).toBe("misaligned-toggle");
		expect(second.ticket).toBe("misaligned-toggle-2");
		const view = store.viewTicket(run.slug, "misaligned-toggle");
		expect(view.success).toBe(true);
		expect(view.what).toBe("The toggle label is misaligned.");
		expect(view.persona).toBe("tess-auditor");
	});

	test("listTickets orders by severity", () => {
		const run = store.createRun({ personas: fixturePersonas(1) });
		fileTicket(run.slug, "Small thing", "minor");
		fileTicket(run.slug, "App will not start", "blocker");
		const tickets = store.listTickets(run.slug);
		expect(tickets[0]!.severity).toBe("blocker");
	});

	test("marking a duplicate requires and validates duplicate_of", () => {
		const run = store.createRun({ personas: fixturePersonas(1) });
		fileTicket(run.slug, "Canonical");
		fileTicket(run.slug, "Repeat");
		expect(store.updateTicket(run.slug, "repeat", { status: "duplicate" }).success).toBe(false);
		expect(store.updateTicket(run.slug, "repeat", { status: "duplicate", duplicate_of: "nope" }).success).toBe(false);
		expect(store.updateTicket(run.slug, "repeat", { status: "duplicate", duplicate_of: "repeat" }).success).toBe(
			false,
		);
		const marked = store.updateTicket(run.slug, "repeat", { status: "duplicate", duplicate_of: "canonical" });
		expect(marked.success).toBe(true);
		const ticket = store.viewTicket(run.slug, "repeat");
		expect(ticket.status).toBe("duplicate");
		expect(ticket.duplicateOf).toBe("canonical");
	});

	test("viewRun splits open from closed tickets and lists notes paths", () => {
		const personas = fixturePersonas(2);
		const run = store.createRun({ personas });
		fileTicket(run.slug, "Open one");
		fileTicket(run.slug, "Fixed one");
		store.updateTicket(run.slug, "fixed-one", { status: "fixed" });
		store.appendNote(run.slug, personas[0]!, "launch", "note");
		const view = store.viewRun(run.slug);
		expect((view.open_tickets as unknown[]).length).toBe(1);
		expect((view.closed_tickets as unknown[]).length).toBe(1);
		expect((view.notes as { exists: boolean }[]).filter((entry) => entry.exists).length).toBe(1);
	});
});

describe("report", () => {
	test("write_report writes the file and completes the run", () => {
		const run = store.createRun({ personas: fixturePersonas(1) });
		const result = store.writeReport(run.slug, "## Overview\n\nFine app, rough edges.");
		expect(result.success).toBe(true);
		expect(existsSync(store.reportPath(run.slug))).toBe(true);
		expect(store.readRun(run.slug)!.status).toBe("complete");
	});
});

describe("dispatcher", () => {
	test("validates severities, categories, and statuses", () => {
		const run = store.createRun({ personas: fixturePersonas(1) });
		expect(
			battleTestTool(store, {
				action: "add_ticket",
				run: run.slug,
				title: "T",
				what: "W",
				severity: "catastrophic",
			}).success,
		).toBe(false);
		expect(
			battleTestTool(store, { action: "add_ticket", run: run.slug, title: "T", what: "W", category: "vibes" })
				.success,
		).toBe(false);
		battleTestTool(store, { action: "add_ticket", run: run.slug, title: "T", what: "W" });
		expect(battleTestTool(store, { action: "update_ticket", ticket: "t", status: "sideways" }).success).toBe(false);
		expect(battleTestTool(store, { action: "update_ticket", ticket: "t", status: "fixed" }).success).toBe(true);
	});

	test("list summarizes runs with ticket counts", () => {
		const run = store.createRun({ personas: fixturePersonas(2) });
		battleTestTool(store, { action: "add_ticket", run: run.slug, title: "T", what: "W" });
		const listed = battleTestTool(store, { action: "list" }) as { runs: Record<string, unknown>[] };
		expect(listed.runs.length).toBe(1);
		expect(listed.runs[0]!.testers).toBe(2);
		expect(listed.runs[0]!.open_tickets).toBe(1);
	});

	test("unknown action names the valid ones", () => {
		const result = battleTestTool(store, { action: "explode" });
		expect(result.success).toBe(false);
		expect(String(result.error)).toContain("write_report");
	});
});
