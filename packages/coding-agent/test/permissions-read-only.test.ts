import { describe, expect, test } from "vitest";
import { decide, isReadOnlyCommand } from "../src/extensions/permissions/index.ts";

/**
 * The read-only classifier exists so accept-edits mode stops asking about
 * commands nobody would ever refuse. It must err closed: a false "read-only"
 * runs an unapproved write, a false "ask" merely nags.
 */

describe("isReadOnlyCommand", () => {
	test("plain readers pass, chained or piped", () => {
		expect(isReadOnlyCommand("ls -la")).toBe(true);
		expect(isReadOnlyCommand("git status")).toBe(true);
		expect(isReadOnlyCommand("cd packages/desktop && git diff")).toBe(true);
		expect(isReadOnlyCommand("cat src/main.ts | grep import")).toBe(true);
		expect(isReadOnlyCommand("Get-ChildItem src | Select-String theme")).toBe(true);
		expect(isReadOnlyCommand("node --version")).toBe(true);
		expect(isReadOnlyCommand("git log; git rev-parse HEAD")).toBe(true);
	});

	test("stream-silencing redirects are not writes", () => {
		expect(
			isReadOnlyCommand('ls "packages/desktop" && cat "packages/desktop/package.json" 2>/dev/null | head -60'),
		).toBe(true);
		expect(isReadOnlyCommand("ls .smolt/agent/extensions 2>/dev/null; rg -l battletest | head -20")).toBe(true);
		expect(isReadOnlyCommand("git status 2>&1 | head -5")).toBe(true);
		expect(isReadOnlyCommand("dir 2>nul")).toBe(true);
		// A null-lookalike that is actually a file is still a write.
		expect(isReadOnlyCommand("cat x > nullify.txt")).toBe(false);
		expect(isReadOnlyCommand("ls 2>errors.log")).toBe(false);
	});

	test("writers and runners fail", () => {
		expect(isReadOnlyCommand("npm install")).toBe(false);
		expect(isReadOnlyCommand("node build.mjs")).toBe(false);
		expect(isReadOnlyCommand("git commit -m x")).toBe(false);
		expect(isReadOnlyCommand("git branch -d main")).toBe(false);
		expect(isReadOnlyCommand("rm file.txt")).toBe(false);
		expect(isReadOnlyCommand("Set-Content out.txt hi")).toBe(false);
	});

	test("a read that smuggles a write fails", () => {
		expect(isReadOnlyCommand("ls > files.txt")).toBe(false);
		expect(isReadOnlyCommand("cat a.txt >> b.txt")).toBe(false);
		expect(isReadOnlyCommand("echo $(rm -rf .)")).toBe(false);
		expect(isReadOnlyCommand("echo `touch x`")).toBe(false);
		expect(isReadOnlyCommand("git diff | tee out.patch")).toBe(false);
		expect(isReadOnlyCommand("ls | Out-File list.txt")).toBe(false);
		expect(isReadOnlyCommand("ls && npm install")).toBe(false);
		expect(isReadOnlyCommand("find . -name '*.tmp' | xargs rm")).toBe(false);
	});

	test("empty and whitespace commands fail", () => {
		expect(isReadOnlyCommand("")).toBe(false);
		expect(isReadOnlyCommand("   ")).toBe(false);
	});
});

describe("decide in acceptEdits", () => {
	test("read-only shell runs unasked; mutating shell still asks", () => {
		expect(decide("acceptEdits", "bash", { command: "cd repo && git status" })).toBe("allow");
		expect(decide("acceptEdits", "bash", { command: "npm run build" })).toBe("ask");
		expect(decide("acceptEdits", "powershell", { command: "Get-ChildItem src" })).toBe("allow");
	});

	test("destructive always asks, even when it parses as a read chain", () => {
		expect(decide("acceptEdits", "bash", { command: "git reset --hard HEAD~1" })).toBe("ask");
		expect(decide("acceptEdits", "bash", { command: "rm -rf node_modules" })).toBe("ask");
	});

	test("manual mode still asks about everything mutating", () => {
		expect(decide("manual", "bash", { command: "git status" })).toBe("ask");
		expect(decide("manual", "edit", {})).toBe("ask");
	});
});
