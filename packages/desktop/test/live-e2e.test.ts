import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AgentBridge } from "../src/main/agent-bridge.ts";
import { initialState, reduce, type UiState } from "../src/renderer/store.ts";

/**
 * Live e2e: a real prompt through the real agent, with the streamed events
 * fed through the SAME reducer the desktop renderer uses — proving the full
 * GUI pipeline (bridge -> events -> view state) against a real model.
 * Gated on OPENCODE_API_KEY, same convention as the other live suites.
 */

const API_KEY = process.env.OPENCODE_API_KEY;
const CLI = resolve(import.meta.dirname, "..", "..", "coding-agent", "dist", "cli.js");
const PROVIDER = process.env.SMOLT_E2E_PROVIDER || "opencode-go";
const MODEL = process.env.SMOLT_E2E_MODEL || "glm-5.3-flash";

describe.skipIf(!API_KEY || !existsSync(CLI))("desktop live e2e", () => {
	let sandbox: string;
	const bridge = new AgentBridge();
	const state: UiState = initialState();

	beforeAll(async () => {
		sandbox = mkdtempSync(join(tmpdir(), "smolt-desktop-live-"));
		process.env.SMOLT_CODING_AGENT_DIR = join(sandbox, "agent");
		bridge.onEvent((event) => reduce(state, event));
		await bridge.start({ cwd: sandbox, cliPath: CLI, provider: PROVIDER, model: MODEL }, import.meta.dirname);
		expect(bridge.status.running, bridge.status.error ?? "").toBe(true);
	}, 60_000);

	afterAll(async () => {
		await bridge.stop();
		process.env.SMOLT_CODING_AGENT_DIR = "";
		rmSync(sandbox, { recursive: true, force: true });
	});

	test("a prompt streams into renderer state and settles", async () => {
		await bridge.call("prompt", ["Reply with exactly: DESKTOP-OK. No tools, nothing else."]);

		const deadline = Date.now() + 120_000;
		while (Date.now() < deadline) {
			if (!state.streaming && state.messages.some((m) => m.role === "assistant")) break;
			await new Promise((resolveWait) => setTimeout(resolveWait, 250));
		}

		const assistant = state.messages.filter((m) => m.role === "assistant").at(-1);
		expect(assistant, "no assistant message assembled").toBeTruthy();
		const text = assistant!.blocks
			.filter((b): b is { kind: "text"; text: string } => b.kind === "text")
			.map((b) => b.text)
			.join("\n");
		expect(text).toContain("DESKTOP-OK");
		expect(state.streaming).toBe(false);
	}, 180_000);
});
