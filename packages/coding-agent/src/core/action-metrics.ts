/**
 * Per-action timing for child agent sessions.
 *
 * A subagent's wall clock splits into two kinds of span: tool executions (the
 * actions it takes) and assistant turns (the model deciding what to do next).
 * Recording both, per action, is what lets a battletest run — or any
 * subagent fleet — answer "where did the time go": which tool is the
 * bottleneck, whether the model or the tools dominate, and which single
 * actions were pathologically slow.
 *
 * The recorder attaches to an AgentSession's event stream and costs nothing
 * measurable: two map writes per tool call. Rows stream to an optional sink
 * (e.g. a JSONL file that survives a killed run); the summary is computed on
 * demand.
 */

/** One measured span: a tool execution, or an assistant turn between them. */
export interface ActionRow {
	/** ISO start time. */
	at: string;
	kind: "tool" | "llm";
	/** Tool name, for kind "tool". */
	tool?: string;
	/** One line on what the call was — the command or action argument. */
	label?: string;
	ms: number;
	/** For tools: whether the execution succeeded. */
	ok?: boolean;
}

export interface ToolTotals {
	count: number;
	ms: number;
	errors: number;
}

export interface ActionSummary {
	/** Wall-clock ms since the recorder attached. */
	wallMs: number;
	/** Total actions (tool executions). */
	actions: number;
	/** Time inside tool executions. */
	toolMs: number;
	/** Time inside assistant turns (model latency + generation). */
	llmMs: number;
	byTool: Record<string, ToolTotals>;
	/** The slowest individual spans, worst first — where to look first. */
	slowest: ActionRow[];
}

const SLOWEST_KEPT = 5;

/** How many described actions the rolling history keeps. */
const RECENT_KEPT = 30;

interface SessionLike {
	subscribe(listener: (event: unknown) => void): () => void;
}

interface SpanEvent {
	type?: string;
	toolCallId?: string;
	toolName?: string;
	args?: unknown;
	isError?: boolean;
	message?: { role?: string };
}

/** A compact human line for an action in flight: `browse: goto smolt.dev/desktop`. */
function describeAction(tool: string, args: unknown): string {
	const record = (args ?? {}) as Record<string, unknown>;
	// A self-described action costs nothing: the agent said what it is doing
	// in the call itself — a `doing` argument, or a leading `# comment` on a
	// shell command — and that phrase is the label, no classification needed.
	if (typeof record.doing === "string" && record.doing.trim() !== "") {
		return record.doing.trim().slice(0, 60);
	}
	if (typeof record.command === "string") {
		const comment = /^#\s*(.{3,80})/.exec(record.command.trimStart());
		if (comment) return comment[1]!.split("\n")[0]!.trim().slice(0, 60);
	}
	const bits: string[] = [];
	for (const key of ["action", "url", "selector", "area", "title"] as const) {
		const value = record[key];
		if (typeof value === "string" && value !== "") bits.push(value);
	}
	if (typeof record.command === "string" && record.command !== "") bits.push(record.command.slice(0, 40));
	const detail = bits.join(" ").replace(/\s+/g, " ").slice(0, 60);
	return detail === "" ? tool : `${tool}: ${detail}`;
}

export class ActionMetrics {
	private readonly rows: ActionRow[] = [];
	private readonly pendingTools = new Map<string, { tool: string; start: number; label: string }>();
	private currentAction: string | undefined;
	private currentActionId: string | undefined;
	private lastAction: string | undefined;
	private readonly described: string[] = [];
	private llmStart: number | undefined;
	private readonly startedAt = Date.now();
	private readonly onRow?: (row: ActionRow) => void;

	constructor(onRow?: (row: ActionRow) => void) {
		this.onRow = onRow;
	}

	/** Subscribe to a session's events. Returns the unsubscribe function. */
	attach(session: SessionLike): () => void {
		return session.subscribe((event) => this.ingest(event));
	}

	/** Feed one session event. Exposed for tests and custom plumbing. */
	ingest(raw: unknown): void {
		if (raw === null || typeof raw !== "object") return;
		const event = raw as SpanEvent;
		const now = Date.now();
		switch (event.type) {
			case "tool_execution_start": {
				if (event.toolCallId) {
					const label = describeAction(event.toolName ?? "unknown", event.args);
					this.pendingTools.set(event.toolCallId, { tool: event.toolName ?? "unknown", start: now, label });
					this.currentAction = label;
					this.currentActionId = event.toolCallId;
					this.described.push(this.currentAction);
					if (this.described.length > RECENT_KEPT) this.described.shift();
				}
				return;
			}
			case "tool_execution_end": {
				const pending = event.toolCallId ? this.pendingTools.get(event.toolCallId) : undefined;
				if (!pending) return;
				this.pendingTools.delete(event.toolCallId as string);
				if (event.toolCallId === this.currentActionId) {
					this.lastAction = this.currentAction;
					this.currentAction = undefined;
					this.currentActionId = undefined;
				}
				this.push({
					at: new Date(pending.start).toISOString(),
					kind: "tool",
					tool: pending.tool,
					label: pending.label === pending.tool ? undefined : pending.label,
					ms: now - pending.start,
					ok: event.isError !== true,
				});
				return;
			}
			case "message_start": {
				if (event.message?.role === "assistant") this.llmStart = now;
				return;
			}
			case "message_end": {
				if (event.message?.role !== "assistant" || this.llmStart === undefined) return;
				const start = this.llmStart;
				this.llmStart = undefined;
				this.push({ at: new Date(start).toISOString(), kind: "llm", ms: now - start });
				return;
			}
			default:
		}
	}

	private push(row: ActionRow): void {
		this.rows.push(row);
		this.onRow?.(row);
	}

	/** What the agent is doing right now, or undefined between actions. */
	get current(): string | undefined {
		return this.currentAction;
	}

	/**
	 * The in-flight action, or the most recently finished one. Between actions
	 * an agent is thinking about what it just did — for a status line, that
	 * action is still the honest answer to "what is it doing".
	 */
	get recent(): string | undefined {
		return this.currentAction ?? this.lastAction;
	}

	/** The last actions taken, oldest first, capped at RECENT_KEPT. */
	get recentActions(): string[] {
		return [...this.described];
	}

	/** Actions taken so far — tool executions only, the user-visible count. */
	get actions(): number {
		let count = 0;
		for (const row of this.rows) if (row.kind === "tool") count++;
		return count;
	}

	summary(): ActionSummary {
		const byTool: Record<string, ToolTotals> = {};
		let toolMs = 0;
		let llmMs = 0;
		let actions = 0;
		for (const row of this.rows) {
			if (row.kind === "llm") {
				llmMs += row.ms;
				continue;
			}
			actions++;
			toolMs += row.ms;
			const name = row.tool ?? "unknown";
			byTool[name] ??= { count: 0, ms: 0, errors: 0 };
			const totals = byTool[name];
			totals.count++;
			totals.ms += row.ms;
			if (row.ok === false) totals.errors++;
		}
		const slowest = [...this.rows].sort((a, b) => b.ms - a.ms).slice(0, SLOWEST_KEPT);
		return { wallMs: Date.now() - this.startedAt, actions, toolMs, llmMs, byTool, slowest };
	}
}

/** One line for a status row or thread listing: `42 actions · tool 63s · llm 41s`. */
export function describeSummary(summary: ActionSummary): string {
	const seconds = (ms: number) => `${Math.round(ms / 1000)}s`;
	return `${summary.actions} actions · tool ${seconds(summary.toolMs)} · llm ${seconds(summary.llmMs)}`;
}
