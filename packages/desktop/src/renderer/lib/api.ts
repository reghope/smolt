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
		canTranscribe?: boolean;
		packaged?: boolean;
	}>;
	transcribe(audio: ArrayBuffer, mimeType: string): Promise<AgentCallResult>;
	stats(): Promise<AgentCallResult>;
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
	titlebar(theme: string): Promise<void>;
	linkPreview(url: string): Promise<LinkPreview | null>;
	pickFolder(): Promise<{ ok: boolean; value?: unknown; error?: string }>;
	openProject(path: string): Promise<{ ok: boolean; value?: unknown; error?: string }>;
	recentProjects(): Promise<string[]>;
	closeProject(): Promise<{ ok: boolean; error?: string }>;
	folders(): Promise<string[]>;
	updateState(): Promise<UpdateState>;
	updateCheck(): Promise<{ ok: boolean }>;
	updateInstall(): Promise<{ ok: boolean }>;
	onUpdateState(cb: (state: UpdateState) => void): void;
	authList(): Promise<string[]>;
	knownProviders(): Promise<{ id: string; name: string; apiKey: boolean; oauth: boolean }[]>;
	authSet(provider: string, key: string): Promise<{ ok: boolean; error?: string }>;
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
	permissionMode(mode?: string): Promise<AgentCallResult>;
	worktrees(): Promise<AgentCallResult>;
	worktreeCreate(label: string): Promise<AgentCallResult>;
	worktreeEnter(path: string): Promise<AgentCallResult>;
	worktreeRemove(path: string, force?: boolean): Promise<AgentCallResult>;
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
	ready(): void;
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
}

declare global {
	interface Window {
		smolt: SmoltApi;
	}
}

export const api: SmoltApi = window.smolt;
