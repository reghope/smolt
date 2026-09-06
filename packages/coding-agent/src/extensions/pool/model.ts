/**
 * The pool's data model and every pure operation on it: what a pool file
 * holds, and how it changes when a credential is added, renamed, or
 * removed. Nothing here touches the filesystem or the agent's config, so
 * the desktop app (whose main-process bundle cannot evaluate the config
 * module) can share these with the /pool command.
 */

import type { OAuthCredential } from "@smolt/ai";
import { effectiveWindow, exceedsCap } from "./windows.ts";

export const POOL_PRIMARY_ID = "__primary__";

export type WindowKind = "5h" | "weekly";

/** Estimated caps for proactive rotation. Optional per credential. */
export interface PoolPlanCaps {
	/** Max total tokens (input+output) per window. */
	tokens?: number;
	/** Max requests per window. */
	requests?: number;
}

export interface PoolCredential {
	id: string;
	type: "api_key" | "oauth";
	label?: string;
	addedAt: number;
	/** api_key entries. */
	key?: string;
	env?: Record<string, string>;
	/** oauth entries: the full stored credential, refreshed by the pool. */
	oauth?: OAuthCredential;
	/** Plan preset id used to seed `caps` (e.g. "anthropic-pro"). Informational. */
	plan?: string;
	/** Local cap estimates for proactive rotation; undefined = no proactive rotation. */
	caps?: Partial<Record<WindowKind, PoolPlanCaps>>;
}

export interface PoolWindowUsage {
	/** Rolling window anchor: first request inside the window. */
	start: number;
	requests: number;
	tokens: number;
}

export interface PoolUnavailableMark {
	/** Epoch ms when the credential becomes usable again. */
	until: number;
	reason: string;
}

export interface ProviderPool {
	/** Additional credentials beyond the primary, in fallback order. */
	credentials: PoolCredential[];
	/** Active credential id; undefined = primary. */
	activeId?: string;
}

export interface PoolData {
	version: 1;
	providers: Record<string, ProviderPool>;
	/** Usage ledger by credential id (POOL_PRIMARY_ID for the primary). */
	ledger: Record<string, Partial<Record<WindowKind, PoolWindowUsage>>>;
	/** Reactive unavailability marks by credential id. */
	unavailable: Record<string, PoolUnavailableMark>;
	/**
	 * Names for each provider's primary credential, by provider id. Kept apart
	 * from the pools because a provider with no failover keys has no pool
	 * entry to hang a name on, yet its one key still deserves one.
	 */
	primaryLabels?: Record<string, string>;
	/**
	 * Providers switched out of the pool. A provider is pooled by default:
	 * its instances fail over to each other and its allowance shows in the
	 * usage view. Listed here, it runs on its primary alone and stays out
	 * of the usage view.
	 */
	unpooled?: string[];
}

export function emptyPoolData(): PoolData {
	return { version: 1, providers: {}, ledger: {}, unavailable: {} };
}

export function providerPoolOf(data: PoolData, providerId: string): ProviderPool {
	const pool = data.providers[providerId];
	if (pool) return pool;
	return { credentials: [] };
}

/** Ordered fallback chain for a provider: rotated so the active credential is first. */
export function orderedChain(data: PoolData, providerId: string): Array<{ id: string; entry?: PoolCredential }> {
	const pool = providerPoolOf(data, providerId);
	const chain: Array<{ id: string; entry?: PoolCredential }> = [
		{ id: POOL_PRIMARY_ID },
		...pool.credentials.map((entry) => ({ id: entry.id, entry })),
	];
	const activeId = pool.activeId;
	if (!activeId) return chain;
	const index = chain.findIndex((step) => step.id === activeId);
	if (index <= 0) return chain;
	return [...chain.slice(index), ...chain.slice(0, index)];
}

export function isMarkedUnavailable(data: PoolData, id: string, now: number): boolean {
	const mark = data.unavailable[id];
	return mark !== undefined && mark.until > now;
}

export function isCapExceeded(data: PoolData, selection: { id: string; entry?: PoolCredential }, now: number): boolean {
	if (!selection.entry?.caps) return false;
	const usage = data.ledger[selection.id];
	for (const kind of Object.keys(selection.entry.caps) as WindowKind[]) {
		const cap = selection.entry.caps[kind];
		if (!cap) continue;
		const state = effectiveWindow(usage?.[kind], kind, now);
		if (exceedsCap(state, cap)) return true;
	}
	return false;
}

/**
 * The pool without one credential. No ghosts: an empty provider disappears,
 * an activeId pointing at the removed credential falls back to the primary,
 * and the credential's ledger and marks go with it. Pure, so the /pool
 * command and the desktop remove the same way.
 */
export function removePoolCredential(current: PoolData, providerId: string, credentialId: string): PoolData {
	const currentPool = providerPoolOf(current, providerId);
	const remaining = currentPool.credentials.filter((entry) => entry.id !== credentialId);
	const providers = { ...current.providers };
	if (remaining.length === 0) delete providers[providerId];
	else {
		providers[providerId] = {
			...currentPool,
			credentials: remaining,
			activeId: currentPool.activeId === credentialId ? undefined : currentPool.activeId,
		};
	}
	const ledger = { ...current.ledger };
	delete ledger[credentialId];
	const unavailable = { ...current.unavailable };
	delete unavailable[credentialId];
	return { ...current, providers, ledger, unavailable };
}

/**
 * The pool with one credential renamed. POOL_PRIMARY_ID names the provider's
 * primary key, which lives outside the pool; an empty label clears the name.
 */
export function relabelPoolCredential(
	current: PoolData,
	providerId: string,
	credentialId: string,
	label: string,
): PoolData {
	const trimmed = label.trim();
	if (credentialId === POOL_PRIMARY_ID) {
		const primaryLabels = { ...(current.primaryLabels ?? {}) };
		if (trimmed === "") delete primaryLabels[providerId];
		else primaryLabels[providerId] = trimmed;
		return { ...current, primaryLabels };
	}
	const pool = providerPoolOf(current, providerId);
	return {
		...current,
		providers: {
			...current.providers,
			[providerId]: {
				...pool,
				credentials: pool.credentials.map((entry) =>
					entry.id === credentialId ? { ...entry, label: trimmed === "" ? undefined : trimmed } : entry,
				),
			},
		},
	};
}

/** The pool with one more credential appended to a provider's chain. Pure. */
export function appendPoolCredential(
	current: PoolData,
	providerId: string,
	credential: Omit<PoolCredential, "id" | "addedAt">,
	id: string,
	addedAt: number = Date.now(),
): PoolData {
	const pool = providerPoolOf(current, providerId);
	return {
		...current,
		providers: {
			...current.providers,
			[providerId]: { ...pool, credentials: [...pool.credentials, { ...credential, id, addedAt }] },
		},
	};
}

/** Whether a provider takes part in the pool: failover across its instances, and a place in the usage view. */
export function isProviderPooled(data: PoolData, providerId: string): boolean {
	return !(data.unpooled ?? []).includes(providerId);
}

/** The pool with one provider switched in or out. */
export function setProviderPooled(current: PoolData, providerId: string, pooled: boolean): PoolData {
	const unpooled = (current.unpooled ?? []).filter((entry) => entry !== providerId);
	if (!pooled) unpooled.push(providerId);
	return { ...current, unpooled };
}

/** What a provider's primary credential is called: its given name, or "Primary". */
export function primaryLabelOf(data: PoolData, providerId: string): string {
	return data.primaryLabels?.[providerId] ?? "Primary";
}

export function isUsableCredential(entry: PoolCredential | undefined): entry is PoolCredential {
	if (!entry || typeof entry.id !== "string" || entry.id === "") return false;
	if (entry.type === "api_key")
		return typeof entry.key === "string" && entry.key !== "" && !/[\s\r\n]/.test(entry.key);
	if (entry.type === "oauth") return entry.oauth !== undefined && typeof entry.oauth === "object";
	return false;
}

export function parsePoolData(raw: string | undefined): PoolData {
	if (!raw || !raw.trim()) return emptyPoolData();
	const parsed: unknown = JSON.parse(raw);
	if (!parsed || typeof parsed !== "object") return emptyPoolData();
	const data = parsed as Partial<PoolData>;
	// Malformed entries (a command line pasted as a key, a half-written add)
	// are dropped LOUDLY: silence here is how a "saved" credential vanished
	// between sessions with nobody the wiser.
	const providers: Record<string, ProviderPool> = {};
	let dropped = 0;
	for (const [providerId, pool] of Object.entries(data.providers ?? {})) {
		const credentials = (pool?.credentials ?? []).filter((entry) => {
			const usable = isUsableCredential(entry);
			if (!usable) dropped += 1;
			return usable;
		});
		if (credentials.length === 0) continue;
		const activeId = credentials.some((entry) => entry.id === pool?.activeId) ? pool?.activeId : undefined;
		providers[providerId] = { credentials, activeId };
	}
	if (dropped > 0) {
		console.error(
			`smolt pool: dropped ${dropped} malformed credential entr${dropped === 1 ? "y" : "ies"} from pool.json`,
		);
	}
	const primaryLabels: Record<string, string> = {};
	for (const [providerId, label] of Object.entries(data.primaryLabels ?? {})) {
		if (typeof label === "string" && label.trim() !== "") primaryLabels[providerId] = label.trim();
	}
	const unpooled = (Array.isArray(data.unpooled) ? data.unpooled : []).filter(
		(entry): entry is string => typeof entry === "string" && entry !== "",
	);
	return {
		version: 1,
		providers,
		ledger: data.ledger ?? {},
		unavailable: data.unavailable ?? {},
		primaryLabels,
		unpooled,
	};
}
