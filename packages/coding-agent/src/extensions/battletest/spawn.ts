import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ThinkingLevel } from "@smolt/agent-core";
import type { Api, Model } from "@smolt/ai";
import { getAgentDir } from "../../config.ts";
import { ActionMetrics, type ActionSummary } from "../../core/action-metrics.ts";
import type { ExtensionContext, ToolDefinition } from "../../core/extensions/types.ts";
import { DefaultResourceLoader } from "../../core/resource-loader.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { createLeanChildExtension, type LeanChildOptions } from "./lean.ts";

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
	tokens?(): ChildTokens;
}

/**
 * A child's spend, every part of it. `input` is only what the provider
 * billed as fresh; the context re-sent on every turn comes back as
 * `cacheRead` (or `cacheWrite` the first time), and for a long session that
 * is most of the tokens — leave it out and the roster shows a tenth of the
 * truth.
 */
export interface ChildTokens {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** Every token the child was billed for, cached or not. */
export function childTokenTotal(tokens: ChildTokens): number {
	return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
}

/** "112.4k tokens" — the roster's spend label; empty until something was spent. */
export function childSpendLabel(tokens: ChildTokens | undefined): string {
	if (!tokens) return "";
	const total = childTokenTotal(tokens);
	if (total <= 0) return "";
	return `${(total / 1000).toFixed(1)}k tokens`;
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
	/** How lean the child's context is kept (tool-result budget, shedding of old results). */
	lean?: LeanChildOptions;
	/**
	 * Keep this child's transcript, but out of the session list: it is written
	 * to the project's hidden session folder, which nothing lists until the
	 * reader turns on `showHiddenChats`. For work done on their behalf that
	 * they did not sit and watch, and may want to read afterwards.
	 */
	hidden?: boolean;
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
export function persistChildSessions(settingsManager: SettingsManager): boolean {
	return settingsManager.getAgentsSettings().persistChildSessions === true;
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

/**
 * The resources a child session loads: as few as it can work with, because
 * every one of them rides on every turn, and a child makes fifty turns.
 *
 * - noExtensions keeps the child a worker, not an orchestrator: no subagent
 *   tool, no battletest or research command, nothing below this level
 *   spawns anything. The one extension it does run is inline: the budget
 *   on tool results, the shedding of old ones, and the reading habits —
 *   see lean.ts.
 * - noSkills: the skills catalogue is written for whoever is directing the
 *   work, and a child is handed its whole task in its brief. Left in, a
 *   catalogue of forty skills came to two thousand tokens on every turn of
 *   every researcher — a quarter of the fixed context — for nothing.
 * - No project context files (AGENTS.md and kin): coding conventions for
 *   whoever edits this repository, and a child never edits it.
 */
export function createChildResourceLoader(options: {
	cwd: string;
	agentDir: string;
	settingsManager: SettingsManager;
	lean?: LeanChildOptions;
	/** Text appended to the child's system prompt (an agent definition's instructions). */
	appendSystemPrompt?: string[];
	/**
	 * Keep the project's context files (AGENTS.md and kin). Off by default;
	 * a subagent that edits the repository is the one child that needs them.
	 */
	contextFiles?: boolean;
}): DefaultResourceLoader {
	return new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settingsManager: options.settingsManager,
		noExtensions: true,
		noSkills: true,
		extensionFactories: [createLeanChildExtension(options.lean)],
		...(options.contextFiles ? {} : { agentsFilesOverride: () => ({ agentsFiles: [] }) }),
		...(options.appendSystemPrompt ? { appendSystemPrompt: options.appendSystemPrompt } : {}),
	});
}

/** Start one child as a real background agent session. */
export async function spawnChildSession(options: ChildSpawnOptions, onFinish: ChildFinish): Promise<ChildDriver> {
	const { task, customTools, ctx, model, thinkingLevel, metricsPath } = options;
	const shellTimeout = options.shellTimeoutSeconds ?? CHILD_SHELL_TIMEOUT_SECONDS;
	const { createAgentSession } = await import("../../core/sdk.ts");
	const { SettingsManager } = await import("../../core/settings-manager.ts");
	const { getDefaultSessionDir, getHiddenSessionDir, SessionManager } = await import("../../core/session-manager.ts");

	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(ctx.cwd, agentDir);
	const resourceLoader = createChildResourceLoader({ cwd: ctx.cwd, agentDir, settingsManager, lean: options.lean });
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
		sessionManager: options.hidden
			? SessionManager.create(ctx.cwd, getHiddenSessionDir(ctx.cwd, agentDir))
			: persistChildSessions(settingsManager)
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
			const totals: ChildTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
			for (const message of session.messages) {
				const usage = (
					message as {
						role?: unknown;
						usage?: {
							input?: number;
							output?: number;
							cacheRead?: number;
							cacheWrite?: number;
						};
					}
				).usage;
				if ((message as { role?: unknown }).role !== "assistant" || !usage) continue;
				totals.input += usage.input ?? 0;
				totals.output += usage.output ?? 0;
				totals.cacheRead += usage.cacheRead ?? 0;
				totals.cacheWrite += usage.cacheWrite ?? 0;
			}
			return totals;
		},
	};
}
