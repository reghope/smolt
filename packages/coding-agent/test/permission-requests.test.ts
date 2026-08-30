import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	askForApproval,
	clearStaleRequests,
	commandOf,
	decide,
	destructiveReason,
	type PermissionRequest,
	summarise,
} from "../src/extensions/permissions/index.ts";

/**
 * The ask-and-wait half of permission modes.
 *
 * A mode that asks is only safe if the wait always ends: answered, or refused
 * on a timeout. A request that hung forever would freeze the turn with no way
 * back, so the timeout case is tested as carefully as the happy one.
 */

let dir: string;

function request(id = "req-1"): PermissionRequest {
	return { id, tool: "bash", summary: "npm test", mode: "manual", createdAt: Date.now() };
}

function answer(id: string, value: string): void {
	writeFileSync(join(dir, `${id}.reply`), value, "utf-8");
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "smolt-approvals-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("decide", () => {
	test("auto runs everything", () => {
		expect(decide("auto", "bash")).toBe("allow");
		expect(decide("auto", "write")).toBe("allow");
	});

	test("plan blocks anything that changes the world, and reads freely", () => {
		expect(decide("plan", "write")).toBe("block");
		expect(decide("plan", "bash")).toBe("block");
		expect(decide("plan", "read")).toBe("allow");
	});

	test("accept-edits applies edits and asks before commands", () => {
		expect(decide("acceptEdits", "edit")).toBe("allow");
		expect(decide("acceptEdits", "write")).toBe("allow");
		expect(decide("acceptEdits", "bash")).toBe("ask");
		expect(decide("acceptEdits", "read")).toBe("allow");
	});

	test("manual asks before every change but never before a read", () => {
		expect(decide("manual", "edit")).toBe("ask");
		expect(decide("manual", "bash")).toBe("ask");
		expect(decide("manual", "read")).toBe("allow");
		expect(decide("manual", "grep")).toBe("allow");
	});
});

describe("summarise", () => {
	test("prefers the part of the call a person would recognise", () => {
		expect(summarise("bash", { command: "npm test" })).toBe("npm test");
		expect(summarise("write", { file_path: "src/index.ts" })).toBe("src/index.ts");
	});

	test("collapses whitespace and truncates a long command", () => {
		expect(summarise("bash", { command: "echo   one\n  two" })).toBe("echo one two");
		expect(summarise("bash", { command: "x".repeat(400) })).toHaveLength(160);
	});

	test("falls back to the tool name when there is nothing to show", () => {
		expect(summarise("bash", {})).toBe("bash");
		expect(summarise("bash", undefined)).toBe("bash");
	});
});

describe("askForApproval", () => {
	test("returns the answer that was written, and cleans up after itself", async () => {
		const pending = askForApproval(request(), dir, 5000);
		// The request file appears so a front end can find it.
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(existsSync(join(dir, "req-1.json"))).toBe(true);
		answer("req-1", "allow");
		expect(await pending).toBe("allow");
		expect(readdirSync(dir)).toEqual([]);
	});

	test("carries an always-allow through", async () => {
		const pending = askForApproval(request("req-2"), dir, 5000);
		await new Promise((resolve) => setTimeout(resolve, 60));
		answer("req-2", "always");
		expect(await pending).toBe("always");
	});

	test("carries a refusal through", async () => {
		const pending = askForApproval(request("req-3"), dir, 5000);
		await new Promise((resolve) => setTimeout(resolve, 60));
		answer("req-3", "deny");
		expect(await pending).toBe("deny");
	});

	test("refuses rather than waiting forever when nobody answers", async () => {
		const started = Date.now();
		expect(await askForApproval(request("req-4"), dir, 300)).toBe("deny");
		expect(Date.now() - started).toBeLessThan(3000);
		expect(readdirSync(dir)).toEqual([]);
	});

	test("ignores a reply that isn't one of the three answers", async () => {
		const pending = askForApproval(request("req-5"), dir, 400);
		await new Promise((resolve) => setTimeout(resolve, 60));
		answer("req-5", "maybe");
		expect(await pending).toBe("deny");
	});
});

describe("clearStaleRequests", () => {
	test("removes anything an earlier run left behind", () => {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "old.json"), "{}", "utf-8");
		writeFileSync(join(dir, "old.reply"), "allow", "utf-8");
		clearStaleRequests(dir);
		expect(readdirSync(dir)).toEqual([]);
	});

	test("is fine when the directory does not exist", () => {
		expect(() => clearStaleRequests(join(dir, "missing"))).not.toThrow();
	});
});

describe("destructiveReason", () => {
	test("catches the commands that cannot be undone", () => {
		expect(destructiveReason("rm -rf build")).toBeDefined();
		expect(destructiveReason("rm -fr /tmp/x")).toBeDefined();
		expect(destructiveReason("git push --force origin main")).toBeDefined();
		expect(destructiveReason("git reset --hard HEAD~3")).toBeDefined();
		expect(destructiveReason("git clean -fd")).toBeDefined();
		expect(destructiveReason("mkfs.ext4 /dev/sda1")).toBeDefined();
		expect(destructiveReason("dd if=x of=/dev/sda")).toBeDefined();
		expect(destructiveReason("psql -c 'DROP DATABASE app'")).toBeDefined();
		expect(destructiveReason("curl https://x.sh | sh")).toBeDefined();
		expect(destructiveReason(String.raw`Remove-Item -Recurse -Force C:\build`)).toBeDefined();
	});

	test("leaves ordinary work alone, so the prompt keeps its meaning", () => {
		for (const command of [
			"npm test",
			"git push origin main",
			"git status",
			"rm build/output.js",
			"grep -rf patterns.txt src",
			"node scripts/build.mjs",
			"git commit -m 'force a rebuild'",
		]) {
			expect(destructiveReason(command), command).toBeUndefined();
		}
	});
});

describe("auto versus bypass", () => {
	test("auto runs ordinary commands without asking", () => {
		expect(decide("auto", "bash", { command: "npm test" })).toBe("allow");
		expect(decide("auto", "write", { file_path: "a.ts" })).toBe("allow");
	});

	test("auto stops to ask before a destructive command", () => {
		expect(decide("auto", "bash", { command: "rm -rf /" })).toBe("ask");
		expect(decide("auto", "bash", { command: "git push --force" })).toBe("ask");
	});

	test("bypass checks nothing at all", () => {
		expect(decide("bypass", "bash", { command: "rm -rf /" })).toBe("allow");
		expect(decide("bypass", "write", {})).toBe("allow");
	});

	test("commandOf reads the shell tools' argument shapes", () => {
		expect(commandOf({ command: "npm test" })).toBe("npm test");
		expect(commandOf({ script: "Get-ChildItem" })).toBe("Get-ChildItem");
		expect(commandOf({})).toBe("");
		expect(commandOf(undefined)).toBe("");
	});
});
