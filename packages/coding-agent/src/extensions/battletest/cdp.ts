import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * A minimal Chrome DevTools Protocol driver for battletest's `browse` tool.
 *
 * Before this existed, every tester burned its opening actions hand-rolling
 * the same headless-browser harness: find Chrome, script the WebSocket,
 * relearn the protocol. Now the harness is code and a tester's action budget
 * is spent on testing. One driver per tester, on its own debugging port and
 * profile directory, locked to its persona's viewport.
 *
 * Dependency-free on purpose: global fetch for target discovery and the
 * global WebSocket (Node 22+) for the protocol itself.
 */

export interface BrowseViewport {
	width: number;
	height: number;
	deviceScaleFactor: number;
	mobile: boolean;
}

export const VIEWPORT_PRESETS: Record<"desktop" | "mobile" | "tablet", BrowseViewport> = {
	desktop: { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
	mobile: { width: 375, height: 812, deviceScaleFactor: 3, mobile: true },
	tablet: { width: 768, height: 1024, deviceScaleFactor: 2, mobile: false },
};

export interface PageState {
	url: string;
	title: string;
	/** Console errors/warnings and uncaught exceptions since the last drain. */
	console: string[];
}

/** What the browse tool drives. Injectable so tests never need a browser. */
export interface BrowseDriver {
	goto(url: string): Promise<void>;
	clickSelector(selector: string): Promise<string>;
	clickAt(x: number, y: number): Promise<void>;
	type(text: string): Promise<void>;
	press(key: string): Promise<void>;
	scroll(dy: number): Promise<void>;
	eval(js: string): Promise<string>;
	setViewport(viewport: BrowseViewport): Promise<void>;
	/** Base64 JPEG of the current viewport — sized by the viewport, not the page. */
	screenshot(): Promise<string>;
	state(): Promise<PageState>;
	dispose(): void;
}

export interface BrowseLaunchOptions {
	port: number;
	userDataDir: string;
	viewport: BrowseViewport;
}

export type BrowseDriverFactory = (options: BrowseLaunchOptions) => Promise<BrowseDriver>;

const NAV_TIMEOUT_MS = 10_000;
const SETTLE_MS = 400;

/** Common keys a user actually presses, mapped to Windows virtual key codes. */
const KEY_CODES: Record<string, number> = {
	Enter: 13,
	Tab: 9,
	Escape: 27,
	Backspace: 8,
	Delete: 46,
	ArrowLeft: 37,
	ArrowUp: 38,
	ArrowRight: 39,
	ArrowDown: 40,
	PageUp: 33,
	PageDown: 34,
	Home: 36,
	End: 35,
	Space: 32,
};

function findBrowserBinary(): string | undefined {
	if (process.platform === "win32") {
		const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
		const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
		const localAppData = process.env.LOCALAPPDATA ?? "";
		const candidates = [
			join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
			join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
			join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
			join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
			join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
		];
		return candidates.find((candidate) => existsSync(candidate));
	}
	if (process.platform === "darwin") {
		const candidates = [
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		];
		return candidates.find((candidate) => existsSync(candidate));
	}
	// Linux: rely on PATH.
	return "google-chrome";
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

class CdpDriver implements BrowseDriver {
	private ws: WebSocket;
	private proc: ChildProcess;
	private nextId = 1;
	private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	private consoleBuffer: string[] = [];
	private loadFired = false;
	private viewport: BrowseViewport;

	private constructor(ws: WebSocket, proc: ChildProcess, viewport: BrowseViewport) {
		this.ws = ws;
		this.proc = proc;
		this.viewport = viewport;
	}

	static async launch(options: BrowseLaunchOptions): Promise<CdpDriver> {
		if (typeof WebSocket === "undefined") {
			throw new Error("global WebSocket unavailable (Node 22+ required)");
		}
		const binary = findBrowserBinary();
		if (!binary) throw new Error("no Chrome or Edge binary found");
		mkdirSync(options.userDataDir, { recursive: true });
		const proc = spawn(
			binary,
			[
				"--headless=new",
				"--disable-gpu",
				"--no-first-run",
				"--no-default-browser-check",
				"--hide-scrollbars",
				`--remote-debugging-port=${options.port}`,
				`--user-data-dir=${options.userDataDir}`,
				`--window-size=${options.viewport.width},${options.viewport.height}`,
				"about:blank",
			],
			{ stdio: "ignore" },
		);

		// The DevTools endpoint takes a moment to come up; poll for the page target.
		let wsUrl: string | undefined;
		const deadline = Date.now() + 15_000;
		while (!wsUrl && Date.now() < deadline) {
			await sleep(250);
			try {
				const response = await fetch(`http://127.0.0.1:${options.port}/json/list`);
				const targets = (await response.json()) as { type?: string; webSocketDebuggerUrl?: string }[];
				wsUrl = targets.find(
					(target) => target.type === "page" && target.webSocketDebuggerUrl,
				)?.webSocketDebuggerUrl;
			} catch {
				// Not listening yet.
			}
		}
		if (!wsUrl) {
			proc.kill();
			throw new Error(`browser started but no debuggable page appeared on port ${options.port}`);
		}

		const ws = new WebSocket(wsUrl);
		await new Promise<void>((resolve, reject) => {
			ws.addEventListener("open", () => resolve(), { once: true });
			ws.addEventListener("error", () => reject(new Error("could not connect to the browser's CDP socket")), {
				once: true,
			});
		});

		const driver = new CdpDriver(ws, proc, options.viewport);
		ws.addEventListener("message", (event) => driver.onMessage(String((event as MessageEvent).data)));
		await driver.send("Page.enable", {});
		await driver.send("Runtime.enable", {});
		await driver.send("Log.enable", {});
		await driver.setViewport(options.viewport);
		return driver;
	}

	private onMessage(raw: string): void {
		let message: {
			id?: number;
			method?: string;
			params?: Record<string, unknown>;
			result?: unknown;
			error?: { message?: string };
		};
		try {
			message = JSON.parse(raw);
		} catch {
			return;
		}
		if (message.id !== undefined) {
			const waiter = this.pending.get(message.id);
			if (!waiter) return;
			this.pending.delete(message.id);
			if (message.error) waiter.reject(new Error(message.error.message ?? "CDP error"));
			else waiter.resolve(message.result);
			return;
		}
		if (message.method === "Page.loadEventFired") this.loadFired = true;
		if (message.method === "Runtime.consoleAPICalled") {
			const params = message.params as { type?: string; args?: { value?: unknown; description?: string }[] };
			if (params.type === "error" || params.type === "warning") {
				const text = (params.args ?? [])
					.map((arg) => (arg.value !== undefined ? String(arg.value) : (arg.description ?? "")))
					.join(" ");
				this.note(`console.${params.type}: ${text}`);
			}
		}
		if (message.method === "Runtime.exceptionThrown") {
			const params = message.params as {
				exceptionDetails?: { text?: string; exception?: { description?: string } };
			};
			this.note(
				`uncaught: ${params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? "exception"}`,
			);
		}
		if (message.method === "Log.entryAdded") {
			const params = message.params as { entry?: { level?: string; text?: string } };
			if (params.entry?.level === "error" || params.entry?.level === "warning") {
				this.note(`${params.entry.level}: ${params.entry.text ?? ""}`);
			}
		}
	}

	private note(line: string): void {
		this.consoleBuffer.push(line.length > 300 ? `${line.slice(0, 297)}...` : line);
		if (this.consoleBuffer.length > 40) this.consoleBuffer.shift();
	}

	private send<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
			this.ws.send(JSON.stringify({ id, method, params }));
		});
	}

	async goto(url: string): Promise<void> {
		this.loadFired = false;
		await this.send("Page.navigate", { url });
		const deadline = Date.now() + NAV_TIMEOUT_MS;
		while (!this.loadFired && Date.now() < deadline) await sleep(100);
		await sleep(SETTLE_MS);
	}

	async clickSelector(selector: string): Promise<string> {
		const escaped = JSON.stringify(selector);
		const result = await this.send<{ result?: { value?: string } }>("Runtime.evaluate", {
			expression: `(() => {
				const el = document.querySelector(${escaped});
				if (!el) return "NOTFOUND";
				el.scrollIntoView({ block: "center", inline: "center" });
				const r = el.getBoundingClientRect();
				return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2, text: (el.innerText || el.value || el.ariaLabel || "").slice(0, 60) });
			})()`,
			returnByValue: true,
		});
		const value = result.result?.value;
		if (value === "NOTFOUND" || typeof value !== "string") {
			throw new Error(`no element matches selector ${selector}`);
		}
		const target = JSON.parse(value) as { x: number; y: number; text: string };
		await sleep(100);
		await this.clickAt(target.x, target.y);
		return target.text;
	}

	async clickAt(x: number, y: number): Promise<void> {
		const base = { x, y, button: "left", clickCount: 1 };
		await this.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
		await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
		await sleep(SETTLE_MS);
	}

	async type(text: string): Promise<void> {
		await this.send("Input.insertText", { text });
		await sleep(150);
	}

	async press(key: string): Promise<void> {
		const code = KEY_CODES[key];
		if (code === undefined) throw new Error(`unsupported key '${key}'; one of: ${Object.keys(KEY_CODES).join(", ")}`);
		await this.send("Input.dispatchKeyEvent", {
			type: "rawKeyDown",
			windowsVirtualKeyCode: code,
			key,
		});
		if (key === "Enter") await this.send("Input.dispatchKeyEvent", { type: "char", text: "\r" });
		if (key === "Space") await this.send("Input.dispatchKeyEvent", { type: "char", text: " " });
		await this.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: code, key });
		await sleep(SETTLE_MS);
	}

	async scroll(dy: number): Promise<void> {
		await this.send("Input.dispatchMouseEvent", {
			type: "mouseWheel",
			x: Math.floor(this.viewport.width / 2),
			y: Math.floor(this.viewport.height / 2),
			deltaX: 0,
			deltaY: dy,
		});
		await sleep(300);
	}

	async eval(js: string): Promise<string> {
		const result = await this.send<{
			result?: { value?: unknown; description?: string };
			exceptionDetails?: { text?: string; exception?: { description?: string } };
		}>("Runtime.evaluate", { expression: js, returnByValue: true, awaitPromise: true });
		if (result.exceptionDetails) {
			throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "threw");
		}
		const value = result.result?.value;
		if (value === undefined) return result.result?.description ?? "undefined";
		return typeof value === "string" ? value : JSON.stringify(value);
	}

	async setViewport(viewport: BrowseViewport): Promise<void> {
		this.viewport = viewport;
		await this.send("Emulation.setDeviceMetricsOverride", {
			width: viewport.width,
			height: viewport.height,
			deviceScaleFactor: viewport.deviceScaleFactor,
			mobile: viewport.mobile,
		});
		await this.send("Emulation.setTouchEmulationEnabled", { enabled: viewport.mobile });
		await sleep(200);
	}

	async screenshot(): Promise<string> {
		// JPEG at moderate quality: a fraction of a PNG's tokens, and layout
		// problems survive compression just fine.
		const result = await this.send<{ data: string }>("Page.captureScreenshot", {
			format: "jpeg",
			quality: 60,
		});
		return result.data;
	}

	async state(): Promise<PageState> {
		const raw = await this.eval("JSON.stringify({ url: location.href, title: document.title })");
		const parsed = JSON.parse(raw) as { url: string; title: string };
		const drained = this.consoleBuffer;
		this.consoleBuffer = [];
		return { url: parsed.url, title: parsed.title, console: drained };
	}

	dispose(): void {
		try {
			this.ws.close();
		} catch {}
		try {
			this.proc.kill();
		} catch {}
	}
}

export const defaultBrowseDriverFactory: BrowseDriverFactory = (options) => CdpDriver.launch(options);
