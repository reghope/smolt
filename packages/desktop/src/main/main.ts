import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, session, shell, systemPreferences } from "electron";
import lockfile from "proper-lockfile";
import {
	appendPoolCredential,
	parsePoolData,
	relabelPoolCredential,
	removePoolCredential,
	setProviderPooled,
} from "../../../coding-agent/src/extensions/pool/model.ts";
import { AgentBridge, findCliPath } from "./agent-bridge.ts";
import { pendingPermissionRequests, requestPid, watchPermissionRequests, writePermissionReply } from "./approvals.ts";
import { createChatFolder, needsChatFolder, sweepEmptyChatFolders } from "./chat-folders.ts";
import { ensureCliShim } from "./cli-shim.ts";
import {
	captureDiffBaseline,
	changedBetween,
	classifyToolCall,
	collectDiff,
	collectDiffStats,
	createPullRequest,
	type DiffBaseline,
	prReadiness,
	remoteWebUrl,
	toGitPath,
} from "./diff.ts";
import { transformersEntry } from "./embeddings-module.ts";
import { refreshIconCacheAfterUpdate } from "./icon-cache.ts";
import { fetchLinkPreview } from "./link-preview.ts";
import { listSessions, searchSessions, sessionCwd } from "./sessions.ts";
import { chooseSlotForSession, type SlotChoice } from "./slots.ts";
import { ensureModel, isModelCached, speechStatus, stopSpeech, transcribeSamples } from "./speech.ts";
import { makeCliRunner, suggestStarters } from "./starters.ts";
import { collectStats } from "./stats.ts";
import { checkNow, installUpdate, startUpdates, updateState } from "./updates.ts";
import { tapIpc, WebServer } from "./web-server.ts";
import { checkoutBranch, createWorktree, listBranches, listWorktrees, removeWorktree, repoRoot } from "./worktrees.ts";

// Before any handler registers: the web server answers browsers with the
// same handlers the window gets, and this is how it learns them.
tapIpc();

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
	/**
	 * The folder this agent is rooted in, and with it the chat's project.
	 *
	 * A chat belongs to the folder it was started in and stays there: the
	 * directory used to be one app-wide value, so opening another project —
	 * or a chat settling into a folder of its own — re-rooted every agent at
	 * once and killed whatever the others were in the middle of. Only an
	 * explicit move of the chat on screen changes this now.
	 */
	cwd: string;
	/** Session file this agent currently holds; "" until first known. */
	sessionPath: string;
	busy: boolean;
	/** Tree at the running turn's start, in case the turn runs a sweeping tool. */
	turnCapture: Promise<DiffBaseline> | null;
	/** Files the running turn's edit/write calls have named so far. */
	turnWrote: Set<string>;
	/** The running turn used bash or another tool that can write anywhere. */
	turnSwept: boolean;
	/**
	 * The agent currently holds a temporary chat: in-memory on the agent
	 * side, never written to disk, never named into a chat folder.
	 */
	temporary: boolean;
	/**
	 * A chat that has never been prompted and was not switched into from the
	 * session list, so it is still free to be moved into a folder of its own.
	 */
	fresh: boolean;
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
	// Only providers set up in the app (or by the CLI's /login) exist to a
	// desktop agent: a key left in the shell by some other tool must not put
	// hundreds of unasked-for models in the list.
	SMOLT_STORED_CREDENTIALS_ONLY: "1",
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
/**
 * The agent directory, computed the way every other main-process path is.
 * The coding-agent has its own resolver, but inside the Electron bundle it
 * once produced a raw `"path" argument must be of type string` throw, so the
 * desktop keeps its own.
 */
function agentDir(): string {
	const envDir = process.env.SMOLT_CODING_AGENT_DIR;
	return envDir?.trim()
		? envDir.startsWith("~")
			? join(homedir(), envDir.slice(1))
			: envDir
		: join(homedir(), ".smolt", "agent");
}

function projectFile(): string {
	return join(agentDir(), "desktop-project");
}

/**
 * Edit one of the agent's credential files under the same lock the agent
 * takes, so a settings change never races a pool write mid-turn.
 *
 * The desktop does not use the agent's own stores for this: their module
 * graph reaches the config module, which reads `import.meta.url` at load
 * time and throws inside this CommonJS bundle. The files are plain JSON,
 * created 0600 like the agent creates them.
 */
function editLockedJson(path: string, edit: (current: string | undefined) => string): void {
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (!existsSync(path)) writeFileSync(path, "{}", { encoding: "utf-8", mode: 0o600 });
	const release = acquireLockSync(path);
	try {
		const current = readFileSync(path, "utf-8");
		writeFileSync(path, edit(current), { encoding: "utf-8", mode: 0o600 });
	} finally {
		release();
	}
}

/**
 * Take the file lock, waiting out a holder for a moment. The sync API has no
 * retry option of its own, so this is the agent's loop: a few short waits
 * on ELOCKED, anything else thrown straight through.
 */
function acquireLockSync(path: string): () => void {
	const maxAttempts = 10;
	const delayMs = 20;
	for (let attempt = 1; ; attempt += 1) {
		try {
			return lockfile.lockSync(path, { realpath: false });
		} catch (error) {
			const code =
				typeof error === "object" && error !== null && "code" in error
					? String((error as { code?: unknown }).code)
					: undefined;
			if (code !== "ELOCKED" || attempt === maxAttempts) throw error;
			const start = Date.now();
			while (Date.now() - start < delayMs) {
				// A synchronous wait: the caller is a one-shot IPC handler.
			}
		}
	}
}

/** Change the pool file in place, through the pool's own pure operations. */
function editPool(edit: (current: ReturnType<typeof parsePoolData>) => ReturnType<typeof parsePoolData>): void {
	editLockedJson(join(agentDir(), "pool.json"), (current) => JSON.stringify(edit(parsePoolData(current)), null, 2));
}

/** Change the auth file in place: one credential set or cleared, the rest untouched. */
function editAuth(edit: (current: Record<string, unknown>) => Record<string, unknown>): void {
	editLockedJson(join(agentDir(), "auth.json"), (current) => {
		const parsed: unknown = current && current.trim() !== "" ? JSON.parse(current.replace(/^﻿/, "")) : {};
		const data = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
		return JSON.stringify(edit(data), null, 2);
	});
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
 * Where chats with no folder open keep their work.
 *
 * One folder per chat lives under this, dated and named after the message
 * that opened it. It sits in the reader's documents on purpose: what a chat
 * makes is theirs, it has to be findable a week later, and the old shared
 * hidden directory was neither.
 */
function chatsRoot(): string {
	// The documents folder beside the home directory, not whatever the OS
	// reports: on Windows that one is often redirected into a synced cloud
	// drive, and a chat's working files have no business being uploaded to a
	// company drive, one save at a time, as the agent writes them.
	const root = join(homedir(), "Documents", "smolt");
	mkdirSync(root, { recursive: true });
	return root;
}

/**
 * The chat folder the agent is actually running in, while no project folder
 * is open. Null until some chat has claimed one.
 *
 * It outlives the chat that made it, because the agent stays there until a
 * restart moves it: between chats this is still where the working directory
 * is, and saying otherwise would have the window describe a directory the
 * agent is not in.
 */
let chatFolder: string | null = null;

/**
 * Whether the chat on screen has claimed a folder of its own.
 *
 * Separate from the one above: a new chat has claimed nothing yet, but the
 * agent is still standing in the last chat's folder until its first message
 * names a new one.
 */
let chatSettled = false;

/**
 * The extra system prompt an agent rooted at `cwd` should start with, if any.
 *
 * Taken from the folder the agent is actually being started in rather than
 * from whatever the window is showing: agents now sit in different folders at
 * the same time, and one told about another chat's folder would offer to
 * write there.
 */
function agentNotes(cwd: string): string[] | undefined {
	if (projectFolders.length === 0) {
		// A chat working in a folder of its own is told so by name; one still
		// standing in the shared scratch root has nowhere the reader chose.
		const own = cwd !== "" && cwd !== chatsRoot() && cwd.startsWith(chatsRoot());
		return ["--append-system-prompt", own ? chatFolderNote(cwd) : NO_PROJECT_NOTE];
	}
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

/** Told to the agent once this chat has a folder of its own. */
function chatFolderNote(dir: string): string {
	return (
		`No project folder is open, so this chat has one of its own: ${dir}, which is already the working ` +
		"directory and is empty. Put anything you create there, and say where a file landed so the user can " +
		"find it. Ask first only before writing somewhere else."
	);
}

/** Told to the agent when no folder is open and this chat has not begun. */
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
const homeCwd = (): string => process.env.SMOLT_DESKTOP_CWD || projectFolders[0] || chatFolder || chatsRoot();
/**
 * The folder of the chat on screen — a mirror of the active slot's own cwd,
 * kept here because everything a directory answers for (the diff, the stats,
 * the file picker, the repo bar) is asked of the module rather than of the
 * slot. It follows the chat, so opening a chat from another project moves
 * all of that with it; it is no longer something a chat can be moved *by*.
 */
let activeCwd = homeCwd();

/**
 * A system terminal opened in a folder, detached from this process.
 *
 * Each platform has one way in that needs nothing installed: `start` on
 * Windows, the Terminal app on macOS, and the Debian alternative on Linux,
 * which is what a desktop's chosen terminal is registered as.
 */
function openTerminalAt(dir: string): void {
	if (process.platform === "win32") {
		// `/D` as well as cwd: the new console takes its directory from the switch,
		// and the empty title is what keeps `start` from reading the path as one.
		spawn("cmd.exe", ["/c", "start", "", "/D", dir, "cmd.exe", "/K"], { cwd: dir, detached: true }).unref();
	} else if (process.platform === "darwin") {
		spawn("open", ["-a", "Terminal", dir], { detached: true }).unref();
	} else {
		spawn("x-terminal-emulator", [], { cwd: dir, detached: true }).unref();
	}
}
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
		// Warm the speech model while nobody is waiting on it. Loading takes
		// well over a second, and it used to happen on the first clip of
		// audio — so the first thing anyone said went unheard until it
		// finished, every time the app was opened. Only warmed when the
		// weights are already on disk, which means only for someone who has
		// dictated before: it must never pull a download for someone who
		// never will. Failure is silent, since nothing was asked for yet and
		// the next real attempt will report it properly.
		if (isModelCached()) setTimeout(() => void ensureModel().catch(() => {}), 2000);
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
	// Chats that ran without a project folder and wrote nothing leave an empty
	// folder behind. Nothing is standing in them at startup, so this is when
	// they can go.
	try {
		sweepEmptyChatFolders(chatsRoot());
	} catch {
		// A documents folder that cannot be read is not worth a failed launch.
	}
	const win = createWindow();

	// The app in a browser, when the setting says so: this process, these
	// chats — a browser is one more window on the same app.
	const webServer = new WebServer({
		dist: __dirname,
		dataDir: join(app.getPath("userData"), "web-server"),
		settingsPath: join(app.getPath("userData"), "web-server.json"),
	});
	webServer.mirror(win);
	ipcMain.handle("app:web-server", () => webServer.state());
	ipcMain.handle("app:web-server-set", async (_event, enabled: unknown) => {
		try {
			return await webServer.setEnabled(enabled === true);
		} catch {
			// The failure is in the state's `error`; the switch shows it.
			return webServer.state();
		}
	});
	if (webServer.settings().enabled) {
		webServer.start().catch((error: unknown) => {
			console.error(`web server: ${error instanceof Error ? error.message : String(error)}`);
		});
	}

	let active: AgentSlot = {
		id: ++slotSeq,
		bridge,
		cwd: activeCwd,
		sessionPath: "",
		busy: false,
		turnCapture: null,
		turnWrote: new Set(),
		turnSwept: false,
		temporary: false,
		fresh: true,
	};
	slots.push(active);

	/**
	 * Put the window on a slot, and the app's directory with it.
	 *
	 * The only place `active` is assigned. Every folder-shaped answer — the
	 * diff, the changed-files bar, the stats, the file picker, `git` — reads
	 * `activeCwd`, so the two moving apart is what would have one chat showing
	 * another project's working tree.
	 */
	const setActive = (slot: AgentSlot): void => {
		active = slot;
		activeCwd = slot.cwd;
	};

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

	/**
	 * Name the chat the app has moved to, for every window on it. The
	 * window that asked for the move already shows it; a browser tab on the
	 * in-app web server, or the desktop when the browser did the moving,
	 * follows — the same chat on every screen, not one per screen.
	 */
	const announceSession = (): void => {
		if (!win.isDestroyed()) {
			win.webContents.send("session:changed", { slot: active.id, path: active.sessionPath });
		}
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
				// begins, or the sidebar's busy dot points at nothing. A brand-new
				// chat can still be nameless at that instant, so look again a
				// little later and say so again if the answer changed.
				void refreshSlotPath(slot).then(broadcastBusy);
				broadcastBusy();
				for (const delay of [1500, 4000]) {
					setTimeout(() => {
						if (!slot.busy) return;
						const before = slot.sessionPath;
						void refreshSlotPath(slot).then(() => {
							if (slot.sessionPath !== before) broadcastBusy();
						});
					}, delay);
				}
				slot.turnCapture = captureDiffBaseline(slot.cwd);
				slot.turnWrote = new Set();
				slot.turnSwept = false;
			} else if (type === "message_update") {
				const delta = (event as { assistantMessageEvent?: { type?: string; toolCall?: unknown } })
					.assistantMessageEvent;
				const call =
					delta?.type === "toolcall_end" ? (delta.toolCall as { name?: unknown; arguments?: unknown }) : null;
				if (call) {
					const { target, sweeping } = classifyToolCall(String(call.name ?? ""), call.arguments);
					if (target !== undefined) slot.turnWrote.add(toGitPath(target, slot.cwd, repoRootPath));
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
						const end = await captureDiffBaseline(slot.cwd);
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
			// A sign-in's browser step: the agent names the page, the window
			// opens it. Only web URLs, so a malformed flow cannot launch anything
			// else.
			if (type === "extension_ui_request" && (event as { method?: unknown }).method === "open_url") {
				const url = String((event as { url?: unknown }).url ?? "");
				if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
				return;
			}
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

	/**
	 * A new agent rooted in a folder — the chat on screen's by default, and
	 * another project's when a chat from there is being opened.
	 */
	const spawnSlot = async (cwd: string = activeCwd): Promise<AgentSlot> => {
		const slot: AgentSlot = {
			id: ++slotSeq,
			bridge: new AgentBridge(),
			cwd,
			sessionPath: "",
			busy: false,
			turnCapture: null,
			turnWrote: new Set(),
			turnSwept: false,
			temporary: false,
			fresh: true,
		};
		wireSlot(slot);
		await slot.bridge.start(
			{
				cwd,
				provider: process.env.SMOLT_DESKTOP_PROVIDER,
				model: process.env.SMOLT_DESKTOP_MODEL,
				// The folder note belongs at spawn as much as at a restart: a
				// spare started without it answered as if no folder were open.
				args: agentNotes(cwd),
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

	/**
	 * The folder a stored chat belongs to.
	 *
	 * Its own opening record, which is where it actually ran; the folder on
	 * screen only stands in for a chat too new to have written one yet. A
	 * folder that has since been deleted is not somewhere an agent can start,
	 * so that falls back too.
	 */
	const cwdForSession = (path: string): string => {
		const recorded = sessionCwd(path);
		return recorded !== "" && existsSync(recorded) ? recorded : activeCwd;
	};

	/**
	 * Bring the window's idea of the open project into line with the chat it
	 * has landed on.
	 *
	 * A chat carries its project, so opening one from elsewhere moves the
	 * window there: the folder chip, the folders a new chat would start in,
	 * and what the app reopens with next launch all name the same place.
	 * Without this the directory followed the chat while the folder bar went
	 * on naming the project the reader had left.
	 *
	 * A chat working in a folder of its own is not a project and is not
	 * promoted to one; the window simply has no folder open, which is the
	 * state that chat was started in.
	 */
	const followActiveFolder = (): void => {
		// A directory forced from outside is not the window's to change.
		if (process.env.SMOLT_DESKTOP_CWD) return;
		const cwd = active.cwd;
		if (cwd === "") return;
		if (cwd !== chatsRoot() && cwd.startsWith(chatsRoot())) {
			if (projectFolders.length > 0) {
				rememberProject([], projectFolders);
				projectFolders = [];
			}
			chatFolder = cwd;
			chatSettled = true;
			return;
		}
		// Already the open project — and its extra folders stay with it.
		if (projectFolders[0] === cwd) return;
		rememberProject([cwd], projectFolders);
		projectFolders = [cwd];
		chatSettled = false;
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
		// A spare only saves the wait for a chat in the same folder: an agent
		// is rooted where it started, so one warmed in another project cannot
		// take this one's chats.
		if (slots.some((slot) => slot !== active && !slot.busy && slot.cwd === activeCwd)) return;
		warming = spawnSlot(activeCwd);
		void warming
			.catch(() => undefined)
			.finally(() => {
				warming = null;
			});
	};

	/**
	 * Give a chat with no project folder open one of its own, in the moment
	 * between its first message being typed and being answered.
	 *
	 * The folder is named after that message, so it cannot be made any
	 * earlier, and an agent's working directory is fixed when it starts — so
	 * the agent is restarted into it. Only a chat that has not begun is moved:
	 * a chat with history would be stranded away from the folder it has been
	 * writing in. If an agent is mid-turn the move waits for another chat, as
	 * a restart would take that turn down with it.
	 */
	const settleChatFolder = async (first: unknown): Promise<void> => {
		// A temporary chat names no folder of its own: its whole point is that
		// nothing about it lands on disk, and the agent running in the chats
		// root (or wherever it was opened) already answers where it works.
		if (active.temporary) return;
		const move = needsChatFolder({
			forcedCwd: Boolean(process.env.SMOLT_DESKTOP_CWD),
			hasProject: projectFolders.length > 0,
			settled: chatSettled,
			fresh: active.fresh,
			// This chat's own agent. It used to be any agent at all, because a
			// move restarted every one of them; now it moves only this chat, so
			// another chat working elsewhere is no reason to leave this one
			// without a folder of its own.
			busy: active.busy,
		});
		if (!move) return;
		const previous = chatFolder;
		try {
			chatFolder = createChatFolder(chatsRoot(), new Date(), typeof first === "string" ? first : "");
			chatSettled = true;
			await restartAgentIn(chatFolder);
		} catch (err) {
			// No folder of its own is a poor answer but a working one: the agent
			// stays where it is, and its note still tells it to ask first.
			crashLog(`chat folder: ${err instanceof Error ? err.message : String(err)}`);
			chatFolder = previous;
			chatSettled = false;
		}
	};

	const switchToPath = async (path: string): Promise<unknown> => {
		// The chat opens in the folder it ran in, not the one on screen: an
		// agent's directory is fixed when it starts, so a chat from another
		// project needs an agent rooted there rather than this one moved.
		const cwd = cwdForSession(path);
		const choose = (): SlotChoice =>
			chooseSlotForSession({
				slots: slots.map(({ id, cwd: at, sessionPath, busy }) => ({ id, cwd: at, sessionPath, busy })),
				activeId: active.id,
				sessionPath: path,
				cwd,
			});
		let choice = choose();
		// An agent still starting may be exactly the spare this needs; wait for
		// it before paying for another cold start.
		if (choice.kind === "spawn" && warming !== null) {
			await warming.catch(() => undefined);
			choice = choose();
		}
		const byId = (id: number): AgentSlot | undefined => slots.find((candidate) => candidate.id === id);
		let slot: AgentSlot;
		if (choice.kind === "held") {
			// Already open here, running or not; nothing to ask of the agent.
			slot = byId(choice.id) ?? active;
		} else {
			if (choice.kind === "active") {
				const value = await active.bridge.call("switchSession", [path]);
				await refreshSlotPath(active);
				active.fresh = false;
				active.temporary = false;
				return value;
			}
			slot = choice.kind === "spare" ? (byId(choice.id) ?? (await spawnSlot(cwd))) : await spawnSlot(cwd);
			const value = (await slot.bridge.call("switchSession", [path])) as { cancelled?: boolean } | undefined;
			await refreshSlotPath(slot);
			slot.fresh = false;
			slot.temporary = false;
			if (value?.cancelled) return value;
		}
		setActive(slot);
		followActiveFolder();
		broadcastBusy();
		reapIdleSlots();
		// Line up the next one now. A connector can keep the active agent busy
		// indefinitely, and then every switch pays a cold start on the click.
		ensureSpare();
		return { cancelled: false };
	};

	/** A new chat while the current agent works starts on its own agent. */
	const newSessionSlot = async (temporary?: boolean): Promise<unknown> => {
		// In this chat's folder: a new chat opens where the reader is, and only
		// a free agent already standing there can be the one to take it.
		const cwd = activeCwd;
		const idle = slots.find((candidate) => candidate !== active && !candidate.busy && candidate.cwd === cwd);
		const slot = idle ?? (await spawnSlot(cwd));
		const value = (await slot.bridge.call("newSession", [undefined, temporary === true])) as
			| { cancelled?: boolean }
			| undefined;
		await refreshSlotPath(slot);
		if (value?.cancelled) return value;
		slot.temporary = temporary === true;
		setActive(slot);
		// A new chat on its own agent has claimed no folder either — and it is
		// as unbegun as one started on the agent already in view, so it is
		// still free to be moved into a folder of its own by its first message.
		chatSettled = false;
		slot.fresh = true;
		broadcastBusy();
		reapIdleSlots();
		ensureSpare();
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
			// Back into the folder that chat belongs to, not the one on screen.
			const fresh = await spawnSlot(dead.cwd);
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
			// Only if the window is still on that chat: starting an agent takes a
			// couple of seconds, and a reader who moved on in the meantime must
			// not be dragged back to the chat that died.
			const wasActive = active === dead;
			if (wasActive) setActive(fresh);
			broadcastBusy();
			announceActive();
			reapIdleSlots();
			ensureSpare();
			if (!win.isDestroyed()) win.webContents.send("agent:exited", { slotId: dead.id, wasActive, code });
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
			// A first message is what names this chat's folder, so it is settled
			// here, before the message is answered anywhere.
			if (method === "prompt") await settleChatFolder(list[0]);
			const dispatch = async (): Promise<unknown> => {
				if (method === "switchSession") return await switchToPath(String(list[0] ?? ""));
				if (method === "newSession" && active.busy) {
					return await newSessionSlot(
						(list[0] && typeof list[0] === "object"
							? (list[0] as { temporary?: boolean }).temporary
							: undefined) === true,
					);
				}
				if (method === "newSession") {
					const temporary =
						(list[0] && typeof list[0] === "object"
							? (list[0] as { temporary?: boolean }).temporary
							: undefined) === true;
					const result = await active.bridge.call("newSession", [undefined, temporary]);
					active.temporary = temporary;
					await refreshSlotPath(active);
					// This chat starts over and claims nothing yet; the agent stays
					// in the last folder until this one's first message names its
					// own.
					chatSettled = false;
					active.fresh = true;
					return result;
				}
				const result = await active.bridge.call(method, list);
				if (movesSession) await refreshSlotPath(active);
				if (method === "prompt") active.fresh = false;
				if (method === "clone" || method === "fork") active.fresh = false;
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
				announceSession();
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
	ipcMain.handle("app:titlebar", (_e, theme: string, dimmed?: boolean) => {
		try {
			// The dimmed pair is each theme under the 40% black backdrop the
			// dialogs draw, so the strip the OS paints reads as part of the
			// dimmed page rather than a bright bar above it.
			const light = theme === "light";
			win.setTitleBarOverlay(
				dimmed === true
					? light
						? { color: "#999897", symbolColor: "#3b3534", height: 36 }
						: { color: "#060708", symbolColor: "#686c71", height: 36 }
					: light
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
		// Only the chat on screen moves. This used to restart every slot at
		// once, on the reasoning that background turns would otherwise write
		// into the wrong tree — but they would not: each of those chats is
		// rooted where it was started and stays there, and taking them down
		// meant opening another project silently killed whatever the other
		// chats were in the middle of, with nothing on screen to say so.
		//
		// A fresh bridge rather than a re-wired one: re-wiring a stopped bridge
		// would stack its old event listeners under the new ones. The old agent
		// is dropped, not waited for — its teardown is a second of the switch,
		// and the new process has its own listeners and its own session file.
		const leaving = active;
		stoppingBridges.add(leaving.bridge);
		void leaving.bridge.stop();
		const index = slots.indexOf(leaving);
		if (index >= 0) slots.splice(index, 1);
		// A turn in flight in the chat being moved does die with it — the move
		// was asked for — but it is never taken quietly.
		if (leaving.busy && !win.isDestroyed()) {
			win.webContents.send("agent:turn-dropped", { sessionPath: leaving.sessionPath, cwd: leaving.cwd, to: cwd });
		}
		// A spare warmed for the folder being left is of no use here, and
		// dropping the handle lets the next ensureSpare warm one in the new
		// folder; the agent itself is still in `slots` and still reapable.
		warming = null;
		const slot: AgentSlot = {
			id: ++slotSeq,
			bridge: new AgentBridge(),
			cwd,
			sessionPath: "",
			busy: false,
			turnCapture: null,
			turnWrote: new Set(),
			turnSwept: false,
			temporary: false,
			fresh: true,
		};
		setActive(slot);
		slots.push(slot);
		wireSlot(slot);
		await slot.bridge.start(
			{
				cwd,
				provider: process.env.SMOLT_DESKTOP_PROVIDER,
				model: process.env.SMOLT_DESKTOP_MODEL,
				// With no folder open the agent must not guess a destination.
				args: agentNotes(cwd),
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
		// Idle agents left in the folder just left are worth nothing to the
		// chats still open there, and the cap counts them.
		reapIdleSlots();
		ensureSpare();
		await rebaseline();
		announceActive();
		if (!win.isDestroyed()) win.webContents.send("agent:started", slot.bridge.status);
	};

	/**
	 * Pick up a credential change without disturbing anyone's work.
	 *
	 * Providers, keys and pool membership are read when an agent starts, so a
	 * change needs new agents — but it is not a reason to move a chat or to
	 * end a turn. Idle agents are replaced where they stand; a chat mid-turn
	 * keeps the credentials it started with and is told, rather than being cut
	 * off. This used to call `restartAgentIn(homeCwd())`, which both killed
	 * every running turn and dragged the chat on screen out of its own folder
	 * — adding an API key moved you to another project.
	 */
	const reloadAgents = async (): Promise<void> => {
		// Spares first: they carry no chat, so they simply go and are warmed
		// again from the new credentials on the next switch.
		for (const spare of [...slots]) {
			if (spare === active || spare.busy) continue;
			stoppingBridges.add(spare.bridge);
			void spare.bridge.stop();
			const index = slots.indexOf(spare);
			if (index >= 0) slots.splice(index, 1);
		}
		if (active.busy) {
			// Its turn is worth more than the immediacy of the change.
			if (!win.isDestroyed()) win.webContents.send("agent:reload-deferred", { sessionPath: active.sessionPath });
			return;
		}
		const held = active.sessionPath;
		await restartAgentIn(active.cwd);
		// Back into the same chat: a credential change is not a reason to lose
		// the conversation on screen.
		if (held !== "" && existsSync(held)) {
			try {
				await active.bridge.call("switchSession", [held]);
				await refreshSlotPath(active);
				active.fresh = false;
				announceActive();
			} catch {
				// The chat is on disk either way; a failed switch starts empty.
			}
		}
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
	ipcMain.handle("app:branches", async () => {
		try {
			return { ok: true, value: await listBranches(homeCwd()) };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});
	ipcMain.handle("app:branch-checkout", async (_e, branch: string) => {
		try {
			// The chat on screen runs wherever it runs, and a busy turn writing
			// files while the branch moves under it is not something to risk.
			if (slots.some((slot) => slot.busy)) {
				return { ok: false, error: "A chat is still working. Stop its turn before switching branch." };
			}
			await checkoutBranch(homeCwd(), String(branch ?? ""));
			// The agent reads git state when it starts, so a fresh one is what
			// the new chat opens against.
			await restartAgentIn(homeCwd());
			return { ok: true, value: activeCwd };
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
			const target = String(path);
			// Chats live in their own folders now, so this worktree may be home
			// to background ones as well as to the chat on screen. A turn still
			// running in it is not something to end behind the reader's back —
			// and on Windows a running agent's directory cannot be deleted at
			// all, so the removal would fail here anyway, with a worse message.
			if (slots.some((slot) => slot.busy && slot.cwd === target)) {
				return { ok: false, error: "A chat is still working in that worktree. Stop its turn first." };
			}
			if (activeCwd === target) await restartAgentIn(homeCwd());
			// Idle agents standing there are dropped; nothing is lost, since
			// their chats are on disk and reopen in whatever folder they name.
			for (const idle of [...slots]) {
				if (idle === active || idle.cwd !== target) continue;
				stoppingBridges.add(idle.bridge);
				await idle.bridge.stop();
				const index = slots.indexOf(idle);
				if (index >= 0) slots.splice(index, 1);
			}
			await removeWorktree(homeCwd(), target, force === true);
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
			const { describeFailure, wipeLocalData } = await import("./wipe.ts");
			for (const slot of slots) {
				stoppingBridges.add(slot.bridge);
				await slot.bridge.stop();
			}
			slots.length = 0;
			warming = null;
			const report = await wipeLocalData();
			await restartAgentIn(activeCwd);
			return { ok: report.failed.length === 0, value: report, error: describeFailure(report) };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});

	ipcMain.handle("app:recent-projects", () => readProjectState().recent);

	/** Where this folder's `origin` lives on the web, so a menu can name it. */
	ipcMain.handle("app:repo-url", async (_e, dir?: string) => await remoteWebUrl(String(dir || activeCwd)));

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
			const raw: unknown = JSON.parse(readFileSync(join(agentDir(), "auth.json"), "utf-8"));
			if (raw === null || typeof raw !== "object") return [];
			return Object.keys(raw as Record<string, unknown>);
		} catch {
			return [];
		}
	});

	/**
	 * Every provider with a credential, and the failover pool behind each: what
	 * the settings page lists. Metadata only, read straight from the two files
	 * the CLI shares: the kind of credential, never the credential itself.
	 */
	ipcMain.handle("app:providers-list", async () => {
		const providers = new Map<
			string,
			{
				id: string;
				type?: string;
				primaryLabel?: string;
				pooled: boolean;
				pool: { id: string; label?: string; type: string; addedAt: number; plan?: string }[];
			}
		>();
		try {
			const raw: unknown = JSON.parse(readFileSync(join(agentDir(), "auth.json"), "utf-8"));
			if (raw !== null && typeof raw === "object") {
				for (const [id, credential] of Object.entries(raw as Record<string, { type?: string }>)) {
					providers.set(id, { id, type: credential?.type, pooled: true, pool: [] });
				}
			}
		} catch {
			// No auth file yet: nothing configured.
		}
		try {
			const raw = JSON.parse(readFileSync(join(agentDir(), "pool.json"), "utf-8")) as {
				providers?: Record<
					string,
					{ credentials?: { id: string; label?: string; type: string; addedAt: number; plan?: string }[] }
				>;
				primaryLabels?: Record<string, string>;
				unpooled?: string[];
			};
			for (const id of Array.isArray(raw.unpooled) ? raw.unpooled : []) {
				const existing = providers.get(id);
				if (existing) existing.pooled = false;
			}
			for (const [id, label] of Object.entries(raw.primaryLabels ?? {})) {
				const existing = providers.get(id);
				if (existing && typeof label === "string" && label.trim() !== "") existing.primaryLabel = label.trim();
			}
			for (const [id, pool] of Object.entries(raw.providers ?? {})) {
				const entries = (pool.credentials ?? []).map((entry) => ({
					id: entry.id,
					label: entry.label,
					type: entry.type,
					addedAt: entry.addedAt,
					plan: entry.plan,
				}));
				if (entries.length === 0) continue;
				const existing = providers.get(id);
				if (existing) existing.pool = entries;
				else providers.set(id, { id, pooled: !(raw.unpooled ?? []).includes(id), pool: entries });
			}
		} catch {
			// No pool file: no failover credentials.
		}
		return [...providers.values()];
	});

	/**
	 * Local llama.cpp launcher: what the settings page needs to decide whether
	 * a "Launch server" button applies, and the actual launch. Detection only:
	 * the llama-server binary on the PATH-like spots and a GGUF model directory.
	 */
	function findLlamaServerBinary(): string | undefined {
		const exeSuffix = process.platform === "win32" ? ".exe" : "";
		const candidates: string[] = [];
		const configured = process.env.LLAMA_SERVER_PATH?.trim();
		if (configured) candidates.push(configured);
		candidates.push(join(homedir(), "scoop", "apps", "llama.cpp-cu133", "current", `llama-server${exeSuffix}`));
		candidates.push(join(homedir(), "scoop", "apps", "llama.cpp", "current", `llama-server${exeSuffix}`));
		candidates.push(
			...(process.env.PATH ?? "")
				.split(process.platform === "win32" ? ";" : ":")
				.filter((part) => part.trim() !== "")
				.map((part) => join(part.trim(), `llama-server${exeSuffix}`)),
		);
		return candidates.find((candidate) => existsSync(candidate));
	}

	function llamaModelsDir(): { dir: string; models: number } | undefined {
		const dir = process.env.LLAMA_MODELS_DIR?.trim() || join(homedir(), "models");
		if (!existsSync(dir)) return undefined;
		let models = 0;
		try {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (entry.isFile() && entry.name.toLowerCase().endsWith(".gguf")) models += 1;
				if (entry.isDirectory() && existsSync(join(dir, entry.name, "mmproj-F16.gguf"))) models += 1;
			}
		} catch {
			return undefined;
		}
		return models > 0 ? { dir, models } : undefined;
	}

	async function llamaServerUrl(): Promise<string | undefined> {
		let url = process.env.LLAMA_BASE_URL?.trim();
		if (!url) {
			try {
				const raw: unknown = JSON.parse(readFileSync(join(agentDir(), "auth.json"), "utf-8"));
				const credential = (raw as Record<string, { env?: { LLAMA_BASE_URL?: unknown } } | undefined>)["llama.cpp"];
				const stored = credential?.env?.LLAMA_BASE_URL;
				if (typeof stored === "string" && stored.trim() !== "") url = stored.trim();
			} catch {
				// No auth file or no llama.cpp credential.
			}
		}
		if (!url || !/^https?:\/\//.test(url)) return undefined;
		return url.replace(/\/$/, "");
	}

	async function llamaReachable(serverUrl: string): Promise<boolean> {
		try {
			const response = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(1500) });
			return response.ok;
		} catch {
			return false;
		}
	}

	ipcMain.handle("app:llama-sizeup", async () => {
		const binary = findLlamaServerBinary();
		const models = llamaModelsDir();
		const serverUrl = await llamaServerUrl();
		const reachable = serverUrl !== undefined && (await llamaReachable(serverUrl));
		return {
			binary,
			modelsDir: models?.dir,
			modelCount: models?.models ?? 0,
			serverUrl,
			reachable,
		};
	});

	ipcMain.handle("app:llama-launch", async () => {
		const serverUrl = await llamaServerUrl();
		if (serverUrl !== undefined && (await llamaReachable(serverUrl))) {
			return { ok: true, already: true, serverUrl };
		}
		const binary = findLlamaServerBinary();
		if (!binary) {
			return { ok: false, error: "llama-server was not found. Install llama.cpp first." };
		}
		const models = llamaModelsDir();
		if (!models) {
			return {
				ok: false,
				error: `No GGUF models were found${process.env.LLAMA_MODELS_DIR ? ` in ${process.env.LLAMA_MODELS_DIR}` : " in ~models"}.`,
			};
		}
		const port = Number(/^https?:\/\/[^:/]+:(\d+)$/.exec(serverUrl ?? "")?.[1] ?? 8080);
		try {
			const child = spawn(
				binary,
				[
					"--models-dir",
					models.dir,
					"--jinja",
					"--host",
					"127.0.0.1",
					"--port",
					String(port),
					"-ngl",
					"999",
					"-c",
					"32768",
				],
				{ detached: true, stdio: "ignore", windowsHide: true },
			);
			child.unref();
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
		const deadline = Date.now() + 20_000;
		while (Date.now() < deadline) {
			if (await llamaReachable(`http://127.0.0.1:${port}`)) {
				return { ok: true, serverUrl: `http://127.0.0.1:${port}` };
			}
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		return { ok: false, error: "llama-server started but did not answer within 20 seconds." };
	});

	/**
	 * Forget a provider's credential, then restart so the agent stops offering
	 * its models. Through the agent's own store, which takes the lock the CLI
	 * respects. The pool entries behind it are left alone: they are removed
	 * one at a time, on purpose.
	 */
	ipcMain.handle("app:auth-remove", async (_e, provider: string) => {
		try {
			const name = String(provider ?? "").trim();
			if (name === "") return { ok: false, error: "Which provider?" };
			editAuth((data) => {
				const next = { ...data };
				delete next[name];
				return next;
			});
			void reloadAgents();
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});

	/**
	 * Name a credential: the primary (by the pool's own primary id) or one
	 * failover key. The agent reads the pool file afresh each poll, so the new
	 * name shows up in usage without a restart.
	 */
	ipcMain.handle("app:pool-relabel", async (_e, provider: string, credentialId: string, label: string) => {
		try {
			const name = String(provider ?? "").trim();
			const id = String(credentialId ?? "").trim();
			if (name === "" || id === "") return { ok: false, error: "Which credential?" };
			editPool((current) => relabelPoolCredential(current, name, id, String(label ?? "")));
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});

	/**
	 * Add an instance of a provider: another API key in its pool, the way
	 * /pool add-key does, then restart so the pool wraps it in. The key comes
	 * straight from the dialog over IPC and never touches a transcript.
	 */
	ipcMain.handle("app:pool-add-key", async (_e, provider: string, key: string, label: string) => {
		try {
			const name = String(provider ?? "").trim();
			const secret = String(key ?? "").trim();
			if (name === "" || secret === "") return { ok: false, error: "Both a provider and a key are needed." };
			if (/[\s]/.test(secret))
				return { ok: false, error: "That does not look like an API key: it contains whitespace." };
			const trimmedLabel = String(label ?? "").trim();
			editPool((current) =>
				appendPoolCredential(
					current,
					name,
					{ type: "api_key", key: secret, label: trimmedLabel === "" ? undefined : trimmedLabel },
					randomUUID(),
				),
			);
			void reloadAgents();
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});

	/**
	 * Switch a provider in or out of the pool. Out, it runs on its primary
	 * alone and leaves the usage view; the agent restarts so its failover
	 * wrappers follow.
	 */
	ipcMain.handle("app:pool-set-pooled", async (_e, provider: string, pooled: boolean) => {
		try {
			const name = String(provider ?? "").trim();
			if (name === "") return { ok: false, error: "Which provider?" };
			editPool((current) => setProviderPooled(current, name, pooled === true));
			void reloadAgents();
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});

	/** Drop one failover credential from a provider's pool, the way /pool remove does. */
	ipcMain.handle("app:pool-remove", async (_e, provider: string, credentialId: string) => {
		try {
			const name = String(provider ?? "").trim();
			const id = String(credentialId ?? "").trim();
			if (name === "" || id === "") return { ok: false, error: "Which credential?" };
			editPool((current) => removePoolCredential(current, name, id));
			void reloadAgents();
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
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
			editAuth((data) => ({ ...data, [name]: { type: "api_key", key: secret } }));
			void reloadAgents();
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
			// Only a first folder moves the agent. The rest widen its remit,
			// which is a line of its system prompt and so needs a new agent —
			// but not at the cost of a turn: this said as much and restarted
			// regardless, so adding a second folder killed whatever was running.
			if (primaryChanged) await restartAgentIn(target);
			else await reloadAgents();
			return { ok: true, value: projectFolders };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});

	ipcMain.handle("app:close-project", async () => {
		try {
			rememberProject([], projectFolders);
			projectFolders = [];
			// Closing the folder moves the chat on screen out of it, as asked.
			// Chats that were started in it stay in it — they are still on that
			// project, and clicking one takes the window back there.
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
			if (how === "open") {
				// A path the agent quoted: relative to the folder it was working
				// in, and opened with whatever the system uses for that file.
				const raw = String(target).replace(/^~(?=[/\\])/, homedir());
				const full = isAbsolute(raw) ? raw : join(activeCwd, raw);
				if (!existsSync(full)) return { ok: false, error: `${raw} is not there any more.` };
				const problem = await shell.openPath(full);
				if (problem) return { ok: false, error: problem };
				return { ok: true };
			}
			if (how === "terminal") {
				const dir = String(target);
				if (!existsSync(dir)) return { ok: false, error: `${dir} is not there any more.` };
				openTerminalAt(dir);
				return { ok: true };
			}
			if (how === "repo") {
				const url = await remoteWebUrl(String(target));
				if (url === undefined) return { ok: false, error: "This folder has no origin remote." };
				await shell.openExternal(url);
				return { ok: true };
			}
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

	// Suggestions for the empty new-chat screen, written by the user's own
	// default model over a one-shot CLI run. Long (a model round trip) but
	// fire-and-forget: the empty state shows skeletons and fills in later.
	ipcMain.handle("app:starters", () => {
		try {
			const cli = findCliPath(__dirname);
			if (!cli) return { ok: true, value: [] };
			const runCli = makeCliRunner(cli, agentExecPath(), agentEnv({}));
			return suggestStarters(activeCwd, runCli).then((starters) => ({ ok: true, value: starters }));
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});

	ipcMain.handle("app:pr-readiness", async () => {
		try {
			return { ok: true, value: await prReadiness(activeCwd) };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});

	ipcMain.handle("app:pr-create", async (_e, draft: boolean) => {
		try {
			const result = await createPullRequest(activeCwd, draft === true);
			if (!result.ok) return { ok: false, error: result.error };
			// The pull request is the point; open it rather than leaving a URL
			// in a toast for someone to hunt down.
			if (result.url) void shell.openExternal(result.url);
			return { ok: true, value: result };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});

	ipcMain.handle("app:diff", async () => {
		try {
			// Follows the agent into a worktree, so the pane shows that session's work.
			// The scope is the branch, not the chat: every commit on it plus the
			// working tree, which is what a review or a pull request would carry.
			return { ok: true, value: await collectDiff(activeCwd) };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});
	// The bar's three numbers, without the bodies: what the composer reads on
	// every refresh, so a long branch does not push megabytes of hunks through
	// the pipe just to update a count nobody has opened the pane for.
	ipcMain.handle("app:diff-stats", async () => {
		try {
			return { ok: true, value: await collectDiffStats(activeCwd) };
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
