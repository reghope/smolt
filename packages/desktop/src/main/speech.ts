import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Speech to text, on this machine.
 *
 * The model is not shipped with the app: the first time dictation is used it
 * downloads a small quantised model (~64 MB) into the smolt directory and
 * caches it there for good. That keeps the installer light and means nothing is
 * fetched for someone who never dictates.
 *
 * Everything runs locally, so audio never leaves the machine — which is the
 * point, given a microphone is open.
 *
 * This half only brokers: the model itself lives in a utility process (see
 * speech-worker.ts) so its arithmetic never blocks the main process, and
 * what follows is the queue that keeps one request in flight at a time.
 */

/** Kept in step with the worker, which is what actually loads it. */
const MODEL_ID = "onnx-community/moonshine-base-ONNX";

export interface DownloadProgress {
	/** 0–100 across the whole download. */
	percent: number;
	file: string;
}

export interface SpeechStatus {
	ready: boolean;
	downloading: boolean;
	percent: number;
	modelId: string;
	cacheDir: string;
}

export function modelCacheDir(): string {
	const envDir = process.env.SMOLT_CODING_AGENT_DIR;
	const base = envDir?.trim()
		? envDir.startsWith("~")
			? join(homedir(), envDir.slice(1))
			: envDir
		: join(homedir(), ".smolt", "agent");
	return join(base, "models");
}

/** Whether the weights are already on disk, so dictation can start at once. */
export function isModelCached(): boolean {
	// Transformers.js lays the cache out as <cacheDir>/<org>/<name>.
	return existsSync(join(modelCacheDir(), ...MODEL_ID.split("/")));
}

interface Worker {
	postMessage(message: unknown): void;
	on(event: "message", listener: (message: unknown) => void): void;
	once(event: "exit", listener: () => void): void;
	kill(): void;
}

interface Pending {
	resolve: (text: string) => void;
	reject: (error: Error) => void;
}

let worker: Worker | null = null;
let ready = false;
let downloading = false;
let percent = 0;
let nextId = 1;
const pending = new Map<number, Pending>();
let progressListener: ((progress: DownloadProgress) => void) | undefined;

export function speechStatus(): SpeechStatus {
	return {
		ready: ready || isModelCached(),
		downloading,
		percent,
		modelId: MODEL_ID,
		cacheDir: modelCacheDir(),
	};
}

/** Fail every request in flight; used when the worker dies under them. */
function failPending(message: string): void {
	for (const request of pending.values()) request.reject(new Error(message));
	pending.clear();
}

/**
 * Start the worker, or hand back the one already running.
 *
 * The utility process is only reachable from Electron's main process, and
 * it is imported here rather than at the top of the file so the pure parts
 * above — where the cache lives, what is on disk — stay testable outside
 * Electron.
 */
async function ensureWorker(): Promise<Worker> {
	if (worker) return worker;
	const { utilityProcess } = await import("electron");
	// The worker resolves @huggingface/transformers and its native ONNX
	// binding from node_modules the same way the main process did, and keeps
	// the parent's stdio so a load failure is visible rather than silent.
	const child = utilityProcess.fork(join(__dirname, "speech-worker.cjs"), [], {
		serviceName: "smolt-speech",
	}) as unknown as Worker;

	child.on("message", (message: unknown) => {
		const reply = message as
			| { type: "progress"; percent: number; file: string }
			| { type: "ready"; id: number }
			| { type: "text"; id: number; text: string }
			| { type: "error"; id: number; message: string };
		if (reply.type === "progress") {
			downloading = true;
			percent = reply.percent;
			progressListener?.({ percent: reply.percent, file: reply.file });
			return;
		}
		const request = pending.get(reply.id);
		pending.delete(reply.id);
		if (reply.type === "error") {
			request?.reject(new Error(reply.message));
			return;
		}
		downloading = false;
		percent = 100;
		ready = true;
		request?.resolve(reply.type === "text" ? reply.text : "");
	});

	child.once("exit", () => {
		worker = null;
		ready = false;
		downloading = false;
		// A crash mid-download must not leave the button spinning for good.
		failPending("The speech model stopped unexpectedly. Try dictating again.");
	});

	worker = child;
	return child;
}

/** Send one request and wait for its reply. */
async function ask(request: { type: "prepare" } | { type: "transcribe"; samples: Float32Array }): Promise<string> {
	const child = await ensureWorker();
	const id = nextId++;
	return new Promise<string>((resolve, reject) => {
		pending.set(id, { resolve, reject });
		child.postMessage({ ...request, id, cacheDir: modelCacheDir() });
	});
}

/**
 * Load the model, downloading it the first time.
 *
 * The window asks on open so the microphone button can spin rather than
 * stall on the first word; the worker shares one load between callers, so
 * asking again while a download runs costs nothing.
 */
export async function ensureModel(onProgress?: (progress: DownloadProgress) => void): Promise<void> {
	progressListener = onProgress;
	downloading = !isModelCached();
	percent = downloading ? 0 : 100;
	try {
		await ask({ type: "prepare" });
		ready = true;
	} catch (error) {
		// A failed download must not poison later attempts.
		downloading = false;
		percent = 0;
		throw error;
	} finally {
		progressListener = undefined;
	}
}

/**
 * Transcribe 16 kHz mono samples.
 *
 * This is not a streaming model, so live text comes from re-reading the clip
 * so far rather than decoding a tail in isolation: at this size that costs
 * tens to hundreds of milliseconds and keeps the text coherent instead of
 * fragmenting at chunk boundaries.
 */
export async function transcribeSamples(samples: Float32Array): Promise<string> {
	// Stopping before saying anything must not start a worker or fetch a
	// model just to report that nothing was said.
	if (samples.length === 0) return "";
	return ask({ type: "transcribe", samples });
}

/** Shut the worker down; the window is closing and nothing more will be asked. */
export function stopSpeech(): void {
	const child = worker;
	worker = null;
	ready = false;
	failPending("Dictation stopped.");
	child?.kill();
}
