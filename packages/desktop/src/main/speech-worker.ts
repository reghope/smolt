/**
 * The speech model, kept out of the main process.
 *
 * Decoding a clip is several hundred milliseconds of ONNX arithmetic, and
 * run in the main process that is several hundred milliseconds during which
 * no IPC is answered and no window event is handled — which made the whole
 * app sticky while anyone dictated, not just the dictation. It runs here
 * instead, in a utility process of its own, and the main process does
 * nothing but pass audio in and text out.
 *
 * The protocol is deliberately small: one request in, one reply out, matched
 * by id. Load failures come back as replies rather than crashes, so a failed
 * download is a message in the window rather than a dead worker.
 */

/**
 * Moonshine rather than Whisper, and base rather than tiny.
 *
 * Whisper pads every clip to a thirty-second window, so re-reading two
 * seconds of audio costs almost what re-reading thirty would — and this
 * re-reads a growing clip about once a second. Moonshine's cost follows the
 * audio instead, which on the short clips dictation actually sends is four
 * to five times quicker, at a size that is a step up in accuracy rather
 * than down.
 */
const MODEL_ID = "onnx-community/moonshine-base-ONNX";

type Transcriber = (audio: Float32Array, options?: Record<string, unknown>) => Promise<{ text?: unknown }>;

type Request =
	| { type: "prepare"; id: number; cacheDir: string }
	| { type: "transcribe"; id: number; cacheDir: string; samples: Float32Array };

type Reply =
	| { type: "progress"; percent: number; file: string }
	| { type: "ready"; id: number }
	| { type: "text"; id: number; text: string }
	| { type: "error"; id: number; message: string };

/** The sample rate the renderer captures at and Whisper expects. */
const SPEECH_RATE = 16000;
/** The window past which a clip is read in overlapping pieces. */
const WINDOW_SECONDS = 30;

let transcriber: Transcriber | null = null;
let loading: Promise<Transcriber> | null = null;

function send(reply: Reply): void {
	process.parentPort.postMessage(reply);
}

/**
 * Load the model, downloading it the first time.
 *
 * Concurrent callers share one load: the window asks on open and again on
 * the first chunk of audio, and two downloads of the same weights would be
 * waste. A failure clears the promise so a later attempt can retry.
 */
async function ensure(cacheDir: string): Promise<Transcriber> {
	if (transcriber) return transcriber;
	if (loading) return loading;

	loading = (async () => {
		const transformers = await import("@huggingface/transformers");
		// Keep the weights beside the rest of smolt's state rather than in a
		// cache folder next to the executable.
		transformers.env.cacheDir = cacheDir;
		const pipe = (await transformers.pipeline("automatic-speech-recognition", MODEL_ID, {
			dtype: "q8",
			progress_callback: (info: { status?: string; progress?: number; file?: string }) => {
				if (info.status === "progress" && typeof info.progress === "number") {
					send({
						type: "progress",
						percent: Math.max(0, Math.min(100, Math.round(info.progress))),
						file: String(info.file ?? ""),
					});
				}
			},
		})) as unknown as Transcriber;
		transcriber = pipe;
		return pipe;
	})();

	try {
		return await loading;
	} finally {
		loading = null;
	}
}

/**
 * Transcribe 16 kHz mono samples.
 *
 * A clip longer than the window is decoded in overlapping chunks — without
 * that a model reads the first window and silently discards the rest, which
 * is how the end of a long dictation used to vanish. Segments are cut well
 * below this, so it is a backstop rather than the usual path.
 */
async function transcribe(cacheDir: string, samples: Float32Array): Promise<string> {
	if (samples.length === 0) return "";
	const pipe = await ensure(cacheDir);
	const result =
		samples.length > SPEECH_RATE * WINDOW_SECONDS
			? await pipe(samples, { chunk_length_s: WINDOW_SECONDS, stride_length_s: 5 })
			: await pipe(samples);
	return typeof result.text === "string" ? result.text.trim() : "";
}

process.parentPort.on("message", (event: { data: Request }) => {
	const request = event.data;
	void (async () => {
		try {
			if (request.type === "prepare") {
				await ensure(request.cacheDir);
				send({ type: "ready", id: request.id });
			} else {
				send({ type: "text", id: request.id, text: await transcribe(request.cacheDir, request.samples) });
			}
		} catch (error) {
			send({ type: "error", id: request.id, message: error instanceof Error ? error.message : String(error) });
		}
	})();
});
