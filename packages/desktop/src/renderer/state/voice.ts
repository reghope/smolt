import { api } from "../lib/api.ts";
import { app, bump, toast } from "./app.ts";

/**
 * Dictation: capture 16 kHz mono, refresh a partial transcript on a timer,
 * and write recognised words into the composer draft as they land.
 * Ported unchanged from the pre-React renderer.
 */

interface VoiceSession {
	stream: MediaStream;
	context: AudioContext;
	analyser: AnalyserNode;
	/** Every sample captured so far, at 16 kHz mono. */
	samples: Float32Array[];
	total: number;
	timer: ReturnType<typeof setInterval> | null;
	/** Loudest sample seen, which is how a dead microphone is recognised. */
	peak: number;
	/** The device this clip came from, for saying which one heard nothing. */
	device: string;
}

/**
 * Below this peak amplitude, nothing was said.
 *
 * A working microphone in a silent room still reads around 0.15 peak from
 * its own noise floor; a muted or absent one reads 0.0001 or less. The
 * threshold sits far above the dead floor and far below any real speech,
 * so it separates the two without ever rejecting a quiet talker.
 *
 * This matters because Whisper does not return nothing for silence — it
 * invents a filler word. Transcribing a dead microphone is where the
 * stray "yeah" in the composer came from.
 */
const SILENCE_PEAK = 0.02;

let voice: VoiceSession | null = null;
let voiceText = "";
/** True while a transcription is in flight, so passes never overlap. */
let voiceBusy = false;
/** Text already in the composer when dictation started. */
let voiceBase = "";

/** Whisper wants 16 kHz mono; asking the context for it does the resampling. */
const SPEECH_RATE = 16000;
/** How often the partial transcript is refreshed while speaking. */
const SPEECH_INTERVAL_MS = 1800;

export function voiceRunning(): boolean {
	return voice !== null;
}

/** Everything captured so far, as one buffer for the model. */
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
 * Re-read the clip so far and show the text.
 *
 * Whisper is not a streaming model, so a partial pass over the whole clip
 * gives coherent text where decoding only the newest slice would fragment
 * words at the boundaries.
 */
async function refreshTranscript(final = false): Promise<void> {
	if (!voice || voiceBusy) return;
	if (voice.total < SPEECH_RATE * 0.4) return;
	// Never hand silence to the model: it answers with a word regardless.
	if (voice.peak < SILENCE_PEAK) return;
	voiceBusy = true;
	try {
		const result = await api.speechTranscribe(joinSamples(voice).buffer as ArrayBuffer);
		if (!voice && !final) return;
		if (result.ok) {
			voiceText = String(result.value ?? "").trim();
			// Show the words in the composer as they are recognised, so there is
			// no second place to look while speaking.
			app.draft = voiceBase === "" ? voiceText : `${voiceBase} ${voiceText}`;
			bump();
		} else if (final) {
			toast(result.error ?? "Could not transcribe that", "error");
		}
	} finally {
		voiceBusy = false;
	}
}

export async function startVoice(): Promise<void> {
	if (voice) return;
	const status = (await api.speechStatus()) as { ready: boolean };
	voiceText = "";
	// Dictation appends to whatever is already typed rather than replacing it.
	voiceBase = app.draft.replace(/\s+$/, "");
	if (!status.ready) {
		// No message for this: the mic button spins until the model is here.
		app.voicePreparing = true;
		const prepared = await api.speechPrepare();
		app.voicePreparing = false;
		if (!prepared.ok) {
			toast(prepared.error ?? "Could not prepare the speech model", "error");
			return;
		}
	}

	// Ask the operating system before asking for a stream, so a first-time
	// user gets a prompt rather than a refusal.
	const access = await api.micAccess();
	const osStatus = (access.value as { status?: string })?.status;
	if (access.ok && osStatus && osStatus !== "granted") {
		app.voiceDenied = true;
		toast("smolt needs microphone access. Use the mic button to open the setting.", "error");
		return;
	}

	let stream: MediaStream;
	try {
		stream = await navigator.mediaDevices.getUserMedia({
			audio: app.micDeviceId ? { deviceId: { exact: app.micDeviceId } } : true,
		});
	} catch (error) {
		// The failures mean different things and deserve different advice:
		// a refusal is a setting, a missing device is a device.
		const name = error instanceof Error ? error.name : "";
		if (name === "NotFoundError" || name === "OverconstrainedError") {
			app.voiceDenied = true;
			app.micDeviceId = "";
			toast(
				"No microphone found. Plug one in, or check Settings → Privacy → Microphone → " +
					"'Let desktop apps access your microphone'.",
				"error",
			);
		} else if (name === "NotAllowedError" || name === "SecurityError") {
			app.voiceDenied = true;
			toast("smolt needs microphone access. Use the mic button to open the setting.", "error");
		} else {
			app.voiceDenied = false;
			toast(`Could not open the microphone (${name || "unknown error"}).`, "error");
		}
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
		timer: null,
		peak: 0,
		device: stream.getAudioTracks()[0]?.label ?? "",
	};
	collector.onaudioprocess = (event) => {
		const input = event.inputBuffer.getChannelData(0);
		session.samples.push(new Float32Array(input));
		session.total += input.length;
		let loudest = 0;
		for (const sample of input) {
			const size = sample < 0 ? -sample : sample;
			if (size > loudest) loudest = size;
		}
		if (loudest > session.peak) session.peak = loudest;
		if (session.peak >= SILENCE_PEAK && app.voiceSilent !== "") {
			app.voiceSilent = "";
			bump();
		}
		// A coarse level, so the button can show that sound is arriving and a
		// dead microphone is visible while speaking rather than afterwards.
		const level = Math.min(1, loudest * 4);
		if (Math.abs(level - app.voiceLevel) > 0.12) {
			app.voiceLevel = level;
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
	session.timer = setInterval(() => void refreshTranscript(), SPEECH_INTERVAL_MS);
	bump();
}

/** Stop capture and tear the audio graph down. */
function stopCapture(): VoiceSession | null {
	const session = voice;
	if (!session) return null;
	voice = null;
	app.voiceActive = false;
	if (session.timer) clearInterval(session.timer);
	app.voiceLevel = 0;
	for (const track of session.stream.getTracks()) track.stop();
	void session.context.close();
	return session;
}

export async function finishVoice(insert: boolean): Promise<void> {
	const session = stopCapture();
	if (!session) return;
	if (!insert) {
		voiceText = "";
		bump();
		return;
	}
	// A clip with nothing in it is not transcribed at all. Saying so, and
	// naming the device, is the difference between a mystery and a setting:
	// the machine may have several inputs and only one of them live.
	if (session.peak < SILENCE_PEAK) {
		voiceText = "";
		const which = session.device.trim();
		app.voiceSilent = which === "" ? "the microphone" : which;
		bump();
		return;
	}
	voiceBusy = false;
	app.voiceFinishing = true;
	bump();
	// One last pass, so the tail of the sentence is not lost.
	voice = session;
	await refreshTranscript(true);
	voice = null;
	app.voiceActive = false;

	app.voiceFinishing = false;
	const text = voiceText.trim();
	app.draft = text === "" ? voiceBase : voiceBase === "" ? text : `${voiceBase} ${text}`;
	voiceText = "";
	voiceBase = "";
	bump();
}

export function toggleVoice(): void {
	void (voiceRunning() ? finishVoice(true) : startVoice());
}
