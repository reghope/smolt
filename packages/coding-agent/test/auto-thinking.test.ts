import type { ThinkingLevel } from "@smolt/agent-core";
import { clampThinkingLevel } from "@smolt/ai/compat";
import { beforeEach, describe, expect, test } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import { classify, escalationLadder, nextRung } from "../src/extensions/auto-thinking/classifier.ts";
import { AUTO_THINKING_ENTRY, createAutoThinkingExtension } from "../src/extensions/auto-thinking/index.ts";

/**
 * The auto thinking extension: a zero-usage heuristic classifies each task's
 * thinking level before its first request, escalation bumps the level when a
 * task struggles, and any manual pick stands auto down until auto is picked
 * again.
 */

describe("classify", () => {
	test("conversational tokens run without thinking", () => {
		for (const text of ["hi", "thanks!", "ok", "go on", "Proceed.", "yes", "ok thanks", "yes yes, done"]) {
			const result = classify(text);
			expect(result.level).toBe("off");
			expect(result.confidence).toBe("confident");
		}
	});

	test("follow-ups inherit the previous task's level", () => {
		const result = classify("do the same for the settings page", { previousLevel: "high" });
		expect(result.level).toBe("high");
		expect(result.reason).toContain("follow-up");
	});

	test("pasted stack traces classify high", () => {
		const text = 'this crashes:\nTraceback (most recent call last):\n  File "x.py", line 1';
		expect(classify(text).level).toBe("high");
		const js = "node crashes\n    at Object.<anonymous> (/x/y.ts:10:5)";
		expect(classify(js).level).toBe("high");
	});

	test("cause-hunting verbs classify high", () => {
		for (const text of [
			"debug why the pool drains tokens",
			"investigate the flaky session teardown",
			"why does compaction truncate history?",
		]) {
			expect(classify(text).level).toBe("high");
		}
	});

	test("design-shaped work classifies medium, not high", () => {
		for (const text of [
			"refactor the session manager",
			"design a migration path for the schema",
			"tighten the performance of the transcript renderer",
		]) {
			expect(classify(text).level).toBe("medium");
		}
	});

	test("fixes paired with failure language classify high", () => {
		for (const text of [
			"fix the bug in the retry loop",
			"please fix auto thinking, it seems to always pick low",
			"resolve the flaky test issue",
			"fix the footer, it should be pinned instead of scrolling",
		]) {
			const result = classify(text);
			expect(result.level).toBe("high");
			expect(result.confidence).toBe("confident");
		}
	});

	test("described misbehavior is a bug report even without a fix verb", () => {
		for (const text of [
			"the settings dialog crashes when I open it twice",
			"the sync spinner hangs after resume",
			"saving stopped working after the last update",
		]) {
			expect(classify(text).level).toBe("high");
		}
	});

	test("quick requests stay minimal", () => {
		expect(classify("quick check: is the footer aligned?").level).toBe("minimal");
	});

	test("long prompts and multi-step requests classify medium", () => {
		expect(classify("x".repeat(2500)).level).toBe("medium");
		expect(classify("do three things:\n1) read the file\n2) update the docs").level).toBe("medium");
		expect(classify("review this:\n```ts\nconst x = 1;\n```").level).toBe("medium");
	});

	test("substantive change requests classify medium", () => {
		for (const text of [
			"add retry support to the uploader",
			"implement dark mode for the settings dialog",
			"update the composer to send drafts on blur",
		]) {
			const result = classify(text);
			expect(result.level).toBe("medium");
			expect(result.reason).toContain("substantive");
		}
	});

	test("cosmetic edits classify low even with change verbs", () => {
		expect(classify("fix the typo in the welcome banner").level).toBe("low");
		expect(classify("rename fetchData to loadPosts in src/api/posts.ts").level).toBe("low");
	});

	test("substantial prompts with no clear signal fall back to low, uncertain", () => {
		const result = classify("go through the composer component and tidy the props so they group logically");
		expect(result.level).toBe("low");
		expect(result.confidence).toBe("uncertain");
	});

	test("short vague prompts fall back to the lowest thinking, uncertain", () => {
		const result = classify("look at the build output when you get a chance");
		expect(result.level).toBe("minimal");
		expect(result.confidence).toBe("uncertain");
	});

	test("slash commands are left alone by the caller, but classify sanely anyway", () => {
		// The extension skips "/" input before calling classify; this only
		// pins the classifier's own behavior.
		expect(classify("/commit").level).toBe("minimal");
	});
});

describe("escalation ladder", () => {
	test("covers supported levels up to medium", () => {
		const ladder = escalationLadder(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
		expect(ladder).toEqual(["off", "minimal", "low", "medium"]);
	});

	test("skips levels the model does not support", () => {
		const ladder = escalationLadder(["off", "low", "medium", "high"]);
		expect(ladder).toEqual(["off", "low", "medium"]);
	});

	test("climbs one rung at a time and stops at the cap", () => {
		const ladder = escalationLadder(["off", "minimal", "low", "medium"]);
		expect(nextRung(ladder, "off")).toBe("minimal");
		expect(nextRung(ladder, "minimal")).toBe("low");
		expect(nextRung(ladder, "low")).toBe("medium");
		expect(nextRung(ladder, "medium")).toBeUndefined();
	});

	test("levels above the cap are outside the ladder", () => {
		const ladder = escalationLadder(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
		expect(nextRung(ladder, "high")).toBeUndefined();
		expect(nextRung(ladder, "max")).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Extension wiring
// ---------------------------------------------------------------------------

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => Promise<unknown> | unknown;

class FakeSmolt {
	handlers = new Map<string, Handler[]>();
	commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	entries: { customType: string; data?: unknown }[] = [];
	entriesRegistered: { value: string }[] = [];
	level: ThinkingLevel = "medium";
	modelRef: { provider: string; id: string; reasoning: boolean; thinkingLevelMap?: Record<string, string | null> } = {
		provider: "anthropic",
		id: "claude-test",
		reasoning: true,
	};
	notices: string[] = [];
	status: { key: string; text: string | undefined } | undefined;
	widget: { key: string; lines: string[] | undefined } | undefined;

	on(event: string, handler: Handler): void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
	}

	registerCommand(name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }): void {
		this.commands.set(name, options);
	}

	registerThinkingLevelEntry(entry: { value: string }): void {
		this.entriesRegistered.push(entry);
	}

	getThinkingLevel(): ThinkingLevel {
		return this.level;
	}

	setThinkingLevel(level: ThinkingLevel): void {
		// Emulate the core: clamp to model capabilities, then report the
		// effective level in the event.
		const effective = clampThinkingLevel(this.modelRef as never, level) as ThinkingLevel;
		this.level = effective;
		void this.fire("thinking_level_select", { level: effective, previousLevel: "medium" });
	}

	appendEntry(customType: string, data?: unknown): void {
		this.entries.push({ customType, data });
	}

	async fire(event: string, payload: Record<string, unknown> = {}): Promise<void> {
		for (const handler of this.handlers.get(event) ?? []) await handler({ type: event, ...payload }, this.ctx());
	}

	async runCommand(args: string): Promise<void> {
		await this.commands.get("auto-thinking")!.handler(args, this.ctx());
	}

	ctx(): ExtensionContext {
		return {
			ui: {
				notify: (message: string) => this.notices.push(message),
				setStatus: (key: string, text: string | undefined) => {
					this.status = { key, text };
				},
				setWidget: (key: string, lines: string[] | undefined) => {
					this.widget = { key, lines };
				},
			},
			mode: "tui",
			model: this.modelRef,
		} as unknown as ExtensionContext;
	}
}

let smolt: FakeSmolt;

beforeEach(() => {
	smolt = new FakeSmolt();
	createAutoThinkingExtension(smolt as unknown as ExtensionAPI);
});

describe("auto-thinking extension", () => {
	test("registers the far-left selector entry", () => {
		expect(smolt.entriesRegistered.map((entry) => entry.value)).toEqual(["auto"]);
	});

	test("classifies each user message before its first request", async () => {
		await smolt.fire("session_start");
		await smolt.fire("input", { text: "debug why the retry loop spins", source: "interactive" });
		expect(smolt.level).toBe("high");
		expect(smolt.status?.text).toContain("high");
	});

	test("a model missing the classified level clamps down, not up", async () => {
		// e.g. a sparsely-mapped model with no 'high': the core clamp alone
		// would round a high classification up to xhigh; auto thinking must
		// prefer the cheaper neighbor instead.
		smolt.modelRef = {
			provider: "test",
			id: "no-high",
			reasoning: true,
			thinkingLevelMap: { high: null, xhigh: "xhigh", max: "max" },
		};
		await smolt.fire("session_start");
		await smolt.fire("input", { text: "debug why the retry loop spins", source: "interactive" });
		expect(smolt.level).toBe("medium");
	});

	test("continuations keep the task's level", async () => {
		await smolt.fire("session_start");
		await smolt.fire("input", { text: "debug why the retry loop spins", source: "interactive" });
		expect(smolt.level).toBe("high");
		// A steer while streaming would re-classify as conversational; it must
		// not: the task is already classified.
		await smolt.fire("input", { text: "ok", source: "interactive", streamingBehavior: "steer" });
		expect(smolt.level).toBe("high");
	});

	test("two consecutive tool errors escalate one rung", async () => {
		await smolt.fire("session_start");
		await smolt.fire("input", { text: "look at the build output when you get a chance", source: "interactive" });
		expect(smolt.level).toBe("minimal");
		await smolt.fire("tool_result", { isError: true });
		expect(smolt.level).toBe("minimal");
		await smolt.fire("tool_result", { isError: true });
		expect(smolt.level).toBe("low");
		expect(smolt.status?.text).toContain("escalated");
	});

	test("a successful tool result resets the error counter", async () => {
		await smolt.fire("session_start");
		await smolt.fire("input", { text: "look at the build output when you get a chance", source: "interactive" });
		await smolt.fire("tool_result", { isError: true });
		await smolt.fire("tool_result", { isError: false });
		await smolt.fire("tool_result", { isError: true });
		expect(smolt.level).toBe("minimal");
	});

	test("escalation never passes medium", async () => {
		await smolt.fire("session_start");
		await smolt.fire("input", { text: "look at the build output", source: "interactive" });
		for (let index = 0; index < 10; index++) await smolt.fire("tool_result", { isError: true });
		expect(smolt.level).toBe("medium");
	});

	test("a manual pick stands auto down until auto is selected again", async () => {
		await smolt.fire("session_start");
		await smolt.fire("input", { text: "debug why the retry loop spins", source: "interactive" });
		expect(smolt.level).toBe("high");
		// The user picks "low" in the selector: the core applies the level and
		// reports a selection the extension did not make.
		smolt.level = "low";
		await smolt.fire("thinking_level_select", { level: "low", previousLevel: "high" });
		expect(smolt.status?.text).toBeUndefined();
		// Manual levels win while auto is off.
		await smolt.fire("input", { text: "debug why the retry loop spins again", source: "interactive" });
		expect(smolt.level).toBe("low");
	});

	test("a model switch rewriting the level does not stand auto down", async () => {
		await smolt.fire("session_start");
		await smolt.fire("input", { text: "debug why the retry loop spins", source: "interactive" });
		expect(smolt.level).toBe("high");
		// setModel changes the model first, then rewrites the level.
		smolt.modelRef = { provider: "anthropic", id: "claude-other", reasoning: true };
		await smolt.fire("thinking_level_select", { level: "medium", previousLevel: "high" });
		expect(smolt.status?.text).toContain("auto");
	});

	test("/auto-thinking off disables, on re-enables", async () => {
		await smolt.fire("session_start");
		await smolt.runCommand("off");
		expect(smolt.status?.text).toBeUndefined();
		await smolt.fire("input", { text: "debug why the retry loop spins", source: "interactive" });
		expect(smolt.level).toBe("medium"); // untouched
		await smolt.runCommand("on");
		await smolt.fire("input", { text: "debug why the retry loop spins", source: "interactive" });
		expect(smolt.level).toBe("high");
	});

	test("a clamp mismatch does not stand auto down", async () => {
		// A model whose thinkingLevelMap has no "off" or "minimal": trivial
		// prompts clamp up to low.
		smolt.modelRef = {
			provider: "anthropic",
			id: "glm-flash",
			reasoning: true,
			thinkingLevelMap: { off: null, minimal: null },
		};
		smolt.level = "max";
		await smolt.fire("session_start");
		await smolt.fire("input", { text: "hi", source: "interactive" });
		expect(smolt.level).toBe("low");
		expect(smolt.status?.text).toContain("auto");
		// A later real manual pick still stands auto down.
		smolt.level = "high";
		await smolt.fire("thinking_level_select", { level: "high", previousLevel: "low" });
		expect(smolt.status?.text).toBeUndefined();
	});

	test("records decisions as custom session entries", async () => {
		await smolt.fire("session_start");
		await smolt.fire("input", { text: "debug why the retry loop spins", source: "interactive" });
		const decisions = smolt.entries.filter((entry) => entry.customType === AUTO_THINKING_ENTRY);
		expect(decisions.length).toBeGreaterThan(0);
		expect(decisions[0]?.data).toMatchObject({ level: "high" });
	});
});
