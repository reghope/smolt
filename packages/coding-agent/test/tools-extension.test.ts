import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@smolt/ai/compat";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import toolsExtension, {
	DEFAULT_TOOLS_CONFIG,
	readToolsConfig,
	toolHabitsPrompt,
} from "../src/extensions/tools/index.ts";
import {
	createTargetedReadToolDefinition,
	READ_DESCRIPTION,
	READ_GUIDELINES,
	readImageAutoResize,
} from "../src/extensions/tools/read.ts";

/**
 * The extension gives the tools leaner habits: a token budget on every tool result at
 * the boundary, prompt lines, and optionally no read tool at all. The tests
 * hold that the guidance reaches the prompt, that the built-in's behaviour
 * is inherited where it should be, and that each mode does what it says.
 */

// 1x1 PNG, the smallest valid one.
const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

function contextFor(cwd: string): ExtensionContext {
	return { cwd } as unknown as ExtensionContext;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
}

describe("tools extension", () => {
	let tempDir: string;
	let agentDir: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `smolt-tools-ext-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		// The extension reads its config from the agent dir, like the CLI would.
		previousAgentDir = process.env.SMOLT_CODING_AGENT_DIR;
		process.env.SMOLT_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		if (previousAgentDir === undefined) delete process.env.SMOLT_CODING_AGENT_DIR;
		else process.env.SMOLT_CODING_AGENT_DIR = previousAgentDir;
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function startSession() {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.create(tempDir, join(agentDir, "sessions"), { id: "tools-ext-test" });
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [toolsExtension],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			thinkingLevel: "high",
			settingsManager,
			sessionManager,
			resourceLoader,
		});
		return session;
	}

	test("its read replaces the built-in and its guidance reaches the system prompt", async () => {
		const session = await startSession();
		try {
			const read = session.getAllTools().find((tool) => tool.name === "read");
			expect(read?.description).toBe(READ_DESCRIPTION);
			expect(read?.description).toContain("only read that part");
			expect(read?.description).not.toContain("continue with offset until complete");
			for (const guideline of READ_GUIDELINES) {
				expect(session.systemPrompt).toContain(`- ${guideline}`);
			}
			expect(session.getAllTools().filter((tool) => tool.name === "read")).toHaveLength(1);
			expect(session.getActiveToolNames()).toContain("read");
			expect(session.getActiveToolNames()).not.toContain("view_image");

			writeFileSync(join(tempDir, "notes.txt"), "one\ntwo\nthree\nfour\nfive");
			const readTool = session.agent.state.tools.find((tool) => tool.name === "read")!;
			const result = await readTool.execute("read-1", { path: "notes.txt", offset: 2, limit: 2 });
			expect(textOf(result)).toBe("two\nthree\n\n[2 more lines in file. Use offset=4 to continue.]");
		} finally {
			session.dispose();
		}
	});

	test("every tool result is cut to the budget at the boundary, head and tail kept", async () => {
		writeFileSync(join(agentDir, "tools.json"), JSON.stringify({ outputTokenLimit: 200 }));
		const session = await startSession();
		try {
			const padding = "x".repeat(20);
			writeFileSync(
				join(tempDir, "big.txt"),
				Array.from({ length: 400 }, (_, i) => `line ${i + 1} ${padding}`).join("\n"),
			);
			const readTool = session.agent.state.tools.find((tool) => tool.name === "read")!;
			const args = { path: "big.txt" };
			const raw = await readTool.execute("read-2", args);
			// The budget is applied where the loop applies it: the after-tool-call hook.
			const hooked = await session.agent.afterToolCall!({
				assistantMessage: { role: "assistant", content: [] } as never,
				toolCall: { type: "toolCall", id: "read-2", name: "read", arguments: args },
				args,
				result: raw,
				isError: false,
				context: session.agent.state as never,
			});
			const text = textOf({ content: (hooked?.content ?? raw.content) as Array<{ type: string; text?: string }> });
			expect(text).toMatch(/…\d+ tokens truncated…/);
			expect(text.startsWith("line 1 ")).toBe(true);
			expect(text.trimEnd().endsWith(`line 400 ${padding}`)).toBe(true);
			expect(Buffer.byteLength(text)).toBeLessThan(200 * 4 + 60);
		} finally {
			session.dispose();
		}
	});

	test("shell mode drops the read tool, keeps view_image, and says how to read", async () => {
		writeFileSync(join(agentDir, "tools.json"), JSON.stringify({ read: "shell" }));
		const session = await startSession();
		// session_start fires when the host binds, as every mode does at startup.
		await session.bindExtensions({});
		try {
			expect(session.getActiveToolNames()).not.toContain("read");
			expect(session.getActiveToolNames()).toContain("view_image");
			expect(session.getActiveToolNames()).toContain("bash");

			writeFileSync(join(tempDir, "dot.png"), Buffer.from(TINY_PNG_BASE64, "base64"));
			writeFileSync(join(tempDir, "notes.txt"), "not an image");
			const viewImage = session.agent.state.tools.find((tool) => tool.name === "view_image")!;
			expect(textOf(await viewImage.execute("v-1", { path: "dot.png" }))).toMatch(/^Read image file \[/);
			expect(textOf(await viewImage.execute("v-2", { path: "notes.txt" }))).toContain("not an image");
		} finally {
			session.dispose();
		}
	});

	test("the habit lines are appended per mode", () => {
		const tool = toolHabitsPrompt(DEFAULT_TOOLS_CONFIG);
		expect(tool).toContain("prefer rg or rg --files");
		expect(tool).toContain("Parallelize tool calls");
		expect(tool).toContain("capped at 10000 tokens");
		expect(tool).not.toContain("There is no read tool");
		const shell = toolHabitsPrompt({ ...DEFAULT_TOOLS_CONFIG, read: "shell" });
		expect(shell).toContain("There is no read tool");
		expect(shell).toContain("sed -n 'START,ENDp'");
	});

	test("config falls back to the defaults and ignores nonsense", () => {
		expect(readToolsConfig(undefined)).toEqual(DEFAULT_TOOLS_CONFIG);
		writeFileSync(
			join(agentDir, "tools.json"),
			JSON.stringify({ read: "carrier pigeon", outputTokenLimit: -5, firstLookLines: 500 }),
		);
		expect(readToolsConfig(join(agentDir, "tools.json"))).toEqual({ ...DEFAULT_TOOLS_CONFIG, firstLookLines: 500 });
		writeFileSync(join(agentDir, "tools.json"), "not json");
		expect(readToolsConfig(join(agentDir, "tools.json"))).toEqual(DEFAULT_TOOLS_CONFIG);
	});

	test("keeps everything of the built-in except the guidance", () => {
		const builtIn = createReadToolDefinition(tempDir);
		const targeted = createTargetedReadToolDefinition();
		expect(targeted.name).toBe(builtIn.name);
		expect(targeted.label).toBe(builtIn.label);
		expect(targeted.promptSnippet).toBe(builtIn.promptSnippet);
		expect(targeted.parameters).toEqual(builtIn.parameters);
		expect(targeted.promptGuidelines).toEqual(READ_GUIDELINES);
		expect(targeted.description).not.toBe(builtIn.description);
	});

	test("a ranged read resolves against the calling context's cwd", async () => {
		writeFileSync(join(tempDir, "notes.txt"), "one\ntwo\nthree");
		const targeted = createTargetedReadToolDefinition();
		const result = await targeted.execute(
			"read-3",
			{ path: "notes.txt", offset: 3 },
			undefined,
			undefined,
			contextFor(tempDir),
		);
		expect(textOf(result)).toBe("three");
	});

	test("an image still takes the built-in image path", async () => {
		writeFileSync(join(tempDir, "dot.png"), Buffer.from(TINY_PNG_BASE64, "base64"));
		const targeted = createTargetedReadToolDefinition();
		const result = await targeted.execute("read-4", { path: "dot.png" }, undefined, undefined, contextFor(tempDir));
		expect(result.content[0]?.type).toBe("text");
		expect(textOf(result)).toMatch(/^Read image file \[/);
	});

	test("image auto-resize follows settings, project over global, default on", () => {
		expect(readImageAutoResize(tempDir, agentDir)).toBe(true);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ images: { autoResize: false } }));
		expect(readImageAutoResize(tempDir, agentDir)).toBe(false);
		mkdirSync(join(tempDir, ".smolt"), { recursive: true });
		writeFileSync(join(tempDir, ".smolt", "settings.json"), JSON.stringify({ images: { autoResize: true } }));
		expect(readImageAutoResize(tempDir, agentDir)).toBe(true);
		writeFileSync(join(tempDir, ".smolt", "settings.json"), "not json");
		expect(readImageAutoResize(tempDir, agentDir)).toBe(false);
	});
});

describe("tools extension first look (opt-in)", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `smolt-tools-look-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		writeFileSync(join(tempDir, "long.txt"), Array.from({ length: 800 }, (_, i) => `line ${i + 1}`).join("\n"));
		writeFileSync(join(tempDir, "short.txt"), Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("off by default: an unranged read is the built-in's", async () => {
		const targeted = createTargetedReadToolDefinition();
		const text = textOf(await targeted.execute("r", { path: "long.txt" }, undefined, undefined, contextFor(tempDir)));
		expect(text.split("\n")).toHaveLength(800);
		expect(text).not.toContain("First");
	});

	test("when set, a read with no range gets the first look and is told what remains", async () => {
		const targeted = createTargetedReadToolDefinition(undefined, 500);
		const text = textOf(await targeted.execute("r", { path: "long.txt" }, undefined, undefined, contextFor(tempDir)));
		const lines = text.split("\n");
		expect(lines[0]).toBe("line 1");
		expect(lines[499]).toBe("line 500");
		expect(text).toContain("[First 500 lines shown; 300 more in file. Use offset=501 to continue");
		expect(text).toContain("search with rg");
		expect(targeted.description).toContain("first 500 lines");
	});

	test("a read that names a range gets what it asked for, past the first look", async () => {
		const targeted = createTargetedReadToolDefinition(undefined, 500);
		const fromOffset = textOf(
			await targeted.execute("r", { path: "long.txt", offset: 501 }, undefined, undefined, contextFor(tempDir)),
		);
		expect(fromOffset.split("\n")).toHaveLength(300);
		const withLimit = textOf(
			await targeted.execute("r", { path: "long.txt", limit: 600 }, undefined, undefined, contextFor(tempDir)),
		);
		expect(withLimit).toContain("[200 more lines in file. Use offset=601 to continue.]");
	});

	test("a file inside the first look reads whole, with no note", async () => {
		const targeted = createTargetedReadToolDefinition(undefined, 500);
		const text = textOf(
			await targeted.execute("r", { path: "short.txt" }, undefined, undefined, contextFor(tempDir)),
		);
		expect(text.split("\n")).toHaveLength(100);
		expect(text).not.toContain("[");
	});
});
