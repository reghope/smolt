import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { createTasteExtension } from "../src/extensions/taste/index.ts";

/**
 * Wiring tests for the taste gate: the doctrine arms itself, writes that
 * render are tracked, and a session cannot end quietly having written UI it
 * never reviewed. The part worth proving is that the gate cannot be talked
 * past — a pass claimed over failing mechanical checks is still a failure.
 */

interface RegisteredTool {
	name: string;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: unknown,
		onUpdate?: unknown,
		ctx?: unknown,
	): Promise<{ content: { type: string; text: string }[] }>;
}

class FakeSmolt {
	handlers = new Map<string, ((event: Record<string, unknown>, ctx?: unknown) => Promise<unknown>)[]>();
	tools = new Map<string, RegisteredTool>();
	commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	sent: string[] = [];
	notices: string[] = [];
	pending = false;
	cwd = "";

	on(event: string, handler: (event: Record<string, unknown>, ctx?: unknown) => Promise<unknown>): void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
	}

	registerTool(tool: RegisteredTool): void {
		this.tools.set(tool.name, tool);
	}

	registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }): void {
		this.commands.set(name, options);
	}

	sendUserMessage(content: string): void {
		this.sent.push(content);
	}

	appendEntry(): void {}

	ctx(): unknown {
		return {
			mode: "tui",
			cwd: this.cwd,
			isIdle: () => true,
			hasPendingMessages: () => this.pending,
			ui: {
				notify: (message: string) => this.notices.push(message),
				setStatus: () => undefined,
				setWidget: () => undefined,
			},
		};
	}

	async fire(event: string, payload: Record<string, unknown> = {}): Promise<unknown> {
		let result: unknown;
		for (const handler of this.handlers.get(event) ?? [])
			result = await handler({ type: event, ...payload }, this.ctx());
		return result;
	}

	async review(params: Record<string, unknown>): Promise<string> {
		const tool = this.tools.get("taste_review");
		if (!tool) throw new Error("taste_review not registered");
		const result = await tool.execute("call-1", params, undefined, undefined, this.ctx());
		return result.content[0]!.text;
	}

	async command(args: string): Promise<void> {
		await this.commands.get("taste")!.handler(args, this.ctx());
	}
}

let dir: string;
let smolt: FakeSmolt;
let handle: ReturnType<typeof createTasteExtension>;

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "taste-ext-"));
	mkdirSync(join(dir, "doctrine"), { recursive: true });
	writeFileSync(join(dir, "doctrine", "taste-skill.md"), "# TASTE DOCTRINE BODY");
	writeFileSync(join(dir, "doctrine", "dense-ui.md"), "# DENSE UI SUPPLEMENT");
	mkdirSync(join(dir, "project", "src"), { recursive: true });
	smolt = new FakeSmolt();
	smolt.cwd = join(dir, "project");
	handle = createTasteExtension(smolt as unknown as ExtensionAPI, join(dir, "doctrine"));
	await smolt.fire("session_start");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** Write a file into the fake project and report the successful write to the extension. */
async function writeUi(name: string, body: string): Promise<void> {
	writeFileSync(join(smolt.cwd, name), body);
	await smolt.fire("tool_result", { toolName: "write", input: { path: name }, isError: false });
}

/** Run a shell command through the extension: call, optional disk effect, result. */
async function runShell(command: string, options: { effect?: () => void; isError?: boolean } = {}): Promise<void> {
	await smolt.fire("tool_call", { toolCallId: "sh-1", toolName: "bash", input: { command } });
	options.effect?.();
	await smolt.fire("tool_result", {
		toolCallId: "sh-1",
		toolName: "bash",
		input: { command },
		isError: options.isError ?? false,
	});
}

const CLEAN = '<div className="min-h-[100dvh]"><p>Straight copy.</p></div>';
const DIRTY = '<div className="h-screen"><p>one — two</p></div>';

describe("arming", () => {
	test("nothing is injected until design work appears", async () => {
		expect(await smolt.fire("before_agent_start", { systemPrompt: "BASE" })).toBeUndefined();
		expect(handle.armed()).toBe(false);
	});

	test("a design prompt arms the whole doctrine", async () => {
		await smolt.fire("input", { text: "redo the dashboard layout", source: "interactive" });
		const result = (await smolt.fire("before_agent_start", { systemPrompt: "BASE" })) as { systemPrompt: string };
		expect(result.systemPrompt.startsWith("BASE")).toBe(true);
		expect(result.systemPrompt).toContain("TASTE DOCTRINE BODY");
		expect(result.systemPrompt).toContain("DENSE UI SUPPLEMENT");
	});

	test("it stays armed through turns that are not design work", async () => {
		await smolt.fire("input", { text: "redo the dashboard layout", source: "interactive" });
		await smolt.fire("input", { text: "now fix the parser test", source: "interactive" });
		const result = (await smolt.fire("before_agent_start", { systemPrompt: "BASE" })) as { systemPrompt: string };
		expect(result.systemPrompt).toContain("TASTE DOCTRINE BODY");
	});

	test("the extension's own messages never arm it", async () => {
		await smolt.fire("input", { text: "redo the dashboard layout", source: "extension" });
		expect(handle.armed()).toBe(false);
	});
});

describe("tracking writes", () => {
	test("a file that renders is tracked, one that does not is ignored", async () => {
		await writeUi("src/Hero.tsx", CLEAN);
		await smolt.fire("tool_result", { toolName: "write", input: { path: "src/server.ts" }, isError: false });
		expect(handle.pending()).toEqual(["src/Hero.tsx"]);
	});

	test("a shell redirect into a UI file is caught too", async () => {
		await runShell("cat tpl > src/Hero.tsx", {
			effect: () => writeFileSync(join(smolt.cwd, "src/Hero.tsx"), CLEAN),
		});
		expect(handle.pending()).toEqual(["src/Hero.tsx"]);
	});

	test("reads are not writes", async () => {
		await smolt.fire("tool_result", { toolName: "read", input: { path: "src/Hero.tsx" }, isError: false });
		expect(handle.pending()).toHaveLength(0);
	});

	test("a write that failed did not update anything", async () => {
		await smolt.fire("tool_result", { toolName: "write", input: { path: "src/Hero.tsx" }, isError: true });
		expect(handle.pending()).toHaveLength(0);
	});

	test("a write nominated but never resolved did not update anything", async () => {
		// A denied permission or an abort produces a tool_call with no result.
		await smolt.fire("tool_call", { toolName: "write", input: { path: "src/Hero.tsx" } });
		expect(handle.pending()).toHaveLength(0);
	});

	test("a shell command that mentions a page it never changed tracks nothing", async () => {
		writeFileSync(join(smolt.cwd, "src/Hero.tsx"), CLEAN);
		await runShell("cat src/Hero.tsx > /tmp/out.txt");
		expect(handle.pending()).toHaveLength(0);
	});

	test("a shell command that failed tracks nothing, even if the file moved", async () => {
		await runShell("cat tpl > src/Hero.tsx", {
			effect: () => writeFileSync(join(smolt.cwd, "src/Hero.tsx"), CLEAN),
			isError: true,
		});
		expect(handle.pending()).toHaveLength(0);
	});
});

describe("the gate", () => {
	test("a session that wrote UI without reviewing it is sent back", async () => {
		await writeUi("src/Hero.tsx", CLEAN);
		await smolt.fire("agent_settled");
		expect(smolt.sent).toHaveLength(1);
		expect(smolt.sent[0]).toContain("[taste gate]");
		expect(smolt.sent[0]).toContain("src/Hero.tsx");
	});

	test("a session that wrote nothing visual settles quietly", async () => {
		await smolt.fire("tool_call", { toolName: "write", input: { path: "src/server.ts" } });
		await smolt.fire("agent_settled");
		expect(smolt.sent).toHaveLength(0);
	});

	test("a queued user message wins over the gate", async () => {
		await writeUi("src/Hero.tsx", CLEAN);
		smolt.pending = true;
		await smolt.fire("agent_settled");
		expect(smolt.sent).toHaveLength(0);
	});

	test("it stops pushing after two goes and says so", async () => {
		await writeUi("src/Hero.tsx", CLEAN);
		await smolt.fire("agent_settled");
		await smolt.fire("agent_settled");
		expect(smolt.sent).toHaveLength(2);
		await smolt.fire("agent_settled");
		expect(smolt.sent).toHaveLength(2);
		expect(smolt.notices.some((notice) => notice.includes("still unreviewed"))).toBe(true);
	});
});

describe("review", () => {
	test("the first call reports the mechanics and asks for the checklist", async () => {
		await writeUi("src/Hero.tsx", DIRTY);
		const text = await smolt.review({});
		expect(text).toContain("MECHANICAL CHECKS");
		expect(text).toContain("FAIL src/Hero.tsx");
		expect(text).toContain("NEEDS A BROWSER");
		// Still pending: reporting is not passing.
		expect(handle.pending()).toHaveLength(1);
	});

	test("a clean file plus a pass verdict clears the gate", async () => {
		await writeUi("src/Hero.tsx", CLEAN);
		const text = await smolt.review({ verdict: "pass", findings: "every item PASS with evidence" });
		expect(text).toContain("Review PASSED");
		expect(handle.pending()).toHaveLength(0);
		await smolt.fire("agent_settled");
		expect(smolt.sent).toHaveLength(0);
	});

	test("a pass claimed over failing mechanics is refused", async () => {
		await writeUi("src/Hero.tsx", DIRTY);
		const text = await smolt.review({ verdict: "pass", findings: "looks great to me" });
		expect(text).toContain("Review NOT passed");
		expect(text).toContain("mechanical checks failed");
		expect(handle.pending()).toHaveLength(1);
	});

	test("fixing the file and reviewing again passes", async () => {
		await writeUi("src/Hero.tsx", DIRTY);
		await smolt.review({ verdict: "pass" });
		await writeUi("src/Hero.tsx", CLEAN);
		expect(await smolt.review({ verdict: "pass" })).toContain("Review PASSED");
	});

	test("writing again after a pass re-arms the gate", async () => {
		await writeUi("src/Hero.tsx", CLEAN);
		await smolt.review({ verdict: "pass" });
		await writeUi("src/Hero.tsx", CLEAN);
		await smolt.fire("agent_settled");
		expect(smolt.sent).toHaveLength(1);
	});

	test("a file that cannot be read is a skip, not a silent pass", async () => {
		const text = await smolt.review({ files: ["src/Gone.tsx"] });
		expect(text).toContain("SKIP src/Gone.tsx");
	});
});

describe("the user's controls", () => {
	test("off stands the gate down", async () => {
		await smolt.fire("input", { text: "redo the dashboard", source: "interactive" });
		await smolt.command("off");
		await writeUi("src/Hero.tsx", CLEAN);
		await smolt.fire("agent_settled");
		expect(smolt.sent).toHaveLength(0);
		expect(await smolt.fire("before_agent_start", { systemPrompt: "BASE" })).toBeUndefined();
	});

	test("on arms it without waiting for a design prompt", async () => {
		await smolt.command("on");
		expect(handle.armed()).toBe(true);
	});

	test("a review the user asked for ignores the cap", async () => {
		await writeUi("src/Hero.tsx", CLEAN);
		await smolt.fire("agent_settled");
		await smolt.fire("agent_settled");
		await smolt.fire("agent_settled");
		expect(smolt.sent).toHaveLength(2);
		await smolt.command("review");
		expect(smolt.sent).toHaveLength(3);
	});

	test("reset forgets what is pending", async () => {
		await writeUi("src/Hero.tsx", CLEAN);
		await smolt.command("reset");
		expect(handle.pending()).toHaveLength(0);
	});
});
