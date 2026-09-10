import { fauxAssistantMessage } from "@smolt/ai";
import { afterEach, describe, expect, it } from "vitest";
import sessionNameExtension from "../../src/extensions/session-name/index.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("session-name extension", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("never names a chat on its first round", async () => {
		const harness = await createHarness({ extensionFactories: [sessionNameExtension] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Postgres connection pooling is set by max_connections.")]);

		await harness.session.prompt("How do I size a postgres connection pool?");

		expect(harness.sessionManager.getSessionName()).toBeUndefined();
		// No naming call was made: the turn's own response is all that was used.
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("names the chat once a second message has been sent", async () => {
		const harness = await createHarness({ extensionFactories: [sessionNameExtension] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Postgres connection pooling is set by max_connections.")]);
		await harness.session.prompt("How do I size a postgres connection pool?");

		harness.setResponses([
			fauxAssistantMessage("Start at 20 per worker."),
			fauxAssistantMessage('{"title": "Size a postgres connection pool"}'),
		]);
		await harness.session.prompt("and how many per worker?");

		expect(harness.sessionManager.getSessionName()).toBe("Size a postgres connection pool");
	});

	it("leaves a chat with no subject yet unnamed, and names it on a later turn", async () => {
		const harness = await createHarness({ extensionFactories: [sessionNameExtension] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("Hi. What are you working on?"),
			fauxAssistantMessage('{"title": "NONE"}'),
		]);

		await harness.session.prompt("hi");
		expect(harness.sessionManager.getSessionName()).toBeUndefined();

		harness.setResponses([
			fauxAssistantMessage("Set max_connections and use pgbouncer."),
			fauxAssistantMessage('{"title": "Size a postgres connection pool"}'),
		]);
		await harness.session.prompt("how do I size a postgres connection pool?");

		expect(harness.sessionManager.getSessionName()).toBe("Size a postgres connection pool");
	});

	it("refuses a reply that is a transcript label rather than a subject", async () => {
		const harness = await createHarness({ extensionFactories: [sessionNameExtension] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("Hi. What are you working on?"),
			fauxAssistantMessage('{"title": "User"}'),
		]);

		await harness.session.prompt("hi");

		expect(harness.sessionManager.getSessionName()).toBeUndefined();
	});

	it("leaves a session the reader already named alone", async () => {
		const harness = await createHarness({ extensionFactories: [sessionNameExtension] });
		harnesses.push(harness);
		harness.session.setSessionName("my chat");
		harness.setResponses([fauxAssistantMessage("Sure.")]);

		await harness.session.prompt("hello");

		expect(harness.sessionManager.getSessionName()).toBe("my chat");
		expect(harness.getPendingResponseCount()).toBe(0);
	});
});
