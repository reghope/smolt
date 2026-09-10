import type { ThinkingLevel } from "@smolt/agent-core";
import { Type } from "typebox";
import { getAgentDir } from "../../config.ts";
import { ActionMetrics } from "../../core/action-metrics.ts";
// Type-only import: a standalone install of this module outside the smolt
// tree switches this single line to `from "smolt"`.
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import type { AgentsSettings } from "../../core/settings-manager.ts";
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

/**
 * The thinking level a thread runs at when neither its definition nor the
 * `agents` settings say. Not the parent's: that is often the user's ceiling
 * for their own work, and a thread at it spent most of its budget thinking.
 */
const SUBAGENT_THINKING: ThinkingLevel = "medium";

/** How much of a thread's transcript a 'read' shows: the tail, not the whole. */
const READ_ENTRIES = 12;
const READ_ENTRY_CHARS = 1200;

/** Longest summary relayed to the parent; everything relayed lands in its context for good. */
const SUMMARY_CHARS = 4000;

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
}

/** A thread's answer as the parent sees it: whole when short, its head when not. */
function summaryOf(thread: Thread): string {
	if (thread.summary === "") return "(no output)";
	if (thread.summary.length <= SUMMARY_CHARS) return thread.summary;
	return `${thread.summary.slice(0, SUMMARY_CHARS)}\n…(${thread.summary.length - SUMMARY_CHARS} more chars; 'read' the thread for the rest)`;
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

/** Whether an agent can change files, and so needs the project's conventions in its prompt. */
function canEdit(agent: AgentDefinition): boolean {
	return agent.tools === undefined || agent.tools.some((tool) => tool === "edit" || tool === "write");
}

/** The model a thread runs on: its definition's, else the settings default, else the parent's. */
function resolveModel(ref: string | undefined, ctx: ExtensionContext) {
	if (!ref) return ctx.model;
	return (
		ctx.modelRegistry.getAvailable().find((candidate) => {
			const id = `${candidate.provider}/${candidate.id}`;
			return id === ref || candidate.id === ref;
		}) ?? ctx.model
	);
}

/**
 * Threads run in temporary sessions by default: in-memory, never on disk, so
 * spawning a fleet of subagents does not clog the session list, /resume, or
 * session search. The parent carries the summary; the transcript is scratch.
 * `agents.persistChildSessions: true` restores the old persistent behavior.
 */
const defaultSpawner: Spawner = async (agent, task, ctx, onFinish) => {
	const { createAgentSession } = await import("../../core/sdk.ts");
	const { SettingsManager } = await import("../../core/settings-manager.ts");
	const { getDefaultSessionDir, SessionManager } = await import("../../core/session-manager.ts");
	const { createChildResourceLoader, persistChildSessions } = await import("../battletest/spawn.ts");

	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(ctx.cwd, agentDir);
	const defaults = settingsManager.getAgentsSettings();
	// The lean child loader battletest and research run on: no extensions
	// (the recursion guard — a child has no subagent tool, so nothing below
	// this level spawns anything), no skills catalogue (the task is in the
	// brief), tool results budgeted and shed as the thread goes. Measured on
	// this repository, the full loader put six thousand tokens of skills and
	// AGENTS.md on every turn of every thread. An explorer that never edits
	// keeps neither; a worker keeps the conventions it edits under.
	const resourceLoader = createChildResourceLoader({
		cwd: ctx.cwd,
		agentDir,
		settingsManager,
		appendSystemPrompt: [agent.instructions],
		contextFiles: canEdit(agent),
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd: ctx.cwd,
		agentDir,
		model: resolveModel(agent.model ?? defaults.defaultSubagentModel, ctx),
		thinkingLevel: agent.thinking ?? defaults.defaultSubagentThinking ?? SUBAGENT_THINKING,
		tools: agent.tools,
		resourceLoader,
		settingsManager,
		sessionManager: persistChildSessions(settingsManager)
			? SessionManager.create(ctx.cwd, getDefaultSessionDir(ctx.cwd, agentDir))
			: SessionManager.inMemory(ctx.cwd),
	});

	// Every action timed, so /subagents can say where a slow thread's time
	// went: inside its tools, or waiting on the model.
	const metrics = new ActionMetrics();
	const detachMetrics = metrics.attach(session);

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
		dispose: () => {
			detachMetrics();
			session.dispose();
		},
		transcript,
		metricsSummary: () => metrics.summary(),
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

	const settings = async (ctx: ExtensionContext): Promise<AgentsSettings> => {
		const { SettingsManager } = await import("../../core/settings-manager.ts");
		return SettingsManager.create(ctx.cwd, getAgentDir()).getAgentsSettings();
	};

	smolt.on("session_start", async (_event, ctx) => {
		agents = discoverAgents(ctx.cwd, getAgentDir());
		const config = await settings(ctx);
		enabled = config.enabled !== false;
		pool.setLimits({ maxConcurrent: config.maxConcurrentThreadsPerSession ?? DEFAULT_MAX_CONCURRENT });
		paint(ctx);
	});

	// Threads outlive a turn but never the session that owns them.
	smolt.on("session_shutdown", async () => {
		for (const thread of pool.closeAll()) void thread.driver?.abort();
	});

	// Nor do they outlive the reader pressing stop. A thread is an agent of its
	// own, running work the reader has just asked to end.
	smolt.on("agent_abort", async () => {
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
			const body = thread.status === "errored" ? `failed: ${thread.error}` : summaryOf(thread);
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
			"RESTRAINT: threads multiply cost and time. Each one re-establishes context, re-explores, and " +
			"reports back, and you then re-read its report. Delegate only when the payoff clearly exceeds " +
			"that overhead. Do the work inline when it is a small, bounded sub-task — a few file reads, one " +
			"search, a short edit, a single check. Do not fan out multiple threads on a single small task: " +
			"parallel threads are for genuinely independent, sizeable tracks, not for splitting one modest " +
			"job into pieces. Do not spawn a thread to review, re-verify, or double-check work you can " +
			"verify inline — verification that fits in your own loop belongs in your own loop. If you " +
			"delegate, commit to the delegation: do not redo the thread's work while waiting, and do not " +
			"re-derive its findings once it reports. If you find yourself repeating what a thread is " +
			"doing, you should not have spawned it. Keep spawn counts low: one well-briefed thread for a " +
			"large independent chunk is worth more than several loosely-briefed ones, so brief it precisely " +
			"the first time rather than launching, waiting, and re-briefing. Delegate for work that is " +
			"genuinely independent, large enough to justify a fresh context, or naturally parallel. " +
			"Otherwise, do it yourself.\n\n" +
			"WRITING THE TASK: brief the thread like a smart colleague who just walked into the room. It " +
			"has not seen this conversation, does not know what you have tried, and does not understand " +
			"why this task matters. Explain what you are trying to accomplish and why. Describe what you " +
			"have already learned or ruled out. Give enough context about the surrounding problem that it " +
			"can make judgment calls rather than just following a narrow instruction. If you need a short " +
			'response, say so, as in "report in under 200 words". For lookups, hand over the exact ' +
			"command; for investigations, hand over the " +
			"question, because prescribed steps become dead weight when the premise is wrong. Terse " +
			"command-style prompts produce shallow, generic work. Never delegate understanding: do not " +
			"write 'based on your findings, fix the bug', which pushes synthesis onto the thread instead " +
			"of doing it yourself. Write prompts that prove you understood, with file paths, line numbers, " +
			"and what specifically to change.\n\n" +
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
				// The tail, not the whole: a read is for seeing where a thread is,
				// and everything it returns sits in the parent's context for good.
				const shown = transcript.slice(-READ_ENTRIES);
				const skipped = transcript.length - shown.length;
				return textResult(
					`${describe(thread)}\n\n${skipped > 0 ? `(${skipped} earlier entries not shown)\n\n` : ""}${shown
						.map((entry) => `[${entry.role}] ${entry.text.slice(0, READ_ENTRY_CHARS)}`)
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
						: `${thread.id} ${thread.status}.\n\n${summaryOf(thread)}\n\nClose it with action 'close' when you are done with it.`,
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
