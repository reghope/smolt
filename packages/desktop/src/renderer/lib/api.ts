/** The preload bridge: everything the renderer may ask of the main process. */

/** What the updater is doing, mirrored from the main process. */
export type UpdateState =
	| { status: "idle" }
	| { status: "checking" }
	| { status: "available"; version: string }
	| { status: "downloading"; version: string; percent: number }
	| { status: "ready"; version: string; hotfix?: boolean }
	| { status: "installing"; version: string }
	| { status: "error"; message: string };

/** One failover credential in a provider's pool: what it is, never what it holds. */
export interface PoolCredentialInfo {
	id: string;
	label?: string;
	type: string;
	addedAt: number;
	plan?: string;
}

/** A provider with a credential, and the failover pool behind it. */
export interface ConfiguredProvider {
	id: string;
	/** "api_key" or "oauth"; absent when only pool credentials exist. */
	type?: string;
	/** The name given to the primary credential, when one has been. */
	primaryLabel?: string;
	/** In the pool: instances fail over to each other and the allowance shows in usage. */
	pooled: boolean;
	pool: PoolCredentialInfo[];
}

export interface AgentCallResult {
	ok: boolean;
	value?: unknown;
	error?: string;
}

export interface SmoltApi {
	call(method: string, ...args: unknown[]): Promise<AgentCallResult>;
	status(): Promise<{ running: boolean; error: string | null }>;
	sessions(query?: string): Promise<SessionRow[]>;
	info(): Promise<{
		cwd: string;
		version: string;
		hasProject?: boolean;
		folders?: string[];
		continueLatest?: boolean;
		packaged?: boolean;
	}>;
	stats(): Promise<AgentCallResult>;
	starters(): Promise<AgentCallResult>;
	micAccess(): Promise<AgentCallResult>;
	openMicSettings(): Promise<{ ok: boolean; error?: string }>;
	speechStatus(): Promise<unknown>;
	speechPrepare(): Promise<AgentCallResult>;
	speechTranscribe(samples: ArrayBuffer): Promise<AgentCallResult>;
	onSpeechProgress(cb: (progress: unknown) => void): void;
	sessionMessages(
		path: string,
		options?: { limit?: number; before?: number },
	): Promise<{ messages: Record<string, unknown>[]; start: number; userStart: number }>;
	sessionDelete(path: string): Promise<{ ok: boolean; error?: string }>;
	titlebar(theme: string, dimmed?: boolean): Promise<void>;
	linkPreview(url: string): Promise<LinkPreview | null>;
	pickFolder(): Promise<{ ok: boolean; value?: unknown; error?: string }>;
	openProject(path: string): Promise<{ ok: boolean; value?: unknown; error?: string }>;
	recentProjects(): Promise<string[]>;
	repoUrl(dir?: string): Promise<string | undefined>;
	closeProject(): Promise<{ ok: boolean; error?: string }>;
	folders(): Promise<string[]>;
	updateState(): Promise<UpdateState>;
	updateCheck(): Promise<{ ok: boolean }>;
	updateInstall(): Promise<{ ok: boolean }>;
	onUpdateState(cb: (state: UpdateState) => void): void;
	authList(): Promise<string[]>;
	knownProviders(): Promise<{ id: string; name: string; apiKey: boolean; oauth: boolean }[]>;
	authSet(provider: string, key: string): Promise<{ ok: boolean; error?: string }>;
	authRemove(provider: string): Promise<{ ok: boolean; error?: string }>;
	providersList(): Promise<ConfiguredProvider[]>;
	llamaStatus(): Promise<{
		binary?: string;
		modelsDir?: string;
		modelCount: number;
		serverUrl?: string;
		reachable: boolean;
	}>;
	llamaLaunch(): Promise<{ ok: boolean; already?: boolean; serverUrl?: string; error?: string }>;
	poolRemove(provider: string, credentialId: string): Promise<{ ok: boolean; error?: string }>;
	poolRelabel(provider: string, credentialId: string, label: string): Promise<{ ok: boolean; error?: string }>;
	poolAddKey(provider: string, key: string, label: string): Promise<{ ok: boolean; error?: string }>;
	poolSetPooled(provider: string, pooled: boolean): Promise<{ ok: boolean; error?: string }>;
	openCli(): Promise<{ ok: boolean; error?: string }>;
	addFolder(path: string): Promise<{ ok: boolean; value?: unknown; error?: string }>;
	popupMenu(x: number, y: number): Promise<{ ok: boolean }>;
	onMenuCommand(cb: (command: string) => void): void;
	copyText(text: string): Promise<{ ok: boolean; error?: string }>;
	reveal(target: string, how?: string): Promise<{ ok: boolean; error?: string }>;
	permissionReply(id: string, answer: string): Promise<{ ok: boolean; error?: string }>;
	pendingApprovals(): Promise<unknown[]>;
	onPermissionRequest(cb: (request: unknown) => void): void;
	onPermissionRemoved(cb: (id: string) => void): void;
	diff(): Promise<AgentCallResult>;
	diffStats(): Promise<AgentCallResult>;
	prReadiness(): Promise<AgentCallResult>;
	prCreate(draft: boolean): Promise<AgentCallResult>;
	permissionMode(mode?: string): Promise<AgentCallResult>;
	worktrees(): Promise<AgentCallResult>;
	branches(): Promise<AgentCallResult>;
	branchCheckout(branch: string): Promise<AgentCallResult>;
	worktreeCreate(label: string): Promise<AgentCallResult>;
	worktreeEnter(path: string): Promise<AgentCallResult>;
	worktreeRemove(path: string, force?: boolean): Promise<AgentCallResult>;
	/** Delete every chat, memory, skill, cue and index this machine holds. */
	wipeLocalData(): Promise<AgentCallResult>;
	sideCall(method: string, ...args: unknown[]): Promise<AgentCallResult>;
	sideStop(): Promise<{ ok: boolean; error?: string }>;
	onSideEvent(cb: (event: unknown) => void): void;
	activeSlot(): Promise<number>;
	onEvent(cb: (event: unknown, slot: number) => void): void;
	onAttached(cb: (slot: number) => void): void;
	onStarted(cb: (status: { running: boolean; error: string | null }) => void): void;
	onBusySessions(cb: (paths: string[]) => void): void;
	onBackgroundSettled(cb: (info: { sessionPath: string }) => void): void;
	onAgentExited(cb: (info: { slotId: number; wasActive: boolean; code: number | null }) => void): void;
	/** A running turn was ended by a directory move the reader asked for. */
	onTurnDropped(cb: (info: { sessionPath: string; cwd: string; to: string }) => void): void;
	/** A credential change is waiting for the turn in flight to finish. */
	onReloadDeferred(cb: (info: { sessionPath: string }) => void): void;
	/** The app moved to another chat, from this window or any other on it. */
	onSessionChanged(cb: (info: { slot: number; path: string }) => void): void;
	/** The in-app web server: whether it is on, and where to open it. */
	webServer(): Promise<WebServerState>;
	setWebServer(enabled: boolean): Promise<WebServerState>;
	ready(): void;
}

export interface WebServerState {
	enabled: boolean;
	running: boolean;
	https: boolean;
	/** Where to open it, best first. */
	urls: string[];
	error?: string;
}

export interface LinkPreview {
	url: string;
	host: string;
	title: string;
	description: string;
	image?: string;
}

export interface SessionRow {
	path: string;
	id: string;
	title: string;
	preview: string;
	lastActive: number;
	messageCount: number;
	/** The folder the chat ran in, so opening it can follow it there. */
	cwd: string;
	/** True while this session's agent is still working in the background. */
	busy?: boolean;
	/** This is the chat the dedicated Telegram host writes into. */
	telegram?: boolean;
}

declare global {
	interface Window {
		smolt: SmoltApi;
	}
}

export const api: SmoltApi = window.smolt;
