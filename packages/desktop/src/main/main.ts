import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, session, shell, systemPreferences } from "electron";
import { AgentBridge, findCliPath } from "./agent-bridge.ts";
import { pendingPermissionRequests, watchPermissionRequests, writePermissionReply } from "./approvals.ts";
import {
	captureDiffBaseline,
	changedBetween,
	classifyToolCall,
	collectDiff,
	type DiffBaseline,
	toGitPath,
} from "./diff.ts";
import { fetchLinkPreview } from "./link-preview.ts";
import { listSessions } from "./sessions.ts";
import { ensureModel, speechStatus, transcribeSamples } from "./speech.ts";
import { collectStats } from "./stats.ts";
import { findTranscriptionProvider, transcribeAudio } from "./transcribe.ts";
import { createWorktree, listWorktrees, removeWorktree, repoRoot } from "./worktrees.ts";

const SMOKE = process.env.SMOLT_DESKTOP_SMOKE === "1";
const bridge = new AgentBridge();

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
const slots: AgentSlot[] = [];
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
const agentEnv = (extra: Record<string, string>): Record<string, string> =>
	app.isPackaged
		? {
				...extra,
				ELECTRON_RUN_AS_NODE: "1",
				// Say where the agent lives rather than letting it guess: bundled, it
				// would walk up from resources looking for a package root and land
				// somewhere arbitrary, then fail to find its own theme files.
				SMOLT_PACKAGE_DIR: join(process.resourcesPath, "agent"),
			}
		: extra;
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
				},
				__dirname,
			);
			if (host.status.error) {
				await host.stop();
				return;
			}
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
const homeCwd = (): string => projectFolders[0] ?? scratchDir();
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
	win.once("ready-to-show", () => win.show());

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
	const win = createWindow();

	let active: AgentSlot = {
		bridge,
		sessionPath: "",
		busy: false,
		turnCapture: null,
		turnWrote: new Set(),
		turnSwept: false,
	};
	slots.push(active);

	const broadcastBusy = (): void => {
		if (win.isDestroyed()) return;
		win.webContents.send(
			"agent:busy",
			slots.filter((slot) => slot.busy).map((slot) => slot.sessionPath),
		);
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
			if (slot === active) {
				win.webContents.send("agent:event", event);
			} else if (type === "agent_settled") {
				win.webContents.send("agent:background-settled", { sessionPath: slot.sessionPath });
			}
		});
	};
	wireSlot(active);

	const spawnSlot = async (): Promise<AgentSlot> => {
		const slot: AgentSlot = {
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
			},
			__dirname,
		);
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

	const debug = process.env.SMOLT_DESKTOP_DEBUG === "1";
	ipcMain.handle("agent:call", async (_e, method: string, args: unknown[]) => {
		try {
			if (restarting) await restarting;
			const list = Array.isArray(args) ? args : [];
			let value: unknown;
			if (method === "switchSession") {
				value = await switchToPath(String(list[0] ?? ""));
			} else if (method === "newSession" && active.busy) {
				value = await newSessionSlot();
			} else {
				value = await active.bridge.call(method, list);
				if (method === "newSession" || method === "clone" || method === "fork") {
					await refreshSlotPath(active);
				}
			}
			// A different conversation starts from a different tree.
			if (method === "newSession" || method === "switchSession" || method === "clone" || method === "fork") {
				await rebaseline();
			}
			if (debug) console.log(`[call] ${method} ok ${JSON.stringify(value)?.slice(0, 120)}`);
			return { ok: true, value };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (debug) console.log(`[call] ${method} ERR ${message}`);
			return { ok: false, error: message };
		}
	});
	ipcMain.handle("agent:status", () => active.bridge.status);
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
	ipcMain.handle("app:sessions", async () => {
		const rows = await listSessions(undefined, 50);
		const busyPaths = new Set(slots.filter((slot) => slot.busy).map((slot) => slot.sessionPath));
		return rows.map((row) => ({ ...row, busy: busyPaths.has(row.path) }));
	});
	ipcMain.handle("app:info", () => ({
		cwd: activeCwd,
		hasProject: projectFolders.length > 0,
		folders: projectFolders,
		version: app.getVersion(),
		continueLatest: process.env.SMOLT_DESKTOP_CONTINUE === "1",
		canTranscribe: findTranscriptionProvider() !== undefined,
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
					},
					__dirname,
				);
				if (sideBridge.status.error) {
					const error = sideBridge.status.error;
					sideBridge = null;
					return { ok: false, error };
				}
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
		for (const slot of slots) void slot.bridge.stop();
		slots.length = 0;
		// Any agent still starting belongs to the folder being left.
		warming = null;
		activeCwd = cwd;
		const slot: AgentSlot = {
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
			},
			__dirname,
		);
		await refreshSlotPath(slot);
		restarting = null;
		signalReady();
		ensureSpare();
		await rebaseline();
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
	ipcMain.handle("app:session-messages", async (_e, path: string) => {
		try {
			const { resolve } = await import("node:path");
			const { readSessionMessages, sessionsDir } = await import("./sessions.ts");
			const target = resolve(String(path ?? ""));
			if (!target.startsWith(resolve(sessionsDir())) || !target.endsWith(".jsonl")) return [];
			return readSessionMessages(target);
		} catch {
			return [];
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

	ipcMain.handle("app:recent-projects", () => readProjectState().recent);

	ipcMain.handle("app:folders", () => projectFolders);

	/**
	 * Which providers already have a credential.
	 *
	 * Only the names: the window never needs a key, and a key that reaches the
	 * renderer is a key that can end up in a screenshot or a log.
	 */
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
			await AuthStorage.create().modify(name, async () => ({ type: "api_key", key: secret }));
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
	// goes back the same way.
	watchPermissionRequests((request) => {
		if (!win.isDestroyed()) win.webContents.send("permission:request", request);
	});
	ipcMain.handle("app:pending-approvals", () => pendingPermissionRequests());
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

	ipcMain.handle("app:transcribe", async (_e, audio: ArrayBuffer, mimeType: string) => {
		try {
			const text = await transcribeAudio(new Uint8Array(audio), mimeType);
			return { ok: true, value: text };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { ok: false, error: message };
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
			cwd: process.env.SMOLT_DESKTOP_CWD || process.cwd(),
			provider: process.env.SMOLT_DESKTOP_PROVIDER,
			model: process.env.SMOLT_DESKTOP_MODEL,
			args: process.env.SMOLT_DESKTOP_CONTINUE === "1" ? ["--continue"] : undefined,
			env: agentEnv(PANE_ENV),
			execPath: agentExecPath(),
		},
		__dirname,
	);
	await refreshSlotPath(active);
	await rebaseline();
	if (!win.isDestroyed()) win.webContents.send("agent:started", bridge.status);
	// The Telegram host follows the linked config: setup done in any pane is
	// picked up within a poll interval, unlinking shuts the host down.
	syncTelegramHost();
	setInterval(syncTelegramHost, 15_000);
});

app.on("window-all-closed", () => {
	void Promise.all([...slots.map((slot) => slot.bridge.stop()), sideBridge?.stop(), telegramBridge?.stop()]).finally(
		() => app.quit(),
	);
});
