import type { AssistantMessage } from "@smolt/ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { createDegenerationGuard } from "../src/extensions/degeneration/index.ts";
import { createHarnessWithExtensions, type Harness } from "./test-harness.ts";

/**
 * End-to-end: the degeneration guard against a real AgentSession with the
 * faux streaming provider. The faux stream ignores abort signals and always
 * completes — which exercises the important property that the retry keys on
 * the extension's request, not on stopReason "aborted".
 */

const LOOP = "I need to make sure the system understands this entire request.\n\n".repeat(20);

function guardFactory(maxRetries = 1): (smolt: ExtensionAPI) => void {
	return (smolt) => createDegenerationGuard(smolt, { enabled: true, maxRetries, minRepeats: 10 });
}

function assistantTexts(harness: Harness): (string | undefined)[] {
	return harness.session.messages
		.filter((m): m is AssistantMessage => m.role === "assistant")
		.map((m) => m.content.find((c) => c.type === "text")?.text);
}

describe("degeneration guard end-to-end", () => {
	let harness: Harness;

	afterEach(() => {
		harness?.cleanup();
	});

	it("aborts a degenerate response and recovers on the retry", async () => {
		harness = await createHarnessWithExtensions({
			extensionFactories: [guardFactory()],
			responses: [LOOP, "recovered"],
		});

		await harness.session.prompt("hi");

		expect(harness.faux.callCount).toBe(2);
		const retries = harness.eventsOfType("auto_retry_start");
		expect(retries).toHaveLength(1);
		expect(retries[0]!.errorMessage).toContain("Degenerate output detected");
		// The degenerate response was dropped from agent state; the retry stands.
		expect(assistantTexts(harness)).toEqual(["recovered"]);
	});

	it("gives up visibly when the retry degenerates too", async () => {
		harness = await createHarnessWithExtensions({
			extensionFactories: [guardFactory()],
			responses: [LOOP, LOOP],
		});

		await harness.session.prompt("hi");

		expect(harness.faux.callCount).toBe(2);
		const ends = harness.eventsOfType("auto_retry_end");
		expect(ends).toHaveLength(1);
		expect(ends[0]!.success).toBe(false);
		expect(ends[0]!.finalError).toContain("Retry limit reached");
	});

	it("leaves clean responses untouched", async () => {
		harness = await createHarnessWithExtensions({
			extensionFactories: [guardFactory()],
			responses: ["a perfectly ordinary answer"],
		});

		await harness.session.prompt("hi");

		expect(harness.faux.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
		expect(assistantTexts(harness)).toEqual(["a perfectly ordinary answer"]);
	});

	it("a fresh user prompt restores the retry budget", async () => {
		harness = await createHarnessWithExtensions({
			extensionFactories: [guardFactory()],
			responses: [LOOP, "first recovery", LOOP, "second recovery"],
		});

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		expect(harness.faux.callCount).toBe(4);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(2);
		expect(assistantTexts(harness)).toEqual(["first recovery", "second recovery"]);
	});
});
