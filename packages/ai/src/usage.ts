import type { Credential } from "./auth/types.ts";

/**
 * Subscription usage polled from providers that expose it.
 *
 * Windows are percent-based (a plan allowance consumed), not token counts —
 * providers describe subscriptions as "x% of your window used", so that is
 * the honest unit here. A provider without a usage endpoint simply has no
 * entry in the fetcher table and reports as unsupported.
 */
export interface UsageWindow {
	/** Provider's window key, e.g. "rolling", "weekly", "monthly". */
	key: string;
	/** Human label shown in UI. */
	label: string;
	/** Provider status, e.g. "ok" or "rate-limited". */
	status: string;
	/** 0-100, how much of the allowance is consumed. */
	percent: number;
	/** ISO timestamp when the window resets, when the provider says. */
	resetsAt?: string;
	/**
	 * A balance rather than a window: prepaid credit that drains and is
	 * topped up, with no reset. `percent` is the share spent when a ceiling
	 * is known, else 0, and `detail` says the amount in words.
	 */
	kind?: "balance";
	/** A short human figure to show beside the percent, e.g. "$9.97 left today". */
	detail?: string;
}

export interface ProviderUsage {
	providerId: string;
	providerName: string;
	windows: UsageWindow[];
	fetchedAt: number;
}

const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

/** The rolling window is five hours long; "5hr" says so where "Rolling" only hints. */
function openCodeGoWindowLabel(key: string): string {
	if (key === "rolling") return "5hr";
	if (key === "weekly") return "Weekly";
	if (key === "monthly") return "Monthly";
	return key.charAt(0).toUpperCase() + key.slice(1);
}

async function fetchOpenCodeGoUsage(credential: Credential): Promise<ProviderUsage | undefined> {
	// Usage follows the plan, which the API key identifies; only api_key
	// credentials carry one. Bearer is the header the endpoint accepts.
	if (credential.type !== "api_key") return undefined;
	const res = await fetch(OPENCODE_GO_USAGE_URL, { headers: { Authorization: `Bearer ${credential.key}` } });
	if (!res.ok) return undefined;
	const body = (await res.json()) as {
		usage?: Record<string, { status?: string; percent?: number; resetsAt?: string }>;
	};
	if (!body.usage) return undefined;
	const windows: UsageWindow[] = [];
	for (const [key, window_] of Object.entries(body.usage)) {
		if (typeof window_.percent !== "number") continue;
		windows.push({
			key,
			label: openCodeGoWindowLabel(key),
			status: window_.status ?? "ok",
			percent: window_.percent,
			resetsAt: window_.resetsAt,
		});
	}
	if (windows.length === 0) return undefined;
	return { providerId: "opencode-go", providerName: "OpenCode Go", windows, fetchedAt: Date.now() };
}

const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/** One window as Anthropic reports it; null for windows the plan does not have. */
interface AnthropicUsageWindow {
	utilization?: number | null;
	resets_at?: string | null;
	locked_reason?: string | null;
}

/**
 * A Claude subscription (Pro or Max) reports its allowance on the OAuth
 * usage endpoint: a five-hour window and a seven-day one, plus per-family
 * seven-day windows on plans that carve those out. Utilisation is already
 * a percentage. Only OAuth credentials carry a subscription; an API key is
 * pay-as-you-go and has no window to show.
 */
async function fetchAnthropicUsage(credential: Credential): Promise<ProviderUsage | undefined> {
	if (credential.type !== "oauth") return undefined;
	const res = await fetch(ANTHROPIC_USAGE_URL, {
		headers: {
			Authorization: `Bearer ${credential.access}`,
			"anthropic-beta": "oauth-2025-04-20",
			Accept: "application/json",
		},
	});
	if (!res.ok) return undefined;
	const body = (await res.json()) as Record<string, unknown> & { limits?: AnthropicLimit[] };
	const windows = anthropicWindowsFromLimits(body.limits) ?? anthropicWindowsFromFields(body);
	if (windows.length === 0) return undefined;
	return { providerId: "anthropic", providerName: "Anthropic", windows, fetchedAt: Date.now() };
}

/** One entry of the structured `limits` list: the session window, the weekly one, or a weekly window scoped to a model or surface. */
interface AnthropicLimit {
	kind?: string;
	group?: string;
	percent?: number;
	severity?: string;
	resets_at?: string | null;
	scope?: { model?: { id?: string | null; display_name?: string | null } | null; surface?: string | null } | null;
	is_active?: boolean;
}

/**
 * The structured form: self-describing, and the only place a per-model
 * window such as Fable appears. Ordered session, weekly, then each scoped
 * weekly window beneath it, so a plan with Fable access reads 5hr, Weekly,
 * Weekly (Fable).
 */
function anthropicWindowsFromLimits(limits: AnthropicLimit[] | undefined): UsageWindow[] | undefined {
	if (!Array.isArray(limits) || limits.length === 0) return undefined;
	const rank = (limit: AnthropicLimit): number =>
		limit.kind === "session" ? 0 : limit.kind === "weekly_all" ? 1 : limit.group === "weekly" ? 2 : 3;
	const windows: UsageWindow[] = [];
	for (const limit of [...limits].sort((a, b) => rank(a) - rank(b))) {
		if (typeof limit.percent !== "number") continue;
		const scopeName = limit.scope?.model?.display_name ?? limit.scope?.surface ?? undefined;
		const kind = limit.kind ?? "limit";
		const label =
			kind === "session"
				? "5hr"
				: kind === "weekly_all"
					? "Weekly"
					: limit.group === "weekly"
						? `Weekly (${scopeName ?? "scoped"})`
						: scopeName
							? `${humanizeKind(kind)} (${scopeName})`
							: humanizeKind(kind);
		const percent = Math.min(100, Math.max(0, limit.percent));
		windows.push({
			key: scopeName ? `${kind}-${scopeName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : kind,
			label,
			status: percent >= 100 || limit.severity === "exceeded" || limit.severity === "locked" ? "rate-limited" : "ok",
			percent,
			resetsAt: limit.resets_at ?? undefined,
		});
	}
	return windows.length > 0 ? windows : undefined;
}

/** "weekly_scoped" reads as "Weekly scoped". */
function humanizeKind(kind: string): string {
	const words = kind.replace(/_/g, " ").trim();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The older flat fields, for a response without the structured list. */
function anthropicWindowsFromFields(body: Record<string, unknown>): UsageWindow[] {
	const named: [string, string, string][] = [
		["five_hour", "5h", "5hr"],
		["seven_day", "weekly", "Weekly"],
		["seven_day_opus", "weekly-opus", "Weekly (Opus)"],
		["seven_day_sonnet", "weekly-sonnet", "Weekly (Sonnet)"],
	];
	const windows: UsageWindow[] = [];
	for (const [field, key, label] of named) {
		const window_ = body[field] as AnthropicUsageWindow | null | undefined;
		if (!window_ || typeof window_.utilization !== "number") continue;
		const percent = Math.min(100, Math.max(0, window_.utilization));
		windows.push({
			key,
			label,
			status: window_.locked_reason || percent >= 100 ? "rate-limited" : "ok",
			percent,
			resetsAt: window_.resets_at ?? undefined,
		});
	}
	return windows;
}

/** Percent of a ceiling that has been used, clamped to the bar. */
function spentPercent(used: number, limit: number): number {
	if (!(limit > 0)) return 0;
	return Math.min(100, Math.max(0, (used / limit) * 100));
}

/** Money to two places, with a currency sign where one is known. */
function money(amount: number, currency = "USD"): string {
	const sign = currency === "USD" ? "$" : currency === "CNY" ? "¥" : currency === "EUR" ? "€" : `${currency} `;
	return `${sign}${amount.toFixed(2)}`;
}

/**
 * OpenRouter: the key reports its own spending cap (daily, weekly, monthly
 * or lifetime) and the account reports prepaid credits. Both are money,
 * shown as a balance when there is no cap to measure against.
 */
async function fetchOpenRouterUsage(credential: Credential): Promise<ProviderUsage | undefined> {
	if (credential.type !== "api_key") return undefined;
	const headers = { Authorization: `Bearer ${credential.key}`, Accept: "application/json" };
	const keyRes = await fetch("https://openrouter.ai/api/v1/auth/key", { headers });
	if (!keyRes.ok) return undefined;
	const key = ((await keyRes.json()) as { data?: Record<string, unknown> }).data ?? {};
	const windows: UsageWindow[] = [];
	const limit = typeof key.limit === "number" ? key.limit : undefined;
	const reset = typeof key.limit_reset === "string" ? key.limit_reset : undefined;
	const usedInWindow =
		reset === "daily"
			? key.usage_daily
			: reset === "weekly"
				? key.usage_weekly
				: reset === "monthly"
					? key.usage_monthly
					: key.usage;
	if (limit !== undefined && typeof usedInWindow === "number") {
		const remaining = typeof key.limit_remaining === "number" ? key.limit_remaining : limit - usedInWindow;
		const label =
			reset === "daily" ? "Daily" : reset === "weekly" ? "Weekly" : reset === "monthly" ? "Monthly" : "Key limit";
		windows.push({
			key: `key-${reset ?? "total"}`,
			label,
			status: remaining <= 0 ? "rate-limited" : "ok",
			percent: spentPercent(usedInWindow, limit),
			detail: `${money(Math.max(0, remaining))} of ${money(limit)} left`,
		});
	}
	const creditRes = await fetch("https://openrouter.ai/api/v1/credits", { headers });
	if (creditRes.ok) {
		const credits = ((await creditRes.json()) as { data?: { total_credits?: number; total_usage?: number } }).data;
		if (credits && typeof credits.total_credits === "number" && typeof credits.total_usage === "number") {
			const left = credits.total_credits - credits.total_usage;
			windows.push({
				key: "credits",
				label: "Credits",
				status: left <= 0 ? "rate-limited" : "ok",
				percent: spentPercent(credits.total_usage, credits.total_credits),
				kind: "balance",
				detail: `${money(Math.max(0, left))} left of ${money(credits.total_credits)} bought`,
			});
		}
	}
	if (windows.length === 0) return undefined;
	return { providerId: "openrouter", providerName: "OpenRouter", windows, fetchedAt: Date.now() };
}

/** DeepSeek: a prepaid balance per currency, no windows. */
async function fetchDeepSeekUsage(credential: Credential): Promise<ProviderUsage | undefined> {
	if (credential.type !== "api_key") return undefined;
	const res = await fetch("https://api.deepseek.com/user/balance", {
		headers: { Authorization: `Bearer ${credential.key}`, Accept: "application/json" },
	});
	if (!res.ok) return undefined;
	const body = (await res.json()) as {
		is_available?: boolean;
		balance_infos?: { currency?: string; total_balance?: string; topped_up_balance?: string }[];
	};
	const windows: UsageWindow[] = [];
	for (const info of body.balance_infos ?? []) {
		const total = Number(info.total_balance);
		if (!Number.isFinite(total)) continue;
		const currency = info.currency ?? "USD";
		windows.push({
			key: `balance-${currency.toLowerCase()}`,
			label: `Balance (${currency})`,
			status: body.is_available === false || total <= 0 ? "rate-limited" : "ok",
			percent: 0,
			kind: "balance",
			detail: `${money(total, currency)} left`,
		});
	}
	if (windows.length === 0) return undefined;
	return { providerId: "deepseek", providerName: "DeepSeek", windows, fetchedAt: Date.now() };
}

/**
 * Kimi Code: a weekly quota at the top level and rate-limit windows beneath
 * it (a five-hour one on current plans), each as used/limit counts with a
 * reset time. Numbers arrive as strings.
 */
async function fetchKimiCodingUsage(credential: Credential): Promise<ProviderUsage | undefined> {
	const token = credential.type === "api_key" ? credential.key : credential.access;
	const res = await fetch("https://api.kimi.com/coding/v1/usages", {
		headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
	});
	interface Counter {
		limit?: string | number;
		used?: string | number;
		remaining?: string | number;
		resetTime?: string;
	}
	const toWindow = (key: string, label: string, counter: Counter | undefined): UsageWindow | undefined => {
		if (!counter) return undefined;
		const limit = Number(counter.limit);
		const used = Number(counter.used);
		if (!Number.isFinite(limit) || !Number.isFinite(used)) return undefined;
		const percent = spentPercent(used, limit);
		return {
			key,
			label,
			status: percent >= 100 ? "rate-limited" : "ok",
			percent,
			resetsAt: counter.resetTime,
			detail: `${Math.max(0, limit - used).toLocaleString()} of ${limit.toLocaleString()} left`,
		};
	};
	// The endpoint answers 429 with a quota message once the allowance is
	// spent; that is still an answer: everything is used up.
	if (res.status === 429) {
		return {
			providerId: "kimi-coding",
			providerName: "Kimi Code",
			windows: [{ key: "weekly", label: "Weekly", status: "rate-limited", percent: 100 }],
			fetchedAt: Date.now(),
		};
	}
	if (!res.ok) return undefined;
	const body = (await res.json()) as {
		usage?: Counter;
		limits?: { window?: { duration?: number; timeUnit?: string }; detail?: Counter }[];
	};
	const windows: UsageWindow[] = [];
	for (const entry of body.limits ?? []) {
		const minutes =
			entry.window?.timeUnit === "TIME_UNIT_MINUTE"
				? (entry.window.duration ?? 0)
				: entry.window?.timeUnit === "TIME_UNIT_HOUR"
					? (entry.window.duration ?? 0) * 60
					: entry.window?.timeUnit === "TIME_UNIT_DAY"
						? (entry.window.duration ?? 0) * 1440
						: 0;
		const label = minutes > 0 && minutes % 60 === 0 ? `${minutes / 60}hr` : minutes > 0 ? `${minutes}min` : "Window";
		const window_ = toWindow(`window-${minutes || windows.length}`, label, entry.detail);
		if (window_) windows.push(window_);
	}
	const weekly = toWindow("weekly", "Weekly", body.usage);
	if (weekly) windows.push(weekly);
	if (windows.length === 0) return undefined;
	return { providerId: "kimi-coding", providerName: "Kimi Code", windows, fetchedAt: Date.now() };
}

/**
 * A ChatGPT plan used through Codex: a five-hour window and a weekly one,
 * each as a percent used with a reset instant, behind the account the
 * token belongs to.
 */
async function fetchOpenAICodexUsage(credential: Credential): Promise<ProviderUsage | undefined> {
	if (credential.type !== "oauth") return undefined;
	const accountId = typeof credential.accountId === "string" ? credential.accountId : undefined;
	const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
		headers: {
			Authorization: `Bearer ${credential.access}`,
			Accept: "application/json",
			...(accountId ? { "chatgpt-account-id": accountId } : {}),
		},
	});
	if (!res.ok) return undefined;
	interface Window {
		used_percent?: number;
		limit_window_seconds?: number;
		reset_at?: number;
		resets_at?: number;
	}
	const body = (await res.json()) as {
		plan_type?: string;
		rate_limit?: { primary_window?: Window | null; secondary_window?: Window | null };
	};
	const windows: UsageWindow[] = [];
	const add = (key: string, fallback: string, window_: Window | null | undefined): void => {
		if (!window_ || typeof window_.used_percent !== "number") return;
		const seconds = window_.limit_window_seconds ?? 0;
		const label = seconds >= 6 * 86_400 ? "Weekly" : seconds >= 3_600 ? `${Math.round(seconds / 3_600)}hr` : fallback;
		const reset = window_.reset_at ?? window_.resets_at;
		windows.push({
			key,
			label,
			status: window_.used_percent >= 100 ? "rate-limited" : "ok",
			percent: Math.min(100, Math.max(0, window_.used_percent)),
			resetsAt: typeof reset === "number" ? new Date(reset * 1000).toISOString() : undefined,
		});
	};
	add("primary", "5hr", body.rate_limit?.primary_window);
	add("secondary", "Weekly", body.rate_limit?.secondary_window);
	if (windows.length === 0) return undefined;
	return { providerId: "openai-codex", providerName: "OpenAI Codex", windows, fetchedAt: Date.now() };
}

/**
 * GLM Coding Plan (z.ai): a list of limits, each a percent with a reset
 * instant in epoch milliseconds. Token limits are the plan windows; a
 * credit limit is pay-as-you-go spend; a time limit is a monthly count of
 * tool calls such as web searches.
 */
async function fetchZaiUsage(
	credential: Credential,
	providerId: string,
	base: string,
): Promise<ProviderUsage | undefined> {
	if (credential.type !== "api_key") return undefined;
	const res = await fetch(`${base}/api/monitor/usage/quota/limit`, {
		headers: { Authorization: `Bearer ${credential.key}`, Accept: "application/json", "Accept-Language": "en-US,en" },
	});
	if (!res.ok) return undefined;
	const body = (await res.json()) as {
		success?: boolean;
		data?: {
			limits?: { type?: string; percentage?: number; nextResetTime?: number; unit?: number; number?: number }[];
		};
	};
	const windows: UsageWindow[] = [];
	let tokenWindows = 0;
	for (const limit of body.data?.limits ?? []) {
		if (typeof limit.percentage !== "number") continue;
		const type = limit.type ?? "";
		let label: string;
		if (type === "TOKENS_LIMIT") {
			tokenWindows += 1;
			label = tokenWindows === 1 ? "Tokens" : `Tokens (${tokenWindows})`;
		} else if (type === "CREDIT_LIMIT") label = "Credits";
		else if (type === "TIME_LIMIT") label = "Tool calls";
		else label = type.replace(/_LIMIT$/, "").toLowerCase() || "Limit";
		windows.push({
			key: `${type.toLowerCase()}-${windows.length}`,
			label,
			status: limit.percentage >= 100 ? "rate-limited" : "ok",
			percent: Math.min(100, Math.max(0, limit.percentage)),
			resetsAt: typeof limit.nextResetTime === "number" ? new Date(limit.nextResetTime).toISOString() : undefined,
		});
	}
	if (windows.length === 0) return undefined;
	return {
		providerId,
		providerName: providerId === "zai-coding-cn" ? "Z.ai (CN)" : "Z.ai",
		windows,
		fetchedAt: Date.now(),
	};
}

/**
 * GitHub Copilot: the plan reports remaining shares of premium requests,
 * chat and completions. The GitHub token (kept as the refresh half of the
 * credential) is the one the endpoint accepts; the short-lived Copilot
 * session token is not.
 */
async function fetchGitHubCopilotUsage(credential: Credential): Promise<ProviderUsage | undefined> {
	if (credential.type !== "oauth") return undefined;
	const res = await fetch("https://api.github.com/copilot_internal/user", {
		headers: {
			Authorization: `token ${credential.refresh}`,
			Accept: "application/json",
			"Editor-Version": "vscode/1.107.0",
			"User-Agent": "smolt",
		},
	});
	if (!res.ok) return undefined;
	interface Snapshot {
		percent_remaining?: number;
		entitlement?: number;
		remaining?: number;
		unlimited?: boolean;
	}
	const body = (await res.json()) as {
		copilot_plan?: string;
		quota_reset_date?: string;
		quota_snapshots?: Record<string, Snapshot | undefined>;
	};
	const named: [string, string][] = [
		["premium_interactions", "Premium requests"],
		["chat", "Chat"],
		["completions", "Completions"],
	];
	const windows: UsageWindow[] = [];
	for (const [field, label] of named) {
		const snapshot = body.quota_snapshots?.[field];
		if (!snapshot || snapshot.unlimited || typeof snapshot.percent_remaining !== "number") continue;
		const percent = Math.min(100, Math.max(0, 100 - snapshot.percent_remaining));
		windows.push({
			key: field,
			label,
			status: percent >= 100 ? "rate-limited" : "ok",
			percent,
			resetsAt: body.quota_reset_date ? new Date(body.quota_reset_date).toISOString() : undefined,
			detail:
				typeof snapshot.remaining === "number" && typeof snapshot.entitlement === "number"
					? `${snapshot.remaining.toLocaleString()} of ${snapshot.entitlement.toLocaleString()} left`
					: undefined,
		});
	}
	if (windows.length === 0) return undefined;
	return { providerId: "github-copilot", providerName: "GitHub Copilot", windows, fetchedAt: Date.now() };
}

const usageFetchers: Record<string, (credential: Credential) => Promise<ProviderUsage | undefined>> = {
	"opencode-go": fetchOpenCodeGoUsage,
	anthropic: fetchAnthropicUsage,
	openrouter: fetchOpenRouterUsage,
	deepseek: fetchDeepSeekUsage,
	"kimi-coding": fetchKimiCodingUsage,
	"openai-codex": fetchOpenAICodexUsage,
	zai: (credential) => fetchZaiUsage(credential, "zai", "https://api.z.ai"),
	"zai-coding-cn": (credential) => fetchZaiUsage(credential, "zai-coding-cn", "https://open.bigmodel.cn"),
	"github-copilot": fetchGitHubCopilotUsage,
};

/** Whether a provider exposes subscription usage at all. */
export function supportsProviderUsage(providerId: string): boolean {
	return providerId in usageFetchers;
}

/** Poll a provider's subscription usage; undefined when unavailable. */
export async function fetchProviderUsage(
	providerId: string,
	credential: Credential,
): Promise<ProviderUsage | undefined> {
	const fetcher = usageFetchers[providerId];
	if (!fetcher) return undefined;
	try {
		return await fetcher(credential);
	} catch {
		return undefined;
	}
}
