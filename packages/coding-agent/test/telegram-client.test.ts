import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	chunkMessage,
	type InboundMessage,
	loadTelegramConfig,
	markdownToPlain,
	saveTelegramConfig,
	TELEGRAM_MESSAGE_LIMIT,
	TelegramClient,
	TelegramConflictError,
	TelegramPoller,
	type TelegramUpdate,
} from "../src/extensions/telegram/client.ts";

/**
 * Offline unit tests for the telegram client layer: message chunking, config
 * persistence, the Bot API client against a fake fetch, and the long-poll
 * loop's delivery, filtering, and shutdown behavior.
 */

interface RecordedCall {
	method: string;
	body: Record<string, unknown>;
}

function fakeFetch(routes: Record<string, (body: Record<string, unknown>, init?: RequestInit) => unknown>): {
	fetchImpl: typeof fetch;
	calls: RecordedCall[];
} {
	const calls: RecordedCall[] = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const method = url.slice(url.lastIndexOf("/") + 1);
		const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
		calls.push({ method, body });
		const route = routes[method];
		if (!route) return new Response(JSON.stringify({ ok: false, description: `no route for ${method}` }));
		const result = await route(body, init);
		if (result instanceof Response) return result;
		return new Response(JSON.stringify({ ok: true, result }));
	}) as typeof fetch;
	return { fetchImpl, calls };
}

/** A promise that rejects (like an aborted fetch) when the request's signal aborts. */
function pendingUntilAbort(init?: RequestInit): Promise<never> {
	return new Promise((_resolve, reject) => {
		init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
	});
}

describe("chunkMessage", () => {
	test("short messages pass through unchanged", () => {
		expect(chunkMessage("hello")).toEqual(["hello"]);
	});

	test("long messages split at newline boundaries under the limit", () => {
		const first = "a".repeat(3000);
		const second = "b".repeat(3000);
		const chunks = chunkMessage(`${first}\n${second}`);
		expect(chunks).toEqual([first, second]);
	});

	test("unbroken text hard-splits at the limit", () => {
		const chunks = chunkMessage("x".repeat(TELEGRAM_MESSAGE_LIMIT + 10));
		expect(chunks).toHaveLength(2);
		expect(chunks[0]).toHaveLength(TELEGRAM_MESSAGE_LIMIT);
		expect(chunks[1]).toHaveLength(10);
	});
});

describe("markdownToPlain", () => {
	test("drops emphasis, heading, and quote markers but keeps the words", () => {
		expect(markdownToPlain("# Results\n\n**All tests pass** — *nice*.\n> quoted")).toBe(
			"Results\n\nAll tests pass — nice.\nquoted",
		);
	});

	test("links keep label and address; bullets become dots; fences keep their body", () => {
		expect(markdownToPlain("- See [the docs](https://d.example)\n\n```js\nconst x = 1;\n```")).toBe(
			"• See the docs (https://d.example)\n\nconst x = 1;",
		);
	});

	test("leaves plain text alone", () => {
		expect(markdownToPlain("Two cabins shortlisted. Prices from £180/night.")).toBe(
			"Two cabins shortlisted. Prices from £180/night.",
		);
	});
});

describe("config persistence", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "telegram-config-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("round-trips and tolerates a missing or corrupt file", () => {
		const path = join(dir, "telegram.json");
		expect(loadTelegramConfig(path)).toBeUndefined();
		saveTelegramConfig(path, { token: "t", chatId: 42, chatName: "Rob", enabled: true, lastUpdateId: 7 });
		expect(loadTelegramConfig(path)).toMatchObject({ token: "t", chatId: 42, chatName: "Rob", lastUpdateId: 7 });
		saveTelegramConfig(join(dir, "bad.json"), { token: "t", chatId: 1, enabled: true });
		expect(loadTelegramConfig(join(dir, "missing.json"))).toBeUndefined();
	});
});

describe("TelegramClient", () => {
	test("sendMessage chunks long text into multiple API calls", async () => {
		const { fetchImpl, calls } = fakeFetch({ sendMessage: () => ({ message_id: 1 }) });
		const client = new TelegramClient("tok", fetchImpl);
		const sent = await client.sendMessage(42, "x".repeat(TELEGRAM_MESSAGE_LIMIT + 1));
		expect(sent).toEqual({ chunks: 2, messageIds: [1, 1] });
		expect(calls).toHaveLength(2);
		expect(calls[0]).toMatchObject({ method: "sendMessage", body: { chat_id: 42 } });
	});

	test("surfaces API errors and 409 conflicts distinctly", async () => {
		const { fetchImpl } = fakeFetch({
			getMe: () => new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), { status: 401 }),
			getUpdates: () => new Response("{}", { status: 409 }),
		});
		const client = new TelegramClient("tok", fetchImpl);
		await expect(client.getMe()).rejects.toThrow("Unauthorized");
		await expect(client.getUpdates(0, 0)).rejects.toBeInstanceOf(TelegramConflictError);
	});
});

describe("TelegramPoller", () => {
	test("delivers linked-chat messages, filters others, acks, and stops cleanly", async () => {
		const update = (id: number, chatId: number, text: string): TelegramUpdate => ({
			update_id: id,
			message: { message_id: id, text, chat: { id: chatId, first_name: "Rob" }, from: { first_name: "Rob" } },
		});
		let served = false;
		const { fetchImpl, calls } = fakeFetch({
			getUpdates: (_body, init) => {
				if (served) return pendingUntilAbort(init);
				served = true;
				return [update(5, 42, "take the shortlist ticket"), update(6, 99, "wrong chat")];
			},
		});
		const received: InboundMessage[] = [];
		const acked: number[] = [];
		const poller = new TelegramPoller({
			client: new TelegramClient("tok", fetchImpl),
			chatId: 42,
			initialOffset: 3,
			onMessage: (message) => received.push(message),
			onAck: (id) => acked.push(id),
		});
		poller.start();
		await vi.waitFor(() => expect(received).toHaveLength(1));
		expect(received[0]).toEqual({ text: "take the shortlist ticket", from: "Rob", messageId: 5 });
		expect(acked).toEqual([6]);
		expect(poller.status).toBe("connected");
		expect(calls[0]!.body.offset).toBe(3);
		poller.stop();
		expect(poller.status).toBe("stopped");
	});

	test("a 409 conflict sets status and stop() interrupts the backoff wait", async () => {
		const { fetchImpl } = fakeFetch({ getUpdates: () => new Response("{}", { status: 409 }) });
		const poller = new TelegramPoller({
			client: new TelegramClient("tok", fetchImpl),
			chatId: 42,
			onMessage: () => {},
		});
		poller.start();
		await vi.waitFor(() => expect(poller.status).toBe("conflict"));
		poller.stop();
		expect(poller.status).toBe("stopped");
	});
});
