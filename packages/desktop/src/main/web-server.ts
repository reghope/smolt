import { spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { networkInterfaces } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { type BrowserWindow, ipcMain } from "electron";

/**
 * The app in a browser: a small HTTP server inside the running desktop
 * process that serves the renderer bundle and bridges `window.smolt` over
 * POST /invoke and an SSE stream at /events.
 *
 * It grew out of `.smolt/webhost/host.cjs`, which ran a second copy of the
 * main process under plain Node with a faked `electron` module. Running
 * inside the real process instead means one agent bridge, one set of
 * chats, one speech model — the browser is another window on the same app,
 * not another app on the same data.
 *
 * Reach: the server binds to localhost and, when one exists, the machine's
 * Tailscale address, so the tailnet can open it and the LAN cannot. The
 * `lan` setting binds every interface instead. There is no login: whoever
 * can reach the port drives the agent, with the shell it has.
 *
 * HTTPS rides beside HTTP on the next port up, with a self-signed
 * certificate made by openssl on first use; the microphone exists only in
 * a secure context, so dictation needs it. No openssl means HTTP only.
 */

export interface WebServerSettings {
	enabled: boolean;
	/** HTTP port; HTTPS listens on port + 1. */
	port: number;
	/** Bind every interface, not just localhost and Tailscale. */
	lan: boolean;
}

export interface WebServerState {
	enabled: boolean;
	running: boolean;
	https: boolean;
	/** Where to open it, best first. */
	urls: string[];
	error?: string;
}

export const DEFAULT_WEB_PORT = 7332;

// ---------------------------------------------------------------- ipc tap

type InvokeHandler = (event: unknown, ...args: unknown[]) => unknown;
type SendListener = (event: unknown, ...args: unknown[]) => void;

const invokeHandlers = new Map<string, InvokeHandler>();
const sendListeners = new Map<string, SendListener[]>();
let tapped = false;

/**
 * Record every IPC handler the main process registers, so a browser client
 * can call the same functions the window does. Must run before any
 * `ipcMain.handle` — main.ts calls it at import time.
 */
export function tapIpc(): void {
	if (tapped) return;
	tapped = true;
	const handle = ipcMain.handle.bind(ipcMain);
	ipcMain.handle = ((channel: string, listener: InvokeHandler) => {
		invokeHandlers.set(channel, listener);
		return handle(channel, listener as never);
	}) as typeof ipcMain.handle;
	const on = ipcMain.on.bind(ipcMain);
	ipcMain.on = ((channel: string, listener: SendListener) => {
		const list = sendListeners.get(channel) ?? [];
		list.push(listener);
		sendListeners.set(channel, list);
		return on(channel, listener as never);
	}) as typeof ipcMain.on;
}

// ---------------------------------------------------------------- settings

export function readWebServerSettings(path: string): WebServerSettings {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<WebServerSettings>;
		return {
			enabled: parsed.enabled === true,
			port: typeof parsed.port === "number" && parsed.port > 0 ? Math.floor(parsed.port) : DEFAULT_WEB_PORT,
			lan: parsed.lan === true,
		};
	} catch {
		return { enabled: false, port: DEFAULT_WEB_PORT, lan: false };
	}
}

export function writeWebServerSettings(path: string, settings: WebServerSettings): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}

// ---------------------------------------------------------------- addresses

/** The machine's Tailscale IPv4, if it has one: the CGNAT range Tailscale hands out. */
export function tailscaleAddress(): string | undefined {
	for (const entries of Object.values(networkInterfaces())) {
		for (const entry of entries ?? []) {
			if (entry.family !== "IPv4" || entry.internal) continue;
			const [a, b] = entry.address.split(".").map(Number);
			if (a === 100 && b !== undefined && b >= 64 && b <= 127) return entry.address;
		}
	}
	return undefined;
}

function lanAddresses(): string[] {
	const found: string[] = [];
	for (const entries of Object.values(networkInterfaces())) {
		for (const entry of entries ?? []) {
			if (entry.family === "IPv4" && !entry.internal) found.push(entry.address);
		}
	}
	return found;
}

// ---------------------------------------------------------------- certificate

function findOpenssl(): string[] {
	const candidates = ["openssl"];
	if (process.platform === "win32") {
		const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
		candidates.push(
			join(programFiles, "Git", "usr", "bin", "openssl.exe"),
			join(programFiles, "Git", "mingw64", "bin", "openssl.exe"),
		);
	}
	return candidates;
}

function run(command: string, args: string[]): Promise<boolean> {
	return new Promise((resolve) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, args, { stdio: "ignore", windowsHide: true });
		} catch {
			resolve(false);
			return;
		}
		child.on("error", () => resolve(false));
		child.on("exit", (code) => resolve(code === 0));
	});
}

/**
 * A self-signed certificate naming every address the server answers on,
 * regenerated when that list changes (a new Tailscale address, say). The
 * browser warns once per certificate; a stable one is warned about once.
 */
async function ensureCertificate(dir: string, names: string[]): Promise<{ key: Buffer; cert: Buffer } | undefined> {
	const keyPath = join(dir, "key.pem");
	const certPath = join(dir, "cert.pem");
	const sanPath = join(dir, "san.txt");
	const san = names.join(",");
	const existing = (): { key: Buffer; cert: Buffer } | undefined =>
		existsSync(keyPath) && existsSync(certPath)
			? { key: readFileSync(keyPath), cert: readFileSync(certPath) }
			: undefined;
	let recorded = "";
	try {
		recorded = readFileSync(sanPath, "utf-8").trim();
	} catch {
		// No record: generate.
	}
	if (recorded === san) {
		const found = existing();
		if (found) return found;
	}
	mkdirSync(dir, { recursive: true });
	for (const openssl of findOpenssl()) {
		const made = await run(openssl, [
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-keyout",
			keyPath,
			"-out",
			certPath,
			"-days",
			"825",
			"-subj",
			"/CN=smolt web server",
			"-addext",
			`subjectAltName=${san}`,
		]);
		if (made) {
			writeFileSync(sanPath, `${san}\n`, "utf-8");
			return existing();
		}
	}
	// No openssl: an older certificate still beats none.
	return existing();
}

// ---------------------------------------------------------------- browser layer

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".map": "application/json",
	".json": "application/json",
	".png": "image/png",
	".svg": "image/svg+xml",
	".woff2": "font/woff2",
};

const MOBILE_CSS = `
/* Browser: no native File/Edit/View/Help menu exists, so the titlebar
   hamburger (the frameless-window menu entry point) is dead weight. */
div.app-drag button[aria-label="Menu"] { display: none !important; }

/* No OS window controls either, so reclaim the titlebar reserves. */
div.app-drag.fixed { padding-left: 8px !important; padding-right: 8px !important; }
div.app-drag .right-\\[148px\\] { right: 8px !important; }

html, body { overscroll-behavior: none; }

@media (max-width: 700px) {
	/* The sidebar becomes an overlay drawer instead of a squeezing column.
	   Closed is inline width:0px; open gets a fixed sheet with a backdrop. */
	aside[data-sidebar][style*="width: 0"] { display: none; }
	aside[data-sidebar]:not([style*="width: 0"]) {
		position: fixed !important;
		top: 0; bottom: 0; left: 0;
		z-index: 70;
		width: min(85vw, 320px) !important;
		max-width: 85vw !important;
		box-shadow: 0 0 0 100vmax rgba(0, 0, 0, 0.45);
	}
	/* Keep the transcript readable and the composer reachable. */
	main { padding-left: env(safe-area-inset-left); padding-right: env(safe-area-inset-right); }
}

@media (pointer: coarse) {
	/* Prevent iOS focus zoom: form fields must be at least 16px. */
	textarea, input, [contenteditable] { font-size: 16px !important; }
	/* Drag-to-resize edges are meaningless on touch and steal edge swipes. */
	[aria-label*="Resize"], [aria-label*="Drag to open"] { display: none !important; }
	/* Hover-revealed row actions must simply be visible. */
	[class*="group-hover/session:opacity-100"] { opacity: 1 !important; }
	/* Comfortable touch targets in the titlebar. */
	div.app-drag button { min-width: 34px; min-height: 34px; }
}
`;

const MOBILE_JS = `(() => {
const narrow = () => window.matchMedia("(max-width: 700px)").matches;
const drawerOpen = () => {
	const aside = document.querySelector("aside[data-sidebar]");
	return aside && !/width:\\s*0px/.test(aside.getAttribute("style") || "");
};
const toggleSidebar = () =>
	document.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true }));
// Tap outside the open drawer closes it; picking a session closes it too.
document.addEventListener("click", (e) => {
	if (!narrow() || !drawerOpen()) return;
	const t = e.target instanceof Element ? e.target : null;
	if (!t) return;
	const inside = t.closest("aside[data-sidebar]");
	if (!inside) { toggleSidebar(); return; }
	if (t.closest('[class*="group/session"]') && !t.closest("input, textarea")) {
		setTimeout(toggleSidebar, 50);
	}
}, true);
})();
`;

/** The desktop's index.html with the browser shim, the mobile layer, and a viewport. */
function indexHtml(dist: string): string {
	let html = readFileSync(join(dist, "index.html"), "utf8");
	html = html.replace(
		"<title>",
		'<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />\n\t<title>',
	);
	html = html.replace(
		'<link rel="stylesheet" href="styles.css" />',
		'<link rel="stylesheet" href="styles.css" />\n\t<link rel="stylesheet" href="mobile.css" />\n\t<meta name="theme-color" content="#0a0b0e" />\n\t<meta name="apple-mobile-web-app-capable" content="yes" />',
	);
	html = html.replace(
		'<script src="renderer.js"></script>',
		'<script src="webshim.js"></script>\n\t<script src="renderer.js"></script>\n\t<script src="mobile.js"></script>',
	);
	return html;
}

function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let body = "";
		req.on("data", (chunk: Buffer | string) => {
			body += chunk;
		});
		req.on("end", () => resolve(body));
		req.on("error", reject);
	});
}

// ---------------------------------------------------------------- server

export interface WebServerOptions {
	/** The built renderer: index.html, renderer.js, styles.css, webshim.js. */
	dist: string;
	/** Where the certificate lives. */
	dataDir: string;
	settingsPath: string;
}

export class WebServer {
	private readonly options: WebServerOptions;
	private servers: (http.Server | https.Server)[] = [];
	private readonly clients = new Set<http.ServerResponse>();
	private urls: string[] = [];
	private httpsOn = false;
	private error: string | undefined;
	private keepAlive: NodeJS.Timeout | undefined;

	constructor(options: WebServerOptions) {
		this.options = options;
	}

	settings(): WebServerSettings {
		return readWebServerSettings(this.options.settingsPath);
	}

	state(): WebServerState {
		return {
			enabled: this.settings().enabled,
			running: this.servers.length > 0,
			https: this.httpsOn,
			urls: [...this.urls],
			...(this.error ? { error: this.error } : {}),
		};
	}

	/** Flip the setting and make the server match it. */
	async setEnabled(enabled: boolean): Promise<WebServerState> {
		writeWebServerSettings(this.options.settingsPath, { ...this.settings(), enabled });
		if (enabled) await this.start();
		else await this.stop();
		return this.state();
	}

	/**
	 * Everything the window is sent, the browsers are sent too. The wrap is
	 * on the instance, so every `win.webContents.send` in main.ts feeds it.
	 */
	mirror(win: BrowserWindow): void {
		const contents = win.webContents;
		const send = contents.send.bind(contents);
		contents.send = ((channel: string, ...args: unknown[]) => {
			send(channel, ...args);
			this.broadcast(channel, args);
		}) as typeof contents.send;
	}

	broadcast(channel: string, args: unknown[]): void {
		if (this.clients.size === 0) return;
		let data: string;
		try {
			data = `data: ${JSON.stringify({ channel, args })}\n\n`;
		} catch {
			return;
		}
		for (const client of this.clients) client.write(data);
	}

	async start(): Promise<void> {
		if (this.servers.length > 0) return;
		this.error = undefined;
		const settings = this.settings();
		const tailscale = tailscaleAddress();
		const addresses = settings.lan ? ["0.0.0.0"] : ["127.0.0.1", ...(tailscale ? [tailscale] : [])];
		const names = ["DNS:localhost", "IP:127.0.0.1", ...(tailscale ? [`IP:${tailscale}`] : [])];
		if (settings.lan) for (const address of lanAddresses()) names.push(`IP:${address}`);
		const cert = await ensureCertificate(this.options.dataDir, [...new Set(names)]);
		this.httpsOn = cert !== undefined;
		const handler = this.handler(settings.port);
		const started: (http.Server | https.Server)[] = [];
		try {
			for (const address of addresses) {
				started.push(await listen(http.createServer(handler), settings.port, address));
				if (cert) started.push(await listen(https.createServer(cert, handler), settings.port + 1, address));
			}
		} catch (error) {
			for (const server of started) server.close();
			const message = error instanceof Error ? error.message : String(error);
			this.error = /EADDRINUSE/.test(message)
				? `Port ${settings.port} or ${settings.port + 1} is already in use — another web host is running.`
				: message;
			throw new Error(this.error);
		}
		this.servers = started;
		const hosts = settings.lan
			? [...(tailscale ? [tailscale] : []), ...lanAddresses(), "localhost"]
			: [...(tailscale ? [tailscale] : []), "localhost"];
		this.urls = [...new Set(hosts)].map((host) =>
			cert ? `https://${host}:${settings.port + 1}` : `http://${host}:${settings.port}`,
		);
		// A comment line every so often keeps idle SSE connections open
		// through proxies and mobile radios that drop silent sockets.
		this.keepAlive = setInterval(() => {
			for (const client of this.clients) client.write(": keep-alive\n\n");
		}, 25_000);
	}

	async stop(): Promise<void> {
		if (this.keepAlive) clearInterval(this.keepAlive);
		this.keepAlive = undefined;
		for (const client of this.clients) client.end();
		this.clients.clear();
		const closing = this.servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())));
		this.servers = [];
		this.urls = [];
		await Promise.all(closing);
	}

	private handler(port: number): http.RequestListener {
		const { dist } = this.options;
		return async (req, res) => {
			const url = (req.url ?? "/").split("?")[0] ?? "/";
			try {
				const navigation =
					req.method === "GET" &&
					(url === "/" || url === "/index.html") &&
					String(req.headers.accept ?? "").includes("text/html");
				// HTTPS is the entry: a plain-HTTP navigation is bounced to the
				// TLS twin so the mic (secure-context-only) works. Everything else
				// keeps serving on HTTP so an open HTTP page does not break.
				if (navigation && this.httpsOn && !(req.socket as { encrypted?: boolean }).encrypted) {
					const host = req.headers.host ?? `localhost:${port}`;
					const tlsHost = host.replace(new RegExp(`:${port}$`), `:${port + 1}`);
					res.writeHead(302, { location: `https://${tlsHost}/` });
					res.end();
					return;
				}
				if (req.method === "GET" && (url === "/" || url === "/index.html")) {
					res.writeHead(200, { "content-type": MIME[".html"] });
					res.end(indexHtml(dist));
				} else if (req.method === "GET" && url === "/mobile.css") {
					res.writeHead(200, { "content-type": MIME[".css"] });
					res.end(MOBILE_CSS);
				} else if (req.method === "GET" && url === "/mobile.js") {
					res.writeHead(200, { "content-type": MIME[".js"] });
					res.end(MOBILE_JS);
				} else if (req.method === "GET" && url === "/events") {
					res.writeHead(200, {
						"content-type": "text/event-stream",
						"cache-control": "no-cache",
						connection: "keep-alive",
					});
					res.write(": connected\n\n");
					this.clients.add(res);
					res.on("close", () => this.clients.delete(res));
				} else if (req.method === "POST" && url === "/invoke") {
					const body = JSON.parse(await readBody(req)) as { channel?: string; args?: unknown[] };
					const channel = String(body.channel ?? "");
					let args = Array.isArray(body.args) ? body.args : [];
					// Samples arrive base64-encoded (JSON has no binary); the
					// transcribe handler expects an ArrayBuffer of float32.
					if (channel === "speech:transcribe") {
						const buf = Buffer.from(String(args[0] ?? ""), "base64");
						args = [buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)];
					}
					const handle = invokeHandlers.get(channel);
					if (!handle) {
						res.writeHead(404, { "content-type": "application/json" });
						res.end(JSON.stringify({ error: `no handler: ${channel}` }));
						return;
					}
					try {
						const value = await handle({}, ...args);
						res.writeHead(200, { "content-type": "application/json" });
						res.end(JSON.stringify({ value: value === undefined ? null : value }));
					} catch (error) {
						res.writeHead(200, { "content-type": "application/json" });
						res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
					}
				} else if (req.method === "POST" && url === "/send") {
					const body = JSON.parse(await readBody(req)) as { channel?: string; args?: unknown[] };
					const args = Array.isArray(body.args) ? body.args : [];
					for (const listener of sendListeners.get(String(body.channel ?? "")) ?? []) listener({}, ...args);
					res.writeHead(204);
					res.end();
				} else if (req.method === "GET") {
					const file = join(dist, normalize(url).replace(/^([\\/])+/, ""));
					if (file.startsWith(dist) && existsSync(file) && statSync(file).isFile()) {
						res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
						createReadStream(file).pipe(res);
					} else {
						res.writeHead(404);
						res.end();
					}
				} else {
					res.writeHead(404);
					res.end();
				}
			} catch (error) {
				res.writeHead(500, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
			}
		};
	}
}

function listen<T extends http.Server | https.Server>(server: T, port: number, address: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error): void => reject(error);
		server.once("error", onError);
		server.listen(port, address, () => {
			server.off("error", onError);
			resolve(server);
		});
	});
}
