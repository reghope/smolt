import { describe, expect, test } from "vitest";
import { ActionMetrics, describeSummary } from "../src/core/action-metrics.ts";

/**
 * The recorder turns a session's event stream into timed spans: tool
 * executions and the assistant turns between them. These tests drive it with
 * synthetic events; timing precision is not asserted, only accounting.
 */

function feedToolSpan(metrics: ActionMetrics, id: string, tool: string, isError = false): void {
	metrics.ingest({ type: "tool_execution_start", toolCallId: id, toolName: tool });
	metrics.ingest({ type: "tool_execution_end", toolCallId: id, toolName: tool, isError });
}

describe("ActionMetrics", () => {
	test("tool spans are counted per tool with error totals", () => {
		const metrics = new ActionMetrics();
		feedToolSpan(metrics, "t1", "browse");
		feedToolSpan(metrics, "t2", "browse", true);
		feedToolSpan(metrics, "t3", "testlog");
		const summary = metrics.summary();
		expect(summary.actions).toBe(3);
		expect(summary.byTool.browse?.count).toBe(2);
		expect(summary.byTool.browse?.errors).toBe(1);
		expect(summary.byTool.testlog?.count).toBe(1);
		expect(metrics.actions).toBe(3);
	});

	test("assistant turns are measured as llm spans, other roles ignored", () => {
		const metrics = new ActionMetrics();
		metrics.ingest({ type: "message_start", message: { role: "assistant" } });
		metrics.ingest({ type: "message_end", message: { role: "assistant" } });
		metrics.ingest({ type: "message_start", message: { role: "user" } });
		metrics.ingest({ type: "message_end", message: { role: "user" } });
		const summary = metrics.summary();
		expect(summary.actions).toBe(0);
		expect(summary.llmMs).toBeGreaterThanOrEqual(0);
		// Exactly one llm row: the user message must not have opened a span.
		expect(summary.slowest.filter((row) => row.kind === "llm").length).toBe(1);
	});

	test("an end without a start, and unknown events, are ignored", () => {
		const metrics = new ActionMetrics();
		metrics.ingest({ type: "tool_execution_end", toolCallId: "ghost", toolName: "bash" });
		metrics.ingest({ type: "message_end", message: { role: "assistant" } });
		metrics.ingest({ type: "queue_update" });
		metrics.ingest(null);
		expect(metrics.summary().actions).toBe(0);
		expect(metrics.summary().slowest.length).toBe(0);
	});

	test("current names the in-flight action and clears when it ends", () => {
		const metrics = new ActionMetrics();
		expect(metrics.current).toBeUndefined();
		metrics.ingest({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "browse",
			args: { action: "goto", url: "https://smolt.dev/desktop" },
		});
		expect(metrics.current).toBe("browse: goto https://smolt.dev/desktop");
		metrics.ingest({ type: "tool_execution_end", toolCallId: "t1", toolName: "browse" });
		expect(metrics.current).toBeUndefined();
		// `recent` remembers what just finished — that's what a status line
		// shows while the model thinks about its next move.
		expect(metrics.recent).toBe("browse: goto https://smolt.dev/desktop");
	});

	test("a doing argument or a leading shell comment is the label itself", () => {
		const metrics = new ActionMetrics();
		metrics.ingest({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "browse",
			args: { action: "click", selector: ".docs", doing: "checking the docs button" },
		});
		expect(metrics.current).toBe("checking the docs button");
		metrics.ingest({ type: "tool_execution_end", toolCallId: "t1", toolName: "browse" });
		metrics.ingest({
			type: "tool_execution_start",
			toolCallId: "t2",
			toolName: "bash",
			args: { command: "# looking for the launch script\nls scripts" },
		});
		expect(metrics.current).toBe("looking for the launch script");
	});

	test("rows stream to the sink as they complete", () => {
		const rows: unknown[] = [];
		const metrics = new ActionMetrics((row) => rows.push(row));
		feedToolSpan(metrics, "t1", "browse");
		metrics.ingest({ type: "message_start", message: { role: "assistant" } });
		metrics.ingest({ type: "message_end", message: { role: "assistant" } });
		expect(rows.length).toBe(2);
		expect((rows[0] as { tool?: string }).tool).toBe("browse");
		expect((rows[1] as { kind?: string }).kind).toBe("llm");
	});

	test("slowest keeps the worst spans first", () => {
		const metrics = new ActionMetrics();
		for (let index = 0; index < 8; index++) feedToolSpan(metrics, `t${index}`, "bash");
		const summary = metrics.summary();
		expect(summary.slowest.length).toBe(5);
		for (let index = 1; index < summary.slowest.length; index++) {
			expect(summary.slowest[index - 1]!.ms).toBeGreaterThanOrEqual(summary.slowest[index]!.ms);
		}
	});

	test("describeSummary renders the one-line form", () => {
		const metrics = new ActionMetrics();
		feedToolSpan(metrics, "t1", "browse");
		expect(describeSummary(metrics.summary())).toMatch(/^1 actions · tool \d+s · llm \d+s$/);
	});
});
