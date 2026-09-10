import * as fs from "node:fs";
import * as path from "node:path";
import type {
	Api,
	AssistantMessage,
	Message,
	Model,
	ModelThinkingLevel,
	Tool as ModelTool,
	ToolResultMessage,
	UserMessage,
} from "@smolt/ai";
import { Type } from "typebox";
// Type-only import: a standalone install of this module outside the smolt
// tree switches this single line to `from "smolt"`.
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { createTool, type Tool, type ToolName } from "../../core/tools/index.ts";
import {
	type AdvisorRosterConfig,
	type AdvisorSpec,
	DEFAULT_ADVISOR_TOOLS,
	loadAdvisorConfig,
	loadAdvisorSettings,
	writeAdvisorMode,
	writeAdvisorTokenBudget,
} from "./config.ts";
import { ADVISE_TOOL_DESCRIPTION, ADVISOR_INVESTIGATION_PROMPT, ADVISOR_SYSTEM_PROMPT } from "./prompts.ts";

/**
 * Advisor: a second model (or a roster of them) shadows the session, reviews
 * incremental transcript deltas with its own investigative tools, and steers
 * the primary agent through severity-ranked advisory notes.
 *
 * Ported from oh-my-pi's advisor/watchdog subsystem. Each advisor is an
 * isolated reviewer: it never shares the primary agent's context, and its
 * only channel back into the session is the `advise` tool, guarded by
 * dedupe/noise filters and an interrupt cooldown.
 *
 * Configuration:
 * - advisor.json (user agent dir, then project .smolt): { enabled, model,
 *   immuneTurns, syncBacklog, reviewEvery }
 * - WATCHDOG.md (agent dir, project ancestors, .smolt dirs): advisor-only
 *   review priorities appended to every advisor's system prompt.
 * - WATCHDOG.yml (same locations): the roster - named advisors with their own
 *   model, tool grant, and specialization instructions.
 * - `--advisor` flag / `/advisor` command: session-scoped enablement.
 *
 * What it costs is decided by three things, all bounded here. How often it
 * reviews: once when the run settles, and while a run is in progress only
 * every `reviewEvery` steps (six by default; twelve in quick mode) rather than after every model
 * step - and not at all while the transcript since the last review holds no
 * tool calls, tool results or failed steps, since a chat exchange gives a
 * code reviewer nothing to review, nor while a mid-run stretch holds fewer
 * than three of them and no error, since a couple of tool calls do not repay
 * a request; that stretch waits and joins the next update instead. How many requests a review is: one. Without investigative
 * tools (the default) the advisor answers "ok" or calls advise, and either
 * ends the review; a roster that grants tools buys a couple more calls, each
 * re-sending the conversation. What each request carries: an update of a
 * few thousand characters at most - reasoning, tool arguments and results
 * each cut to a couple of lines, an error kept longer - a short system
 * prompt, minimal thinking (advisor.json `thinking` raises it), a 700-token
 * reply cap (150 in quick mode, which also drops thinking and investigative
 * tools), and one collapsed earlier exchange, so a review costs around a
 * thousand tokens rather than fifteen. A session token budget (`tokenBudget`,
 * `/advisor budget`) stops reviews outright once the advisors have spent it.
 */

type Severity = "nit" | "concern" | "blocker";

const MAX_ARGS_CHARS = 240;
/** A quoted tool result. An error keeps more: that is what a reviewer acts on. */
const MAX_RESULT_CHARS = 240;
const MAX_ERROR_CHARS = 600;
/** The start of a step's reasoning, where the plan is stated. */
const MAX_THINKING_CHARS = 240;
/** The whole update. Over this, the head and the tail are kept and the middle dropped. */
const MAX_DELTA_CHARS = 3_500;
/**
 * How much work an in-progress update must hold to be worth a request. One
 * lone tool call mid-run tells a reviewer almost nothing, and reviewing it
 * spends a whole request to hear "ok"; below this the stretch waits and joins
 * the next update instead. An error is always worth a look, whatever else the
 * update holds.
 */
const MIN_IN_PROGRESS_SIGNALS = 3;
/** The same bar in quick mode: reviews only on visibly busier stretches. */
const QUICK_MIN_IN_PROGRESS_SIGNALS = 6;
/** Carried conversation cap: the pending update plus the last collapsed exchange. */
const MAX_ADVISOR_MESSAGES = 3;
const MAX_DEDUPE_ENTRIES = 4096;
/** Model calls per review when a roster grants investigative tools; without them a review is one call. */
const MAX_TOOL_ITERATIONS = 3;
/** What an update shrinks to once its review is over and it is only context for the next. */
const CARRY_UPDATE_CHARS = 240;
/** What the advisor's own reply shrinks to in the carried conversation. */
const CARRY_REPLY_CHARS = 200;
/** Output cap: brief thinking, then "ok" or one note and its tool call. */
const MAX_REPLY_TOKENS = 700;
/** Output cap in quick mode: one short note or "ok", nothing else. */
const QUICK_MAX_REPLY_TOKENS = 150;
/**
 * How many turns in a row the advisor may start on its own while the agent is
 * idle. A note the agent answers can draw another note, and without a cap that
 * exchange runs on its own without the reader. Reset by the next user input.
 */
const MAX_ADVISOR_TRIGGERED_TURNS = 2;
/** Thinking level for a review when advisor.json does not name one. */
export const DEFAULT_THINKING: ModelThinkingLevel = "minimal";
export const DEFAULT_REVIEW_EVERY = 6;
const SYNC_BACKLOG_WAIT_MS = 30_000;
const CUSTOM_TYPE = "advisor";

const CONTENT_FREE = new Set([
	"stop",
	"done",
	"complete",
	"completed",
	"ok",
	"okay",
	"lgtm",
	"looks good",
	"looks good to me",
	"no issue",
	"no issues",
	"no issue continue",
	"nothing to add",
	"continue",
	"proceed",
	"on track",
]);

const adviseSchema = Type.Object({
	note: Type.String({ description: "The advice, addressed directly to the agent. Concrete and terse." }),
	severity: Type.Optional(
		Type.Union([Type.Literal("nit"), Type.Literal("concern"), Type.Literal("blocker")], {
			description: "Delivery severity. Defaults to nit.",
		}),
	),
});

function normalizeNote(text: string): string {
	return text
		.toLowerCase()
		.normalize("NFKC")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n[...truncated, ${text.length - max} more chars]`;
}

/** Keep the head and the tail of a long text. In an update the tail is the newest work. */
export function truncateMiddle(text: string, max: number): string {
	if (text.length <= max) return text;
	const head = Math.floor(max / 3);
	const tail = max - head;
	return `${text.slice(0, head)}\n[...${text.length - max} chars dropped...]\n${text.slice(text.length - tail)}`;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
			parts.push((block as { text: string }).text);
		}
	}
	return parts.join("\n");
}

const SEVERITY_RANK: Record<Severity, number> = { nit: 0, concern: 1, blocker: 2 };

/** Whether an in-progress review is due after this many steps since the last one. */
export function reviewDue(stepsSinceReview: number, every: number): boolean {
	return stepsSinceReview >= Math.max(1, every);
}

/**
 * Collapse a finished review, the messages from `start` on, into what the next
 * review needs of it: the update cut short, and the advisor's closing words
 * with no tool calls, so nothing dangles. Its investigation - tool calls and
 * results - is dropped; what it learned is in the note it delivered.
 */
export function carryExchange(conversation: Message[], start: number): Message[] {
	const kept = conversation.slice(0, start);
	const exchange = conversation.slice(start);
	const update = exchange.find((message): message is UserMessage => message.role === "user");
	if (!update) return kept;
	kept.push({ ...update, content: [{ type: "text", text: truncate(textOf(update.content), CARRY_UPDATE_CHARS) }] });
	const replies = exchange.filter((message): message is AssistantMessage => message.role === "assistant");
	const last = replies[replies.length - 1];
	if (!last) return kept;
	const said = replies
		.flatMap((reply) => reply.content)
		.filter((block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text")
		.map((block) => block.text.trim())
		.filter(Boolean)
		.join("\n");
	kept.push({ ...last, content: [{ type: "text", text: truncate(said || "(no comment)", CARRY_REPLY_CHARS) }] });
	return kept;
}

/** The shape of a session entry the delta renderer reads; the real type is wider. */
interface DeltaEntry {
	type: string;
	message?: Record<string, unknown>;
}

export interface RenderedDelta {
	text: string;
	/**
	 * Whether the delta holds anything a code reviewer can act on: a tool call,
	 * a tool result, a shell command, or a step that errored or was cut short.
	 * A delta of user and assistant prose alone is conversation, not work.
	 */
	reviewable: boolean;
	/** How many such items the delta holds, for the in-progress substance gate. */
	signals: number;
	/** An error or an aborted step: worth a look however little else is here. */
	urgent: boolean;
}

/** Render the transcript from `cursor` on as the advisor's next update. */
export function renderDelta(entries: ReadonlyArray<DeltaEntry>, cursor: number): RenderedDelta {
	const sections: string[] = [];
	let signals = 0;
	let urgent = false;
	for (let i = cursor; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.type === "compaction") {
			sections.push("[transcript compacted]");
			continue;
		}
		if (entry.type !== "message" || !entry.message) continue;
		const message = entry.message;
		const role = message.role as string;
		if (role === "user") {
			const text = textOf(message.content).trim();
			if (text) sections.push(`<user>\n${text}\n</user>`);
		} else if (role === "assistant") {
			const lines: string[] = [];
			const content = Array.isArray(message.content) ? message.content : [];
			for (const block of content as Array<Record<string, unknown>>) {
				if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
					lines.push(`<thinking>\n${truncate(block.thinking.trim(), MAX_THINKING_CHARS)}\n</thinking>`);
				} else if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
					lines.push(block.text.trim());
				} else if (block.type === "toolCall") {
					const args = truncate(JSON.stringify(block.arguments ?? {}), MAX_ARGS_CHARS);
					lines.push(`[tool call] ${block.name as string} ${args}`);
					signals++;
				}
			}
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				lines.push(`[assistant stop: ${message.stopReason as string}]`);
				signals++;
				urgent = true;
			}
			if (lines.length) sections.push(`<assistant>\n${lines.join("\n")}\n</assistant>`);
		} else if (role === "toolResult") {
			const text = truncate(textOf(message.content).trim(), message.isError ? MAX_ERROR_CHARS : MAX_RESULT_CHARS);
			const flag = message.isError ? " (error)" : "";
			sections.push(`[tool result] ${message.toolName as string}${flag}\n${text}`);
			signals++;
			if (message.isError) urgent = true;
		} else if (role === "custom") {
			if (message.customType === CUSTOM_TYPE) continue; // never review our own advice
			const text = textOf(message.content).trim();
			if (text) sections.push(`[${message.customType as string}]\n${truncate(text, MAX_RESULT_CHARS)}`);
		} else if (role === "bashExecution") {
			sections.push(
				`[user bash] $ ${message.command as string}\n${truncate((message.output as string) ?? "", MAX_RESULT_CHARS)}`,
			);
			signals++;
		}
	}
	return { text: truncateMiddle(sections.join("\n\n"), MAX_DELTA_CHARS), reviewable: signals > 0, signals, urgent };
}

interface AdvisorUsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

/** The custom entry an advisor files after each review, so the session's stats count its spend. */
const USAGE_ENTRY_TYPE = "advisor-usage";

/** One advisor's private runtime: its conversation, cursor, guard, and tools. */
class AdvisorRuntime {
	readonly spec: AdvisorSpec;
	cursor = 0;
	conversation: Message[] = [];
	notesSent = 0;
	usage: AdvisorUsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	backlog = 0;
	failures = 0;
	halted = false;
	private readonly dedupe: string[] = [];
	private readonly dedupeSet = new Set<string>();
	/** severity rank by normalized note, for the escalation-allowed duplicate check */
	private readonly seenSeverity = new Map<string, number>();

	constructor(spec: AdvisorSpec) {
		this.spec = spec;
	}

	/** Returns false for duplicates at equal-or-lower severity; true records the note. */
	acceptNote(note: string, severity: Severity): "accepted" | "duplicate" | "noise" {
		const normalized = normalizeNote(note);
		if (!normalized || CONTENT_FREE.has(normalized)) return "noise";
		const prior = this.seenSeverity.get(normalized);
		if (prior !== undefined && SEVERITY_RANK[severity] <= prior) return "duplicate";
		if (this.dedupeSet.has(normalized) && prior !== undefined && SEVERITY_RANK[severity] <= prior) {
			return "duplicate";
		}
		this.seenSeverity.set(normalized, SEVERITY_RANK[severity]);
		if (!this.dedupeSet.has(normalized)) {
			this.dedupe.push(normalized);
			this.dedupeSet.add(normalized);
			if (this.dedupe.length > MAX_DEDUPE_ENTRIES) {
				const evicted = this.dedupe.shift();
				if (evicted !== undefined) {
					this.dedupeSet.delete(evicted);
					this.seenSeverity.delete(evicted);
				}
			}
		}
		return "accepted";
	}
}

export default function advisorExtension(smolt: ExtensionAPI) {
	let config: AdvisorRosterConfig = {
		settings: {},
		sharedInstructions: [],
		watchdogBlocks: [],
		advisors: [],
	};
	let runtimes: AdvisorRuntime[] = [];
	let enabled = false;
	let modelOverride: string | undefined;
	let turnCount = 0;
	let cooldownUntilTurn = 0;
	let stepsSinceReview = 0;
	let advisorTriggeredTurns = 0;
	let reviewing = false;
	let rerun = false;
	let abort: AbortController | undefined;
	let disposed = false;
	let backlogWaiters: Array<() => void> = [];
	// Set by agent_abort, cleared at the next turn_start. Until then,
	// scheduleReview is skipped: the settled-after-abort events see the aborted
	// partial work, would call it a blocker, and triggerTurn would start a new
	// turn - un-stopping what the reader just stopped, one revived turn per
	// press of the stop button. Both turn_end and agent_settled fire after an
	// abort, so a one-shot skip is not enough.
	let abortGrace = false;

	smolt.registerFlag("advisor", {
		description: "Enable the advisor for this session",
		type: "boolean",
		default: false,
	});

	function immuneTurns(): number {
		return config.settings.immuneTurns ?? 3;
	}

	function reviewEvery(): number {
		const base = config.settings.reviewEvery ?? DEFAULT_REVIEW_EVERY;
		// Quick mode reviews half as often: its whole point is spending little,
		// and an in-progress review it skips is work the next update covers.
		return advisorMode() === "quick" ? base * 2 : base;
	}

	function advisorMode(): "quick" | "deep" {
		return config.settings.mode ?? "deep";
	}

	/** Every token the advisors have spent this session, in any billing form. */
	function advisorTokensSpent(): number {
		return runtimes.reduce(
			(sum, runtime) =>
				sum + runtime.usage.input + runtime.usage.output + runtime.usage.cacheRead + runtime.usage.cacheWrite,
			0,
		);
	}

	/** True once the session token budget is set and spent. */
	let budgetAnnounced = false;
	function budgetExhausted(): boolean {
		const budget = config.settings.tokenBudget;
		if (!budget) return false;
		const spent = advisorTokensSpent();
		if (spent < budget) return false;
		if (!budgetAnnounced) {
			budgetAnnounced = true;
			try {
				smolt.sendMessage({
					customType: CUSTOM_TYPE,
					content: `Advisor token budget reached (${spent.toLocaleString()} / ${budget.toLocaleString()} tokens). Reviews stop until the budget is raised (\`/advisor budget\`) or the session restarts.`,
					display: true,
				});
			} catch {
				// the message is a courtesy; the budget cut itself must stand
			}
		}
		return true;
	}

	function totalBacklog(): number {
		return runtimes.reduce((sum, runtime) => sum + runtime.backlog, 0);
	}

	function releaseBacklogWaiters() {
		const waiters = backlogWaiters;
		backlogWaiters = [];
		for (const waiter of waiters) waiter();
	}

	function resolveModel(ctx: ExtensionContext, spec: AdvisorSpec): Model<Api> | undefined {
		const selector = modelOverride ?? spec.model ?? config.settings.model;
		if (!selector) return ctx.model;
		const slash = selector.indexOf("/");
		if (slash <= 0) return undefined;
		return ctx.modelRegistry.find(selector.slice(0, slash), selector.slice(slash + 1));
	}

	function systemPromptFor(spec: AdvisorSpec): string {
		const sections = [ADVISOR_SYSTEM_PROMPT];
		if ((spec.tools ?? DEFAULT_ADVISOR_TOOLS).length > 0) sections.push(ADVISOR_INVESTIGATION_PROMPT);
		if (config.sharedInstructions.length) sections.push(config.sharedInstructions.join("\n\n"));
		if (spec.instructions?.trim()) sections.push(spec.instructions.trim());
		if (config.watchdogBlocks.length) {
			sections.push(
				`Especially pay attention to:\n<attention>\n${config.watchdogBlocks.join("\n\n---\n\n")}\n</attention>`,
			);
		}
		return sections.join("\n\n");
	}

	function updateStatus(ctx: ExtensionContext) {
		// The background review loop may outlive the session (shutdown, replacement);
		// a stale ctx throws on any access, so status updates are best-effort.
		try {
			if (!ctx.hasUI) return;
		} catch {
			return;
		}
		if (!enabled) {
			ctx.ui.setStatus("advisor", undefined);
			return;
		}
		const notes = runtimes.reduce((sum, runtime) => sum + runtime.notesSent, 0);
		const label = runtimes.length === 1 ? runtimes[0].spec.name.toLowerCase() : `${runtimes.length} advisors`;
		const modeNote = advisorMode() === "quick" ? ", quick" : "";
		ctx.ui.setStatus(
			"advisor",
			`advisor: ${reviewing ? "reviewing" : "watching"} (${label}, ${notes} notes${modeNote})`,
		);
	}

	function deliver(ctx: ExtensionContext, runtime: AdvisorRuntime, severity: Severity, note: string) {
		let effective = severity;
		if (effective !== "nit" && turnCount < cooldownUntilTurn) {
			effective = "nit"; // interrupt cooldown active: downgrade to a non-interrupting aside
		}
		const attribution = runtimes.length > 1 ? ` advisor="${runtime.spec.name}"` : "";
		const content = `<advisory${attribution} severity="${effective}" guidance="weigh, don't blindly obey; if it is right, act on it, otherwise say why not">\n${note}\n</advisory>`;
		// A note is addressed to the agent, so it should reach it as something to
		// answer. Mid-run the steer does that on its own; idle, the note would sit
		// in the transcript until the reader typed again, so it starts a turn.
		const idle = ctx.isIdle();
		const trigger = effective === "blocker" || (idle && advisorTriggeredTurns < MAX_ADVISOR_TRIGGERED_TURNS);
		if (idle && trigger) advisorTriggeredTurns++;
		smolt.sendMessage(
			{ customType: CUSTOM_TYPE, content, display: true },
			{ deliverAs: "steer", triggerTurn: trigger },
		);
		if (effective !== "nit" && !idle) {
			cooldownUntilTurn = turnCount + immuneTurns();
		}
		runtime.notesSent++;
	}

	function buildTools(ctx: ExtensionContext, spec: AdvisorSpec): Map<string, Tool> {
		const granted = spec.tools ?? DEFAULT_ADVISOR_TOOLS;
		const tools = new Map<string, Tool>();
		for (const name of granted) {
			try {
				tools.set(name, createTool(name as ToolName, ctx.cwd));
			} catch {
				// unknown or unavailable tool: skip
			}
		}
		return tools;
	}

	/**
	 * One review, with its spend filed afterwards: an advisor's requests never
	 * appear in the transcript, so without this they would be invisible to
	 * everything that adds up what the session cost.
	 */
	async function runAdvisorUpdate(ctx: ExtensionContext, runtime: AdvisorRuntime, signal: AbortSignal): Promise<void> {
		const before = { ...runtime.usage };
		try {
			await reviewUpdate(ctx, runtime, signal);
		} finally {
			const spent = runtime.usage;
			const turns = spent.turns - before.turns;
			if (turns > 0) {
				const input = spent.input - before.input;
				const output = spent.output - before.output;
				const cacheRead = spent.cacheRead - before.cacheRead;
				const cacheWrite = spent.cacheWrite - before.cacheWrite;
				const total = spent.cost - before.cost;
				try {
					smolt.appendEntry(USAGE_ENTRY_TYPE, {
						advisor: runtime.spec.name,
						turns,
						usage: {
							input,
							output,
							cacheRead,
							cacheWrite,
							totalTokens: input + output + cacheRead + cacheWrite,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
						},
					});
				} catch {
					// Record-keeping must never take the advisor down.
				}
			}
		}
	}

	async function reviewUpdate(ctx: ExtensionContext, runtime: AdvisorRuntime, signal: AbortSignal): Promise<void> {
		// advisor.json is what the desktop's settings page edits; reading it
		// again here is how a model picked mid-chat reaches the next review.
		config.settings = loadAdvisorSettings(ctx.cwd);
		if (budgetExhausted()) return;
		const model = resolveModel(ctx, runtime.spec);
		if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) return;
		const quick = advisorMode() === "quick";
		const thinking = quick ? "off" : (config.settings.thinking ?? DEFAULT_THINKING);

		const inProgress = !ctx.isIdle();
		const entries = ctx.sessionManager.getEntries() as ReadonlyArray<DeltaEntry>;
		const { text: delta, reviewable, signals, urgent } = renderDelta(entries, runtime.cursor);
		// Mid-run and barely anything happened: not worth a request. Leave the
		// cursor put so this work joins the next update rather than being reviewed
		// a couple of tool calls at a time.
		if (inProgress && !urgent && signals < (quick ? QUICK_MIN_IN_PROGRESS_SIGNALS : MIN_IN_PROGRESS_SIGNALS)) return;
		// Nothing a reviewer can act on yet: a chat exchange, a nudge, a compaction
		// marker. Leave the cursor where it is so this stretch - the user's
		// instructions included - opens the next update that does carry work.
		if (!reviewable || !delta.trim()) return;
		runtime.cursor = entries.length;

		const heading = inProgress ? "[in progress - more steps follow]\n\n" : "";
		const update: UserMessage = {
			role: "user",
			content: [{ type: "text", text: `${heading}Session update:\n\n${delta}` }],
			timestamp: Date.now(),
		};
		runtime.conversation.push(update);
		if (runtime.conversation.length > MAX_ADVISOR_MESSAGES) {
			// Re-prime: keep the system prompt's framing, drop the oldest exchanges.
			runtime.conversation = runtime.conversation.slice(-MAX_ADVISOR_MESSAGES);
			while (runtime.conversation.length && runtime.conversation[0].role !== "user") {
				runtime.conversation.shift();
			}
		}
		const start = runtime.conversation.lastIndexOf(update);
		const reviewModel: Model<Api> = model;

		const investigative = quick ? new Map<string, Tool>() : buildTools(ctx, runtime.spec);
		const adviseTool: ModelTool = {
			name: "advise",
			description: ADVISE_TOOL_DESCRIPTION,
			parameters: adviseSchema,
		};
		const toolDefs: ModelTool[] = [adviseTool, ...[...investigative.values()]];

		let acceptedThisUpdate = false;
		try {
			await investigate();
		} finally {
			// Whatever happened, the next review gets the gist, not the transcript.
			runtime.conversation = carryExchange(runtime.conversation, start < 0 ? runtime.conversation.length : start);
		}

		async function investigate(): Promise<void> {
			for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
				// Low thinking: enough to weigh an update, not enough to run up output.
				const response: AssistantMessage = await ctx.modelRegistry.completeSimple(
					reviewModel,
					{ systemPrompt: systemPromptFor(runtime.spec), messages: [...runtime.conversation], tools: toolDefs },
					{
						signal,
						sessionId: ctx.sessionManager.getSessionId(),
						reasoning: thinking === "off" ? undefined : thinking,
						maxTokens: quick ? QUICK_MAX_REPLY_TOKENS : MAX_REPLY_TOKENS,
					},
				);
				runtime.conversation.push(response);
				runtime.usage.turns++;
				runtime.usage.input += response.usage.input;
				runtime.usage.output += response.usage.output;
				runtime.usage.cacheRead += response.usage.cacheRead;
				runtime.usage.cacheWrite += response.usage.cacheWrite;
				runtime.usage.cost += response.usage.cost.total;

				if (response.stopReason === "error" || response.stopReason === "aborted") {
					if (response.stopReason === "error") throw new Error(response.errorMessage ?? "advisor request failed");
					return;
				}

				const toolCalls = response.content.filter(
					(block): block is Extract<AssistantMessage["content"][number], { type: "toolCall" }> =>
						block.type === "toolCall",
				);
				if (toolCalls.length === 0) return;

				for (const call of toolCalls) {
					let result: ToolResultMessage;
					if (call.name === "advise") {
						const args = call.arguments as { note?: unknown; severity?: unknown };
						const note = typeof args.note === "string" ? args.note.trim() : "";
						const severity: Severity =
							args.severity === "concern" || args.severity === "blocker" ? args.severity : "nit";
						let reply = "Recorded.";
						if (!note) {
							reply = "Empty note ignored.";
						} else if (inProgress && severity !== "blocker") {
							// withhold critique of partial work; visible as recorded to the model
						} else if (acceptedThisUpdate) {
							// one accepted note per update; silently absorbed
						} else {
							const verdict = runtime.acceptNote(note, severity);
							if (verdict === "duplicate") {
								reply = "Duplicate advice ignored.";
							} else if (verdict === "accepted") {
								acceptedThisUpdate = true;
								deliver(ctx, runtime, severity, note);
							}
						}
						result = {
							role: "toolResult",
							toolCallId: call.id,
							toolName: call.name,
							content: [{ type: "text", text: reply }],
							isError: false,
							timestamp: Date.now(),
						};
					} else {
						const tool = investigative.get(call.name);
						if (!tool) {
							result = {
								role: "toolResult",
								toolCallId: call.id,
								toolName: call.name,
								content: [{ type: "text", text: `Tool not available: ${call.name}` }],
								isError: true,
								timestamp: Date.now(),
							};
						} else {
							try {
								const executed = await tool.execute(call.id, call.arguments, signal);
								result = {
									role: "toolResult",
									toolCallId: call.id,
									toolName: call.name,
									content: executed.content,
									details: executed.details,
									isError: false,
									timestamp: Date.now(),
								};
							} catch (error) {
								result = {
									role: "toolResult",
									toolCallId: call.id,
									toolName: call.name,
									content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
									isError: true,
									timestamp: Date.now(),
								};
							}
						}
					}
					runtime.conversation.push(result);
				}
				// One note per update: once the advisor has spoken, another request
				// would only re-send the conversation to hear it say "ok".
				if (toolCalls.some((call) => call.name === "advise")) return;
			}
		}
	}

	async function drainRuntime(ctx: ExtensionContext, runtime: AdvisorRuntime, signal: AbortSignal): Promise<void> {
		while (runtime.backlog > 0 && enabled && !disposed && !runtime.halted && !signal.aborted) {
			runtime.backlog = 1; // coalesce queued updates into one delta pass
			try {
				await runAdvisorUpdate(ctx, runtime, signal);
				runtime.failures = 0;
				runtime.backlog = 0;
			} catch {
				runtime.failures++;
				if (runtime.failures >= 3) {
					runtime.halted = true;
					runtime.backlog = 0;
					try {
						if (ctx.hasUI) {
							ctx.ui.notify(`Advisor "${runtime.spec.name}" halted after repeated failures`, "warning");
						}
					} catch {
						// stale ctx after session teardown
					}
				} else {
					// Drop this batch. The failed update stays in the advisor's own
					// conversation, so the next delta continues from the current cursor.
					runtime.backlog = 0;
				}
			}
			releaseBacklogWaiters();
		}
	}

	function lastAssistantAborted(ctx: ExtensionContext): boolean {
		const entries = ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i] as { type: string; message?: Record<string, unknown> };
			if (entry.type !== "message" || !entry.message) continue;
			// An aborted tool call leaves its result as the last message; what
			// matters is the assistant message that was cut short.
			if (entry.message.role === "toolResult") continue;
			return entry.message.role === "assistant" && entry.message.stopReason === "aborted";
		}
		return false;
	}

	function scheduleReview(ctx: ExtensionContext) {
		if (!enabled || runtimes.length === 0) return;
		// The agent_abort emit is fire-and-forget, so turn_end/agent_settled can
		// race ahead of the handler that sets abortGrace. The transcript is the
		// tiebreaker: while it ends in an aborted assistant message, the reader
		// just stopped this chat, and a review here would only see the partial
		// work, call it a blocker, and trigger a turn that un-stops it.
		if (abortGrace || lastAssistantAborted(ctx)) return;
		for (const runtime of runtimes) {
			if (!runtime.halted) runtime.backlog++;
		}
		if (reviewing) {
			rerun = true;
			return;
		}
		reviewing = true;
		abort = new AbortController();
		const signal = abort.signal;
		updateStatus(ctx);
		void (async () => {
			try {
				do {
					rerun = false;
					for (const runtime of runtimes) {
						if (signal.aborted || disposed) break;
						await drainRuntime(ctx, runtime, signal);
					}
				} while (rerun && enabled && !disposed && !signal.aborted);
			} finally {
				reviewing = false;
				abort = undefined;
				releaseBacklogWaiters();
				updateStatus(ctx);
			}
		})();
	}

	/** Bounded catch-up: hold the primary turn while advisor backlog is at/above threshold. */
	async function waitForBacklog(): Promise<void> {
		const threshold = config.settings.syncBacklog;
		if (!enabled || threshold === undefined || threshold === "off") return;
		if (totalBacklog() < threshold) return;
		const deadline = Date.now() + SYNC_BACKLOG_WAIT_MS;
		while (totalBacklog() >= threshold && reviewing && Date.now() < deadline) {
			await new Promise<void>((resolve) => {
				backlogWaiters.push(resolve);
				setTimeout(resolve, Math.max(50, Math.min(1000, deadline - Date.now())));
			});
		}
	}

	function reset(ctx: ExtensionContext, enable: boolean) {
		abort?.abort();
		abortGrace = false;
		enabled = enable;
		turnCount = 0;
		cooldownUntilTurn = 0;
		stepsSinceReview = 0;
		advisorTriggeredTurns = 0;
		rerun = false;
		const cursor = ctx.sessionManager.getEntries().length;
		runtimes = config.advisors
			.filter((spec) => spec.enabled)
			.map((spec) => {
				const runtime = new AdvisorRuntime(spec);
				runtime.cursor = cursor;
				return runtime;
			});
		releaseBacklogWaiters();
		updateStatus(ctx);
	}

	function dumpTranscript(raw: boolean): string {
		const lines: string[] = [];
		for (const runtime of runtimes) {
			lines.push(`# Advisor: ${runtime.spec.name}`, "");
			if (raw) lines.push("## System prompt", "", systemPromptFor(runtime.spec), "");
			for (const message of runtime.conversation) {
				if (message.role === "user") {
					lines.push(`## update`, "", textOf(message.content), "");
				} else if (message.role === "assistant") {
					for (const block of message.content) {
						if (block.type === "text" && block.text.trim()) lines.push(`## reply`, "", block.text.trim(), "");
						else if (raw && block.type === "thinking" && block.thinking.trim())
							lines.push(`## thinking`, "", block.thinking.trim(), "");
						else if (block.type === "toolCall")
							lines.push(`## tool call: ${block.name}`, "", JSON.stringify(block.arguments), "");
					}
				} else if (raw && message.role === "toolResult") {
					lines.push(`## tool result: ${message.toolName}`, "", truncate(textOf(message.content), 4000), "");
				}
			}
			lines.push("");
		}
		return lines.join("\n");
	}

	/**
	 * What advisor.json said about "enabled" when it was last read. The
	 * desktop's settings page flips that field; a chat already running must
	 * follow it, or the switch looks broken until the next chat. A change in
	 * the file is what moves it, so /advisor on|off in the session still wins
	 * until the file changes again.
	 */
	let fileEnabled: boolean | undefined;
	function followFileToggle(ctx: ExtensionContext): void {
		const now = loadAdvisorSettings(ctx.cwd).enabled === true;
		if (fileEnabled === undefined || now === fileEnabled) {
			fileEnabled = now;
			return;
		}
		fileEnabled = now;
		if (now !== enabled) {
			config = loadAdvisorConfig(ctx.cwd);
			reset(ctx, now);
		}
	}

	smolt.on("session_start", async (_event, ctx) => {
		disposed = false;
		config = loadAdvisorConfig(ctx.cwd);
		fileEnabled = config.settings.enabled === true;
		const enable = Boolean(config.settings.enabled) || smolt.getFlag("advisor") === true;
		reset(ctx, enable);
	});

	smolt.on("session_compact", async (_event, ctx) => {
		// Primary transcript was rewritten: drop advisor context and re-seed cursors.
		reset(ctx, enabled);
	});

	// A step is one model response and its tool calls. Reviewing after every
	// one made a thirty-step run thirty reviews; now a run in progress is
	// looked at every few steps, and once more when it settles.
	smolt.on("turn_end", async (_event, ctx) => {
		turnCount++;
		stepsSinceReview++;
		if (reviewDue(stepsSinceReview, reviewEvery())) {
			stepsSinceReview = 0;
			scheduleReview(ctx);
		}
		await waitForBacklog();
	});

	smolt.on("agent_settled", async (_event, ctx) => {
		stepsSinceReview = 0;
		scheduleReview(ctx);
	});

	// The advisor reads along in its own agent, so stopping the chat has to
	// reach it too, or it keeps reviewing a turn that is already over.
	smolt.on("turn_start", async (_event, ctx) => {
		followFileToggle(ctx);
		abortGrace = false;
	});

	// The reader is back in the loop: the advisor may start turns again.
	smolt.on("input", async (event) => {
		if (event.source !== "extension") advisorTriggeredTurns = 0;
	});

	smolt.on("agent_abort", async () => {
		abortGrace = true;
		advisorTriggeredTurns = MAX_ADVISOR_TRIGGERED_TURNS;
		abort?.abort();
	});

	smolt.on("session_shutdown", async () => {
		disposed = true;
		abort?.abort();
		enabled = false;
		releaseBacklogWaiters();
	});

	smolt.registerCommand("advisor", {
		description: "Advisor: toggle | on | off | status | dump [raw] | model <provider/id>",
		handler: async (args, ctx) => {
			const [sub, ...rest] = args.trim().split(/\s+/);
			switch (sub || "toggle") {
				case "toggle":
				case "on":
				case "off": {
					const enable = sub === "on" ? true : sub === "off" ? false : !enabled;
					if (enable === enabled) {
						ctx.ui.notify(`Advisor already ${enable ? "on" : "off"}`, "info");
						return;
					}
					if (enable) {
						config = loadAdvisorConfig(ctx.cwd);
						reset(ctx, true);
						const names = runtimes.map((runtime) => runtime.spec.name).join(", ");
						ctx.ui.notify(`Advisor enabled for this session (${names || "none"})`, "info");
					} else {
						abort?.abort();
						enabled = false;
						updateStatus(ctx);
						ctx.ui.notify("Advisor disabled for this session", "info");
					}
					return;
				}
				case "status": {
					if (runtimes.length === 0) {
						ctx.ui.notify(`enabled: ${enabled}\nno advisors configured`, "info");
						return;
					}
					const lines: string[] = [`enabled: ${enabled}`];
					const budget = config.settings.tokenBudget;
					if (budget)
						lines.push(`budget: ${advisorTokensSpent().toLocaleString()} / ${budget.toLocaleString()} tokens`);
					for (const runtime of runtimes) {
						const model = resolveModel(ctx, runtime.spec);
						const grant = (runtime.spec.tools ?? DEFAULT_ADVISOR_TOOLS).join(",") || "none";
						lines.push(
							`${runtime.spec.name}: ${runtime.halted ? "halted" : runtime.backlog > 0 ? "reviewing" : "watching"}` +
								` | model ${model ? `${model.provider}/${model.id}` : "unresolved"}` +
								` | tools ${grant}` +
								` | ${runtime.notesSent} notes | ${runtime.usage.turns} turns` +
								` | ↑${runtime.usage.input} ↓${runtime.usage.output} $${runtime.usage.cost.toFixed(4)}`,
						);
					}
					lines.push(`interrupt cooldown: ${Math.max(0, cooldownUntilTurn - turnCount)} turns`);
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}
				case "quick":
				case "deep": {
					const mode = sub === "quick" ? ("quick" as const) : ("deep" as const);
					writeAdvisorMode(mode);
					config.settings.mode = mode;
					updateStatus(ctx);
					ctx.ui.notify(
						mode === "quick"
							? "Advisor mode: quick — shallow cheap pass, no thinking, no tools, half the review cadence"
							: "Advisor mode: deep — full reviews with the configured thinking and tools",
						"info",
					);
					return;
				}
				case "budget": {
					const raw = rest[0];
					if (raw === undefined) {
						const budget = config.settings.tokenBudget;
						ctx.ui.notify(
							budget
								? `budget: ${advisorTokensSpent().toLocaleString()} / ${budget.toLocaleString()} tokens`
								: "no token budget set (reviews run until turned off)",
							"info",
						);
						return;
					}
					if (raw === "off") {
						writeAdvisorTokenBudget(undefined);
						config.settings.tokenBudget = undefined;
						budgetAnnounced = false;
						ctx.ui.notify("Advisor token budget cleared", "info");
						return;
					}
					const tokens = Number.parseInt(raw, 10);
					if (!Number.isFinite(tokens) || tokens <= 0) {
						ctx.ui.notify("Usage: /advisor budget <tokens>|off", "warning");
						return;
					}
					writeAdvisorTokenBudget(tokens);
					config.settings.tokenBudget = tokens;
					budgetAnnounced = false;
					ctx.ui.notify(`Advisor token budget: ${tokens.toLocaleString()} tokens this session`, "info");
					return;
				}
				case "dump": {
					const raw = rest[0] === "raw";
					const target = path.join(ctx.cwd, ".smolt", `advisor-dump${raw ? "-raw" : ""}.md`);
					fs.mkdirSync(path.dirname(target), { recursive: true });
					fs.writeFileSync(target, dumpTranscript(raw), "utf8");
					ctx.ui.notify(`Advisor transcript written to ${target}`, "info");
					return;
				}
				case "model": {
					const selector = rest.join(" ").trim();
					if (!selector) {
						ctx.ui.notify("Usage: /advisor model <provider/model-id>", "warning");
						return;
					}
					const previous = modelOverride;
					modelOverride = selector;
					const model = runtimes[0] ? resolveModel(ctx, runtimes[0].spec) : undefined;
					if (!model) {
						modelOverride = previous;
						ctx.ui.notify(`Model not found: ${selector}`, "warning");
						return;
					}
					ctx.ui.notify(`Advisor model: ${model.provider}/${model.id}`, "info");
					updateStatus(ctx);
					return;
				}
				default:
					ctx.ui.notify(
						"Usage: /advisor [on|off|status|quick|deep|dump [raw]|model <provider/id>|budget <tokens>|off]",
						"warning",
					);
			}
		},
	});
}
