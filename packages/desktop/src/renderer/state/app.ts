import { api, type SessionRow } from "../lib/api.ts";
import { storedPreference, storePreference } from "../lib/prefs.ts";
import { attachToolResult, fromAgentMessage, initialState, reduce, type UiState } from "../store.ts";

/**
 * The renderer's domain state and actions, kept outside React.
 *
 * Components read through `useApp()` (see useApp.ts), which subscribes to
 * `bump()`. Actions here are ports of the pre-React renderer's handlers; the
 * streaming reducer itself (store.ts) is untouched and fully unit-tested.
 */

export interface Attachment {
	/** base64 payload the agent accepts, without the data: prefix */
	data: string;
	mimeType: string;
	/** full data URL, for the composer thumbnail */
	url: string;
	name: string;
}

export interface ModelOption {
	provider: string;
	id: string;
	reasoning: boolean;
	/** Total context the model accepts, for the composer's context ring. */
	contextWindow?: number;
}

export interface SlashCommand {
	name: string;
	description?: string;
	source: "extension" | "prompt" | "skill";
}

/** An extension dialog forwarded from the agent (extension_ui_request). */
export interface UiDialogRequest {
	id: string;
	method: "select" | "confirm" | "input";
	title: string;
	message?: string;
	options?: string[];
	placeholder?: string;
}

export interface PermissionRequest {
	id: string;
	tool: string;
	summary: string;
	mode: string;
	/** Why the command looks destructive, when it does. */
	danger?: string;
	createdAt: number;
}

export interface DiffFile {
	path: string;
	hunks: string;
	added: number;
	removed: number;
	status: string;
}

export interface UsageStats {
	sessions: number;
	messages: number;
	tokens: number;
	cost: number;
	activeDays: number;
	currentStreak: number;
	longestStreak: number;
	peakHour: number | null;
	/** Replies per hour of the day, 0–23, for the busiest-hours chart. */
	byHour: number[];
	favouriteModel: string | null;
	byDay: Record<string, number>;
	byModel: { model: string; messages: number; tokens: number; input: number; output: number }[];
	byDayModel: Record<string, Record<string, number>>;
}

/** The agent's own context accounting, as the TUI footer shows it. */
export interface ContextUsage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

export interface WorktreeInfo {
	isRepo: boolean;
	activeCwd: string;
	isolated: boolean;
	worktrees: { name: string; branch: string; path: string }[];
}

export type ThemeChoice = "system" | "light" | "dark";

/** A transient, self-dismissing notification card. */
/** An in-app confirmation, in place of the operating system's dialog. */
export interface ConfirmRequest {
	title: string;
	message: string;
	actionLabel: string;
	destructive: boolean;
	resolve: (confirmed: boolean) => void;
}

interface AppState {
	chat: UiState;
	side: UiState;
	model: string;
	thinking: string;
	/** The effort new chats start at; the composer changes only this chat. */
	defaultThinking: string;
	sessionRows: SessionRow[];
	currentSessionPath: string;
	sessionName: string;
	attachments: Attachment[];
	availableModels: ModelOption[];
	availableThinking: string[];
	slashCommands: SlashCommand[];
	autoCompaction: boolean;
	autoRetry: boolean;
	deliverAllQueued: boolean;
	canTranscribe: boolean;
	permissionMode: string;
	runStartedAt: number;
	appInfo: { cwd: string; version: string; hasProject: boolean };
	/** Folders worked in before, newest first, for the folder switcher. */
	recentProjects: string[];
	/** Folders open now, the working directory first. */
	folders: string[];
	/** The add-a-provider dialog, shown when there are no models yet. */
	providerDialogOpen: boolean;
	/** Chats picked out for a bulk action, by session path. */
	selectedSessions: Set<string>;
	/** How often each slash command has been run, for palette ordering. */
	commandUse: Record<string, number>;
	repoBranch: string;
	contextUsage: ContextUsage | null;
	diffFiles: DiffFile[];
	preexistingChanges: number;
	/** The diff as it stood when the repo bar's × was clicked (path → hunks), or null when not dismissed. */
	repoBarDismissed: Map<string, string> | null;
	/** Messages waiting on a turn, per chat: a queue belongs to its own conversation. */
	queuedBySession: Map<string, QueuedMessage[]>;
	/** Where the rendered window starts in the chat; above 0 there is more above it. */
	historyStart: number;
	/** User messages before the window, so a rewind still names the right one. */
	historyUserStart: number;
	/** Where the window was filled from, and so where the page above it comes from. */
	historySource: "disk" | "agent";
	/** An earlier page is on its way. */
	historyLoading: boolean;
	/** The chat is being read in; the transcript shows a spinner, not an empty state. */
	chatLoading: boolean;
	/** This chat has run a tool, remembered past the end of the rendered page. */
	chatUsedTools: boolean;
	/** The agent whose events the window is currently reducing; null mid-switch. */
	attachedSlot: number | null;
	pendingApprovals: PermissionRequest[];
	uiRequests: UiDialogRequest[];
	confirm: ConfirmRequest | null;
	stats: UsageStats | null;
	statsTab: "overview" | "models" | "rhythm";
	statsWindow: number;
	sideSeeded: boolean;
	sideError: string | null;
	// UI surfaces the keyboard shortcuts also need to reach.
	sidebarHidden: boolean;
	sessionSearchOpen: boolean;
	sessionQuery: string;
	diffOpen: boolean;
	sideOpen: boolean;
	settingsOpen: boolean;
	shortcutsOpen: boolean;
	modelMenuOpen: boolean;
	modeMenuOpen: boolean;
	effortOpen: boolean;
	serif: boolean;
	themeChoice: ThemeChoice;
	// Dictation surface state; the audio machinery lives in voice.ts.
	voiceActive: boolean;
	voicePreparing: boolean;
	voiceFinishing: boolean;
	voiceDenied: boolean;
	micDeviceId: string;
	/** How loud the microphone is right now, 0–1, while dictation runs. */
	voiceLevel: number;
	/** The device that recorded nothing, so the mic button can say which. */
	voiceSilent: string;
	/** A stop has been asked for and not yet taken effect. */
	aborting: boolean;
	holdToRecord: boolean;
	/** Composer text lives here so dictation and history can write it. */
	draft: string;
	busySessions: Set<string>;
	pinned: Set<string>;
	archived: Set<string>;
	collapsedGroups: Set<string>;
}

export const app: AppState = {
	chat: initialState(),
	side: initialState(),
	model: "",
	thinking: "",
	defaultThinking: storedPreference("smolt.defaultEffort", ""),
	sessionRows: [],
	currentSessionPath: "",
	sessionName: "",
	attachments: [],
	availableModels: [],
	availableThinking: [],
	slashCommands: [],
	autoCompaction: true,
	autoRetry: true,
	deliverAllQueued: false,
	canTranscribe: false,
	permissionMode: "auto",
	runStartedAt: 0,
	appInfo: { cwd: "", version: "", hasProject: false },
	recentProjects: [],
	folders: [],
	providerDialogOpen: false,
	selectedSessions: new Set<string>(),
	commandUse: readCommandUse(),
	repoBranch: "",
	contextUsage: null,
	diffFiles: [],
	preexistingChanges: 0,
	repoBarDismissed: null,
	queuedBySession: new Map(),
	historyStart: 0,
	historyUserStart: 0,
	historySource: "disk",
	historyLoading: false,
	chatLoading: false,
	chatUsedTools: false,
	attachedSlot: null,
	pendingApprovals: [],
	uiRequests: [],
	confirm: null,
	stats: null,
	statsTab: "overview",
	statsWindow: 0,
	sideSeeded: false,
	sideError: null,
	sidebarHidden: false,
	sessionSearchOpen: false,
	sessionQuery: "",
	diffOpen: false,
	sideOpen: false,
	settingsOpen: false,
	shortcutsOpen: false,
	modelMenuOpen: false,
	modeMenuOpen: false,
	effortOpen: false,
	serif: false,
	themeChoice: "system",
	voiceActive: false,
	voicePreparing: false,
	voiceFinishing: false,
	voiceDenied: false,
	micDeviceId: "",
	voiceLevel: 0,
	voiceSilent: "",
	aborting: false,
	holdToRecord: false,
	draft: "",
	busySessions: new Set<string>(),
	pinned: new Set<string>(),
	archived: new Set<string>(),
	collapsedGroups: new Set<string>(),
};

// ---------------------------------------------------------------------------
// Subscription
// ---------------------------------------------------------------------------

const listeners = new Set<() => void>();
let version = 0;

export function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function getVersion(): number {
	return version;
}

export function bump(): void {
	version += 1;
	for (const listener of listeners) listener();
}

// ---------------------------------------------------------------------------
// RPC plumbing
// ---------------------------------------------------------------------------

/**
 * A message waiting for the turn to finish.
 *
 * The whole payload is kept, not just the line the banner shows: sending
 * it now has to reproduce the message the agent was given, attachments
 * included, and the label is a shortened form with the images named.
 */
export interface QueuedMessage {
	label: string;
	text: string;
	images: { type: "image"; data: string; mimeType: string }[];
}

export async function call<T>(method: string, ...args: unknown[]): Promise<T | null> {
	const result = await api.call(method, ...args);
	if (!result.ok) {
		reportAgentError(result.error ?? "unknown error");
		bump();
		return null;
	}
	reportAgentError(null);
	return result.value as T;
}

/** The last one surfaced, so a run of identical failures only toasts once. */
let lastAgentError: string | null = null;

/**
 * Agent failures have no reserved line in the layout, so they arrive as toasts.
 * Repeats are swallowed: a broken agent fails every call, and one card per
 * failure would bury the rest of the interface.
 */
export function reportAgentError(message: string | null): void {
	if (message === lastAgentError) return;
	lastAgentError = message;
	if (message !== null && message !== "") toast(message, "error");
}

/** Show a transient card that dismisses itself; errors linger a little longer. */
export function toast(message: string, tone: "default" | "error" = "default"): void {
	if (message.trim() === "") return;
	// Nothing pops up any more: the cards were more intrusive than the things
	// they reported. Failures go to the console so they can still be traced,
	// and the call sites stay put should a quieter surface ever be wanted.
	if (tone === "error") console.error(message);
	else console.info(message);
}

/** Ask the user to confirm in an in-app dialog, never the OS one. */
export function requestConfirm(options: {
	title: string;
	message: string;
	actionLabel?: string;
	destructive?: boolean;
}): Promise<boolean> {
	return new Promise((resolve) => {
		// A second request while one is open would orphan the first answer;
		// resolve the earlier one as declined and move on.
		app.confirm?.resolve(false);
		app.confirm = {
			title: options.title,
			message: options.message,
			actionLabel: options.actionLabel ?? "Confirm",
			destructive: options.destructive ?? false,
			resolve,
		};
		bump();
	});
}

export function resolveConfirm(confirmed: boolean): void {
	const pending = app.confirm;
	app.confirm = null;
	bump();
	pending?.resolve(confirmed);
}

/** Answer one extension dialog and remove it from the queue. */
export function answerUiRequest(response: {
	id: string;
	value?: string;
	confirmed?: boolean;
	cancelled?: boolean;
}): void {
	app.uiRequests = app.uiRequests.filter((request) => request.id !== response.id);
	bump();
	void call("respondExtensionUI", response);
}

function handleExtensionUiRequest(request: {
	id: string;
	method: string;
	title?: string;
	message?: string;
	options?: string[];
	placeholder?: string;
	notifyType?: string;
}): void {
	switch (request.method) {
		case "select":
		case "confirm":
		case "input":
			app.uiRequests.push({
				id: request.id,
				method: request.method,
				title: request.title ?? "",
				message: request.message,
				options: request.options,
				placeholder: request.placeholder,
			});
			bump();
			return;
		case "editor":
			// No extension editor surface here; cancel so the extension isn't stuck.
			void call("respondExtensionUI", { id: request.id, cancelled: true });
			return;
		case "notify":
			// Only failures interrupt; an extension telling us it is fine can stay quiet.
			if (request.notifyType === "error") toast(request.message ?? "", "error");
			return;
		default:
			// setStatus / setWidget / setTitle / set_editor_text: fire-and-forget
			// with no desktop surface yet.
			return;
	}
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

/**
 * Work in a different folder.
 *
 * The agent is a subprocess rooted at one directory, so changing project means
 * restarting it there; sessions, statistics and the diff are all scoped to the
 * working directory and follow on their own once the state is refreshed.
 */
/**
 * Slash command tallies, so the palette leads with what gets used.
 *
 * Cosmetic and per-machine, which is why it lives beside the other
 * localStorage preferences rather than in the agent's own state.
 */
function readCommandUse(): Record<string, number> {
	try {
		const parsed: unknown = JSON.parse(storedPreference("smolt.commandUse", "{}"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const out: Record<string, number> = {};
		for (const [name, count] of Object.entries(parsed as Record<string, unknown>)) {
			if (typeof count === "number" && Number.isFinite(count)) out[name] = count;
		}
		return out;
	} catch {
		return {};
	}
}

/** Count one run of a command, so the palette can lead with the popular ones. */
export function noteCommandUse(name: string): void {
	if (name === "") return;
	app.commandUse = { ...app.commandUse, [name]: (app.commandUse[name] ?? 0) + 1 };
	storePreference("smolt.commandUse", JSON.stringify(app.commandUse));
}

export async function openProject(path: string): Promise<void> {
	// Show the destination before asking for it. Moving folders restarts the
	// agent, which takes a couple of seconds, and leaving the old folder on
	// screen throughout reads as nothing having happened.
	const previous = { ...app.appInfo };
	const previousFolders = app.folders;
	app.appInfo = { ...app.appInfo, cwd: path, hasProject: true };
	app.folders = [path];
	app.chat.messages = [];
	app.chat.usage = null;
	bump();

	const result = await api.openProject(path);
	if (!result.ok) {
		toast(result.error ?? "Could not open that folder", "error");
		app.appInfo = previous;
		app.folders = previousFolders;
		bump();
		return;
	}
	const info = await api.info();
	app.appInfo = { ...app.appInfo, cwd: String(info?.cwd ?? path), hasProject: info?.hasProject !== false };
	// Nothing is awaited past this point. The agent is still starting in the new
	// folder, and its first answer takes a couple of seconds; the chat is empty
	// by definition of having just moved, so there is nothing worth waiting for.
	void refreshRecentProjects();
	void (async () => {
		await refreshState();
		await loadMessages();
	})();
}

/**
 * Work with no folder open.
 *
 * This is the state the app starts in, and it is a real choice rather than a
 * gap: the agent has nowhere the reader has chosen, so it asks before it puts
 * a file anywhere.
 */
export async function closeProject(): Promise<void> {
	// Closing restarts the agent in its scratch directory, which takes as long
	// as opening one; the screen should not sit on the old folder meanwhile.
	const previous = { ...app.appInfo };
	const previousFolders = app.folders;
	app.appInfo = { ...app.appInfo, hasProject: false };
	app.folders = [];
	app.chat.messages = [];
	app.chat.usage = null;
	bump();

	const result = await api.closeProject();
	if (!result.ok) {
		toast(result.error ?? "Could not close the folder", "error");
		app.appInfo = previous;
		app.folders = previousFolders;
		bump();
		return;
	}
	const info = await api.info();
	app.appInfo = { ...app.appInfo, cwd: String(info?.cwd ?? ""), hasProject: false };
	void refreshRecentProjects();
	void (async () => {
		await refreshState();
		await loadMessages();
	})();
}

/** Reload the folder lists behind the switcher and the chips. */
export async function refreshRecentProjects(): Promise<void> {
	try {
		app.recentProjects = await api.recentProjects();
		app.folders = await api.folders();
	} catch {
		app.recentProjects = [];
		app.folders = [];
	}
	bump();
}

/**
 * Add a folder beside the ones already open.
 *
 * The first folder opened stays the working directory; the rest are extra
 * places the agent is told it may use, so adding one never restarts a turn.
 */
export async function addFolder(): Promise<void> {
	const picked = await api.pickFolder();
	if (!picked.ok) {
		toast(picked.error ?? "Could not open the folder picker", "error");
		return;
	}
	const path = String(picked.value ?? "");
	if (path === "") return;
	const result = await api.addFolder(path);
	if (!result.ok) {
		toast(result.error ?? "Could not add that folder", "error");
		return;
	}
	const info = await api.info();
	app.appInfo = { ...app.appInfo, cwd: String(info?.cwd ?? ""), hasProject: info?.hasProject === true };
	await refreshRecentProjects();
	await refreshState();
}

/** Choose a folder, then work in it. */
export async function pickProject(): Promise<void> {
	const picked = await api.pickFolder();
	if (!picked.ok) {
		toast(picked.error ?? "Could not open the folder picker", "error");
		return;
	}
	const path = String(picked.value ?? "");
	if (path === "") return;
	await openProject(path);
}

/**
 * Just the sidebar list, without the rest of a full state refresh.
 *
 * Used when a chat first becomes real: the list is the only thing that has
 * changed, and reloading state, stats and the diff for it would cost a second.
 */
export async function refreshSessionRows(): Promise<void> {
	app.sessionRows = (await api.sessions()) ?? [];
	bump();
}

/**
 * When each chat's turn began, kept by session so a switch does not restart it.
 *
 * The elapsed time was anchored to the moment the window first saw a turn, so
 * looking away and back made a five-minute turn look like a fresh one.
 */
const turnStarts = new Map<string, number>();

/** Note that this chat's turn is under way, if its start is not already known. */
function markTurnStart(path: string): void {
	if (path === "" || turnStarts.has(path)) return;
	turnStarts.set(path, Date.now());
}

/** Anchor the footer's clock to when the turn actually began. */
function syncRunStart(): void {
	if (!app.chat.streaming) {
		turnStarts.delete(app.currentSessionPath);
		app.runStartedAt = 0;
		return;
	}
	markTurnStart(app.currentSessionPath);
	// An unknown chat (a turn that began before this window saw it) starts now,
	// which undercounts rather than inventing a time it cannot know.
	app.runStartedAt = turnStarts.get(app.currentSessionPath) ?? Date.now();
}

export async function refreshState(): Promise<void> {
	const rpcState = await call<Record<string, unknown>>("getState");
	if (rpcState) {
		const m = rpcState.model as Record<string, unknown> | undefined;
		app.model = m ? `${m.provider ?? ""}/${m.id ?? ""}`.replace(/^\//, "") : String(rpcState.modelId ?? "");
		app.thinking = String(rpcState.thinkingLevel ?? "");
		const path = String(rpcState.sessionFile ?? "");
		// A chat's first turn is where its file appears, so anything queued
		// before then was filed under the empty path; move it with the chat
		// rather than stranding it under a key nothing reads again.
		const early = app.queuedBySession.get("");
		if (early && path !== "" && app.currentSessionPath === "") {
			app.queuedBySession.delete("");
			app.queuedBySession.set(path, early);
		}
		app.currentSessionPath = path;
		app.sessionName = String(rpcState.sessionName ?? "");
		app.autoCompaction = rpcState.autoCompactionEnabled !== false;
		app.deliverAllQueued = rpcState.steeringMode === "all";
		// The view may have just landed on an agent mid-turn; mirror its truth.
		app.chat.streaming = rpcState.isStreaming === true;
		syncRunStart();
	}
	app.sessionRows = (await api.sessions()) ?? [];
	void refreshStats();
	void refreshDiff();
	void refreshContextUsage();
	bump();
}

/**
 * The context figure is the agent's own — the same accounting the TUI footer
 * shows and auto-compaction acts on — so the dial is cumulative, survives
 * session switches, and honestly reads unknown right after a compaction.
 */
/**
 * Re-read the diff while a turn is still running.
 *
 * The repository bar used to update only when the turn settled, so a
 * chat that edited a file five minutes ago showed nothing until it
 * finished — or until the reader pressed stop, which is what made it
 * look like stopping was the thing that produced the change.
 *
 * Throttled, because a turn can finish a write every few hundred
 * milliseconds and each read shells out to git.
 */
const DIFF_REFRESH_MS = 1500;
let diffRefreshAt = 0;
let diffRefreshTimer: ReturnType<typeof setTimeout> | null = null;

export function refreshDiffSoon(): void {
	if (diffRefreshTimer !== null) return;
	const wait = Math.max(0, diffRefreshAt + DIFF_REFRESH_MS - Date.now());
	diffRefreshTimer = setTimeout(() => {
		diffRefreshTimer = null;
		diffRefreshAt = Date.now();
		void refreshDiff();
	}, wait);
}

export async function refreshContextUsage(): Promise<void> {
	const stats = await call<{ contextUsage?: ContextUsage }>("getSessionStats");
	app.contextUsage = stats?.contextUsage ?? null;
	bump();
}

/**
 * How much of a chat is rendered at once.
 *
 * A long conversation runs to thousands of messages; drawing the lot to
 * show the last few is slow to load and slow to scroll. Only a page is
 * held, and scrolling to the top asks for the one above it.
 */
const PAGE = 60;

/** Stored messages in the shape the transcript draws, tool results folded in. */
function toChatMessages(raw: Record<string, unknown>[]): typeof app.chat.messages {
	const messages: typeof app.chat.messages = [];
	for (const entry of raw) {
		if (entry.role === "toolResult") {
			attachToolResult(messages, entry);
			continue;
		}
		const mapped = fromAgentMessage(entry);
		if (mapped && mapped.blocks.length > 0) messages.push(mapped);
	}
	return messages;
}

const countUsers = (raw: Record<string, unknown>[]): number => raw.filter((entry) => entry.role === "user").length;

/**
 * The transcript as the agent holds it — needed when a turn is in flight,
 * since the file cannot show a message still being written. Only the last
 * page is drawn, the same as a read from disk.
 */
export async function loadMessages(): Promise<void> {
	const messages = await call<Record<string, unknown>[]>("getMessages");
	if (!messages) return;
	const start = Math.max(0, messages.length - PAGE);
	app.chat.messages = toChatMessages(messages.slice(start));
	app.historyStart = start;
	app.historyUserStart = countUsers(messages.slice(0, start));
	app.historySource = "agent";
	// Put the turn cost back. Switching into a chat clears it, and the count
	// only ever refills from a streamed usage event — so on a long turn the
	// footer would sit there with no tokens for however long the turn had left.
	app.chat.usage = latestUsage(messages) ?? app.chat.usage;
	bump();
}

/** The newest usage figures in a transcript, which are the turn so far. */
function latestUsage(messages: Record<string, unknown>[]): { input: number; output: number; cost: number } | null {
	for (let index = messages.length - 1; index >= 0; index--) {
		const raw = messages[index];
		if (raw?.role !== "assistant") continue;
		const usage = raw.usage as { input?: number; output?: number; cost?: { total?: number } } | undefined;
		if (!usage || typeof usage.input !== "number") continue;
		return { input: usage.input, output: usage.output ?? 0, cost: usage.cost?.total ?? 0 };
	}
	return null;
}

/**
 * Add the page above the one on screen.
 *
 * It comes from wherever the window was filled from: mixing the two would
 * mean lining up two lists that need not agree, since the agent can hold a
 * message the file has not been given yet.
 */
export async function loadEarlier(): Promise<void> {
	if (app.historyLoading || app.historyStart <= 0) return;
	const path = app.currentSessionPath;
	app.historyLoading = true;
	bump();
	try {
		const start = Math.max(0, app.historyStart - PAGE);
		let older: Record<string, unknown>[];
		let userStart: number;
		if (app.historySource === "agent") {
			const all = (await call<Record<string, unknown>[]>("getMessages")) ?? [];
			older = all.slice(start, app.historyStart);
			userStart = countUsers(all.slice(0, start));
		} else {
			const page = await api.sessionMessages(path, { limit: PAGE, before: app.historyStart });
			older = page.messages;
			userStart = page.userStart;
		}
		// A switch may have overtaken this read; that chat owns the view now.
		if (app.currentSessionPath !== path || older.length === 0) return;
		// The pages are mapped apart, so a tool call left at the end of one
		// keeps its output in the next; only the join itself can lose a result.
		app.chat.messages = [...toChatMessages(older), ...app.chat.messages];
		app.historyStart = start;
		app.historyUserStart = userStart;
	} catch {
		// Nothing added; the top of the transcript still offers another go.
	} finally {
		app.historyLoading = false;
		bump();
	}
}

export async function refreshStats(): Promise<void> {
	const result = await api.stats();
	if (result.ok) {
		app.stats = result.value as UsageStats;
		bump();
	}
}

export async function refreshDiff(): Promise<void> {
	const result = await api.diff();
	if (!result.ok) {
		// Keep the last good answer. Wiping the list on a failed read made a
		// momentary error look like the change had been undone: the bar
		// vanished and the panel emptied, with nothing to say why.
		reportAgentError(result.error ?? "Could not read the working tree");
		return;
	}
	const { files, branch, preexisting } = (result.value ?? {}) as {
		files?: DiffFile[];
		unavailable?: string;
		branch?: string;
		preexisting?: number;
	};
	app.preexistingChanges = preexisting ?? 0;
	app.repoBranch = branch ?? "";
	const next = files ?? [];
	// The × holds until a genuinely new change appears: a file the dismissal
	// never saw, or one whose diff has moved since. Changes merely vanishing
	// (a commit, a revert) keep the bar hidden.
	if (app.repoBarDismissed && next.some((file) => app.repoBarDismissed?.get(file.path) !== file.hunks)) {
		app.repoBarDismissed = null;
	}
	app.diffFiles = next;
	bump();
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/**
 * Ask the turn to stop, and show that it was asked at once.
 *
 * Aborting is not instant — the agent finishes what it is inside before it
 * unwinds — so a button that stays live reads as a button that did not
 * work, and gets pressed again.
 */
export async function abortTurn(): Promise<void> {
	if (app.aborting) return;
	app.aborting = true;
	bump();
	await call("abort");
}

/** Prompts already sent, newest last; Up/Down walk this like a shell history. */
export const promptHistory: string[] = [];

export async function send(): Promise<void> {
	const text = app.draft.trim();
	const images = app.attachments.map(({ data, mimeType }) => ({ type: "image" as const, data, mimeType }));
	if (text === "" && images.length === 0) return;
	app.draft = "";
	if (text !== "") {
		promptHistory.push(text);
		if (promptHistory.length > 200) promptHistory.shift();
	}
	app.attachments = [];
	bump();
	if (app.chat.streaming) {
		const label =
			images.length > 0 ? `${images.length === 1 ? "[Image]" : `[${images.length} images]`} ${text}`.trim() : text;
		if (label !== "") {
			app.queuedBySession.set(app.currentSessionPath, [...queuedHere(), { label, text, images }]);
			bump();
		}
		// Steered, not followed up. A follow-up waits for the whole run to
		// finish — every tool call, every retry — which on a long agentic turn
		// is minutes of the message sitting there looking ignored. Steering
		// delivers it at the next tool boundary, which is the first moment the
		// agent can actually read it.
		await call("steer", text, images);
	} else {
		// A first message is what turns a scratch chat into a stored one. Put the
		// row in the sidebar now, titled from the message, rather than leaving the
		// chat unlisted until the agent has written its file and a refresh lands.
		const firstMessage = app.chat.messages.length === 0;
		await call("prompt", text, images);
		if (firstMessage) await adoptNewChat(text);
	}
}

/**
 * List the chat that has just been started, before the agent's file exists.
 *
 * The row is provisional: the next refresh replaces it with the stored one,
 * which carries the same path and so takes its place rather than doubling it.
 */
async function adoptNewChat(text: string): Promise<void> {
	const title = titleFrom(text);
	if (app.currentSessionPath === "" || title === "") return;
	// Name it for real rather than leaning on the lister's fallback, which only
	// ever shows the opening words: a stored name survives, and a chat opened
	// with boilerplate (a skill's preamble) still reads as itself.
	void call("setSessionName", title);
	app.sessionName = title;
	await refreshSessionRows();
	if (app.sessionRows.some((row) => row.path === app.currentSessionPath)) return;
	app.sessionRows = [
		{
			path: app.currentSessionPath,
			id: app.currentSessionPath,
			cwd: app.appInfo.cwd,
			title,
			preview: text.trim().slice(0, 120),
			lastActive: Date.now(),
			messageCount: 1,
		},
		...app.sessionRows,
	];
	bump();
}

/**
 * A chat's name, from the message that started it.
 *
 * Kept to the first sentence and a whole word, so the sidebar reads as a list
 * of subjects rather than of severed openings.
 */
function titleFrom(text: string): string {
	const firstLine =
		text
			.trim()
			.split("\n")
			.find((line) => line.trim() !== "") ?? "";
	// A slash command is how the chat was invoked, not what it is about.
	const body = firstLine.replace(/^\/\S+\s*/, "").trim() || firstLine.trim();
	const sentence = (body.split(/(?<=[.!?])\s/)[0] ?? body).replace(/\s+/g, " ").trim();
	if (sentence.length <= 48) return sentence;
	const cut = sentence.slice(0, 48);
	const lastSpace = cut.lastIndexOf(" ");
	return `${(lastSpace > 24 ? cut.slice(0, lastSpace) : cut).replace(/[,;:.]$/, "")}…`;
}

/** What this chat has waiting — never another chat's queue. */
export function queuedHere(): QueuedMessage[] {
	return app.queuedBySession.get(app.currentSessionPath) ?? [];
}

/**
 * Deliver what is waiting straight into the running turn.
 *
 * Queueing is the safe default — a half-formed thought should not
 * redirect work already under way — but once it is typed the reader can
 * see it is not half-formed, and waiting out a long turn to say so is
 * its own kind of wrong. This takes the message out of the agent's queue
 * and steers it in instead.
 */
export async function sendQueuedNow(): Promise<void> {
	const path = app.currentSessionPath;
	const waiting = queuedHere();
	if (waiting.length === 0) return;
	const text = waiting
		.map((message) => message.text)
		.filter((line) => line !== "")
		.join("\n\n");
	const images = waiting.flatMap((message) => message.images);
	if (text === "" && images.length === 0) return;
	// Take it out of the agent's queue so the send below is not a second
	// copy of the same message.
	if ((await call("clearQueue")) === null) return;
	app.queuedBySession.delete(path);
	bump();
	// A turn that finished while the message sat there cannot be steered:
	// steering an idle agent puts the message somewhere nothing reads, and
	// it was just taken out of the queue. Start a turn with it instead.
	const method = app.chat.streaming ? "steer" : "prompt";
	const sent = await call(method, text, images);
	if (sent === null) {
		// Delivery failed; put it back rather than losing what was typed.
		app.queuedBySession.set(path, waiting);
		bump();
	}
}

export async function clearQueued(): Promise<void> {
	app.queuedBySession.delete(app.currentSessionPath);
	bump();
	await call("clearQueue");
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * Switching chats never interrupts a working agent: a busy session keeps its
 * own agent process and finishes in the background (the main process runs a
 * pool), the way the reference apps behave. Only the view moves.
 */
/**
 * Which agent the window is listening to.
 *
 * The main process runs an agent per busy chat and announces the one on
 * screen; this is the renderer's side of that. It is asked for directly
 * after a switch as well, so a dropped announcement cannot leave the
 * window permanently deaf.
 */
async function reattach(): Promise<void> {
	if (typeof api.activeSlot !== "function") return;
	try {
		app.attachedSlot = await api.activeSlot();
	} catch {
		// Nothing to attach to; the announcement is the other way in.
	}
	bump();
}

export async function switchToSession(path: string): Promise<void> {
	if (path === app.currentSessionPath) return;
	// Move the view first. The agent's own switch takes about a second and the
	// transcript another half, so waiting for both before anything changes on
	// screen reads as a hang rather than a load.
	app.currentSessionPath = path;
	app.chat.messages = [];
	app.chat.usage = null;
	resetHistory(true);
	// The pool tells the window which chats are working, so a turn in flight
	// says so at once. Asking the agent instead means waiting on a process
	// that is busy answering, which is what left the line missing for seconds.
	app.chat.streaming = app.busySessions.has(path);
	syncRunStart();
	bump();
	// Render from the stored transcript first. Switching inside the agent takes
	// seconds, and the same messages are already on disk; waiting for the agent
	// before showing anything is what made opening a chat feel broken.
	await loadStoredMessages(path);
	if (app.currentSessionPath === path) {
		app.chatLoading = false;
		bump();
	}

	const result = await call<{ cancelled: boolean }>("switchSession", path);
	await reattach();
	if (!result || result.cancelled) return;
	// The agent is authoritative only for a turn still in flight, which the
	// file cannot show — so a working chat is asked first, before the state
	// round-trip, and a settled one is spared the fetch altogether.
	let asked = false;
	if (app.busySessions.has(path)) {
		await loadMessages();
		asked = true;
	}
	await refreshState();
	if (app.chat.streaming && !asked) await loadMessages();
}

/** Forget the window; a different chat is about to fill it. */
function resetHistory(loading: boolean): void {
	app.chatUsedTools = false;
	app.historyStart = 0;
	app.historyUserStart = 0;
	app.historySource = "disk";
	app.historyLoading = false;
	app.chatLoading = loading;
}

/** Fill the transcript from the session file, without troubling the agent. */
async function loadStoredMessages(path: string): Promise<void> {
	let page: { messages: Record<string, unknown>[]; start: number; userStart: number };
	try {
		page = await api.sessionMessages(path, { limit: PAGE });
	} catch {
		return;
	}
	// A later switch may have overtaken this read; it owns the view now.
	if (app.currentSessionPath !== path || page.messages.length === 0) return;
	app.chat.messages = toChatMessages(page.messages);
	app.historyStart = page.start;
	app.historyUserStart = page.userStart;
	app.historySource = "disk";
	bump();
}

export async function newSession(): Promise<void> {
	resetHistory(false);
	await call("newSession");
	await reattach();
	// A fresh chat starts at the effort chosen in settings, not at whatever the
	// last one was left on.
	if (app.defaultThinking !== "") await call("setThinkingLevel", app.defaultThinking, false);
	app.chat.messages = [];
	app.chat.usage = null;
	await refreshState();
}

export async function cycleSession(step: number): Promise<void> {
	if (app.sessionRows.length === 0) return;
	const current = app.sessionRows.findIndex((row) => row.path === app.currentSessionPath);
	const next =
		app.sessionRows[
			(((current < 0 ? 0 : current + step) % app.sessionRows.length) + app.sessionRows.length) %
				app.sessionRows.length
		];
	if (!next || next.path === app.currentSessionPath) return;
	await switchToSession(next.path);
}

export async function renameSession(row: SessionRow): Promise<void> {
	// Naming writes into the session itself, so it has to be the open one.
	if (row.path !== app.currentSessionPath) await switchToSession(row.path);
	const name = window.prompt("Name this chat", app.sessionName || row.title);
	if (name?.trim()) {
		await call("setSessionName", name.trim());
		app.sessionName = name.trim();
		await refreshState();
	}
}

export async function forkSession(row: SessionRow): Promise<void> {
	if (row.path !== app.currentSessionPath) await switchToSession(row.path);
	const forked = await call<{ cancelled: boolean }>("clone");
	if (forked && !forked.cancelled) {
		await refreshState();
		await loadMessages();
	}
}

export function togglePinned(path: string): void {
	if (app.pinned.has(path)) app.pinned.delete(path);
	else app.pinned.add(path);
	storePreference("smolt.pinned", [...app.pinned].join("\n"));
	bump();
}

export function archiveSession(row: SessionRow): void {
	app.archived.add(row.path);
	storePreference("smolt.archived", [...app.archived].join("\n"));
}

export async function deleteSession(row: SessionRow): Promise<void> {
	const sure = await requestConfirm({
		title: "Delete session?",
		message: `"${row.title}" will be permanently deleted. This can't be undone.`,
		actionLabel: "Delete",
		destructive: true,
	});
	if (!sure) return;
	const result = await api.sessionDelete(row.path);
	if (!result.ok) {
		toast(result.error ?? "Could not delete that chat", "error");
		return;
	}
	if (row.path === app.currentSessionPath) await call("newSession");
	await refreshState();
}

/**
 * Pick out every chat in a group, so one gesture can act on the lot.
 *
 * Selecting replaces rather than adds: a right-click on a second heading is
 * far more likely to mean "that group instead" than "both groups".
 */
export function selectSessions(paths: string[]): void {
	app.selectedSessions = new Set(paths);
	bump();
}

export function clearSessionSelection(): void {
	if (app.selectedSessions.size === 0) return;
	app.selectedSessions = new Set();
	bump();
}

/** Delete every selected chat, once. */
export async function deleteSelectedSessions(): Promise<void> {
	const paths = [...app.selectedSessions];
	if (paths.length === 0) return;
	const sure = await requestConfirm({
		title: paths.length === 1 ? "Delete chat?" : `Delete ${paths.length} chats?`,
		message:
			paths.length === 1
				? "This chat will be permanently deleted. This can't be undone."
				: `${paths.length} chats will be permanently deleted. This can't be undone.`,
		actionLabel: "Delete",
		destructive: true,
	});
	if (!sure) return;
	let deletedCurrent = false;
	for (const path of paths) {
		const result = await api.sessionDelete(path);
		if (!result.ok) {
			toast(result.error ?? "Could not delete that chat", "error");
			continue;
		}
		if (path === app.currentSessionPath) deletedCurrent = true;
	}
	app.selectedSessions = new Set();
	if (deletedCurrent) await call("newSession");
	await refreshState();
}

export function toggleGroupCollapsed(label: string): void {
	if (app.collapsedGroups.has(label)) app.collapsedGroups.delete(label);
	else app.collapsedGroups.add(label);
	storePreference("smolt.collapsed", [...app.collapsedGroups].join("\n"));
	bump();
}

// ---------------------------------------------------------------------------
// Model, effort, mode
// ---------------------------------------------------------------------------

/**
 * Apply a model or effort choice.
 *
 * A user's pick persists through the agent into the shared settings.json —
 * the same write the TUI's selector makes — so the desktop, the TUI, and the
 * next launch of either all agree on the default. Nothing is kept in
 * renderer storage except the "last used" ordering for the menu.
 */
export async function chooseModel(provider: string, id: string, remember = true): Promise<void> {
	await call("setModel", provider, id, remember);
	app.model = `${provider}/${id}`;
	if (remember) rememberRecentModel(app.model);
	app.availableThinking = (await call<string[]>("getAvailableThinkingLevels")) ?? [];
	await refreshState();
}

export async function chooseThinking(level: string, remember = true): Promise<void> {
	await call("setThinkingLevel", level, remember);
	app.thinking = level;
	bump();
}

/**
 * The effort a new chat starts at.
 *
 * Kept apart from the level in play: settings describe how the next chat
 * should begin, and changing that should not reach into a conversation
 * already under way.
 */
export function setDefaultThinking(level: string): void {
	app.defaultThinking = level;
	storePreference("smolt.defaultEffort", level);
	bump();
}

export async function ensureModels(): Promise<void> {
	if (app.availableModels.length === 0) {
		app.availableModels = (await call<ModelOption[]>("getAvailableModels")) ?? [];
		bump();
	}
}

export async function ensureThinkingLevels(): Promise<void> {
	if (app.availableThinking.length === 0) {
		app.availableThinking = (await call<string[]>("getAvailableThinkingLevels")) ?? [];
		bump();
	}
}

export async function ensureCommands(): Promise<void> {
	if (app.slashCommands.length === 0) {
		app.slashCommands = (await call<SlashCommand[]>("getCommands")) ?? [];
		bump();
	}
}

/** Models picked in this app, most recent first, for the menu's top section. */
export function recentModels(): string[] {
	try {
		const parsed: unknown = JSON.parse(storedPreference("smolt.recentModels", "[]"));
		if (Array.isArray(parsed)) return parsed.filter((entry): entry is string => typeof entry === "string");
	} catch {
		// A malformed list is no list.
	}
	return [];
}

function rememberRecentModel(label: string): void {
	const list = [label, ...recentModels().filter((entry) => entry !== label)].slice(0, 5);
	storePreference("smolt.recentModels", JSON.stringify(list));
}

/** The permission modes the agent actually enforces, in escalating caution. */
export const MODE_ITEMS: { id: string; label: string; hint: string; badge?: string }[] = [
	{ id: "auto", label: "Auto", hint: "Edit files and run commands without asking", badge: "Default" },
	{ id: "acceptEdits", label: "Accept edits", hint: "Apply file edits, ask before running commands" },
	{ id: "manual", label: "Manual", hint: "Ask before every edit and command" },
	{ id: "plan", label: "Plan", hint: "Investigate and propose, change nothing" },
	{ id: "bypass", label: "Bypass", hint: "Skip every check, including destructive commands" },
];

export function modeLabel(id: string): string {
	return MODE_ITEMS.find((item) => item.id === id)?.label ?? id;
}

export async function setPermissionMode(mode: string, remember = true): Promise<void> {
	const result = await api.permissionMode(mode);
	if (!result.ok) {
		toast(result.error ?? "Could not change the permission mode", "error");
		return;
	}
	app.permissionMode = String(result.value ?? mode);
	if (remember) storePreference("smolt.mode", app.permissionMode);
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

function readImageFile(file: File): Promise<Attachment | null> {
	return new Promise((resolve) => {
		if (!file.type.startsWith("image/")) return resolve(null);
		const reader = new FileReader();
		reader.onerror = () => resolve(null);
		reader.onload = () => {
			const url = String(reader.result ?? "");
			const comma = url.indexOf(",");
			if (comma < 0) return resolve(null);
			resolve({
				data: url.slice(comma + 1),
				mimeType: file.type,
				url,
				name: file.name || "pasted image",
			});
		};
		reader.readAsDataURL(file);
	});
}

export async function addImageFiles(files: Iterable<File>): Promise<void> {
	const added = await Promise.all([...files].map(readImageFile));
	const usable = added.filter((item): item is Attachment => item !== null);
	if (usable.length === 0) return;
	app.attachments = [...app.attachments, ...usable].slice(0, 8);
	bump();
}

export function removeAttachment(index: number): void {
	app.attachments = app.attachments.filter((_, i) => i !== index);
	bump();
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export async function answerApproval(answer: string): Promise<void> {
	const request = app.pendingApprovals.shift();
	if (!request) return;
	bump();
	const result = await api.permissionReply(request.id, answer);
	if (!result.ok) toast(result.error ?? "Could not send that decision", "error");
}

// ---------------------------------------------------------------------------
// Side chat
// ---------------------------------------------------------------------------

/**
 * Hand the side agent the main thread once, so it can answer questions about
 * the work in progress. Sent as context in the first message rather than
 * replayed as history, which would need the other agent's session format.
 */
function sideContext(): string {
	if (app.sideSeeded) return "";
	app.sideSeeded = true;
	const transcript = app.chat.messages
		.slice(-12)
		.map((message) => {
			const text = message.blocks
				.filter((block) => block.kind === "text")
				.map((block) => ("text" in block ? block.text : ""))
				.join("\n")
				.trim();
			return text === "" ? "" : `${message.role === "user" ? "User" : "Assistant"}: ${text}`;
		})
		.filter(Boolean)
		.join("\n\n");
	if (transcript === "") return "";
	return `Here is the conversation I am having in another thread, for context. Do not act on it unless I ask.\n\n<main_thread>\n${transcript}\n</main_thread>\n\nMy question: `;
}

export async function sendSideMessage(text: string): Promise<void> {
	const prefix = sideContext();
	const result = await api.sideCall("prompt", `${prefix}${text}`);
	app.sideError = result.ok ? null : (result.error ?? "Side chat unavailable");
	bump();
}

export async function resetSideChat(): Promise<void> {
	await api.sideStop();
	app.side.messages = [];
	app.sideSeeded = false;
	app.sideError = null;
	bump();
}

// ---------------------------------------------------------------------------
// Worktrees & session-wide actions
// ---------------------------------------------------------------------------

/** Restart the agent elsewhere and reload everything tied to its directory. */
export async function afterWorktreeChange(): Promise<void> {
	app.sessionRows = [];
	app.chat.messages = [];
	app.chat.usage = null;
	await refreshState();
	await loadMessages();
	const info = await api.worktrees();
	const value = (info.value ?? {}) as WorktreeInfo;
	app.appInfo = { ...app.appInfo, cwd: value.activeCwd ?? app.appInfo.cwd };
	bump();
}

export async function compactNow(): Promise<void> {
	await call("compact");
	await loadMessages();
	await refreshContextUsage();
}

/**
 * Rewind the conversation to just before one of its user messages, exactly as
 * the TUI's double-escape does: the agent forks the session at that entry and
 * hands the message text back, which lands in the composer for editing.
 *
 * The transcript's Nth user message is matched to the agent's forkable list
 * by position, verified (and if need be recovered) by text, since the two
 * views are assembled independently.
 */
export async function rewindToUserMessage(userIndex: number, currentText: string): Promise<void> {
	if (app.chat.streaming) {
		const sure = await requestConfirm({
			title: "Stop this turn?",
			message: "smolt is still working here. Rewinding stops the work in progress.",
			actionLabel: "Rewind and stop",
			destructive: true,
		});
		if (!sure) return;
	}
	const forkable = (await call<{ entryId: string; text: string }[]>("getForkMessages")) ?? [];
	// The window may start part-way down the chat; the agent counts from the top.
	let target = forkable[app.historyUserStart + userIndex];
	if (!target || (currentText !== "" && target.text !== currentText)) {
		target = forkable.filter((entry) => entry.text === currentText).at(-1) ?? target;
	}
	if (!target) {
		toast("Could not find that message to rewind to.", "error");
		return;
	}
	const result = await call<{ text: string; cancelled: boolean }>("fork", target.entryId);
	if (!result || result.cancelled) return;
	app.draft = result.text || currentText;
	await refreshState();
	await loadMessages();
	document.querySelector<HTMLTextAreaElement>("textarea")?.focus();
}

/** True once this chat has actually run tools — the only work that changes files. */
/**
 * Whether this chat has actually run a tool.
 *
 * Sticky, and not re-derived from the transcript: only a page of messages
 * is held at a time, so a tool call that has scrolled out of the window
 * would otherwise read as a chat that never touched anything.
 */
export function chatDidToolWork(): boolean {
	if (app.chatUsedTools) return true;
	const seen = app.chat.messages.some(
		(message) => message.role === "assistant" && message.blocks.some((block) => block.kind === "tool"),
	);
	if (seen) app.chatUsedTools = true;
	return seen;
}

// ---------------------------------------------------------------------------
// Appearance
// ---------------------------------------------------------------------------

const systemPrefersLight = window.matchMedia("(prefers-color-scheme: light)");

/**
 * Stamp the chosen theme on the root element.
 *
 * "System" is resolved here rather than left to a media query: the stylesheet
 * keeps a single definition per theme, and the native titlebar strip — which
 * no stylesheet can reach — needs the resolved answer anyway.
 */
export function applyTheme(choice: ThemeChoice): void {
	const resolved = choice === "system" ? (systemPrefersLight.matches ? "light" : "dark") : choice;
	document.documentElement.setAttribute("data-theme", resolved);
	app.themeChoice = choice;
	storePreference("smolt.theme", choice);
	void api.titlebar(resolved);
	bump();
}

systemPrefersLight.addEventListener("change", () => {
	if (storedPreference("smolt.theme", "system") === "system") applyTheme("system");
});

export function applySerif(on: boolean): void {
	document.documentElement.classList.toggle("serif-prose", on);
	app.serif = on;
	storePreference("smolt.serif", on ? "1" : "0");
	bump();
}

// ---------------------------------------------------------------------------
// Panes and surfaces
// ---------------------------------------------------------------------------

export function toggleSidebar(): void {
	app.sidebarHidden = !app.sidebarHidden;
	bump();
}

export function toggleSessionSearch(force?: boolean): void {
	const show = force ?? !app.sessionSearchOpen;
	if (show && app.sidebarHidden) toggleSidebar();
	app.sessionSearchOpen = show;
	if (!show) app.sessionQuery = "";
	bump();
}

export function toggleDiffPane(force?: boolean): void {
	app.diffOpen = force ?? !app.diffOpen;
	if (app.diffOpen) void refreshDiff();
	bump();
}

export function toggleSidePane(force?: boolean): void {
	app.sideOpen = force ?? !app.sideOpen;
	bump();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

export function projectName(): string {
	return app.appInfo.cwd.split(/[\\/]/).filter(Boolean).pop() ?? "";
}

async function applyRememberedSettings(): Promise<void> {
	const savedMode = storedPreference("smolt.mode", "");
	if (savedMode && savedMode !== app.permissionMode) await setPermissionMode(savedMode, false);
	// The context ring needs the current model's window size from the start,
	// not only after a menu has happened to fetch the model list.
	await ensureModels();
}

/** Tools whose finished call means a file on disk has just moved. */
const WRITING_TOOLS = new Set(["edit", "write", "bash", "powershell"]);

/** Whether this streamed event was a writing tool finishing. */
function wroteAFile(event: unknown): boolean {
	const raw = event as { type?: string; assistantMessageEvent?: { type?: string; toolCall?: { name?: unknown } } };
	if (raw.type !== "message_update") return false;
	const delta = raw.assistantMessageEvent;
	if (delta?.type !== "toolcall_end") return false;
	return WRITING_TOOLS.has(String(delta.toolCall?.name ?? ""));
}

/** The agent's live view of what it still has queued. */
/**
 * The most messages held while a turn is running.
 *
 * Loading a chat takes a page at a time, but a live turn appends without
 * limit: a long agentic run can produce hundreds of tool calls, and every one
 * stays in memory and in the DOM for the rest of the session. Well above a
 * page, so ordinary use never reaches it.
 */
const LIVE_MAX = 200;

/** Drop the oldest messages once a running turn has outgrown the window. */
function trimLiveTranscript(): void {
	const over = app.chat.messages.length - LIVE_MAX;
	if (over <= 0) return;
	const dropped = app.chat.messages.slice(0, over);
	app.chat.messages = app.chat.messages.slice(over);
	// The window has moved down the conversation, so what sits above it has
	// grown by the same amount — or scrolling up would fetch the wrong slice.
	app.historyStart += over;
	app.historyUserStart += dropped.filter((message) => message.role === "user").length;
}

interface QueueUpdate {
	steering?: string[];
	followUp?: string[];
}

export function boot(): void {
	for (const [key, target] of [
		["smolt.pinned", app.pinned],
		["smolt.archived", app.archived],
		["smolt.collapsed", app.collapsedGroups],
	] as const) {
		for (const value of storedPreference(key, "").split("\n")) {
			if (value.trim() !== "") target.add(value);
		}
	}
	applyTheme(storedPreference("smolt.theme", "system") as ThemeChoice);
	applySerif(storedPreference("smolt.serif", "0") === "1");

	const slotAware = typeof api.onAttached === "function" && typeof api.activeSlot === "function";
	api.onAttached?.((slot) => {
		app.attachedSlot = slot;
		bump();
	});
	void reattach();

	api.onEvent((event, slot) => {
		// Only the chat on screen. Anything else is a background turn, or the
		// tail of the one just left, and reducing it here is what used to leak
		// one conversation's words into another's transcript.
		if (slotAware && slot !== app.attachedSlot) return;
		const raw = event as { type?: string; id?: string; method?: string };
		if (raw.type === "extension_ui_request" && typeof raw.id === "string" && typeof raw.method === "string") {
			handleExtensionUiRequest(raw as Parameters<typeof handleExtensionUiRequest>[0]);
			return;
		}
		if (raw.type === "session_replaced") {
			// The agent switched sessions on its own (e.g. a Telegram message
			// opened its own chat): reset the transcript and follow it.
			app.chat = initialState();
			resetHistory(false);
			void refreshState();
			void loadMessages();
			bump();
			return;
		}
		// The first turn is what promotes a scratch chat into a stored one: the
		// agent writes its session file as the turn opens, so this is the moment
		// the sidebar can show it rather than waiting for the turn to finish.
		if (raw.type === "agent_start" && app.chat.messages.length === 0) void refreshSessionRows();
		// A finished write moves the working tree now, not when the turn ends.
		if (wroteAFile(event)) refreshDiffSoon();
		reduce(app.chat, event);
		trimLiveTranscript();
		syncRunStart();
		bump();
		const type = (event as { type?: string }).type;
		// The agent reports its own queue as it drains it, so the banner clears
		// when a message is actually delivered rather than when the turn ends.
		if (raw.type === "queue_update") {
			const live = new Set([...((raw as QueueUpdate).steering ?? []), ...((raw as QueueUpdate).followUp ?? [])]);
			const held = queuedHere();
			const remaining = held.filter((message) => live.has(message.text));
			if (remaining.length !== held.length) {
				if (remaining.length === 0) app.queuedBySession.delete(app.currentSessionPath);
				else app.queuedBySession.set(app.currentSessionPath, remaining);
				bump();
			}
		}
		if (raw.type === "agent_start") app.aborting = false;
		if (type === "agent_settled") {
			app.aborting = false;
			// Nothing can still be waiting once the run is over: a message the
			// agent never drained is one it will not read now.
			app.queuedBySession.delete(app.currentSessionPath);
			void refreshState();
			// The turn probably touched files, so refresh the diff either way:
			// the composer's repository bar reads it even when the pane is shut.
			void refreshDiff();
		}
	});

	api.onSideEvent((event) => {
		reduce(app.side, event);
		bump();
	});

	// Optional-called: during development the window can reload onto a newer
	// renderer than the preload it booted with, and a missing bridge method
	// must degrade to a missing feature, not a dead app.
	api.onBusySessions?.((paths) => {
		app.busySessions = new Set(paths.filter((path) => path !== ""));
		bump();
	});

	api.onBackgroundSettled?.(() => {
		// A chat finished while another was on screen; its title, preview and
		// dot in the sidebar all want refreshing.
		void refreshState();
	});

	let initialLoadDone = false;
	const initialLoad = async (): Promise<void> => {
		if (initialLoadDone) return;
		initialLoadDone = true;
		await refreshState();
		// The agent starts on its own defaults; put back what was chosen last.
		await applyRememberedSettings();
		const info = await api.info();
		app.canTranscribe = info.canTranscribe === true;
		app.appInfo = { cwd: info.cwd ?? "", version: info.version ?? "", hasProject: info.hasProject === true };
		await refreshRecentProjects();
		const mode = await api.permissionMode();
		if (mode.ok) app.permissionMode = String(mode.value ?? "auto");
		if (info.continueLatest && app.sessionRows.length > 0 && app.chat.messages.length === 0) {
			const result = await call<{ cancelled: boolean }>("switchSession", app.sessionRows[0]!.path);
			if (result && !result.cancelled) await refreshState();
		}
		await loadMessages();
		bump();
	};

	// The window menu lives in the main process; its items arrive as commands.
	api.onMenuCommand((command) => {
		if (command === "new-session") void newSession();
		else if (command === "open-folder") void pickProject();
		else if (command === "settings") {
			app.settingsOpen = true;
			bump();
		} else if (command === "shortcuts") {
			app.shortcutsOpen = true;
			bump();
		}
	});

	api.onStarted((status) => {
		reportAgentError(status.error);
		if (status.running) void initialLoad();
		bump();
	});

	// The agent may already be running before our listener registered.
	const pollStarted = setInterval(() => {
		if (initialLoadDone) {
			clearInterval(pollStarted);
			return;
		}
		void api.status().then((status) => {
			reportAgentError(status.error);
			if (status.running) void initialLoad();
			bump();
		});
	}, 300);

	// Anything that arrived before this listener existed.
	void api.pendingApprovals().then((waiting) => {
		for (const raw of waiting ?? []) {
			const request = raw as PermissionRequest;
			if (request?.id && !app.pendingApprovals.some((pending) => pending.id === request.id)) {
				app.pendingApprovals.push(request);
			}
		}
		bump();
	});
	api.onPermissionRequest((raw) => {
		const request = raw as PermissionRequest;
		if (!request?.id || app.pendingApprovals.some((pending) => pending.id === request.id)) return;
		app.pendingApprovals.push(request);
		bump();
	});
}
