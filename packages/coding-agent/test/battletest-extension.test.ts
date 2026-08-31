import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "../src/core/extensions/types.ts";
import type { BrowseDriver, BrowseDriverFactory, BrowseLaunchOptions } from "../src/extensions/battletest/cdp.ts";
import {
	type BattleTestHandle,
	createBattleTestExtension,
	extractTargetUrl,
	type TesterSpawner,
} from "../src/extensions/battletest/index.ts";

/**
 * Wiring tests for the battletest extension: the /battletest command's run
 * dispatch, the tester lifecycle through a fake spawner, the testlog tool
 * each tester is handed, the wait action, and the settle-time synthesis
 * safety net.
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
		// Empty catalog: NL parsing keeps everything in the focus, so command
		// tests that pass prose through are unaffected. Model-override tests
		// swap this stub for one carrying models.
		modelRegistry: {
			getAll: () => [],
			getAvailable: () => [],
			hasConfiguredAuth: () => false,
		},
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus: () => {},
			setWidget: (_key: string, content: string[] | undefined, options?: { details?: unknown }) => {
				ctx.widget = content;
				ctx.widgetDetails = options?.details;
			},
		},
	};
	return ctx;
}

interface SpawnedTester {
	persona: { slug: string; name: string; archetype: string };
	task: string;
	customTools: ToolDefinition[];
	metricsPath?: string;
	model?: unknown;
	thinkingLevel?: unknown;
	finish: (status: "completed" | "errored", detail: string) => void;
	aborted: boolean;
	steered: string[];
}

/** A pretend browser: records calls, returns a fixed screenshot. */
function fakeBrowseFactory(launches: BrowseLaunchOptions[], log: string[]): BrowseDriverFactory {
	return async (options) => {
		launches.push(options);
		const driver: BrowseDriver = {
			goto: async (url) => void log.push(`goto ${url}`),
			clickSelector: async (selector) => {
				log.push(`click ${selector}`);
				return "Get started";
			},
			clickAt: async (x, y) => void log.push(`clickAt ${x},${y}`),
			type: async (text) => void log.push(`type ${text}`),
			press: async (key) => void log.push(`press ${key}`),
			scroll: async (dy) => void log.push(`scroll ${dy}`),
			eval: async () => '"42"',
			setViewport: async (viewport) => void log.push(`viewport ${viewport.width}x${viewport.height}`),
			screenshot: async () => "aGVsbG8=",
			state: async () => ({ url: "https://example.dev/", title: "Example", console: ["console.error: boom"] }),
			dispose: () => void log.push("dispose"),
		};
		return driver;
	};
}

let dir: string;
let smolt: FakeSmolt;
let handle: BattleTestHandle;
let spawned: SpawnedTester[];
let launches: BrowseLaunchOptions[];
let browseLog: string[];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "battletest-ext-"));
	smolt = new FakeSmolt();
	spawned = [];
	launches = [];
	browseLog = [];
	const spawner: TesterSpawner = async (
		{ persona, task, customTools, metricsPath, model, thinkingLevel },
		onFinish,
	) => {
		const record: SpawnedTester = {
			persona,
			task,
			customTools,
			metricsPath,
			model,
			thinkingLevel,
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
			metricsSummary: () => ({
				wallMs: 1000,
				actions: 7,
				toolMs: 600,
				llmMs: 300,
				byTool: { browse: { count: 7, ms: 600, errors: 0 } },
				slowest: [],
			}),
			currentAction: () => "browse: goto https://example.dev",
		};
	};
	handle = createBattleTestExtension(
		smolt as unknown as ExtensionAPI,
		{ root: join(dir, "battletest") },
		spawner,
		fakeBrowseFactory(launches, browseLog),
	);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

async function startRun(args: string): Promise<Record<string, unknown>> {
	const ctx = fakeCtx();
	await smolt.commands.get("battletest")!.handler(args, ctx);
	return ctx;
}

async function runTool(
	params: Record<string, unknown>,
	ctx: Record<string, unknown> = fakeCtx(),
): Promise<Record<string, unknown>> {
	const result = await smolt.tools.get("battletest")!.execute("call-1", params, undefined, undefined, ctx);
	const text = result.content[0]!.text;
	try {
		return JSON.parse(text) as Record<string, unknown>;
	} catch {
		return { text };
	}
}

describe("/battletest command", () => {
	test("spawns the requested number of testers with distinct personas", async () => {
		await startRun("4");
		expect(spawned.length).toBe(4);
		expect(new Set(spawned.map((tester) => tester.persona.archetype)).size).toBe(4);
		expect(new Set(spawned.map((tester) => tester.persona.slug)).size).toBe(4);
		expect(handle.activeRun()).toBeDefined();
	});

	test("sends a kickoff prompt naming the team and the wait loop", async () => {
		await startRun("2");
		expect(smolt.sentMessages.length).toBe(1);
		const kickoff = smolt.sentMessages[0]!;
		expect(kickoff).toContain("2 simulated users");
		expect(kickoff).toContain("'wait'");
		expect(kickoff).toContain("write_report");
		for (const tester of spawned) expect(kickoff).toContain(tester.persona.name);
	});

	test("each tester's task carries its persona, isolation, and the hard rules", async () => {
		await startRun("2 the onboarding flow");
		const [first, second] = spawned;
		expect(first!.task).toContain(first!.persona.name);
		expect(first!.task).toContain("pay particular attention to: the onboarding flow");
		expect(first!.task).toContain("Never modify the app's source");
		expect(first!.task).toContain("9333");
		expect(second!.task).toContain("9334");
	});

	test("the safety doctrine is in every tester's brief", async () => {
		await startRun("2");
		for (const tester of spawned) {
			expect(tester.task).toContain("SAFETY — JUDGE EVERY ACTION YOURSELF, NEVER ASK");
			expect(tester.task).toContain("Buying anything");
			expect(tester.task).toContain("Deleting, wiping, or corrupting");
		}
	});

	test("viewports reach the tester briefs: desktop first, mobile second", async () => {
		await startRun("2");
		expect(spawned[0]!.task).toContain("desktop-sized screen");
		expect(spawned[1]!.task).toContain("375x812");
		expect(spawned[1]!.task).toContain("setDeviceMetricsOverride");
	});

	test("testers are told to study the screenshots browse returns", async () => {
		await startRun("1");
		expect(spawned[0]!.task).toContain("SEE IT LIKE A USER");
		expect(spawned[0]!.task).toContain("Every browse action returns a screenshot");
		expect(spawned[0]!.task).toContain("STUDY each one");
	});

	test("a hosted target in the focus routes testers at it instead of a local launch", async () => {
		await startRun("1 test the live site at https://example.dev");
		expect(spawned[0]!.task).toContain("'goto' to https://example.dev");
		expect(spawned[0]!.task).toContain("launch nothing locally");
	});

	test("rejects a count beyond the cap and refuses a second concurrent run", async () => {
		const ctx = await startRun("50");
		expect(spawned.length).toBe(0);
		expect(String((ctx.notifications as string[])[0])).toContain("between 1 and");
		await startRun("2");
		const again = await startRun("2");
		expect(spawned.length).toBe(2);
		expect(String((again.notifications as string[])[0])).toContain("already going");
	});

	test("a bare /battletest asks the supervisor to size the team", async () => {
		await startRun("");
		expect(spawned.length).toBe(0);
		expect(smolt.sentMessages[0]).toContain("Plan a battletest team");
		expect(smolt.sentMessages[0]).toContain("specialists");
	});

	test("a supervisor-picked team is a generalist plus its specialists", async () => {
		const result = await runTool({ action: "start", specialists: ["keyboard-only accessibility"] });
		expect(String(result.text ?? "")).toContain("2 testers");
		expect(spawned.length).toBe(2);
		expect(spawned[0]!.persona.archetype).toBe("generalist");
		expect(spawned[1]!.persona.archetype).toBe("specialist");
	});

	test("a finished run records every tester's form and the best performer", async () => {
		await startRun("2");
		const testlog = spawned[0]!.customTools.find((tool) => tool.name === "testlog")!;
		await testlog.execute(
			"c1",
			{
				action: "ticket",
				area: "nav",
				title: "Menu traps focus",
				severity: "major",
				category: "accessibility",
				what: "Tabbed into the menu; could not tab out.",
				expected: "Focus escapes the menu.",
				steps: "Open menu, press Tab repeatedly.",
			},
			undefined,
			undefined,
			fakeCtx() as never,
		);
		spawned[0]!.finish("completed", "done");
		spawned[1]!.finish("completed", "done");
		const run = handle.activeRun()!;
		const performance = JSON.parse(readFileSync(join(dir, "battletest", run, "performance.json"), "utf-8")) as {
			best: string;
			testers: { slug: string; points: number; brief: string }[];
		};
		expect(performance.best).toBe(spawned[0]!.persona.slug);
		expect(performance.testers.length).toBe(2);
		expect(performance.testers[0]!.points).toBe(4);
		expect(performance.testers[0]!.brief).toContain(spawned[0]!.persona.name);
		expect(existsSync(join(dir, "battletest", "form.jsonl"))).toBe(true);
	});

	test("stop aborts running testers", async () => {
		await startRun("2");
		const ctx = await startRun("stop");
		expect(spawned.every((tester) => tester.aborted)).toBe(true);
		expect(String((ctx.notifications as string[])[0])).toContain("Stopped 2");
		expect(handle.testers().every((tester) => tester.status === "stopped")).toBe(true);
	});
});

describe("testlog tool given to testers", () => {
	test("notes and tickets land in the run, attributed to the persona", async () => {
		const runCtx = await startRun("1");
		const tester = spawned[0]!;
		const testlog = tester.customTools.find((tool) => tool.name === "testlog")!;
		await testlog.execute(
			"c1",
			{ action: "note", area: "launch", text: "Took two tries to find the run script." },
			undefined,
			undefined,
			fakeCtx() as never,
		);
		const ticketResult = await testlog.execute(
			"c2",
			{
				action: "ticket",
				area: "settings",
				title: "Save button never enables",
				severity: "major",
				category: "bug",
				what: "Changed the theme; Save stayed greyed out.",
				expected: "Save enables after any change.",
				steps: "Open settings, change theme, look at Save.",
			},
			undefined,
			undefined,
			fakeCtx() as never,
		);
		expect(JSON.parse((ticketResult as { content: { text: string }[] }).content[0]!.text).success).toBe(true);
		const view = await runTool({ action: "view" });
		expect((view.open_tickets as { persona: string }[])[0]!.persona).toBe(tester.persona.slug);
		expect((view.notes as { exists: boolean }[]).some((entry) => entry.exists)).toBe(true);
		// No toast per ticket — the roster's widget details carry the list instead.
		expect((runCtx.notifications as string[]).some((line) => line.includes("Save button never enables"))).toBe(false);
		const details = runCtx.widgetDetails as { testers: { tickets: string[] }[] };
		expect(details.testers[0]!.tickets[0]).toContain("[major/bug] Save button never enables — settings");
	});

	test("a second tester hitting the same bug is bounced to the original and can chip in", async () => {
		await startRun("2");
		const [first, second] = spawned;
		const fields = {
			severity: "major",
			category: "bug",
			what: "Clicked Save; nothing happened.",
			expected: "The change is saved.",
			steps: "Open settings, change anything, click Save.",
		};
		const firstLog = first!.customTools.find((tool) => tool.name === "testlog")!;
		const filed = await firstLog.execute(
			"c1",
			{ action: "ticket", area: "settings", title: "Save button does nothing", ...fields },
			undefined,
			undefined,
			fakeCtx() as never,
		);
		const filedParsed = JSON.parse((filed as { content: { text: string }[] }).content[0]!.text);
		expect(filedParsed.success).toBe(true);

		const secondLog = second!.customTools.find((tool) => tool.name === "testlog")!;
		const bounced = await secondLog.execute(
			"c2",
			{ action: "ticket", area: "Settings", title: "The save button does nothing at all", ...fields },
			undefined,
			undefined,
			fakeCtx() as never,
		);
		const bouncedParsed = JSON.parse((bounced as { content: { text: string }[] }).content[0]!.text);
		expect(bouncedParsed.success).toBe(false);
		expect(bouncedParsed.duplicate_of).toBe(filedParsed.ticket);
		expect(bouncedParsed.filed_by).toBe(first!.persona.slug);
		expect(String(bouncedParsed.message)).toContain("move on");

		// Chip in on the original instead of refiling.
		const appended = await secondLog.execute(
			"c3",
			{ action: "append", area: "settings", ticket: filedParsed.ticket, text: "Also broken on mobile width." },
			undefined,
			undefined,
			fakeCtx() as never,
		);
		expect(JSON.parse((appended as { content: { text: string }[] }).content[0]!.text).success).toBe(true);
		const view = await runTool({ action: "view_ticket", ticket: filedParsed.ticket });
		expect(String(view.alsoSeen)).toContain(second!.persona.slug);
		expect(String(view.alsoSeen)).toContain("Also broken on mobile width.");
		// Only the one ticket exists.
		const full = await runTool({ action: "view" });
		expect((full.open_tickets as unknown[]).length).toBe(1);

		// A genuinely different problem still files with force.
		const forced = await secondLog.execute(
			"c4",
			{ action: "ticket", area: "Settings", title: "Save button mislabeled as Sav", ...fields, force: true },
			undefined,
			undefined,
			fakeCtx() as never,
		);
		expect(JSON.parse((forced as { content: { text: string }[] }).content[0]!.text).success).toBe(true);
	});

	test("a ticket missing its fields is refused with the list", async () => {
		await startRun("1");
		const testlog = spawned[0]!.customTools.find((tool) => tool.name === "testlog")!;
		const result = await testlog.execute(
			"c1",
			{ action: "ticket", area: "settings", title: "Half a ticket" },
			undefined,
			undefined,
			fakeCtx() as never,
		);
		const parsed = JSON.parse((result as { content: { text: string }[] }).content[0]!.text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain("steps");
	});
});

describe("browse tool", () => {
	test("goto lazily launches a viewport-locked browser and returns text plus a screenshot", async () => {
		await startRun("2");
		const mobileTester = spawned[1]!;
		const browse = mobileTester.customTools.find((tool) => tool.name === "browse")!;
		const notReady = await browse.execute(
			"b0",
			{ action: "click", selector: "a" },
			undefined,
			undefined,
			fakeCtx() as never,
		);
		expect((notReady as { content: { text?: string }[] }).content[0]!.text).toContain("goto");
		expect(launches.length).toBe(0);
		const result = (await browse.execute(
			"b1",
			{ action: "goto", url: "https://example.dev" },
			undefined,
			undefined,
			fakeCtx() as never,
		)) as { content: { type: string; text?: string; mimeType?: string }[] };
		expect(launches.length).toBe(1);
		expect(launches[0]!.viewport.width).toBe(375);
		expect(launches[0]!.viewport.mobile).toBe(true);
		expect(result.content[0]!.text).toContain("https://example.dev/ — Example");
		expect(result.content[0]!.text).toContain("console.error: boom");
		expect(result.content[1]!.type).toBe("image");
		expect(result.content[1]!.mimeType).toBe("image/jpeg");
	});

	test("click by selector reports what was clicked; eval returns text only", async () => {
		await startRun("1");
		const browse = spawned[0]!.customTools.find((tool) => tool.name === "browse")!;
		await browse.execute(
			"b1",
			{ action: "goto", url: "https://example.dev" },
			undefined,
			undefined,
			fakeCtx() as never,
		);
		const clicked = (await browse.execute(
			"b2",
			{ action: "click", selector: ".cta" },
			undefined,
			undefined,
			fakeCtx() as never,
		)) as { content: { text?: string }[] };
		expect(clicked.content[0]!.text).toContain('clicked "Get started"');
		const evaluated = (await browse.execute(
			"b3",
			{ action: "eval", js: "6*7" },
			undefined,
			undefined,
			fakeCtx() as never,
		)) as { content: { type: string }[] };
		expect(evaluated.content.length).toBe(1);
	});

	test("a finished tester's browser is disposed", async () => {
		await startRun("1");
		const browse = spawned[0]!.customTools.find((tool) => tool.name === "browse")!;
		await browse.execute(
			"b1",
			{ action: "goto", url: "https://example.dev" },
			undefined,
			undefined,
			fakeCtx() as never,
		);
		spawned[0]!.finish("completed", "done");
		expect(browseLog).toContain("dispose");
	});
});

describe("wrap_up and coverage", () => {
	test("wrap_up steers all still-running testers", async () => {
		await startRun("3");
		spawned[0]!.finish("completed", "done early");
		const result = await runTool({ action: "wrap_up" });
		expect(String(result.text)).toContain("2 tester(s)");
		expect(spawned[0]!.steered.length).toBe(0);
		expect(spawned[1]!.steered[0]).toContain("time is up");
		expect(spawned[2]!.steered.length).toBe(1);
	});

	test("widget lines put counters first and the live action at the end", async () => {
		const ctx = await startRun("2");
		const widget = ctx.widget as string[];
		expect(widget.length).toBe(2);
		for (const line of widget) {
			// The raw "browse: goto https://example.dev" is humanized for the roster.
			expect(line).toMatch(/\d+ actions? · \d+ tickets? · opening example\.dev$/);
		}
		spawned[0]!.finish("completed", "done");
		const after = fakeCtx();
		await smolt.fire("agent_settled", {}, after);
		expect((after.widget as string[])[0]).toMatch(/completed$/);
	});

	test("actions are classified into short labels by the injected labeler", async () => {
		const local = new FakeSmolt();
		const raw = 'bash: grep -ri "battletest" C:/repo';
		const spawner: TesterSpawner = async (_options, _onFinish) => ({
			abort: async () => {},
			dispose: () => {},
			actions: () => 3,
			currentAction: () => raw,
			recentActions: () => [raw],
		});
		const labeled: string[] = [];
		createBattleTestExtension(
			local as unknown as ExtensionAPI,
			{ root: join(dir, "battletest-labeled") },
			spawner,
			fakeBrowseFactory([], []),
			async (input) => {
				labeled.push(input);
				return "searching the repo for battletest";
			},
		);
		const ctx = fakeCtx();
		await local.commands.get("battletest")!.handler("1", ctx);
		// The first paint shows the heuristic line; the label lands async,
		// repaints, and every later paint serves it from the cache.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(labeled).toContain(raw);
		expect((ctx.widget as string[])[0]).toMatch(/searching the repo for battletest$/);
	});

	test("without a target URL the brief covers web, desktop, CLI, and library projects", async () => {
		await startRun("1");
		const task = spawned[0]!.task;
		expect(task).toContain("not just for the web");
		expect(task).toContain("CLI or TUI");
		expect(task).toContain("Library, API, or SDK");
		expect(task).toContain("its user is a developer");
	});

	test("briefs carry the target URL, territory slice, and action budget", async () => {
		await startRun("2 check https://smolt.dev please");
		expect(extractTargetUrl("check https://smolt.dev please")).toBe("https://smolt.dev");
		for (const tester of spawned) {
			expect(tester.task).toContain("'goto' to https://smolt.dev");
			expect(tester.task).toContain("YOUR COVERAGE PLAN AND BUDGET");
			expect(tester.task).toMatch(/budget is about \d+ browse actions/);
		}
		expect(spawned[0]!.task).toContain("tester #1 of 2");
		expect(spawned[1]!.task).toContain("tester #2 of 2");
	});
});

describe("clearance", () => {
	/** Fires the clearance call and returns the UNawaited verdict promise — awaiting it before 'decide' would deadlock. */
	function requestClearance(text: string): Promise<Record<string, unknown>> {
		const testlog = spawned[0]!.customTools.find((tool) => tool.name === "testlog")!;
		return testlog
			.execute(
				"c-clr",
				{ action: "clearance", area: "checkout", text, risk: "might order something real" },
				undefined,
				undefined,
				fakeCtx() as never,
			)
			.then((result) => JSON.parse((result as { content: { text: string }[] }).content[0]!.text));
	}

	test("wait surfaces the request, decide allow unblocks the tester", async () => {
		await startRun("1");
		const pending = requestClearance("press the 'start free trial' button");
		const waited = await runTool({ action: "wait", seconds: 30 });
		expect(String(waited.text)).toContain("clearance request(s) pending");
		expect(String(waited.text)).toContain("[c1]");
		expect(String(waited.text)).toContain("start free trial");
		const decided = await runTool({
			action: "decide",
			clearance: "c1",
			verdict: "allow",
			guidance: "Trial page only, no card details.",
		});
		expect(decided.success).toBe(true);
		const verdict = await pending;
		expect(verdict.allowed).toBe(true);
		expect(verdict.guidance).toBe("Trial page only, no card details.");
	});

	test("decide deny is delivered and the ruling lands in the diary", async () => {
		await startRun("1");
		const pending = requestClearance("delete the demo workspace");
		await runTool({ action: "wait", seconds: 30 });
		await runTool({ action: "decide", clearance: "c1", verdict: "deny" });
		const verdict = await pending;
		expect(verdict.allowed).toBe(false);
		const view = await runTool({ action: "view" });
		expect((view.notes as { exists: boolean }[]).some((entry) => entry.exists)).toBe(true);
	});

	test("an unanswered request denies itself after the timeout", async () => {
		const local = new FakeSmolt();
		const localSpawned: SpawnedTester[] = [];
		const spawner: TesterSpawner = async ({ persona, task, customTools }, onFinish) => {
			localSpawned.push({ persona, task, customTools, finish: onFinish, aborted: false, steered: [] });
			return { abort: async () => {}, dispose: () => {} };
		};
		createBattleTestExtension(
			local as unknown as ExtensionAPI,
			{ root: join(dir, "battletest-timeout"), clearanceTimeoutMs: 50 },
			spawner,
		);
		await local.commands.get("battletest")!.handler("1", fakeCtx());
		const testlog = localSpawned[0]!.customTools.find((tool) => tool.name === "testlog")!;
		const result = await testlog.execute(
			"c-clr",
			{ action: "clearance", area: "settings", text: "poke the dragon", risk: "dragons" },
			undefined,
			undefined,
			fakeCtx() as never,
		);
		const verdict = JSON.parse((result as { content: { text: string }[] }).content[0]!.text);
		expect(verdict.allowed).toBe(false);
		expect(String(verdict.guidance)).toContain("denied");
	});

	test("decide on an unknown id names the pending ones", async () => {
		await startRun("1");
		void requestClearance("anything");
		await new Promise((resolve) => setTimeout(resolve, 10));
		const result = await runTool({ action: "decide", clearance: "c9", verdict: "allow" });
		expect(result.success).toBe(false);
		expect(String(result.error)).toContain("c1");
		await runTool({ action: "decide", clearance: "c1", verdict: "deny" });
	});
});

describe("wait and synthesis", () => {
	test("every tester gets a metrics path inside the run, and finishing writes the summary", async () => {
		await startRun("2");
		for (const tester of spawned) {
			expect(tester.metricsPath).toContain("metrics");
			expect(tester.metricsPath).toContain(tester.persona.slug);
		}
		spawned[0]!.finish("completed", "done");
		const view = await runTool({ action: "view" });
		expect((view.metrics_summaries as string[]).length).toBe(1);
		expect((view.metrics_summaries as string[])[0]).toContain(spawned[0]!.persona.slug);
	});

	test("wait digests deltas: new tickets reported once, then quiet", async () => {
		await startRun("1");
		const testlog = spawned[0]!.customTools.find((tool) => tool.name === "testlog")!;
		await testlog.execute(
			"t1",
			{
				action: "ticket",
				area: "nav",
				title: "Menu traps focus",
				severity: "major",
				category: "accessibility",
				what: "w",
				expected: "e",
				steps: "s",
			},
			undefined,
			undefined,
			fakeCtx() as never,
		);
		const first = await runTool({ action: "wait", seconds: 1 });
		expect(String(first.text)).toContain("NEW FINDINGS since the last check");
		expect(String(first.text)).toContain("[major/accessibility] Menu traps focus");
		expect(String(first.text)).toContain("progress update");
		const second = await runTool({ action: "wait", seconds: 1 });
		expect(String(second.text)).toContain("No new tickets since the last check");
	});

	test("wait reports testers still going, then the finished roster", async () => {
		await startRun("2");
		const pending = await runTool({ action: "wait", seconds: 1 });
		expect(String(pending.text)).toContain("2 of 2 testers still going");
		expect(String(pending.text)).toContain("7 actions · tool 1s · llm 0s");
		spawned[0]!.finish("completed", "Nice app, three tickets.");
		spawned[1]!.finish("errored", "provider fell over");
		const done = await runTool({ action: "wait", seconds: 1 });
		expect(String(done.text)).toContain("All 2 testers have finished");
		expect(String(done.text)).toContain("Nice app, three tickets.");
		expect(String(done.text)).toContain("provider fell over");
	});

	test("agent_settled sends the synthesis prompt when a run finished unattended", async () => {
		await startRun("1");
		smolt.sentMessages.length = 0;
		spawned[0]!.finish("completed", "done");
		await smolt.fire("agent_settled", {}, fakeCtx());
		expect(smolt.sentMessages.length).toBe(1);
		expect(smolt.sentMessages[0]).toContain("Synthesize run");
		// Once sent, it is not sent again.
		await smolt.fire("agent_settled", {}, fakeCtx());
		expect(smolt.sentMessages.length).toBe(1);
	});

	test("a completed wait disarms the settle safety net", async () => {
		await startRun("1");
		spawned[0]!.finish("completed", "done");
		await runTool({ action: "wait", seconds: 1 });
		smolt.sentMessages.length = 0;
		await smolt.fire("agent_settled", {}, fakeCtx());
		expect(smolt.sentMessages.length).toBe(0);
	});
});

describe("start and resume", () => {
	/** Writes metric rows for a tester, the way the real metrics sink would have. */
	function logActions(tester: SpawnedTester, toolRows: number, llmRows: number): void {
		if (!tester.metricsPath) throw new Error("no metrics path");
		mkdirSync(dirname(tester.metricsPath), { recursive: true });
		for (let index = 0; index < toolRows; index++) {
			appendFileSync(
				tester.metricsPath,
				`{"at":"2026-08-30T23:00:0${index}.000Z","kind":"tool","tool":"browse","ms":100,"ok":true}\n`,
			);
		}
		for (let index = 0; index < llmRows; index++) {
			appendFileSync(tester.metricsPath, `{"at":"2026-08-30T23:00:10.000Z","kind":"llm","ms":500}\n`);
		}
	}

	test("start dispatches a run from the tool with count and focus", async () => {
		const result = await runTool({ action: "start", count: 2, focus: "the desktop app" });
		expect(String(result.text)).toContain("started");
		expect(spawned.length).toBe(2);
		expect(spawned[0]!.task).toContain("pay particular attention to: the desktop app");
		expect(smolt.sentMessages[0]).toContain("has started");
	});

	test("resume re-spawns the recorded personas, primed with diary, tickets, and remaining budget", async () => {
		await startRun("2");
		const originalSlugs = spawned.map((tester) => tester.persona.slug);
		const testlog = spawned[0]!.customTools.find((tool) => tool.name === "testlog")!;
		await testlog.execute(
			"n1",
			{ action: "note", area: "composer", text: "Chips vanished and never came back." },
			undefined,
			undefined,
			fakeCtx() as never,
		);
		await testlog.execute(
			"t1",
			{
				action: "ticket",
				area: "composer",
				title: "Chips vanish",
				severity: "minor",
				category: "bug",
				what: "w",
				expected: "e",
				steps: "s",
			},
			undefined,
			undefined,
			fakeCtx() as never,
		);
		logActions(spawned[0]!, 3, 2);
		await startRun("stop");
		spawned.length = 0;
		smolt.sentMessages.length = 0;

		const result = await runTool({ action: "resume" });
		expect(String(result.text)).toContain("Resumed");
		expect(spawned.map((tester) => tester.persona.slug)).toEqual(originalSlugs);
		const task = spawned[0]!.task;
		expect(task).toContain("RESUMING AN INTERRUPTED SESSION");
		expect(task).toContain("Chips vanished and never came back.");
		expect(task).toContain("Chips vanish");
		expect(task).toContain("never refile");
		expect(task).toContain("already spent about 3");
		expect(spawned[1]!.task).toContain("(none so far)");
		expect(spawned[1]!.task).toContain("already spent about 0");
		const view = await runTool({ action: "view" });
		expect(view.status).toBe("testing");
		expect(smolt.sentMessages.length).toBe(1);
		expect(smolt.sentMessages[0]).toContain("was interrupted mid-run");
		expect(smolt.sentMessages[0]).toContain("Synthesize run");
	});

	test("resume refuses a complete run and a session that already has testers", async () => {
		await startRun("1");
		spawned[0]!.finish("completed", "done");
		await runTool({ action: "write_report", content: "# Report" });
		const complete = await runTool({ action: "resume" });
		expect(String(complete.text)).toContain("already complete");
		await startRun("2");
		const busy = await runTool({ action: "resume" });
		expect(String(busy.text)).toContain("already has 2 tester(s) running");
	});

	test("wait with no in-session testers points at the interrupted run", async () => {
		await startRun("1");
		const slug = handle.activeRun()!;
		await startRun("stop");
		const result = await runTool({ action: "wait" });
		expect(String(result.text)).toContain("Interrupted run(s) on disk");
		expect(String(result.text)).toContain(slug);
		expect(String(result.text)).toContain("action 'resume'");
	});

	test("resume drains a previous instance's leftover testers", async () => {
		const makeInstance = () => {
			const s = new FakeSmolt();
			const list: SpawnedTester[] = [];
			const h = createBattleTestExtension(
				s as unknown as ExtensionAPI,
				{ root: join(dir, "battletest") },
				async ({ persona, task, customTools, metricsPath }, onFinish) => {
					const record: SpawnedTester = {
						persona,
						task,
						customTools,
						metricsPath,
						finish: onFinish,
						aborted: false,
						steered: [],
					};
					list.push(record);
					return {
						abort: async () => {
							record.aborted = true;
						},
						dispose: () => {},
					};
				},
			);
			return { s, list, h };
		};
		const a = makeInstance();
		await a.s.commands.get("battletest")!.handler("1", fakeCtx());
		expect(a.list.length).toBe(1);
		// A session reload: b is created after a, so a is its previous instance.
		const b = makeInstance();
		await b.s.commands.get("battletest")!.handler("resume", fakeCtx());
		expect(a.list[0]!.aborted).toBe(true);
		expect(b.list.length).toBe(1);
		expect(b.h.activeRun()).toBe(a.h.activeRun());
	});
});

describe("plain-language invocation", () => {
	const models = [
		{ provider: "opencode", id: "minimax-m3" },
		{ provider: "minimax", id: "MiniMax-M3" },
		{ provider: "opencode", id: "kimi-k2.6" },
	];

	/** A ctx whose registry knows the models above, so NL model phrases resolve. */
	function fakeCtxWithModels(authConfigured = true): Record<string, unknown> {
		const ctx = fakeCtx();
		ctx.modelRegistry = {
			getAll: () => models.map((model) => ({ ...model, name: model.id })),
			getAvailable: () => [],
			hasConfiguredAuth: () => authConfigured,
		};
		return ctx;
	}

	test("parses count, model override, and focus, and threads them to every tester", async () => {
		const ctx = fakeCtxWithModels();
		await smolt.commands.get("battletest")!.handler("15 subagents using opencode minimax-m3 to test a feature", ctx);
		expect(spawned.length).toBe(15);
		for (const tester of spawned) {
			expect(tester.model).toMatchObject({ provider: "opencode", id: "minimax-m3" });
		}
		expect(spawned[0]!.task).toContain("pay particular attention to: test a feature");
		expect(smolt.sentMessages[0]).toContain("Every tester runs on opencode/minimax-m3");
	});

	test("refuses to start when the named model has no API key", async () => {
		const ctx = fakeCtxWithModels(false);
		await smolt.commands.get("battletest")!.handler("2 using opencode minimax-m3", ctx);
		expect(spawned.length).toBe(0);
		expect(String((ctx.notifications as string[])[0])).toContain('No API key configured for provider "opencode"');
	});

	test("refuses an unknown model named after a provider", async () => {
		const ctx = fakeCtxWithModels();
		await smolt.commands.get("battletest")!.handler("2 using opencode minimax-m9", ctx);
		expect(spawned.length).toBe(0);
		expect(String((ctx.notifications as string[])[0])).toContain("No model matches");
	});

	test("the tool's start action accepts a model override too", async () => {
		const ctx = fakeCtxWithModels();
		const result = await runTool({ action: "start", count: 2, model: "opencode kimi-k2.6", focus: "checkout" }, ctx);
		expect(String(result.text)).toContain("started");
		expect(spawned.length).toBe(2);
		expect(spawned[0]!.model).toMatchObject({ provider: "opencode", id: "kimi-k2.6" });
	});

	test("the tool's start action rejects an unusable model", async () => {
		const ctx = fakeCtxWithModels();
		const result = await runTool({ action: "start", count: 2, model: "opencode nope" }, ctx);
		expect(String(result.text)).toContain("No model matches");
		expect(spawned.length).toBe(0);
	});
});
