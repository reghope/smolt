import { createModels, fauxProvider } from "@smolt/ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { DEFAULT_MARK_MS, isLimitError, isModelUnavailableError, markUntil } from "../../src/extensions/pool/errors.ts";
import { createPoolExtension, POOL_RETRY_PROMPT } from "../../src/extensions/pool/index.ts";
import {
	emptyPoolData,
	isCapExceeded,
	isMarkedUnavailable,
	orderedChain,
	POOL_PRIMARY_ID,
	type PoolCredential,
	type PoolData,
	PoolStore,
} from "../../src/extensions/pool/storage.ts";
import { effectiveWindow, exceedsCap, recordUsage } from "../../src/extensions/pool/windows.ts";
import { nextCandidate, selectAttemptOrder, wrapProviderWithPool } from "../../src/extensions/pool/wrapper.ts";
import type { ExtensionAPI } from "../../src/index.ts";

const PROVIDER = "faux";

function poolData(overrides: Partial<PoolData>): PoolData {
	return { ...emptyPoolData(), ...overrides };
}

function apiKeyEntry(id: string, label?: string, caps?: PoolCredential["caps"]): PoolCredential {
	return { id, type: "api_key", key: `key-${id}`, label, addedAt: 0, caps };
}

function seedPool(entries: PoolCredential[], activeId?: string): PoolStore {
	const store = new PoolStore();
	store.modify((data) => ({
		result: undefined,
		next: { ...data, providers: { [PROVIDER]: { credentials: entries, activeId } } },
	}));
	return store;
}

function assistantMessage(provider: string, fields: { stopReason: string; errorMessage?: string; tokens?: number }) {
	return {
		role: "assistant",
		provider,
		content: [],
		stopReason: fields.stopReason,
		errorMessage: fields.errorMessage,
		usage: {
			input: 0,
			output: fields.tokens ?? 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: fields.tokens ?? 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

class FakeSmolt {
	handlers = new Map<string, Array<(event: Record<string, unknown>, ctx?: unknown) => Promise<unknown>>>();
	sentMessages: string[] = [];
	registeredProviders: unknown[] = [];
	unregistered: string[] = [];
	commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>();

	on(event: string, handler: (event: Record<string, unknown>, ctx?: unknown) => Promise<unknown>): void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
	}

	registerProvider(provider: unknown): void {
		this.registeredProviders.push(provider);
	}

	unregisterProvider(name: string): void {
		this.unregistered.push(name);
	}

	registerCommand(
		name: string,
		options: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> },
	): void {
		this.commands.set(name, options);
	}

	sendUserMessage(content: string): void {
		this.sentMessages.push(content);
	}

	async fire(event: string, payload: Record<string, unknown> = {}, ctx?: unknown): Promise<unknown> {
		let result: unknown;
		for (const handler of this.handlers.get(event) ?? []) {
			result = await handler({ type: event, ...payload }, ctx);
		}
		return result;
	}
}

/** Command-context fixture: scripted input answers, first-option selects. */
function commandFixture(store: PoolStore, inputs: (string | undefined)[]) {
	const smolt = new FakeSmolt();
	createPoolExtension({ store })(smolt as unknown as ExtensionAPI);
	const notices: string[] = [];
	const ctx = {
		mode: "tui",
		ui: {
			notify: (message: string) => notices.push(message),
			input: async () => inputs.shift(),
			select: async (_title: string, options: string[]) => options[0],
			confirm: async () => true,
		},
		modelRegistry: {
			getAll: () => [{ provider: PROVIDER, id: "faux-1" }],
			getProvider: () => undefined,
			find: () => undefined,
			hasConfiguredAuth: () => false,
		},
		model: undefined,
		sessionManager: { getEntries: () => [] },
	};
	const run = (args: string) => smolt.commands.get("pool")!.handler(args, ctx);
	return { smolt, notices, run };
}

describe("/pool command safety", () => {
	it("add-key refuses a key pasted on the command line and stores nothing", async () => {
		const store = new PoolStore();
		const { notices, run } = commandFixture(store, []);
		await run("add-key faux sk-abc123def456ghi789jkl012mno");
		expect(notices.join("\n")).toContain("rotate");
		expect(store.read().providers.faux).toBeUndefined();
	});

	it("add-key collects the key via a prompt, with the args as label only", async () => {
		const store = new PoolStore();
		const { run } = commandFixture(store, ["real-key-123"]);
		await run("add-key faux work");
		const pool = store.read().providers.faux;
		expect(pool?.credentials[0]?.key).toBe("real-key-123");
		expect(pool?.credentials[0]?.label).toBe("work");
	});

	it("an empty key answer is refused with a message, not swallowed", async () => {
		const store = new PoolStore();
		const { notices, run } = commandFixture(store, [""]);
		await run("add-key faux");
		expect(notices.join("\n")).toContain("No key entered");
		expect(store.read().providers.faux).toBeUndefined();
	});

	it("removing the last credential prunes the provider, its ledger, and its marks", async () => {
		const store = seedPool([apiKeyEntry("a")], "a");
		store.modify((data) => ({
			result: undefined,
			next: {
				...data,
				ledger: { a: { "5h": { start: 1, requests: 1, tokens: 1 } } },
				unavailable: { a: { until: 9e15, reason: "x" } },
			},
		}));
		const { run } = commandFixture(store, []);
		await run("remove faux");
		const data = store.read();
		expect(data.providers.faux).toBeUndefined();
		expect(data.ledger.a).toBeUndefined();
		expect(data.unavailable.a).toBeUndefined();
	});
});

function driverFixture(store: PoolStore, baseProvider: ReturnType<typeof fauxProvider>["provider"]) {
	const smolt = new FakeSmolt();
	createPoolExtension({ store })(smolt as unknown as ExtensionAPI);
	const notifications: string[] = [];
	const ctx = {
		mode: "tui",
		isIdle: () => true,
		hasPendingMessages: () => false,
		ui: { notify: (message: string) => notifications.push(message) },
		modelRegistry: { getProvider: () => baseProvider, getAll: () => [] },
		sessionManager: { getEntries: () => [] },
	};
	return { smolt, notifications, ctx };
}

describe("pool window math", () => {
	it("rolls a window forward once its duration has passed", () => {
		const start = 1_000_000;
		const fiveHours = 5 * 60 * 60 * 1000;
		const usage = { start, requests: 3, tokens: 300 };
		expect(effectiveWindow(usage, "5h", start + fiveHours - 1)).toEqual(usage);
		expect(effectiveWindow(usage, "5h", start + fiveHours)).toEqual({
			start: start + fiveHours,
			requests: 0,
			tokens: 0,
		});
		expect(effectiveWindow(undefined, "weekly", start)).toEqual({ start, requests: 0, tokens: 0 });
	});

	it("records usage into the current window", () => {
		const start = 1_000_000;
		const first = recordUsage(undefined, "5h", start, 100);
		expect(first).toEqual({ start, requests: 1, tokens: 100 });
		const second = recordUsage({ "5h": first }, "5h", start + 1000, 50);
		expect(second).toEqual({ start, requests: 2, tokens: 150 });
	});

	it("exceedsCap triggers on either dimension", () => {
		const state = { start: 0, requests: 5, tokens: 1000 };
		expect(exceedsCap(state, { requests: 5 })).toBe(true);
		expect(exceedsCap(state, { requests: 6 })).toBe(false);
		expect(exceedsCap(state, { tokens: 1000 })).toBe(true);
		expect(exceedsCap(state, {})).toBe(false);
	});
});

describe("pool error classification", () => {
	it("classifies limit errors", () => {
		expect(isLimitError("You have hit your usage limit. Your limit will reset at 5pm")).toBe(true);
		expect(isLimitError("429 too many requests")).toBe(true);
		expect(isLimitError("rate limit exceeded")).toBe(true);
		expect(isLimitError("insufficient_quota: you exceeded your current quota")).toBe(true);
		expect(isLimitError("Something broke")).toBe(false);
		expect(isLimitError(undefined)).toBe(false);
	});

	it("classifies model availability errors separately from limit errors", () => {
		expect(isModelUnavailableError("Organization does not have access to model claude-opus-4")).toBe(true);
		expect(isModelUnavailableError("model not found")).toBe(true);
		expect(isModelUnavailableError("usage limit reached")).toBe(false);
	});

	it("extracts relative and absolute reset times", () => {
		const now = Date.UTC(2025, 5, 10, 12, 0, 0);
		expect(markUntil("try again in 25 minutes", now)).toBe(now + 25 * 60 * 1000);
		expect(markUntil("resets in 2 hours", now)).toBe(now + 2 * 60 * 60 * 1000);
		// "resets at 5pm" -> next 17:00 local occurrence (test runs in local time).
		const localNow = new Date(2025, 5, 10, 12, 0, 0).getTime();
		const until = markUntil("Your limit will reset at 5pm", localNow);
		expect(until).toBe(new Date(2025, 5, 10, 17, 0, 0).getTime());
		// No stated reset -> short default mark.
		expect(markUntil("usage limit reached", localNow)).toBe(localNow + DEFAULT_MARK_MS);
	});
});

describe("pool selection", () => {
	const entries = [apiKeyEntry("e1", "one"), apiKeyEntry("e2", "two")];

	it("chains primary first when nothing is active", () => {
		const chain = orderedChain(poolData({ providers: { faux: { credentials: entries } } }), PROVIDER);
		expect(chain.map((step) => step.id)).toEqual([POOL_PRIMARY_ID, "e1", "e2"]);
	});

	it("rotates the chain to the active credential", () => {
		const chain = orderedChain(poolData({ providers: { faux: { credentials: entries, activeId: "e2" } } }), PROVIDER);
		expect(chain.map((step) => step.id)).toEqual(["e2", POOL_PRIMARY_ID, "e1"]);
	});

	it("demotes marked credentials behind clean ones but keeps a clean active first", () => {
		const now = Date.now();
		const data = poolData({
			providers: { faux: { credentials: entries } },
			unavailable: { e1: { until: now + 60_000, reason: "limit" } },
		});
		expect(selectAttemptOrder(data, PROVIDER, now).map((step) => step.id)).toEqual([POOL_PRIMARY_ID, "e2", "e1"]);

		const activeMarked = poolData({
			providers: { faux: { credentials: entries, activeId: "e1" } },
			unavailable: { e1: { until: now + 60_000, reason: "limit" } },
		});
		// Active is dirty but e2 is clean: clean candidates lead, keeping the
		// rotated order ("next in the list" after e1 is e2, then the primary).
		expect(selectAttemptOrder(activeMarked, PROVIDER, now).map((step) => step.id)).toEqual([
			"e2",
			POOL_PRIMARY_ID,
			"e1",
		]);
	});

	it("keeps the original rotation when nothing is clean (the attempt is the test)", () => {
		const now = Date.now();
		const data = poolData({
			providers: { faux: { credentials: entries } },
			unavailable: {
				[POOL_PRIMARY_ID]: { until: now + 60_000, reason: "limit" },
				e1: { until: now + 60_000, reason: "limit" },
				e2: { until: now + 60_000, reason: "limit" },
			},
		});
		expect(selectAttemptOrder(data, PROVIDER, now).map((step) => step.id)).toEqual([POOL_PRIMARY_ID, "e1", "e2"]);
		expect(isMarkedUnavailable(data, "e2", now)).toBe(true);
	});

	it("skips cap-exceeded credentials proactively", () => {
		const now = Date.now();
		const data = poolData({
			providers: {
				faux: {
					credentials: [apiKeyEntry("e1", "one", { "5h": { requests: 2 } }), apiKeyEntry("e2", "two")],
					activeId: "e1",
				},
			},
			ledger: { e1: { "5h": { start: now, requests: 2, tokens: 0 } } },
		});
		expect(isCapExceeded(data, { id: "e1", entry: data.providers[PROVIDER].credentials[0] }, now)).toBe(true);
		expect(selectAttemptOrder(data, PROVIDER, now).map((step) => step.id)).toEqual(["e2", POOL_PRIMARY_ID, "e1"]);
	});

	it("finds the next candidate after a failure", () => {
		const now = Date.now();
		const data = poolData({ providers: { faux: { credentials: entries } } });
		expect(nextCandidate(data, PROVIDER, POOL_PRIMARY_ID, new Set(["e1"]), now)?.id).toBe("e2");
		expect(nextCandidate(data, PROVIDER, "e2", new Set<string>(), now)?.id).toBe(POOL_PRIMARY_ID);
	});
});

describe("pool wrapper auth resolution", () => {
	it("resolves the primary until it is marked, then rotates through the pool", async () => {
		const store = seedPool([apiKeyEntry("e1", "one"), apiKeyEntry("e2", "two")]);
		const faux = fauxProvider({ provider: PROVIDER });
		const resolved: string[] = [];
		const wrapper = wrapProviderWithPool(faux.provider, store, {
			noteResolved: (_providerId, credentialId) => resolved.push(credentialId),
			noteRotation: () => {},
		});
		const credentials = AuthStorage.inMemory();
		await credentials.modify(PROVIDER, async () => ({ type: "api_key", key: "primary-key" }));
		const models = createModels({ credentials });
		models.setProvider(wrapper);

		// Primary credential first.
		expect((await models.getAuth(PROVIDER))?.auth.apiKey).toBeUndefined();
		expect(resolved).toEqual([POOL_PRIMARY_ID]);

		// Mark the primary down: the next resolutions use the first pool credential.
		const now = Date.now();
		store.modify((data) => ({
			result: undefined,
			next: {
				...data,
				unavailable: { ...data.unavailable, [POOL_PRIMARY_ID]: { until: now + 60_000, reason: "limit" } },
			},
		}));
		await models.getAuth(PROVIDER);
		expect(resolved).toEqual([POOL_PRIMARY_ID, "e1"]);
		expect((await models.getAuth(PROVIDER))?.source).toContain("one");
		expect(resolved).toEqual([POOL_PRIMARY_ID, "e1", "e1"]);

		// Mark everything: the attempt is the test, so the primary is attempted again.
		store.modify((data) => ({
			result: undefined,
			next: {
				...data,
				unavailable: {
					...data.unavailable,
					e1: { until: now + 60_000, reason: "limit" },
					e2: { until: now + 60_000, reason: "limit" },
				},
			},
		}));
		await models.getAuth(PROVIDER);
		expect(resolved).toEqual([POOL_PRIMARY_ID, "e1", "e1", POOL_PRIMARY_ID]);
	});

	it("rotates on proactive caps before the wall is hit", async () => {
		const now = Date.now();
		const store = seedPool([apiKeyEntry("e1", "one", { "5h": { requests: 1 } }), apiKeyEntry("e2", "two")], "e1");
		store.modify((data) => ({
			result: undefined,
			next: { ...data, ledger: { e1: { "5h": { start: now, requests: 1, tokens: 0 } } } },
		}));
		const faux = fauxProvider({ provider: PROVIDER });
		const resolved: string[] = [];
		const wrapper = wrapProviderWithPool(faux.provider, store, {
			noteResolved: (_providerId, credentialId) => resolved.push(credentialId),
			noteRotation: () => {},
		});
		const credentials = AuthStorage.inMemory();
		await credentials.modify(PROVIDER, async () => ({ type: "api_key", key: "primary-key" }));
		const models = createModels({ credentials });
		models.setProvider(wrapper);

		await models.getAuth(PROVIDER);
		expect(resolved).toEqual(["e2"]);
	});
});

describe("pool driver", () => {
	const entries = [apiKeyEntry("e1", "one"), apiKeyEntry("e2", "two")];

	it("registers a wrapper provider for pooled providers", () => {
		const store = seedPool(entries);
		const { smolt, ctx } = driverFixture(store, fauxProvider({ provider: PROVIDER }).provider);
		smolt.fire("before_agent_start", {}, ctx);
		expect(smolt.registeredProviders).toHaveLength(1);
	});

	it("marks the failed credential and re-issues after a limit error", async () => {
		const store = seedPool(entries);
		const { smolt, notifications, ctx } = driverFixture(store, fauxProvider({ provider: PROVIDER }).provider);
		await smolt.fire("before_agent_start", {}, ctx);
		await smolt.fire(
			"message_end",
			{ message: assistantMessage(PROVIDER, { stopReason: "error", errorMessage: "usage limit reached" }) },
			ctx,
		);
		expect(store.read().unavailable[POOL_PRIMARY_ID]).toBeDefined();
		await smolt.fire("agent_settled", {}, ctx);
		expect(smolt.sentMessages).toEqual([POOL_RETRY_PROMPT]);
		expect(notifications.some((message) => message.includes("retrying with"))).toBe(true);
	});

	it("exhausts without re-issuing when every credential has failed", async () => {
		const store = seedPool(entries);
		const { smolt, notifications, ctx } = driverFixture(store, fauxProvider({ provider: PROVIDER }).provider);
		await smolt.fire("before_agent_start", {}, ctx);
		for (const _attempt of [1, 2, 3]) {
			await smolt.fire(
				"message_end",
				{ message: assistantMessage(PROVIDER, { stopReason: "error", errorMessage: "usage limit reached" }) },
				ctx,
			);
			await smolt.fire("agent_settled", {}, ctx);
		}
		// Re-issues after failures one and two only; the third settles exhausted.
		expect(smolt.sentMessages).toEqual([POOL_RETRY_PROMPT, POOL_RETRY_PROMPT]);
		expect(notifications.some((message) => message.includes("All 3 credentials"))).toBe(true);
	});

	it("makes the working credential sticky and records usage on success", async () => {
		const store = seedPool(entries);
		const { smolt, ctx } = driverFixture(store, fauxProvider({ provider: PROVIDER }).provider);
		await smolt.fire("before_agent_start", {}, ctx);
		await smolt.fire(
			"message_end",
			{ message: assistantMessage(PROVIDER, { stopReason: "error", errorMessage: "usage limit reached" }) },
			ctx,
		);
		await smolt.fire("agent_settled", {}, ctx);
		await smolt.fire(
			"message_end",
			{ message: assistantMessage(PROVIDER, { stopReason: "stop", tokens: 123 }) },
			ctx,
		);

		const data = store.read();
		expect(data.providers[PROVIDER]?.activeId).toBe("e1");
		expect(data.ledger.e1?.["5h"]?.tokens).toBe(123);
		// A success clears the failure cascade state.
		expect(smolt.sentMessages).toEqual([POOL_RETRY_PROMPT]);
	});

	it("does not rotate on model-availability errors and points at /pool model", async () => {
		const store = seedPool(entries);
		const { smolt, notifications, ctx } = driverFixture(store, fauxProvider({ provider: PROVIDER }).provider);
		await smolt.fire("before_agent_start", {}, ctx);
		await smolt.fire(
			"message_end",
			{
				message: assistantMessage(PROVIDER, {
					stopReason: "error",
					errorMessage: "does not have access to model faux-1",
				}),
			},
			ctx,
		);
		await smolt.fire("agent_settled", {}, ctx);
		expect(smolt.sentMessages).toEqual([]);
		expect(store.read().unavailable[POOL_PRIMARY_ID]).toBeUndefined();
		expect(notifications.some((message) => message.includes("/pool model"))).toBe(true);
	});
});
