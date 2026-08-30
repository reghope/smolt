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
	sessions: (): Promise<unknown[]> => ipcRenderer.invoke("app:sessions"),
	info: (): Promise<{ cwd: string; version: string }> => ipcRenderer.invoke("app:info"),
	transcribe: (audio: ArrayBuffer, mimeType: string): Promise<AgentCallResult> =>
		ipcRenderer.invoke("app:transcribe", audio, mimeType),
	pendingApprovals: (): Promise<unknown[]> => ipcRenderer.invoke("app:pending-approvals"),
	permissionReply: (id: string, answer: string): Promise<AgentCallResult> =>
		ipcRenderer.invoke("app:permission-reply", id, answer),
	onPermissionRequest: (cb: (request: unknown) => void): void => {
		ipcRenderer.on("permission:request", (_e, request) => cb(request));
	},
	sessionMessages: (path: string): Promise<Record<string, unknown>[]> =>
		ipcRenderer.invoke("app:session-messages", path),
	sessionDelete: (path: string): Promise<AgentCallResult> => ipcRenderer.invoke("app:session-delete", path),
	titlebar: (theme: string): Promise<void> => ipcRenderer.invoke("app:titlebar", theme),
	linkPreview: (url: string): Promise<unknown> => ipcRenderer.invoke("app:link-preview", url),
	openProject: (path: string): Promise<AgentCallResult> => ipcRenderer.invoke("app:open-project", path),
	pickFolder: (): Promise<AgentCallResult> => ipcRenderer.invoke("app:pick-folder"),
	recentProjects: (): Promise<string[]> => ipcRenderer.invoke("app:recent-projects"),
	closeProject: (): Promise<AgentCallResult> => ipcRenderer.invoke("app:close-project"),
	folders: (): Promise<string[]> => ipcRenderer.invoke("app:folders"),
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
	diff: (): Promise<AgentCallResult> => ipcRenderer.invoke("app:diff"),
	permissionMode: (mode?: string): Promise<AgentCallResult> => ipcRenderer.invoke("app:permission-mode", mode),
	worktrees: (): Promise<AgentCallResult> => ipcRenderer.invoke("app:worktrees"),
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
	onEvent: (cb: (event: unknown) => void): void => {
		ipcRenderer.on("agent:event", (_e, event) => cb(event));
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
	ready: (): void => ipcRenderer.send("renderer:ready"),
});
