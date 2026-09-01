import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// Type-only import: a standalone install of this module outside the smolt
// tree switches this single line to `from "smolt"`.
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { DegenerationWatcher } from "./detector.ts";

/**
 * Degeneration guard: watches the assistant's stream for repetition
 * collapse (the same sentence looping over and over — a failure mode of
 * small models deep in agentic contexts), aborts the response the moment
 * it trips, and retries the identical request once. A fresh sample almost
 * always escapes the attractor; if the retry degenerates too, the run
 * stops with a visible error instead of streaming garbage.
 *
 * Detection lives in detector.ts (pure, conservative — legitimate code
 * output repeats, so a trip needs many consecutive identical prose-like
 * units). The abort-and-reissue mechanics are core's `smolt.abortResponse`
 * primitive; this extension is only the policy around it.
 *
 * Config: `~/.smolt/agent/degeneration.json` —
 * `{ "enabled": true, "maxRetries": 1, "minRepeats": 10 }`.
 */

export interface DegenerationConfig {
	enabled: boolean;
	maxRetries: number;
	minRepeats: number;
}

export const DEFAULT_DEGENERATION_CONFIG: DegenerationConfig = {
	enabled: true,
	maxRetries: 1,
	minRepeats: 10,
};

export function readDegenerationConfig(configPath: string | undefined): DegenerationConfig {
	const config = { ...DEFAULT_DEGENERATION_CONFIG };
	if (!configPath) return config;
	try {
		if (!existsSync(configPath)) return config;
		const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as Partial<DegenerationConfig>;
		if (typeof parsed.enabled === "boolean") config.enabled = parsed.enabled;
		if (typeof parsed.maxRetries === "number" && parsed.maxRetries >= 0) config.maxRetries = parsed.maxRetries;
		if (typeof parsed.minRepeats === "number" && parsed.minRepeats >= 3) config.minRepeats = parsed.minRepeats;
	} catch {
		// A malformed config is not a reason to stop guarding.
	}
	return config;
}

/** Concatenate the streamed prose of a partial assistant message. */
function accumulatedText(message: unknown): string {
	const content = (message as { content?: unknown })?.content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as { type?: string; text?: string; thinking?: string };
		if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
		else if (b.type === "thinking" && typeof b.thinking === "string") parts.push(b.thinking);
	}
	return parts.join("\n");
}

export function createDegenerationGuard(smolt: ExtensionAPI, config: DegenerationConfig): void {
	if (!config.enabled) return;

	const watcher = new DegenerationWatcher(config.minRepeats);
	// Retries used within the current turn; a turn with several degenerate
	// responses shares one budget rather than retrying each forever.
	let attempts = 0;
	// A trip aborts mid-stream but deltas may still arrive; ask only once.
	let trippedThisResponse = false;

	smolt.on("before_agent_start", async () => {
		attempts = 0;
	});

	smolt.on("message_start", async (event) => {
		if (event.message.role === "assistant") {
			watcher.reset();
			trippedThisResponse = false;
		}
	});

	smolt.on("message_update", async (event) => {
		if (trippedThisResponse) return;
		const delta = event.assistantMessageEvent;
		if (delta?.type !== "text_delta" && delta?.type !== "thinking_delta") return;
		const reason = watcher.check(accumulatedText(event.message));
		if (reason === undefined) return;
		trippedThisResponse = true;
		if (attempts < config.maxRetries) {
			attempts += 1;
			smolt.abortResponse(`Degenerate output detected — ${reason}. Retrying with a fresh sample.`, {
				retry: true,
				attempt: attempts,
				maxAttempts: config.maxRetries,
			});
		} else {
			smolt.abortResponse(
				`Degenerate output detected — ${reason}. Retry limit reached; stopping. ` +
					"A stronger model may handle this context better.",
				{ retry: false, attempt: attempts, maxAttempts: config.maxRetries },
			);
		}
	});
}

// Self-contained path resolution (no runtime imports from the host tree) so
// the module stays drop-in portable as a regular extension.
const CONFIG_DIR_NAME = ".smolt";

function getAgentDir(): string {
	const envDir = process.env.SMOLT_CODING_AGENT_DIR;
	if (envDir) {
		return envDir.startsWith("~") ? join(homedir(), envDir.slice(1)) : envDir;
	}
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

export default function degenerationExtension(smolt: ExtensionAPI): void {
	createDegenerationGuard(smolt, readDegenerationConfig(join(getAgentDir(), "degeneration.json")));
}
