# Telegram

Two-way bridge between a session and the user's Telegram account, through a bot the user owns. The agent can message the user (progress on long tasks, questions while they're away); whatever the user types to the bot comes back into the session as a user message, so the conversation continues from a phone.

## Setup

Setup is part of the conversation, not a modal wizard — identical in TUI and desktop. `/telegram` sends the agent a setup prompt; the agent then walks the user through it in the transcript:

1. It explains how to create a bot with @BotFather (recommending Telegram Desktop/web on this machine so the token is a straight copy-paste). The token itself **never enters the conversation**: tool action `configure` takes no token parameter — it opens a secure input dialog (TUI-native; the desktop's `ExtensionDialog` surface over RPC), and the value goes dialog → extension → config file without touching the model or the transcript. The setup prompt explicitly tells the user not to paste the token in chat, and to revoke it via BotFather if they do by mistake.
2. The user sends the bot one message; the agent discovers and links the chat (tool action `link`, ~30s wait per call, retryable), which saves the config, sends a hello, and starts inbound polling.

Config lives in `<agentDir>/telegram.json` (mode 0600): token, chat id, enabled flag, and the last delivered `update_id` so restarts don't replay messages. `chatId: 0` means a token is saved but no chat is linked yet; bare `/telegram` resumes setup from there.

## Surfaces

- **`telegram` tool** — default action `send`: plain text to the linked chat, auto-chunked to the 4096-char API limit, optional `silent` delivery. Setup actions `configure`, `link`, and `status` power the conversational setup.
- **`/telegram [setup|status|on|off|test|new]`** — start/resume setup, connection state, enable/disable (off blocks both directions), test message, fresh session.
- **`/stop` (or `/cancel`) from the phone** — never reaches the model: it bridges to `/telegram stop`, whose handler aborts the running agent immediately (extension commands dispatch even mid-stream), freezes the status line as `· stopped`, skips the half-finished reply forward, and acks "⏹ Stopped." — or "Nothing was running." when idle. `/telegram stop` works from the app too.
- **`/new` from the phone** — sending `/new` to the bot never reaches the model. The extension wipes the Telegram chat (best-effort `deleteMessage` of every logged message id — both sides' messages, within Telegram's ~48h window; ids persist in the config so the log survives restarts), posts "New session started", and starts a new session in whichever surface is connected, by dispatching `/telegram new` whose command handler calls `ctx.newSession()`.
- **Inbound long-poll** — starts at `session_start` when enabled, stops at `session_shutdown`. Only messages from the linked chat are accepted; anyone else who finds the bot is dropped. Delivered messages are prefixed `[Telegram message from ...]`.
- **Own session, never the open chat** — phone messages belong to a dedicated Telegram session (`telegramSessionId` in the config). If that session is the active one, messages deliver straight in; otherwise they are queued (`pendingInbound`), a fresh session is opened via the internal `/telegram inbound` bridge, the new session claims the Telegram role at `session_start` (one-shot `claimNextSession` flag, race-free across the extension-runtime replacement), and the queue drains there. If session creation is cancelled, delivery falls back to the open chat rather than dropping messages. `/new` from the phone claims its fresh session the same way.
- **Remote-turn mirror** — a turn triggered from Telegram gives instant, continuous feedback on the phone, styled like the app's own working indicator: the "typing…" indicator starts immediately, and once the turn outlives a few seconds a single silent status message appears and is *edited* on each ~4s heartbeat — `✻ 1m 30s · 8.0k tokens · working…` (elapsed time plus token usage accumulated from turn ends; no per-tool detail). Delivery of the answer is guaranteed — if the model didn't send one via the tool, the turn's final assistant reply is forwarded automatically at settle, and the status line flips to `· done`. Turns started at the keyboard are never mirrored.

## Concurrency

The Bot API allows one `getUpdates` consumer per bot. The first eligible process holds the connection; others see HTTP 409, report status "conflict", and retry every 30s — so the inbound connection migrates automatically when the holder exits. Outbound sends work from any number of sessions at once.

**The desktop GUI never moves for a phone message.** Eligibility is controlled by `SMOLT_TELEGRAM_POLL` (extension option `inbound`): the desktop starts every pane-visible agent (main slots, side chat) with it `off`, and runs a dedicated Telegram host process (`main.ts`, spawned when the linked config exists, synced every 15s so setup/unlink take effect live) with it `on`. Phone conversations happen entirely inside that host — its sessions land on disk like any other, so they appear in the sidebar's session list — while the panes stay wherever the user is working. Both sides run at the same time. A bare TUI process keeps the old single-process behavior (it hosts inbound itself and follows the conversation) unless started with `SMOLT_TELEGRAM_POLL=off`.

## Files

- `client.ts` — Bot API client (injectable fetch), config store, chunking, `TelegramPoller` long-poll loop.
- `index.ts` — extension wiring: tool, command + wizard, poller lifecycle. `createTelegramExtension(api, paths, options)` exists for tests; the default export resolves the agent-dir config path.

Tests: `test/telegram-client.test.ts`, `test/telegram-extension.test.ts` — fully offline against a fake fetch.
