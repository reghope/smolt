import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, session, shell, systemPreferences } from "electron";
import { AgentBridge, findCliPath } from "./agent-bridge.ts";
import { pendingPermissionRequests, requestPid, watchPermissionRequests, writePermissionReply } from "./approvals.ts";
import { ensureCliShim } from "./cli-shim.ts";
import {
	captureDiffBaseline,
	changedBetween,
	classifyToolCall,
	collectDiff,
	type DiffBaseline,
	toGitPath,
} from "./diff.ts";
import { transformersEntry } from "./embeddings-module.ts";
import { refreshIconCacheAfterUpdate } from "./icon-cache.ts";
import { fetchLinkPreview } from "./link-preview.ts";
import { listSessions, searchSessions } from "./sessions.ts";
import { ensureModel, speechStatus, stopSpeech, transcribeSamples } from "./speech.ts";
import { collectStats } from "./stats.ts";
import { checkNow, installUpdate, startUpdates, updateState } from "./updates.ts";
import { createWorktree, listWorktrees, removeWorktree, repoRoot } from "./worktrees.ts";

const SMOKE = process.env.SMOLT_DESKTOP_SMOKE === "1";

// Unpackaged builds listen for DevTools on localhost so a wedged renderer can
// be inspected from outside — heap snapshots are how the freeze bugs get
// found. Loopback only; packaged builds never open it.
if (!app.isPackaged) {
	app.commandLine.appendSwitch("remote-debugging-port", process.env.SMOLT_DESKTOP_DEVTOOLS_PORT ?? "9223");
	app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
}

// ---------------------------------------------------------------------------
// Stall evidence. The window freezes whenever this process blocks its event
// loop (sync fs, sync git, big JSON.parse) — the renderer stays innocent and
// the user just sees a dead app. Every IPC handler is timed, and a heartbeat
// notices multi-second gaps, so a freeze leaves a named culprit in
// main-stalls.log instead of a mystery.
// ---------------------------------------------------------------------------
let inFlightChannel = "";
const stallLogPath = (): string => join(app.getPath("userData"), "main-stalls.log");
const logStall = (line: string): void => {
	try {
		appendFileSync(stallLogPath(), `${new Date().toISOString()} ${line}\n`, "utf-8");
	} catch {
		// Diagnostics must never hurt the app.
	}
};
{
	const originalHandle = ipcMain.handle.bind(ipcMain);
	(ipcMain as { handle: typeof ipcMain.handle }).handle = (channel, listener) =>
		originalHandle(channel, async (...args: Parameters<typeof listener>) => {
			const started = Date.now();
			const previous = inFlightChannel;
			inFlightChannel = channel;
			try {
				return await listener(...args);
			} finally {
				inFlightChannel = previous;
				const ms = Date.now() - started;
				if (ms > 1_000) logStall(`ipc ${channel} took ${ms}ms`);
			}
		});
	let lastBeat = Date.now();
	setInterval(() => {
		const now = Date.now();
		const stalled = now - lastBeat - 1_000;
		if (stalled > 2_000) {
			logStall(`event loop blocked ~${Math.round(stalled / 1000)}s (in flight: ${inFlightChannel || "none"})`);
		}
		lastBeat = now;
	}, 1_000).unref();
}

const bridge = new AgentBridge();

/**
 * The app's own version, not the runtime's.
 *
 * `app.getVersion()` answers with the Electron binary's version when the app
 * is launched unpackaged straight at its main script, so the settings footer
 * read like a Chromium build number. Prefer the package.json this file ships
 * in, and fall back to Electron's answer only when it cannot be found.
 */
const appVersion = (): string => {
	let dir = app.getAppPath();
	for (let guard = 0; guard < 4 && dir !== dirname(dir); guard += 1) {
		try {
			const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as {
				name?: unknown;
				version?: unknown;
			};
			if (manifest.name === "@smolt/desktop" && typeof manifest.version === "string") return manifest.version;
		} catch {
			// No manifest here; walk up one more level.
		}
		dir = dirname(dir);
	}
	return app.getVersion();
};

/**
 * One agent per session with work in flight, as the reference apps do it.
 *
 * The app used to drive a single agent, so switching chats had to tear down
 * the running turn. Instead, a busy agent keeps its session and keeps
 * working in the background; the switch lands on another slot — an idle
 * existing one, or a freshly spawned agent — and the sidebar marks sessions
 * that are still running.
 */
interface AgentSlot {
	/** Stable identity, so a forwarded event names the agent it came from. */
	id: number;
	bridge: AgentBridge;
	/** Session file this agent currently holds; "" until first known. */
	sessionPath: string;
	busy: boolean;
	/** Tree at the running turn's start, in case the turn runs a sweeping tool. */
	turnCapture: Promise<DiffBaseline> | null;
	/** Files the running turn's edit/write calls have named so far. */
	turnWrote: Set<string>;
	/** The running turn used bash or another tool that can write anywhere. */
	turnSwept: boolean;
}
/** How much of a stored transcript the window is asking for. */
interface SessionWindow {
	limit?: number;
	before?: number;
}

const slots: AgentSlot[] = [];
/** Hands out slot ids; only ever compared, never persisted. */
let slotSeq = 0;
/** Idle agents kept warm for quick switching, beyond the active one. */
const MAX_SLOTS = 3;
/**
 * Second agent for side chats: a throwaway thread for a question you do not
 * want in the main transcript. Started lazily, because most sessions never
 * open one and it is a whole extra agent process.
 */
let sideBridge: AgentBridge | null = null;
/**
 * Pane-visible agents never poll Telegram: inbound phone messages would
 * hijack whatever chat is open. A dedicated host process (below) owns the
 * phone conversation instead, so both can run at the same time.
 */
const PANE_ENV = { SMOLT_TELEGRAM_POLL: "off" };

/**
 * How to start an agent process.
 *
 * Packaged, there may be no Node on the machine at all, but Electron carries
 * one: run our own binary with ELECTRON_RUN_AS_NODE and it behaves as node.
 */
const agentExecPath = (): string | undefined => (app.isPackaged ? process.execPath : undefined);
/**
 * Ambient CLI variables that must not reach the app's own agents.
 *
 * The agent inherits the environment of whatever shell launched the app;
 * session and provider variables set there describe *that* program's
 * choices, not this window's. The app names its agents' provider, model and
 * sessions explicitly, so ambient ones are stripped rather than inherited —
 * a shell that was pointing at a live session must not drag the desktop
 * into it.
 */
const STRIPPED_AGENT_VARS = [
	"SMOLT_SESSION_FILE",
	"SMOLT_SESSION_ID",
	"SMOLT_PROVIDER",
	"SMOLT_MODEL",
	"SMOLT_THINKING_LEVEL",
	"SMOLT_RESUME",
	"SMOLT_CONTINUE",
] as const;

/**
 * Extra environment for a spawned agent, minus the ambient variables above.
 *
 * An `undefined` value deletes an inherited variable instead of setting it,
 * which is what lets the spawn filter below drop the shell's leftovers.
 */
const embeddingsModule = transformersEntry();
const agentEnv = (extra: Record<string, string>): Record<string, string | undefined> => ({
	...Object.fromEntries(STRIPPED_AGENT_VARS.map((name) => [name, undefined])),
	...(app.isPackaged ? { ELECTRON_RUN_AS_NODE: "1", SMOLT_PACKAGE_DIR: join(process.resourcesPath, "agent") } : {}),
	// The agents embed past sessions with the app's own copy of transformers.js.
	...(embeddingsModule ? { SMOLT_EMBEDDINGS_MODULE: embeddingsModule } : {}),
	...extra,
});

let telegramBridge: AgentBridge | null = null;
let telegramSync: Promise<void> = Promise.resolve();

function telegramConfigPath(): string {
	const envDir = process.env.SMOLT_CODING_AGENT_DIR;
	const agentDir = envDir
		? envDir.startsWith("~")
			? join(homedir(), envDir.slice(1))
			: envDir
		: join(homedir(), ".smolt", "agent");
	return join(agentDir, "telegram.json");
}

function telegramConfigured(): boolean {
	try {
		const raw = JSON.parse(readFileSync(telegramConfigPath(), "utf-8")) as { enabled?: boolean; chatId?: number };
		return raw.enabled !== false && typeof raw.chatId === "number" && raw.chatId !== 0;
	} catch {
		return false;
	}
}

/**
 * The session the dedicated Telegram host is writing into.
 *
 * The host is a hidden agent with no pane of its own, so without asking it
 * there is nothing to tell its chat apart from any other file in the sessions
 * directory. Answered from the bridge rather than remembered, because `/new`
 * in the Telegram chat rotates the session underneath us.
 */
async function telegramSessionPath(): Promise<string> {
	if (!telegramBridge) return "";
	try {
		const state = (await telegramBridge.call("getState", [])) as { sessionFile?: string } | undefined;
		return typeof state?.sessionFile === "string" ? state.sessionFile : "";
	} catch {
		// A host that cannot answer simply has no chat to lift out.
		return "";
	}
}

/** Start or stop the dedicated Telegram host to match the linked config. */
function syncTelegramHost(): void {
	telegramSync = telegramSync.then(async () => {
		const want = telegramConfigured();
		if (want && !telegramBridge) {
			const host = new AgentBridge();
			await host.start(
				{
					cwd: homeCwd(),
					provider: process.env.SMOLT_DESKTOP_PROVIDER,
					model: process.env.SMOLT_DESKTOP_MODEL,
					env: agentEnv({ SMOLT_TELEGRAM_POLL: "on" }),
					execPath: agentExecPath(),
					onDiagnostic: crashLog,
				},
				__dirname,
			);
			if (host.status.error) {
				await host.stop();
				return;
			}
			noteAgentPid(host);
			telegramBridge = host;
		} else if (!want && telegramBridge) {
			const host = telegramBridge;
			telegramBridge = null;
			await host.stop();
		}
	});
}

/** The directory the main agent is running in; a worktree once isolated. */
function projectFile(): string {
	const envDir = process.env.SMOLT_CODING_AGENT_DIR;
	const base = envDir?.trim()
		? envDir.startsWith("~")
			? join(homedir(), envDir.slice(1))
			: envDir
		: join(homedir(), ".smolt", "agent");
	return join(base, "desktop-project");
}

/**
 * Which folder is open, and the folders opened before it.
 *
 * The two are separate because no folder is a real state: a reader can work
 * with nothing selected, and closing a folder must not forget the ones they
 * have used. Chats are stored per working directory, so the list is what makes
 * opening a folder a filter they can undo rather than a one-way door.
 */
interface ProjectState {
	/** Open folders, primary first; empty means none. */
	folders: string[];
	recent: string[];
}

function readProjectState(): ProjectState {
	let text: string;
	try {
		text = readFileSync(projectFile(), "utf-8").trim();
	} catch {
		return { folders: [], recent: [] };
	}
	if (text === "") return { folders: [], recent: [] };
	let folders: string[] = [];
	let recent: string[] = [];
	try {
		const parsed: unknown = JSON.parse(text);
		if (Array.isArray(parsed)) {
			// The second version held a bare list with the open folder first.
			recent = parsed.filter((entry): entry is string => typeof entry === "string");
			folders = recent.slice(0, 1);
		} else if (parsed !== null && typeof parsed === "object") {
			const shape = parsed as { active?: unknown; folders?: unknown; recent?: unknown };
			folders = Array.isArray(shape.folders)
				? shape.folders.filter((entry): entry is string => typeof entry === "string")
				: typeof shape.active === "string"
					? [shape.active]
					: [];
			recent = Array.isArray(shape.recent)
				? shape.recent.filter((entry): entry is string => typeof entry === "string")
				: [];
		}
	} catch {
		// The first version held a single bare path.
		folders = [text];
		recent = [text];
	}
	// A folder that has since been moved or deleted must not strand the app.
	return {
		folders: folders.filter((entry) => existsSync(entry)),
		recent: recent.filter((entry) => existsSync(entry)),
	};
}

function writeProjectState(state: ProjectState): void {
	mkdirSync(dirname(projectFile()), { recursive: true });
	writeFileSync(projectFile(), JSON.stringify(state, null, "	"), "utf-8");
}

/**
 * Record which folders are open, keeping the ones being left behind listed.
 *
 * Only the first is the agent's working directory; the rest are extra places
 * it has been told it may use. Nothing is ever dropped from `recent`, so
 * closing a folder is always reversible in one click.
 */
function rememberProject(next: string[], leaving: string[]): void {
	const previous = readProjectState().recent;
	const keep = leaving.filter((entry) => !next.includes(entry));
	const rest = previous.filter((entry) => !next.includes(entry) && !keep.includes(entry));
	writeProjectState({ folders: next, recent: [...next, ...keep, ...rest].slice(0, 12) });
}

/**
 * Where the agent runs with no folder open.
 *
 * It needs some directory to start in, and it must not be one of the reader's:
 * with nothing selected the agent has no business writing anywhere, and the
 * note below tells it to ask first.
 */
function scratchDir(): string {
	const dir = join(dirname(projectFile()), "scratch");
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** The extra system prompt this agent should start with, if any. */
function agentNotes(): string[] | undefined {
	if (projectFolders.length === 0) return ["--append-system-prompt", NO_PROJECT_NOTE];
	const extra = projectFolders.slice(1);
	return extra.length > 0 ? ["--append-system-prompt", extraFoldersNote(extra)] : undefined;
}

/** Told to the agent when folders beyond the working directory are open. */
function extraFoldersNote(extra: string[]): string {
	return (
		`Besides the working directory, the user has opened these project folders: ${extra.join(", ")}. ` +
		"Treat them as part of this project — you may read and change files there — but keep the working " +
		"directory as the default place for anything new unless the user says otherwise."
	);
}

/** Told to the agent whenever no folder is open. */
const NO_PROJECT_NOTE =
	"No project folder is open in this app, so there is no directory the user has chosen to work in. " +
	"Answer questions and reason freely, but before creating, writing or moving any file, ask the user " +
	"where it should go. Do not fall back to the current working directory.";

let projectFolders: string[] = readProjectState().folders;

/**
 * Agent processes this app owns, by pid.
 *
 * The permission-request directory is machine-global: every smolt agent on
 * the machine — another app instance, the CLI, the tests — drops its
 * questions in the same place. Only a question raised by one of this
 * window's own agents may show a card here; forwarding everyone's requests
 * meant one window could see, and answer, another's command.
 */
const ownedAgentPids = new Set<number>();
/** Requests this window has shown a card for, so their removal can be reported. */
const shownRequestIds = new Set<string>();
/** Bridges being deliberately stopped; their exits are not failures. */
const stoppingBridges = new WeakSet<AgentBridge>();

const noteAgentPid = (bridge: AgentBridge): void => {
	const pid = bridge.pid;
	if (typeof pid === "number") ownedAgentPids.add(pid);
	bridge.onExit(() => {
		if (typeof pid === "number") ownedAgentPids.delete(pid);
	});
};

const requestIsOurs = (id: string): boolean => {
	const pid = requestPid(id);
	return pid !== undefined && ownedAgentPids.has(pid);
};

/** Extension UI methods that hold an agent's turn open until answered. */
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const isDialogRequest = (event: unknown): boolean =>
	DIALOG_METHODS.has(String((event as { method?: unknown }).method ?? ""));

/**
 * The chat a request belongs to, from the asking agent's pid. A request card
 * should interrupt the chat whose agent asked, not every chat this window
 * ever shows — the renderer filters on the slot, and marks the session's
 * sidebar row so a background chat's question is findable rather than silent.
 */
const requestMeta = (id: string): { slot?: number; session?: string } => {
	const pid = requestPid(id);
	const slot = pid === undefined ? undefined : slots.find((candidate) => candidate.bridge.pid === pid);
	return { slot: slot?.id, session: slot?.sessionPath || undefined };
};
/**
 * Where the agent works when no chat has moved it: the explicit override
 * first, then the project folder the window remembers, then a scratch
 * directory. Every agent slot is rooted here, including the first one — it
 * used to start in the process working directory instead, so the opening
 * chat of every launch ran somewhere other than the folder on screen.
 */
const homeCwd = (): string => process.env.SMOLT_DESKTOP_CWD || projectFolders[0] || scratchDir();
let activeCwd = homeCwd();
/**
 * The tree as this chat found it. Anything already modified when a chat opens
 * belongs to whoever made it, not to the chat, so the pane and the composer
 * bar report only what has changed since.
 */
let diffBaseline: DiffBaseline = new Map();
/**
 * Resolves once the snapshot exists.
 *
 * The window asks for the diff while it is starting up, which is before the
 * first snapshot has been taken. Answering then, with an empty baseline, makes
 * every file in the tree look like this chat's work — so the diff waits.
 */
let baselineReady: Promise<void> = Promise.resolve();
/**
 * Paths the visible chat's turns actually changed. The tree also moves under
 * editors, builds and other sessions while a chat sits open, so differing
 * from the chat-open snapshot alone cannot pin a change on the chat: paths
 * land here only from the tools its turns ran — edit/write name their file,
 * and a turn that used bash is swept by comparing the tree across it.
 */
let attributed = new Set<string>();
/** Resolves once the last settled turn's changes have been attributed. */
let attributionReady: Promise<void> = Promise.resolve();
/** Repo root for the active tree: git reports diff paths relative to it. */
let repoRootPath = activeCwd;
const rebaseline = (): Promise<void> => {
	// A different conversation starts from a different tree, and owns none of
	// the old one's edits.
	attributed = new Set();
	baselineReady = (async () => {
		repoRootPath = (await repoRoot(activeCwd)) ?? activeCwd;
		diffBaseline = await captureDiffBaseline(activeCwd);
	})();
	return baselineReady;
};

/**
 * Record something that went wrong badly enough to lose the window.
 *
 * Kept as a plain file beside the agent`s own state: when the interface
 * disappears there is nowhere on screen left to report it, and "it just went
 * blank" needs something to look at afterwards.
 */
function crashLog(message: string): void {
	const line = `${new Date().toISOString()} ${message}`;
	console.error(line);
	try {
		const dir = join(homedir(), ".smolt", "agent");
		mkdirSync(dir, { recursive: true });
		appendFileSync(
			join(dir, "desktop-crash.log"),
			`${line}
`,
		);
	} catch {
		// Losing the log must not itself throw; the console line still stands.
	}
}

function createWindow(): BrowserWindow {
	const win = new BrowserWindow({
		width: 1200,
		height: 820,
		minWidth: 720,
		minHeight: 480,
		backgroundColor: "#0a0b0e",
		titleBarStyle: "hidden",
		titleBarOverlay: { color: "#0a0b0e", symbolColor: "#aeb4bd", height: 36 },
		show: false,
		webPreferences: {
			preload: join(__dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
		},
	});
	win.loadFile(join(__dirname, "index.html"));

	/**
	 * A dead renderer must not leave a black window.
	 *
	 * The React tree has its own error boundary, so anything it can catch is
	 * already reported in place. What lands here is the other kind: the render
	 * process itself gone — out of memory, killed, or crashed — which leaves a
	 * window that is simply empty, with no way back and nothing said. Reload it,
	 * and keep the reason where it can be found afterwards.
	 */
	let reloadsAfterCrash = 0;
	win.webContents.on("render-process-gone", (_event, details) => {
		crashLog(`render-process-gone reason=${details.reason} exitCode=${details.exitCode}`);
		if (win.isDestroyed()) return;
		// A crash that repeats on load would spin here; after a few goes, stop
		// and leave the window alone rather than flickering forever.
		reloadsAfterCrash += 1;
		if (reloadsAfterCrash > 3) return;
		// Not from inside the handler: Electron is still tearing the old render
		// process down, and reloading underneath that throws before it reloads.
		setTimeout(() => {
			if (!win.isDestroyed()) win.reload();
		}, 0);
	});
	win.webContents.on("unresponsive", () => crashLog("renderer unresponsive"));
	// Renderer errors are otherwise only visible with devtools open.
	win.webContents.on(
		"console-message",
		(event: { level?: unknown; message?: unknown; lineNumber?: unknown; sourceId?: unknown }) => {
			if (String(event?.level ?? "") !== "error") return;
			crashLog(
				`renderer error: ${String(event.message ?? "")} (${String(event.sourceId ?? "")}:${String(event.lineNumber ?? "")})`,
			);
		},
	);

	/**
	 * The window is frameless, so the menu it would normally carry is built
	 * here and raised from the titlebar's own button. Registering it also
	 * restores the Edit roles, which is what makes Ctrl+C and friends work.
	 */
	const send = (command: string): void => {
		if (!win.isDestroyed()) win.webContents.send("menu:command", command);
	};
	const appMenu = Menu.buildFromTemplate([
		{
			label: "File",
			submenu: [
				{ label: "New session", accelerator: "CmdOrCtrl+N", click: () => send("new-session") },
				{ label: "Open folder…", click: () => send("open-folder") },
				{ type: "separator" },
				{ label: "Settings", accelerator: "CmdOrCtrl+,", click: () => send("settings") },
				{ type: "separator" },
				{ role: "close" },
			],
		},
		{
			label: "Edit",
			submenu: [
				{ role: "undo" },
				{ role: "redo" },
				{ type: "separator" },
				{ role: "cut" },
				{ role: "copy" },
				{ role: "paste" },
				{ role: "selectAll" },
			],
		},
		{
			label: "View",
			submenu: [
				{ role: "reload" },
				{ role: "toggleDevTools" },
				{ type: "separator" },
				{ role: "resetZoom" },
				{ role: "zoomIn" },
				{ role: "zoomOut" },
				{ type: "separator" },
				{ role: "togglefullscreen" },
			],
		},
		{
			label: "Help",
			submenu: [{ label: "Keyboard shortcuts", accelerator: "CmdOrCtrl+/", click: () => send("shortcuts") }],
		},
	]);
	Menu.setApplicationMenu(appMenu);
	win.setMenuBarVisibility(false);
	ipcMain.handle("app:menu-popup", (_e, x: number, y: number) => {
		appMenu.popup({ window: win, x: Math.round(x), y: Math.round(y) });
		return { ok: true };
	});

	// Right-clicking a transcript should offer to copy it. Without this the only
	// route to the clipboard is Ctrl+C, which is not where people look first.
	win.webContents.on("context-menu", (_event, params) => {
		const items: Electron.MenuItemConstructorOptions[] = [];
		if (params.linkURL !== "") {
			items.push({ label: "Copy link", click: () => clipboard.writeText(params.linkURL) });
		}
		if (params.isEditable || params.selectionText !== "") {
			items.push({ role: "copy", enabled: params.selectionText !== "" });
		}
		if (params.isEditable) {
			items.push({ role: "cut", enabled: params.selectionText !== "" }, { role: "paste" });
		}
		items.push({ role: "selectAll" });
		Menu.buildFromTemplate(items).popup({ window: win });
	});
	win.once("ready-to-show", () => {
		win.show();
		// Looking for an update is background work; it must never delay the window.
		// A hotfix applies itself, but never through a turn in progress.
		void startUpdates(win, () => !slots.some((slot) => slot.busy));
	});

	// Links in a response belong in the user's browser. Without this a click
	// either navigates the window away from the app or opens a bare Electron
	// window; both lose the session view.
	win.webContents.setWindowOpenHandler(({ url }) => {
		if (/^https?:$/.test(new URL(url).protocol)) void shell.openExternal(url);
		return { action: "deny" };
	});
	win.webContents.on("will-navigate", (event, url) => {
		if (url === win.webContents.getURL()) return;
		event.preventDefault();
		if (/^https?:$/.test(new URL(url).protocol)) void shell.openExternal(url);
	});
	if (process.env.SMOLT_DESKTOP_DEBUG === "1") {
		win.webContents.on("console-message", (_e, _level, message) => {
			console.log(`[renderer] ${message}`);
		});
	}
	return win;
}

app.whenReady().then(async () => {
	// Snapshot before the window can ask, so the first answer is already right.
	void rebaseline();
	// One install, both surfaces: keep the terminal's `smolt` pointed at the
	// CLI this build shipped with.
	ensureCliShim();
	refreshIconCacheAfterUpdate();
	const win = createWindow();

	let active: AgentSlot = {
		id: ++slotSeq,
		bridge,
		sessionPath: "",
		busy: false,
		turnCapture: null,
		turnWrote: new Set(),
		turnSwept: false,
	};
	slots.push(active);

	/**
	 * A session change in flight.
	 *
	 * While this is set the window is between chats, so nothing is forwarded to
	 * it: the agent being left can still be streaming, and its words belong to
	 * the chat it came from, not the one about to appear.
	 */
	let switching: Promise<unknown> | null = null;

	const broadcastBusy = (): void => {
		if (win.isDestroyed()) return;
		win.webContents.send(
			"agent:busy",
			slots.filter((slot) => slot.busy).map((slot) => slot.sessionPath),
		);
	};

	/**
	 * Name the agent the window is now attached to.
	 *
	 * The view moves before the agent does — the renderer paints the next
	 * chat from disk while the switch is still in flight — so for a moment
	 * the window is showing one conversation and the old agent is still the
	 * one streaming. The renderer detaches for that moment and waits for
	 * this, rather than reducing whatever arrives into the chat on screen.
	 */
	const announceActive = (): void => {
		if (!win.isDestroyed()) win.webContents.send("agent:attached", active.id);
	};

	const refreshSlotPath = async (slot: AgentSlot): Promise<void> => {
		try {
			const state = (await slot.bridge.call("getState", [])) as { sessionFile?: unknown };
			slot.sessionPath = String(state?.sessionFile ?? "");
		} catch {
			// A slot with an unknown path just cannot be found for reuse.
		}
	};

	/**
	 * Every agent gets the same wiring: only the active one streams into the
	 * transcript, only the active one's turns feed diff attribution (a
	 * background session's work is rebaselined away on switch anyway), and a
	 * background agent finishing announces itself so the sidebar can settle
	 * its dot.
	 *
	 * Attribution follows the tools a turn ran, not its wall-clock window:
	 * edit/write name their file, a turn that ran bash is swept by comparing
	 * tree snapshots across it, and a turn that wrote nothing attributes
	 * nothing — so edits landing from elsewhere mid-turn stay unclaimed.
	 */
	const wireSlot = (slot: AgentSlot): void => {
		// An agent that died on its own is replaced at once, in the same chat;
		// the next message would otherwise fail against a dead client with
		// nothing on screen saying why.
		slot.bridge.onExit(({ code }) => {
			slot.busy = false;
			broadcastBusy();
			if (win.isDestroyed() || stoppingBridges.has(slot.bridge)) return;
			if (slot === active) void respawnAgent(slot, code);
			else win.webContents.send("agent:exited", { slotId: slot.id, wasActive: false });
		});
		slot.bridge.onEvent((event) => {
			const type = (event as { type?: string }).type;
			if (type === "agent_start") {
				slot.busy = true;
				// A working chat is the one a reader leaves; have the next agent ready.
				if (slot === active) ensureSpare();
				// The session file appears with the first message, so the path
				// recorded at spawn can be empty or stale; re-read it as a turn
				// begins, or the sidebar's busy dot points at nothing.
				void refreshSlotPath(slot).then(broadcastBusy);
				broadcastBusy();
				slot.turnCapture = captureDiffBaseline(activeCwd);
				slot.turnWrote = new Set();
				slot.turnSwept = false;
			} else if (type === "message_update") {
				const delta = (event as { assistantMessageEvent?: { type?: string; toolCall?: unknown } })
					.assistantMessageEvent;
				const call =
					delta?.type === "toolcall_end" ? (delta.toolCall as { name?: unknown; arguments?: unknown }) : null;
				if (call) {
					const { target, sweeping } = classifyToolCall(String(call.name ?? ""), call.arguments);
					if (target !== undefined) slot.turnWrote.add(toGitPath(target, activeCwd, repoRootPath));
					if (sweeping) slot.turnSwept = true;
				}
			} else if (type === "agent_settled") {
				slot.busy = false;
				broadcastBusy();
				const before = slot.turnCapture;
				const wrote = slot.turnWrote;
				const swept = slot.turnSwept;
				slot.turnCapture = null;
				if (slot === active) {
					// The turn's own attributed set: a rebaseline mid-capture swaps
					// the set out, and a stale turn must not write into the new chat's.
					const bucket = attributed;
					const settle = async (): Promise<void> => {
						for (const path of wrote) bucket.add(path);
						// Without a sweeping tool nothing else could have written;
						// skip the end snapshot rather than claim bystander edits.
						if (!swept) return;
						if (!before) await baselineReady;
						const start = before ? await before : diffBaseline;
						const end = await captureDiffBaseline(activeCwd);
						for (const path of changedBetween(start, end)) bucket.add(path);
					};
					attributionReady = attributionReady.then(settle, settle);
				}
			}
			if (win.isDestroyed()) return;
			// A dialog is an agent waiting on an answer, and an unanswered one
			// hangs that agent's turn: it must reach the window whichever slot
			// asked and whatever move is in flight, unlike ordinary events,
			// which belong to the chat on screen.
			if (type === "extension_ui_request" && isDialogRequest(event)) {
				win.webContents.send("agent:event", event, slot.id);
				return;
			}
			if (switching !== null) return;
			if (slot === active) {
				win.webContents.send("agent:event", event, slot.id);
			} else if (type === "agent_settled") {
				win.webContents.send("agent:background-settled", { sessionPath: slot.sessionPath });
			}
		});
	};
	wireSlot(active);

	const spawnSlot = async (): Promise<AgentSlot> => {
		const slot: AgentSlot = {
			id: ++slotSeq,
			bridge: new AgentBridge(),
			sessionPath: "",
			busy: false,
			turnCapture: null,
			turnWrote: new Set(),
			turnSwept: false,
		};
		wireSlot(slot);
		await slot.bridge.start(
			{
				cwd: activeCwd,
				provider: process.env.SMOLT_DESKTOP_PROVIDER,
				model: process.env.SMOLT_DESKTOP_MODEL,
				env: agentEnv(PANE_ENV),
				execPath: agentExecPath(),
				onDiagnostic: crashLog,
			},
			__dirname,
		);
		noteAgentPid(slot.bridge);
		slots.push(slot);
		return slot;
	};

	/** Idle, inactive agents beyond the cap are stopped quietly. */
	const reapIdleSlots = (): void => {
		while (slots.length > MAX_SLOTS) {
			const index = slots.findIndex((slot) => slot !== active && !slot.busy);
			if (index < 0) return;
			const [gone] = slots.splice(index, 1);
			void gone?.bridge.stop();
		}
	};

	/**
	 * Move the view to another session. A busy active agent is left running —
	 * its turn continues in the background — and the target session lands on
	 * an idle slot instead: the one already holding it, any idle spare, or a
	 * fresh agent.
	 */
	/**
	 * One idle agent kept ready while another is working.
	 *
	 * Leaving a busy chat needs a second agent to show the next one, and
	 * starting that on the click costs a couple of seconds of process start.
	 * Warming it as the turn begins moves that wait off the critical path.
	 */
	let warming: Promise<AgentSlot> | null = null;
	const ensureSpare = (): void => {
		if (warming !== null) return;
		if (slots.length >= MAX_SLOTS) return;
		if (slots.some((slot) => slot !== active && !slot.busy)) return;
		warming = spawnSlot();
		void warming
			.catch(() => undefined)
			.finally(() => {
				warming = null;
			});
	};

	const switchToPath = async (path: string): Promise<unknown> => {
		// A slot already holding the target — running or not — just becomes the
		// view again; that is how a background turn is picked back up live.
		let slot = slots.find((candidate) => candidate.sessionPath === path);
		if (!slot) {
			if (!active.busy) {
				const value = await active.bridge.call("switchSession", [path]);
				await refreshSlotPath(active);
				return value;
			}
			// A warm spare, the one still starting, or a fresh one — in that order.
			const spare = (): AgentSlot | undefined => slots.find((candidate) => candidate !== active && !candidate.busy);
			if (!spare() && warming !== null) await warming.catch(() => undefined);
			slot = spare() ?? (await spawnSlot());
			const value = (await slot.bridge.call("switchSession", [path])) as { cancelled?: boolean } | undefined;
			await refreshSlotPath(slot);
			if (value?.cancelled) return value;
		}
		active = slot;
		broadcastBusy();
		reapIdleSlots();
		// Line up the next one now. A connector can keep the active agent busy
		// indefinitely, and then every switch pays a cold start on the click.
		ensureSpare();
		return { cancelled: false };
	};

	/** A new chat while the current agent works starts on its own agent. */
	const newSessionSlot = async (): Promise<unknown> => {
		const idle = slots.find((candidate) => candidate !== active && !candidate.busy);
		const slot = idle ?? (await spawnSlot());
		const value = (await slot.bridge.call("newSession", [])) as { cancelled?: boolean } | undefined;
		await refreshSlotPath(slot);
		if (value?.cancelled) return value;
		active = slot;
		broadcastBusy();
		reapIdleSlots();
		return { cancelled: false };
	};

	/** Guards against a double respawn racing on one dead slot. */
	const respawning = new Set<number>();

	/**
	 * Replace an agent that died on its own with a fresh one in the same chat.
	 *
	 * The transcript is on disk, so the replacement picks the chat back up;
	 * the window is told after the replacement is live, so a banner there can
	 * honestly say "restarted" rather than only "crashed".
	 */
	const respawnAgent = async (dead: AgentSlot, code: number | null): Promise<void> => {
		if (respawning.has(dead.id)) return;
		respawning.add(dead.id);
		try {
			const fresh = await spawnSlot();
			const index = slots.indexOf(dead);
			if (index >= 0) slots.splice(index, 1);
			if (dead.sessionPath) {
				try {
					await fresh.bridge.call("switchSession", [dead.sessionPath]);
					await refreshSlotPath(fresh);
				} catch {
					// The chat is on disk either way; a failed switch starts empty.
				}
			}
			active = fresh;
			broadcastBusy();
			announceActive();
			reapIdleSlots();
			ensureSpare();
			if (!win.isDestroyed()) win.webContents.send("agent:exited", { slotId: dead.id, wasActive: true, code });
		} finally {
			respawning.delete(dead.id);
		}
	};

	const debug = process.env.SMOLT_DESKTOP_DEBUG === "1";
	ipcMain.handle("agent:call", async (_e, method: string, args: unknown[]) => {
		try {
			// A dialog answer goes to the agent that asked, which is not always
			// the active one: the user can switch chats while a card is open,
			// and an answer sent to the wrong process is silently ignored while
			// the asking agent waits out its timeout. Routed before the gates
			// below — the answer must not queue behind the very switch that
			// made the slot inactive.
			if (method === "respondExtensionUI") {
				const { slotId, ...body } = ((Array.isArray(args) ? args[0] : undefined) ?? {}) as {
					slotId?: number;
				} & Record<string, unknown>;
				const target = slots.find((slot) => slot.id === slotId) ?? active;
				return { ok: true, value: await target.bridge.call("respondExtensionUI", [body]) };
			}
			if (restarting) await restarting;
			// Moving between chats is not instant — the agent takes about a second
			// — and until it lands the active agent is still the one being left.
			// A prompt sent into that gap would be answered by the wrong chat, so
			// everything queues behind the move.
			if (switching) await switching.catch(() => undefined);
			const list = Array.isArray(args) ? args : [];
			const movesSession =
				method === "switchSession" || method === "newSession" || method === "clone" || method === "fork";
			const dispatch = async (): Promise<unknown> => {
				if (method === "switchSession") return await switchToPath(String(list[0] ?? ""));
				if (method === "newSession" && active.busy) return await newSessionSlot();
				const result = await active.bridge.call(method, list);
				if (movesSession) await refreshSlotPath(active);
				return result;
			};
			let value: unknown;
			if (movesSession) {
				const move = dispatch();
				switching = move;
				try {
					value = await move;
				} finally {
					if (switching === move) switching = null;
				}
				// A different conversation starts from a different tree. Outside the
				// gate: this walks the working tree, and holding every other call
				// behind a git scan is what made the window feel stuck after a
				// switch on a large repository.
				await rebaseline();
				// The view may have landed on another agent; say so before the
				// renderer reattaches, or it stays deaf to the chat it is showing.
				announceActive();
			} else {
				value = await dispatch();
			}
			if (debug) console.log(`[call] ${method} ok ${JSON.stringify(value)?.slice(0, 120)}`);
			return { ok: true, value };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			// A switch that failed left the window detached; put it back.
			announceActive();
			if (debug) console.log(`[call] ${method} ERR ${message}`);
			return { ok: false, error: message };
		}
	});
	ipcMain.handle("agent:status", () => active.bridge.status);
	ipcMain.handle("app:active-slot", () => active.id);
	// The native window controls sit on the main-process side of the titlebar,
	// so the renderer reports its resolved theme and the strip follows it.
	ipcMain.handle("app:link-preview", async (_e, url: string) => {
		try {
			return await fetchLinkPreview(String(url));
		} catch {
			return null;
		}
	});
	ipcMain.handle("app:titlebar", (_e, theme: string) => {
		try {
			win.setTitleBarOverlay(
				theme === "light"
					? { color: "#fffdfc", symbolColor: "#635956", height: 36 }
					: { color: "#0a0b0e", symbolColor: "#aeb4bd", height: 36 },
			);
		} catch {
			// Not every platform draws the overlay; the theme still applies.
		}
	});
	ipcMain.handle("app:sessions", async (_e, query?: string) => {
		const needle = typeof query === "string" ? query.trim() : "";
		const rows = needle === "" ? await listSessions(undefined, 50) : await searchSessions(needle, undefined, 50);
		const busyPaths = new Set(slots.filter((slot) => slot.busy).map((slot) => slot.sessionPath));
		const telegramPath = await telegramSessionPath();
		return rows.map((row) => ({
			...row,
			busy: busyPaths.has(row.path),
			telegram: telegramPath !== "" && row.path === telegramPath,
		}));
	});
	ipcMain.handle("app:info", () => ({
		cwd: activeCwd,
		hasProject: projectFolders.length > 0,
		folders: projectFolders,
		version: appVersion(),
		continueLatest: process.env.SMOLT_DESKTOP_CONTINUE === "1",
		// Only an installed build has an installer the updater can replace.
		packaged: app.isPackaged,
	}));
	ipcMain.handle("side:call", async (_e, method: string, args: unknown[]) => {
		try {
			if (!sideBridge) {
				sideBridge = new AgentBridge();
				sideBridge.onEvent((event) => {
					if (!win.isDestroyed()) win.webContents.send("side:event", event);
				});
				await sideBridge.start(
					{
						cwd: process.env.SMOLT_DESKTOP_CWD || process.cwd(),
						provider: process.env.SMOLT_DESKTOP_PROVIDER,
						model: process.env.SMOLT_DESKTOP_MODEL,
						env: agentEnv(PANE_ENV),
						execPath: agentExecPath(),
						onDiagnostic: crashLog,
					},
					__dirname,
				);
				if (sideBridge.status.error) {
					const error = sideBridge.status.error;
					sideBridge = null;
					return { ok: false, error };
				}
				noteAgentPid(sideBridge);
			}
			return { ok: true, value: await sideBridge.call(method, Array.isArray(args) ? args : []) };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});
	ipcMain.handle("side:stop", async () => {
		await sideBridge?.stop();
		sideBridge = null;
		return { ok: true };
	});

	/**
	 * Move the agent into a directory: a fresh worktree, or back to the repo.
	 * The agent is a subprocess rooted at one cwd, so isolating a session means
	 * restarting it there rather than reusing the running one.
	 */
	/**
	 * Set while an agent is coming up in a new folder.
	 *
	 * Switching folders no longer waits for the restart, so a call can arrive
	 * before the new agent exists. Waiting on this is what turns that into a
	 * slightly slower call rather than an "agent not running" failure.
	 */
	let restarting: Promise<void> | null = null;

	const restartAgentIn = async (cwd: string): Promise<void> => {
		// The gate is its own promise rather than this whole call: it has to lift
		// when the agent can answer, not when the tree snapshot below finishes.
		let signalReady: () => void = () => {};
		restarting = new Promise<void>((resolve) => {
			signalReady = resolve;
		});
		// A directory move restarts everything: every slot is rooted in the old
		// cwd, and background turns there would write into the wrong tree. A
		// fresh bridge each time — re-wiring a stopped one would stack its old
		// event listeners under the new ones.
		// The old agents are dropped, not waited for: their teardown is a second
		// of the switch and nothing downstream needs them gone, since the fresh
		// bridge is a new process with its own listeners and its own session file.
		for (const slot of slots) {
			stoppingBridges.add(slot.bridge);
			void slot.bridge.stop();
		}
		slots.length = 0;
		// Any agent still starting belongs to the folder being left.
		warming = null;
		activeCwd = cwd;
		const slot: AgentSlot = {
			id: ++slotSeq,
			bridge: new AgentBridge(),
			sessionPath: "",
			busy: false,
			turnCapture: null,
			turnWrote: new Set(),
			turnSwept: false,
		};
		active = slot;
		slots.push(slot);
		wireSlot(slot);
		await slot.bridge.start(
			{
				cwd,
				provider: process.env.SMOLT_DESKTOP_PROVIDER,
				model: process.env.SMOLT_DESKTOP_MODEL,
				// With no folder open the agent must not guess a destination.
				args: agentNotes(),
				env: agentEnv(PANE_ENV),
				execPath: agentExecPath(),
				onDiagnostic: crashLog,
			},
			__dirname,
		);
		noteAgentPid(slot.bridge);
		await refreshSlotPath(slot);
		restarting = null;
		signalReady();
		ensureSpare();
		await rebaseline();
		announceActive();
		if (!win.isDestroyed()) win.webContents.send("agent:started", slot.bridge.status);
	};

	ipcMain.handle("app:worktrees", async () => {
		try {
			return {
				ok: true,
				value: {
					isRepo: (await repoRoot(homeCwd())) !== undefined,
					activeCwd,
					isolated: activeCwd !== homeCwd(),
					worktrees: await listWorktrees(homeCwd()),
				},
			};
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});
	ipcMain.handle("app:worktree-create", async (_e, label: string) => {
		try {
			const worktree = await createWorktree(homeCwd(), String(label ?? ""));
			await restartAgentIn(worktree.path);
			return { ok: true, value: worktree };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});
	ipcMain.handle("app:worktree-enter", async (_e, path: string) => {
		try {
			await restartAgentIn(path ? String(path) : homeCwd());
			return { ok: true, value: activeCwd };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});
	ipcMain.handle("app:worktree-remove", async (_e, path: string, force?: boolean) => {
		try {
			if (activeCwd === path) await restartAgentIn(homeCwd());
			await removeWorktree(homeCwd(), String(path), force === true);
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});

	/**
	 * Delete a session transcript. Guarded to the sessions directory so a bad
	 * path from the window can never remove anything else.
	 */
	/** The transcript straight off disk, so a switch need not wait for the agent. */
	ipcMain.handle("app:session-messages", async (_e, path: string, options?: SessionWindow) => {
		const empty = { messages: [], start: 0, userStart: 0 };
		try {
			const { resolve } = await import("node:path");
			const { readSessionMessages, sessionsDir } = await import("./sessions.ts");
			const target = resolve(String(path ?? ""));
			if (!target.startsWith(resolve(sessionsDir())) || !target.endsWith(".jsonl")) return empty;
			return readSessionMessages(target, options ?? {});
		} catch {
			return empty;
		}
	});

	ipcMain.handle("app:session-delete", async (_e, path: string) => {
		try {
			const { rmSync } = await import("node:fs");
			const { resolve } = await import("node:path");
			const { sessionsDir } = await import("./sessions.ts");
			const target = resolve(String(path));
			const root = resolve(sessionsDir());
			if (!target.startsWith(root) || !target.endsWith(".jsonl")) {
				return { ok: false, error: "Refusing to delete a path outside the sessions directory" };
			}
			rmSync(target, { force: true });
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});

	/** Choose a folder to bring into the conversation. */
	ipcMain.handle("app:open-project", async (_e, path: string) => {
		try {
			const target = String(path ?? "").trim();
			if (target === "" || !existsSync(target)) {
				return { ok: false, error: "That folder no longer exists." };
			}
			// Choosing a folder replaces the set rather than adding to it; the ones
			// left behind stay listed, so their chats are one click away.
			rememberProject([target], projectFolders);
			projectFolders = [target];
			// The restart is not awaited: it takes a couple of seconds, activeCwd is
			// already the new folder, and the window is told again when the agent is
			// up. Holding the reply here would freeze the switch on nothing.
			void restartAgentIn(target);
			return { ok: true, value: target };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});

	/**
	 * Delete everything the agent has accumulated on this machine.
	 *
	 * The agents are stopped first and restarted after: on Windows the running
	 * process holds state.db open, and an open handle turns the delete into a
	 * failure rather than the database disappearing. Restarting also means the
	 * app comes back on an empty history instead of holding a chat that no
	 * longer has a file behind it.
	 */
	ipcMain.handle("app:wipe-local-data", async () => {
		try {
			const { wipeLocalData } = await import("./wipe.ts");
			for (const slot of slots) {
				stoppingBridges.add(slot.bridge);
				await slot.bridge.stop();
			}
			slots.length = 0;
			warming = null;
			const report = wipeLocalData();
			await restartAgentIn(activeCwd);
			return { ok: report.failed.length === 0, value: report, error: report.failed[0]?.error };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});

	ipcMain.handle("app:recent-projects", () => readProjectState().recent);

	ipcMain.handle("app:update-state", () => updateState());
	ipcMain.handle("app:update-check", async () => {
		await checkNow();
		return { ok: true };
	});
	ipcMain.handle("app:update-install", async () => {
		await installUpdate();
		return { ok: true };
	});

	ipcMain.handle("app:folders", () => projectFolders);

	/**
	 * Which providers already have a credential.
	 *
	 * Only the names: the window never needs a key, and a key that reaches the
	 * renderer is a key that can end up in a screenshot or a log.
	 */
	// Every provider the agent's catalog knows, so the add-provider dialog is
	// exhaustive rather than a hand-picked eight. Ids and capability flags
	// only — no credentials, no model lists.
	ipcMain.handle("app:known-providers", async () => {
		try {
			const { builtinProviders } = await import("../../../ai/src/providers/all.ts");
			return builtinProviders().map((provider) => ({
				id: provider.id,
				name: provider.name,
				apiKey: provider.auth.apiKey !== undefined,
				oauth: provider.auth.oauth !== undefined,
			}));
		} catch {
			return [];
		}
	});
	ipcMain.handle("app:auth-list", async () => {
		try {
			// The names only, straight from the file the CLI shares. Reading keys
			// rather than credentials keeps the secrets out of this process's reply.
			const raw: unknown = JSON.parse(readFileSync(join(dirname(projectFile()), "auth.json"), "utf-8"));
			if (raw === null || typeof raw !== "object") return [];
			return Object.keys(raw as Record<string, unknown>);
		} catch {
			return [];
		}
	});

	/**
	 * Store an API key for a provider, then restart so the agent picks it up.
	 *
	 * Written through the agent's own store rather than by hand: it takes the
	 * lock and creates the file 0600, and the CLI reads the same file.
	 */
	ipcMain.handle("app:auth-set", async (_e, provider: string, key: string) => {
		try {
			const name = String(provider ?? "").trim();
			const secret = String(key ?? "").trim();
			if (name === "" || secret === "") return { ok: false, error: "Both a provider and a key are needed." };
			const { AuthStorage } = await import("../../../coding-agent/src/core/auth-storage.ts");
			// The explicit path, computed the way every other main-process path
			// is: AuthStorage.create()'s own default resolves through the
			// coding-agent's config module, which inside the Electron bundle
			// once produced a raw `"path" argument must be of type string`
			// throw — and a key that silently never saved.
			const envDir = process.env.SMOLT_CODING_AGENT_DIR;
			const agentDir = envDir?.trim()
				? envDir.startsWith("~")
					? join(homedir(), envDir.slice(1))
					: envDir
				: join(homedir(), ".smolt", "agent");
			await AuthStorage.create(join(agentDir, "auth.json")).modify(name, async () => ({
				type: "api_key",
				key: secret,
			}));
			void restartAgentIn(homeCwd());
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});

	/**
	 * Open the bundled CLI in a terminal, for logins the window cannot do.
	 *
	 * OAuth sign-in lives in the CLI's own interface, and the desktop ships that
	 * CLI; handing the reader straight to it beats telling them to find it.
	 */
	ipcMain.handle("app:open-cli", () => {
		try {
			const cli = findCliPath(__dirname);
			if (!cli) return { ok: false, error: "The bundled agent could not be found." };
			const runner = agentExecPath() ?? "node";
			const env = { ...process.env, ...agentEnv({}) };
			if (process.platform === "win32") {
				spawn("cmd.exe", ["/c", "start", "", "cmd.exe", "/k", runner, cli], {
					cwd: homeCwd(),
					env,
					detached: true,
				}).unref();
			} else if (process.platform === "darwin") {
				spawn("open", ["-a", "Terminal", runner, "--args", cli], { cwd: homeCwd(), env, detached: true }).unref();
			} else {
				spawn("x-terminal-emulator", ["-e", ` `], { cwd: homeCwd(), env, detached: true }).unref();
			}
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});

	/**
	 * Add a folder alongside the ones already open.
	 *
	 * The first stays the working directory: moving the agent would restart it
	 * and throw away the turn in flight, so extra folders are told to it rather
	 * than run in.
	 */
	ipcMain.handle("app:add-folder", async (_e, path: string) => {
		try {
			const target = String(path ?? "").trim();
			if (target === "" || !existsSync(target)) {
				return { ok: false, error: "That folder no longer exists." };
			}
			if (projectFolders.includes(target)) return { ok: true, value: projectFolders };
			const primaryChanged = projectFolders.length === 0;
			projectFolders = [...projectFolders, target];
			rememberProject(projectFolders, []);
			// Only a first folder moves the agent; the rest just widen its remit.
			await restartAgentIn(primaryChanged ? target : activeCwd);
			return { ok: true, value: projectFolders };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});

	ipcMain.handle("app:close-project", async () => {
		try {
			rememberProject([], projectFolders);
			projectFolders = [];
			void restartAgentIn(homeCwd());
			return { ok: true, value: null };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});

	/**
	 * Copy through Electron rather than the page's clipboard API.
	 *
	 * The window is loaded from file://, where the async clipboard API is a
	 * permission the embedder has to grant; going through the main process
	 * sidesteps that entirely and cannot be broken by a permission change.
	 */
	ipcMain.handle("app:copy", (_e, text: string) => {
		try {
			clipboard.writeText(String(text ?? ""));
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});

	ipcMain.handle("app:pick-folder", async () => {
		try {
			const result = await dialog.showOpenDialog(win, {
				title: "Add a folder",
				defaultPath: activeCwd,
				properties: ["openDirectory"],
			});
			return { ok: true, value: result.canceled ? "" : (result.filePaths[0] ?? "") };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});

	ipcMain.handle("app:reveal", async (_e, target: string, how?: string) => {
		try {
			if (how === "editor") {
				await shell.openExternal(`vscode://file/${String(target).replaceAll("\\", "/")}`);
			} else if (how === "folder") {
				await shell.openPath(String(target));
			} else {
				shell.showItemInFolder(String(target));
			}
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});

	ipcMain.handle("app:permission-mode", async (_e, mode?: string) => {
		try {
			const { readPermissionMode, writePermissionMode } = await import(
				"../../../coding-agent/src/extensions/permissions/index.ts"
			);
			const { PERMISSION_MODES } = await import("../../../coding-agent/src/extensions/permissions/index.ts");
			if (mode && (PERMISSION_MODES as readonly string[]).includes(mode)) {
				writePermissionMode(mode as never);
			}
			return { ok: true, value: readPermissionMode() };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});

	// A tool call that needs approval reaches the window here, and the answer
	// goes back the same way — but only for this app's own agents: the requests
	// directory is shared with every other smolt process on the machine, and
	// their questions must neither appear on, nor be answerable from, this
	// window. A request whose file disappears was answered elsewhere or swept,
	// and the card here has to go with it.
	watchPermissionRequests(
		(request) => {
			if (!requestIsOurs(request.id)) return;
			shownRequestIds.add(request.id);
			if (!win.isDestroyed()) {
				win.webContents.send("permission:request", { ...request, ...requestMeta(request.id) });
			}
		},
		(id) => {
			if (!shownRequestIds.delete(id)) return;
			if (!win.isDestroyed()) win.webContents.send("permission:removed", id);
		},
	);
	ipcMain.handle("app:pending-approvals", () =>
		pendingPermissionRequests()
			.filter((request) => requestIsOurs(request.id))
			.map((request) => ({ ...request, ...requestMeta(request.id) })),
	);
	ipcMain.handle("app:permission-reply", (_e, id: string, answer: string) => {
		try {
			writePermissionReply(String(id), String(answer));
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});

	ipcMain.handle("app:stats", () => {
		try {
			return { ok: true, value: collectStats(activeCwd) };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});

	ipcMain.handle("app:diff", async () => {
		try {
			// Follows the agent into a worktree, so the pane shows that session's work.
			await baselineReady;
			await attributionReady;
			// A running turn counts live: files its edit/write calls have named,
			// and — once it has used a sweeping tool — whatever moved since its start.
			const paths = active.turnWrote.size > 0 ? new Set([...attributed, ...active.turnWrote]) : attributed;
			const turnStart = active.turnSwept && active.turnCapture ? await active.turnCapture : undefined;
			return { ok: true, value: await collectDiff(activeCwd, diffBaseline, { paths, turnStart }) };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});
	// Dictation runs on this machine. The model downloads the first time it is
	// used and is cached; progress goes to the window so the wait is visible.
	/**
	 * Microphone access, in the two places it can be refused.
	 *
	 * Electron denies media requests from the page unless the app says
	 * otherwise, and the operating system has its own switch on top. Asking
	 * for both is what turns "microphone unavailable" into a prompt.
	 */
	// Copy buttons write through the async clipboard API, which is itself a
	// permission; an allow-list that only named "media" silently refused them.
	const allowed = new Set(["media", "clipboard-sanitized-write"]);
	session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
		callback(allowed.has(permission));
	});
	session.defaultSession.setPermissionCheckHandler((_contents, permission) => allowed.has(permission));

	ipcMain.handle("app:mic-access", async () => {
		try {
			// Linux reports nothing here and needs no prompt.
			if (process.platform !== "darwin" && process.platform !== "win32") {
				return { ok: true, value: { status: "granted", asked: false } };
			}
			let status = systemPreferences.getMediaAccessStatus("microphone");
			let asked = false;
			// macOS can raise the system prompt; Windows only reports.
			if (status !== "granted" && process.platform === "darwin") {
				asked = true;
				status = (await systemPreferences.askForMediaAccess("microphone")) ? "granted" : "denied";
			}
			return { ok: true, value: { status, asked } };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});

	ipcMain.handle("app:open-mic-settings", async () => {
		try {
			await shell.openExternal(
				process.platform === "darwin"
					? "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
					: "ms-settings:privacy-microphone",
			);
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});

	ipcMain.handle("speech:status", () => speechStatus());
	ipcMain.handle("speech:prepare", async () => {
		try {
			await ensureModel((progress) => {
				if (!win.isDestroyed()) win.webContents.send("speech:progress", progress);
			});
			return { ok: true, value: speechStatus() };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});
	ipcMain.handle("speech:transcribe", async (_e, samples: ArrayBuffer) => {
		try {
			return { ok: true, value: await transcribeSamples(new Float32Array(samples)) };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});

	// Screenshot mode: capture the window to the given path once the
	// renderer settles, then exit. Used to document the UI.
	const shotPath = process.env.SMOLT_DESKTOP_SHOT;
	if (shotPath) {
		ipcMain.on("renderer:ready", () => {
			setTimeout(
				async () => {
					try {
						const image = await win.webContents.capturePage();
						const { writeFileSync } = await import("node:fs");
						writeFileSync(shotPath, image.toPNG());
						console.log(`shot: ${shotPath}`);
						app.exit(0);
					} catch (e) {
						console.error("shot failed", e);
						app.exit(1);
					}
				},
				Number(process.env.SMOLT_DESKTOP_SHOT_DELAY_MS ?? 1200),
			);
		});
	}

	let smokeTimer: ReturnType<typeof setTimeout> | undefined;
	if (SMOKE) {
		// Full-boot smoke test: exit 0 once the renderer signals it is wired
		// up (preload bridge working, first paint done); exit 1 on timeout.
		smokeTimer = setTimeout(() => {
			console.error("smoke: renderer never signalled ready");
			app.exit(1);
		}, 20_000);
		ipcMain.on("renderer:ready", () => {
			clearTimeout(smokeTimer);
			console.log("smoke: renderer ready");
			app.exit(0);
		});
	} else {
		ipcMain.on("renderer:ready", () => {
			// no-op outside smoke mode; the renderer polls status over IPC
		});
	}

	// Start the agent after the window is up so the UI appears instantly.
	await bridge.start(
		{
			cwd: activeCwd,
			provider: process.env.SMOLT_DESKTOP_PROVIDER,
			model: process.env.SMOLT_DESKTOP_MODEL,
			args: process.env.SMOLT_DESKTOP_CONTINUE === "1" ? ["--continue"] : undefined,
			env: agentEnv(PANE_ENV),
			execPath: agentExecPath(),
			onDiagnostic: crashLog,
		},
		__dirname,
	);
	noteAgentPid(bridge);
	await refreshSlotPath(active);
	announceActive();
	await rebaseline();
	if (!win.isDestroyed()) win.webContents.send("agent:started", bridge.status);
	// The Telegram host follows the linked config: setup done in any pane is
	// picked up within a poll interval, unlinking shuts the host down.
	syncTelegramHost();
	setInterval(syncTelegramHost, 15_000);
});

app.on("window-all-closed", () => {
	// The speech model runs in a process of its own; nothing will be asked
	// of it again, and it must not outlive the windows.
	stopSpeech();
	void Promise.all([...slots.map((slot) => slot.bridge.stop()), sideBridge?.stop(), telegramBridge?.stop()]).finally(
		() => app.quit(),
	);
});
