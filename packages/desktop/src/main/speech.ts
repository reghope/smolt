import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Speech to text, on this machine.
 *
 * The model is not shipped with the app: the first time dictation is used it
 * downloads a small quantised Whisper (~40 MB) into the smolt directory and
 * caches it there for good. That keeps the installer light and means nothing
 * is fetched for someone who never dictates.
 *
 * Everything runs locally, so audio never leaves the machine — which is the
 * point, given a microphone is open.
 */

/** Small and fast: transcribing a few seconds takes a few hundred ms. */
const MODEL_ID = "onnx-community/whisper-tiny.en";

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

type Transcriber = (audio: Float32Array, options?: Record<string, unknown>) => Promise<{ text?: unknown }>;

let transcriber: Transcriber | null = null;
let loading: Promise<Transcriber> | null = null;
let downloading = false;
let percent = 0;

/** Whether the weights are already on disk, so dictation can start at once. */
export function isModelCached(): boolean {
	// Transformers.js lays the cache out as <cacheDir>/<org>/<name>.
	return existsSync(join(modelCacheDir(), ...MODEL_ID.split("/")));
}

export function speechStatus(): SpeechStatus {
	return {
		ready: transcriber !== null || isModelCached(),
		downloading,
		percent,
		modelId: MODEL_ID,
		cacheDir: modelCacheDir(),
	};
}

/**
 * Load the model, downloading it the first time.
 *
 * Concurrent callers share one load: the window asks on open and again on the
 * first chunk of audio, and two downloads of the same weights would be waste.
 */
export async function ensureModel(onProgress?: (progress: DownloadProgress) => void): Promise<Transcriber> {
	if (transcriber) return transcriber;
	if (loading) return loading;

	loading = (async () => {
		const transformers = await import("@huggingface/transformers");
		// Keep the weights beside the rest of smolt's state rather than in a
		// cache folder next to the executable.
		transformers.env.cacheDir = modelCacheDir();
		downloading = !isModelCached();
		percent = downloading ? 0 : 100;

		const pipe = (await transformers.pipeline("automatic-speech-recognition", MODEL_ID, {
			dtype: "q8",
			progress_callback: (info: { status?: string; progress?: number; file?: string }) => {
				if (info.status === "progress" && typeof info.progress === "number") {
					percent = Math.max(0, Math.min(100, Math.round(info.progress)));
					onProgress?.({ percent, file: String(info.file ?? "") });
				}
			},
		})) as unknown as Transcriber;

		downloading = false;
		percent = 100;
		transcriber = pipe;
		return pipe;
	})();

	try {
		return await loading;
	} catch (error) {
		// A failed download must not poison later attempts.
		loading = null;
		downloading = false;
		percent = 0;
		throw error;
	} finally {
		loading = null;
	}
}

/** The sample rate the renderer captures at and Whisper expects. */
const SPEECH_RATE = 16000;
/** Whisper's native window: audio past this is dropped unless chunked. */
const WINDOW_SECONDS = 30;

/**
 * Transcribe 16 kHz mono samples.
 *
 * Whisper is not a streaming model, so live text comes from re-reading the
 * clip so far rather than decoding a tail in isolation: at this size that
 * costs a few hundred milliseconds and keeps the text coherent instead of
 * fragmenting at chunk boundaries.
 *
 * A clip longer than Whisper's thirty-second window is decoded in
 * overlapping chunks — without that the model reads the first window and
 * silently discards the rest, which is how the end of a long dictation
 * used to vanish.
 */
export async function transcribeSamples(samples: Float32Array): Promise<string> {
	if (samples.length === 0) return "";
	const pipe = await ensureModel();
	const result =
		samples.length > SPEECH_RATE * WINDOW_SECONDS
			? await pipe(samples, { chunk_length_s: WINDOW_SECONDS, stride_length_s: 5 })
			: await pipe(samples);
	const text = typeof result.text === "string" ? result.text : "";
	return text.trim();
}
