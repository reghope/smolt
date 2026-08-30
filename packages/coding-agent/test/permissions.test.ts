import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	blockReason,
	isToolAllowed,
	type PermissionMode,
	readPermissionMode,
	writePermissionMode,
} from "../src/extensions/permissions/index.ts";

/**
 * Permission modes are enforced on the `tool_call` event, so what matters is
 * that the predicate refuses every tool that can change something, and that
 * the mode survives a round trip through the file a GUI writes to.
 */

let dir: string;
let path: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "smolt-perm-"));
	path = join(dir, "nested", "permission-mode");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("isToolAllowed", () => {
	const mutating = ["write", "edit", "bash", "powershell", "multi_edit", "notebook_edit"];
	const reading = ["read", "grep", "find", "ls", "screenshot", "session_search"];

	test("auto allows everything", () => {
		for (const tool of [...mutating, ...reading]) {
			expect(isToolAllowed("auto", tool)).toBe(true);
		}
	});

	test("plan blocks every tool that can change something", () => {
		for (const tool of mutating) {
			expect(isToolAllowed("plan", tool), `${tool} should be blocked in plan mode`).toBe(false);
		}
	});

	test("plan still allows investigation", () => {
		for (const tool of reading) {
			expect(isToolAllowed("plan", tool), `${tool} should be allowed in plan mode`).toBe(true);
		}
	});
});

describe("mode persistence", () => {
	test("defaults to auto when nothing is stored", () => {
		expect(readPermissionMode(path)).toBe("auto");
	});

	test("round-trips through the file, creating the directory", () => {
		writePermissionMode("plan", path);
		expect(readPermissionMode(path)).toBe("plan");
		writePermissionMode("auto", path);
		expect(readPermissionMode(path)).toBe("auto");
	});

	test("treats anything unrecognised as auto, never as a stricter mode by accident", () => {
		writePermissionMode("nonsense" as PermissionMode, path);
		expect(readPermissionMode(path)).toBe("auto");
	});
});

describe("blockReason", () => {
	test("names the tool and says how to lift the block", () => {
		const reason = blockReason("plan", "write");
		expect(reason).toContain("write");
		expect(reason).toMatch(/plan mode/i);
	});

	test("accept-edits explains that edits are fine and commands are not", () => {
		const reason = blockReason("acceptEdits", "bash");
		expect(reason).toContain("bash");
		expect(reason).toMatch(/accept-edits/i);
		expect(reason).toMatch(/file edits apply/i);
	});
});

describe("acceptEdits", () => {
	test("lets file edits through but stops shells", () => {
		expect(isToolAllowed("acceptEdits", "edit")).toBe(true);
		expect(isToolAllowed("acceptEdits", "write")).toBe(true);
		expect(isToolAllowed("acceptEdits", "read")).toBe(true);
		expect(isToolAllowed("acceptEdits", "bash")).toBe(false);
		expect(isToolAllowed("acceptEdits", "powershell")).toBe(false);
	});

	test("round-trips through the mode file", () => {
		writePermissionMode("acceptEdits", path);
		expect(readPermissionMode(path)).toBe("acceptEdits");
	});
});
