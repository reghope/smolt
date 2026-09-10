# @smolt/desktop

A minimalist desktop app for the Smolt coding agent — the same functionality
as the CLI, as a GUI. Dark, quiet, chat-first.

The app embeds the agent through its supported RPC mode: the Electron main
process spawns `smolt --mode rpc` (via the typed `RpcClient`) and bridges a
whitelisted command surface to the renderer over IPC. Everything the CLI can
do flows through the same protocol: prompting with live streaming, steering
mid-run, abort, tool-call display with outputs, session switching and
resume, model and thinking-level switching, compaction and retry notices,
token usage. Reasoning never enters the transcript: the stream is condensed
into a live stage phrase on the working line (`thinking.ts`, ported from the
imagined web agent) and discarded once real output starts.

## Layout

- `src/main/` — Electron main process: window, IPC, the agent bridge
  (`agent-bridge.ts`, method-whitelisted), and the sidebar session lister.
- `src/preload.ts` — contextBridge surface (`window.smolt`).
- `src/renderer/` — React UI on shadcn/ui components (radix-ui + Tailwind,
  vendored under `components/ui/`), themed with the site's palette. Domain
  state lives outside React in `state/app.ts` (components subscribe via
  `useSyncExternalStore`); the pure event reducer (`store.ts`, fully
  unit-tested) and the dependency-free markdown renderer are unchanged.
  Tailwind compiles at build time into a static stylesheet, so the page's
  CSP needs no inline styles.

## Run

```bash
npm run build --workspace @smolt/desktop   # bundle main/preload/renderer
npm run dev --workspace @smolt/desktop     # build + launch
```

The bridge finds the CLI at `packages/coding-agent/dist/cli.js` (build the
workspace first) or via `SMOLT_CLI_PATH`. Useful env vars:

- `SMOLT_DESKTOP_PROVIDER` / `SMOLT_DESKTOP_MODEL` — initial model
- `SMOLT_DESKTOP_CWD` — agent working directory
- `SMOLT_DESKTOP_CONTINUE=1` — reopen the most recent session on launch
- `SMOLT_DESKTOP_SMOKE=1` — boot, wait for renderer ready, exit (CI smoke)
- `SMOLT_DESKTOP_SHOT=<path.png>` — capture the window and exit

## Tests

`npm test` runs the renderer typecheck (DOM lib is scoped to
`tsconfig.renderer.json`) plus four suites: the store reducer (streaming
assembly, tool lifecycle, history restore), the markdown renderer
(including escaping), an integration suite that drives the real CLI in RPC
mode (no API key needed), and an Electron full-boot smoke test. A live
end-to-end suite (real model, gated on `OPENCODE_API_KEY`) streams a prompt
through the same reducer the UI uses.

## Web server

Settings › General › "Local web server" serves the app in a browser from the running desktop process: the same agent, the same chats, one more window on them. It listens on `http://localhost:7332` and, when the machine has one, its Tailscale address, with HTTPS beside it on 7333 (a self-signed certificate made by openssl on first use; the browser warns once) — dictation needs the HTTPS one, because the microphone only exists in a secure context. The setting lives in `web-server.json` in the app's user-data folder (`{ "enabled": true, "port": 7332, "lan": false }`); `lan: true` binds every interface. There is no login: whoever can reach the port drives the agent.

The browser gets `window.smolt` from `src/web-shim.ts`, the preload's API over `POST /invoke` and an SSE stream at `/events`; a test keeps the two in step. `src/main/web-server.ts` records every `ipcMain.handle` and mirrors every `webContents.send`, so a browser client sees exactly what the window sees. Every window shows the same chat: a message sent from one streams into all of them through the mirrored agent events, and a chat opened in one is followed by the others (`session:changed`, announced by the main process after every move; a window not already there loads the chat the way it loads any other).
