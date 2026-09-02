import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "../src/core/extensions/types.ts";
import type { BrowseDriver, BrowseDriverFactory, BrowseLaunchOptions } from "../src/extensions/battletest/cdp.ts";
import {
	createResearchExtension,
	extractTargetUrls,
	type ResearcherSpawner,
	type ResearchHandle,
} from "../src/extensions/research/index.ts";
import type { FetchImpl } from "../src/extensions/research/web.ts";

/**
 * Wiring tests for the research extension: the /research command's dispatch,
 * the researcher lifecycle through a fake spawner, the notebook / browse /
 * fetch / search tools each researcher is handed, the wait action's deltas,
 * waves, and the settle-time synthesis safety net.
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
}

function fakeCtx(): Record<string, unknown> {
	const notifications: string[] = [];
	const ctx: Record<string, unknown> = {
		mode: "tui",
		hasPendingMessages: () => false,
		notifications,
		widget: undefined as string[] | undefined,
		widgetDetails: undefined as unknown,
		status: undefined as string | undefined,
		modelRegistry: {
			getAll: () => [],
			getAvailable: () => [],
			hasConfiguredAuth: () => false,
		},
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus: (_key: string, text: string | undefined) => {
				ctx.status = text;
			},
			setWidget: (_key: string, content: string[] | undefined, options?: { details?: unknown }) => {
				ctx.widget = content;
				ctx.widgetDetails = options?.details;
			},
		},
	};
	return ctx;
}

interface SpawnedResearcher {
	researcher: { slug: string; name: string; angle: string };
	task: string;
	customTools: ToolDefinition[];
	metricsPath?: string;
	finish: (status: "completed" | "errored", detail: string) => void;
	aborted: boolean;
	steered: string[];
}

function fakeBrowseFactory(launches: BrowseLaunchOptions[], log: string[]): BrowseDriverFactory {
	return async (options) => {
		launches.push(options);
		const driver: BrowseDriver = {
			goto: async (url) => void log.push(`goto ${url}`),
			clickSelector: async (selector) => {
				log.push(`click ${selector}`);
				return "Pricing";
			},
			clickAt: async (x, y) => void log.push(`clickAt ${x},${y}`),
			type: async (text) => void log.push(`type ${text}`),
			press: async (key) => void log.push(`press ${key}`),
			scroll: async (dy) => void log.push(`scroll ${dy}`),
			eval: async (js) =>
				js.includes("innerText") ? "Rendered pricing table" : js.includes("outerHTML") ? "<html>x</html>" : '"42"',
			setViewport: async (viewport) => void log.push(`viewport ${viewport.width}x${viewport.height}`),
			screenshot: async () => "aGVsbG8=",
			state: async () => ({ url: "https://example.dev/pricing", title: "Pricing", console: [] }),
			requests: async () => [
				{
					method: "GET",
					url: "https://example.dev/api/prices",
					type: "XHR",
					status: 200,
					mimeType: "application/json",
				},
			],
			dispose: () => void log.push("dispose"),
		};
		return driver;
	};
}

const fakeFetch: FetchImpl = async (url) => {
	const body = url.includes("duckduckgo")
		? '<div class="result"><a class="result__a" href="https://example.dev/docs">Docs</a><a class="result__snippet">The docs</a></div>'
		: '<html><head><title>Pricing</title></head><body><p>Starter is $9</p><script src="/app.js"></script></body></html>';
	const headers = new Map([["content-type", "text/html"]]);
	return {
		ok: true,
		status: 200,
		url,
		headers: {
			get: (name: string) => headers.get(name.toLowerCase()) ?? null,
			forEach: (callback: (value: string, key: string) => void) => {
				for (const [key, value] of headers) callback(value, key);
			},
		},
		text: async () => body,
	};
};

let dir: string;
let smolt: FakeSmolt;
let handle: ResearchHandle;
let spawned: SpawnedResearcher[];
let launches: BrowseLaunchOptions[];
let browseLog: string[];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "research-ext-"));
	smolt = new FakeSmolt();
	spawned = [];
	launches = [];
	browseLog = [];
	const spawner: ResearcherSpawner = async ({ researcher, task, customTools, metricsPath }, onFinish) => {
		const record: SpawnedResearcher = {
			researcher,
			task,
			customTools,
			metricsPath,
			finish: onFinish,
			aborted: false,
			steered: [],
		};
		spawned.push(record);
		return {
			abort: async () => {
				record.aborted = true;
			},
			dispose: () => {},
			send: async (text: string) => {
				record.steered.push(text);
			},
			actions: () => 5,
			tokens: () => ({ input: 1000, output: 200, cost: 0.01 }),
			metricsSummary: () => ({
				wallMs: 1000,
				actions: 5,
				toolMs: 600,
				llmMs: 300,
				byTool: { fetch: { count: 5, ms: 600, errors: 0 } },
				slowest: [],
			}),
			currentAction: () => "fetch: https://example.dev/pricing",
		};
	};
	handle = createResearchExtension(
		smolt as unknown as ExtensionAPI,
		{ root: join(dir, "research"), clearanceTimeoutMs: 200 },
		spawner,
		fakeBrowseFactory(launches, browseLog),
		fakeFetch,
		async () => undefined,
	);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

async function command(args: string): Promise<Record<string, unknown>> {
	const ctx = fakeCtx();
	await smolt.commands.get("research")!.handler(args, ctx);
	return ctx;
}

async function runTool(
	params: Record<string, unknown>,
	ctx: Record<string, unknown> = fakeCtx(),
): Promise<Record<string, unknown>> {
	const result = await smolt.tools.get("research")!.execute("call-1", params, undefined, undefined, ctx);
	const text = result.content[0]!.text;
	try {
		return JSON.parse(text) as Record<string, unknown>;
	} catch {
		return { text };
	}
}

async function researcherTool(
	index: number,
	name: string,
	params: Record<string, unknown>,
): Promise<Record<string, unknown> & { raw: string }> {
	const tool = spawned[index]!.customTools.find((candidate) => candidate.name === name)!;
	const result = await tool.execute("c1", params, undefined, undefined, fakeCtx() as never);
	const text = (result.content[0] as { text: string }).text;
	try {
		return { ...(JSON.parse(text) as Record<string, unknown>), raw: text };
	} catch {
		return { raw: text };
	}
}

describe("/research command", () => {
	test("a counted invocation deals that many distinct angles and sends the kickoff", async () => {
		await command("3 researchers into how example.dev builds its search");
		expect(spawned.length).toBe(3);
		expect(new Set(spawned.map((researcher) => researcher.researcher.angle)).size).toBe(3);
		expect(handle.activeRun()).toContain("how-example-dev-builds");
		const kickoff = smolt.sentMessages[0]!;
		expect(kickoff).toContain("3 investigators");
		expect(kickoff).toContain("'wait'");
		expect(kickoff).toContain("'continue'");
		expect(kickoff).toContain("write_report");
	});

	test("a bare subject hands team selection to the supervisor", async () => {
		await command("how stripe.com renders its pricing table");
		expect(spawned.length).toBe(0);
		expect(smolt.sentMessages[0]).toContain("Plan a research team");
		expect(smolt.sentMessages[0]).toContain("how stripe.com renders its pricing table");
		expect(smolt.sentMessages[0]).toContain("network-sleuth");
		expect(smolt.sentMessages[0]).toContain("angles array");
	});

	test("an empty invocation asks for a subject and refuses a second concurrent run", async () => {
		const empty = await command("");
		expect(String((empty.notifications as string[])[0])).toContain("What should the team research");
		await command("2 researchers into x");
		const again = await command("2 researchers into y");
		expect(spawned.length).toBe(2);
		expect(String((again.notifications as string[])[0])).toContain("already going");
	});

	test("each brief carries the subject, the ladder, the map rules, its port, and the safety doctrine", async () => {
		await command("2 researchers into how https://example.dev/pricing loads its prices");
		const [first, second] = spawned;
		expect(first!.task).toContain(first!.researcher.name);
		expect(first!.task).toContain("THE SUBJECT\nhow https://example.dev/pricing loads its prices");
		expect(first!.task).toContain("https://example.dev/pricing — so that is where the answer lives");
		expect(first!.task).toContain("STOP AT NOTHING");
		expect(first!.task).toContain("'relaunch' with headed = true");
		expect(first!.task).toContain("sourceMappingURL");
		expect(first!.task).toContain("THE QUESTION MAP");
		expect(first!.task).toContain("port 9433");
		expect(second!.task).toContain("port 9434");
		expect(first!.task).toContain("SAFETY — JUDGE EVERY ACTION YOURSELF");
		expect(first!.task).toContain("Solving, bypassing, or automating past CAPTCHAs");
		expect(first!.task).toContain("Never modify this project's source");
		expect(extractTargetUrls(first!.task).length).toBeGreaterThan(0);
	});

	test("a supervisor-picked team seeds the question map and appears in the briefs", async () => {
		const unknown = await runTool({ action: "start", subject: "y", angles: ["generalist"] });
		expect(String(unknown.text)).toContain("Unknown angle 'generalist'");
		expect(spawned.length).toBe(0);
		const result = await runTool({
			action: "start",
			subject: "how example.dev builds its search",
			angles: ["source-diver: the search bundle", "network sleuth"],
			questions: ["Which endpoint serves search results?", "Is there a client-side index?"],
			notes: "We already know it is a Next.js app",
		});
		expect(String(result.text ?? "")).toContain("2 researcher(s) dispatched");
		expect(spawned[0]!.researcher.angle).toBe("source-diver");
		expect(spawned[0]!.task).toContain("especially the search bundle");
		expect(spawned[1]!.researcher.angle).toBe("network-sleuth");
		expect(spawned[0]!.task).toContain("TAKEABLE NOW");
		expect(spawned[0]!.task).toContain("Which endpoint serves search results?");
		expect(spawned[0]!.task).toContain("We already know it is a Next.js app");
	});

	test("stop aborts running researchers and marks the run stopped", async () => {
		await command("2 researchers into x");
		const ctx = await command("stop");
		expect(spawned.every((researcher) => researcher.aborted)).toBe(true);
		expect(String((ctx.notifications as string[])[0])).toContain("Stopped 2");
		expect(handle.researchers().every((slot) => slot.status === "stopped")).toBe(true);
	});
});

describe("researcher tools", () => {
	test("notebook files findings with sources, bounces near-duplicates, and works the question map", async () => {
		await command("2 researchers into x");
		const filed = await researcherTool(0, "notebook", {
			action: "finding",
			title: "Prices come from /api/prices",
			confidence: "confirmed",
			kind: "mechanism",
			topic: "pricing",
			what: "The table is filled from a JSON call",
			evidence: "GET /api/prices 200",
			sources: ["https://example.dev/pricing"],
		});
		expect(filed.success).toBe(true);
		const bounced = await researcherTool(1, "notebook", {
			action: "finding",
			title: "The prices come from api/prices",
			topic: "pricing",
			what: "Same thing",
		});
		expect(bounced.success).toBe(false);
		expect(bounced.duplicate_of).toBe(filed.finding);
		const appended = await researcherTool(1, "notebook", {
			action: "append",
			finding: String(filed.finding),
			text: "Also cached 60s",
		});
		expect(appended.success).toBe(true);
		const unsourced = await researcherTool(1, "notebook", {
			action: "finding",
			title: "Something else entirely",
			topic: "cdn",
			what: "Served by a CDN",
		});
		expect(unsourced.success).toBe(true);
		expect(String((unsourced.warnings as string[])[0])).toContain("No sources");

		const asked = await researcherTool(0, "notebook", {
			action: "question",
			title: "Is the price list cached at the edge?",
			text: "Where is it cached?",
		});
		expect(asked.success).toBe(true);
		const claimed = await researcherTool(0, "notebook", { action: "claim", question: String(asked.question) });
		expect(claimed.success).toBe(true);
		const contested = await researcherTool(1, "notebook", { action: "claim", question: String(asked.question) });
		expect(contested.success).toBe(false);
		const answered = await researcherTool(0, "notebook", {
			action: "answer",
			question: String(asked.question),
			answer: "Yes: cache-control: s-maxage=60 on https://example.dev/api/prices",
			gist: "Edge-cached for 60s",
		});
		expect(answered.success).toBe(true);
		const view = await runTool({ action: "view_question", question: String(asked.question) });
		expect(view.status).toBe("answered");
		expect(view.gist).toBe("Edge-cached for 60s");
		const notes = readFileSync(
			join(dir, "research", handle.activeRun()!, "notes", `${spawned[0]!.researcher.slug}.md`),
			"utf-8",
		);
		expect(notes).toContain("Answered [");
	});

	test("browse reads rendered text and network requests, relaunches visible, and screenshots navigation", async () => {
		await command("1 researcher into x");
		const early = await researcherTool(0, "browse", { action: "text" });
		expect(early.raw).toContain("No page open yet");
		const tool = spawned[0]!.customTools.find((candidate) => candidate.name === "browse")!;
		const gone = await tool.execute(
			"c1",
			{ action: "goto", url: "https://example.dev/pricing" },
			undefined,
			undefined,
			fakeCtx() as never,
		);
		expect(launches[0]!.headed).toBeFalsy();
		expect(launches[0]!.captureNetwork).toBe(true);
		expect(gone.content.some((block) => block.type === "image")).toBe(true);
		expect((gone.content[0] as { text: string }).text).toContain("https://example.dev/pricing — Pricing");
		const text = await researcherTool(0, "browse", { action: "text" });
		expect(text.raw).toContain("Rendered pricing table");
		const network = await researcherTool(0, "browse", { action: "network" });
		expect(network.raw).toContain("GET https://example.dev/api/prices — 200 XHR");
		const relaunched = await researcherTool(0, "browse", { action: "relaunch", headed: true });
		expect(relaunched.raw).toContain("visible window");
		expect(launches[1]!.headed).toBe(true);
		expect(launches[1]!.userDataDir).toBe(launches[0]!.userDataDir);
		expect(browseLog).toContain("dispose");
	});

	test("fetch and search run through the injected fetch", async () => {
		await command("1 researcher into x");
		const page = await researcherTool(0, "fetch", { url: "https://example.dev/pricing" });
		expect(page.raw).toContain("HTTP 200 https://example.dev/pricing");
		expect(page.raw).toContain("Starter is $9");
		const scripts = await researcherTool(0, "fetch", { url: "https://example.dev/pricing", as: "scripts" });
		expect(scripts.raw).toContain("https://example.dev/app.js");
		const found = await researcherTool(0, "search", { query: "example.dev docs" });
		expect(found.raw).toContain("via duckduckgo");
		expect(found.raw).toContain("https://example.dev/docs");
	});
});

describe("wait, waves, and synthesis", () => {
	test("wait reports new findings and closed questions, then hands off to synthesis", async () => {
		await command("2 researchers into x");
		await researcherTool(0, "notebook", {
			action: "finding",
			title: "A fact",
			topic: "t",
			what: "w",
			sources: ["https://a"],
		});
		await researcherTool(0, "notebook", { action: "question", title: "Q one?" });
		const first = await runTool({ action: "wait", seconds: 1 });
		expect(String(first.text)).toContain("2 of 2 researchers still going");
		expect(String(first.text)).toContain("NEW FINDINGS");
		expect(String(first.text)).toContain("A fact");
		expect(String(first.text)).toContain("QUESTION MAP: 0 answered");
		await researcherTool(1, "notebook", {
			action: "answer",
			question: "q-one",
			answer: "Because https://a says so",
			gist: "Because",
		});
		spawned[0]!.finish("completed", "Found the mechanism.");
		spawned[1]!.finish("completed", "Verified it.");
		const done = await runTool({ action: "wait", seconds: 1 });
		expect(String(done.text)).toContain("All 2 researchers have finished");
		expect(String(done.text)).toContain("QUESTIONS CLOSED");
		expect(String(done.text)).toContain("Found the mechanism.");
		expect(String(done.text)).toContain("Now synthesize");
		const run = handle.activeRun()!;
		const performance = JSON.parse(readFileSync(join(dir, "research", run, "performance.json"), "utf-8")) as {
			best: string;
			researchers: { slug: string; points: number }[];
		};
		expect(performance.best).toBe(spawned[1]!.researcher.slug);
		expect(existsSync(join(dir, "research", "form.jsonl"))).toBe(true);
	});

	test("a finished wave with open questions is told to continue, and continue dispatches wave 2 with fresh slugs", async () => {
		await command("1 researcher into x");
		await researcherTool(0, "notebook", { action: "question", title: "Still open?" });
		spawned[0]!.finish("completed", "Ran out of budget.");
		const done = await runTool({ action: "wait", seconds: 1 });
		expect(String(done.text)).toContain("dispatching the next wave with action 'continue'");
		const run = handle.activeRun()!;
		const next = await runTool({ action: "continue", angles: ["verifier: the open question", "historian"] });
		expect(String(next.text)).toContain("Next wave dispatched");
		expect(spawned.length).toBe(3);
		expect(spawned[1]!.researcher.angle).toBe("verifier");
		expect(spawned[2]!.task).toContain("TAKEABLE NOW");
		expect(spawned[2]!.task).toContain("Still open?");
		expect(new Set(spawned.map((researcher) => researcher.researcher.slug)).size).toBe(3);
		expect(smolt.sentMessages.at(-1)).toContain("Wave 2 of research run");
		const view = await runTool({ action: "view", run });
		expect(view.wave).toBe(2);
		expect((view.researchers as unknown[]).length).toBe(3);
	});

	test("continue refuses when nothing is open, and after the report is written the run is complete", async () => {
		await command("1 researcher into x");
		spawned[0]!.finish("completed", "done");
		const refused = await runTool({ action: "continue" });
		expect(String(refused.text)).toContain("No open questions remain");
		const written = await runTool({ action: "write_report", content: "## Answer\n\nIt is Next.js." });
		expect(written.success).toBe(true);
		const list = await runTool({ action: "list" });
		expect((list.runs as { status: string; report: boolean }[])[0]).toMatchObject({
			status: "complete",
			report: true,
		});
	});

	test("a fresh session is told nothing about earlier runs unless it asks", async () => {
		await command("1 researcher into reddit saas pain points");
		spawned[0]!.finish("completed", "done");
		await runTool({ action: "write_report", content: "## Answer\n\nSome." });
		// A new session in the same project: no orientation block rides its system prompt.
		await smolt.fire("session_start", {}, fakeCtx());
		expect(smolt.handlers.has("before_agent_start")).toBe(false);
		const list = await runTool({ action: "list" });
		expect((list.runs as unknown[]).length).toBe(1);
	});

	test("the settle safety net sends the synthesis prompt once the wave finishes idle", async () => {
		await command("1 researcher into x");
		smolt.sentMessages.length = 0;
		spawned[0]!.finish("completed", "done");
		await smolt.fire("agent_settled", {}, fakeCtx());
		expect(smolt.sentMessages.length).toBe(1);
		expect(smolt.sentMessages[0]).toContain("have finished while you were idle");
		await smolt.fire("agent_settled", {}, fakeCtx());
		expect(smolt.sentMessages.length).toBe(1);
	});

	test("clearance pauses the researcher until the supervisor rules, and wait surfaces it", async () => {
		await command("1 researcher into x");
		const pending = researcherTool(0, "notebook", {
			action: "clearance",
			topic: "pricing",
			text: "POST to the public quote API",
			risk: "might create a quote",
		});
		const seen = await runTool({ action: "wait", seconds: 5 });
		expect(String(seen.text)).toContain("clearance request(s) pending");
		expect(String(seen.text)).toContain("POST to the public quote API");
		const ruled = await runTool({
			action: "decide",
			clearance: "c1",
			verdict: "deny",
			guidance: "Read the docs instead.",
		});
		expect(ruled.success).toBe(true);
		const verdict = await pending;
		expect(verdict.allowed).toBe(false);
		expect(verdict.guidance).toBe("Read the docs instead.");
	});

	test("the roster widget names the researcher, the counts, and what they are doing", async () => {
		await command("1 researcher into x");
		await researcherTool(0, "notebook", {
			action: "finding",
			title: "A fact",
			topic: "t",
			what: "w",
			sources: ["https://a"],
		});
		const ctx = fakeCtx();
		await runTool({ action: "wait", seconds: 1 }, ctx);
		const line = (ctx.widget as string[])[0]!;
		expect(line).toContain(`${spawned[0]!.researcher.name} (${spawned[0]!.researcher.angle})`);
		expect(line).toContain("5 actions");
		expect(line).toContain("1 finding");
		expect(line).toContain("fetching example.dev/pricing");
		expect(String(ctx.status)).toContain("research: 1/1 researching, 1 findings");
		const details = ctx.widgetDetails as { testers: { tickets: string[] }[] };
		expect(details.testers[0]!.tickets[0]).toContain("A fact");
	});
});
