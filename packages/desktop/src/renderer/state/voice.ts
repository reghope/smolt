import { api } from "../lib/api.ts";
import { app, bump, toast } from "./app.ts";
import { collapseRepeats, isRunaway, isStockAnswer, renderRun, shouldCutSegment } from "./voice-core.ts";

/**
 * Dictation: capture 16 kHz mono for as long as the microphone is open, in
 * segments cut at the pauses between sentences.
 *
 * A sitting has no length limit. Someone can talk for hours: the audio is
 * never held whole, never sent whole, and never decoded whole. Every half
 * minute or so, at the next pause in speech, the audio in hand is closed
 * off and handed to the decoder, which works through the segments one at a
 * time and writes each one into the draft as it lands. So memory, the size
 * of a message to the main process, and the length of a single decode all
 * stay flat however long the microphone is open, and stopping only has to
 * wait for whatever is left rather than for the whole sitting.
 *
 * The segments are still far larger than a streaming recogniser's, which is
 * what keeps a bigger and more accurate model affordable: a decode that
 * runs twice a minute can take seconds, where one running every second
 * could not.
 *
 * Two rules keep the model honest, because a speech model invents words
 * when it is handed quiet: a sitting whose loudest moment is under the
 * dead-microphone line is never transcribed at all, and the auto-stop
 * watchdog only counts a chunk as speech when it clears the room's own
 * learned floor.
 */

interface VoiceSession {
	stream: MediaStream;
	context: AudioContext;
	analyser: AnalyserNode;
	/** The segment being captured now, at 16 kHz mono, in capture order. */
	samples: Float32Array[];
	total: number;
	/** Loudest sample of that segment, so a segment of pure room is never decoded. */
	segmentPeak: number;
	/** Unbroken quiet at the end of it, in samples, which is where a cut goes. */
	quiet: number;
	/** The idle watchdog, which is the only thing on a timer. */
	watchdog: ReturnType<typeof setInterval> | null;
	/** Loudest sample of the whole sitting, which is how a dead microphone is recognised. */
	peak: number;
	/**
	 * The room's own level, learned as it goes.
	 *
	 * A laptop microphone in a quiet room boosts its gain until the noise
	 * floor alone clears any fixed threshold — which read as someone talking
	 * forever, and kept the microphone from ever switching itself off. The
	 * estimate snaps down to any quiet chunk instantly and rises only slowly,
	 * so speech never drags it up.
	 */
	noiseFloor: number;
	/** The device this clip came from, for saying which one heard nothing. */
	device: string;
	/** When the microphone last heard something loud enough to be speech. */
	lastSpokeAt: number;
}

/**
 * Below this peak amplitude, the microphone is dead.
 *
 * A muted or absent input reads 0.0001 or less; this sits far above that
 * dead floor and far below any real speech, so it separates the two without
 * ever rejecting a quiet talker. It is measured on the peak of the whole
 * sitting, and answers only one question — whether anything arrived at all —
 * which is why the sitting is not transcribed when it fails.
 */
const SILENCE_PEAK = 0.02;
/**
 * Speech must clear the room by this much.
 *
 * Multiplying the learned noise floor separates talking from the hiss of
 * the room it is spoken in, so "loud enough to be speech" means loud
 * against this room rather than loud in the abstract.
 */
const SPEECH_ABOVE_FLOOR = 3;
/** Absolute bounds on that threshold, so a very quiet or loud room cannot pin it. */
const SPEECH_PEAK_FLOOR = 0.02;
const SPEECH_PEAK_CAP = 0.25;

/** Loud enough to be speech, in this room, on this microphone. */
function speechThreshold(session: VoiceSession): number {
	return Math.min(SPEECH_PEAK_CAP, Math.max(SPEECH_PEAK_FLOOR, session.noiseFloor * SPEECH_ABOVE_FLOOR));
}

let voice: VoiceSession | null = null;
/** Segments captured but not yet decoded, oldest first. */
const queue: Float32Array[] = [];
/** The text of every segment already written into the draft this sitting. */
let settled: string[] = [];
/** Runs while the queue drains, so senders can wait the words out. */
let decoding: Promise<void> | null = null;
/** The stop in progress, so a second stop joins it rather than repeating it. */
let stopping: Promise<void> | null = null;

export function voiceRunning(): boolean {
	return voice !== null;
}

/** True while segments are being decoded; their words are not in the draft yet. */
export function voiceTranscribing(): boolean {
	return decoding !== null;
}

/** Resolves once every captured segment has landed (or failed). */
export function whenVoiceSettled(): Promise<void> {
	return decoding ?? Promise.resolve();
}

/** The segment in hand, as one buffer for the model. */
function joinSamples(session: VoiceSession): Float32Array {
	const all = new Float32Array(session.total);
	let offset = 0;
	for (const chunk of session.samples) {
		all.set(chunk, offset);
		offset += chunk.length;
	}
	return all;
}

/**
 * Close the segment in hand and hand it to the decoder.
 *
 * A segment the microphone barely registered is dropped here rather than
 * decoded: a pause between two sentences is not worth a pass, and a speech
 * model given quiet invents words to fill it.
 */
function cutSegment(session: VoiceSession): void {
	const clip = joinSamples(session);
	const heard = session.segmentPeak >= SILENCE_PEAK;
	session.samples = [];
	session.total = 0;
	session.segmentPeak = 0;
	session.quiet = 0;
	if (heard) enqueue(clip);
}

/** Put a segment in the queue, starting the decoder if it is not running. */
function enqueue(clip: Float32Array): void {
	queue.push(clip);
	if (decoding) return;
	decoding = drainQueue().finally(() => {
		decoding = null;
		bump();
	});
	bump();
}

/** One decode at a time, in capture order, until nothing is waiting. */
async function drainQueue(): Promise<void> {
	for (;;) {
		const clip = queue.shift();
		if (!clip) return;
		try {
			await decodeSegment(clip);
		} catch (error) {
			// A pass that threw rather than answering must not take the segments
			// behind it down with it: the rest of the sitting still decodes.
			app.voiceError = error instanceof Error ? error.message : String(error);
			toast(app.voiceError, "error");
			bump();
		}
	}
}

/** Decode one segment and put its words at the end of the draft. */
async function decodeSegment(clip: Float32Array): Promise<void> {
	const result = await api.speechTranscribe(clip.buffer as ArrayBuffer);
	if (!result.ok) {
		// One segment failing is not the sitting failing. Say so, and carry on
		// with the rest: losing a sentence out of an hour beats losing the hour.
		app.voiceError = result.error ?? "Could not transcribe that";
		toast(app.voiceError, "error");
		bump();
		return;
	}
	const raw = String(result.value ?? "").trim();
	// A decode that fell into a loop comes back as one word repeated; a
	// segment that is mostly that is thrown away, and a shorter run inside
	// otherwise sound text is folded to a single copy.
	if (isRunaway(raw)) {
		console.debug(`dictation: transcription refused as a runaway repeat: ${raw.slice(0, 80)}`);
		return;
	}
	const text = collapseRepeats(raw);
	// Something crossed the threshold, but what came back is what the model
	// says when it has heard nothing worth saying. Take the pass as the
	// invention it is rather than typing it at the user.
	if (isStockAnswer(text, settled)) return;
	if (text === "") return;
	// Append at the end of whatever the composer holds, replacing trailing
	// whitespace with the one separating space.
	app.draft = renderRun(app.draft, "", text).draft;
	settled.push(text);
	bump();
}

export async function startVoice(): Promise<void> {
	if (voice) return;
	// A fresh sitting starts with a clean slate: the last attempt's failure
	// must not keep staining the button once the user tries again. Segments
	// still coming back from the last sitting keep theirs, since what has
	// settled decides whether the next answer is the model talking to itself.
	app.voiceError = "";
	if (!decoding) settled = [];
	bump();
	const status = (await api.speechStatus()) as { ready: boolean };
	if (status.ready) {
		// The weights are on disk, but that is not the same as loaded, and
		// loading them is what the stop used to wait on. Start it now and do
		// not wait: capture begins immediately either way, so the load runs
		// while the user is still talking.
		void api.speechPrepare();
	} else {
		// No message for this: the mic button spins until the model is here.
		app.voicePreparing = true;
		const prepared = await api.speechPrepare();
		app.voicePreparing = false;
		if (!prepared.ok) {
			app.voiceError = prepared.error ?? "Could not prepare the speech model";
			toast(app.voiceError, "error");
			bump();
			return;
		}
	}

	// The microphone API only exists in a secure context — HTTPS, or localhost.
	// Served over plain HTTP from another machine, it is simply absent, and
	// reaching for it crashes the window rather than saying why.
	if (!navigator.mediaDevices?.getUserMedia) {
		app.voiceError = "Dictation needs a secure context: open Smolt over HTTPS, or via localhost.";
		bump();
		return;
	}

	// Ask the operating system before asking for a stream, so a first-time
	// user gets a prompt rather than a refusal.
	const access = await api.micAccess();
	const osStatus = (access.value as { status?: string })?.status;
	if (access.ok && osStatus && osStatus !== "granted") {
		app.voiceDenied = true;
		app.voiceError = "Smolt needs microphone access. Use the mic button to open the setting.";
		toast(app.voiceError, "error");
		bump();
		return;
	}

	let stream: MediaStream;
	try {
		// The browser's own audio processing is the noise suppression here —
		// the same WebRTC stack a voice chat runs, which is what strips a fan
		// or a keyboard before the model ever hears it.
		//
		// Automatic gain stays *on*: it is the only thing bringing a quiet
		// microphone up to a level worth transcribing, and the gain it adds
		// is handled where it belongs — the room floor below is learned from
		// what the microphone actually delivers.
		const processing = {
			echoCancellation: true,
			noiseSuppression: true,
			autoGainControl: true,
		};
		stream = await navigator.mediaDevices.getUserMedia({
			audio: app.micDeviceId ? { deviceId: { exact: app.micDeviceId }, ...processing } : processing,
		});
	} catch (error) {
		// The failures mean different things and deserve different advice:
		// a refusal is a setting, a missing device is a device. Each lands on
		// the mic button too — a console-only message is no message at all.
		const name = error instanceof Error ? error.name : "";
		const advise =
			name === "NotFoundError" || name === "OverconstrainedError"
				? "No microphone found. Plug one in, or check Settings → Privacy → Microphone → " +
					"'Let desktop apps access your microphone'."
				: name === "NotAllowedError" || name === "SecurityError"
					? "Smolt needs microphone access. Use the mic button to open the setting."
					: `Could not open the microphone (${name || "unknown error"}).`;
		app.voiceError = advise;
		app.voiceDenied = name !== "" && name !== "UnknownError";
		if (name === "NotFoundError" || name === "OverconstrainedError") app.micDeviceId = "";
		toast(advise, "error");
		bump();
		return;
	}
	app.voiceDenied = false;

	const context = new AudioContext({ sampleRate: SPEECH_RATE });
	const source = context.createMediaStreamSource(stream);
	const analyser = context.createAnalyser();
	analyser.fftSize = 1024;
	const collector = context.createScriptProcessor(4096, 1, 1);

	const session: VoiceSession = {
		stream,
		context,
		analyser,
		samples: [],
		total: 0,
		segmentPeak: 0,
		quiet: 0,
		watchdog: null,
		peak: 0,
		noiseFloor: 1,
		device: stream.getAudioTracks()[0]?.label ?? "",
		lastSpokeAt: Date.now(),
	};
	collector.onaudioprocess = (event) => {
		const input = event.inputBuffer.getChannelData(0);
		session.samples.push(new Float32Array(input));
		session.total += input.length;
		let loudest = 0;
		let energy = 0;
		for (const sample of input) {
			const size = sample < 0 ? -sample : sample;
			if (size > loudest) loudest = size;
			energy += sample * sample;
		}
		if (loudest > session.peak) session.peak = loudest;
		if (loudest > session.segmentPeak) session.segmentPeak = loudest;
		// Any quiet chunk is the room, and is believed at once. A louder one
		// moves the estimate only a hair, so a sentence never drags it up.
		if (loudest < session.noiseFloor) session.noiseFloor = loudest;
		else if (loudest < speechThreshold(session)) session.noiseFloor = session.noiseFloor * 0.995 + loudest * 0.005;
		if (loudest >= speechThreshold(session)) {
			session.lastSpokeAt = Date.now();
			session.quiet = 0;
		} else session.quiet += input.length;
		if (shouldCutSegment(session.total / SPEECH_RATE, session.quiet / SPEECH_RATE)) cutSegment(session);
		// Live level for the waveform: RMS relative to this room's speech
		// threshold, clamped to 0..1, with a fast attack and a slower decay so
		// the bars fall gently between syllables instead of strobing. When it
		// settles near zero the composer shows its waiting dots again.
		const rms = Math.sqrt(energy / input.length);
		const now = Math.min(1, rms / speechThreshold(session));
		const level = Math.max(now, app.voiceLevel * 0.82);
		// The waveform reads the level straight off the store (outside React,
		// via a rAF loop), so a store bump is only needed to switch the strip
		// between its dots and its rolling bars — not for every wiggle.
		const wasAudible = app.voiceLevel >= 0.05;
		app.voiceLevel = level;
		if (wasAudible !== level >= 0.05) bump();
		if (session.peak >= SILENCE_PEAK && app.voiceSilent !== "") {
			app.voiceSilent = "";
			bump();
		}
	};
	source.connect(analyser);
	analyser.connect(collector);
	// A ScriptProcessor only runs while connected to a destination; a silent
	// gain keeps it pumping without playing the microphone back at you.
	const mute = context.createGain();
	mute.gain.value = 0;
	collector.connect(mute);
	mute.connect(context.destination);

	voice = session;
	app.voiceActive = true;
	// A fresh sitting starts silent until the microphone proves otherwise.
	app.voiceLevel = 0;
	// A microphone forgotten about switches itself off rather than listening
	// to the room; a thinking pause is far too short to trip it.
	session.watchdog = setInterval(() => {
		if (voice !== session) return;
		if (Date.now() - session.lastSpokeAt > AUTO_STOP_AFTER_SILENCE_MS) {
			toast("Dictation switched off after a minute of silence.");
			void finishVoice(true);
		}
	}, 1000);
	bump();
}

/** Whisper wants 16 kHz mono; asking the context for it does the resampling. */
const SPEECH_RATE = 16000;
/**
 * Quiet for this long and the microphone switches itself off.
 *
 * Long enough that a thinking pause mid-prompt never trips it — it only
 * fires when dictation has plainly been forgotten about, so an open
 * microphone is never left listening to the room.
 */
const AUTO_STOP_AFTER_SILENCE_MS = 60_000;

/**
 * How long to keep capturing after a stop, waiting for the last block.
 *
 * The capture node hands audio over in 4096-sample blocks, so when a stop
 * arrives the block still being filled — up to 256 ms, which is a whole
 * short word — has never been delivered. One more block is waited for
 * before the graph comes down, which is why the end of a sentence spoken
 * straight into Enter still makes it into the clip.
 */
const TAIL_FLUSH_MS = 400;

/** Wait for the block in flight, or for the deadline, whichever comes first. */
async function flushTail(session: VoiceSession): Promise<void> {
	const blocks = session.samples.length;
	const until = Date.now() + TAIL_FLUSH_MS;
	while (session.samples.length === blocks && Date.now() < until) {
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/** Stop capture and tear the audio graph down. */
function stopCapture(): VoiceSession | null {
	const session = voice;
	if (!session) return null;
	voice = null;
	app.voiceActive = false;
	if (session.watchdog) clearInterval(session.watchdog);
	for (const track of session.stream.getTracks()) track.stop();
	void session.context.close();
	return session;
}

/**
 * Stop dictation and finish decoding what was captured.
 *
 * Most of the sitting has usually been decoded already, while it was being
 * spoken. What is left is the segment in hand and anything still queued, so
 * this returns once every word is in the draft (or its pass has failed) —
 * however long the microphone was open.
 */
export function finishVoice(insert: boolean): Promise<void> {
	if (stopping) return stopping;
	if (!voice) return whenVoiceSettled();
	stopping = finishVoiceNow(insert).finally(() => {
		stopping = null;
	});
	return stopping;
}

async function finishVoiceNow(insert: boolean): Promise<void> {
	if (voice && insert) await flushTail(voice);
	const session = stopCapture();
	if (!session) return;
	if (!insert) {
		// Thrown away rather than typed out: segments waiting on the decoder
		// are dropped with the one in hand.
		queue.length = 0;
		return;
	}
	// A sitting with nothing in it is not transcribed at all. Saying so, and
	// naming the device, is the difference between a mystery and a setting:
	// the machine may have several inputs and only one of them live.
	if (session.peak < SILENCE_PEAK) {
		const which = session.device.trim();
		app.voiceSilent = which === "" ? "the microphone" : which;
		bump();
		return;
	}
	cutSegment(session);
	app.voiceFinishing = true;
	bump();
	try {
		await whenVoiceSettled();
	} finally {
		app.voiceFinishing = false;
		bump();
	}
}

export function toggleVoice(): void {
	void (voiceRunning() ? finishVoice(true) : startVoice());
}
