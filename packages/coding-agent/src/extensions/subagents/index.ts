import { Type } from "typebox";
import { getAgentDir } from "../../config.ts";
// Type-only import: a standalone install of this module outside the smolt
// tree switches this single line to `from "smolt"`.
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { type AgentDefinition, discoverAgents } from "./agents.ts";
import { describe, isFinished, type Thread, type ThreadDriver, ThreadPool } from "./threads.ts";

/**
 * Subagents: background threads the model can start, watch, correct and stop.
 *
 * The point of a subagent is that its context stays its own. A long search or
 * a self-contained build runs somewhere else, spends its own tokens, and hands
 * back a summary — the parent never carries the transcript.
 *
 * What makes these different from the fire-and-forget kind is that they are
 * still there while they run. A thread can be listed, read mid-flight, sent a
 * correction without restarting, and stopped. Finished threads keep their slot
 * until they are closed, so a result cannot be quietly displaced by the next
 * spawn before anyone has read it.
 *
 * Children run with extensions disabled, which is both a recursion guard —
 * they have no subagent tool, so the tree is one level deep by construction —
 * and the reason they start in milliseconds rather than seconds.
 */

/** How many threads may exist at once before spawning is refused. */
const DEFAULT_MAX_CONCURRENT = 4;

/** Longest a wait will block before reporting the thread is still going. */
const DEFAULT_WAIT_SECONDS = 60;

interface AgentsSettings {
	enabled?: boolean;
	maxConcurrentThreadsPerSession?: number;
	defaultSubagentModel?: string;
	defaultSubagentThinking?: string;
}

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
}

/** The last thing a thread said, which is its answer to the task. */
function finalText(transcript: { role: string; text: string }[]): string {
	for (let index = transcript.length - 1; index >= 0; index--) {
		const entry = transcript[index];
		if (entry && entry.role === "assistant" && entry.text.trim() !== "") return entry.text.trim();
	}
	return "";
}

/**
 * Start a real child agent session.
 *
 * Kept behind an injectable seam so the lifecycle can be tested without a
 * provider: the tests supply their own spawner, and the default one below is
 * the only place that touches the SDK.
 */
export type Spawner = (
	agent: AgentDefinition,
	task: string,
	ctx: ExtensionContext,
	onFinish: (status: "completed" | "errored", detail: string) => void,
) => Promise<ThreadDriver>;

const defaultSpawner: Spawner = async (agent, task, ctx, onFinish) => {
	const { createAgentSession } = await import("../../core/sdk.ts");
	const { DefaultResourceLoader } = await import("../../core/resource-loader.ts");
	const { SettingsManager } = await import("../../core/settings-manager.ts");
	const { getDefaultSessionDir, SessionManager } = await import("../../core/session-manager.ts");

	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(ctx.cwd, agentDir);
	// noExtensions is the recursion guard: a child has no subagent tool, so
	// nothing below this level can spawn anything.
	const resourceLoader = new DefaultResourceLoader({
		cwd: ctx.cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		appendSystemPrompt: [agent.instructions],
	});
	await resourceLoader.reload();

	const model = agent.model
		? (ctx.modelRegistry.getAvailable().find((candidate) => {
				const id = `${candidate.provider}/${candidate.id}`;
				return id === agent.model || candidate.id === agent.model;
			}) ?? ctx.model)
		: ctx.model;

	const { session } = await createAgentSession({
		cwd: ctx.cwd,
		agentDir,
		model,
		thinkingLevel: agent.thinking ?? ctx.thinkingLevel,
		tools: agent.tools,
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.create(ctx.cwd, getDefaultSessionDir(ctx.cwd, agentDir)),
	});

	const transcript = (): { role: string; text: string }[] =>
		session.messages.map((message) => ({
			role: String((message as { role?: unknown }).role ?? ""),
			text: Array.isArray((message as { content?: unknown }).content)
				? ((message as { content: { type?: string; text?: string }[] }).content ?? [])
						.filter((block) => block.type === "text")
						.map((block) => block.text ?? "")
						.join("")
				: String((message as { content?: unknown }).content ?? ""),
		}));

	// Detached on purpose: the whole point is that the parent does not wait.
	void session
		.prompt(task)
		.then(() => onFinish("completed", finalText(transcript())))
		.catch((error: unknown) => onFinish("errored", error instanceof Error ? error.message : String(error)));

	return {
		send: async (text, interrupt) => {
			if (interrupt) await session.steer(text);
			else await session.followUp(text);
		},
		abort: async () => {
			await session.abort();
		},
		dispose: () => session.dispose(),
		transcript,
	};
};

export default function subagentsExtension(smolt: ExtensionAPI): void {
	createSubagentsExtension(smolt);
}

export interface SubagentsHandle {
	threads(): Thread[];
}

export function createSubagentsExtension(smolt: ExtensionAPI, spawn: Spawner = defaultSpawner): SubagentsHandle {
	const pool = new ThreadPool({ maxConcurrent: DEFAULT_MAX_CONCURRENT });
	let agents: AgentDefinition[] = [];
	let enabled = true;

	const paint = (ctx: ExtensionContext): void => {
		const running = pool.running.length;
		const done = pool.open.length - running;
		if (pool.open.length === 0) {
			ctx.ui.setStatus("subagents", undefined);
			ctx.ui.setWidget("subagents", undefined);
			return;
		}
		ctx.ui.setStatus("subagents", `agents: ${running} running${done > 0 ? `, ${done} done` : ""}`);
		ctx.ui.setWidget("subagents", pool.open.map(describe).slice(0, 6));
	};

	const settings = (ctx: ExtensionContext): AgentsSettings => {
		const raw = (ctx as unknown as { settings?: { agents?: AgentsSettings } }).settings?.agents;
		return raw ?? {};
	};

	smolt.on("session_start", async (_event, ctx) => {
		agents = discoverAgents(ctx.cwd, getAgentDir());
		const config = settings(ctx);
		enabled = config.enabled !== false;
		pool.setLimits({ maxConcurrent: config.maxConcurrentThreadsPerSession ?? DEFAULT_MAX_CONCURRENT });
		paint(ctx);
	});

	// Threads outlive a turn but never the session that owns them.
	smolt.on("session_shutdown", async () => {
		for (const thread of pool.closeAll()) void thread.driver?.abort();
	});

	/**
	 * A thread that finished while the parent was working announces itself.
	 *
	 * The summary is delivered at settle rather than pushed mid-turn: cutting
	 * into a running turn with an unrelated result is how a parent loses the
	 * thread of its own work.
	 */
	smolt.on("agent_settled", async (_event, ctx) => {
		paint(ctx);
		if (!enabled) return;
		const done = pool.takeUnreported();
		if (done.length === 0) return;
		if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
		if (ctx.hasPendingMessages()) return;
		const lines = done.map((thread) => {
			const body = thread.status === "errored" ? `failed: ${thread.error}` : thread.summary || "(no output)";
			return `## ${thread.id} (${thread.nickname}) — ${thread.agent}\nTask: ${thread.task}\n\n${body}`;
		});
		smolt.sendUserMessage(
			`${done.length} subagent thread${done.length === 1 ? "" : "s"} finished while you were working:\n\n${lines.join(
				"\n\n",
			)}\n\nFold anything useful into what you are doing, then close them with the subagent tool (action 'close') to free their slots.`,
		);
	});

	smolt.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Run work on a background agent thread with its own context window, and drive it while it runs.\n\n" +
			"ACTIONS: 'spawn' (agent, task) starts a thread and returns immediately with its id — it does " +
			"NOT wait. 'list' shows every thread and its status. 'read' (id) returns a running thread's " +
			"transcript. 'send' (id, text, interrupt?) queues a correction, or cuts into the current turn " +
			"when interrupt is true. 'wait' (id, seconds?) blocks until one thread finishes or the wait " +
			"runs out. 'stop' (id) halts a thread. 'close' (id) discards it and frees its slot.\n\n" +
			"WHEN: work that is self-contained and would otherwise fill your own context — a wide search, " +
			"a long build, several independent changes at once. Spawn several and carry on; their results " +
			"arrive when they finish. Do NOT delegate work that needs what you already know but they do " +
			"not: a thread starts fresh and only sees the task you write for it.\n\n" +
			"A finished thread keeps its slot until you close it, so read the result first.",
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("spawn"),
					Type.Literal("list"),
					Type.Literal("read"),
					Type.Literal("send"),
					Type.Literal("wait"),
					Type.Literal("stop"),
					Type.Literal("close"),
				],
				{ description: "Operation to perform" },
			),
			agent: Type.Optional(
				Type.String({ description: "Which agent to run as, for 'spawn'. Use 'list' to see what exists." }),
			),
			task: Type.Optional(
				Type.String({
					description:
						"The whole job, for 'spawn'. The thread starts with no memory of this conversation, so state everything it needs.",
				}),
			),
			id: Type.Optional(Type.String({ description: "Thread id, for every action except spawn and list." })),
			text: Type.Optional(Type.String({ description: "Message to send, for 'send'." })),
			interrupt: Type.Optional(
				Type.Boolean({ description: "For 'send': cut into the current turn instead of queueing behind it." }),
			),
			seconds: Type.Optional(Type.Number({ description: "For 'wait': how long to block. Default 60." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!enabled) return textResult("Subagents are disabled for this project.");

			if (params.action === "list") {
				const available = agents.map((agent) => `- ${agent.name}: ${agent.description}`).join("\n");
				const threads = pool.open.length === 0 ? "No threads." : pool.open.map(describe).join("\n");
				return textResult(`AGENTS AVAILABLE\n${available}\n\nTHREADS\n${threads}`);
			}

			if (params.action === "spawn") {
				const name = params.agent ?? "default";
				const agent = agents.find((candidate) => candidate.name === name);
				if (!agent) {
					return textResult(`No agent named '${name}'. Available: ${agents.map((a) => a.name).join(", ")}.`);
				}
				if ((params.task ?? "").trim() === "") return textResult("A thread needs a task.");
				if (pool.atCapacity()) {
					return textResult(
						`At capacity (${pool.open.length} threads). Close a finished one with action 'close' before spawning another.`,
					);
				}
				const thread = pool.register(agent, params.task ?? "");
				try {
					const driver = await spawn(agent, params.task ?? "", ctx, (status, detail) => {
						pool.finish(thread.id, status, detail);
						paint(ctx);
					});
					pool.attach(thread.id, driver);
				} catch (error) {
					pool.finish(thread.id, "errored", error instanceof Error ? error.message : String(error));
				}
				paint(ctx);
				const started = pool.get(thread.id);
				return textResult(
					started?.status === "errored"
						? `Thread ${thread.id} failed to start: ${started.error}`
						: `Started ${thread.id} (${thread.nickname}) as '${agent.name}'. It runs in the background; carry on and check back with action 'list', or 'wait'.`,
				);
			}

			const thread = pool.get(params.id ?? "");
			if (!thread) return textResult(`No thread '${params.id ?? ""}'. Use action 'list'.`);

			if (params.action === "read") {
				const transcript = thread.driver?.transcript() ?? [];
				if (transcript.length === 0) return textResult(`${describe(thread)}\n\nNothing yet.`);
				return textResult(
					`${describe(thread)}\n\n${transcript
						.map((entry) => `[${entry.role}] ${entry.text.slice(0, 2000)}`)
						.join("\n\n")}`,
				);
			}

			if (params.action === "send") {
				if (isFinished(thread.status)) return textResult(`${thread.id} has already ${thread.status}.`);
				if ((params.text ?? "").trim() === "") return textResult("Nothing to send.");
				await thread.driver?.send(params.text ?? "", params.interrupt === true);
				return textResult(
					params.interrupt === true
						? `Cut into ${thread.id} with your message.`
						: `Queued for ${thread.id}, to be read when its current turn ends.`,
				);
			}

			if (params.action === "wait") {
				const limit = Math.max(1, Math.min(params.seconds ?? DEFAULT_WAIT_SECONDS, 600)) * 1000;
				const deadline = Date.now() + limit;
				while (!isFinished(thread.status) && Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 250));
				}
				thread.unreported = false;
				paint(ctx);
				if (!isFinished(thread.status)) {
					return textResult(`${thread.id} is still ${thread.status} after ${Math.round(limit / 1000)}s.`);
				}
				return textResult(
					thread.status === "errored"
						? `${thread.id} failed: ${thread.error}`
						: `${thread.id} ${thread.status}.\n\n${thread.summary || "(no output)"}\n\nClose it with action 'close' when you are done with it.`,
				);
			}

			if (params.action === "stop") {
				await thread.driver?.abort();
				pool.finish(thread.id, "stopped", finalText(thread.driver?.transcript() ?? []));
				thread.unreported = false;
				paint(ctx);
				return textResult(`Stopped ${thread.id}.`);
			}

			// close
			if (!isFinished(thread.status)) await thread.driver?.abort();
			pool.close(thread.id);
			paint(ctx);
			return textResult(`Closed ${thread.id}.`);
		},
	});

	smolt.registerCommand("subagents", {
		description: "Inspect, steer and stop background agent threads",
		getArgumentCompletions: (argumentPrefix) => {
			const items = [
				{ value: "list", label: "list", description: "Every thread and its status" },
				{ value: "agents", label: "agents", description: "Agent definitions available here" },
				{ value: "stop", label: "stop <id|all>", description: "Halt a thread, or all of them" },
				{ value: "close", label: "close <id|done>", description: "Discard a thread and free its slot" },
			];
			const prefix = argumentPrefix.trim().toLowerCase();
			return items.filter((item) => item.value.startsWith(prefix));
		},
		handler: async (args, ctx) => {
			const [verb = "", target = ""] = args.trim().split(/\s+/);
			if (verb === "agents") {
				ctx.ui.notify(
					agents.map((agent) => `${agent.name} (${agent.source}): ${agent.description}`).join("\n"),
					"info",
				);
				return;
			}
			if (verb === "stop") {
				const targets = target === "all" ? pool.running : [pool.get(target)].filter((t): t is Thread => !!t);
				for (const thread of targets) {
					await thread.driver?.abort();
					pool.finish(thread.id, "stopped", "");
				}
				paint(ctx);
				ctx.ui.notify(`Stopped ${targets.length} thread(s).`, "info");
				return;
			}
			if (verb === "close") {
				const targets =
					target === "done" || target === ""
						? pool.open.filter((thread) => isFinished(thread.status))
						: [pool.get(target)].filter((t): t is Thread => !!t);
				for (const thread of targets) {
					if (!isFinished(thread.status)) await thread.driver?.abort();
					pool.close(thread.id);
				}
				paint(ctx);
				ctx.ui.notify(`Closed ${targets.length} thread(s).`, "info");
				return;
			}
			if (target !== "" && verb === "read") {
				const thread = pool.get(target);
				ctx.ui.notify(
					thread ? `${describe(thread)}\n\n${thread.summary || "(still working)"}` : "No such thread.",
					"info",
				);
				return;
			}
			ctx.ui.notify(pool.open.length === 0 ? "No agent threads." : pool.open.map(describe).join("\n"), "info");
		},
	});

	return { threads: () => pool.open };
}
