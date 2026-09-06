import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { describeFailure, emptyDatabase, KEPT, wipeLocalData, wipeTargets } from "../src/main/wipe.ts";

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
		const database = wipeTargets().find((target) => target.database);
		expect(database?.path.endsWith("state.db")).toBe(true);
		expect(database?.sidecars?.some((path) => path.endsWith("state.db-wal"))).toBe(true);
		expect(database?.sidecars?.some((path) => path.endsWith("state.db-shm"))).toBe(true);
	});

	test("every target sits under the agent directory in use, so a test run cannot reach the real one", () => {
		const outside = wipeTargets().filter((target) => !target.path.startsWith(dirname(dir)));
		expect(outside).toEqual([]);
	});
});

describe("wiping", () => {
	test("removes what exists, reports it, and leaves the rest alone", async () => {
		mkdirSync(join(dir, "sessions"), { recursive: true });
		writeFileSync(join(dir, "sessions", "a.jsonl"), "{}");
		mkdirSync(join(dir, "skills", "one"), { recursive: true });
		writeFileSync(join(dir, "skills", "one", "SKILL.md"), "---\nname: one\n---\n");
		writeFileSync(join(dir, "state.db"), "not really a database");
		writeFileSync(join(dir, "auth.json"), '{"key":"secret"}');

		const report = await wipeLocalData();

		expect(report.failed).toEqual([]);
		expect(report.removed).toContain("Chats");
		expect(report.removed).toContain("Skills the agent wrote");
		expect(existsSync(join(dir, "sessions"))).toBe(false);
		expect(existsSync(join(dir, "skills"))).toBe(false);
		expect(existsSync(join(dir, "state.db"))).toBe(false);
		// The one file that must survive it.
		expect(existsSync(join(dir, "auth.json"))).toBe(true);
	});

	test("an empty machine wipes cleanly and reports nothing removed", async () => {
		const report = await wipeLocalData();
		expect(report.removed).toEqual([]);
		expect(report.failed).toEqual([]);
	});
});

describe("a database another smolt is holding open", () => {
	/**
	 * Windows will not unlink a file that another process has open, and one
	 * state.db is shared by every smolt on the machine. The rows have to go
	 * even when the file cannot, or "delete everything" leaves the history
	 * behind and only says it is sorry.
	 */
	test("is emptied in place, virtual tables and all, with its schema left standing", async () => {
		const path = join(dir, "state.db");
		const { DatabaseSync } = await import("node:sqlite");
		const seed = new DatabaseSync(path);
		seed.exec("CREATE TABLE files(path TEXT PRIMARY KEY, title TEXT)");
		seed.exec("CREATE VIRTUAL TABLE messages USING fts5(text, path UNINDEXED)");
		seed.exec("INSERT INTO files VALUES ('a.jsonl', 'a chat')");
		seed.exec("INSERT INTO messages VALUES ('something I said', 'a.jsonl')");
		seed.close();

		expect(await emptyDatabase(path)).toBeUndefined();

		const after = new DatabaseSync(path);
		expect(after.prepare("SELECT count(*) AS n FROM files").get()).toEqual({ n: 0 });
		expect(after.prepare("SELECT count(*) AS n FROM messages").get()).toEqual({ n: 0 });
		// The holders are mid-query: the tables they read from must still exist.
		expect(after.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'files'").get()).toEqual({ n: 1 });
		after.close();
	});

	test("says why when the file is not a database at all", async () => {
		const path = join(dir, "not-a.db");
		writeFileSync(path, "not really a database");
		expect(await emptyDatabase(path)).toBeTypeOf("string");
	});
});

describe("a folder something else is sitting in", () => {
	/**
	 * Windows refuses to remove a directory that is a running program's
	 * working directory, and the agent's scratch folder is exactly where a
	 * dev server or a build is likely to be standing. One such folder used to
	 * abort the branch and leave the rest of the reader's files on disk while
	 * the app said the wipe had failed.
	 */
	test.skipIf(process.platform !== "win32")("keeps its lock but loses everything inside it", async () => {
		const scratch = join(dir, "scratch");
		const inside = join(scratch, "a-site");
		mkdirSync(inside, { recursive: true });
		writeFileSync(join(scratch, "notes.txt"), "scratch notes");
		writeFileSync(join(inside, "index.html"), "<p>hi</p>");
		const back = process.cwd();
		process.chdir(inside);
		try {
			const report = await wipeLocalData();
			expect(report.failed).toEqual([]);
			expect(report.removed).toContain("Scratch files");
			expect(existsSync(join(scratch, "notes.txt"))).toBe(false);
			expect(existsSync(join(inside, "index.html"))).toBe(false);
			// And the lock was real: the folder itself could not go.
			expect(existsSync(inside)).toBe(true);
		} finally {
			process.chdir(back);
		}
	});

	test("what genuinely stays is named, with everything else already gone", () => {
		const held = { path: join(dir, "scratch", "held.log"), error: "another program is using it (EPERM)" };
		const message = describeFailure({ removed: ["Chats"], failed: [held, held] }) ?? "";
		expect(message).toContain("Everything else is deleted");
		expect(message).toContain("held.log");
		expect(message).toContain("1 other item");
		expect(describeFailure({ removed: [], failed: [] })).toBeUndefined();
	});
});
