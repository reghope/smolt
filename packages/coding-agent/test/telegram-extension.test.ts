import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { loadTelegramConfig, saveTelegramConfig, type TelegramUpdate } from "../src/extensions/telegram/client.ts";
import { createTelegramExtension, type TelegramHandle } from "../src/extensions/telegram/index.ts";

/**
 * Wiring tests for the telegram extension: outbound tool dispatch, the
 * inbound poll loop feeding sendUserMessage, the /telegram command's
 * status/on/off/test paths, and the full guided setup flow — all against a
 * fake fetch, offline.
 */

interface RegisteredTool {
	name: string;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: unknown,
		onUpdate?: unknown,
		ctx?: unknown,
	): Promise<{ content: { type: string; text: string }[] }>;
}

interface RegisteredCommand {
	description?: string;
	getArgumentCompletions?: (prefix: string) => Array<{ value: string }>;
	handler: (args: string, ctx: unknown) => Promise<void>;
}

class FakeSmolt {
	handlers = new Map<string, ((event: Record<string, unknown>, ctx?: unknown) => Promise<unknown>)[]>();
	tools = new Map<string, RegisteredTool>();
	commands = new Map<string, RegisteredCommand>();
	sentUserMessages: string[] = [];
	/** What the fake secure-input dialog returns (undefined = user cancelled). */
	dialogInput: string | undefined;

	on(event: string, handler: (event: Record<string, unknown>, ctx?: unknown) => Promise<unknown>): void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
	}

	registerTool(tool: RegisteredTool): void {
		this.tools.set(tool.name, tool);
	}

	registerCommand(name: string, options: RegisteredCommand): void {
		this.commands.set(name, options);
	}

	sendUserMessage(content: string): void {
		this.sentUserMessages.push(content);
	}

	async fire(event: string, payload: Record<string, unknown> = {}, ctx?: unknown): Promise<unknown> {
		let result: unknown;
		for (const handler of this.handlers.get(event) ?? []) {
			result = await handler({ type: event, ...payload }, ctx);
		}
		return result;
	}

	async runTool(name: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const tool = this.tools.get(name);
		if (!tool) throw new Error(`tool not registered: ${name}`);
		const ctx = {
			sessionManager: { getSessionId: () => "session-a" },
			hasUI: true,
			ui: { input: async () => this.dialogInput },
		};
		const result = await tool.execute("call-1", params, undefined, undefined, ctx);
		return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
	}
}

interface FakeUI {
	notifications: { message: string; type?: string }[];
	notify: (message: string, type?: string) => void;
	input: (title: string, placeholder?: string) => Promise<string | undefined>;
	confirm: (title: string, message: string) => Promise<boolean>;
}

function makeCommandCtx(options: { input?: string; confirm?: boolean; hasUI?: boolean } = {}) {
	const ui: FakeUI = {
		notifications: [],
		notify: (message, type) => ui.notifications.push({ message, type }),
		input: async () => options.input,
		confirm: async () => options.confirm ?? true,
	};
	return { hasUI: options.hasUI ?? true, mode: "tui", ui };
}

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

function pendingUntilAbort(init?: RequestInit): Promise<never> {
	return new Promise((_resolve, reject) => {
		init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
	});
}

// telegramSessionId matches the id sessionCtx() reports, so inbound messages
// deliver directly in tests unless a test explicitly starts elsewhere.
const LINKED = {
	token: "tok",
	chatId: 42,
	chatName: "Rob",
	botUsername: "testbot",
	enabled: true,
	telegramSessionId: "session-a",
};

function sessionCtx(id = "session-a") {
	return { sessionManager: { getSessionId: () => id } };
}

let dir: string;
let configPath: string;
let smolt: FakeSmolt;
let handle: TelegramHandle | undefined;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "telegram-ext-"));
	configPath = join(dir, "telegram.json");
	smolt = new FakeSmolt();
	handle = undefined;
});

afterEach(async () => {
	// Stops the poller and clears the remote-turn typing timer.
	await smolt.fire("session_shutdown");
	handle?.getPoller()?.stop();
	rmSync(dir, { recursive: true, force: true });
});

function create(routes: Record<string, (body: Record<string, unknown>, init?: RequestInit) => unknown>) {
	const { fetchImpl, calls } = fakeFetch(routes);
	handle = createTelegramExtension(
		smolt as unknown as ExtensionAPI,
		{ configPath },
		{ fetchImpl, linkWaitAttempts: 3, linkWaitPollSeconds: 0, mirrorIntervalMs: 15, statusAfterMs: 0 },
	);
	return { calls };
}

describe("outbound tool", () => {
	test("reports the missing link when not set up", async () => {
		create({});
		const result = await smolt.runTool("telegram", { message: "hi" });
		expect(result.success).toBe(false);
		expect(String(result.error)).toContain("/telegram");
	});

	test("sends to the linked chat", async () => {
		saveTelegramConfig(configPath, LINKED);
		const { calls } = create({ sendMessage: () => ({ message_id: 1 }) });
		const result = await smolt.runTool("telegram", { message: "build finished", silent: true });
		expect(result).toMatchObject({ success: true, chunks: 1, chat: "Rob" });
		expect(calls[0]).toMatchObject({
			method: "sendMessage",
			body: { chat_id: 42, text: "build finished", disable_notification: true },
		});
	});

	test("refuses while the connector is disabled", async () => {
		saveTelegramConfig(configPath, { ...LINKED, enabled: false });
		create({ sendMessage: () => ({ message_id: 1 }) });
		const result = await smolt.runTool("telegram", { message: "hi" });
		expect(result.success).toBe(false);
		expect(String(result.error)).toContain("disabled");
	});
});

describe("inbound polling", () => {
	test("session_start begins polling and delivers messages, briefing only the first", async () => {
		saveTelegramConfig(configPath, { ...LINKED, lastUpdateId: 4 });
		let served = false;
		const update = (id: number, text: string): TelegramUpdate => ({
			update_id: id,
			message: { message_id: id, text, chat: { id: 42, first_name: "Rob" }, from: { first_name: "Rob" } },
		});
		const { calls } = create({
			getUpdates: (_body, init) => {
				if (served) return pendingUntilAbort(init);
				served = true;
				return [update(5, "how is the build going?"), update(6, "and the tests?")];
			},
		});
		await smolt.fire("session_start", {}, sessionCtx());
		await vi.waitFor(() => expect(smolt.sentUserMessages).toHaveLength(2));
		expect(smolt.sentUserMessages[0]).toContain("[Telegram message from Rob]");
		expect(smolt.sentUserMessages[0]).toContain("how is the build going?");
		expect(smolt.sentUserMessages[0]).toContain("telegram tool");
		// The standing guidance rides only the session's first delivery.
		expect(smolt.sentUserMessages[1]).toBe("[Telegram message from Rob]\nand the tests?");
		// Resumes past the persisted lastUpdateId, and persists the new one.
		expect(calls[0]!.body.offset).toBe(5);
		await vi.waitFor(() => expect(loadTelegramConfig(configPath)?.lastUpdateId).toBe(6));

		await smolt.fire("session_shutdown");
		expect(handle!.getPoller()).toBeUndefined();
	});

	test("a pane process with inbound disabled never polls", async () => {
		saveTelegramConfig(configPath, LINKED);
		const { fetchImpl } = fakeFetch({});
		handle = createTelegramExtension(smolt as unknown as ExtensionAPI, { configPath }, { fetchImpl, inbound: false });
		await smolt.fire("session_start", {}, sessionCtx());
		expect(handle.getPoller()).toBeUndefined();
		// Outbound still works from a pane process.
		const result = await smolt.runTool("telegram", { message: "hi" });
		expect(result.success).toBe(false); // fake fetch has no sendMessage route
		expect(String(result.error)).not.toContain("/telegram"); // linked, just transport-less
	});

	test("a message arriving while another chat is open gets its own fresh session", async () => {
		// The open session is NOT the telegram session.
		saveTelegramConfig(configPath, { ...LINKED, telegramSessionId: "session-telegram", lastUpdateId: 4 });
		let served = false;
		const { calls } = create({
			getUpdates: (_body, init) => {
				if (served) return pendingUntilAbort(init);
				served = true;
				return [
					{
						update_id: 5,
						message: {
							message_id: 7,
							text: "book the cabin",
							chat: { id: 42, first_name: "Rob" },
							from: { first_name: "Rob" },
						},
					},
				];
			},
			sendChatAction: () => true,
		});
		await smolt.fire("session_start", {}, sessionCtx("session-desk"));
		await vi.waitFor(() => expect(smolt.sentUserMessages).toHaveLength(1));

		// Nothing entered the open chat; the poller queued and bridged instead.
		expect(smolt.sentUserMessages[0]).toBe("/telegram inbound");
		expect(loadTelegramConfig(configPath)?.claimNextSession).toBe(true);
		expect(loadTelegramConfig(configPath)?.pendingInbound).toHaveLength(1);

		// The bridge handler opens a new session, which claims the telegram role
		// and receives the queued message.
		const ctx = {
			...makeCommandCtx(),
			newSession: async () => {
				await smolt.fire("session_start", {}, sessionCtx("session-fresh"));
				return { cancelled: false };
			},
		};
		await smolt.commands.get("telegram")!.handler("inbound", ctx);
		expect(smolt.sentUserMessages).toHaveLength(2);
		expect(smolt.sentUserMessages[1]).toContain("book the cabin");
		const saved = loadTelegramConfig(configPath);
		expect(saved?.telegramSessionId).toBe("session-fresh");
		expect(saved?.claimNextSession).toBe(false);
		expect(saved?.pendingInbound).toEqual([]);
		// The new session mirrors like any telegram turn.
		expect(calls.some((call) => call.method === "sendChatAction")).toBe(true);
	});

	test("a cancelled new-session falls back to delivering in the open chat", async () => {
		saveTelegramConfig(configPath, { ...LINKED, telegramSessionId: "session-telegram", lastUpdateId: 4 });
		let served = false;
		create({
			getUpdates: (_body, init) => {
				if (served) return pendingUntilAbort(init);
				served = true;
				return [
					{
						update_id: 5,
						message: {
							message_id: 9,
							text: "still there?",
							chat: { id: 42, first_name: "Rob" },
							from: { first_name: "Rob" },
						},
					},
				];
			},
			sendChatAction: () => true,
		});
		await smolt.fire("session_start", {}, sessionCtx("session-desk"));
		await vi.waitFor(() => expect(smolt.sentUserMessages).toHaveLength(1));
		expect(smolt.sentUserMessages[0]).toBe("/telegram inbound");

		const ctx = { ...makeCommandCtx(), newSession: async () => ({ cancelled: true }) };
		await smolt.commands.get("telegram")!.handler("inbound", ctx);
		expect(smolt.sentUserMessages.some((text) => text.includes("still there?"))).toBe(true);
		expect(loadTelegramConfig(configPath)?.pendingInbound).toEqual([]);
	});

	test("a dedicated host sticks to its current session, whatever the stored id says", async () => {
		saveTelegramConfig(configPath, { ...LINKED, telegramSessionId: "session-old", lastUpdateId: 4 });
		let served = false;
		const { fetchImpl } = fakeFetch({
			getUpdates: (_body, init) => {
				if (served) return pendingUntilAbort(init);
				served = true;
				return [
					{
						update_id: 5,
						message: {
							message_id: 7,
							text: "carry on",
							chat: { id: 42, first_name: "Rob" },
							from: { first_name: "Rob" },
						},
					},
				];
			},
			sendChatAction: () => true,
		});
		handle = createTelegramExtension(
			smolt as unknown as ExtensionAPI,
			{ configPath },
			{ fetchImpl, dedicated: true, mirrorIntervalMs: 15, statusAfterMs: 0 },
		);
		await smolt.fire("session_start", {}, sessionCtx("session-fresh"));
		await vi.waitFor(() => expect(smolt.sentUserMessages).toHaveLength(1));
		// Delivered straight into the current session; no bridge, no new chat.
		expect(smolt.sentUserMessages[0]).toContain("carry on");
		expect(smolt.sentUserMessages[0]).not.toBe("/telegram inbound");
	});

	test("a pane process never consumes the claim for the next session", async () => {
		saveTelegramConfig(configPath, {
			...LINKED,
			telegramSessionId: "session-telegram",
			claimNextSession: true,
			pendingInbound: [{ text: "queued", from: "Rob", messageId: 9 }],
		});
		const { fetchImpl } = fakeFetch({});
		handle = createTelegramExtension(smolt as unknown as ExtensionAPI, { configPath }, { fetchImpl, inbound: false });
		await smolt.fire("session_start", {}, sessionCtx("session-desk"));
		// The claim and queue are untouched for the real host to consume.
		const saved = loadTelegramConfig(configPath);
		expect(saved?.claimNextSession).toBe(true);
		expect(saved?.pendingInbound).toHaveLength(1);
		expect(saved?.telegramSessionId).toBe("session-telegram");
		expect(smolt.sentUserMessages).toHaveLength(0);
	});

	test("does not poll when disabled or unconfigured", async () => {
		saveTelegramConfig(configPath, { ...LINKED, enabled: false });
		create({});
		await smolt.fire("session_start", {}, sessionCtx());
		expect(handle!.getPoller()).toBeUndefined();
	});
});

describe("remote turn mirror", () => {
	function inboundUpdate(id: number, text: string): TelegramUpdate {
		return {
			update_id: id,
			message: { message_id: id, text, chat: { id: 42, first_name: "Rob" }, from: { first_name: "Rob" } },
		};
	}

	async function startInboundTurn(): Promise<RecordedCall[]> {
		saveTelegramConfig(configPath, { ...LINKED, lastUpdateId: 4 });
		let served = false;
		const { calls } = create({
			getUpdates: (_body, init) => {
				if (served) return pendingUntilAbort(init);
				served = true;
				return [inboundUpdate(5, "run the tests")];
			},
			sendChatAction: () => true,
			sendMessage: () => ({ message_id: 101 }),
			editMessageText: () => true,
			deleteMessage: () => true,
		});
		await smolt.fire("session_start", {}, sessionCtx());
		await vi.waitFor(() => expect(smolt.sentUserMessages).toHaveLength(1));
		return calls;
	}

	test("typing starts instantly, a working line ticks along, and the final reply is forwarded", async () => {
		const calls = await startInboundTurn();
		await vi.waitFor(() => expect(calls.some((call) => call.method === "sendChatAction")).toBe(true));

		// The heartbeat posts one silent status line: elapsed · tokens · working.
		await vi.waitFor(() => expect(calls.some((call) => call.method === "sendMessage")).toBe(true));
		const status = calls.find((call) => call.method === "sendMessage");
		expect(status!.body).toMatchObject({ chat_id: 42, disable_notification: true });
		// No intent line yet: just the counter. The model's opening sentence
		// joins it on a later edit, above the counter.
		expect(String(status!.body.text)).toMatch(/^✻ /);
		expect(String(status!.body.text)).toContain("working");
		expect(String(status!.body.text)).toContain("tokens");

		// Turn usage feeds the counter; later beats edit the same message.
		await smolt.fire("turn_end", {
			turnIndex: 1,
			message: { role: "assistant", usage: { input: 500, output: 76 } },
			toolResults: [],
		});
		await vi.waitFor(() =>
			expect(
				calls.some((call) => call.method === "editMessageText" && String(call.body.text).includes("576 tokens")),
			).toBe(true),
		);

		// A completed thought becomes the stage phrase; the reply's first
		// sentence becomes the acknowledgment line above the counter.
		await smolt.fire("message_update", {
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "I need to create the alarm now. " },
					{ type: "text", text: "I'll set up an alarm at 6pm. Working on it" },
				],
			},
			assistantMessageEvent: {},
		});
		await vi.waitFor(() =>
			expect(
				calls.some(
					(call) =>
						call.method === "editMessageText" &&
						String(call.body.text).includes("create the alarm now…") &&
						String(call.body.text).startsWith("I'll set up an alarm at 6pm."),
				),
			).toBe(true),
		);

		// A tool start takes over the stage until the next completed thought.
		await smolt.fire("tool_execution_start", { toolCallId: "t1", toolName: "bash", args: {} });
		await vi.waitFor(() =>
			expect(
				calls.some(
					(call) => call.method === "editMessageText" && String(call.body.text).includes("running a command…"),
				),
			).toBe(true),
		);

		await smolt.fire("agent_end", {
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "**All tests pass.** See [the log](https://ci.example)." }],
				},
			],
		});
		await smolt.fire("agent_settled");
		const sends = calls.filter((call) => call.method === "sendMessage");
		const texts = sends.map((call) => String(call.body.text));
		// The forwarded reply is flattened for Telegram: no markdown markers.
		expect(texts.some((text) => text.includes("All tests pass. See the log (https://ci.example)."))).toBe(true);
		expect(texts.some((text) => text.includes("**"))).toBe(false);
		// The status line ends BELOW the reply as the chat's last message: the
		// old one is deleted and a silent 'done' line is posted last.
		expect(calls.some((call) => call.method === "deleteMessage" && call.body.message_id === 101)).toBe(true);
		expect(String(sends.at(-1)!.body.text)).toContain("done");
		expect(sends.at(-1)!.body.disable_notification).toBe(true);
	});

	test("a tool-sent reply suppresses the auto-forward", async () => {
		const calls = await startInboundTurn();
		await smolt.runTool("telegram", { message: "custom update" });
		await smolt.fire("agent_end", {
			messages: [{ role: "assistant", content: [{ type: "text", text: "Final answer." }] }],
		});
		await smolt.fire("agent_settled");
		const texts = calls.filter((call) => call.method === "sendMessage").map((call) => String(call.body.text));
		expect(texts).toContain("custom update");
		expect(texts.some((text) => text.includes("Final answer."))).toBe(false);
	});

	test("/new from Telegram wipes the chat and bridges to a fresh session", async () => {
		saveTelegramConfig(configPath, { ...LINKED, lastUpdateId: 4, messageLog: [90, 91] });
		let served = false;
		const { calls } = create({
			getUpdates: (_body, init) => {
				if (served) return pendingUntilAbort(init);
				served = true;
				return [inboundUpdate(5, "/new")].map((update) => ({
					...update,
					message: { ...update.message!, message_id: 92 },
				}));
			},
			deleteMessage: () => true,
			sendMessage: () => ({ message_id: 101 }),
		});
		await smolt.fire("session_start", {}, sessionCtx());
		await vi.waitFor(() => expect(smolt.sentUserMessages).toHaveLength(1));

		// The raw /new never reaches the model; only the bridge command does.
		expect(smolt.sentUserMessages[0]).toBe("/telegram new");
		// Logged history plus the /new message itself were deleted; the ack is the new log.
		const deleted = calls.filter((call) => call.method === "deleteMessage").map((call) => call.body.message_id);
		expect(deleted).toEqual([90, 91, 92]);
		expect(loadTelegramConfig(configPath)?.messageLog).toEqual([101]);
		const texts = calls.filter((call) => call.method === "sendMessage").map((call) => String(call.body.text));
		expect(texts.some((text) => text.includes("New session started"))).toBe(true);
	});

	test("/stop from Telegram bridges to an abort and freezes the mirror", async () => {
		const calls = await startInboundTurn();
		// The mirror is live: wait for the status message to exist.
		await vi.waitFor(() => expect(calls.some((call) => call.method === "sendMessage")).toBe(true));

		// The user sends /stop from the phone: the poller bridges, never delivers.
		let aborts = 0;
		const ctx = {
			...makeCommandCtx(),
			isIdle: () => false,
			abort: () => {
				aborts += 1;
			},
		};
		await smolt.commands.get("telegram")!.handler("stop", ctx);
		expect(aborts).toBe(1);
		// The old status is deleted and the frozen line reposted below the ack.
		expect(calls.some((call) => call.method === "deleteMessage" && call.body.message_id === 101)).toBe(true);
		const sends = calls.filter((call) => call.method === "sendMessage");
		const texts = sends.map((call) => String(call.body.text));
		expect(texts.some((text) => text.includes("Stopped."))).toBe(true);
		expect(String(sends.at(-1)!.body.text)).toContain("stopped");

		// The abort settles the run, but the mirror is already closed: the
		// half-finished reply is never forwarded.
		await smolt.fire("agent_end", {
			messages: [{ role: "assistant", content: [{ type: "text", text: "Half-finished answer." }] }],
		});
		await smolt.fire("agent_settled");
		const after = calls.filter((call) => call.method === "sendMessage").map((call) => String(call.body.text));
		expect(after.some((text) => text.includes("Half-finished answer."))).toBe(false);
	});

	test("/stop while idle reports there was nothing to stop", async () => {
		saveTelegramConfig(configPath, LINKED);
		const { calls } = create({ sendMessage: () => ({ message_id: 7 }) });
		const ctx = { ...makeCommandCtx(), isIdle: () => true, abort: () => {} };
		await smolt.commands.get("telegram")!.handler("stop", ctx);
		const texts = calls.filter((call) => call.method === "sendMessage").map((call) => String(call.body.text));
		expect(texts.some((text) => text.includes("Nothing was running."))).toBe(true);
	});

	test("a /cancel message from Telegram dispatches the stop bridge, not the model", async () => {
		saveTelegramConfig(configPath, { ...LINKED, lastUpdateId: 4 });
		let served = false;
		create({
			getUpdates: (_body, init) => {
				if (served) return pendingUntilAbort(init);
				served = true;
				return [
					{
						update_id: 5,
						message: {
							message_id: 8,
							text: "/cancel",
							chat: { id: 42, first_name: "Rob" },
							from: { first_name: "Rob" },
						},
					},
				];
			},
		});
		await smolt.fire("session_start", {}, sessionCtx());
		await vi.waitFor(() => expect(smolt.sentUserMessages).toHaveLength(1));
		expect(smolt.sentUserMessages[0]).toBe("/telegram stop");
	});

	test("/telegram new starts a new session from the app side", async () => {
		saveTelegramConfig(configPath, LINKED);
		create({});
		let newSessions = 0;
		const ctx = {
			...makeCommandCtx(),
			newSession: async () => {
				newSessions += 1;
				return { cancelled: false };
			},
		};
		await smolt.commands.get("telegram")!.handler("new", ctx);
		expect(newSessions).toBe(1);
	});

	test("turns not triggered from Telegram are not mirrored", async () => {
		saveTelegramConfig(configPath, LINKED);
		const { calls } = create({ getUpdates: (_body, init) => pendingUntilAbort(init) });
		await smolt.fire("session_start", {}, sessionCtx());
		await smolt.fire("tool_execution_start", { toolCallId: "t1", toolName: "bash", args: { command: "ls" } });
		await smolt.fire("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "hi" }] }] });
		await smolt.fire("agent_settled");
		expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(0);
		expect(calls.filter((call) => call.method === "sendChatAction")).toHaveLength(0);
	});
});

describe("/telegram command", () => {
	test("status reports the unlinked state without UI side effects", async () => {
		create({});
		const ctx = makeCommandCtx();
		await smolt.commands.get("telegram")!.handler("status", ctx);
		expect(ctx.ui.notifications[0]!.message).toContain("not set up");
	});

	test("off persists and stops; on restores", async () => {
		saveTelegramConfig(configPath, LINKED);
		create({ getUpdates: (_body, init) => pendingUntilAbort(init) });
		await smolt.fire("session_start", {}, sessionCtx());
		expect(handle!.getPoller()).toBeDefined();

		const ctx = makeCommandCtx();
		await smolt.commands.get("telegram")!.handler("off", ctx);
		expect(handle!.getPoller()).toBeUndefined();
		expect(loadTelegramConfig(configPath)?.enabled).toBe(false);

		await smolt.commands.get("telegram")!.handler("on", ctx);
		expect(handle!.getPoller()).toBeDefined();
		expect(loadTelegramConfig(configPath)?.enabled).toBe(true);
	});

	test("/telegram with no config hands the agent the setup prompt", async () => {
		create({});
		await smolt.commands.get("telegram")!.handler("", makeCommandCtx());
		expect(smolt.sentUserMessages).toHaveLength(1);
		expect(smolt.sentUserMessages[0]).toContain("BotFather");
		expect(smolt.sentUserMessages[0]).toContain("'configure'");
		expect(smolt.sentUserMessages[0]).toContain("'link'");
	});
});

describe("conversational setup actions", () => {
	const linkUpdate: TelegramUpdate = {
		update_id: 7,
		message: {
			message_id: 1,
			text: "hi",
			chat: { id: 42, first_name: "Rob", type: "private" },
			from: { first_name: "Rob" },
		},
	};

	test("configure validates the token, link discovers the chat, then send works", async () => {
		let linkServed = false;
		const { calls } = create({
			getMe: () => ({ username: "testbot" }),
			getUpdates: (_body, init) => {
				// The link poll returns the user's message once; the poller that
				// starts after linking hangs until stopped.
				if (linkServed) return pendingUntilAbort(init);
				linkServed = true;
				return [linkUpdate];
			},
			sendMessage: () => ({ message_id: 9 }),
		});

		smolt.dialogInput = "tok";
		const configured = await smolt.runTool("telegram", { action: "configure" });
		expect(configured).toMatchObject({ success: true, bot: "testbot" });
		expect(String(configured.next)).toContain("t.me/testbot");
		// The token reached the config via the dialog, never a tool parameter.
		expect(loadTelegramConfig(configPath)?.token).toBe("tok");

		// Configured but unlinked: sends are refused with guidance.
		const premature = await smolt.runTool("telegram", { message: "hi" });
		expect(premature.success).toBe(false);
		expect(String(premature.error)).toContain("link");

		const linked = await smolt.runTool("telegram", { action: "link" });
		expect(linked).toMatchObject({ success: true, chat: "Rob", bot: "testbot" });
		expect(loadTelegramConfig(configPath)).toMatchObject({
			token: "tok",
			chatId: 42,
			chatName: "Rob",
			botUsername: "testbot",
			enabled: true,
			lastUpdateId: 7,
		});
		// The hello went to the linked chat and polling began.
		expect(calls.some((call) => call.method === "sendMessage" && call.body.chat_id === 42)).toBe(true);
		expect(handle!.getPoller()).toBeDefined();

		const sent = await smolt.runTool("telegram", { message: "test" });
		expect(sent).toMatchObject({ success: true, chat: "Rob" });

		const status = await smolt.runTool("telegram", { action: "status" });
		expect(status).toMatchObject({ success: true, configured: true, linked: true, enabled: true });
	});

	test("configure surfaces a rejected token, and a cancelled dialog", async () => {
		create({
			getMe: () => new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), { status: 401 }),
		});
		smolt.dialogInput = "bad";
		const result = await smolt.runTool("telegram", { action: "configure" });
		expect(result.success).toBe(false);
		expect(String(result.error)).toContain("Unauthorized");
		expect(loadTelegramConfig(configPath)).toBeUndefined();

		smolt.dialogInput = undefined;
		const cancelled = await smolt.runTool("telegram", { action: "configure" });
		expect(cancelled.success).toBe(false);
		expect(String(cancelled.error)).toContain("cancelled");
	});

	test("link with no message yet asks to retry, and link before configure is refused", async () => {
		create({ getMe: () => ({ username: "testbot" }), getUpdates: () => [] });
		const unconfigured = await smolt.runTool("telegram", { action: "link" });
		expect(unconfigured.success).toBe(false);
		expect(String(unconfigured.error)).toContain("configure");

		smolt.dialogInput = "tok";
		await smolt.runTool("telegram", { action: "configure" });
		const nothing = await smolt.runTool("telegram", { action: "link" });
		expect(nothing.success).toBe(false);
		expect(String(nothing.error)).toContain("again");
	});

	test("a partially set up connector resumes setup from bare /telegram", async () => {
		create({ getMe: () => ({ username: "testbot" }) });
		smolt.dialogInput = "tok";
		await smolt.runTool("telegram", { action: "configure" });
		await smolt.commands.get("telegram")!.handler("", makeCommandCtx());
		expect(smolt.sentUserMessages).toHaveLength(1);
		expect(smolt.sentUserMessages[0]).toContain("BotFather");
	});
});
