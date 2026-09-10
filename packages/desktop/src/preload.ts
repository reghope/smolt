import { contextBridge, ipcRenderer } from "electron";

export interface AgentCallResult {
	ok: boolean;
	value?: unknown;
	error?: string;
}

contextBridge.exposeInMainWorld("smolt", {
	call: (method: string, ...args: unknown[]): Promise<AgentCallResult> =>
		ipcRenderer.invoke("agent:call", method, args),
	status: (): Promise<{ running: boolean; error: string | null }> => ipcRenderer.invoke("agent:status"),
	sessions: (query?: string): Promise<unknown[]> => ipcRenderer.invoke("app:sessions", query),
	info: (): Promise<{ cwd: string; version: string }> => ipcRenderer.invoke("app:info"),
	pendingApprovals: (): Promise<unknown[]> => ipcRenderer.invoke("app:pending-approvals"),
	permissionReply: (id: string, answer: string): Promise<AgentCallResult> =>
		ipcRenderer.invoke("app:permission-reply", id, answer),
	onPermissionRequest: (cb: (request: unknown) => void): void => {
		ipcRenderer.on("permission:request", (_e, request) => cb(request));
	},
	onPermissionRemoved: (cb: (id: string) => void): void => {
		ipcRenderer.on("permission:removed", (_e, id: string) => cb(id));
	},
	sessionMessages: (
		path: string,
		options?: { limit?: number; before?: number },
	): Promise<{ messages: Record<string, unknown>[]; start: number; userStart: number }> =>
		ipcRenderer.invoke("app:session-messages", path, options),
	sessionDelete: (path: string): Promise<AgentCallResult> => ipcRenderer.invoke("app:session-delete", path),
	wipeLocalData: (): Promise<AgentCallResult> => ipcRenderer.invoke("app:wipe-local-data"),
	titlebar: (theme: string, dimmed?: boolean): Promise<void> => ipcRenderer.invoke("app:titlebar", theme, dimmed),
	linkPreview: (url: string): Promise<unknown> => ipcRenderer.invoke("app:link-preview", url),
	openProject: (path: string): Promise<AgentCallResult> => ipcRenderer.invoke("app:open-project", path),
	pickFolder: (): Promise<AgentCallResult> => ipcRenderer.invoke("app:pick-folder"),
	recentProjects: (): Promise<string[]> => ipcRenderer.invoke("app:recent-projects"),
	projectFiles: (query: string): Promise<string[]> => ipcRenderer.invoke("app:project-files", query),
	repoUrl: (dir?: string): Promise<string | undefined> => ipcRenderer.invoke("app:repo-url", dir),
	closeProject: (): Promise<AgentCallResult> => ipcRenderer.invoke("app:close-project"),
	folders: (): Promise<string[]> => ipcRenderer.invoke("app:folders"),
	updateState: (): Promise<unknown> => ipcRenderer.invoke("app:update-state"),
	updateCheck: (): Promise<AgentCallResult> => ipcRenderer.invoke("app:update-check"),
	updateInstall: (): Promise<AgentCallResult> => ipcRenderer.invoke("app:update-install"),
	onUpdateState: (cb: (state: unknown) => void): void => {
		ipcRenderer.on("update:state", (_e, state: unknown) => cb(state));
	},
	authList: (): Promise<string[]> => ipcRenderer.invoke("app:auth-list"),
	knownProviders: (): Promise<{ id: string; name: string; apiKey: boolean; oauth: boolean }[]> =>
		ipcRenderer.invoke("app:known-providers"),
	authSet: (provider: string, key: string): Promise<AgentCallResult> =>
		ipcRenderer.invoke("app:auth-set", provider, key),
	authRemove: (provider: string): Promise<AgentCallResult> => ipcRenderer.invoke("app:auth-remove", provider),
	providersList: (): Promise<unknown[]> => ipcRenderer.invoke("app:providers-list"),
	llamaStatus: (): Promise<unknown> => ipcRenderer.invoke("app:llama-sizeup"),
	llamaLaunch: (): Promise<unknown> => ipcRenderer.invoke("app:llama-launch"),
	poolRemove: (provider: string, credentialId: string): Promise<AgentCallResult> =>
		ipcRenderer.invoke("app:pool-remove", provider, credentialId),
	poolRelabel: (provider: string, credentialId: string, label: string): Promise<AgentCallResult> =>
		ipcRenderer.invoke("app:pool-relabel", provider, credentialId, label),
	poolAddKey: (provider: string, key: string, label: string): Promise<AgentCallResult> =>
		ipcRenderer.invoke("app:pool-add-key", provider, key, label),
	poolSetPooled: (provider: string, pooled: boolean): Promise<AgentCallResult> =>
		ipcRenderer.invoke("app:pool-set-pooled", provider, pooled),
	openCli: (): Promise<AgentCallResult> => ipcRenderer.invoke("app:open-cli"),
	addFolder: (path: string): Promise<AgentCallResult> => ipcRenderer.invoke("app:add-folder", path),
	popupMenu: (x: number, y: number): Promise<AgentCallResult> => ipcRenderer.invoke("app:menu-popup", x, y),
	onMenuCommand: (cb: (command: string) => void): void => {
		ipcRenderer.on("menu:command", (_e, command: string) => cb(command));
	},
	copyText: (text: string): Promise<AgentCallResult> => ipcRenderer.invoke("app:copy", text),
	reveal: (target: string, how?: string): Promise<AgentCallResult> => ipcRenderer.invoke("app:reveal", target, how),
	micAccess: (): Promise<AgentCallResult> => ipcRenderer.invoke("app:mic-access"),
	openMicSettings: (): Promise<AgentCallResult> => ipcRenderer.invoke("app:open-mic-settings"),
	speechStatus: (): Promise<unknown> => ipcRenderer.invoke("speech:status"),
	speechPrepare: (): Promise<AgentCallResult> => ipcRenderer.invoke("speech:prepare"),
	speechTranscribe: (samples: ArrayBuffer): Promise<AgentCallResult> =>
		ipcRenderer.invoke("speech:transcribe", samples),
	onSpeechProgress: (cb: (progress: unknown) => void): void => {
		ipcRenderer.on("speech:progress", (_e, progress) => cb(progress));
	},
	stats: (): Promise<AgentCallResult> => ipcRenderer.invoke("app:stats"),
	starters: (): Promise<AgentCallResult> => ipcRenderer.invoke("app:starters"),
	diff: (): Promise<AgentCallResult> => ipcRenderer.invoke("app:diff"),
	diffStats: (): Promise<AgentCallResult> => ipcRenderer.invoke("app:diff-stats"),
	prReadiness: (): Promise<AgentCallResult> => ipcRenderer.invoke("app:pr-readiness"),
	prCreate: (draft: boolean): Promise<AgentCallResult> => ipcRenderer.invoke("app:pr-create", draft),
	permissionMode: (mode?: string): Promise<AgentCallResult> => ipcRenderer.invoke("app:permission-mode", mode),
	worktrees: (): Promise<AgentCallResult> => ipcRenderer.invoke("app:worktrees"),
	branches: (): Promise<AgentCallResult> => ipcRenderer.invoke("app:branches"),
	branchCheckout: (branch: string): Promise<AgentCallResult> => ipcRenderer.invoke("app:branch-checkout", branch),
	worktreeCreate: (label: string): Promise<AgentCallResult> => ipcRenderer.invoke("app:worktree-create", label),
	worktreeEnter: (path: string): Promise<AgentCallResult> => ipcRenderer.invoke("app:worktree-enter", path),
	worktreeRemove: (path: string, force?: boolean): Promise<AgentCallResult> =>
		ipcRenderer.invoke("app:worktree-remove", path, force),
	sideCall: (method: string, ...args: unknown[]): Promise<AgentCallResult> =>
		ipcRenderer.invoke("side:call", method, args),
	sideStop: (): Promise<AgentCallResult> => ipcRenderer.invoke("side:stop"),
	onSideEvent: (cb: (event: unknown) => void): void => {
		ipcRenderer.on("side:event", (_e, event) => cb(event));
	},
	activeSlot: (): Promise<number> => ipcRenderer.invoke("app:active-slot"),
	onEvent: (cb: (event: unknown, slot: number) => void): void => {
		ipcRenderer.on("agent:event", (_e, event, slot) => cb(event, slot));
	},
	onAttached: (cb: (slot: number) => void): void => {
		ipcRenderer.on("agent:attached", (_e, slot) => cb(slot));
	},
	onStarted: (cb: (status: { running: boolean; error: string | null }) => void): void => {
		ipcRenderer.on("agent:started", (_e, status) => cb(status));
	},
	onBusySessions: (cb: (paths: string[]) => void): void => {
		ipcRenderer.on("agent:busy", (_e, paths) => cb(paths));
	},
	onBackgroundSettled: (cb: (info: { sessionPath: string }) => void): void => {
		ipcRenderer.on("agent:background-settled", (_e, info) => cb(info));
	},
	onAgentExited: (cb: (info: { slotId: number; wasActive: boolean; code: number | null }) => void): void => {
		ipcRenderer.on("agent:exited", (_e, info) => cb(info));
	},
	onTurnDropped: (cb: (info: { sessionPath: string; cwd: string; to: string }) => void): void => {
		ipcRenderer.on("agent:turn-dropped", (_e, info) => cb(info));
	},
	onReloadDeferred: (cb: (info: { sessionPath: string }) => void): void => {
		ipcRenderer.on("agent:reload-deferred", (_e, info) => cb(info));
	},
	onSessionChanged: (cb: (info: { slot: number; path: string }) => void): void => {
		ipcRenderer.on("session:changed", (_e, info) => cb(info));
	},
	webServer: (): Promise<unknown> => ipcRenderer.invoke("app:web-server"),
	setWebServer: (enabled: boolean): Promise<unknown> => ipcRenderer.invoke("app:web-server-set", enabled),
	ready: (): void => ipcRenderer.send("renderer:ready"),
});
