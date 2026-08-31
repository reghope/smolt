/**
 * Usage ledger window math and plan cap presets for proactive rotation.
 *
 * Windows are ROLLING, anchored at the first request inside the window
 * (exact provider window phases are not published; provider-stated resets
 * and error marks always win over these local estimates).
 */

import type { PoolPlanCaps, PoolWindowUsage, WindowKind } from "./storage.ts";

export const WINDOW_DURATIONS_MS: Record<WindowKind, number> = {
	"5h": 5 * 60 * 60 * 1000,
	weekly: 7 * 24 * 60 * 60 * 1000,
};

/** The window state that applies at `now`, resetting an expired one to a fresh anchor. */
export function effectiveWindow(usage: PoolWindowUsage | undefined, kind: WindowKind, now: number): PoolWindowUsage {
	if (!usage || now - usage.start >= WINDOW_DURATIONS_MS[kind]) return { start: now, requests: 0, tokens: 0 };
	return usage;
}

/** Record one request (+tokens) into the ledger window, rolling it forward if expired. */
export function recordUsage(
	usage: Partial<Record<WindowKind, PoolWindowUsage>> | undefined,
	kind: WindowKind,
	now: number,
	tokens: number,
): PoolWindowUsage {
	const state = effectiveWindow(usage?.[kind], kind, now);
	return { start: state.start, requests: state.requests + 1, tokens: state.tokens + tokens };
}

/** True when the window has consumed at least one configured cap dimension. */
export function exceedsCap(state: PoolWindowUsage, cap: PoolPlanCaps): boolean {
	if (cap.tokens !== undefined && state.tokens >= cap.tokens) return true;
	if (cap.requests !== undefined && state.requests >= cap.requests) return true;
	return false;
}

/**
 * Built-in cap estimates per plan. These are community-observed request
 * counts used ONLY as pre-emptive rotation heuristics — they are not
 * provider contracts. Per-credential `caps` overrides always win, and a
 * provider-stated limit error marks the credential down regardless.
 */
export const PLAN_PRESETS: Record<string, { label: string; caps: Partial<Record<WindowKind, PoolPlanCaps>> }> = {
	"anthropic-pro": {
		label: "Anthropic Pro",
		caps: { "5h": { requests: 45 }, weekly: { requests: 220 } },
	},
	"anthropic-max-5x": {
		label: "Anthropic Max 5x",
		caps: { "5h": { requests: 220 }, weekly: { requests: 880 } },
	},
	"anthropic-max-20x": {
		label: "Anthropic Max 20x",
		caps: { "5h": { requests: 880 }, weekly: { requests: 3520 } },
	},
	"openai-plus": {
		label: "ChatGPT Plus (Codex)",
		caps: { "5h": { requests: 150 }, weekly: { requests: 600 } },
	},
	"openai-pro": {
		label: "ChatGPT Pro (Codex)",
		caps: { "5h": { requests: 600 }, weekly: { requests: 2400 } },
	},
};

/** Compact human-readable ledger summary for /pool status. */
export function describeUsage(
	usage: Partial<Record<WindowKind, PoolWindowUsage>> | undefined,
	caps: Partial<Record<WindowKind, PoolPlanCaps>> | undefined,
	now: number,
): string {
	const kinds: WindowKind[] = ["5h", "weekly"];
	const parts: string[] = [];
	for (const kind of kinds) {
		const cap = caps?.[kind];
		if (!cap) continue;
		const state = effectiveWindow(usage?.[kind], kind, now);
		const used: string[] = [];
		if (cap.requests !== undefined) used.push(`${Math.min(state.requests, cap.requests)}/${cap.requests} req`);
		if (cap.tokens !== undefined) used.push(`${Math.min(state.tokens, cap.tokens)}/${cap.tokens} tok`);
		parts.push(`${kind}: ${used.length > 0 ? used.join(", ") : "no cap"}`);
	}
	return parts.length > 0 ? parts.join(" · ") : "no plan set — rotates only when the provider says stop";
}
