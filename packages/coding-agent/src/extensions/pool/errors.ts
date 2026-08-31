/**
 * Provider error classification for the failover driver: which failed
 * assistant messages mean "this credential is limited" (rotate to the next),
 * which mean "this model is not available on this credential" (ask the user),
 * and when a stated limit resets (marks are authoritative over local caps).
 */

const LIMIT_ERROR_PATTERN =
	/(usage|rate|weekly|monthly|daily|message)\s+limit|limit\s+(has\s+been\s+)?(reached|exceeded)|\b429\b|too\s+many\s+requests|insufficient_quota|quota\s+exceeded|exceeded\s+your\s+(plan|usage|org|monthly|weekly)|resource.?exhausted|hit\s+your\s+usage/i;

const MODEL_UNAVAILABLE_PATTERN =
	/(does\s+not|doesn't|no)\s+(have\s+)?(access|exist)|not\s+entitled|model\s*(is\s*)?not\s*found|not_found|invalid\s+model|unknown\s+model|no\s+access\s+to\s+(the\s+)?model|does\s+not\s+have\s+permission/i;

export function isLimitError(errorMessage: string | undefined): boolean {
	if (!errorMessage) return false;
	return LIMIT_ERROR_PATTERN.test(errorMessage);
}

export function isModelUnavailableError(errorMessage: string | undefined): boolean {
	if (!errorMessage) return false;
	return MODEL_UNAVAILABLE_PATTERN.test(errorMessage);
}

const ABSOLUTE_RESET_PATTERN =
	/(?:reset|resets|resetting|available|valid)\s+(?:at|by|from)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;
const RELATIVE_RESET_PATTERN =
	/(?:try\s+again|retry|resets?|available)\s+(?:in|after)\s+(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i;

function nextOccurrenceOfDay(now: number, hours: number, minutes: number, meridiem: string | undefined): number {
	const date = new Date(now);
	let h = hours;
	if (meridiem) {
		const lower = meridiem.toLowerCase();
		const isPm = lower === "pm";
		const isAm = lower === "am";
		if (isPm && h < 12) h += 12;
		if (isAm && h === 12) h = 0;
	}
	const candidate = new Date(date.getFullYear(), date.getMonth(), date.getDate(), h, minutes, 0, 0);
	if (candidate.getTime() <= now) {
		return candidate.getTime() + 24 * 60 * 60 * 1000;
	}
	return candidate.getTime();
}

function unitMs(unit: string): number {
	const lower = unit.toLowerCase();
	if (lower.startsWith("s")) return 1000;
	if (lower.startsWith("h")) return 60 * 60 * 1000;
	return 60 * 1000;
}

/**
 * Extract the stated reset time from a limit error message. Returns epoch ms,
 * or undefined when the message states no reset (caller applies a short mark).
 */
export function extractResetAt(errorMessage: string | undefined, now: number): number | undefined {
	if (!errorMessage) return undefined;

	const relative = RELATIVE_RESET_PATTERN.exec(errorMessage);
	if (relative) {
		return now + Number(relative[1]) * unitMs(relative[2]);
	}

	const absolute = ABSOLUTE_RESET_PATTERN.exec(errorMessage);
	if (absolute) {
		const hours = Number(absolute[1]);
		const minutes = absolute[2] ? Number(absolute[2]) : 0;
		return nextOccurrenceOfDay(now, hours, minutes, absolute[3]);
	}

	return undefined;
}

/** Mark duration when the provider states no reset time. */
export const DEFAULT_MARK_MS = 60 * 1000;

/** Clamp marks to a sane ceiling so a mis-parsed time cannot bench a credential for days. */
export const MAX_MARK_MS = 7 * 24 * 60 * 60 * 1000;

export function markUntil(errorMessage: string | undefined, now: number): number {
	const stated = extractResetAt(errorMessage, now);
	if (stated !== undefined) return Math.min(stated, now + MAX_MARK_MS);
	return now + DEFAULT_MARK_MS;
}
