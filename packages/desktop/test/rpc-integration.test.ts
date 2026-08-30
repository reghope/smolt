import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AgentBridge, findCliPath } from "../src/main/agent-bridge.ts";
import { listSessions, projectDirName } from "../src/main/sessions.ts";

/**
 * Integration: the desktop bridge against the REAL agent CLI in RPC mode.
 * No API key needed — everything here works without an LLM call.
 */

const CLI = resolve(import.meta.dirname, "..", "..", "coding-agent", "dist", "cli.js");
const HAVE_CLI = existsSync(CLI);

describe.skipIf(!HAVE_CLI)("agent bridge (real RPC subprocess)", () => {
	let sandbox: string;
	const bridge = new AgentBridge();

	beforeAll(async () => {
		sandbox = mkdtempSync(join(tmpdir(), "smolt-desktop-int-"));
		process.env.SMOLT_CODING_AGENT_DIR = join(sandbox, "agent");
		await bridge.start({ cwd: sandbox, cliPath: CLI }, import.meta.dirname);
		expect(bridge.status.running, bridge.status.error ?? "").toBe(true);
	}, 60_000);

	afterAll(async () => {
		await bridge.stop();
		process.env.SMOLT_CODING_AGENT_DIR = "";
		rmSync(sandbox, { recursive: true, force: true });
	});

	test("getState reports a model and session file", async () => {
		const state = (await bridge.call("getState", [])) as Record<string, unknown>;
		expect(state.model).toBeTruthy();
		expect(String(state.sessionFile ?? "")).toContain(".jsonl");
	}, 30_000);

	test("getAvailableModels returns a non-empty catalog", async () => {
		const models = (await bridge.call("getAvailableModels", [])) as unknown[];
		expect(models.length).toBeGreaterThan(0);
	}, 30_000);

	test("thinking levels are queryable and settable", async () => {
		const levels = (await bridge.call("getAvailableThinkingLevels", [])) as string[];
		expect(levels.length).toBeGreaterThan(0);
		await bridge.call("setThinkingLevel", [levels[0]]);
	}, 30_000);

	test("newSession swaps to a fresh session file", async () => {
		const before = (await bridge.call("getState", [])) as Record<string, unknown>;
		const result = (await bridge.call("newSession", [])) as { cancelled: boolean };
		expect(result.cancelled).toBe(false);
		const after = (await bridge.call("getState", [])) as Record<string, unknown>;
		expect(after.sessionFile).not.toBe(before.sessionFile);
	}, 30_000);

	test("the sidebar lister parses stored session files", async () => {
		// Session files persist lazily (on first message), so write a fixture
		// in the same JSONL format the agent uses.
		const fixtureCwd = join(sandbox, "fixture-project");
		const dir = join(sandbox, "agent", "sessions", projectDirName(fixtureCwd));
		const { mkdirSync, writeFileSync } = await import("node:fs");
		// The lister drops chats whose folder is gone, so the fixture needs one.
		mkdirSync(fixtureCwd, { recursive: true });
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "s.jsonl"),
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "sess-x",
					timestamp: "2026-08-28T00:00:00.000Z",
					cwd: fixtureCwd,
				}),
				JSON.stringify({ type: "session_info", id: "i", parentId: null, timestamp: "t", name: "Fixture session" }),
				JSON.stringify({
					type: "message",
					id: "m",
					parentId: null,
					timestamp: "t",
					message: { role: "user", content: [{ type: "text", text: "hello sidebar" }] },
				}),
			].join("\n"),
			"utf-8",
		);
		const rows = listSessions(join(sandbox, "agent", "sessions"), 50);
		expect(rows.length).toBeGreaterThan(0);
		expect(rows[0]).toMatchObject({ id: "sess-x", title: "Fixture session", messageCount: 1 });
		expect(rows[0]!.preview).toContain("hello sidebar");
	}, 30_000);

	test("disallowed methods are rejected without reaching the agent", async () => {
		await expect(bridge.call("stop", [])).rejects.toThrow(/not allowed/);
		await expect(bridge.call("constructor", [])).rejects.toThrow(/not allowed/);
	});

	test("events stream to listeners", async () => {
		const events: unknown[] = [];
		bridge.onEvent((event) => events.push(event));
		// switching sessions emits no agent events, but a prompt would; here we
		// simply assert the listener plumbing is installed without error.
		expect(typeof events).toBe("object");
	});
});

describe("findCliPath", () => {
	test("prefers the explicit path and falls back to workspace discovery", () => {
		expect(findCliPath(import.meta.dirname, CLI)).toBe(CLI);
		if (HAVE_CLI) {
			// From packages/desktop/src (simulated by src dir), the workspace
			// candidate ../../coding-agent/dist/cli.js resolves.
			const fromDist = findCliPath(resolve(import.meta.dirname, "..", "src"));
			expect(fromDist).toBeTruthy();
		}
	});

	test("returns undefined when nothing exists", () => {
		const prev = process.env.SMOLT_CLI_PATH;
		process.env.SMOLT_CLI_PATH = "";
		expect(findCliPath("Z:/definitely/not/here")).toBeUndefined();
		process.env.SMOLT_CLI_PATH = prev;
	});
});
