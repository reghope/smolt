import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { createWayfinderExtension } from "../src/extensions/wayfinder/index.ts";
import type { WayfinderStore } from "../src/extensions/wayfinder/store.ts";

/**
 * Wiring tests for the wayfinder extension: conditional system-prompt
 * injection frozen per session, tool dispatch with the session-scoped
 * decision limit, and the /wayfinder command's mode selection.
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

interface RegisteredCommand {
	description?: string;
	getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string; description?: string }>;
	handler: (args: string, ctx: unknown) => Promise<void>;
}

class FakeSmolt {
	handlers = new Map<string, ((event: Record<string, unknown>, ctx?: unknown) => Promise<unknown>)[]>();
	tools = new Map<string, RegisteredTool>();
	commands = new Map<string, RegisteredCommand>();
	sentMessages: string[] = [];

	on(event: string, handler: (event: Record<string, unknown>, ctx?: unknown) => Promise<unknown>): void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
	}

	registerTool(tool: RegisteredTool): void {
		this.tools.set(tool.name, tool);
	}

	registerCommand(name: string, options: RegisteredCommand): void {
		this.commands.set(name, options);
	}

	sendUserMessage(content: string): void {
		this.sentMessages.push(content);
	}

	async fire(event: string, payload: Record<string, unknown> = {}, ctx?: unknown): Promise<unknown> {
		let result: unknown;
		for (const handler of this.handlers.get(event) ?? []) {
			result = await handler({ type: event, ...payload }, ctx);
		}
		return result;
	}

	async runTool(
		name: string,
		params: Record<string, unknown>,
		sessionId = "session-a",
	): Promise<Record<string, unknown>> {
		const tool = this.tools.get(name);
		if (!tool) throw new Error(`tool not registered: ${name}`);
		const ctx = { sessionManager: { getSessionId: () => sessionId } };
		const result = await tool.execute("call-1", params, undefined, undefined, ctx);
		return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
	}
}

let dir: string;
let smolt: FakeSmolt;
let store: WayfinderStore;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "wayfinder-ext-"));
	smolt = new FakeSmolt();
	store = createWayfinderExtension(smolt as unknown as ExtensionAPI, { root: join(dir, "wayfinder") });
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

async function chartFixture(): Promise<void> {
	await smolt.runTool("wayfinder", {
		action: "chart",
		title: "Payments Revamp",
		destination: "A locked provider decision.",
	});
	await smolt.runTool("wayfinder", {
		action: "add_ticket",
		map: "payments-revamp",
		title: "Pick the provider",
		type: "grilling",
		question: "Which provider do we commit to?",
	});
}

describe("system prompt injection", () => {
	test("injects nothing when no maps exist", async () => {
		await smolt.fire("session_start");
		const result = await smolt.fire("before_agent_start", { systemPrompt: "BASE" });
		expect(result).toBeUndefined();
	});

	test("injects the doctrine and active-map status, frozen for the session", async () => {
		await chartFixture();
		await smolt.fire("session_start");
		const first = (await smolt.fire("before_agent_start", { systemPrompt: "BASE" })) as { systemPrompt: string };
		expect(first.systemPrompt.startsWith("BASE")).toBe(true);
		expect(first.systemPrompt).toContain("## Wayfinder");
		expect(first.systemPrompt).toContain("Payments Revamp");
		expect(first.systemPrompt).toContain("1 takeable of 1 open");

		// Mid-session changes land on disk but not in the frozen block.
		await smolt.runTool("wayfinder", {
			action: "add_ticket",
			map: "payments-revamp",
			title: "Choose rollout order",
			type: "grilling",
			question: "Which market first?",
		});
		const second = (await smolt.fire("before_agent_start", { systemPrompt: "BASE" })) as { systemPrompt: string };
		expect(second.systemPrompt).toContain("1 takeable of 1 open");

		await smolt.fire("session_start");
		const third = (await smolt.fire("before_agent_start", { systemPrompt: "BASE" })) as { systemPrompt: string };
		expect(third.systemPrompt).toContain("2 takeable of 2 open");
	});

	test("a completed map is not announced", async () => {
		await smolt.runTool("wayfinder", { action: "chart", title: "Done Effort", destination: "d" });
		await smolt.runTool("wayfinder", { action: "update_map", map: "done-effort", status: "complete" });
		await smolt.fire("session_start");
		expect(await smolt.fire("before_agent_start", { systemPrompt: "BASE" })).toBeUndefined();
	});
});

describe("session decision limit", () => {
	test("resets on session_start", async () => {
		await chartFixture();
		await smolt.runTool("wayfinder", { action: "claim", map: "payments-revamp", ticket: "pick-the-provider" });
		await smolt.runTool("wayfinder", {
			action: "resolve",
			map: "payments-revamp",
			ticket: "pick-the-provider",
			resolution: "Adyen.",
		});
		await smolt.runTool("wayfinder", {
			action: "add_ticket",
			map: "payments-revamp",
			title: "Choose rollout order",
			type: "grilling",
			question: "Which market first?",
		});
		await smolt.runTool("wayfinder", { action: "claim", map: "payments-revamp", ticket: "choose-rollout-order" });
		const refused = await smolt.runTool("wayfinder", {
			action: "resolve",
			map: "payments-revamp",
			ticket: "choose-rollout-order",
			resolution: "EU first.",
		});
		expect(refused.success).toBe(false);

		await smolt.fire("session_start");
		const allowed = await smolt.runTool("wayfinder", {
			action: "resolve",
			map: "payments-revamp",
			ticket: "choose-rollout-order",
			resolution: "EU first.",
		});
		expect(allowed.success).toBe(true);
	});

	test("the claim is checked against the calling session's id", async () => {
		await chartFixture();
		await smolt.runTool(
			"wayfinder",
			{ action: "claim", map: "payments-revamp", ticket: "pick-the-provider" },
			"session-a",
		);
		const foreign = await smolt.runTool(
			"wayfinder",
			{ action: "resolve", map: "payments-revamp", ticket: "pick-the-provider", resolution: "Adyen." },
			"session-b",
		);
		expect(foreign.success).toBe(false);
	});
});

interface SettledCtx {
	mode: string;
	compacted: boolean;
	hasPendingMessages: () => boolean;
	getContextUsage: () => { tokens: number; percent: number | null } | undefined;
	compact: (opts?: { customInstructions?: string; onComplete?: (result: unknown) => void }) => void;
}

function makeSettledCtx(options: { mode?: string; percent?: number | null; pending?: boolean } = {}): SettledCtx {
	const ctx: SettledCtx = {
		mode: options.mode ?? "tui",
		compacted: false,
		hasPendingMessages: () => options.pending ?? false,
		getContextUsage: () =>
			options.percent === undefined ? undefined : { tokens: 100_000, percent: options.percent },
		compact: (opts) => {
			ctx.compacted = true;
			opts?.onComplete?.({});
		},
	};
	return ctx;
}

describe("research auto-continuation", () => {
	async function resolveDecisionWithResearchBehind(): Promise<void> {
		await chartFixture();
		await smolt.runTool("wayfinder", {
			action: "add_ticket",
			map: "payments-revamp",
			title: "Survey migration tooling",
			type: "research",
			question: "What tooling exists?",
			blocked_by: ["pick-the-provider"],
		});
		await smolt.runTool("wayfinder", { action: "claim", map: "payments-revamp", ticket: "pick-the-provider" });
		await smolt.runTool("wayfinder", {
			action: "resolve",
			map: "payments-revamp",
			ticket: "pick-the-provider",
			resolution: "Adyen.",
		});
	}

	test("compacts then sends the research prompt when a decision leaves research takeable", async () => {
		await resolveDecisionWithResearchBehind();
		const ctx = makeSettledCtx({ percent: 60 });
		await smolt.fire("agent_settled", {}, ctx);
		expect(ctx.compacted).toBe(true);
		expect(smolt.sentMessages).toHaveLength(1);
		expect(smolt.sentMessages[0]).toContain("payments-revamp");
		expect(smolt.sentMessages[0]).toContain("survey-migration-tooling");

		// Disarmed: a later settle with no new wayfinder activity stays quiet.
		await smolt.fire("agent_settled", {}, makeSettledCtx({ percent: 60 }));
		expect(smolt.sentMessages).toHaveLength(1);
	});

	test("skips compaction when the context is still small", async () => {
		await resolveDecisionWithResearchBehind();
		const ctx = makeSettledCtx({ percent: 5 });
		await smolt.fire("agent_settled", {}, ctx);
		expect(ctx.compacted).toBe(false);
		expect(smolt.sentMessages).toHaveLength(1);
	});

	test("stays quiet when no research is takeable, the user queued a message, or the mode is headless", async () => {
		await chartFixture();
		await smolt.runTool("wayfinder", { action: "claim", map: "payments-revamp", ticket: "pick-the-provider" });
		await smolt.runTool("wayfinder", {
			action: "resolve",
			map: "payments-revamp",
			ticket: "pick-the-provider",
			resolution: "Adyen.",
		});
		await smolt.fire("agent_settled", {}, makeSettledCtx({ percent: 60 }));
		expect(smolt.sentMessages).toHaveLength(0);

		// Re-arm via a takeable research ticket, but with a user message queued.
		await smolt.runTool("wayfinder", {
			action: "add_ticket",
			map: "payments-revamp",
			title: "Survey migration tooling",
			type: "research",
			question: "What tooling exists?",
		});
		await smolt.fire("agent_settled", {}, makeSettledCtx({ percent: 60, pending: true }));
		expect(smolt.sentMessages).toHaveLength(0);
	});

	test("headless modes never auto-continue", async () => {
		await resolveDecisionWithResearchBehind();
		await smolt.fire("agent_settled", {}, makeSettledCtx({ percent: 60, mode: "print" }));
		expect(smolt.sentMessages).toHaveLength(0);
	});

	test("creating research tickets while charting arms the continuation", async () => {
		await smolt.runTool("wayfinder", { action: "chart", title: "New Effort", destination: "d" });
		await smolt.runTool("wayfinder", {
			action: "add_ticket",
			map: "new-effort",
			title: "Scan the docs",
			type: "research",
			question: "What does the API support?",
		});
		await smolt.fire("agent_settled", {}, makeSettledCtx({ percent: 5 }));
		expect(smolt.sentMessages).toHaveLength(1);
		expect(smolt.sentMessages[0]).toContain("scan-the-docs");
	});
});

describe("/wayfinder command", () => {
	test("is registered with map completions", async () => {
		await chartFixture();
		const command = smolt.commands.get("wayfinder");
		expect(command).toBeDefined();
		const completions = command!.getArgumentCompletions!("");
		expect(completions.map((item) => item.value)).toEqual(["chart", "payments-revamp"]);
		expect(command!.getArgumentCompletions!("ch").map((item) => item.value)).toEqual(["chart"]);
	});

	test("no args and no maps sends the charting prompt", async () => {
		await smolt.commands.get("wayfinder")!.handler("", {});
		expect(smolt.sentMessages).toHaveLength(1);
		expect(smolt.sentMessages[0]).toContain("Chart a wayfinder map");
	});

	test("chart with an idea seeds the prompt", async () => {
		await smolt.commands.get("wayfinder")!.handler("chart migrate billing to usage-based", {});
		expect(smolt.sentMessages[0]).toContain("migrate billing to usage-based");
	});

	test("no args with one active map sends the working prompt for it", async () => {
		await chartFixture();
		await smolt.commands.get("wayfinder")!.handler("", {});
		expect(smolt.sentMessages[0]).toContain("Work through the wayfinder map 'payments-revamp'");
	});

	test("a plain-English request is never parsed as a map name", async () => {
		// The bug this guards: "/wayfinder What are some skills we could add"
		// used to chart against a map called 'What' with the rest as a ticket.
		await smolt.commands.get("wayfinder")!.handler("What are some skills we could add to our app?", {});
		expect(smolt.sentMessages[0]).toContain("Chart a wayfinder map");
		expect(smolt.sentMessages[0]).toContain("What are some skills we could add to our app?");
		expect(smolt.sentMessages[0]).not.toContain("map 'What'");
	});

	test("a request alongside active maps asks the agent to place it", async () => {
		await chartFixture();
		await smolt.commands.get("wayfinder")!.handler("what skills could we add, like the memory module?", {});
		expect(smolt.sentMessages[0]).toContain("request in my own words");
		expect(smolt.sentMessages[0]).toContain("what skills could we add");
		// The active map is offered as context for the agent's choice.
		expect(smolt.sentMessages[0]).toContain("payments-revamp");
	});

	test("a map name still routes to the working prompt, by slug or title", async () => {
		await chartFixture();
		await smolt.commands.get("wayfinder")!.handler("payments-revamp", {});
		expect(smolt.sentMessages[0]).toContain("Work through the wayfinder map 'payments-revamp'");
		expect(store.resolveMap("Payments Revamp")?.slug).toBe("payments-revamp");
		expect(store.resolveMap("What")).toBeUndefined();
	});

	test("a map and ticket argument target the working prompt", async () => {
		await chartFixture();
		await smolt.commands.get("wayfinder")!.handler("payments-revamp pick-the-provider", {});
		expect(smolt.sentMessages[0]).toContain("'payments-revamp'");
		expect(smolt.sentMessages[0]).toContain("pick-the-provider");
	});

	test("store handle returned for embedding surfaces", () => {
		expect(store.listMaps()).toEqual([]);
	});
});
