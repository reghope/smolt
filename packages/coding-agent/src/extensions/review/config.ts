import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const CONFIG_DIR_NAME = ".smolt";

function getAgentDir(): string {
	const envDir = process.env.SMOLT_CODING_AGENT_DIR;
	if (envDir) {
		return envDir.startsWith("~") ? path.join(os.homedir(), envDir.slice(1)) : envDir;
	}
	return path.join(os.homedir(), CONFIG_DIR_NAME, "agent");
}

/** Settings from review.json (user agent dir, then project .smolt overrides). */
export interface ReviewSettings {
	/** "provider/id" of the model a review runs on. Unset means the session's own model. */
	model?: string;
	/** Cap on findings in a posted comment. Default 15. */
	maxFindings?: number;
	/** While smolt is running, review pull requests on this repo as they arrive. */
	watch?: boolean;
}

export const DEFAULT_MAX_FINDINGS = 15;

/** The user-level review.json, where the settings page and /review setup write. */
export function reviewSettingsFile(): string {
	return path.join(getAgentDir(), "review.json");
}

function readIfExists(file: string): string | undefined {
	try {
		return fs.readFileSync(file, "utf-8");
	} catch {
		return undefined;
	}
}

/** Effective settings: the user-level review.json, then the project's overrides. */
export function loadReviewSettings(cwd: string): ReviewSettings {
	const settings: ReviewSettings = {};
	for (const file of [reviewSettingsFile(), path.join(cwd, CONFIG_DIR_NAME, "review.json")]) {
		const raw = readIfExists(file);
		if (!raw) continue;
		try {
			const parsed = JSON.parse(raw) as ReviewSettings;
			if (typeof parsed.model === "string") settings.model = parsed.model;
			if (typeof parsed.maxFindings === "number" && parsed.maxFindings >= 1) {
				settings.maxFindings = Math.floor(parsed.maxFindings);
			}
			if (typeof parsed.watch === "boolean") settings.watch = parsed.watch;
		} catch {
			// malformed settings file: ignore rather than break the session
		}
	}
	return settings;
}

/** Merge into the user-level review.json, leaving anything it already holds. */
export function saveReviewSettings(update: ReviewSettings): void {
	const file = reviewSettingsFile();
	let current: ReviewSettings = {};
	const raw = readIfExists(file);
	if (raw) {
		try {
			current = JSON.parse(raw) as ReviewSettings;
		} catch {
			current = {};
		}
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify({ ...current, ...update }, null, "\t")}\n`, "utf-8");
}
