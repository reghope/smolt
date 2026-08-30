import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
// Type-only import: a standalone install of this module outside the smolt
// tree switches this single line to `from "smolt"`.
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import {
	type InboundMessage,
	loadTelegramConfig,
	markdownToPlain,
	saveTelegramConfig,
	TelegramClient,
	type TelegramConfig,
	TelegramPoller,
} from "./client.ts";
import { firstSentence, thinkingSummary, toolStage } from "./stage.ts";

type ActionResult = Record<string, unknown>;

/**
 * Telegram connector: a two-way bridge between the session and the user's
 * Telegram account, through a bot the user owns.
 *
 * - Setup is part of the conversation, not a modal wizard: /telegram sends
 *   the agent a setup prompt, and the agent walks the user through creating
 *   a bot with @BotFather and discovers the chat id from the user's first
 *   message to the bot (tool action 'link'). The token itself never enters
 *   the conversation: action 'configure' takes no token parameter and asks
 *   the user directly through a secure input dialog, so the secret reaches
 *   the local config file without passing through the model.
 * - The `telegram` tool's default action sends the user a message (progress
 *   on long tasks, questions while they're away from the screen).
 * - A long-poll loop delivers whatever the user types to the bot back into
 *   the session as a user message, so the conversation continues from a
 *   phone. Only the linked chat is accepted; anyone else who finds the bot
 *   is ignored.
 *
 * One session at a time holds the inbound connection (a Telegram Bot API
 * constraint). Other sessions see status "conflict" and keep retrying, so
 * the connection migrates when the holder exits. Outbound sends work from
 * any session at any time.
 */

const CONFIG_DIR_NAME = ".smolt";

function getAgentDir(): string {
	const envDir = process.env.SMOLT_CODING_AGENT_DIR;
	if (envDir) {
		return envDir.startsWith("~") ? join(homedir(), envDir.slice(1)) : envDir;
	}
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

/** How long one 'link' tool call waits for the user's first message. */
const LINK_WAIT_ATTEMPTS = 10;
const LINK_WAIT_POLL_SECONDS = 3;

/** chatId sentinel: token configured, chat not yet linked. */
const UNLINKED = 0;

const SETUP_PROMPT = `Set up the Telegram connector with me, conversationally. One step at a time; keep each message short.

1. Explain how I create a bot, and recommend doing it on THIS computer so the token is a straight copy-paste: open Telegram Desktop or https://web.telegram.org, message @BotFather (https://t.me/BotFather), send /newbot, follow the prompts (a display name, then a username ending in "bot"), and copy the HTTP API token BotFather returns. IMPORTANT: tell me NOT to paste the token into this chat — it is a secret and must never enter the conversation. Ask me to just say "ready" once I have it copied.
2. When I say I'm ready, call the telegram tool with action 'configure'. A secure input dialog will ask me for the token directly — it goes straight to the local config file without passing through you. If Telegram rejects the token, show me the error and call 'configure' again. If I ever paste the token into the chat by mistake, tell me to revoke it with @BotFather's /revoke and configure with the regenerated one.
3. 'configure' returns the bot's username. Tell me to open https://t.me/<username> and send the bot any message, and to tell you here once I have. Then call action 'link' — it waits up to about 30 seconds. If it says nothing arrived, ask me to check and call 'link' again.
4. 'link' returns the linked chat. Confirm the link worked, send a short test via the tool's default send action, and tell me: you can now message me there, anything I send the bot reaches the session, and /telegram status|on|off|test manage it.`;

function inboundContent(from: string, text: string): string {
	return `[Telegram message from ${from}]\n${text}\n\n(The user sent this from Telegram and may be away from the screen. Open your reply with ONE short sentence saying what you're about to do — it is shown on their phone while you work. Your final reply this turn is forwarded to Telegram automatically — keep it concise and plain-text friendly. Use the telegram tool only for mid-task updates or questions before the turn ends.)`;
}

/** Heartbeat: refresh typing and the status line. Telegram's typing indicator expires after ~5s. */
const TYPING_INTERVAL_MS = 4000;
/** Without an intent line yet, the status message waits this long; typing covers the gap. */
const STATUS_AFTER_MS = 3500;

function formatElapsed(ms: number): string {
	const total = Math.floor(ms / 1000);
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	if (hours > 0) return `${hours}h ${minutes}m`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

function formatTokens(count: number): string {
	return count >= 1000 ? `${(count / 1000).toFixed(1)}k tokens` : `${count} tokens`;
}

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
}

function jsonResult(value: unknown) {
	return textResult(JSON.stringify(value));
}

export interface TelegramPaths {
	configPath: string;
}

export interface TelegramExtensionOptions {
	fetchImpl?: typeof fetch;
	/** Override the 'link' action's wait-for-message polling, for tests. */
	linkWaitAttempts?: number;
	linkWaitPollSeconds?: number;
	/** Override the remote-turn heartbeat cadence, for tests. */
	mirrorIntervalMs?: number;
	statusAfterMs?: number;
	/**
	 * Whether this process may hold the inbound connection. Defaults to the
	 * SMOLT_TELEGRAM_POLL env var: the desktop sets "off" for every
	 * pane-visible agent and "on" only for its dedicated Telegram host, so
	 * phone messages never move the GUI. Outbound sends work regardless.
	 */
	inbound?: boolean;
	/**
	 * Whether this process exists solely for Telegram (SMOLT_TELEGRAM_POLL
	 * exactly "on"). A dedicated host delivers into its current session and
	 * only /new rotates it; non-dedicated hosts route to a separate session.
	 */
	dedicated?: boolean;
}

export interface TelegramHandle {
	getConfig(): TelegramConfig | undefined;
	getPoller(): TelegramPoller | undefined;
}

export default function telegramExtension(smolt: ExtensionAPI): void {
	createTelegramExtension(smolt, { configPath: join(getAgentDir(), "telegram.json") });
}

export function createTelegramExtension(
	smolt: ExtensionAPI,
	paths: TelegramPaths,
	options: TelegramExtensionOptions = {},
): TelegramHandle {
	const fetchImpl = options.fetchImpl ?? fetch;
	const linkWaitAttempts = options.linkWaitAttempts ?? LINK_WAIT_ATTEMPTS;
	const linkWaitPollSeconds = options.linkWaitPollSeconds ?? LINK_WAIT_POLL_SECONDS;
	const mirrorIntervalMs = options.mirrorIntervalMs ?? TYPING_INTERVAL_MS;
	const statusAfterMs = options.statusAfterMs ?? STATUS_AFTER_MS;

	let config = loadTelegramConfig(paths.configPath);
	let poller: TelegramPoller | undefined;
	let currentSessionId = "";

	// Remote-turn mirror: live while a turn was triggered from Telegram, so the
	// user on their phone sees the agent is working, exactly like the app's own
	// indicator: typing plus one edited "elapsed · tokens · working" line.
	let remoteTurn = false;
	let sentViaTool = false;
	let finalReply: string | undefined;
	let statusId: number | undefined;
	let statusBusy = false;
	let remoteStartAt = 0;
	let remoteTokens = 0;
	let typingTimer: ReturnType<typeof setInterval> | undefined;
	// Progress derivation: the streamed partial is stashed per delta (cheap) and
	// condensed only on the heartbeat.
	let lastPartial: unknown;
	let ackLine = "";
	let ackFromModel = false;
	let stagePhrase = "";
	let lastThinkingSummary = "";
	let inboundBriefed = false;
	const inboundEnabled = options.inbound ?? process.env.SMOLT_TELEGRAM_POLL !== "off";
	// A dedicated host (the desktop's hidden Telegram agent) is invisible, so
	// messages simply continue in its current session — only /new rotates it.
	// The fresh-session routing below exists for single-process mode (TUI),
	// where an inbound message must not hijack the user's open chat.
	const dedicated = options.dedicated ?? process.env.SMOLT_TELEGRAM_POLL === "on";

	function persist(next: TelegramConfig): void {
		config = next;
		saveTelegramConfig(paths.configPath, next);
	}

	function linkedClient(): { api: TelegramClient; chatId: number } | undefined {
		if (!config || config.chatId === UNLINKED || !config.enabled) return undefined;
		return { api: new TelegramClient(config.token, fetchImpl), chatId: config.chatId };
	}

	/** Remember chat message ids so a later /new can wipe the visible history. */
	function logMessageIds(ids: number[]): void {
		if (!config || ids.length === 0) return;
		persist({ ...config, messageLog: [...(config.messageLog ?? []), ...ids].slice(-500) });
	}

	async function sendLogged(text: string, silent = false): Promise<{ chunks: number; messageIds: number[] }> {
		const linked = linkedClient();
		if (!linked) throw new Error("no linked chat");
		const sent = await linked.api.sendMessage(linked.chatId, text, silent);
		logMessageIds(sent.messageIds);
		return sent;
	}

	/** Best-effort deletion of every logged message (Telegram allows ~48h back). */
	async function wipeChat(extraIds: number[]): Promise<void> {
		const linked = linkedClient();
		if (!linked || !config) return;
		const ids = [...new Set([...(config.messageLog ?? []), ...extraIds])];
		for (const id of ids) {
			try {
				await linked.api.deleteMessage(linked.chatId, id);
			} catch {
				// Too old, already gone, or not deletable — fine either way.
			}
		}
		persist({ ...config, messageLog: [] });
	}

	/** The user typed /new in the Telegram chat: wipe it there, fresh session here. */
	async function handleTelegramNew(commandMessageId: number): Promise<void> {
		endRemoteTurn();
		await wipeChat([commandMessageId]);
		try {
			await sendLogged("New session started.");
		} catch {
			// The wipe still happened; the new session is the visible signal.
		}
		if (config) persist({ ...config, claimNextSession: true, pendingInbound: [] });
		// Dispatches our own extension command, whose handler has the session
		// controls (ctx.newSession) that a poller callback lacks.
		smolt.sendUserMessage("/telegram new", { expandPromptTemplates: true });
	}

	function statusText(suffix: string): string {
		const line = `✻ ${formatElapsed(Date.now() - remoteStartAt)} · ${formatTokens(remoteTokens)} · ${suffix}`;
		return ackLine === "" ? line : `${ackLine}\n\n${line}`;
	}

	/** Condense the stashed streaming state into the ack line and stage phrase. */
	function deriveProgress(): void {
		const message = lastPartial as { role?: string; content?: unknown } | undefined;
		if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return;
		let thinking = "";
		let text = "";
		for (const raw of message.content) {
			const block = raw as { type?: string; thinking?: string; text?: string };
			if (block.type === "thinking" && typeof block.thinking === "string") thinking += `${block.thinking}\n`;
			else if (block.type === "text" && typeof block.text === "string") text += block.text;
		}
		if (!ackFromModel) {
			const sentence = firstSentence(text);
			if (sentence !== "") {
				ackLine = sentence;
				ackFromModel = true;
			}
		}
		const summary = thinkingSummary(thinking);
		// A freshly completed thought outranks the current stage; an unchanged one
		// does not (a tool stage may have taken over since).
		if (summary !== "" && summary !== lastThinkingSummary) {
			lastThinkingSummary = summary;
			stagePhrase = summary;
		}
	}

	/** Create the status message a few seconds in, then keep editing it in place. */
	async function updateStatus(): Promise<void> {
		if (!remoteTurn || statusBusy) return;
		statusBusy = true;
		try {
			deriveProgress();
			const suffix = `${stagePhrase === "" ? "working" : stagePhrase}…`;
			if (statusId === undefined) {
				// Post as soon as there is an intent line to show; otherwise wait a
				// few seconds so quick replies never spawn a status message.
				if (ackLine === "" && Date.now() - remoteStartAt < statusAfterMs) return;
				statusId = (await sendLogged(statusText(suffix), true)).messageIds.at(-1);
			} else {
				const linked = linkedClient();
				if (linked && statusId !== undefined) {
					await linked.api.editMessageText(linked.chatId, statusId, statusText(suffix));
				}
			}
		} catch {
			// Status is best-effort; the typing indicator still shows life.
		} finally {
			statusBusy = false;
		}
	}

	/**
	 * Keep the status message the LAST message in the chat: after content is
	 * sent beneath it, delete it and repost it at the bottom.
	 */
	async function repositionStatus(finalSuffix?: string): Promise<void> {
		if (statusId === undefined || statusBusy) return;
		statusBusy = true;
		try {
			const linked = linkedClient();
			if (!linked) return;
			const old = statusId;
			statusId = undefined;
			void linked.api.deleteMessage(linked.chatId, old).catch(() => {});
			deriveProgress();
			const suffix = finalSuffix ?? `${stagePhrase === "" ? "working" : stagePhrase}…`;
			statusId = (await sendLogged(statusText(suffix), true)).messageIds.at(-1);
		} catch {
			// Best-effort; the next heartbeat recreates it if needed.
		} finally {
			statusBusy = false;
		}
	}

	function startRemoteTurn(): void {
		if (!remoteTurn) {
			remoteStartAt = Date.now();
			remoteTokens = 0;
		}
		remoteTurn = true;
		const linked = linkedClient();
		if (!linked || typingTimer) return;
		const beat = () => {
			void linked.api.sendChatAction(linked.chatId).catch(() => {});
			void updateStatus();
		};
		beat();
		typingTimer = setInterval(beat, mirrorIntervalMs);
	}

	function endRemoteTurn(): void {
		remoteTurn = false;
		sentViaTool = false;
		finalReply = undefined;
		statusId = undefined;
		statusBusy = false;
		remoteStartAt = 0;
		remoteTokens = 0;
		lastPartial = undefined;
		ackLine = "";
		ackFromModel = false;
		stagePhrase = "";
		lastThinkingSummary = "";
		if (typingTimer) {
			clearInterval(typingTimer);
			typingTimer = undefined;
		}
	}

	/** The standing guidance rides only the session's first delivery. */
	function inboundText(message: InboundMessage): string {
		if (inboundBriefed) return `[Telegram message from ${message.from}]\n${message.text}`;
		inboundBriefed = true;
		return inboundContent(message.from, message.text);
	}

	function startPolling(): void {
		if (!inboundEnabled || !config?.enabled || config.chatId === UNLINKED || poller) return;
		const activeConfig = config;
		poller = new TelegramPoller({
			client: new TelegramClient(activeConfig.token, fetchImpl),
			chatId: activeConfig.chatId,
			initialOffset: activeConfig.lastUpdateId !== undefined ? activeConfig.lastUpdateId + 1 : 0,
			onMessage: (message) => {
				if (/^\/new(@\w+)?$/i.test(message.text.trim())) {
					void handleTelegramNew(message.messageId);
					return;
				}
				if (/^\/(stop|cancel)(@\w+)?$/i.test(message.text.trim())) {
					logMessageIds([message.messageId]);
					// Extension commands dispatch immediately even mid-stream, and the
					// command context carries abort() — which a poller callback lacks.
					smolt.sendUserMessage("/telegram stop", { expandPromptTemplates: true });
					return;
				}
				logMessageIds([message.messageId]);
				if (!config) return;
				// A dedicated host sticks to its current session; in single-process
				// mode, a message for a non-active telegram session is queued and a
				// fresh session claims it so the open chat is never hijacked.
				if (dedicated || config.telegramSessionId === currentSessionId) {
					startRemoteTurn();
					smolt.sendUserMessage(inboundText(message), { deliverAs: "followUp" });
					return;
				}
				const alreadyClaiming = config.claimNextSession === true;
				persist({
					...config,
					claimNextSession: true,
					pendingInbound: [...(config.pendingInbound ?? []), message],
				});
				if (!alreadyClaiming) smolt.sendUserMessage("/telegram inbound", { expandPromptTemplates: true });
			},
			onAck: (lastUpdateId) => {
				if (config) persist({ ...config, lastUpdateId });
			},
		});
		poller.start();
	}

	function stopPolling(): void {
		poller?.stop();
		poller = undefined;
	}

	function deliverPending(): void {
		if (!config) return;
		const pending = config.pendingInbound ?? [];
		persist({ ...config, claimNextSession: false, pendingInbound: [] });
		if (pending.length === 0) return;
		startRemoteTurn();
		for (const message of pending) {
			smolt.sendUserMessage(inboundText(message), { deliverAs: "followUp" });
		}
	}

	smolt.on("session_start", async (_event, ctx) => {
		currentSessionId = ctx.sessionManager.getSessionId();
		inboundBriefed = false;
		// Only a process that can host inbound may consume the claim; a pane
		// process (inbound off) switching sessions must never steal it.
		if (inboundEnabled && config?.claimNextSession) {
			// This session was created for the phone conversation: mark it and
			// deliver whatever arrived while it was being set up.
			persist({ ...config, telegramSessionId: currentSessionId });
			deliverPending();
		}
		startPolling();
	});

	smolt.on("session_shutdown", async () => {
		stopPolling();
		endRemoteTurn();
	});

	smolt.on("turn_end", async (event) => {
		if (!remoteTurn) return;
		// Feed the token counter the same way the app's working line does.
		const usage = (event.message as { usage?: { input?: number; output?: number } }).usage;
		if (usage) remoteTokens += (usage.input ?? 0) + (usage.output ?? 0);
	});

	smolt.on("message_update", async (event) => {
		if (!remoteTurn) return;
		lastPartial = event.message;
	});

	smolt.on("tool_execution_start", async (event) => {
		if (!remoteTurn) return;
		stagePhrase = toolStage(event.toolName);
	});

	smolt.on("agent_end", async (event) => {
		if (!remoteTurn) return;
		// Remember the last assistant text so settle can forward it if the
		// model never called the telegram tool.
		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i] as { role?: string; content?: unknown };
			if (message.role !== "assistant") continue;
			const content = message.content;
			const text =
				typeof content === "string"
					? content
					: Array.isArray(content)
						? content
								.filter(
									(block): block is { type: string; text: string } =>
										typeof block === "object" &&
										block !== null &&
										(block as { type?: string }).type === "text" &&
										typeof (block as { text?: string }).text === "string",
								)
								.map((block) => block.text)
								.join("\n")
								.trim()
						: "";
			if (text !== "") {
				finalReply = text;
				break;
			}
		}
	});

	smolt.on("agent_settled", async () => {
		if (!remoteTurn) return;
		const linked = linkedClient();
		if (linked) {
			if (!sentViaTool && finalReply) {
				try {
					await sendLogged(markdownToPlain(finalReply));
				} catch {
					// Delivery is best-effort; the reply still lives in the session.
				}
			}
			// The status line always ends up BELOW the reply, as the chat's
			// final message.
			await repositionStatus("done");
		}
		endRemoteTurn();
	});

	// The token is collected through a UI dialog, never a tool parameter: it
	// must not enter the model's context or the transcript.
	async function configureAction(ctx: ExtensionContext): Promise<ActionResult> {
		if (!ctx.hasUI) {
			return { success: false, error: "'configure' needs an interactive session to ask the user for the token." };
		}
		const token = await ctx.ui.input(
			"Telegram bot token",
			"123456789:AAF... (goes straight to local config — never to the model)",
		);
		const trimmed = token?.trim();
		if (!trimmed) return { success: false, error: "The user cancelled the token dialog." };
		const api = new TelegramClient(trimmed, fetchImpl);
		try {
			const me = await api.getMe();
			const botUsername = me.username ?? me.first_name ?? "bot";
			stopPolling();
			persist({ token: trimmed, chatId: UNLINKED, botUsername, enabled: true });
			return {
				success: true,
				bot: botUsername,
				next: `Token accepted. Have the user open https://t.me/${botUsername} and send the bot any message, then call action 'link'.`,
			};
		} catch (error) {
			return {
				success: false,
				error: `Telegram rejected the token: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	async function linkAction(): Promise<ActionResult> {
		if (!config)
			return {
				success: false,
				error: "No token configured. Call action 'configure' first — it asks the user for the token via a dialog.",
			};
		const api = new TelegramClient(config.token, fetchImpl);
		let offset = config.lastUpdateId !== undefined ? config.lastUpdateId + 1 : 0;
		let found: { chatId: number; chatName: string; lastUpdateId: number } | undefined;
		for (let attempt = 0; attempt < linkWaitAttempts && !found; attempt++) {
			let updates: Awaited<ReturnType<typeof api.getUpdates>>;
			try {
				updates = await api.getUpdates(offset, linkWaitPollSeconds);
			} catch {
				continue;
			}
			for (const update of updates) {
				offset = Math.max(offset, update.update_id + 1);
				const message = update.message;
				if (!message || (message.chat.type !== undefined && message.chat.type !== "private")) continue;
				const chatName =
					message.chat.first_name ?? message.chat.username ?? message.chat.title ?? String(message.chat.id);
				found = { chatId: message.chat.id, chatName, lastUpdateId: update.update_id };
				break;
			}
		}
		if (!found) {
			if (config.chatId !== UNLINKED) {
				return { success: true, chat: config.chatName ?? String(config.chatId), note: "already linked" };
			}
			return {
				success: false,
				error: "No message from the user arrived yet. Ask them to send the bot a message, then call 'link' again.",
			};
		}
		stopPolling();
		persist({
			...config,
			chatId: found.chatId,
			chatName: found.chatName,
			enabled: true,
			lastUpdateId: found.lastUpdateId,
		});
		try {
			await sendLogged(
				"smolt is connected. The agent can message you here, and anything you type here reaches the session. Send /new any time to wipe this chat and start a fresh session, or /stop to halt the agent mid-task.",
			);
		} catch {
			// The link is saved; a failed hello is not fatal.
		}
		startPolling();
		return { success: true, chat: found.chatName, bot: config.botUsername };
	}

	async function sendAction(message: string | undefined, silent: boolean): Promise<ActionResult> {
		if (!config) return { success: false, error: "No Telegram chat is linked. Ask the user to run /telegram." };
		if (config.chatId === UNLINKED) {
			return {
				success: false,
				error: "A token is configured but no chat is linked yet. Have the user message the bot, then call action 'link'.",
			};
		}
		if (!config.enabled) {
			return { success: false, error: "The Telegram connector is disabled. Ask the user to run /telegram on." };
		}
		if (!message || message.trim() === "") return { success: false, error: "'send' requires 'message'" };
		try {
			const sent = await sendLogged(markdownToPlain(message), silent);
			sentViaTool = true;
			// A mid-task update landed below the status line; move it back down.
			if (remoteTurn) void repositionStatus();
			return { success: true, chunks: sent.chunks, chat: config.chatName ?? String(config.chatId) };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	function statusAction(): ActionResult {
		return {
			success: true,
			configured: config !== undefined,
			linked: config !== undefined && config.chatId !== UNLINKED,
			enabled: config?.enabled ?? false,
			bot: config?.botUsername,
			chat: config?.chatName,
			inbound: poller?.status ?? "not polling",
			last_error: poller?.lastError,
		};
	}

	smolt.registerTool({
		name: "telegram",
		label: "Telegram",
		description:
			"Message the user on Telegram, and manage the connector. The default action 'send' delivers a " +
			"plain-text message to the linked chat (markdown is flattened and long text chunked " +
			"automatically): use it to report " +
			"progress or completion of long-running work, and to ask a question when the user seems away. " +
			"When a turn was triggered by a '[Telegram message from ...]', your final reply is forwarded " +
			"to Telegram automatically — use 'send' there only for mid-task updates, not to duplicate the " +
			"final answer.\n\n" +
			"Setup actions, used when walking the user through /telegram setup: 'configure' asks the user " +
			"for their BotFather token through a secure input dialog (the token NEVER passes through you " +
			"— do not ask the user to paste it in chat), validates it, and stores it; 'link' waits ~30s " +
			"for the user's first message to the bot and links that chat (call it again if nothing " +
			"arrived); 'status' reports the connector state. If 'send' reports nothing is linked, ask " +
			"the user to run /telegram.",
		parameters: Type.Object({
			action: Type.Optional(
				Type.Union(
					[Type.Literal("send"), Type.Literal("configure"), Type.Literal("link"), Type.Literal("status")],
					{ description: "Operation; defaults to 'send'." },
				),
			),
			message: Type.Optional(Type.String({ description: "Message text for 'send'. Plain text; no markup." })),
			silent: Type.Optional(
				Type.Boolean({ description: "'send' only: deliver without a notification sound (low-urgency updates)." }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			switch (params.action ?? "send") {
				case "configure":
					return jsonResult(await configureAction(ctx));
				case "link":
					return jsonResult(await linkAction());
				case "status":
					return jsonResult(statusAction());
				default:
					return jsonResult(await sendAction(params.message ?? undefined, params.silent ?? false));
			}
		},
	});

	function statusLine(): string {
		if (!config) return "Telegram: not set up. Run /telegram to link a bot.";
		const link = `@${config.botUsername ?? "?"} <-> ${config.chatName ?? config.chatId}`;
		if (config.chatId === UNLINKED)
			return `Telegram: token saved for @${config.botUsername ?? "?"}, chat not linked yet — run /telegram to continue`;
		if (!config.enabled) return `Telegram: ${link}, disabled (/telegram on to enable)`;
		const state = poller ? poller.status : "not polling";
		const error = poller?.lastError ? ` (${poller.lastError})` : "";
		return `Telegram: ${link}, inbound ${state}${error}`;
	}

	smolt.registerCommand("telegram", {
		description: "Link Telegram: the agent can message you, and your replies reach the session",
		getArgumentCompletions: (argumentPrefix) => {
			const items = [
				{ value: "setup", label: "setup", description: "Have the agent walk you through linking a bot" },
				{ value: "status", label: "status", description: "Show the linked chat and connection state" },
				{ value: "on", label: "on", description: "Enable the connector" },
				{ value: "off", label: "off", description: "Disable the connector" },
				{ value: "test", label: "test", description: "Send a test message to the linked chat" },
				{
					value: "new",
					label: "new",
					description: "Start a fresh session (also: send /new to the bot in Telegram)",
				},
				{
					value: "stop",
					label: "stop",
					description: "Abort the running agent (also: /stop or /cancel in Telegram)",
				},
			];
			const prefix = argumentPrefix.trim().toLowerCase();
			return items.filter((item) => item.value.startsWith(prefix));
		},
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "setup" || (arg === "" && (!config || config.chatId === UNLINKED))) {
				smolt.sendUserMessage(SETUP_PROMPT);
				return;
			}
			if (arg === "" || arg === "status") {
				ctx.ui.notify(statusLine(), "info");
				return;
			}
			if (!config) {
				ctx.ui.notify("Telegram is not set up yet. Run /telegram to link a bot.", "warning");
				return;
			}
			switch (arg) {
				case "on":
					persist({ ...config, enabled: true });
					startPolling();
					ctx.ui.notify(statusLine(), "info");
					return;
				case "off":
					persist({ ...config, enabled: false });
					stopPolling();
					ctx.ui.notify("Telegram disabled. Outbound and inbound are off until /telegram on.", "info");
					return;
				case "test":
					try {
						await sendLogged("Test message from smolt.");
						ctx.ui.notify(`Test message sent to ${config.chatName ?? config.chatId}`, "info");
					} catch (error) {
						ctx.ui.notify(`Test failed: ${error instanceof Error ? error.message : String(error)}`, "error");
					}
					return;
				case "new": {
					const result = await ctx.newSession();
					if (!result.cancelled) ctx.ui.notify("New session started", "info");
					return;
				}
				case "inbound": {
					// Internal bridge from the poller: a phone message arrived while
					// another chat was open, so it gets its own fresh session.
					const result = await ctx.newSession();
					// On cancel, fall back to the open session over dropping messages.
					if (result.cancelled) deliverPending();
					return;
				}
				case "stop": {
					const wasRunning = !ctx.isIdle();
					if (wasRunning) ctx.abort();
					// Freeze the mirror without forwarding a half-finished reply. The
					// frozen line ends up below the ack, as the chat's last message.
					const status = statusId;
					const frozen = statusText("stopped");
					endRemoteTurn();
					const linked = linkedClient();
					if (linked && status !== undefined) {
						void linked.api.deleteMessage(linked.chatId, status).catch(() => {});
					}
					try {
						await sendLogged(wasRunning ? "⏹ Stopped." : "Nothing was running.");
						if (status !== undefined) await sendLogged(frozen, true);
					} catch {
						// The abort already happened; the ack is best-effort.
					}
					ctx.ui.notify(wasRunning ? "Agent stopped" : "Nothing was running", "info");
					return;
				}
				default:
					ctx.ui.notify("Usage: /telegram [setup|status|on|off|test|new|stop]", "warning");
					return;
			}
		},
	});

	return {
		getConfig: () => config,
		getPoller: () => poller,
	};
}
