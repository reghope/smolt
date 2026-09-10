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
	/**
	 * Repos, as "owner/name", whose pull requests are reviewed as they arrive
	 * while smolt runs. A repo that is not checked out here is cloned to a
	 * temporary directory for the review, so a review anywhere reads the code
	 * around the diff rather than judging the diff alone.
	 */
	watchRepos?: string[];
	/**
	 * Whether those repos are actually watched. Off until setup turns it on, so
	 * a leftover repo list never starts a forwarder the reader did not ask for.
	 */
	watch?: boolean;
	/**
	 * Whether a finished review hands its findings to a hidden session that
	 * fixes them. Off unless the reader turns it on: a review that edits code
	 * on its own is a bigger promise than a review that reports.
	 */
	autoFix?: boolean;
}

export const DEFAULT_MAX_FINDINGS = 15;

/** The user-level review.json, where the settings page and /review setup write. */
export function reviewSettingsFile(): string {
	return path.join(getAgentDir(), "review.json");
}

/**
 * The file that says which process is watching a repo.
 *
 * GitHub allows one forwarder webhook per repository, so two sessions watching
 * the same repo would take turns deleting each other's hook. The claim makes
 * one of them the owner and the other wait for it.
 */
export function watchClaimFile(repo: string): string {
	return path.join(getAgentDir(), "review-watch", `${repo.replace(/[^a-zA-Z0-9._-]+/g, "-")}.json`);
}

/**
 * A review that was asked for and has not been delivered.
 *
 * A review takes minutes, and smolt is closed, restarted and killed in the
 * middle of them. Without a record on disk, a pull request that had been
 * acknowledged ("Reviewing this pull request now") simply never heard back,
 * and nothing retried it. Each queued review writes one of these; it is
 * removed when the review finishes, and every one still there is picked up
 * the next time watching starts.
 */
export interface PendingReview {
	/** "owner/name" of the repo the pull request is on. */
	repo: string;
	number: number;
	/** How many times it has been started, including runs that died. */
	attempts: number;
	at: number;
}

/**
 * How many times a review may be started before it is left alone.
 *
 * A pull request the reviewer genuinely cannot get through — too large, a
 * model that keeps erroring — must not be retried at every launch for ever.
 */
export const MAX_REVIEW_ATTEMPTS = 3;

function pendingDir(): string {
	return path.join(getAgentDir(), "review-pending");
}

function pendingFile(repo: string, number: number): string {
	return path.join(pendingDir(), `${repo.replace(/[^a-zA-Z0-9._-]+/g, "-")}-${number}.json`);
}

/** Record that a review is owed, or bump the attempt count of one already owed. */
export function markReviewPending(repo: string, number: number): PendingReview {
	const existing = listPendingReviews().find((entry) => entry.repo === repo && entry.number === number);
	const entry: PendingReview = {
		repo,
		number,
		attempts: (existing?.attempts ?? 0) + 1,
		at: Date.now(),
	};
	try {
		fs.mkdirSync(pendingDir(), { recursive: true });
		fs.writeFileSync(pendingFile(repo, number), `${JSON.stringify(entry)}\n`, "utf-8");
	} catch {
		// An unwritable agent dir costs the retry, not the review in hand.
	}
	return entry;
}

/** Forget a review: it has been delivered, or given up on. */
export function clearReviewPending(repo: string, number: number): void {
	try {
		fs.unlinkSync(pendingFile(repo, number));
	} catch {
		// already gone
	}
}

/** Every review still owed, oldest first. */
export function listPendingReviews(): PendingReview[] {
	let names: string[];
	try {
		names = fs.readdirSync(pendingDir());
	} catch {
		return [];
	}
	const entries: PendingReview[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const raw = readIfExists(path.join(pendingDir(), name));
		if (raw === undefined) continue;
		try {
			const parsed = JSON.parse(raw) as Partial<PendingReview>;
			if (typeof parsed.repo !== "string" || typeof parsed.number !== "number") continue;
			entries.push({
				repo: parsed.repo,
				number: parsed.number,
				attempts: typeof parsed.attempts === "number" ? parsed.attempts : 1,
				at: typeof parsed.at === "number" ? parsed.at : 0,
			});
		} catch {
			// malformed entry: not a reason to break startup
		}
	}
	return entries.sort((a, b) => a.at - b.at);
}

function readIfExists(file: string): string | undefined {
	try {
		return fs.readFileSync(file, "utf-8");
	} catch {
		return undefined;
	}
}

/**
 * Effective settings: the user-level review.json, then the project's overrides.
 *
 * A project may only narrow what a review does, never widen it. `watchRepos`
 * and `autoFix` are read from the user's own file alone: a cloned repository
 * must not be able to point a webhook at someone's account, or turn on a mode
 * that edits their code, just by shipping a `.smolt/review.json`.
 */
export function loadReviewSettings(cwd: string): ReviewSettings {
	const settings: ReviewSettings = {};
	const userFile = reviewSettingsFile();
	for (const file of [userFile, path.join(cwd, CONFIG_DIR_NAME, "review.json")]) {
		const raw = readIfExists(file);
		if (!raw) continue;
		try {
			const parsed = JSON.parse(raw) as ReviewSettings;
			if (typeof parsed.model === "string") settings.model = parsed.model;
			if (typeof parsed.maxFindings === "number" && parsed.maxFindings >= 1) {
				settings.maxFindings = Math.floor(parsed.maxFindings);
			}
			if (file !== userFile) continue;
			if (typeof parsed.autoFix === "boolean") settings.autoFix = parsed.autoFix;
			if (typeof parsed.watch === "boolean") settings.watch = parsed.watch;
			if (Array.isArray(parsed.watchRepos)) {
				settings.watchRepos = parsed.watchRepos.filter((repo): repo is string => typeof repo === "string");
			}
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
