import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { KEPT, wipeLocalData, wipeTargets } from "../src/main/wipe.ts";

/**
 * A wipe is unrecoverable, so what it does and does not reach is pinned here
 * rather than left to a reading of the code.
 */

let dir: string;
let previous: string | undefined;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "wipe-"));
	previous = process.env.SMOLT_CODING_AGENT_DIR;
	process.env.SMOLT_CODING_AGENT_DIR = dir;
});

afterEach(() => {
	if (previous === undefined) delete process.env.SMOLT_CODING_AGENT_DIR;
	else process.env.SMOLT_CODING_AGENT_DIR = previous;
	rmSync(dir, { recursive: true, force: true });
});

describe("what a wipe reaches", () => {
	test("it takes the data the agent accumulates", () => {
		const labels = wipeTargets().map((target) => target.label);
		expect(labels).toContain("Chats");
		expect(labels).toContain("Memory (MEMORY.md, USER.md)");
		expect(labels).toContain("Skills the agent wrote");
		expect(labels).toContain("Cues");
		expect(labels).toContain("Session index and tool telemetry");
	});

	test("it never reaches credentials or settings", () => {
		const paths = wipeTargets().map((target) => target.path.toLowerCase());
		for (const spared of ["auth.json", "pool.json", "telegram.json", "settings.json", "trust.json"]) {
			expect(paths.some((path) => path.endsWith(spared))).toBe(false);
		}
		// And the reason each one is spared is written down for the reader.
		expect(KEPT.join(" ")).toContain("auth.json");
		expect(KEPT.join(" ")).toContain("settings.json");
	});

	test("the database's sidecars go with it", () => {
		const paths = wipeTargets().map((target) => target.path);
		expect(paths.some((path) => path.endsWith("state.db-wal"))).toBe(true);
		expect(paths.some((path) => path.endsWith("state.db-shm"))).toBe(true);
	});
});

describe("wiping", () => {
	test("removes what exists, reports it, and leaves the rest alone", () => {
		mkdirSync(join(dir, "sessions"), { recursive: true });
		writeFileSync(join(dir, "sessions", "a.jsonl"), "{}");
		mkdirSync(join(dir, "skills", "one"), { recursive: true });
		writeFileSync(join(dir, "skills", "one", "SKILL.md"), "---\nname: one\n---\n");
		writeFileSync(join(dir, "state.db"), "not really a database");
		writeFileSync(join(dir, "auth.json"), '{"key":"secret"}');

		const report = wipeLocalData();

		expect(report.failed).toEqual([]);
		expect(report.removed).toContain("Chats");
		expect(report.removed).toContain("Skills the agent wrote");
		expect(existsSync(join(dir, "sessions"))).toBe(false);
		expect(existsSync(join(dir, "skills"))).toBe(false);
		expect(existsSync(join(dir, "state.db"))).toBe(false);
		// The one file that must survive it.
		expect(existsSync(join(dir, "auth.json"))).toBe(true);
	});

	test("an empty machine wipes cleanly and reports nothing removed", () => {
		const report = wipeLocalData();
		expect(report.removed).toEqual([]);
		expect(report.failed).toEqual([]);
	});
});
