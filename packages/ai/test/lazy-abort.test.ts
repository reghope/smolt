import { describe, expect, it } from "vitest";
import { lazyStream } from "../src/api/lazy.ts";
import type { Api, Model } from "../src/types.ts";

/**
 * A cancelled request is not a failure. The harness aborts a turn to compact
 * when the context fills, and reporting that as an error put "API Error: This
 * operation was aborted" in the transcript every time it happened.
 */
const model = {
	id: "test-model",
	name: "Test",
	api: "openai-completions",
	provider: "test",
	baseUrl: "http://localhost",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
} as unknown as Model<Api>;

function abortError(message: string): Error {
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}

async function resultOf(error: Error) {
	const stream = lazyStream(model, () => Promise.reject(error));
	const events = [];
	for await (const event of stream) events.push(event);
	return { result: await stream.result(), events };
}

describe("lazyStream", () => {
	it("reports a cancelled request as stopped, with nothing to report", async () => {
		const { result, events } = await resultOf(abortError("This operation was aborted"));
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBeUndefined();
		expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
	});

	it("still reports a real failure as an error", async () => {
		const { result, events } = await resultOf(new Error("model server is down"));
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("model server is down");
		expect(events.at(-1)).toMatchObject({ type: "error", reason: "error" });
	});
});
