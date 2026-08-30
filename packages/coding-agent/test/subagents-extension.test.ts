import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { BUILT_IN_AGENTS, discoverAgents } from "../src/extensions/subagents/agents.ts";
import { createSubagentsExtension, type Spawner } from "../src/extensions/subagents/index.ts";
import { describe as describeThread, ThreadPool } from "../src/extensions/subagents/threads.ts";

/**
 * Subagent threads run in the background, so the lifecycle is what matters:
 * a slot held until a result is read, steering that reaches a live thread, and
 * a finished thread reporting itself exactly once.
 *
 * The spawner is injected, so none of this needs a provider.
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

/** A thread that finishes only when the test says so. */
class FakeThread {
	sent: { text: string; interrupt: boolean }[] = [];
	aborted = false;
	disposed = false;
	lines: { role: string; text: string }[] = [];
	finish!: (status: "completed" | "errored", detail: string) => void;
}

class FakeSmolt {
	handlers = new Map<string, ((event: Record<string, unknown>, ctx?: unknown) => Promise<unknown>)[]>();
	tools = new Map<string, RegisteredTool>();
	commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	sent: string[] = [];
	notices: string[] = [];
	cwd = "";
	pending = false;

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
			model: undefined,
			thinkingLevel: "medium",
			modelRegistry: { getAvailable: () => [] },
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

	async run(params: Record<string, unknown>): Promise<string> {
		const tool = this.tools.get("subagent");
		if (!tool) throw new Error("subagent tool not registered");
		const result = await tool.execute("call-1", params, undefined, undefined, this.ctx());
		return result.content[0]!.text;
	}

	async command(args: string): Promise<void> {
		await this.commands.get("subagents")!.handler(args, this.ctx());
	}
}

let dir: string;
let smolt: FakeSmolt;
let handle: ReturnType<typeof createSubagentsExtension>;
let spawned: FakeThread[];

const spawner: Spawner = async (_agent, _task, _ctx, onFinish) => {
	const fake = new FakeThread();
	fake.finish = onFinish;
	spawned.push(fake);
	return {
		send: async (text, interrupt) => {
			fake.sent.push({ text, interrupt });
		},
		abort: async () => {
			fake.aborted = true;
		},
		dispose: () => {
			fake.disposed = true;
		},
		transcript: () => fake.lines,
	};
};

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "subagents-"));
	smolt = new FakeSmolt();
	smolt.cwd = dir;
	spawned = [];
	handle = createSubagentsExtension(smolt as unknown as ExtensionAPI, spawner);
	await smolt.fire("session_start");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

async function start(task = "find the parser"): Promise<string> {
	const text = await smolt.run({ action: "spawn", agent: "explorer", task });
	return text;
}

describe("agent definitions", () => {
	test("three are built in", () => {
		expect(BUILT_IN_AGENTS.map((agent) => agent.name).sort()).toEqual(["default", "explorer", "worker"]);
	});

	test("the explorer cannot write, by having no tools that could", () => {
		const explorer = BUILT_IN_AGENTS.find((agent) => agent.name === "explorer");
		expect(explorer?.tools).toEqual(["read", "grep", "find", "ls"]);
		expect(explorer?.tools).not.toContain("write");
	});

	test("a project definition overrides a built-in of the same name", () => {
		mkdirSync(join(dir, ".smolt", "agents"), { recursive: true });
		writeFileSync(
			join(dir, ".smolt", "agents", "worker.md"),
			"---\nname: worker\ndescription: This repo's own worker\nthinking: high\ntools: [read, write]\n---\nHouse rules.",
		);
		const agents = discoverAgents(dir, join(dir, "nowhere"));
		const worker = agents.find((agent) => agent.name === "worker");
		expect(worker?.description).toBe("This repo's own worker");
		expect(worker?.source).toBe("project");
		expect(worker?.thinking).toBe("high");
		expect(worker?.tools).toEqual(["read", "write"]);
	});

	test("a definition missing its name is skipped, not fatal", () => {
		mkdirSync(join(dir, ".smolt", "agents"), { recursive: true });
		writeFileSync(join(dir, ".smolt", "agents", "broken.md"), "---\ndescription: no name\n---\nbody");
		expect(discoverAgents(dir, join(dir, "nowhere"))).toHaveLength(BUILT_IN_AGENTS.length);
	});
});

describe("spawning", () => {
	test("it returns at once rather than waiting", async () => {
		const text = await start();
		expect(text).toContain("runs in the background");
		expect(handle.threads()).toHaveLength(1);
		expect(handle.threads()[0]?.status).toBe("running");
	});

	test("an unknown agent is refused with the list", async () => {
		const text = await smolt.run({ action: "spawn", agent: "nobody", task: "x" });
		expect(text).toContain("No agent named 'nobody'");
		expect(text).toContain("explorer");
		expect(handle.threads()).toHaveLength(0);
	});

	test("a task is required", async () => {
		expect(await smolt.run({ action: "spawn", agent: "explorer", task: "  " })).toContain("needs a task");
	});

	test("a spawner that throws leaves an errored thread, not a crash", async () => {
		const broken = createSubagentsExtension(smolt as unknown as ExtensionAPI, async () => {
			throw new Error("no model configured");
		});
		await smolt.fire("session_start");
		const text = await smolt.run({ action: "spawn", agent: "explorer", task: "x" });
		expect(text).toContain("failed to start");
		expect(broken.threads()[0]?.status).toBe("errored");
	});
});

describe("driving a running thread", () => {
	test("a correction queues behind the current turn by default", async () => {
		await start();
		await smolt.run({ action: "send", id: "a1", text: "also check the lexer" });
		expect(spawned[0]?.sent).toEqual([{ text: "also check the lexer", interrupt: false }]);
	});

	test("interrupt cuts in instead", async () => {
		await start();
		await smolt.run({ action: "send", id: "a1", text: "stop, wrong file", interrupt: true });
		expect(spawned[0]?.sent[0]?.interrupt).toBe(true);
	});

	test("its transcript can be read while it works", async () => {
		await start();
		spawned[0]!.lines = [{ role: "assistant", text: "looking at src/parser.ts" }];
		expect(await smolt.run({ action: "read", id: "a1" })).toContain("src/parser.ts");
	});

	test("a finished thread cannot be sent to", async () => {
		await start();
		spawned[0]!.finish("completed", "done");
		expect(await smolt.run({ action: "send", id: "a1", text: "more" })).toContain("already completed");
	});

	test("threads answer to their nickname as well as their id", async () => {
		await start();
		const nickname = handle.threads()[0]!.nickname;
		expect(await smolt.run({ action: "read", id: nickname })).toContain(nickname);
	});
});

describe("capacity", () => {
	test("a finished thread keeps its slot until it is closed", async () => {
		for (let index = 0; index < 4; index++)
			await smolt.run({ action: "spawn", agent: "explorer", task: `t${index}` });
		spawned[0]!.finish("completed", "done");
		expect(await smolt.run({ action: "spawn", agent: "explorer", task: "one more" })).toContain("At capacity");
		await smolt.run({ action: "close", id: "a1" });
		expect(await smolt.run({ action: "spawn", agent: "explorer", task: "one more" })).toContain(
			"runs in the background",
		);
	});

	test("closing a running thread stops it first", async () => {
		await start();
		await smolt.run({ action: "close", id: "a1" });
		expect(spawned[0]?.aborted).toBe(true);
		expect(spawned[0]?.disposed).toBe(true);
		expect(handle.threads()).toHaveLength(0);
	});
});

describe("results", () => {
	test("a thread that finished while the parent worked reports itself once", async () => {
		await start();
		spawned[0]!.finish("completed", "the parser is in src/parse.ts");
		await smolt.fire("agent_settled");
		expect(smolt.sent).toHaveLength(1);
		expect(smolt.sent[0]).toContain("src/parse.ts");
		// And not again on the next settle.
		await smolt.fire("agent_settled");
		expect(smolt.sent).toHaveLength(1);
	});

	test("a failure is reported as a failure", async () => {
		await start();
		spawned[0]!.finish("errored", "provider refused");
		await smolt.fire("agent_settled");
		expect(smolt.sent[0]).toContain("failed: provider refused");
	});

	test("waiting on a thread returns its result and does not double-report", async () => {
		await start();
		spawned[0]!.finish("completed", "found it");
		expect(await smolt.run({ action: "wait", id: "a1", seconds: 1 })).toContain("found it");
		await smolt.fire("agent_settled");
		expect(smolt.sent).toHaveLength(0);
	});

	test("waiting on a thread still running says so rather than hanging", async () => {
		await start();
		expect(await smolt.run({ action: "wait", id: "a1", seconds: 1 })).toContain("still running");
	});

	test("a queued user message defers the report", async () => {
		await start();
		spawned[0]!.finish("completed", "done");
		smolt.pending = true;
		await smolt.fire("agent_settled");
		expect(smolt.sent).toHaveLength(0);
	});
});

describe("the user's controls", () => {
	test("stop all halts every running thread", async () => {
		await start("one");
		await start("two");
		await smolt.command("stop all");
		expect(spawned.every((thread) => thread.aborted)).toBe(true);
		expect(handle.threads().every((thread) => thread.status === "stopped")).toBe(true);
	});

	test("close done clears finished threads and leaves the rest", async () => {
		await start("one");
		await start("two");
		spawned[0]!.finish("completed", "done");
		await smolt.command("close done");
		expect(handle.threads()).toHaveLength(1);
		expect(handle.threads()[0]?.task).toBe("two");
	});

	test("shutting the session down stops everything", async () => {
		await start();
		await smolt.fire("session_shutdown");
		expect(handle.threads()).toHaveLength(0);
		expect(spawned[0]?.disposed).toBe(true);
	});
});

describe("the pool itself", () => {
	test("capacity counts finished threads too", () => {
		const pool = new ThreadPool({ maxConcurrent: 2 });
		const first = pool.register(BUILT_IN_AGENTS[0]!, "a");
		pool.register(BUILT_IN_AGENTS[0]!, "b");
		pool.finish(first.id, "completed", "done");
		expect(pool.atCapacity()).toBe(true);
		pool.close(first.id);
		expect(pool.atCapacity()).toBe(false);
	});

	test("a thread's line names it, its agent and its state", () => {
		const pool = new ThreadPool({ maxConcurrent: 2 });
		const thread = pool.register(BUILT_IN_AGENTS[0]!, "find the parser");
		expect(describeThread(thread)).toContain("default");
		expect(describeThread(thread)).toContain("find the parser");
	});

	test("finishing twice keeps the first outcome", () => {
		const pool = new ThreadPool({ maxConcurrent: 2 });
		const thread = pool.register(BUILT_IN_AGENTS[0]!, "a");
		pool.finish(thread.id, "completed", "first");
		pool.finish(thread.id, "errored", "second");
		expect(thread.status).toBe("completed");
		expect(thread.summary).toBe("first");
	});
});
