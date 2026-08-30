import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Minimal Telegram Bot API client, config store, and long-poll loop for the
 * telegram extension. No dependencies beyond global fetch; the fetch
 * implementation is injectable so everything is testable offline.
 */

/** Telegram rejects messages longer than this many characters. */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

/** How long one getUpdates long-poll waits server-side, in seconds. */
export const POLL_TIMEOUT_SECONDS = 25;

/** Backoff after another process is polling the same bot (HTTP 409). */
export const CONFLICT_RETRY_MS = 30_000;

/** Backoff after a network or API error in the poll loop. */
export const ERROR_RETRY_MS = 10_000;

export interface TelegramConfig {
	token: string;
	chatId: number;
	/** Display name of the linked chat, for status output. */
	chatName?: string;
	botUsername?: string;
	enabled: boolean;
	/** Highest update_id already delivered, so restarts don't replay it. */
	lastUpdateId?: number;
	/** Ids of chat messages seen or sent, so /new can wipe the visible history. */
	messageLog?: number[];
	/** The session dedicated to the Telegram conversation; inbound messages deliver there. */
	telegramSessionId?: string;
	/** One-shot: the next session to start becomes the Telegram session. */
	claimNextSession?: boolean;
	/** Messages waiting for that session to exist. */
	pendingInbound?: InboundMessage[];
}

export interface TelegramUpdate {
	update_id: number;
	message?: {
		message_id: number;
		text?: string;
		caption?: string;
		chat: { id: number; first_name?: string; username?: string; title?: string; type?: string };
		from?: { first_name?: string; username?: string };
	};
}

interface ApiEnvelope<T> {
	ok: boolean;
	result?: T;
	description?: string;
}

export class TelegramConflictError extends Error {
	constructor() {
		super("another process is polling this bot (HTTP 409)");
		this.name = "TelegramConflictError";
	}
}

export function loadTelegramConfig(path: string): TelegramConfig | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<TelegramConfig>;
		if (typeof raw.token !== "string" || typeof raw.chatId !== "number") return undefined;
		return {
			token: raw.token,
			chatId: raw.chatId,
			chatName: typeof raw.chatName === "string" ? raw.chatName : undefined,
			botUsername: typeof raw.botUsername === "string" ? raw.botUsername : undefined,
			enabled: raw.enabled !== false,
			lastUpdateId: typeof raw.lastUpdateId === "number" ? raw.lastUpdateId : undefined,
			messageLog: Array.isArray(raw.messageLog)
				? raw.messageLog.filter((id): id is number => typeof id === "number")
				: undefined,
			telegramSessionId: typeof raw.telegramSessionId === "string" ? raw.telegramSessionId : undefined,
			claimNextSession: raw.claimNextSession === true,
			pendingInbound: Array.isArray(raw.pendingInbound)
				? raw.pendingInbound.filter(
						(item): item is InboundMessage =>
							typeof item === "object" &&
							item !== null &&
							typeof (item as InboundMessage).text === "string" &&
							typeof (item as InboundMessage).from === "string" &&
							typeof (item as InboundMessage).messageId === "number",
					)
				: undefined,
		};
	} catch {
		return undefined;
	}
}

export function saveTelegramConfig(path: string, config: TelegramConfig): void {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.tmp-${process.pid}`;
	writeFileSync(temp, `${JSON.stringify(config, undefined, "\t")}\n`, { encoding: "utf-8", mode: 0o600 });
	renameSync(temp, path);
}

/**
 * Flatten model markdown into readable plain text. Telegram messages are sent
 * without parse_mode, so raw markdown arrives as literal asterisks and
 * brackets; this keeps the words and drops the markup.
 */
export function markdownToPlain(markdown: string): string {
	let text = markdown.replace(/\r\n/g, "\n");
	// Fenced code keeps its body; the fences and language tag go.
	text = text.replace(/```[^\n]*\n([\s\S]*?)```/g, (_match, body: string) => body.replace(/\n$/, ""));
	text = text.replace(/```/g, "");
	text = text.replace(/`([^`]+)`/g, "$1");
	// Links keep the label and the address; images collapse to the address.
	text = text.replace(/!\[[^\]]*\]\(([^)]+)\)/g, "$1");
	text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, url: string) =>
		label.trim() === url.trim() ? url : `${label} (${url})`,
	);
	// Emphasis markers vanish; the words stay.
	text = text.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*\n]+)\*/g, "$1");
	text = text.replace(/__([^_]+)__/g, "$1").replace(/(?<![\w])_([^_\n]+)_(?![\w])/g, "$1");
	// Structure markers become plain equivalents.
	text = text.replace(/^#{1,6}\s+(.*)$/gm, "$1");
	text = text.replace(/^(\s*)[-*+]\s+/gm, "$1• ");
	text = text.replace(/^>\s?/gm, "");
	text = text.replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, "");
	return text.replace(/\n{3,}/g, "\n\n").trim();
}

/** Split a message into Telegram-sized chunks, preferring newline boundaries. */
export function chunkMessage(text: string, limit = TELEGRAM_MESSAGE_LIMIT): string[] {
	const chunks: string[] = [];
	let rest = text;
	while (rest.length > limit) {
		const newline = rest.lastIndexOf("\n", limit);
		const cut = newline > limit / 2 ? newline : limit;
		chunks.push(rest.slice(0, cut));
		rest = rest.slice(cut === newline ? cut + 1 : cut);
	}
	chunks.push(rest);
	return chunks.filter((chunk) => chunk.trim() !== "");
}

export class TelegramClient {
	private readonly token: string;
	private readonly fetchImpl: typeof fetch;
	private readonly baseUrl: string;

	constructor(token: string, fetchImpl: typeof fetch = fetch, baseUrl = "https://api.telegram.org") {
		this.token = token;
		this.fetchImpl = fetchImpl;
		this.baseUrl = baseUrl;
	}

	private async call<T>(
		method: string,
		payload: Record<string, unknown>,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<T> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		const onOuterAbort = () => controller.abort();
		signal?.addEventListener("abort", onOuterAbort, { once: true });
		try {
			const response = await this.fetchImpl(`${this.baseUrl}/bot${this.token}/${method}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
				signal: controller.signal,
			});
			if (response.status === 409) throw new TelegramConflictError();
			const data = (await response.json()) as ApiEnvelope<T>;
			if (!data.ok || data.result === undefined) {
				throw new Error(data.description ?? `Telegram API error (HTTP ${response.status})`);
			}
			return data.result;
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onOuterAbort);
		}
	}

	async getMe(): Promise<{ username?: string; first_name?: string }> {
		return this.call("getMe", {}, 10_000);
	}

	/** Send a text message, chunking to the API limit. */
	async sendMessage(chatId: number, text: string, silent = false): Promise<{ chunks: number; messageIds: number[] }> {
		const chunks = chunkMessage(text);
		const messageIds: number[] = [];
		for (const chunk of chunks) {
			const sent = await this.call<{ message_id?: number }>(
				"sendMessage",
				{ chat_id: chatId, text: chunk, disable_notification: silent },
				15_000,
			);
			if (typeof sent.message_id === "number") messageIds.push(sent.message_id);
		}
		return { chunks: chunks.length, messageIds };
	}

	/** Delete one message. Private chats allow deleting both sides' messages within 48h. */
	async deleteMessage(chatId: number, messageId: number): Promise<void> {
		await this.call("deleteMessage", { chat_id: chatId, message_id: messageId }, 10_000);
	}

	/** Show a "typing…" indicator in the chat; it expires after ~5 seconds. */
	async sendChatAction(chatId: number, action = "typing"): Promise<void> {
		await this.call("sendChatAction", { chat_id: chatId, action }, 10_000);
	}

	/** Replace the text of a message the bot sent earlier (edits do not notify). */
	async editMessageText(chatId: number, messageId: number, text: string): Promise<void> {
		await this.call("editMessageText", { chat_id: chatId, message_id: messageId, text }, 10_000);
	}

	async getUpdates(offset: number, timeoutSeconds: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
		return this.call(
			"getUpdates",
			{ offset, timeout: timeoutSeconds, allowed_updates: ["message"] },
			(timeoutSeconds + 10) * 1000,
			signal,
		);
	}
}

export type PollerStatus = "stopped" | "connected" | "conflict" | "error";

export interface InboundMessage {
	text: string;
	from: string;
	messageId: number;
}

/**
 * Long-poll loop for one bot + chat. Only messages from the configured chat
 * are delivered; everything else is acknowledged and dropped. On HTTP 409
 * (another session holds the connection) it backs off and keeps retrying, so
 * the connection migrates when the other session ends.
 */
export class TelegramPoller {
	private readonly client: TelegramClient;
	private readonly chatId: number;
	private readonly onMessage: (message: InboundMessage) => void;
	private readonly onAck: (lastUpdateId: number) => void;
	private offset: number;
	private running = false;
	private abort: AbortController | undefined;
	private wake: (() => void) | undefined;
	status: PollerStatus = "stopped";
	lastError: string | undefined;

	constructor(options: {
		client: TelegramClient;
		chatId: number;
		initialOffset?: number;
		onMessage: (message: InboundMessage) => void;
		/** Called when updates were processed, with the highest update_id seen. */
		onAck?: (lastUpdateId: number) => void;
	}) {
		this.client = options.client;
		this.chatId = options.chatId;
		this.offset = options.initialOffset ?? 0;
		this.onMessage = options.onMessage;
		this.onAck = options.onAck ?? (() => {});
	}

	start(): void {
		if (this.running) return;
		this.running = true;
		void this.run();
	}

	stop(): void {
		this.running = false;
		this.status = "stopped";
		this.abort?.abort();
		this.wake?.();
	}

	/** Interruptible wait: stop() wakes it immediately via this.wake. */
	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.wake = undefined;
				resolve();
			}, ms);
			this.wake = () => {
				clearTimeout(timer);
				this.wake = undefined;
				resolve();
			};
		});
	}

	private async run(): Promise<void> {
		while (this.running) {
			this.abort = new AbortController();
			try {
				const updates = await this.client.getUpdates(this.offset, POLL_TIMEOUT_SECONDS, this.abort.signal);
				if (!this.running) break;
				this.status = "connected";
				this.lastError = undefined;
				let maxId = -1;
				for (const update of updates) {
					this.offset = Math.max(this.offset, update.update_id + 1);
					maxId = Math.max(maxId, update.update_id);
					const message = update.message;
					if (!message || message.chat.id !== this.chatId) continue;
					const text = message.text ?? message.caption;
					if (!text) continue;
					this.onMessage({
						text,
						from: message.from?.first_name ?? message.from?.username ?? "user",
						messageId: message.message_id,
					});
				}
				if (maxId >= 0) this.onAck(maxId);
			} catch (error) {
				if (!this.running) break;
				if (error instanceof TelegramConflictError) {
					this.status = "conflict";
					this.lastError = error.message;
					await this.sleep(CONFLICT_RETRY_MS);
				} else {
					this.status = "error";
					this.lastError = error instanceof Error ? error.message : String(error);
					await this.sleep(ERROR_RETRY_MS);
				}
			}
		}
	}
}
