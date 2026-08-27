import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createTypedSpanStarter, NOOP_TELEMETRY_CONTEXT, type TelemetryContext } from "@smolt/telemetry";
import { describe, expect, expectTypeOf, it } from "vitest";
import { renderAgentTelemetrySchemaMarkdown } from "../../scripts/generate-telemetry-docs.ts";
import {
	AGENT_TELEMETRY_SCHEMAS,
	AI_TELEMETRY_SCHEMA,
	type AiSpanEndAttributes,
	type AiSpanStartAttributes,
	HARNESS_TELEMETRY_SCHEMA,
	type HarnessSpanEndAttributes,
	type HarnessSpanStartAttributes,
	startAiSpan,
	startHarnessSpan,
} from "../../src/harness/telemetry.ts";

describe("agent telemetry schemas", () => {
	it("serializes both schemas and generates the checked-in reference", () => {
		expect(() => JSON.stringify(AI_TELEMETRY_SCHEMA)).not.toThrow();
		expect(() => JSON.stringify(HARNESS_TELEMETRY_SCHEMA)).not.toThrow();
		expect(AGENT_TELEMETRY_SCHEMAS).toEqual([AI_TELEMETRY_SCHEMA, HARNESS_TELEMETRY_SCHEMA]);
		expect(Object.keys(HARNESS_TELEMETRY_SCHEMA.spans)).toEqual([
			"smolt.harness.run",
			"smolt.harness.compaction",
			"smolt.harness.navigation",
			"smolt.harness.checkpoint",
			"smolt.harness.turn",
			"smolt.harness.step",
			"smolt.harness.tool",
			"smolt.harness.hook",
			"smolt.harness.sleep",
			"smolt.harness.event_handler",
			"smolt.session.write",
		]);
		const actual = readFileSync(resolve(import.meta.dirname, "../../docs/telemetry-schema.md"), "utf8");
		expect(actual).toBe(renderAgentTelemetrySchemaMarkdown());
	});

	it("starts AI-request and harness spans through one composed typed starter", async () => {
		const startSpan = createTypedSpanStarter(NOOP_TELEMETRY_CONTEXT, AGENT_TELEMETRY_SCHEMAS);
		await startSpan(
			"smolt.harness.step",
			{
				"smolt.lane.name": "main",
				"smolt.operation.id": "operation",
				"smolt.step.kind": "assistant",
				"smolt.step.attempt": 1,
			},
			async (stepSpan, startChildSpan) => {
				stepSpan.setAttributes({ "smolt.step.outcome": "succeeded" });
				await startChildSpan(
					"smolt.ai.request",
					{
						"smolt.ai.operation": "stream",
						"smolt.ai.provider": "provider",
						"smolt.ai.model": "model",
						"smolt.ai.api": "api",
						"smolt.ai.streaming": true,
					},
					(requestSpan) => {
						requestSpan.setAttributes({ "smolt.ai.response.stop_reason": "stop" });
					},
				);
			},
		);
	});

	it("infers exact AI start and optional end attributes", async () => {
		type Start = AiSpanStartAttributes<"smolt.ai.request">;
		type End = AiSpanEndAttributes<"smolt.ai.request">;
		expectTypeOf<Start>().toMatchTypeOf<{
			"smolt.ai.operation": "stream" | "fetch_deferred" | "cancel_deferred" | "generate_images";
			"smolt.ai.provider": string;
			"smolt.ai.model": string;
			"smolt.ai.api": string;
			"smolt.ai.streaming": boolean;
			"smolt.ai.deferred"?: boolean;
		}>();
		expectTypeOf<End["smolt.ai.response.stop_reason"]>().toEqualTypeOf<
			"stop" | "length" | "tool_use" | "error" | "aborted" | "deferred" | undefined
		>();

		const telemetryContext: TelemetryContext = NOOP_TELEMETRY_CONTEXT;
		await startAiSpan(
			telemetryContext,
			"smolt.ai.request",
			{
				"smolt.ai.operation": "stream",
				"smolt.ai.provider": "provider",
				"smolt.ai.model": "model",
				"smolt.ai.api": "api",
				"smolt.ai.streaming": true,
			},
			(span) => {
				span.setAttributes({ "smolt.ai.response.stop_reason": "tool_use" });
				// @ts-expect-error smolt.ai.request declares no span events
				span.addEvent("chunk");
			},
		);

		const compileTimeFailures = () => {
			const extraAttributes = {
				"smolt.ai.operation": "stream",
				"smolt.ai.provider": "provider",
				"smolt.ai.model": "model",
				"smolt.ai.api": "api",
				"smolt.ai.streaming": true,
				"smolt.ai.unknown": true,
			} as const;
			// @ts-expect-error variables with unknown attributes are rejected
			void startAiSpan(telemetryContext, "smolt.ai.request", extraAttributes, () => {});
			// @ts-expect-error missing required start attributes
			void startAiSpan(telemetryContext, "smolt.ai.request", { "smolt.ai.operation": "stream" }, () => {});
		};
		expectTypeOf(compileTimeFailures).toBeFunction();
	});

	it("infers per-span harness literals and optional completion enrichment", async () => {
		type RunStart = HarnessSpanStartAttributes<"smolt.harness.run">;
		type RunEnd = HarnessSpanEndAttributes<"smolt.harness.run">;
		expectTypeOf<RunStart["smolt.operation.kind"]>().toEqualTypeOf<"run">();
		expectTypeOf<RunEnd["smolt.operation.outcome"]>().toEqualTypeOf<
			"completed" | "aborted" | "failed" | "suspended" | undefined
		>();

		const telemetryContext: TelemetryContext = NOOP_TELEMETRY_CONTEXT;
		await startHarnessSpan(
			telemetryContext,
			"smolt.harness.run",
			{
				"smolt.session.id": "session",
				"smolt.lane.name": "main",
				"smolt.operation.id": "operation",
				"smolt.operation.kind": "run",
				"smolt.operation.recovery": false,
			},
			(span) => {
				span.setAttributes({ "smolt.operation.outcome": "completed" });
				span.setAttributes({});
				// @ts-expect-error the harness schema declares no span events
				span.addEvent("result");
			},
		);

		const compileTimeFailures = () => {
			const extraRunAttributes = {
				"smolt.session.id": "session",
				"smolt.lane.name": "main",
				"smolt.operation.id": "operation",
				"smolt.operation.kind": "run",
				"smolt.operation.recovery": false,
				"smolt.unknown": true,
			} as const;
			// @ts-expect-error variables with unknown attributes are rejected
			void startHarnessSpan(telemetryContext, "smolt.harness.run", extraRunAttributes, () => {});
			void startHarnessSpan(
				telemetryContext,
				"smolt.harness.checkpoint",
				{
					"smolt.lane.name": "main",
					"smolt.operation.id": "operation",
					"smolt.checkpoint.kind": "normal",
				},
				(span) => {
					// @ts-expect-error empty end schemas reject every attribute
					span.setAttributes({ "smolt.unknown": true });
				},
			);
			void startHarnessSpan(
				telemetryContext,
				"smolt.harness.run",
				{
					"smolt.session.id": "session",
					"smolt.lane.name": "main",
					"smolt.operation.id": "operation",
					// @ts-expect-error run spans accept only the run operation kind
					"smolt.operation.kind": "navigation",
					"smolt.operation.recovery": false,
				},
				() => {},
			);
			// @ts-expect-error missing required run start attributes
			void startHarnessSpan(telemetryContext, "smolt.harness.run", {}, () => {});
		};
		expectTypeOf(compileTimeFailures).toBeFunction();
	});
});
