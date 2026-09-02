import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ThinkingLevel } from "@smolt/agent-core";
import type { Api, Model } from "@smolt/ai";
import { getAgentDir } from "../../config.ts";
import { ActionMetrics, type ActionSummary } from "../../core/action-metrics.ts";
import type { ExtensionContext, ToolDefinition } from "../../core/extensions/types.ts";

/**
 * The child-session foundation battletest and research share: one background
 * `AgentSession` per team member, measured action by action, driven from the
 * parent through a small handle.
 *
 * Kept behind an injectable seam so the lifecycle can be tested without a
 * provider: tests supply their own spawner, and `spawnChildSession` below is
 * the only place that touches the SDK.
 */

/** What a running child session can be driven with, once it exists. */
export interface ChildDriver {
	abort(): Promise<void>;
	dispose(): void;
	/** How many actions (tool executions) the child has performed so far. */
	actions?(): number;
	/** Cut into the child's turn with a supervisor message (e.g. wrap up). */
	send?(text: string): Promise<void>;
	/** Timing totals for everything the child has done, for bottleneck hunting. */
	metricsSummary?(): ActionSummary;
	/** What the child is doing right now — the in-flight action, if any. */
	currentAction?(): string | undefined;
	/** The child's last actions, oldest first, for the expandable roster. */
	recentActions?(): string[];
	/** The child's own LLM spend so far, summed over its requests. */
	tokens?(): { input: number; output: number; cost: number };
}

export interface ChildSpawnOptions {
	task: string;
	customTools: ToolDefinition[];
	ctx: ExtensionContext;
	/** Run the child on this model instead of the session's own. */
	model?: Model<Api>;
	/** Thinking level for the model override, when one was stated. */
	thinkingLevel?: ThinkingLevel;
	/** The thinking level a child runs at when no override was stated. */
	defaultThinkingLevel: ThinkingLevel;
	/** JSONL file every timed action is appended to as it happens. */
	metricsPath?: string;
	/** Built-in tools the child must not have (e.g. `edit`, so it never patches source). */
	excludeTools?: string[];
	/** Hard ceiling on one uncapped child shell call, in seconds. */
	shellTimeoutSeconds?: number;
}

export type ChildFinish = (status: "completed" | "errored", detail: string) => void;

/**
 * Children run in temporary sessions by default: in-memory, never written to
 * disk, so a 10-member run leaves the session list — and session search, and
 * the desktop sidebar — exactly as it found it. Their durable output is the
 * run's diaries, tickets, and report, not their transcripts. Set
 * `agents.persistChildSessions: true` in settings.json to keep the old
 * behavior (real session files, recoverable transcripts).
 */
export function persistChildSessions(ctx: ExtensionContext): boolean {
	const settings = (ctx as unknown as { settings?: { agents?: { persistChildSessions?: boolean } } }).settings;
	return settings?.agents?.persistChildSessions === true;
}

/**
 * Hard ceiling on one uncapped child shell call.
 *
 * A run once lost over an hour to a single bash call that sat waiting on
 * something that never came — the child looked frozen and the run's report
 * could only shrug. Children never need an unbounded command: anything
 * longer than this is a wait loop, and a wait loop belongs in short polls
 * the supervisor can watch.
 */
export const CHILD_SHELL_TIMEOUT_SECONDS = 180;

/** Start one child as a real background agent session. */
export async function spawnChildSession(options: ChildSpawnOptions, onFinish: ChildFinish): Promise<ChildDriver> {
	const { task, customTools, ctx, model, thinkingLevel, metricsPath } = options;
	const shellTimeout = options.shellTimeoutSeconds ?? CHILD_SHELL_TIMEOUT_SECONDS;
	const { createAgentSession } = await import("../../core/sdk.ts");
	const { DefaultResourceLoader } = await import("../../core/resource-loader.ts");
	const { SettingsManager } = await import("../../core/settings-manager.ts");
	const { getDefaultSessionDir, SessionManager } = await import("../../core/session-manager.ts");

	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(ctx.cwd, agentDir);
	// noExtensions keeps the child a worker, not an orchestrator: no subagent
	// tool, no battletest or research command, nothing below this level
	// spawns anything.
	const resourceLoader = new DefaultResourceLoader({
		cwd: ctx.cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd: ctx.cwd,
		agentDir,
		model: model ?? ctx.model,
		thinkingLevel: thinkingLevel ?? options.defaultThinkingLevel,
		excludeTools: options.excludeTools ?? [],
		// A hung shell call must cost minutes, not the rest of the run.
		toolsOptions: {
			bash: { defaultTimeoutSeconds: shellTimeout },
			powershell: { defaultTimeoutSeconds: shellTimeout },
		},
		customTools,
		resourceLoader,
		settingsManager,
		sessionManager: persistChildSessions(ctx)
			? SessionManager.create(ctx.cwd, getDefaultSessionDir(ctx.cwd, agentDir))
			: SessionManager.inMemory(ctx.cwd),
	});

	// Every action is timed: tool spans and the model's thinking between them,
	// streamed to the run's metrics JSONL so even a killed run keeps its data.
	const metrics = new ActionMetrics(
		metricsPath
			? (row) => {
					try {
						mkdirSync(dirname(metricsPath), { recursive: true });
						appendFileSync(metricsPath, `${JSON.stringify(row)}\n`, "utf-8");
					} catch {
						// Metrics must never take down a child.
					}
				}
			: undefined,
	);
	const detachMetrics = metrics.attach(session);

	const finalText = (): string => {
		const messages = session.messages;
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index] as { role?: unknown; content?: unknown };
			if (message?.role !== "assistant") continue;
			const text = Array.isArray(message.content)
				? (message.content as { type?: string; text?: string }[])
						.filter((block) => block.type === "text")
						.map((block) => block.text ?? "")
						.join("")
				: String(message.content ?? "");
			if (text.trim() !== "") return text.trim();
		}
		return "";
	};

	// Detached on purpose: the whole point is that the parent does not wait.
	void session
		.prompt(task)
		.then(() => onFinish("completed", finalText()))
		.catch((error: unknown) => onFinish("errored", error instanceof Error ? error.message : String(error)));

	return {
		abort: async () => {
			await session.abort();
		},
		dispose: () => {
			detachMetrics();
			session.dispose();
		},
		actions: () => metrics.actions,
		send: async (text) => {
			await session.steer(text);
		},
		metricsSummary: () => metrics.summary(),
		currentAction: () => metrics.recent,
		recentActions: () => metrics.recentActions,
		tokens: () => {
			let input = 0;
			let output = 0;
			let cost = 0;
			for (const message of session.messages) {
				const usage = (
					message as { role?: unknown; usage?: { input?: number; output?: number; cost?: { total?: number } } }
				).usage;
				if ((message as { role?: unknown }).role !== "assistant" || !usage) continue;
				input += usage.input ?? 0;
				output += usage.output ?? 0;
				cost += usage.cost?.total ?? 0;
			}
			return { input, output, cost };
		},
	};
}
