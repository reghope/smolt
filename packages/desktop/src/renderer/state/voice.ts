import { api } from "../lib/api.ts";
import { app, bump, toast } from "./app.ts";
import { dropSamples, freshWords, isEcho } from "./voice-core.ts";

/**
 * Dictation: capture 16 kHz mono, refresh a partial transcript on a timer,
 * and write recognised words into the composer draft as they land.
 *
 * Whisper is not a streaming model, so live text comes from re-reading a
 * clip — but never the whole sitting. Speech is cut into segments at the
 * natural pauses: once a pause ends a sentence, its words are committed,
 * its audio is dropped, and the next pass starts fresh. Each pass therefore
 * reads seconds of audio no matter how long the microphone has been open,
 * which is what keeps the text close behind the voice. (Re-reading the
 * whole sitting made every pass slower than the last, and past thirty
 * seconds Whisper's window silently cut the end off.)
 *
 * Two rules keep the model honest, because Whisper invents words when it
 * is handed quiet: a pass only runs when speech has actually arrived since
 * the last one, and the clip it reads is cut just after the last spoken
 * word, so trailing room noise never reaches the model at all.
 */

interface VoiceSession {
	stream: MediaStream;
	context: AudioContext;
	analyser: AnalyserNode;
	/** Audio for the current segment only, at 16 kHz mono. */
	samples: Float32Array[];
	total: number;
	timer: ReturnType<typeof setInterval> | null;
	/** Loudest sample of the whole sitting, which is how a dead microphone is recognised. */
	peak: number;
	/**
	 * The room's own level, learned as it goes.
	 *
	 * A laptop microphone in a quiet room boosts its gain until the noise
	 * floor alone clears any fixed threshold — which read as someone talking
	 * forever, so pauses never registered and Whisper was fed the hiss. The
	 * estimate snaps down to any quiet chunk instantly and rises only slowly,
	 * so speech never drags it up, and "loud enough to be speech" means loud
	 * against this room rather than loud in the abstract.
	 */
	noiseFloor: number;
	/** Where in the buffer the last heard speech ended; 0 while the segment holds none. */
	speechEnd: number;
	/** How far the last completed pass had heard; a new pass needs speech beyond it. */
	passSpeechEnd: number;
	/** The device this clip came from, for saying which one heard nothing. */
	device: string;
	/** When the microphone last heard something loud enough to be speech. */
	lastSpokeAt: number;
}

/**
 * Below this peak amplitude, nothing was said.
 *
 * A muted or absent microphone reads 0.0001 or less; the threshold sits far
 * above that dead floor and far below any real speech, so it separates the
 * two without ever rejecting a quiet talker.
 *
 * This matters because Whisper does not return nothing for silence — it
 * invents a filler word. Transcribing a dead microphone is where the
 * stray "yeah" in the composer came from.
 */
const SILENCE_PEAK = 0.02;
/**
 * Speech must clear the room by this much.
 *
 * Multiplying the learned noise floor separates talking from the hiss on
 * microphones whose automatic gain makes silence loud; the cap keeps a bad
 * estimate from ever rejecting real speech, which rarely peaks below 0.3.
 */
const SPEECH_ABOVE_FLOOR = 3;
const SPEECH_THRESHOLD_CAP = 0.25;

/** Loud enough to be speech, in this room, on this microphone. */
function speechThreshold(session: VoiceSession): number {
	return Math.min(SPEECH_THRESHOLD_CAP, Math.max(SILENCE_PEAK, session.noiseFloor * SPEECH_ABOVE_FLOOR));
}

let voice: VoiceSession | null = null;
/**
 * The words of the current segment already written into the composer.
 *
 * Whisper re-reads the segment each pass, and a later pass will happily
 * rephrase what an earlier one produced — so writing its output straight
 * to the draft made the text rewrite itself every couple of seconds. These
 * are kept instead, and only ever added to: a word that has been shown
 * stays put, and each pass appends whatever it has found beyond it.
 */
let settled: string[] = [];
/** True while a transcription is in flight, so passes never overlap. */
let voiceBusy = false;

/** Whisper wants 16 kHz mono; asking the context for it does the resampling. */
const SPEECH_RATE = 16000;
/** How often the partial transcript is refreshed while speaking. */
const SPEECH_INTERVAL_MS = 1200;
/** Audio kept past the last spoken word, so a final consonant is not clipped. */
const SPEECH_PAD_SAMPLES = SPEECH_RATE * 0.3;
/**
 * Quiet for this long and the sentence is over.
 *
 * Nothing more is coming to revise the tail, so the segment is committed
 * whole and its audio dropped — the pause is what keeps every later pass
 * short, and what puts the last word or two on screen while they are
 * still useful.
 */
const SETTLE_AFTER_SILENCE_MS = 900;
/**
 * A segment is never allowed past this, pause or no pause.
 *
 * Whisper reads thirty-second windows; someone who talks straight through
 * every pause would otherwise grow a clip the model silently truncates.
 * Cutting mid-flow can smudge one word at the seam, which is the lesser
 * evil by a distance.
 */
const SEGMENT_LIMIT_SAMPLES = SPEECH_RATE * 25;
/**
 * Quiet for this long and the microphone switches itself off.
 *
 * Long enough that a thinking pause mid-prompt never trips it — it only
 * fires when dictation has plainly been forgotten about, so an open
 * microphone is never left listening to the room.
 */
const AUTO_STOP_AFTER_SILENCE_MS = 60_000;

/**
 * Add newly recognised words to the end of the draft as it stands now.
 *
 * The draft is appended to, never rebuilt: dictation holds no copy of the
 * text it has produced, so sending or editing mid-dictation just works —
 * the next words land in whatever the composer holds at that moment,
 * instead of a stale transcript being pasted back over it.
 */
function appendToDraft(words: string): void {
	const base = app.draft.replace(/\s+$/, "");
	app.draft = base === "" ? words : `${base} ${words}`;
}

export function voiceRunning(): boolean {
	return voice !== null;
}

/** The first `limit` samples of the segment, as one buffer for the model. */
function joinSamples(session: VoiceSession, limit: number): Float32Array {
	const all = new Float32Array(limit);
	let offset = 0;
	for (const chunk of session.samples) {
		if (offset >= limit) break;
		const take = Math.min(chunk.length, limit - offset);
		all.set(take === chunk.length ? chunk : chunk.subarray(0, take), offset);
		offset += take;
	}
	return all;
}

/**
 * Re-read the current segment and show the text.
 *
 * A partial pass over the segment gives coherent text where decoding only
 * the newest slice would fragment words at the boundaries. The clip ends
 * just after the last spoken word — Whisper handed trailing quiet answers
 * with the last word again, which is where a composer full of one repeated
 * word came from. When the pass lands on a pause — or the segment hits its
 * length limit — the segment is finished: every word committed, its audio
 * dropped, the next one begun.
 */
async function refreshTranscript(session: VoiceSession, final = false): Promise<void> {
	if (voiceBusy) return;
	if (!final && voice !== session) return;
	// No speech in the segment, or none since the last pass: there is
	// nothing new to hear, and passing quiet to the model invents words.
	if (session.speechEnd === 0) return;
	if (!final && session.speechEnd <= session.passSpeechEnd) return;
	const clipEnd = Math.min(session.total, Math.round(session.speechEnd + SPEECH_PAD_SAMPLES));
	if (clipEnd < SPEECH_RATE * 0.4) return;
	voiceBusy = true;
	try {
		// Audio keeps arriving while the pass runs; remember where this clip
		// ended so only what was actually transcribed is dropped afterwards.
		const consumed = clipEnd;
		const heard = session.speechEnd;
		const result = await api.speechTranscribe(joinSamples(session, clipEnd).buffer as ArrayBuffer);
		if (!final && voice !== session) return;
		if (!result.ok) {
			if (final) toast(result.error ?? "Could not transcribe that", "error");
			return;
		}
		session.passSpeechEnd = heard;
		// A pause is as good as an ending for the words already spoken.
		const quiet = Date.now() - session.lastSpokeAt > SETTLE_AFTER_SILENCE_MS;
		const done = final || quiet || consumed >= SEGMENT_LIMIT_SAMPLES;
		const fresh = freshWords(settled, String(result.value ?? "").trim(), done);
		// A pass that only says the last word again is the model echoing,
		// not the user repeating themselves; a real repeat still lands when
		// the segment commits whole.
		if (!done && isEcho(settled, fresh)) return;
		settled = settled.concat(fresh);
		// Show the words in the composer as they are recognised, so there is
		// no second place to look while speaking.
		if (fresh.length > 0) {
			appendToDraft(fresh.join(" "));
			bump();
		}
		if (done && !final) {
			// The segment is complete: let its audio go so the next pass reads
			// seconds, not the sitting, and start the word count over.
			dropSamples(session, consumed);
			session.speechEnd = Math.max(0, session.speechEnd - consumed);
			session.passSpeechEnd = Math.max(0, session.passSpeechEnd - consumed);
			settled = [];
		}
	} finally {
		voiceBusy = false;
	}
}

export async function startVoice(): Promise<void> {
	if (voice) return;
	const status = (await api.speechStatus()) as { ready: boolean };
	settled = [];
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
		noiseFloor: 1,
		speechEnd: 0,
		passSpeechEnd: 0,
		device: stream.getAudioTracks()[0]?.label ?? "",
		lastSpokeAt: Date.now(),
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
		// Snap down to any quiet chunk at once; rise toward loudness only
		// slowly, so a sentence never teaches the estimate that the room
		// is as loud as talking.
		session.noiseFloor = Math.min(loudest, session.noiseFloor * 0.98 + loudest * 0.02);
		if (loudest >= speechThreshold(session)) {
			session.lastSpokeAt = Date.now();
			session.speechEnd = session.total;
		}
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
	session.timer = setInterval(() => {
		// A microphone forgotten about switches itself off rather than
		// listening to the room; a thinking pause is far too short to trip it.
		if (Date.now() - session.lastSpokeAt > AUTO_STOP_AFTER_SILENCE_MS) {
			toast("Dictation switched off after a minute of silence.");
			void finishVoice(true);
			return;
		}
		void refreshTranscript(session);
	}, SPEECH_INTERVAL_MS);
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
		settled = [];
		bump();
		return;
	}
	// A sitting with nothing in it is not transcribed at all. Saying so, and
	// naming the device, is the difference between a mystery and a setting:
	// the machine may have several inputs and only one of them live.
	if (session.peak < SILENCE_PEAK) {
		settled = [];
		const which = session.device.trim();
		app.voiceSilent = which === "" ? "the microphone" : which;
		bump();
		return;
	}
	// Only a segment that still holds speech needs a last pass — stopping
	// after a pause has nothing left to commit and is instant.
	if (session.speechEnd > 0) {
		voiceBusy = false;
		app.voiceFinishing = true;
		bump();
		// One last pass, so the tail of the sentence is not lost.
		await refreshTranscript(session, true);
		app.voiceFinishing = false;
	}
	settled = [];
	bump();
}

export function toggleVoice(): void {
	void (voiceRunning() ? finishVoice(true) : startVoice());
}
