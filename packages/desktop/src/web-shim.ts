/**
 * `window.smolt` for a browser: the preload's API over the web server's
 * POST /invoke and SSE /events instead of Electron IPC. Built to
 * dist/webshim.js and injected ahead of renderer.js by the web server.
 *
 * Every method in preload.ts has a twin here — a test holds the two key
 * sets equal — but a few cannot mean the same thing without a window:
 * the titlebar, the folder picker, the context menu and the mic prompt are
 * answered locally, and the clipboard goes through the browser's own.
 */

type Listener = (...args: unknown[]) => void;
const listeners: Record<string, Listener[]> = {};

function sub(channel: string): (cb: Listener) => void {
	return (cb) => {
		const list = listeners[channel] ?? [];
		list.push(cb);
		listeners[channel] = list;
	};
}

function connect(): void {
	if (typeof EventSource === "undefined") return;
	const source = new EventSource("events");
	source.onmessage = (event) => {
		const { channel, args } = JSON.parse(event.data) as { channel: string; args: unknown[] };
		for (const cb of listeners[channel] ?? []) cb(...args);
	};
	source.onerror = () => {
		source.close();
		setTimeout(connect, 1500);
	};
}
connect();

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
	const response = await fetch("invoke", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ channel, args }),
	});
	const data = (await response.json()) as { value?: unknown; error?: string };
	if (data.error) throw new Error(data.error);
	return data.value;
}

function send(channel: string, ...args: unknown[]): void {
	void fetch("send", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ channel, args }),
	});
}

export const smoltWebApi = {
	call: (method: string, ...args: unknown[]) => invoke("agent:call", method, args),
	status: () => invoke("agent:status"),
	sessions: (query?: string) => invoke("app:sessions", query),
	info: () => invoke("app:info"),
	pendingApprovals: () => invoke("app:pending-approvals"),
	permissionReply: (id: string, answer: string) => invoke("app:permission-reply", id, answer),
	onPermissionRequest: sub("permission:request"),
	onPermissionRemoved: sub("permission:removed"),
	sessionMessages: (path: string, options?: unknown) => invoke("app:session-messages", path, options),
	sessionDelete: (path: string) => invoke("app:session-delete", path),
	wipeLocalData: () => invoke("app:wipe-local-data"),
	titlebar: async () => undefined,
	linkPreview: (url: string) => invoke("app:link-preview", url),
	openProject: (path: string) => invoke("app:open-project", path),
	pickFolder: async () => ({ ok: false, error: "not available in a browser" }),
	recentProjects: () => invoke("app:recent-projects"),
	repoUrl: (dir?: string) => invoke("app:repo-url", dir),
	closeProject: () => invoke("app:close-project"),
	folders: () => invoke("app:folders"),
	updateState: () => invoke("app:update-state"),
	updateCheck: () => invoke("app:update-check"),
	updateInstall: () => invoke("app:update-install"),
	onUpdateState: sub("update:state"),
	authList: () => invoke("app:auth-list"),
	knownProviders: () => invoke("app:known-providers"),
	authSet: (provider: string, key: string) => invoke("app:auth-set", provider, key),
	authRemove: (provider: string) => invoke("app:auth-remove", provider),
	providersList: () => invoke("app:providers-list"),
	llamaStatus: () => invoke("app:llama-sizeup"),
	llamaLaunch: () => invoke("app:llama-launch"),
	poolRemove: (provider: string, credentialId: string) => invoke("app:pool-remove", provider, credentialId),
	poolRelabel: (provider: string, credentialId: string, label: string) =>
		invoke("app:pool-relabel", provider, credentialId, label),
	poolAddKey: (provider: string, key: string, label: string) => invoke("app:pool-add-key", provider, key, label),
	poolSetPooled: (provider: string, pooled: boolean) => invoke("app:pool-set-pooled", provider, pooled),
	openCli: () => invoke("app:open-cli"),
	addFolder: (path: string) => invoke("app:add-folder", path),
	popupMenu: async () => ({ ok: true }),
	onMenuCommand: sub("menu:command"),
	copyText: async (text: string) => {
		try {
			await navigator.clipboard.writeText(text);
			return { ok: true };
		} catch (error) {
			return { ok: false, error: String(error) };
		}
	},
	reveal: (target: string, how?: string) => invoke("app:reveal", target, how),
	micAccess: async () => ({ ok: true, value: { status: "granted" } }),
	openMicSettings: async () => ({ ok: false }),
	speechStatus: () => invoke("speech:status"),
	speechPrepare: () => invoke("speech:prepare"),
	// Speech runs in the real main process; only the samples need care,
	// since JSON has no binary: they go over base64.
	speechTranscribe: async (samples: ArrayBuffer) => {
		const bytes = new Uint8Array(samples);
		let binary = "";
		const CHUNK = 0x8000;
		for (let index = 0; index < bytes.length; index += CHUNK) {
			binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(index, index + CHUNK)));
		}
		return invoke("speech:transcribe", btoa(binary));
	},
	onSpeechProgress: sub("speech:progress"),
	stats: () => invoke("app:stats"),
	starters: () => invoke("app:starters"),
	diff: () => invoke("app:diff"),
	diffStats: () => invoke("app:diff-stats"),
	prReadiness: () => invoke("app:pr-readiness"),
	prCreate: (draft: boolean) => invoke("app:pr-create", draft),
	permissionMode: (mode?: string) => invoke("app:permission-mode", mode),
	worktrees: () => invoke("app:worktrees"),
	branches: () => invoke("app:branches"),
	branchCheckout: (branch: string) => invoke("app:branch-checkout", branch),
	worktreeCreate: (label: string) => invoke("app:worktree-create", label),
	worktreeEnter: (path: string) => invoke("app:worktree-enter", path),
	worktreeRemove: (path: string, force?: boolean) => invoke("app:worktree-remove", path, force),
	sideCall: (method: string, ...args: unknown[]) => invoke("side:call", method, args),
	sideStop: () => invoke("side:stop"),
	onSideEvent: sub("side:event"),
	activeSlot: () => invoke("app:active-slot"),
	onEvent: sub("agent:event"),
	onAttached: sub("agent:attached"),
	onStarted: sub("agent:started"),
	onBusySessions: sub("agent:busy"),
	onBackgroundSettled: sub("agent:background-settled"),
	onAgentExited: sub("agent:exited"),
	onTurnDropped: sub("agent:turn-dropped"),
	onReloadDeferred: sub("agent:reload-deferred"),
	onSessionChanged: sub("session:changed"),
	webServer: () => invoke("app:web-server"),
	setWebServer: (enabled: boolean) => invoke("app:web-server-set", enabled),
	ready: () => send("renderer:ready"),
};

if (typeof window !== "undefined") {
	(window as unknown as { smolt: unknown }).smolt = smoltWebApi;
}
