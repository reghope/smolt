import { api, type SessionRow, type UpdateState } from "../lib/api.ts";
import { forgetPreference, storedPreference, storePreference } from "../lib/prefs.ts";
import {
	attachToolResult,
	type Block,
	type ChatMessage,
	fromAgentMessage,
	initialState,
	reduce,
	type UiState,
} from "../store.ts";
import { AUTO_THINKING_ENTRY } from "../thinking.ts";

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
	/** Development tooling; kept out of the user-facing palette. */
	internal?: boolean;
}

/** A live extension widget: display lines plus optional structured data behind them. */
export interface ExtensionWidget {
	lines: string[];
	/** Extension-shaped payload (e.g. battletest per-tester tickets/actions). */
	details?: unknown;
}

/** An extension dialog forwarded from the agent (extension_ui_request). */
export interface UiDialogRequest {
	id: string;
	method: "select" | "multiselect" | "confirm" | "input";
	title: string;
	message?: string;
	options?: string[];
	/** For multiselect: what is ticked when the dialog opens. */
	selected?: string[];
	placeholder?: string;
	/** The agent slot that asked, so the answer reaches that process. */
	slot?: number;
}

export interface PermissionRequest {
	id: string;
	tool: string;
	summary: string;
	mode: string;
	/** The chat slot whose agent asked; the card renders only in that chat. */
	slot?: number;
	/** That chat's session file, so the sidebar can mark the waiting row. */
	session?: string;
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

/** The bar's figures, as the main process totals them without rendering a body. */
export interface DiffStats {
	branch?: string;
	baseBranch?: string;
	hasCommits?: boolean;
	changed: number;
	added: number;
	removed: number;
	unavailable?: string;
}

/** The figures as one string, for telling whether anything has moved since. */
export function diffSignature(): string {
	return `${app.diffChanged}:${app.diffAdded}:${app.diffRemoved}`;
}

/** What the agent has written down for itself, for the home screen. */
export interface LearnedSummary {
	memoryEntries: number;
	latestMemory: string | null;
	latestIsProject: boolean;
	memoryPath: string;
	memoryUpdatedAt: number | null;
	skills: string[];
}

export interface UsageStats {
	learned: LearnedSummary;
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
	/** Images every request carries: what the context holds, and what is sent of it. */
	images?: { sent: number; held: number };
	/** Where the context goes, part by part; estimates scaled to `tokens`. */
	breakdown?: { parts: ContextPart[] };
}

export interface ContextPart {
	key: string;
	label: string;
	tokens: number;
	/** The named pieces of this part, largest first: each tool, each context file. */
	items?: { name: string; tokens: number; source?: string }[];
}

/** Spend on the chat's behalf outside its own requests: a research team, an advisor. */
export interface BackgroundSpend {
	key: string;
	label: string;
	tokens: number;
	cost: number;
	requests: number;
}

/** One allowance window of a subscription provider, as the provider reports it. */
export interface ProviderUsageWindow {
	key: string;
	label: string;
	status: string;
	/** 0-100, how much of the allowance is consumed. */
	percent: number;
	/** ISO timestamp when the window resets, when the provider says. */
	resetsAt?: string;
	/** A prepaid balance rather than a window: no reset, and the detail carries the amount. */
	kind?: "balance";
	/** A short human figure beside the percent, e.g. "$9.97 of $10.00 left". */
	detail?: string;
}

/** Subscription usage for the active provider; absent fields mean no measurable drain yet. */
export interface ProviderUsageSnapshot {
	providerId: string;
	providerName: string;
	windows: ProviderUsageWindow[];
	fetchedAt: number;
	bindingWindow?: string;
	hoursLeft?: number;
	rateSampleMinutes?: number;
	accounts?: ProviderUsageAccount[];
	/** Every other configured provider that reports usage. */
	others?: ProviderUsageSnapshot[];
	/** The last good reading, kept while the endpoint is not answering. */
	stale?: boolean;
}

/** One pool credential's own usage. */
export interface ProviderUsageAccount {
	label: string;
	windows: ProviderUsageWindow[];
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

/** An in-app single-line prompt, in place of the operating system's dialog. */
export interface InputRequest {
	title: string;
	message?: string;
	placeholder?: string;
	initial: string;
	resolve: (value: string | null) => void;
}

interface AppState {
	chat: UiState;
	side: UiState;
	model: string;
	thinking: string;
	/** The effort new chats start at; the composer changes only this chat. */
	defaultThinking: string;
	/** Sidebar days list every chat instead of folding past the latest five. */
	sidebarShowAll: boolean;
	/** Chat markers render as dot bullets instead of asterisks. */
	sidebarDots: boolean;
	/** Spelling/dialect for user-facing labels: "us" (default) or "uk". */
	language: "us" | "uk";
	sessionRows: SessionRow[];
	/** False until the first read of the chat list lands; the sidebar spins until then. */
	sessionsLoaded: boolean;
	/** True while the chat on screen has no session file yet (nothing sent). */
	scratchChat: boolean;
	/** True while the chat on screen is temporary: in-memory, nothing saved or remembered. */
	temporaryChat: boolean;
	currentSessionPath: string;
	sessionName: string;
	attachments: Attachment[];
	availableModels: ModelOption[];
	availableThinking: string[];
	slashCommands: SlashCommand[];
	autoCompaction: boolean;
	autoRetry: boolean;
	deliverAllQueued: boolean;
	permissionMode: string;
	runStartedAt: number;
	appInfo: { cwd: string; version: string; hasProject: boolean; packaged: boolean };
	appInfoLoaded: boolean;
	/** Folders worked in before, newest first, for the folder switcher. */
	recentProjects: string[];
	/** Folders open now, the working directory first. */
	folders: string[];
	/** The add-a-provider-instance dialog. */
	providerDialogOpen: boolean;
	/** The provider the dialog should start on, when opened from that provider's row. */
	providerDialogPreset: string | null;
	/** Chats picked out for a bulk action, by session path. */
	selectedSessions: Set<string>;
	/** How often each slash command has been run, for palette ordering. */
	commandUse: Record<string, number>;
	modelUse: Record<string, number>;
	repoBranch: string;
	contextUsage: ContextUsage | null;
	/** What else is spending on this chat, from the session's stats. */
	backgroundSpend: BackgroundSpend[];
	providerUsage: ProviderUsageSnapshot | null;
	diffFiles: DiffFile[];
	preexistingChanges: number;
	/** Files, lines added and lines removed across the whole branch: the bar's figures. */
	diffChanged: number;
	diffAdded: number;
	diffRemoved: number;
	/** Untracked files counted in the figures but left off the pane's list. */
	diffUnlisted: number;
	/** The branch the current one is measured against; empty on the default branch. */
	repoBaseBranch: string;
	/** The branch carries commits of its own, so a pull request would hold something. */
	repoHasCommits: boolean;
	/** Why the diff pane cannot read the tree (e.g. not a git repository), or "" when it can. */
	diffUnavailable: string;
	/** The figures as they stood when the repo bar's × was clicked, or null when not dismissed. */
	repoBarDismissed: string | null;
	/** Messages waiting on a turn, per chat: a queue belongs to its own conversation. */
	queuedBySession: Map<string, QueuedMessage[]>;
	/** True while Send now is mid-flight, so the button can refuse a double-click. */
	sendingQueuedNow: boolean;
	/** A Send now that has been handed to the agent and is waiting on the next
	    tool boundary. The banner stays up, saying so, until the agent drains it. */
	flushingQueued: { path: string; count: number; text: string; label: string; seen: boolean } | null;
	/** A model picked mid-turn, applied with the next user message. */
	pendingModel: { provider: string; id: string; remember: boolean } | null;
	/** Render the model's reasoning in the transcript. Toggled by clicking the working line. */
	showThinking: boolean;
	/** Enter queues and Ctrl+Enter sends now, rather than the other way round. */
	enterSendsQueued: boolean;
	/**
	 * Live status lines pushed by extensions (battletest tester roster, subagent
	 * threads), keyed per agent slot so one chat's run never renders in another.
	 */
	extensionWidgets: Map<number, Map<string, ExtensionWidget>>;
	/** Floating transient cards, newest last. */
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
	/** A read has confirmed this chat has nothing in it. Unconfirmed (false) is
	    what a chat mid-switch reads as, so the empty state cannot flash over a
	    transcript that is still on its way. */
	chatEmpty: boolean;
	/** This chat has run a tool, remembered past the end of the rendered page. */
	chatUsedTools: boolean;
	/** The agent whose events the window is currently reducing; null mid-switch. */
	attachedSlot: number | null;
	pendingApprovals: PermissionRequest[];
	uiRequests: UiDialogRequest[];
	/** True when the active agent died and was replaced, until the next message. */
	agentLost: boolean;
	confirm: ConfirmRequest | null;
	/** A pending in-app prompt (rename chat, name a worktree). */
	inputRequest: InputRequest | null;
	stats: UsageStats | null;
	statsLoaded: boolean;
	statsTab: "overview" | "models" | "rhythm";
	statsWindow: number;
	/** Prompt suggestions for the empty new-chat screen; empty until loaded. */
	starters: Starter[];
	/** True once the suggestion call has settled (success or failure). */
	startersLoaded: boolean;
	sideSeeded: boolean;
	sideError: string | null;
	// UI surfaces the keyboard shortcuts also need to reach.
	sidebarHidden: boolean;
	sessionSearchOpen: boolean;
	sessionQuery: string;
	diffOpen: boolean;
	sideOpen: boolean;
	settingsOpen: boolean;
	/** The settings page to land on next time the dialog opens; cleared once read. */
	settingsSection: string | null;
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
	/** Live smoothed microphone level (0..1, relative to the speech threshold); drives the waveform. */
	voiceLevel: number;
	micDeviceId: string;
	/** The device that recorded nothing, so the mic button can say which. */
	voiceSilent: string;
	/** Why the last dictation attempt failed, so the mic button can say why. */
	voiceError: string;
	/** A stop has been asked for and not yet taken effect. */
	aborting: boolean;
	/** What the updater is doing, shared by the footer notice and settings. */
	update: UpdateState;
	/** A check the reader asked for is still running. */
	updateChecking: boolean;
	/** A check has been made this session, so "nothing new" can be said. */
	updateChecked: boolean;
	holdToRecord: boolean;
	/** Composer text lives here so dictation and history can write it. */
	draft: string;
	busySessions: Set<string>;
	/** Chats whose turn finished while the reader was elsewhere; steady green
	 * in the sidebar until the chat is opened. */
	finishedUnseen: Set<string>;
	pinned: Set<string>;
	archived: Set<string>;
	collapsedGroups: Set<string>;
}

export const app: AppState = {
	chat: initialState(),
	side: initialState(),
	model: "",
	thinking: "",
	defaultThinking: storedPreference("smolt.defaultEffort", AUTO_THINKING_ENTRY),
	sidebarShowAll: storedPreference("smolt.sidebarShowAll", "0") === "1",
	sidebarDots: storedPreference("smolt.sidebarDots", "0") === "1",
	language: storedPreference("smolt.language", "us") === "uk" ? "uk" : "us",
	enterSendsQueued: storedPreference("smolt.enterSendsQueued", "0") === "1",
	sessionRows: [],
	sessionsLoaded: false,
	scratchChat: true,
	temporaryChat: false,
	currentSessionPath: "",
	sessionName: "",
	attachments: [],
	availableModels: [],
	availableThinking: [],
	slashCommands: [],
	autoCompaction: true,
	autoRetry: true,
	deliverAllQueued: false,
	permissionMode: "auto",
	runStartedAt: 0,
	appInfo: { cwd: "", version: "", hasProject: false, packaged: false },
	appInfoLoaded: false,
	recentProjects: [],
	folders: [],
	providerDialogOpen: false,
	providerDialogPreset: null,
	selectedSessions: new Set<string>(),
	commandUse: readCommandUse(),
	modelUse: readTally("smolt.modelUse"),
	repoBranch: "",
	contextUsage: null,
	backgroundSpend: [],
	providerUsage: null,
	diffFiles: [],
	preexistingChanges: 0,
	diffChanged: 0,
	diffAdded: 0,
	diffRemoved: 0,
	diffUnlisted: 0,
	repoBaseBranch: "",
	repoHasCommits: false,
	diffUnavailable: "",
	repoBarDismissed: null,
	queuedBySession: new Map(),
	sendingQueuedNow: false,
	flushingQueued: null,
	pendingModel: null,
	showThinking: readShowThinking(),
	extensionWidgets: new Map(),
	historyStart: 0,
	historyUserStart: 0,
	historySource: "disk",
	historyLoading: false,
	chatLoading: false,
	chatEmpty: true,
	chatUsedTools: false,
	attachedSlot: null,
	pendingApprovals: [],
	uiRequests: [],
	agentLost: false,
	confirm: null,
	inputRequest: null,
	stats: null,
	statsLoaded: false,
	starters: [],
	startersLoaded: false,
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
	settingsSection: null,
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
	voiceLevel: 0,
	micDeviceId: "",
	voiceSilent: "",
	voiceError: "",
	aborting: false,
	update: { status: "idle" },
	updateChecking: false,
	updateChecked: false,
	holdToRecord: false,
	draft: "",
	busySessions: new Set<string>(),
	finishedUnseen: new Set<string>(),
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
	draftVersion += 1;
	for (const listener of listeners) listener();
	for (const listener of draftListeners) listener();
}

/** How often streaming deltas are allowed to repaint the app. */
const STREAM_PAINT_MS = 150;
let bumpTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Coalesced bump for high-frequency events: the first call paints on a short
 * timer and the calls that pile up behind it ride along. Anything urgent can
 * still call bump() directly and the pending timer becomes a no-op repaint.
 */
/** Open settings, on a given page when one is named. */
export function openSettings(section?: string): void {
	app.settingsSection = section ?? null;
	app.settingsOpen = true;
	bump();
}

export function bumpSoon(): void {
	if (bumpTimer !== null) return;
	bumpTimer = setTimeout(() => {
		bumpTimer = null;
		bump();
	}, STREAM_PAINT_MS);
}

/**
 * A second channel, for the composer's own text.
 *
 * Every keystroke used to wake every subscriber, which meant re-rendering
 * the whole transcript to add one character: measured at 35ms a keystroke
 * on a long chat, and 83ms at worst — plainly late. Nothing outside the
 * composer reads the draft, so typing notifies only the composer.
 */
const draftListeners = new Set<() => void>();
let draftVersion = 0;

export function subscribeDraft(listener: () => void): () => void {
	draftListeners.add(listener);
	return () => draftListeners.delete(listener);
}

export function getDraftVersion(): number {
	return draftVersion;
}

/** The draft changed and nothing else did. */
export function bumpDraft(): void {
	draftVersion += 1;
	rememberDraft();
	for (const listener of draftListeners) listener();
}

// ---------------------------------------------------------------------------
// Unsent words
// ---------------------------------------------------------------------------

/**
 * What was left in each chat's composer, by chat.
 *
 * A half-written message is work. Switching chats to check something used to
 * throw it away, and so did closing the app, so the box was only safe to type
 * in if you finished in one sitting. Each chat keeps its own, on disk, and
 * gets it back when it is opened again - whether that is a moment later or
 * after the machine has died.
 *
 * Keyed by session path. A chat with no path yet is a fresh one, and its words
 * are held under "" until the first message gives it a file of its own; New
 * clears that entry, because a new chat starts empty by definition.
 */
const drafts = new Map<string, string>();

const DRAFTS_KEY = "smolt.drafts";
/** Chats whose unsent words are kept. Beyond this the least recent goes. */
const DRAFTS_LIMIT = 40;
/** Per chat, so one pasted wall of text cannot fill the whole store. */
const DRAFT_MAX_CHARS = 20000;

function readDrafts(): void {
	try {
		const parsed: unknown = JSON.parse(storedPreference(DRAFTS_KEY, "{}"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
		for (const [path, text] of Object.entries(parsed as Record<string, unknown>)) {
			if (typeof text === "string" && text !== "") drafts.set(path, text.slice(0, DRAFT_MAX_CHARS));
		}
	} catch {
		// A corrupt store is not worth refusing to start over.
	}
}

readDrafts();

/**
 * Write the drafts out, a beat after the typing stops.
 *
 * Every keystroke would mean a JSON serialisation and a synchronous
 * localStorage write on the path that was already measured as the slowest
 * thing in the app. A second's delay costs nothing that matters: the words
 * are already in memory, and the transitions that lose them - switching,
 * New, quitting - all flush first.
 */
let draftsTimer: ReturnType<typeof setTimeout> | null = null;

function flushDrafts(): void {
	if (draftsTimer !== null) {
		clearTimeout(draftsTimer);
		draftsTimer = null;
	}
	// Insertion order is recency, because a rewrite deletes before it sets.
	while (drafts.size > DRAFTS_LIMIT) {
		const oldest = drafts.keys().next().value;
		if (oldest === undefined) break;
		drafts.delete(oldest);
	}
	storePreference(DRAFTS_KEY, JSON.stringify(Object.fromEntries(drafts)));
}

function scheduleDraftFlush(): void {
	if (draftsTimer !== null) clearTimeout(draftsTimer);
	draftsTimer = setTimeout(flushDrafts, 1000);
}

/** Keep what is in the box now against the chat it belongs to. */
function rememberDraft(): void {
	const text = app.draft;
	const path = app.currentSessionPath;
	// Rewritten rather than updated in place, so insertion order stays recency.
	drafts.delete(path);
	if (text.trim() !== "") drafts.set(path, text.slice(0, DRAFT_MAX_CHARS));
	scheduleDraftFlush();
}

/** The words this chat was left with, if any. */
function draftFor(path: string): string {
	return drafts.get(path) ?? "";
}

/** This chat is gone, and so are the words that were waiting in it. */
function forgetDraft(path: string): void {
	if (!drafts.delete(path)) return;
	scheduleDraftFlush();
}

/**
 * Put the composer's words away before the chat under them changes.
 *
 * Called on the paths that move the view rather than left to the debounce:
 * a switch is exactly when the last second of typing would otherwise be
 * attributed to the chat being opened.
 */
function stashDraft(): void {
	rememberDraft();
	flushDrafts();
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

/** Show a transient floating card that dismisses itself; errors linger longer. */
/**
 * Where the window's own remarks go, which is nowhere the reader can see.
 *
 * Toasts are gone: this app is a conversation with the agent, and a box
 * floating over the corner for a few seconds is the harness talking over it.
 * Everything a reader should hear about a chat comes from the agent, in the
 * agent's words.
 *
 * The funnel is deliberately kept rather than deleted at all fifty-odd call
 * sites. Two reasons: the console still carries the text, so a failed action
 * is not lost to whoever is debugging it; and when these remarks are given a
 * real home - handed to the agent to say, the way a command's outcome already
 * is - this is the single place that has to change, not fifty.
 *
 * Callers that only ever announced success are the ones worth deleting
 * outright; the failures are the ones worth re-pointing.
 */
export function toast(message: string, tone: "default" | "error" = "default"): void {
	if (message.trim() === "") return;
	if (tone === "error") console.error(message);
	else console.info(message);
}

/** The reasoning toggle survives restarts: a preference, not a session whim. */
function readShowThinking(): boolean {
	try {
		return localStorage.getItem("smolt-show-thinking") === "true";
	} catch {
		return false;
	}
}

export function toggleShowThinking(options?: { quiet?: boolean }): void {
	app.showThinking = !app.showThinking;
	try {
		localStorage.setItem("smolt-show-thinking", String(app.showThinking));
	} catch {
		// Preference just won't survive the restart.
	}
	// A brief confirmation, not a standing badge: the thinking text itself is
	// the visible state once it renders. The working line says it in place
	// and asks for quiet; the keyboard shortcut has nowhere else to say it.
	if (!options?.quiet) toast(app.showThinking ? "Showing thoughts" : "Hiding thoughts");
	bump();
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

/**
 * Ask the user to type one line, in an in-app dialog — never through
 * window.prompt, which Electron does not implement: it throws, and every
 * flow that relied on it (renaming a chat, naming a worktree) silently
 * did nothing.
 */
export function requestInput(options: {
	title: string;
	message?: string;
	placeholder?: string;
	initial?: string;
}): Promise<string | null> {
	return new Promise((resolve) => {
		// A second request while one is open orphans the first answer, as
		// with confirmations: cancel the older one and move on.
		app.inputRequest?.resolve(null);
		app.inputRequest = {
			title: options.title,
			message: options.message,
			placeholder: options.placeholder,
			initial: options.initial ?? "",
			resolve,
		};
		bump();
	});
}

export function resolveInput(value: string | null): void {
	const pending = app.inputRequest;
	if (!pending) return;
	app.inputRequest = null;
	bump();
	pending.resolve(value);
}

/** Answer one extension dialog and remove it from the queue. */
export function answerUiRequest(response: {
	id: string;
	value?: string;
	values?: string[];
	confirmed?: boolean;
	cancelled?: boolean;
}): void {
	// The answer names the slot that asked: sent to whichever agent happens to
	// be active instead, it lands on an unknown id and the asker waits out its
	// whole timeout for a click that already happened.
	const slotId = app.uiRequests.find((request) => request.id === response.id)?.slot;
	app.uiRequests = app.uiRequests.filter((request) => request.id !== response.id);
	bump();
	void call("respondExtensionUI", { ...response, slotId });
}

function handleExtensionUiRequest(
	request: {
		id: string;
		method: string;
		title?: string;
		message?: string;
		options?: string[];
		selected?: string[];
		placeholder?: string;
		notifyType?: string;
	},
	slot?: number,
): void {
	switch (request.method) {
		case "select":
		case "multiselect":
		case "confirm":
		case "input":
			app.uiRequests.push({
				id: request.id,
				method: request.method,
				title: request.title ?? "",
				message: request.message,
				options: request.options,
				selected: request.selected,
				placeholder: request.placeholder,
				slot,
			});
			bump();
			return;
		case "editor":
			// No extension editor surface here; cancel so the extension isn't stuck.
			void call("respondExtensionUI", { id: request.id, cancelled: true, slotId: slot });
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
function readTally(key: string): Record<string, number> {
	try {
		const parsed: unknown = JSON.parse(storedPreference(key, "{}"));
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

function readCommandUse(): Record<string, number> {
	return readTally("smolt.commandUse");
}

/** Count one run of a command, so the palette can lead with the popular ones. */
export function noteCommandUse(name: string): void {
	if (name === "") return;
	app.commandUse = { ...app.commandUse, [name]: (app.commandUse[name] ?? 0) + 1 };
	storePreference("smolt.commandUse", JSON.stringify(app.commandUse));
}

/** Count one pick of a model, so settings can lead with the ones in use. */
export function noteModelUse(provider: string, id: string): void {
	if (provider === "" || id === "") return;
	const key = `${provider}/${id}`;
	app.modelUse = { ...app.modelUse, [key]: (app.modelUse[key] ?? 0) + 1 };
	storePreference("smolt.modelUse", JSON.stringify(app.modelUse));
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
	app.sessionsLoaded = true;
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

/**
 * `owned` marks the read a switch makes for itself: it may adopt the agent's
 * chat even though its own switch is still counted as in flight.
 */
export async function refreshState(options: { owned?: boolean } = {}): Promise<void> {
	const generation = switchGeneration;
	const rpcState = await call<Record<string, unknown>>("getState");
	if (rpcState) {
		const m = rpcState.model as Record<string, unknown> | undefined;
		app.model = m ? `${m.provider ?? ""}/${m.id ?? ""}`.replace(/^\//, "") : String(rpcState.modelId ?? "");
		// An engaged extension entry ("auto") is what the user picked; the
		// concrete level underneath it changes per task and would misread.
		app.thinking = String(rpcState.activeThinkingEntry ?? rpcState.thinkingLevel ?? "");
		// The concrete level seeds the per-message stamp shown next to thinking
		// text; live changes then arrive as thinking_level_changed events.
		app.chat.currentThinking = String(rpcState.thinkingLevel ?? "");
		const path = String(rpcState.sessionFile ?? "");
		// A chat's first turn is where its file appears, so anything queued
		// before then was filed under the empty path; move it with the chat
		// rather than stranding it under a key nothing reads again.
		const early = app.queuedBySession.get("");
		if (early && path !== "" && app.currentSessionPath === "") {
			app.queuedBySession.delete("");
			app.queuedBySession.set(path, early);
		}
		// A switch part-way through owns the window. The agent's move takes about
		// a second, so a state read taken across it answers with the chat just
		// left — which is what snapped the sidebar back a row while the reader
		// was still going down the list.
		if (switchGeneration === generation && (options.owned === true || switchesInFlight === 0)) {
			app.currentSessionPath = path;
			app.scratchChat = path === "";
			// A pathless chat is temporary until something real takes the view:
			// the flag survives refreshes of the temporary chat itself and
			// clears the moment an actual session is opened.
			app.temporaryChat = path === "" && app.temporaryChat;
			app.sessionName = String(rpcState.sessionName ?? "");
		}
		app.autoCompaction = rpcState.autoCompactionEnabled !== false;
		app.deliverAllQueued = rpcState.steeringMode === "all";
		// The view may have just landed on an agent mid-turn; mirror its truth.
		app.chat.streaming = rpcState.isStreaming === true;
		syncRunStart();
	}
	app.sessionRows = (await api.sessions()) ?? [];
	app.sessionsLoaded = true;
	void refreshStats();
	void refreshDiff();
	void refreshContextUsage();
	void refreshProviderUsage();
	void refreshStarters();
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

/**
 * Re-read the pane's list when it becomes visible.
 *
 * The pane's file list is only refreshed while it is open, so a pane opened
 * after files changed elsewhere (or dragged open, which previews before
 * `diffOpen` is set) showed whatever the last open had left behind. Throttled
 * on the same clock as `refreshDiffSoon`: opening the pane costs at most one
 * git read per interval, not one per render.
 */
let diffPaneRefreshAt = 0;
let diffPaneRefreshTimer: ReturnType<typeof setTimeout> | null = null;

export function refreshDiffPaneSoon(): void {
	if (diffPaneRefreshTimer !== null) return;
	const wait = Math.max(0, diffPaneRefreshAt + DIFF_REFRESH_MS - Date.now());
	diffPaneRefreshTimer = setTimeout(() => {
		diffPaneRefreshTimer = null;
		diffPaneRefreshAt = Date.now();
		void (async () => {
			await refreshDiff();
			// An open pane already had its files re-read inside refreshDiff.
			if (!app.diffOpen) await refreshDiffFiles();
		})();
	}, wait);
}

export async function refreshContextUsage(): Promise<void> {
	const stats = await call<{ contextUsage?: ContextUsage; background?: BackgroundSpend[] }>("getSessionStats");
	app.contextUsage = stats?.contextUsage ?? null;
	app.backgroundSpend = stats?.background ?? [];
	bump();
}

/**
 * The context figure moves with every request and every tool result, and
 * the spend beside it lands whenever a background reviewer finishes, so the
 * popover took one snapshot on opening and then sat on it. Now a message or
 * tool boundary asks for a fresh one, throttled to one read a couple of
 * seconds: a turn of forty tool calls costs a handful of reads, not forty.
 */
const CONTEXT_REFRESH_MS = 2000;
let contextRefreshAt = 0;
let contextRefreshTimer: ReturnType<typeof setTimeout> | null = null;

export function refreshContextUsageSoon(): void {
	if (contextRefreshTimer !== null) return;
	const wait = Math.max(0, contextRefreshAt + CONTEXT_REFRESH_MS - Date.now());
	contextRefreshTimer = setTimeout(() => {
		contextRefreshTimer = null;
		contextRefreshAt = Date.now();
		void refreshContextUsage();
	}, wait);
}

/**
 * Subscription usage, polled live. The agent keeps its own history of
 * polls, so the drain-rate projection sharpens the longer the app runs.
 */
export async function refreshProviderUsage(): Promise<void> {
	app.providerUsage = await call<ProviderUsageSnapshot | null>("getProviderUsage");
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
	const mapped = toChatMessages(messages.slice(start));
	app.chatEmpty = mapped.length === 0;
	app.chat.messages = mapped;
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
	if (result.ok) app.stats = result.value as UsageStats;
	// Loaded even on failure: the empty chat holds its lower sections back
	// until this settles, and an error must not hold them back forever.
	app.statsLoaded = true;
	bump();
}

/** One-click prompt suggestion for the empty new-chat screen. */
export interface Starter {
	label: string;
	meta: string;
}

/**
 * Fill the starters card. Fire-and-forget: the model call behind it can take
 * tens of seconds, so the screen shows skeletons until this lands.
 */
export async function refreshStarters(): Promise<void> {
	const result = await api.starters();
	app.starters = result.ok ? ((result.value ?? []) as Starter[]) : [];
	app.startersLoaded = true;
	bump();
}

/** Put a suggestion into the composer for the user to edit and send. */
export function applyStarter(label: string): void {
	app.draft = label;
	bumpDraft();
	bump();
}

/** Where the last figures read for the current directory are kept, per directory. */
function diffStatsKey(): string {
	return `smolt.diffStats:${app.appInfo.cwd}`;
}

function applyDiffStats(stats: DiffStats): void {
	app.repoBranch = stats.branch ?? "";
	app.repoBaseBranch = stats.baseBranch ?? "";
	app.repoHasCommits = stats.hasCommits === true;
	// A folder with no git says so itself: a zero here would read as "this
	// branch changed nothing", which is a lie the moment the agent has edited
	// a file the pane cannot diff.
	app.diffUnavailable = stats.unavailable ?? "";
	app.diffChanged = stats.changed;
	app.diffAdded = stats.added;
	app.diffRemoved = stats.removed;
	// The × holds until the figures move. On a branch a commit moves nothing,
	// since the scope is the branch, so only real change brings the bar back.
	if (app.repoBarDismissed !== null && app.repoBarDismissed !== diffSignature()) app.repoBarDismissed = null;
}

/**
 * Put up the figures from last time for this directory, while git answers.
 *
 * Nothing known yet is the only time this acts, so the bar is there the
 * moment the window is rather than after the session list, the agent's
 * state and a git read have all come back. The read that follows corrects
 * the figures within a moment.
 */
export function hydrateDiffStats(cwd: string = app.appInfo.cwd): void {
	if (app.diffChanged !== 0 || app.diffUnavailable !== "" || cwd === "") return;
	try {
		const cached = JSON.parse(storedPreference(`smolt.diffStats:${cwd}`, "null")) as DiffStats | null;
		if (cached && typeof cached.changed === "number" && cached.changed > 0) {
			applyDiffStats(cached);
			bump();
		}
	} catch {
		// A bad cache entry is not worth a blank bar; the real read is coming.
	}
}

/**
 * Re-read the branch's figures, and the pane's file list if it is open.
 *
 * The figures come first and alone: they are what the bar shows on every
 * refresh, and git can total them without producing a single hunk. The
 * bodies are read only for a pane someone is looking at.
 */
export async function refreshDiff(): Promise<void> {
	hydrateDiffStats();
	const result = await api.diffStats();
	if (!result.ok) {
		// Keep the last good answer. Wiping the figures on a failed read made a
		// momentary error look like the change had been undone: the bar
		// vanished and the panel emptied, with nothing to say why.
		reportAgentError(result.error ?? "Could not read the working tree");
		return;
	}
	const stats = (result.value ?? {}) as Partial<DiffStats>;
	applyDiffStats({ ...stats, changed: stats.changed ?? 0, added: stats.added ?? 0, removed: stats.removed ?? 0 });
	if (app.diffUnavailable === "" && app.appInfo.cwd !== "") storePreference(diffStatsKey(), JSON.stringify(stats));
	bump();
	if (app.diffOpen) await refreshDiffFiles();
}

/** The pane's list, with bodies: read only while the pane is open. */
async function refreshDiffFiles(): Promise<void> {
	const result = await api.diff();
	if (!result.ok) {
		reportAgentError(result.error ?? "Could not read the working tree");
		return;
	}
	const { files, unlisted, preexisting } = (result.value ?? {}) as {
		files?: DiffFile[];
		unlisted?: number;
		preexisting?: number;
	};
	app.preexistingChanges = preexisting ?? 0;
	app.diffFiles = files ?? [];
	app.diffUnlisted = unlisted ?? 0;
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
	// Stop means stop: the agent drops everything queued behind the turn, so
	// the reader's own queued messages come back to the composer rather than
	// vanishing. (Attached images do not survive the trip.)
	const held = app.queuedBySession.get(app.currentSessionPath) ?? [];
	if (held.length > 0) {
		app.queuedBySession.delete(app.currentSessionPath);
		if (app.flushingQueued?.path === app.currentSessionPath) app.flushingQueued = null;
		app.draft = [held.map((message) => message.text).join("\n\n"), app.draft]
			.filter((text) => text.trim() !== "")
			.join("\n\n");
	}
	bump();
	await call("abort");
}

/**
 * Look for a new build now, because the reader asked.
 *
 * The app checks on its own every few hours; this is for the moment
 * somebody wants to know rather than wait. It always settles into a
 * definite answer, so an unchanged status still reads as "nothing new".
 */
export async function checkForUpdate(): Promise<void> {
	if (app.updateChecking) return;
	app.updateChecking = true;
	bump();
	try {
		await api.updateCheck();
	} finally {
		// The feed answers quickly; anything still moving reports itself
		// through the state events above.
		app.updateChecking = false;
		app.updateChecked = true;
		bump();
	}
}

/** Restart into the build that has been fetched. */
export async function installUpdate(): Promise<void> {
	await api.updateInstall();
}

const HISTORY_LIMIT = 50;

/**
 * Prompts already sent, newest last; Up/Down walk this like a shell history.
 *
 * Kept in localStorage rather than in the session, because it belongs to the
 * person and not to one chat: what you typed an hour ago in another chat is
 * exactly what Up is for, and closing the app should not forget it.
 */
function readPromptHistory(): string[] {
	try {
		const parsed: unknown = JSON.parse(storedPreference("smolt.promptHistory", "[]"));
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((entry): entry is string => typeof entry === "string").slice(-HISTORY_LIMIT);
	} catch {
		return [];
	}
}

export const promptHistory: string[] = readPromptHistory();

/**
 * What Enter does to a message typed while a turn is running.
 *
 * "now" steers it in at the next tool boundary; "queue" holds it until the
 * turn finishes. Ctrl+Enter always does the other one, so both are always
 * one keystroke away and the setting only decides which is unmodified.
 */
export type SendMode = "now" | "queue";

/** The mode plain Enter uses; Ctrl+Enter takes the other. */
export function enterSendMode(): SendMode {
	return app.enterSendsQueued ? "queue" : "now";
}

export function setEnterSendsQueued(on: boolean): void {
	app.enterSendsQueued = on;
	storePreference("smolt.enterSendsQueued", on ? "1" : "0");
	bump();
}

/**
 * Draw what was just typed, now, without waiting to be told it arrived.
 *
 * The agent echoes every message back as an event, and until this the window
 * drew nothing until that event landed - a round-trip through a subprocess
 * that is busy doing something else, which on a working agent is seconds of
 * the composer looking as though it ate the words. The stand-in is marked, so
 * the agent's own copy takes its place rather than doubling it.
 *
 * Returns the message, so a send that never left can take it back out again.
 */
/** What the agent writes in place of empty text on an image-only message. */
const IMAGE_ONLY_TEXT = "The user has provided an image with this message";

function echoSentMessage(text: string, images: { data: string; mimeType: string }[]): ChatMessage {
	const blocks: Block[] = [];
	// An image sent without words comes back from the agent with this line
	// on it. The stand-in must carry the same line, or the agent copy never
	// matches it and the image sits in the chat twice: once bare, once with.
	const shown = text === "" && images.length > 0 ? IMAGE_ONLY_TEXT : text;
	if (shown !== "") blocks.push({ kind: "text", text: shown });
	for (const image of images) blocks.push({ kind: "image", data: image.data, mimeType: image.mimeType });
	const message: ChatMessage = { role: "user", blocks, at: Date.now(), pendingEcho: true };
	app.chat.messages.push(message);
	bump();
	return message;
}

/** The send never left: take the stand-in back out. */
function unechoSentMessage(message: ChatMessage): void {
	const index = app.chat.messages.indexOf(message);
	if (index >= 0) app.chat.messages.splice(index, 1);
}

export async function send(mode: SendMode = enterSendMode()): Promise<void> {
	const text = app.draft.trim();
	const images = app.attachments.map(({ data, mimeType }) => ({ type: "image" as const, data, mimeType }));
	if (text === "" && images.length === 0) return;
	// A model picked mid-turn lands now, with the message that starts using it.
	await applyPendingModel();
	app.draft = "";
	// The banner about a replaced agent is answered by carrying on: a message
	// that goes through is proof the app is whole again.
	app.agentLost = false;
	if (text !== "") {
		// A repeat of the last entry would only pad the history it walks.
		if (promptHistory[promptHistory.length - 1] !== text) promptHistory.push(text);
		if (promptHistory.length > HISTORY_LIMIT) promptHistory.shift();
		storePreference("smolt.promptHistory", JSON.stringify(promptHistory));
	}
	app.attachments = [];
	// Sent, so there is nothing waiting in this chat any more - including under
	// the pathless key a fresh chat types into.
	drafts.delete("");
	rememberDraft();
	// Read before anything is echoed into the transcript: the branches below
	// push the message on screen themselves, and a check made after that would
	// never see an empty chat.
	const firstMessage = app.chat.messages.length === 0;
	bump();
	// Extension commands (/hindsight, /auto-thinking, ...) execute inside the
	// agent without emitting a user message event, so nothing would echo the
	// input back into the chat. Show it ourselves; what the command is and what
	// it did are the agent's to say. Skill and prompt commands expand into real
	// prompts and echo through the normal event path.
	const commandName = text.startsWith("/") ? (text.slice(1).split(/\s+/, 1)[0] ?? "") : "";
	if (commandName !== "") await ensureCommands();
	const isExtensionCommand =
		commandName !== "" &&
		app.slashCommands.some((command) => command.source === "extension" && command.name === commandName);
	if (isExtensionCommand) {
		// The reader's own words, and nothing else: a harness line saying
		// "Running" only talks over the sentence the agent is about to write.
		app.chat.messages.push({ role: "user", blocks: [{ kind: "text", text }] });
		bump();
		const sent = await call("prompt", text, images, "steer");
		if (sent === null) {
			// The agent never received it: take the echo back out and put the
			// words where the reader can see them.
			const echoed = app.chat.messages.at(-1);
			if (echoed?.role === "user" && echoed.blocks[0]?.kind === "text" && echoed.blocks[0].text === text) {
				app.chat.messages.pop();
			}
			app.draft = text;
			bump();
			return;
		}
		// A chat opened with a command is still a chat: it was left unlisted
		// until the command finished, which for /battletest or /review is many
		// minutes of the sidebar denying it exists.
		if (firstMessage) await adoptNewChat(text);
		return;
	}
	// An idle agent simply starts a turn. A running one either takes the
	// message at its next tool boundary ("now", the same path the queue's own
	// Send now uses) or holds it to the end ("queue").
	// Steering a message in while the turn runs is the "now" half of the
	// setting; queueing holds it to the end. An idle agent has nothing to wait
	// for either way, so it always starts a turn.
	if (app.chat.streaming && mode === "now") {
		const echoed = echoSentMessage(text, images);
		const sent = await call("prompt", text, images, "steer");
		if (sent === null) {
			unechoSentMessage(echoed);
			app.draft = text;
			bump();
		}
		return;
	}
	if (app.chat.streaming) {
		const label =
			images.length > 0 ? `${images.length === 1 ? "[Image]" : `[${images.length} images]`} ${text}`.trim() : text;
		if (label !== "") {
			app.queuedBySession.set(app.currentSessionPath, [...queuedHere(), { label, text, images }]);
			bump();
		}
		const sent = await call("prompt", text, images, "followUp");
		if (sent === null) {
			// The agent never received it: take the phantom out of the banner
			// and put the words back where the user can see them.
			app.queuedBySession.set(
				app.currentSessionPath,
				queuedHere().filter((message) => message.text !== text),
			);
			if (queuedHere().length === 0) app.queuedBySession.delete(app.currentSessionPath);
			app.draft = text;
			bump();
		}
	} else {
		// A first message is what turns a scratch chat into a stored one. Put the
		// row in the sidebar now, titled from the message, rather than leaving the
		// chat unlisted until the agent has written its file and a refresh lands.
		const echoed = echoSentMessage(text, images);
		const sent = await call("prompt", text, images, "steer");
		if (sent === null) {
			unechoSentMessage(echoed);
			app.draft = text;
			bump();
			return;
		}
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
	// A temporary chat never gets a file, a title, or a row: its whole point
	// is that nothing about it is written down anywhere.
	if (app.temporaryChat) return;
	// A chat has no file until its first message is written, and the write
	// lands just after the prompt is accepted. Without this the row waited
	// for the next full refresh, which on a long first turn is the whole
	// turn, and the chat appears to be missing from the sidebar for minutes.
	if (app.currentSessionPath === "") await waitForSessionFile();
	if (app.currentSessionPath === "") return;
	// Naming and listing are separate jobs. A message with no words to take a
	// title from (an image on its own) still gets its row; it just keeps the
	// lister's own fallback name instead of a stored one.
	const title = titleFrom(text);
	if (title !== "") {
		// Name it for real rather than leaning on the lister's fallback, which
		// only ever shows the opening words: a stored name survives, and a chat
		// opened with boilerplate (a skill's preamble) still reads as itself.
		void call("setSessionName", title);
		app.sessionName = title;
	}
	await refreshSessionRows();
	if (app.sessionRows.some((row) => row.path === app.currentSessionPath)) return;
	app.sessionRows = [
		{
			path: app.currentSessionPath,
			id: app.currentSessionPath,
			cwd: app.appInfo.cwd,
			title: title === "" ? "New chat" : title,
			preview: text.trim().slice(0, 120),
			lastActive: Date.now(),
			messageCount: 1,
		},
		...app.sessionRows,
	];
	bump();
}

/**
 * Wait, briefly, for the agent to write the session file.
 *
 * Asking its state is a millisecond, so this costs nothing when the file
 * is already there and gives up quickly when something has gone wrong.
 */
async function waitForSessionFile(): Promise<void> {
	for (let attempt = 0; attempt < 12; attempt++) {
		const state = await call<{ sessionFile?: unknown }>("getState");
		const path = String(state?.sessionFile ?? "");
		if (path !== "") {
			app.currentSessionPath = path;
			app.scratchChat = false;
			app.temporaryChat = false;
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
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
/**
 * The approval requests that belong to the chat on screen. A background
 * chat's agent asking about a command must not interrupt the conversation the
 * reader is actually in — its card waits in its own chat. A request without a
 * slot (an older agent, the side chat) is shown wherever the reader is, so
 * nothing can wait invisibly.
 */
export function approvalsHere(): PermissionRequest[] {
	return app.pendingApprovals.filter(
		(request) => request.slot === undefined || app.attachedSlot === null || request.slot === app.attachedSlot,
	);
}

export function queuedHere(): QueuedMessage[] {
	return app.queuedBySession.get(app.currentSessionPath) ?? [];
}

/** The Send now this chat is still waiting on, if any. */
export function flushingHere(): AppState["flushingQueued"] {
	const flushing = app.flushingQueued;
	return flushing !== null && flushing.path === app.currentSessionPath ? flushing : null;
}

/**
 * Deliver what is waiting straight into the running turn.
 *
 * Queueing is the safe default — a half-formed thought should not
 * redirect work already under way — but once it is typed the reader can
 * see it is not half-formed, and waiting out a long turn to say so is its
 * own kind of wrong. This takes the message out of the queue that waits for
 * the end of the turn and steers it in at the next tool boundary instead.
 *
 * It does not interrupt. Aborting the turn outright was the old behaviour
 * and it threw away whatever the agent was mid-way through, which is a
 * heavy price for wanting to be heard sooner; the next boundary is close
 * enough, and the work in flight survives.
 */
let sendingQueuedNow = false;

export async function sendQueuedNow(): Promise<void> {
	// Single-shot: the awaits below leave a window where a second click used
	// to read the same queue and send the same message again.
	if (sendingQueuedNow) return;
	const path = app.currentSessionPath;
	const waiting = queuedHere();
	if (waiting.length === 0) return;
	const text = waiting
		.map((message) => message.text)
		.filter((line) => line !== "")
		.join("\n\n");
	const images = waiting.flatMap((message) => message.images);
	if (text === "" && images.length === 0) return;
	sendingQueuedNow = true;
	app.sendingQueuedNow = true;
	// Steering lands at the next tool boundary, which can be a while off. The
	// banner stays up until the agent says it took the message, so the wait is
	// visible instead of the queue simply vanishing.
	app.flushingQueued = { path, count: waiting.length, text, label: waiting[0]?.label ?? text, seen: false };
	// Claim the queue synchronously, before any await, so nothing else can
	// read it; on any failure below it is put back rather than lost.
	app.queuedBySession.delete(path);
	bump();
	const restore = () => {
		app.queuedBySession.set(path, waiting);
		app.flushingQueued = null;
		bump();
	};
	try {
		// Out of the agent's queue first, so the send below is not a second
		// copy of the same message.
		if ((await call("clearQueue")) === null) {
			restore();
			return;
		}
		// Steering delivers at the next tool boundary: sooner than the end of
		// the turn, and without throwing away the step in progress.
		if ((await call("prompt", text, images, "steer")) === null) {
			restore();
		}
	} finally {
		sendingQueuedNow = false;
		app.sendingQueuedNow = false;
		bump();
	}
}

export async function clearQueued(): Promise<void> {
	app.queuedBySession.delete(app.currentSessionPath);
	if (app.flushingQueued?.path === app.currentSessionPath) app.flushingQueued = null;
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

/**
 * Open the chat with this id, wherever it lives.
 *
 * The sidebar only lists this folder's chats, so an id is looked up there
 * first and then in the whole index, which finds a chat from another
 * folder too. An id that matches nothing gets a plain answer rather than
 * a silent click.
 */
/**
 * Open a file the agent named, in whatever the system opens it with. A
 * relative path is taken from the project folder, as the agent meant it.
 * A file that is not there any more says so instead of failing quietly.
 */
export async function openLocalFile(target: string): Promise<void> {
	const path = target.trim().replace(/:\d+(?::\d+)?$/, "");
	if (path === "") return;
	const result = await api.reveal(path, "open");
	if (!result.ok) toast(result.error ?? `Could not open ${path}`, "error");
}

/** Sessions looked up for quoted session ids; null when the id matched nothing. */
const sessionLookups = new Map<string, Promise<SessionRow | null>>();

/**
 * The chat row with this id, if it exists. The sidebar rows answer at once
 * for this folder; anything else is one index search, remembered so a
 * transcript full of the same id asks once.
 */
function lookupSession(id: string): Promise<SessionRow | null> {
	const wanted = id.toLowerCase();
	const here = app.sessionRows.find((row) => row.id.toLowerCase() === wanted);
	if (here) return Promise.resolve(here);
	let pending = sessionLookups.get(wanted);
	if (!pending) {
		pending = api
			.sessions(id)
			.then((rows) => rows.find((row) => row.id.toLowerCase() === wanted) ?? null)
			.catch(() => null);
		sessionLookups.set(wanted, pending);
	}
	return pending;
}

/** The name of the chat with this id, for showing in place of the id. */
export async function sessionTitleFor(id: string): Promise<string | null> {
	return (await lookupSession(id))?.title || null;
}

/** Whether a chat with this id exists, for keeping dead ids from staying links. */
export function sessionExistsFor(id: string): Promise<boolean> {
	return lookupSession(id).then((row) => row !== null);
}

export async function openSessionById(id: string): Promise<void> {
	const wanted = id.toLowerCase();
	const here = app.sessionRows.find(
		(row) => row.id.toLowerCase() === wanted || row.path.toLowerCase().includes(wanted),
	);
	const row = here ?? (await api.sessions(id).catch(() => []))?.find((entry) => entry.id.toLowerCase() === wanted);
	if (!row) {
		toast("That chat is not on this machine any more.", "error");
		return;
	}
	await switchToSession(row.path);
}

/**
 * The last rendered transcript of each chat left this window, so switching
 * back paints instantly instead of waiting out the disk read. The read still
 * runs and replaces the snapshot with whatever is on disk.
 */
const transcriptCache = new Map<
	string,
	{ messages: typeof app.chat.messages; historyStart: number; historyUserStart: number }
>();
const TRANSCRIPT_CACHE_MAX = 12;

/** Drop a chat's cached transcript: it has been deleted, so it is not coming back. */
function forgetTranscript(path: string): void {
	transcriptCache.delete(path);
}

function stashTranscript(): void {
	if (app.currentSessionPath === "" || app.chat.messages.length === 0) return;
	transcriptCache.delete(app.currentSessionPath);
	transcriptCache.set(app.currentSessionPath, {
		messages: app.chat.messages,
		historyStart: app.historyStart,
		historyUserStart: app.historyUserStart,
	});
	while (transcriptCache.size > TRANSCRIPT_CACHE_MAX) {
		const oldest = transcriptCache.keys().next().value;
		if (oldest === undefined) break;
		transcriptCache.delete(oldest);
	}
}

/**
 * Bring the folder the window shows into line with the chat it is showing.
 *
 * A chat is rooted in the project it was started in and keeps it, so the
 * directory is something the window follows rather than something it sets.
 * Cheap when nothing moved — the whole reload only runs on an actual change.
 */
async function syncProjectFolder(): Promise<void> {
	const info = await api.info();
	const cwd = String(info?.cwd ?? "");
	if (cwd === "" || cwd === app.appInfo.cwd) return;
	app.appInfo = { ...app.appInfo, cwd, hasProject: info?.hasProject === true };
	app.folders = info?.folders ?? app.folders;
	// The old folder's figures must not stand in for this one while the git
	// read runs; a folder seen before repaints from what was stored for it.
	app.diffChanged = 0;
	app.diffAdded = 0;
	app.diffRemoved = 0;
	app.diffUnlisted = 0;
	hydrateDiffStats(cwd);
	storePreference("smolt.lastCwd", cwd);
	bump();
	void refreshDiff();
}

/**
 * Which switch owns the window.
 *
 * Flicking down the sidebar starts a switch per row, and each one has several
 * awaits in it — a disk read, the agent's own move, a folder sync, a state
 * round-trip. Without this, an earlier switch's late replies landed on top of
 * a later one and dragged the view back to a chat the reader had already left.
 */
let switchGeneration = 0;

/** The agent's own switches, run one after another so the last click wins. */
let agentSwitches: Promise<unknown> = Promise.resolve();

/** How many switches are part-way through, so state reads defer to them. */
let switchesInFlight = 0;

/**
 * Chats this window asked the agent for and then moved off before the agent
 * got there. The agent still announces each move it makes, and that
 * announcement is what another window follows — so without this, the window
 * followed itself back to the row above the one just clicked.
 */
const abandonedSwitches = new Set<string>();

export async function switchToSession(path: string, options: { follow?: boolean } = {}): Promise<void> {
	if (path === app.currentSessionPath) return;
	switchesInFlight++;
	try {
		await runSwitch(path, options);
	} finally {
		switchesInFlight--;
	}
}

async function runSwitch(path: string, options: { follow?: boolean }): Promise<void> {
	const generation = ++switchGeneration;
	const superseded = (): boolean => generation !== switchGeneration;
	// Before the path moves, or the last second of typing would be filed
	// against the chat being opened rather than the one being left.
	stashDraft();
	stashTranscript();
	// Detach before anything else. The agent's move takes a second, and until
	// it lands the slot being left is still active and still streaming; its
	// events carry that slot's id, which the attachment gate still accepts —
	// so a turn from the old chat would reduce into the one just opened.
	app.attachedSlot = null;
	// Move the view first. The agent's own switch takes about a second and the
	// transcript another half, so waiting for both before anything changes on
	// screen reads as a hang rather than a load.
	app.currentSessionPath = path;
	app.scratchChat = false;
	app.temporaryChat = false;
	// Whatever was left in this chat's box, back where it was left.
	app.draft = draftFor(path);
	bumpDraft();
	// Opening the chat is looking at what it finished.
	app.finishedUnseen.delete(path);
	// The chat being left stays on screen under a loading veil rather than
	// vanishing into a blank pane: the read below replaces it, and a chat
	// that turns out to be empty clears it then.
	app.chat.usage = null;
	resetHistory(true);
	// The old chat's name must not stand in for this one during the seconds
	// until the agent's state lands: the header falls back to the sidebar row.
	app.sessionName = "";
	// The diff and the branch belong to the folder, not the chat. Wiping them
	// for a chat in the same folder made the changes bar and the repo line drop
	// out and come back a second later, shoving the composer and the pane about
	// for no gain. Only a move to another project clears them.
	const targetCwd = app.sessionRows.find((row) => row.path === path)?.cwd ?? "";
	if (targetCwd !== "" && targetCwd !== app.appInfo.cwd) {
		app.diffFiles = [];
		app.diffChanged = 0;
		app.diffAdded = 0;
		app.diffRemoved = 0;
		app.diffUnlisted = 0;
		app.diffUnavailable = "";
		app.repoBranch = "";
		app.repoBarDismissed = null;
	}
	// The pool tells the window which chats are working, so a turn in flight
	// says so at once. Asking the agent instead means waiting on a process
	// that is busy answering, which is what left the line missing for seconds.
	app.chat.streaming = app.busySessions.has(path);
	// A chat seen before repaints from its snapshot in the same frame; the
	// disk read below still replaces it with the truth.
	const cached = transcriptCache.get(path);
	if (cached) {
		app.chat.messages = cached.messages;
		app.historyStart = cached.historyStart;
		app.historyUserStart = cached.historyUserStart;
		app.chatLoading = false;
		app.chatEmpty = false;
	}
	syncRunStart();
	bump();
	// Render from the stored transcript first. Switching inside the agent takes
	// seconds, and the same messages are already on disk; waiting for the agent
	// before showing anything is what made opening a chat feel broken.
	await loadStoredMessages(path);
	if (superseded()) return;
	if (app.currentSessionPath === path) {
		app.chatLoading = false;
		bump();
	}

	// Following a move another window made: the agent is already there, so
	// only the view moves.
	if (!options.follow) {
		// Queued behind any switch already in flight: two running at once can
		// finish in either order, which left the agent on a chat the window had
		// moved off.
		const run = agentSwitches.then(async () => {
			if (superseded()) return null;
			const result = await call<{ cancelled: boolean }>("switchSession", path);
			// The move has been made and announced. If the reader has gone on since,
			// that announcement is stale and must not be followed.
			if (superseded()) abandonedSwitches.add(path);
			await reattach();
			return result;
		});
		agentSwitches = run.catch(() => undefined);
		const result = await run;
		if (superseded()) return;
		if (!result || result.cancelled) return;
	}
	// A chat belongs to the folder it was started in, so opening one can move
	// the window to another project. Everything hung off the directory — the
	// folder chip, the changed-files bar, the repo bar — has to come with it.
	await syncProjectFolder();
	if (superseded()) return;
	// The agent is authoritative only for a turn still in flight, which the
	// file cannot show — so a working chat is asked first, before the state
	// round-trip, and a settled one is spared the fetch altogether.
	let asked = false;
	if (app.busySessions.has(path)) {
		await loadMessages();
		if (superseded()) return;
		asked = true;
	}
	await refreshState({ owned: true });
	if (superseded()) return;
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
	// A fresh chat is empty by definition; a chat being switched into is not
	// known to be anything until a read says so.
	app.chatEmpty = !loading;
}

/** Fill the transcript from the session file, without troubling the agent. */
async function loadStoredMessages(path: string): Promise<void> {
	let page: { messages: Record<string, unknown>[]; start: number; userStart: number };
	try {
		page = await api.sessionMessages(path, { limit: PAGE });
	} catch {
		// The previous chat must not stand in for one that could not be read.
		if (app.currentSessionPath === path) app.chat.messages = [];
		return;
	}
	// A later switch may have overtaken this read; it owns the view now.
	if (app.currentSessionPath !== path) return;
	// An empty page is an answer, not a failed read: this chat is empty.
	app.chatEmpty = page.messages.length === 0;
	if (page.messages.length === 0) {
		app.chat.messages = [];
		return;
	}
	app.chat.messages = toChatMessages(page.messages);
	app.historyStart = page.start;
	app.historyUserStart = page.userStart;
	app.historySource = "disk";
	bump();
}

export async function newSession(options: { follow?: boolean; temporary?: boolean } = {}): Promise<void> {
	// Already looking at an empty chat, saved or not: there is nothing to move
	// to, and re-running the reset clears and reloads the view, which reads as a
	// flicker. A mid-turn empty chat still gets the real move.
	if (app.chat.messages.length === 0 && app.draft.trim() === "" && !app.chat.streaming) return;
	// A switch still in flight must not land on the fresh chat.
	++switchGeneration;
	stashDraft();
	stashTranscript();
	// Detach first, as with switching: the fresh chat starts on its own agent,
	// and until it announces, events from the slot being left still pass the
	// attachment gate and would put its working line on this empty transcript.
	app.attachedSlot = null;
	// The view moves first, as with switching: a fresh chat is empty by
	// definition, and waiting out the agent's round-trip before clearing made
	// the button read as dead whenever the agent was slow to answer.
	resetHistory(false);
	app.sessionName = "";
	app.currentSessionPath = "";
	app.scratchChat = true;
	app.temporaryChat = options.temporary === true;
	// A new chat starts with an empty box. The words of the chat just left are
	// kept against it; the ones from a previous unsaved chat are not inherited,
	// which is what dropping the pathless entry is for.
	app.draft = "";
	drafts.delete("");
	bumpDraft();
	// Written out now rather than a second from now: the words of a fresh chat
	// that was never sent must not be on disk waiting for the next fresh chat.
	flushDrafts();
	app.chat.messages = [];
	app.chat.usage = null;
	// A fresh chat cannot be mid-turn. Whatever the previous chat was doing
	// must not stand in for this one: leaving streaming set put the working
	// line and the queue placeholder on an empty transcript until a state
	// round-trip happened to clear it.
	app.chat.streaming = false;
	app.runStartedAt = 0;
	app.diffFiles = [];
	app.diffChanged = 0;
	app.diffAdded = 0;
	app.diffRemoved = 0;
	app.diffUnlisted = 0;
	app.diffUnavailable = "";
	app.repoBranch = "";
	app.repoBarDismissed = null;
	bump();
	if (!options.follow) {
		await call("newSession", ...(options.temporary === true ? [{ temporary: true }] : []));
		await reattach();
		// A fresh chat starts at the effort chosen in settings, not at whatever the
		// last one was left on.
		if (app.defaultThinking !== "") await call("setThinkingLevel", app.defaultThinking, false);
	}
	await refreshState();
}

/**
 * Another window moved the app to a chat this one is not showing: show it.
 * The window that made the move is already there and does nothing here.
 */
async function followSession(info: { slot: number; path: string }): Promise<void> {
	if (info.path === app.currentSessionPath) return;
	// This window's own move, already overtaken by a later click.
	if (abandonedSwitches.delete(info.path)) return;
	// A switch of this window's own is part-way through and is authoritative:
	// whatever the agent is announcing now, the reader has already chosen where
	// they are going.
	if (switchesInFlight > 0) return;
	if (info.path === "") await newSession({ follow: true });
	else await switchToSession(info.path, { follow: true });
	app.attachedSlot = info.slot;
	bump();
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
	const isCurrent = row.path === app.currentSessionPath;
	const name = await requestInput({
		title: "Rename chat",
		message: isCurrent ? undefined : `Switches to "${row.title}" first, since a chat is named from within it.`,
		initial: (isCurrent ? app.sessionName : "") || row.title,
	});
	if (name === null) return;
	const trimmed = name.trim();
	if (trimmed === "") return;
	// Naming writes into the session itself, so it has to be the open one.
	if (row.path !== app.currentSessionPath) await switchToSession(row.path);
	await call("setSessionName", trimmed);
	app.sessionName = trimmed;
	await refreshState();
}

/**
 * Branch a new chat from an assistant response: the new session carries the
 * conversation up to and including that response, and the original stays
 * untouched. Mechanically a fork at the NEXT user message (whose entry marks
 * the first thing the branch should not contain), or a clone when the
 * response is the newest thing in the chat.
 */
export async function branchFromResponse(nextUserIndex: number): Promise<void> {
	if (app.chat.streaming) {
		toast("Wait for the current turn to finish before branching.");
		return;
	}
	const forkable = (await call<{ entryId: string; text: string }[]>("getForkMessages")) ?? [];
	const target = forkable[app.historyUserStart + nextUserIndex];
	const result = target
		? await call<{ cancelled: boolean }>("fork", target.entryId)
		: await call<{ cancelled: boolean }>("clone");
	if (!result || result.cancelled) return;
	// The fork hands back the removed user message for re-editing; a branch
	// starts fresh instead, so the draft stays whatever the user had typed.
	toast("Branched into a new chat.");
	await refreshState();
	await loadMessages();
	void refreshSessionRows();
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
	const wasCurrent = row.path === app.currentSessionPath;
	if (wasCurrent) await newSession();
	forgetTranscript(row.path);
	forgetDraft(row.path);
	await refreshState();
}

/**
 * The chats the sidebar is showing, in the order it shows them.
 *
 * Range selection needs an order, and the sidebar's is not `sessionRows`:
 * pinned chats are lifted to the top and a search filters the rest. So the
 * list that draws the rows is the list that defines "everything between".
 */
let sessionOrder: string[] = [];

/** Anchor for shift-click: the last row the reader touched directly. */
let selectionAnchor: string | null = null;

export function setSessionOrder(paths: string[]): void {
	sessionOrder = paths;
}

/** A plain click opens a chat; remember it as where a later range starts. */
export function setSelectionAnchor(path: string): void {
	selectionAnchor = path;
}

/**
 * Ctrl+A in the sidebar toggles: everything it is currently showing, or —
 * when everything is already selected — nothing, the second press undoing
 * the first.
 */
export function selectAllSessions(): void {
	if (sessionOrder.length === 0) return;
	const allSelected =
		app.selectedSessions.size >= sessionOrder.length && sessionOrder.every((path) => app.selectedSessions.has(path));
	app.selectedSessions = allSelected ? new Set() : new Set(sessionOrder);
	bump();
}

/** Ctrl-click: add or remove this one, and leave the rest alone. */
export function toggleSessionSelected(path: string): void {
	const next = new Set(app.selectedSessions);
	if (next.has(path)) next.delete(path);
	else next.add(path);
	app.selectedSessions = next;
	selectionAnchor = path;
	bump();
}

/**
 * Shift-click: take everything between the anchor and this row.
 *
 * With no anchor yet (shift-click as the very first gesture) this row becomes
 * the anchor, which is what every list does — there is no range without two
 * ends.
 */
export function selectSessionRange(path: string): void {
	const end = sessionOrder.indexOf(path);
	const start = selectionAnchor === null ? -1 : sessionOrder.indexOf(selectionAnchor);
	if (end === -1 || start === -1) {
		toggleSessionSelected(path);
		return;
	}
	const [from, to] = start <= end ? [start, end] : [end, start];
	app.selectedSessions = new Set(sessionOrder.slice(from, to + 1));
	bump();
}

/**
 * Pick out every chat in a group, so one gesture can act on the lot.
 *
 * Selecting replaces rather than adds: a right-click on a second heading is
 * far more likely to mean "that group instead" than "both groups".
 */
export function selectSessions(paths: string[]): void {
	app.selectedSessions = new Set(paths);
	selectionAnchor = paths[paths.length - 1] ?? null;
	bump();
}

export function clearSessionSelection(): void {
	if (app.selectedSessions.size === 0) return;
	app.selectedSessions = new Set();
	bump();
}

/** Delete every selected chat, once. */
/** Pin every selected chat; the selection has served its purpose after. */
export function pinSelectedSessions(): void {
	for (const path of app.selectedSessions) app.pinned.add(path);
	storePreference("smolt.pinned", [...app.pinned].join("\n"));
	app.selectedSessions = new Set();
	bump();
}

/** Archive every selected chat in one gesture. */
export function archiveSelectedSessions(): void {
	for (const path of app.selectedSessions) app.archived.add(path);
	storePreference("smolt.archived", [...app.archived].join("\n"));
	app.selectedSessions = new Set();
	bump();
}

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
	if (deletedCurrent) await newSession();
	for (const path of paths) {
		forgetTranscript(path);
		forgetDraft(path);
	}
	await refreshState();
}

/**
 * The app's own accumulated data: what you did, not what you chose.
 *
 * Preferences — theme, effort, serif face, sidebar density — are deliberately
 * absent. A wipe clears history; it does not reset how the app looks.
 */
const LOCAL_DATA_KEYS = [
	"smolt.archived",
	"smolt.collapsed",
	"smolt.commandUse",
	"smolt.modelUse",
	"smolt.pinned",
	"smolt.promptHistory",
	"smolt.recentModels",
];

/** Forget everything this window remembers about what you have done. */
export function clearLocalAppData(): void {
	for (const key of LOCAL_DATA_KEYS) forgetPreference(key);
	promptHistory.length = 0;
	app.commandUse = {};
	app.modelUse = {};
	app.pinned = new Set();
	app.archived = new Set();
	app.collapsedGroups = new Set();
	app.selectedSessions = new Set();
	bump();
}

export function setSidebarShowAll(on: boolean): void {
	app.sidebarShowAll = on;
	storePreference("smolt.sidebarShowAll", on ? "1" : "0");
	bump();
}

export function setSidebarDots(on: boolean): void {
	app.sidebarDots = on;
	storePreference("smolt.sidebarDots", on ? "1" : "0");
	bump();
}

export function setLanguage(language: "us" | "uk"): void {
	app.language = language;
	storePreference("smolt.language", language);
	bump();
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
	// Mid-turn, the pick is held rather than applied: yanking the model out
	// from under a streaming response splits one answer across two models.
	// It applies with the next user message (or the turn's end, whichever
	// comes first), and every response after that uses it.
	if (app.chat.streaming) {
		app.pendingModel = { provider, id, remember };
		toast(`Model queued: ${id} takes over from your next message.`);
		bump();
		return;
	}
	await call("setModel", provider, id, remember);
	noteModelUse(provider, id);
	app.model = `${provider}/${id}`;
	if (remember) rememberRecentModel(app.model);
	app.availableThinking = (await call<string[]>("getAvailableThinkingLevels")) ?? [];
	await refreshState();
}

/** Apply a model pick that was made mid-turn, once it is safe to. */
export async function applyPendingModel(): Promise<void> {
	const pending = app.pendingModel;
	if (!pending) return;
	app.pendingModel = null;
	await call("setModel", pending.provider, pending.id, pending.remember);
	app.model = `${pending.provider}/${pending.id}`;
	if (pending.remember) rememberRecentModel(app.model);
	app.availableThinking = (await call<string[]>("getAvailableThinkingLevels")) ?? [];
	bump();
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

/**
 * The models on offer: what the agent reports, narrowed to the providers
 * the reader actually set up here or in the TUI.
 *
 * The agent counts a provider as available whenever it can find a key,
 * which includes keys that happen to sit in the environment; on a machine
 * with a few of those the list fills with hundreds of models nobody chose.
 * Only providers with a credential in the shared auth or pool files count,
 * the same set the Providers page shows.
 */
export async function ensureModels(): Promise<void> {
	if (app.availableModels.length === 0) await refreshModels();
}

/** Re-read the model list, after a provider was added or removed. */
export async function refreshModels(): Promise<void> {
	const [models, configured] = await Promise.all([
		call<ModelOption[]>("getAvailableModels"),
		api.providersList().catch(() => null),
	]);
	const chosen = configured === null ? null : new Set(configured.map((provider) => provider.id));
	app.availableModels = (models ?? []).filter((model) => chosen === null || chosen.has(model.provider));
	bump();
}

export async function ensureThinkingLevels(): Promise<void> {
	if (app.availableThinking.length === 0) {
		app.availableThinking = (await call<string[]>("getAvailableThinkingLevels")) ?? [];
		bump();
	}
}

export async function ensureCommands(): Promise<void> {
	if (app.slashCommands.length === 0) {
		// Internal commands are development tooling; the palette is how the app
		// talks to its user, not to the harness that built it.
		app.slashCommands = ((await call<SlashCommand[]>("getCommands")) ?? []).filter(
			(command) => command.internal !== true,
		);
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

export async function answerApproval(answer: string, id?: string): Promise<void> {
	// Answer the exact request the user saw, never "whatever is first now":
	// a card can be removed (answered elsewhere, expired) and another slide
	// into its place between the reader's eyes and their click, and a blind
	// shift() would record their decision against the wrong command.
	const index = id === undefined ? 0 : app.pendingApprovals.findIndex((request) => request.id === id);
	const request = index === -1 ? undefined : app.pendingApprovals[index];
	if (!request) return;
	app.pendingApprovals.splice(index, 1);
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
	try {
		await call("compact");
	} catch (error) {
		toast(`Compaction failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
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
		// toast() only reaches the console, and a button that silently does
		// nothing reads as a broken button.
		await requestConfirm({
			title: "Could not edit from there",
			message:
				"That message could not be found in the chat's history, so there is nothing to rewind to. This can happen after the conversation has been compacted.",
			actionLabel: "OK",
		});
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
	resolvedTheme = resolved;
	storePreference("smolt.theme", choice);
	void api.titlebar(resolved, dialogsOpen > 0);
	bump();
}

let resolvedTheme: "light" | "dark" = "dark";
let dialogsOpen = 0;

/**
 * A modal backdrop dims the whole page, but the window-controls strip on
 * the right belongs to the operating system, beyond any stylesheet, and
 * stayed crisp above the dimmed app. Every dialog overlay reports itself
 * here so the strip is repainted in the dimmed colour while one is up.
 */
export function setDialogOpen(open: boolean): void {
	dialogsOpen = Math.max(0, dialogsOpen + (open ? 1 : -1));
	void api.titlebar(resolvedTheme, dialogsOpen > 0);
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
	return folderName(app.appInfo.cwd);
}

/** The last segment of a path: the name a folder goes by on screen. */
export function folderName(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).pop() ?? "";
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
	// The window going away is the one deadline the debounce cannot wait out.
	// `pagehide` fires on a closing Electron window where `beforeunload` is not
	// guaranteed to, and both are cheap, so take either.
	for (const event of ["pagehide", "beforeunload"]) {
		window.addEventListener(event, () => {
			rememberDraft();
			flushDrafts();
		});
	}
	// Diagnosis hooks for the DevTools port: the state singleton and a running
	// census of what the agent streams in, so a bloated or frozen renderer can
	// be asked "what have you been fed" from outside.
	const eventStats = { count: 0, byType: {} as Record<string, number>, startedAt: Date.now() };
	(window as unknown as Record<string, unknown>).__smoltApp = app;
	(window as unknown as Record<string, unknown>).__smoltEventStats = eventStats;

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
	api.onSessionChanged?.((info) => {
		void followSession(info);
	});
	void reattach();

	api.onEvent((event, slot) => {
		eventStats.count++;
		const kind = String((event as { type?: unknown }).type ?? "?");
		eventStats.byType[kind] = (eventStats.byType[kind] ?? 0) + 1;
		const raw = event as {
			type?: string;
			id?: string;
			method?: string;
			widgetKey?: string;
			widgetLines?: string[];
			widgetDetails?: unknown;
			message?: string;
			notifyType?: string;
		};
		// A dialog holds its agent's turn open until it is answered, so it shows
		// whichever chat is on screen; dropping one for coming from another slot
		// left that agent waiting out its whole timeout in silence.
		if (
			raw.type === "extension_ui_request" &&
			typeof raw.id === "string" &&
			(raw.method === "select" || raw.method === "confirm" || raw.method === "input" || raw.method === "editor")
		) {
			handleExtensionUiRequest(raw as Parameters<typeof handleExtensionUiRequest>[0], slot);
			return;
		}
		// Live extension surfaces update their own slot's bucket even while that
		// chat is in the background, so switching back shows current state — and
		// never another chat's run.
		if (raw.type === "extension_ui_request" && raw.method === "setWidget" && typeof raw.widgetKey === "string") {
			const slotKey = slot ?? 0;
			let widgets = app.extensionWidgets.get(slotKey);
			if (Array.isArray(raw.widgetLines) && raw.widgetLines.length > 0) {
				if (!widgets) {
					widgets = new Map();
					app.extensionWidgets.set(slotKey, widgets);
				}
				widgets.set(raw.widgetKey, { lines: raw.widgetLines, details: raw.widgetDetails });
			} else {
				widgets?.delete(raw.widgetKey);
			}
			if (!slotAware || slot === app.attachedSlot) bump();
			return;
		}
		// Only the chat on screen. Anything else is a background turn, or the
		// tail of the one just left, and reducing it here is what used to leak
		// one conversation's words into another's transcript.
		if (slotAware && slot !== app.attachedSlot) return;
		if (raw.type === "extension_ui_request" && typeof raw.id === "string" && typeof raw.method === "string") {
			if (raw.method === "notify" && typeof raw.message === "string" && raw.message !== "") {
				// An extension talking to the reader directly. The chat's own
				// account of a command comes from the agent, so this stays a toast.
				toast(raw.message, raw.notifyType === "error" ? "error" : "default");
				return;
			}
			handleExtensionUiRequest(raw as Parameters<typeof handleExtensionUiRequest>[0], slot);
			return;
		}
		if (raw.type === "session_replaced") {
			// The agent switched sessions on its own (e.g. a Telegram message
			// opened its own chat): reset the transcript and follow it. The old
			// session's live widgets die with it.
			if (slot !== undefined) app.extensionWidgets.delete(slot);
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
		// Each finished request and each tool result changes what the next
		// request carries; the context figure follows them rather than the turn.
		if (raw.type === "message_end" || raw.type === "tool_execution_end") refreshContextUsageSoon();
		reduce(app.chat, event);
		trimLiveTranscript();
		syncRunStart();
		// Streaming deltas arrive tens of times a second, and painting each one
		// re-rendered the whole app per delta — measured at ~2MB of engine-side
		// style churn per pass, gigabytes per minute, which is what froze the
		// window under GC. State is reduced immediately (above) so nothing is
		// lost; the paint is coalesced to at most a few per second.
		if (raw.type === "message_update") bumpSoon();
		else bump();
		const type = (event as { type?: string }).type;
		// The agent reports its own queue as it drains it, so the banner clears
		// when a message is actually delivered rather than when the turn ends.
		if (raw.type === "queue_update") {
			const live = new Set([...((raw as QueueUpdate).steering ?? []), ...((raw as QueueUpdate).followUp ?? [])]);
			// A Send now is done the moment the agent no longer holds its text:
			// that is the tool boundary the banner was waiting on.
			// Waiting to see the text held first keeps the empty update that the
			// preceding clearQueue provokes from closing the banner instantly.
			const flushing = app.flushingQueued;
			if (flushing !== null) {
				if (live.has(flushing.text)) flushing.seen = true;
				else if (flushing.seen) app.flushingQueued = null;
				bump();
			}
			const held = queuedHere();
			const remaining = held.filter((message) => live.has(message.text));
			if (remaining.length !== held.length) {
				if (remaining.length === 0) app.queuedBySession.delete(app.currentSessionPath);
				else app.queuedBySession.set(app.currentSessionPath, remaining);
				bump();
			}
		}
		if (raw.type === "agent_start") {
			app.aborting = false;
			app.agentLost = false;
		}
		if (type === "agent_settled") {
			app.aborting = false;
			// The turn is over, so no call can still be running. One that never
			// got its result (the reader stopped the turn mid-call) closes as
			// stopped rather than pulsing blue for the rest of the chat.
			for (const message of app.chat.messages) {
				for (const block of message.blocks) {
					if (block.kind !== "tool" || !block.running) continue;
					block.running = false;
					block.aborted = true;
					if (block.output === "") block.output = "Stopped before it finished.";
				}
			}
			// A model picked mid-turn applies now the turn is over, so the next
			// message starts on it without the user doing anything further.
			void applyPendingModel();
			// Nothing can still be waiting once the run is over: a message the
			// agent never drained is one it will not read now.
			app.queuedBySession.delete(app.currentSessionPath);
			app.flushingQueued = null;
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
	// The updater reports from the main process; keep the latest word in one
	// place rather than having every surface subscribe for itself.
	void api
		.updateState()
		.then((next) => {
			app.update = next;
			bump();
		})
		.catch(() => undefined);
	api.onUpdateState?.((next) => {
		app.update = next;
		app.updateChecking = next.status === "checking";
		bump();
	});

	api.onBusySessions?.((paths) => {
		const next = new Set(paths.filter((path) => path !== ""));
		// A chat that stopped working while the reader was elsewhere finished
		// work nobody has looked at; it stays marked until the chat is opened.
		for (const path of app.busySessions) {
			if (!next.has(path) && path !== app.currentSessionPath) app.finishedUnseen.add(path);
		}
		app.busySessions = next;
		bump();
	});

	api.onBackgroundSettled?.((info) => {
		// A chat finished while another was on screen; its title, preview and
		// dot in the sidebar all want refreshing. It also counts as work the
		// reader has not seen, so the dot holds green until the chat is opened.
		if (info.sessionPath && info.sessionPath !== app.currentSessionPath) {
			app.finishedUnseen.add(info.sessionPath);
		}
		void refreshState();
	});

	let initialLoadDone = false;
	const initialLoad = async (): Promise<void> => {
		if (initialLoadDone) return;
		initialLoadDone = true;
		// The bar is painted from the last sitting before the window has asked
		// anything of the main process: the folder is remembered, and so are
		// its figures, so the first frame already carries them. The directory
		// is then confirmed, and the git read starts at once rather than after
		// the agent's state and the session list have been fetched in turn.
		const remembered = storedPreference("smolt.lastCwd", "");
		if (remembered !== "") {
			hydrateDiffStats(remembered);
			bump();
		}
		const info = await api.info();
		app.appInfo = {
			cwd: info.cwd ?? "",
			version: info.version ?? "",
			hasProject: info.hasProject === true,
			packaged: info.packaged === true,
		};
		app.appInfoLoaded = true;
		if (app.appInfo.cwd !== remembered) {
			// A different folder from last time: the figures painted from memory
			// belong to the other one, and must not stand for this.
			app.diffChanged = 0;
			app.diffAdded = 0;
			app.diffRemoved = 0;
			app.diffUnlisted = 0;
			hydrateDiffStats();
		}
		storePreference("smolt.lastCwd", app.appInfo.cwd);
		void refreshDiff();
		await refreshState();
		// The agent starts on its own defaults; put back what was chosen last.
		await applyRememberedSettings();
		await refreshRecentProjects();
		const mode = await api.permissionMode();
		if (mode.ok) app.permissionMode = String(mode.value ?? "auto");
		// A fresh launch lands on a new chat; yesterday's conversation is one
		// click away in the sidebar. SMOLT_DESKTOP_CONTINUE=1 is the exception:
		// the newest session reopens, for picking up a turn that died with the
		// process.
		const restoreTo = info.continueLatest ? (app.sessionRows[0]?.path ?? "") : "";
		if (restoreTo !== "" && restoreTo !== app.currentSessionPath && app.chat.messages.length === 0) {
			await switchToSession(restoreTo);
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

	// Three ways an agent can stop or be held back. None of them used to reach
	// the window: a chat would simply stop mid-sentence and stay that way,
	// with nothing on screen saying anything had happened to it.
	api.onAgentExited?.((info) => {
		if (info.wasActive) {
			// Replaced in the same chat, so the transcript is intact and the
			// only thing lost is the turn that was in flight.
			toast("The agent stopped and was restarted. Ask again to carry on.", "error");
		} else {
			toast("A chat working in the background stopped.", "error");
			void refreshSessionRows();
		}
	});

	api.onTurnDropped?.((info) => {
		toast(info.to === "" ? "Moving folders ended the turn in flight." : "Moving this chat ended the turn in flight.");
		if (info.sessionPath !== "") app.finishedUnseen.delete(info.sessionPath);
	});

	api.onReloadDeferred?.(() => {
		toast("Saved. It applies to this chat once the turn in flight finishes.");
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

	// Subscription usage drifts slowly; a minute keeps the projection fresh
	// without leaning on the provider's usage endpoint.
	setInterval(() => void refreshProviderUsage(), 60_000);

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
	// A request answered elsewhere, expired, or swept loses its card here too:
	// deciding on a question that no longer exists is worse than no question.
	api.onPermissionRemoved?.((id) => {
		const next = app.pendingApprovals.filter((pending) => pending.id !== id);
		if (next.length === app.pendingApprovals.length) return;
		app.pendingApprovals = next;
		bump();
	});
	// The main process replaces an agent that died on its own; this is the
	// storytelling it cannot do from there — live tool cards close honestly,
	// and the active chat says what happened instead of pretending it didn't.
	api.onAgentExited?.((info) => {
		for (const message of app.chat.messages) {
			for (const block of message.blocks) {
				if (block.kind !== "tool" || !block.running) continue;
				block.running = false;
				block.aborted = true;
				if (block.output === "") block.output = "Interrupted.";
			}
		}
		if (info?.wasActive) {
			app.agentLost = true;
			void refreshState();
		}
		bump();
	});
}
