import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ENTRY_DELIMITER, MemoryStore, memoryTool } from "../src/extensions/learning/memory.ts";

let dir: string;
let store: MemoryStore;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "learning-memory-"));
	store = new MemoryStore(dir);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function fileContent(name: "MEMORY.md" | "USER.md"): string {
	return readFileSync(join(dir, name), "utf-8");
}

describe("MemoryStore.add", () => {
	test("appends an entry and persists it with the § delimiter", () => {
		expect(store.add("memory", "first fact")).toMatchObject({ success: true, done: true, entry_count: 1 });
		expect(store.add("memory", "second fact")).toMatchObject({ success: true, entry_count: 2 });
		expect(fileContent("MEMORY.md")).toBe(`first fact${ENTRY_DELIMITER}second fact`);
	});

	test("rejects empty content", () => {
		expect(store.add("memory", "   ")).toMatchObject({ success: false, error: "Content cannot be empty." });
	});

	test("is idempotent for exact duplicates", () => {
		store.add("memory", "same fact");
		const result = store.add("memory", "same fact");
		expect(result).toMatchObject({
			success: true,
			message: "Entry already exists (no duplicate added).",
			entry_count: 1,
		});
	});

	test("a write landing at 80%+ capacity carries the consolidate-early nudge", () => {
		const small = new MemoryStore(dir, 100, 100);
		const low = small.add("memory", "short");
		expect(String(low.note)).not.toContain("capacity");
		const high = small.add(
			"memory",
			"a much longer entry that pushes this store clearly past the eighty percent line",
		);
		expect(high.success).toBe(true);
		expect(String(high.note)).toContain("% capacity");
		expect(String(high.note)).toContain("consolidate");
	});

	test("rejects an add that would exceed the char limit, echoing current entries", () => {
		const small = new MemoryStore(dir, 50, 50);
		small.add("memory", "a".repeat(30));
		const result = small.add("memory", "b".repeat(30));
		expect(result.success).toBe(false);
		expect(String(result.error)).toContain("would exceed the limit");
		expect(result.current_entries).toEqual(["a".repeat(30)]);
		expect(result.usage).toBe("30/50");
	});

	test("targets USER.md when target is user", () => {
		store.add("user", "prefers concise answers");
		expect(fileContent("USER.md")).toBe("prefers concise answers");
		expect(existsSync(join(dir, "MEMORY.md"))).toBe(false);
	});

	test("picks up entries written by another store instance (cross-session reload)", () => {
		const other = new MemoryStore(dir);
		other.add("memory", "from another session");
		const result = store.add("memory", "from this session");
		expect(result).toMatchObject({ entry_count: 2 });
		expect(fileContent("MEMORY.md")).toBe(`from another session${ENTRY_DELIMITER}from this session`);
	});

	test("success response reports usage percentage and terminal note", () => {
		const result = store.add("memory", "x".repeat(220));
		expect(result.usage).toBe("10% — 220/2,200 chars");
		expect(result.note).toBe("Write saved. This update is complete — do not repeat it.");
	});
});

describe("MemoryStore.replace", () => {
	test("replaces the entry containing old_text", () => {
		store.add("memory", "the API port is 8080");
		const result = store.replace("memory", "port is 8080", "the API port is 9090");
		expect(result).toMatchObject({ success: true, message: "Entry replaced." });
		expect(fileContent("MEMORY.md")).toBe("the API port is 9090");
	});

	test("errors with entry inventory when nothing matches", () => {
		store.add("memory", "some entry");
		const result = store.replace("memory", "missing", "new");
		expect(result.success).toBe(false);
		expect(String(result.error)).toContain("No entry matched 'missing'");
		expect(result.current_entries).toEqual(["some entry"]);
	});

	test("rejects ambiguous matches across distinct entries with previews", () => {
		store.add("memory", "alpha config lives in /etc");
		store.add("memory", "alpha config backup in /var");
		const result = store.replace("memory", "alpha config", "merged");
		expect(result.success).toBe(false);
		expect(String(result.error)).toContain("Multiple entries matched");
		expect(result.matches).toHaveLength(2);
	});

	test("rejects a replacement that would blow the budget", () => {
		const small = new MemoryStore(dir, 40, 40);
		small.add("memory", "short");
		const result = small.replace("memory", "short", "x".repeat(100));
		expect(result.success).toBe(false);
		expect(String(result.error)).toContain("Replacement would put memory at");
	});

	test("rejects empty old_text and empty new content", () => {
		expect(store.replace("memory", "  ", "new")).toMatchObject({ error: "old_text cannot be empty." });
		expect(store.replace("memory", "old", "  ")).toMatchObject({
			error: "new_content cannot be empty. Use 'remove' to delete entries.",
		});
	});
});

describe("MemoryStore.remove", () => {
	test("removes the entry containing old_text", () => {
		store.add("memory", "keep me");
		store.add("memory", "delete me");
		const result = store.remove("memory", "delete");
		expect(result).toMatchObject({ success: true, message: "Entry removed.", entry_count: 1 });
		expect(fileContent("MEMORY.md")).toBe("keep me");
	});

	test("errors with inventory when nothing matches", () => {
		store.add("memory", "only entry");
		const result = store.remove("memory", "nope");
		expect(result.success).toBe(false);
		expect(result.current_entries).toEqual(["only entry"]);
	});
});

describe("MemoryStore.applyBatch", () => {
	test("applies multiple operations atomically against the final budget", () => {
		const small = new MemoryStore(dir, 60, 60);
		small.add("memory", "a".repeat(50));
		// An add alone would overflow, but remove + add in one batch fits.
		const result = small.applyBatch("memory", [
			{ action: "remove", old_text: "aaa" },
			{ action: "add", content: "b".repeat(40) },
		]);
		expect(result).toMatchObject({ success: true, message: "Applied 2 operation(s)." });
		expect(fileContent("MEMORY.md")).toBe("b".repeat(40));
	});

	test("is all-or-nothing: a failing op aborts the whole batch", () => {
		store.add("memory", "original");
		const result = store.applyBatch("memory", [
			{ action: "add", content: "new entry" },
			{ action: "remove", old_text: "does-not-exist" },
		]);
		expect(result.success).toBe(false);
		expect(String(result.error)).toContain("Operation 2 (remove): no entry matched");
		expect(String(result.error)).toContain("No operations were applied (batch is all-or-nothing).");
		expect(fileContent("MEMORY.md")).toBe("original");
	});

	test("skips duplicate adds instead of failing", () => {
		store.add("memory", "existing");
		const result = store.applyBatch("memory", [
			{ action: "add", content: "existing" },
			{ action: "add", content: "fresh" },
		]);
		expect(result).toMatchObject({ success: true, entry_count: 2 });
	});

	test("accepts new_text as an alias for content in batch ops", () => {
		store.add("memory", "old value here");
		const result = store.applyBatch("memory", [
			{ action: "replace", old_text: "old value", new_text: "new value here" },
		]);
		expect(result.success).toBe(true);
		expect(fileContent("MEMORY.md")).toBe("new value here");
	});

	test("rejects the batch when the final state exceeds the limit", () => {
		const small = new MemoryStore(dir, 30, 30);
		const result = small.applyBatch("memory", [
			{ action: "add", content: "0123456789" },
			{ action: "add", content: "abcdefghij" },
			{ action: "add", content: "qrstuvwxyz" },
		]);
		expect(result.success).toBe(false);
		expect(String(result.error)).toContain("over the limit");
	});

	test("rejects unknown actions", () => {
		const result = store.applyBatch("memory", [{ action: "upsert", content: "x" }]);
		expect(String(result.error)).toContain("unknown action. Use add, replace, or remove.");
	});

	test("rejects an empty operations list", () => {
		expect(store.applyBatch("memory", [])).toMatchObject({ success: false, error: "operations list is empty." });
	});
});

describe("consolidation failure cap", () => {
	test("returns a terminal error after 3 failed attempts in one turn", () => {
		store.add("memory", "entry");
		for (let i = 0; i < 3; i++) {
			const result = store.remove("memory", "no-match");
			expect(result.done).toBeUndefined();
		}
		const fourth = store.remove("memory", "no-match");
		expect(fourth).toMatchObject({ success: false, done: true });
		expect(String(fourth.error)).toContain("Stop retrying memory calls");
	});

	test("a successful write resets the failure counter", () => {
		store.add("memory", "entry");
		store.remove("memory", "no-match");
		store.remove("memory", "no-match");
		store.add("memory", "another entry"); // success resets
		for (let i = 0; i < 3; i++) {
			const result = store.remove("memory", "no-match");
			expect(result.done).toBeUndefined();
		}
	});

	test("resetConsolidationFailures resets the counter at turn start", () => {
		store.add("memory", "entry");
		for (let i = 0; i < 3; i++) store.remove("memory", "no-match");
		store.resetConsolidationFailures();
		const result = store.remove("memory", "no-match");
		expect(result.done).toBeUndefined();
	});
});

describe("external drift protection", () => {
	test("refuses replace/remove when the file would not round-trip, saving a .bak", () => {
		// External writer left a stray trailing delimiter — re-serializing the
		// parsed entries would not reproduce the file byte-for-byte.
		writeFileSync(join(dir, "MEMORY.md"), `tool entry${ENTRY_DELIMITER}second entry${ENTRY_DELIMITER}`, "utf-8");
		const result = store.remove("memory", "tool entry");
		expect(result.success).toBe(false);
		expect(String(result.error)).toContain("wouldn't round-trip");
		const baks = readdirSync(dir).filter((name) => name.includes(".bak."));
		expect(baks.length).toBe(1);
		// Nothing was destroyed.
		expect(readFileSync(join(dir, "MEMORY.md"), "utf-8")).toContain("second entry");
	});

	test("refuses mutation when a single on-disk entry exceeds the whole-store limit", () => {
		const small = new MemoryStore(dir, 40, 40);
		writeFileSync(join(dir, "MEMORY.md"), "x".repeat(100), "utf-8");
		const result = small.replace("memory", "xxx", "short");
		expect(result.success).toBe(false);
		expect(String(result.error)).toContain("wouldn't round-trip");
	});

	test("add skips the drift guard (append never clobbers)", () => {
		writeFileSync(join(dir, "MEMORY.md"), "externally written entry", "utf-8");
		const result = store.add("memory", "tool entry");
		expect(result.success).toBe(true);
		expect(fileContent("MEMORY.md")).toBe(`externally written entry${ENTRY_DELIMITER}tool entry`);
	});
});

describe("loading", () => {
	test("strips a UTF-8 BOM so the first entry matches cleanly", () => {
		writeFileSync(join(dir, "MEMORY.md"), "﻿first entry", "utf-8");
		store.loadFromDisk();
		const result = store.remove("memory", "first entry");
		expect(result).toMatchObject({ success: true, entry_count: 0 });
	});

	test("deduplicates entries on load", () => {
		writeFileSync(join(dir, "MEMORY.md"), `dup${ENTRY_DELIMITER}dup${ENTRY_DELIMITER}unique`, "utf-8");
		store.loadFromDisk();
		const result = store.add("memory", "new");
		expect(result.entry_count).toBe(3); // dup, unique, new
	});

	test("keeps entries containing a bare § intact", () => {
		store.add("memory", "section § reference in one entry");
		const other = new MemoryStore(dir);
		other.loadFromDisk();
		const result = other.remove("memory", "section § reference");
		expect(result).toMatchObject({ success: true, entry_count: 0 });
	});
});

describe("frozen system prompt snapshot", () => {
	test("renders headers with usage and stays frozen across mid-session writes", () => {
		store.add("memory", "note one");
		store.add("user", "the user");
		store.loadFromDisk();
		const before = store.formatForSystemPrompt("memory");
		expect(before).toContain("MEMORY (your personal notes)");
		expect(before).toContain("note one");
		expect(before).toContain("═".repeat(46));
		expect(store.formatForSystemPrompt("user")).toContain("USER PROFILE (who the user is)");

		store.add("memory", "note two");
		expect(store.formatForSystemPrompt("memory")).toBe(before); // frozen
		store.loadFromDisk();
		expect(store.formatForSystemPrompt("memory")).toContain("note two"); // refreshed
	});

	test("returns an empty string when there are no entries", () => {
		store.loadFromDisk();
		expect(store.formatForSystemPrompt("memory")).toBe("");
		expect(store.formatForSystemPrompt("user")).toBe("");
	});
});

describe("memoryTool dispatch", () => {
	test("routes single ops and returns structured results", () => {
		expect(memoryTool(store, { action: "add", content: "fact" })).toMatchObject({ success: true });
		expect(memoryTool(store, { action: "replace", old_text: "fact", content: "better fact" })).toMatchObject({
			success: true,
		});
		expect(memoryTool(store, { action: "remove", old_text: "better fact" })).toMatchObject({ success: true });
	});

	test("accepts new_text as an alias for content", () => {
		memoryTool(store, { action: "add", content: "original entry" });
		const result = memoryTool(store, { action: "replace", old_text: "original", new_text: "updated entry" });
		expect(result.success).toBe(true);
		expect(fileContent("MEMORY.md")).toBe("updated entry");
	});

	test("treats a null target as the default memory store", () => {
		expect(memoryTool(store, { action: "add", content: "x", target: null })).toMatchObject({ success: true });
	});

	test("rejects an invalid target", () => {
		expect(memoryTool(store, { action: "add", content: "x", target: "profile" })).toMatchObject({
			error: "Invalid target 'profile'. Use 'memory' or 'user'.",
		});
	});

	test("returns a recoverable inventory error when old_text is missing", () => {
		memoryTool(store, { action: "add", content: "the only entry" });
		const result = memoryTool(store, { action: "remove" });
		expect(result.success).toBe(false);
		expect(String(result.error)).toContain("'remove' needs old_text");
		expect(result.current_entries).toEqual(["the only entry"]);
	});

	test("requires content for add and replace", () => {
		expect(memoryTool(store, { action: "add" })).toMatchObject({ error: "Content is required for 'add' action." });
		expect(memoryTool(store, { action: "replace", old_text: "x" })).toMatchObject({
			error: "content is required for 'replace' action.",
		});
	});

	test("routes the batch shape", () => {
		const result = memoryTool(store, {
			operations: [
				{ action: "add", content: "one" },
				{ action: "add", content: "two" },
			],
		});
		expect(result).toMatchObject({ success: true, entry_count: 2 });
	});

	test("rejects unknown single-op actions", () => {
		expect(memoryTool(store, { action: "append", content: "x" })).toMatchObject({
			error: "Unknown action 'append'. Use: add, replace, remove",
		});
	});
});
