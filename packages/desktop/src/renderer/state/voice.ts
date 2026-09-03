import { api } from "../lib/api.ts";
import { app, bump, toast } from "./app.ts";
import { dropSamples, freshWords, isEcho, isStockAnswer, planRun, renderRun, tailWords } from "./voice-core.ts";

/**
 * Dictation: capture 16 kHz mono, re-read the clip as fast as the model can
 * manage, and write recognised words into the composer draft as they land.
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
	/** The next scheduled pass, if one is waiting rather than running. */
	timer: ReturnType<typeof setTimeout> | null;
	/** The idle watchdog, which is the only thing still on a fixed interval. */
	watchdog: ReturnType<typeof setInterval> | null;
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
 * Multiplying the learned noise floor separates talking from the hiss of the
 * room it is spoken in, so "loud enough to be speech" means loud against
 * this room rather than loud in the abstract.
 */
const SPEECH_ABOVE_FLOOR = 3;
/**
 * The bounds on that threshold, measured on the peak of a chunk.
 *
 * The cap matters most: a room noisy enough to push the estimate past it
 * would otherwise raise the bar above speech itself and hear nobody at all.
 */
const SPEECH_PEAK_FLOOR = 0.02;
const SPEECH_PEAK_CAP = 0.25;

/**
 * A clip must sustain this much level to be worth transcribing.
 *
 * This is the one that stops the model inventing words. A tap, a click or a
 * door is loud for a millisecond and quiet either side, so it trips the peak
 * but leaves the clip's sustained level down among the room's — and a clip
 * of a tap is what came back as "You you Okay." Speech measured on the same
 * scale sits around 0.05 and up, so the bar sits between the two, low enough
 * that a quiet talker still clears it.
 */
const CLIP_SPEECH_LEVEL = 0.042;

/** Loud enough to be speech, in this room, on this microphone. */
function speechThreshold(session: VoiceSession): number {
	return Math.min(SPEECH_PEAK_CAP, Math.max(SPEECH_PEAK_FLOOR, session.noiseFloor * SPEECH_ABOVE_FLOOR));
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
/**
 * The pause between one pass finishing and the next starting.
 *
 * Passes used to run on a fixed 1200 ms timer, and a tick that landed while
 * the model was busy was dropped rather than queued — so the real cadence
 * was often nearer two and a half seconds, and words arrived in clumps.
 * Chaining each pass off the end of the last instead means the text is only
 * ever as far behind the voice as one decode, and this gap exists solely to
 * leave the machine a breath between them.
 */
const SPEECH_GAP_MS = 80;
/**
 * How long to wait before looking again when there is nothing new to hear.
 *
 * A pass over audio the last one already read would spend a few hundred
 * milliseconds to produce the same words, so silence is checked cheaply
 * instead — often enough that the first word after a pause is not held up.
 */
const SPEECH_IDLE_MS = 150;
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
 * Dictation's own words, in the three states they pass through.
 *
 * A pass hands back two or three words at once — the ones spoken while it
 * was decoding — and writing them together made the composer jump in
 * clumps. They are queued instead and revealed one at a time, so the text
 * arrives at something like the rate it was spoken. Nothing is decoded any
 * sooner; what changes is that the words are spread across the wait for the
 * next pass rather than landing on top of each other.
 */
/** Every word this sitting has settled, across segments. */
let committed: string[] = [];
/** The dictated words currently on screen. */
let shownWords: string[] = [];
/** Decoded, still waiting their turn. */
let queued: string[] = [];
/** Exactly what dictation has written at the end of the draft. */
let rendered = "";
let revealTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * How long the next pass is expected to take, learned as it goes.
 *
 * The reveal is paced to empty the queue just as the next pass refills it,
 * so words keep coming at a steady rate instead of stalling and then
 * rushing. A rough estimate is enough, and it must be a moving one: a pass
 * over a long segment takes longer than one over a short one.
 */
let passGapMs = 700;
let lastPassAt = 0;

/**
 * Never slower than this, however few words are waiting.
 *
 * Set below the gap between passes rather than far below it: at 190 ms a
 * pass's two or three words were spent in half a second and then nothing
 * moved until the next one landed, which read as a stutter. Spreading them
 * nearer the full gap costs the last word of each pass a fraction of a
 * second and buys text that simply keeps coming.
 */
const MAX_REVEAL_MS = 340;
/** Never faster than this, or the words are a blur rather than a reveal. */
const MIN_REVEAL_MS = 45;
/**
 * How many words may wait their turn before the reveal gives up and shows
 * them all. Roughly what a fast speaker produces between two passes.
 */
const REVEAL_BACKLOG = 8;

/** Put the words currently revealed at the end of the draft. */
function paint(): void {
	const text = shownWords.join(" ");
	const next = renderRun(app.draft, rendered, text);
	if (!next.reclaimed) {
		// The user has typed since, or sent: those words are theirs now, and
		// the run starts again after whatever the composer holds. Everything
		// this sitting had settled goes with it — left standing, the next pass
		// would offer the whole run again and dictation would retype the
		// message from the beginning.
		shownWords = [];
		queued = [];
		committed = [];
		rendered = "";
		app.voiceSpoken = "";
		return;
	}
	app.draft = next.draft;
	rendered = next.rendered;
	app.voiceSpoken = next.rendered;
}

/** Reveal one waiting word, and line up the next. */
function revealNext(): void {
	revealTimer = null;
	const word = queued.shift();
	if (word === undefined) return;
	shownWords.push(word);
	paint();
	bump();
	scheduleReveal();
}

function scheduleReveal(): void {
	if (revealTimer !== null || queued.length === 0) return;
	// Spread what is waiting across the gap the next pass is expected in.
	const spacing = Math.round(passGapMs / queued.length);
	revealTimer = setTimeout(revealNext, Math.max(MIN_REVEAL_MS, Math.min(MAX_REVEAL_MS, spacing)));
}

/**
 * Take a pass's view of the run and fit it to what is already on screen.
 *
 * The first word of a pass appears at once — the reveal is there to spread
 * the clump behind it, not to hold the whole thing up.
 */
function offerRun(target: string[]): void {
	const now = Date.now();
	if (lastPassAt !== 0) passGapMs = Math.round(passGapMs * 0.6 + (now - lastPassAt) * 0.4);
	lastPassAt = now;

	const plan = planRun(shownWords, queued, target);
	if (plan.kind === "rewrite") {
		// The pass contradicted words already shown, so the run is redrawn
		// whole; this is the rare case, and cheaper than leaving it wrong.
		queued = [];
		shownWords = plan.words;
		paint();
		bump();
		return;
	}
	if (plan.kind === "requeue") queued = plan.words;
	else queued = queued.concat(plan.words);
	// A backlog means the reveal has lost the race with the speaker. Trickling
	// it out would only fall further behind, so past this much the words go up
	// together: being a beat behind is worse than arriving in a clump.
	if (queued.length > REVEAL_BACKLOG) {
		flushRun();
		bump();
		return;
	}
	if (revealTimer === null) revealNext();
	else scheduleReveal();
}

/** Show everything at once: dictation is over and nothing more is coming. */
function flushRun(): void {
	if (revealTimer !== null) {
		clearTimeout(revealTimer);
		revealTimer = null;
	}
	if (queued.length > 0) {
		shownWords = shownWords.concat(queued);
		queued = [];
		paint();
	}
}

/** Give up words that were only ever a guess, and end the run. */
function clearRun(): void {
	if (revealTimer !== null) {
		clearTimeout(revealTimer);
		revealTimer = null;
	}
	queued = [];
	shownWords = [];
	committed = [];
	// Take the shown words back off the draft, if they are still ours to take.
	const next = renderRun(app.draft, rendered, "");
	if (next.reclaimed) app.draft = next.draft;
	rendered = "";
	app.voiceSpoken = "";
}

/**
 * End the run without taking anything back.
 *
 * The microphone is shut, so the words stop being grey italics and read as
 * anything else the user has written — which is what they will look like in
 * the message once it is sent.
 */
function settleRun(): void {
	if (revealTimer !== null) {
		clearTimeout(revealTimer);
		revealTimer = null;
	}
	queued = [];
	shownWords = [];
	committed = [];
	rendered = "";
	lastPassAt = 0;
	app.voiceSpoken = "";
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

/** The sustained level of a clip: what it holds, not what it spiked to. */
function clipLevel(samples: Float32Array): number {
	if (samples.length === 0) return 0;
	let energy = 0;
	for (const sample of samples) energy += sample * sample;
	return Math.sqrt(energy / samples.length);
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
 *
 * Every pass writes twice over: the words it has settled, which stay, and
 * the tail it is still unsure of, which the next pass replaces. Returns
 * whether the model was actually asked, so the caller knows whether to come
 * straight back or wait for more speech.
 */
async function refreshTranscript(session: VoiceSession, final = false): Promise<boolean> {
	if (voiceBusy) return false;
	if (!final && voice !== session) return false;
	// No speech in the segment, or none since the last pass: there is
	// nothing new to hear, and passing quiet to the model invents words.
	if (session.speechEnd === 0) return false;
	if (!final && session.speechEnd <= session.passSpeechEnd) return false;
	const clipEnd = Math.min(session.total, Math.round(session.speechEnd + SPEECH_PAD_SAMPLES));
	if (clipEnd < SPEECH_RATE * 0.4) return false;
	voiceBusy = true;
	try {
		// Audio keeps arriving while the pass runs; remember where this clip
		// ended so only what was actually transcribed is dropped afterwards.
		const consumed = clipEnd;
		const heard = session.speechEnd;
		const clip = joinSamples(session, clipEnd);
		// Something was loud enough to open this clip, but a clip has to hold
		// its level to be speech. Below the bar it is a tap or a door, and
		// handing it over is what made the model answer with a word nobody
		// said. Note where it reached anyway, so the pass is not retried
		// forever over the same quiet audio.
		if (clipLevel(clip) < CLIP_SPEECH_LEVEL) {
			session.passSpeechEnd = heard;
			return true;
		}
		const result = await api.speechTranscribe(clip.buffer as ArrayBuffer);
		if (!final && voice !== session) return true;
		if (!result.ok) {
			if (final) toast(result.error ?? "Could not transcribe that", "error");
			return true;
		}
		session.passSpeechEnd = heard;
		// A pause is as good as an ending for the words already spoken.
		const quiet = Date.now() - session.lastSpokeAt > SETTLE_AFTER_SILENCE_MS;
		const done = final || quiet || consumed >= SEGMENT_LIMIT_SAMPLES;
		const text = String(result.value ?? "").trim();
		// Something crossed the threshold, but what came back is what the
		// model says when it has heard nothing worth saying. Take the pass
		// as the invention it is rather than typing it at the user.
		if (isStockAnswer(text, settled)) return true;
		const fresh = freshWords(settled, text, done);
		// Both are measured against the words settled before this pass: what
		// it adds for good, and what it is still only guessing at.
		const tail = tailWords(settled, text, done);
		// A pass that only says the last word again is the model echoing,
		// not the user repeating themselves; a real repeat still lands when
		// the segment commits whole.
		if (!done && isEcho(settled, fresh)) return true;
		const guess = !done && isEcho(settled, tail) ? [] : tail;
		settled = settled.concat(fresh);
		committed = committed.concat(fresh);
		// Hand the composer the run as this pass hears it: everything settled
		// so far, plus the words it is still unsure of. What of that is not yet
		// on screen is revealed a word at a time.
		offerRun(committed.concat(guess));
		if (done && !final) {
			// The segment is complete: let its audio go so the next pass reads
			// seconds, not the sitting, and start the word count over.
			dropSamples(session, consumed);
			session.speechEnd = Math.max(0, session.speechEnd - consumed);
			session.passSpeechEnd = Math.max(0, session.passSpeechEnd - consumed);
			settled = [];
		}
		return true;
	} finally {
		voiceBusy = false;
	}
}

/**
 * Run passes back to back for as long as the microphone is open.
 *
 * Each pass schedules the next itself rather than sharing a fixed timer, so
 * the text follows the voice at whatever speed the machine can manage: a
 * short gap after a pass that heard something, a slightly longer one when
 * there was nothing new, and no possibility of a tick being thrown away
 * because the model happened to be busy.
 */
function schedulePass(session: VoiceSession, delay: number): void {
	session.timer = setTimeout(() => {
		session.timer = null;
		if (voice !== session) return;
		void refreshTranscript(session).then((ran) => {
			if (voice !== session) return;
			schedulePass(session, ran ? SPEECH_GAP_MS : SPEECH_IDLE_MS);
		});
	}, delay);
}

export async function startVoice(): Promise<void> {
	if (voice) return;
	const status = (await api.speechStatus()) as { ready: boolean };
	settled = [];
	// Whatever is in the composer is the user's now, not a run to reclaim.
	settleRun();
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
		// The browser's own audio processing is the noise suppression here —
		// the same WebRTC stack a voice chat runs, which is what strips a fan
		// or a keyboard before the model ever hears it. Automatic gain is
		// asked *off* on purpose: it is what winds a quiet room up until the
		// hiss alone reads as talking, and it was making the room louder the
		// longer nobody spoke.
		const processing = {
			echoCancellation: true,
			noiseSuppression: true,
			autoGainControl: false,
		};
		stream = await navigator.mediaDevices.getUserMedia({
			audio: app.micDeviceId ? { deviceId: { exact: app.micDeviceId }, ...processing } : processing,
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
		watchdog: null,
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
		// Any quiet chunk is the room, and is believed at once; a loud one
		// moves the estimate only a hair, so a sentence cannot drag the bar up
		// behind it and end up measuring the speech it was meant to detect.
		session.noiseFloor = loudest < session.noiseFloor ? loudest : session.noiseFloor * 0.995 + loudest * 0.005;
		// Where speech reaches is judged on the peak, and generously: a gap
		// between two words is still the middle of a sentence, and a bar high
		// enough to fall into those gaps stops passes running and puts the
		// words back into clumps. Whether a clip is worth transcribing at all
		// is a separate question, asked of the clip below.
		if (loudest >= speechThreshold(session)) {
			session.lastSpokeAt = Date.now();
			session.speechEnd = session.total;
		}
		if (session.peak >= SILENCE_PEAK && app.voiceSilent !== "") {
			app.voiceSilent = "";
			bump();
		}
		// A coarse meter, so the button can show that sound is arriving and a
		// dead microphone is visible while speaking rather than afterwards.
		const meter = Math.min(1, loudest * 4);
		if (Math.abs(meter - app.voiceLevel) > 0.12) {
			app.voiceLevel = meter;
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
	schedulePass(session, SPEECH_GAP_MS);
	// A microphone forgotten about switches itself off rather than listening
	// to the room; a thinking pause is far too short to trip it. This is its
	// own timer because the passes no longer run on one, and because it must
	// still fire during a long decode.
	session.watchdog = setInterval(() => {
		if (voice !== session) return;
		if (Date.now() - session.lastSpokeAt > AUTO_STOP_AFTER_SILENCE_MS) {
			toast("Dictation switched off after a minute of silence.");
			void finishVoice(true);
		}
	}, 1000);
	bump();
}

/** Stop capture and tear the audio graph down. */
function stopCapture(): VoiceSession | null {
	const session = voice;
	if (!session) return null;
	voice = null;
	app.voiceActive = false;
	if (session.timer) clearTimeout(session.timer);
	if (session.watchdog) clearInterval(session.watchdog);
	app.voiceLevel = 0;
	for (const track of session.stream.getTracks()) track.stop();
	void session.context.close();
	return session;
}

export async function finishVoice(insert: boolean): Promise<void> {
	const session = stopCapture();
	if (!session) return;
	if (!insert) {
		// Words that were only ever a guess should not be left behind as
		// though they had been said.
		// Words that were only ever a guess should not be left behind as
		// though they had been said.
		clearRun();
		settled = [];
		bump();
		return;
	}
	// A sitting with nothing in it is not transcribed at all. Saying so, and
	// naming the device, is the difference between a mystery and a setting:
	// the machine may have several inputs and only one of them live.
	if (session.peak < SILENCE_PEAK) {
		clearRun();
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
	// Nothing more is coming, so anything still waiting its turn is shown at
	// once: a stop — or an Enter, which stops first — must not drop words
	// merely because they had not been revealed yet.
	flushRun();
	settled = [];
	// If a last pass could not run, or failed, the words already shown stay in
	// the composer and stop being ours to take back. Either way the microphone
	// is shut, so they read as ordinary text.
	settleRun();
	bump();
}

export function toggleVoice(): void {
	void (voiceRunning() ? finishVoice(true) : startVoice());
}
