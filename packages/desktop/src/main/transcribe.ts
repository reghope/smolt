/**
 * Speech-to-text for the composer's dictation button.
 *
 * The agent itself has no audio surface, so this talks directly to an
 * OpenAI-compatible `/audio/transcriptions` endpoint using whichever key is
 * already in the environment. Nothing is stored: the clip is posted and the
 * text returned. When no key is configured the caller gets a plain message
 * telling the user what to set, rather than a silent failure.
 */

import { Blob } from "node:buffer";

export interface TranscriptionProvider {
	name: string;
	url: string;
	key: string;
	model: string;
}

const PROVIDERS: { env: string; name: string; url: string; model: string }[] = [
	{
		env: "OPENAI_API_KEY",
		name: "OpenAI",
		url: "https://api.openai.com/v1/audio/transcriptions",
		model: "whisper-1",
	},
	{
		env: "GROQ_API_KEY",
		name: "Groq",
		url: "https://api.groq.com/openai/v1/audio/transcriptions",
		model: "whisper-large-v3-turbo",
	},
];

/** Pick the first transcription provider with a key in the environment. */
export function findTranscriptionProvider(env: NodeJS.ProcessEnv = process.env): TranscriptionProvider | undefined {
	const override = env.SMOLT_DESKTOP_TRANSCRIBE_URL?.trim();
	const overrideKeyName = env.SMOLT_DESKTOP_TRANSCRIBE_KEY_ENV?.trim();
	if (override) {
		const key = (overrideKeyName ? env[overrideKeyName] : env.SMOLT_DESKTOP_TRANSCRIBE_KEY)?.trim();
		if (key) {
			return {
				name: "custom",
				url: override,
				key,
				model: env.SMOLT_DESKTOP_TRANSCRIBE_MODEL?.trim() || "whisper-1",
			};
		}
	}
	for (const candidate of PROVIDERS) {
		const key = env[candidate.env]?.trim();
		if (key) return { name: candidate.name, url: candidate.url, key, model: candidate.model };
	}
	return undefined;
}

export function transcriptionUnavailableMessage(): string {
	return "Dictation needs a transcription key: set OPENAI_API_KEY or GROQ_API_KEY before launching.";
}

/** Post a recorded clip and return the transcript text. */
export async function transcribeAudio(
	audio: Uint8Array,
	mimeType: string,
	provider = findTranscriptionProvider(),
): Promise<string> {
	if (!provider) throw new Error(transcriptionUnavailableMessage());

	const extension = mimeType.includes("wav") ? "wav" : mimeType.includes("mp4") ? "mp4" : "webm";
	const form = new FormData();
	form.append("file", new Blob([audio], { type: mimeType }), `clip.${extension}`);
	form.append("model", provider.model);
	form.append("response_format", "json");

	const response = await fetch(provider.url, {
		method: "POST",
		headers: { authorization: `Bearer ${provider.key}` },
		body: form,
	});
	if (!response.ok) {
		const detail = (await response.text()).slice(0, 200);
		throw new Error(`Transcription failed (${provider.name} ${response.status}): ${detail}`);
	}
	const data = (await response.json()) as { text?: unknown };
	if (typeof data.text !== "string") throw new Error("Transcription returned no text");
	return data.text.trim();
}
