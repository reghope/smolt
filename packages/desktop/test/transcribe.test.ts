import { describe, expect, test } from "vitest";
import { findTranscriptionProvider, transcribeAudio } from "../src/main/transcribe.ts";

/**
 * Provider selection for composer dictation. The renderer only ever learns
 * whether *a* provider exists, so the key itself never crosses into the page.
 */

describe("findTranscriptionProvider", () => {
	test("returns nothing when no key is configured", () => {
		expect(findTranscriptionProvider({})).toBeUndefined();
	});

	test("prefers OpenAI when its key is present", () => {
		const provider = findTranscriptionProvider({ OPENAI_API_KEY: "sk-test" });
		expect(provider?.name).toBe("OpenAI");
		expect(provider?.url).toContain("api.openai.com");
		expect(provider?.key).toBe("sk-test");
	});

	test("falls back to Groq when only its key is present", () => {
		const provider = findTranscriptionProvider({ GROQ_API_KEY: "gsk-test" });
		expect(provider?.name).toBe("Groq");
		expect(provider?.url).toContain("api.groq.com");
	});

	test("ignores blank keys", () => {
		expect(findTranscriptionProvider({ OPENAI_API_KEY: "   " })).toBeUndefined();
	});

	test("a custom endpoint overrides the built-ins", () => {
		const provider = findTranscriptionProvider({
			OPENAI_API_KEY: "sk-test",
			SMOLT_DESKTOP_TRANSCRIBE_URL: "https://example.invalid/v1/audio/transcriptions",
			SMOLT_DESKTOP_TRANSCRIBE_KEY: "local-key",
			SMOLT_DESKTOP_TRANSCRIBE_MODEL: "whisper-local",
		});
		expect(provider?.url).toBe("https://example.invalid/v1/audio/transcriptions");
		expect(provider?.model).toBe("whisper-local");
	});

	test("a custom endpoint without a key falls through to the built-ins", () => {
		const provider = findTranscriptionProvider({
			OPENAI_API_KEY: "sk-test",
			SMOLT_DESKTOP_TRANSCRIBE_URL: "https://example.invalid/v1/audio/transcriptions",
		});
		expect(provider?.name).toBe("OpenAI");
	});
});

describe("transcribeAudio", () => {
	test("explains what to configure when no provider is available", async () => {
		await expect(transcribeAudio(new Uint8Array([1, 2, 3]), "audio/webm", undefined)).rejects.toThrow(
			/OPENAI_API_KEY or GROQ_API_KEY/,
		);
	});
});
