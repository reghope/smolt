/**
 * Pool storage: ordered additional credentials per provider, usage ledger,
 * and reactive unavailability marks. Persisted to `<agentDir>/pool.json`
 * using the same locking discipline as auth.json (FileAuthStorageBackend:
 * proper-lockfile write locks, revision-checked reads).
 *
 * The PRIMARY credential of a provider stays in auth.json (managed by /login,
 * refreshed by core). The pool only stores ADDITIONAL credentials; chains are
 * composed as [primary, ...pool.credentials] with POOL_PRIMARY_ID referring
 * to the primary.
 */

import { join } from "node:path";
import type { OAuthCredential } from "@smolt/ai";
import { getAgentDir } from "../../config.ts";
import { FileAuthStorageBackend } from "../../core/auth-storage.ts";
import { getFileRevision } from "../../utils/paths.ts";
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

export interface PoolModifyResult<T> {
	result: T;
	next?: PoolData;
}

/**
 * Pool persistence. With a path: locked read-modify-write via
 * FileAuthStorageBackend and revision-checked cached reads. Without a path:
 * in-memory (tests).
 */
export class PoolStore {
	private readonly backend: FileAuthStorageBackend | undefined;
	private readonly path: string | undefined;
	private memory: PoolData = emptyPoolData();
	private cache: { revision: string; data: PoolData } | undefined;

	constructor(authPath?: string) {
		this.path = authPath;
		this.backend = authPath ? new FileAuthStorageBackend(authPath) : undefined;
	}

	static create(): PoolStore {
		return new PoolStore(join(getAgentDir(), "pool.json"));
	}

	read(): PoolData {
		if (!this.backend || !this.path) return this.memory;
		const revision = getFileRevision(this.path);
		if (revision === undefined) return emptyPoolData();
		if (this.cache && this.cache.revision === revision) return this.cache.data;
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const raw = this.backend.withLock((current) => ({ result: parsePoolData(current) }));
				this.cache = { revision, data: raw };
				return raw;
			} catch {
				// Torn read while another process wrote; retry once, then give up cached-free.
				this.cache = undefined;
			}
		}
		return emptyPoolData();
	}

	async modifyAsync<T>(
		fn: (data: PoolData) => Promise<PoolModifyResult<T>>,
		options?: { signal?: AbortSignal },
	): Promise<T> {
		if (!this.backend || !this.path) {
			const applied = await fn(this.memory);
			if (applied.next) this.memory = applied.next;
			return applied.result;
		}
		const result = await this.backend.withLockAsync(async (current) => {
			const applied = await fn(parsePoolData(current));
			return {
				result: applied.result,
				next: applied.next === undefined ? undefined : JSON.stringify(applied.next),
			};
		}, options);
		this.cache = undefined;
		return result;
	}

	modify<T>(fn: (data: PoolData) => PoolModifyResult<T>): T {
		if (!this.backend || !this.path) {
			const applied = fn(this.memory);
			if (applied.next) this.memory = applied.next;
			return applied.result;
		}
		const result = this.backend.withLock((current) => {
			const applied = fn(parsePoolData(current));
			return {
				result: applied.result,
				next: applied.next === undefined ? undefined : JSON.stringify(applied.next),
			};
		});
		this.cache = undefined;
		return result;
	}
}

/** A stored credential the pool can actually use; anything else is line noise. */
function isUsableCredential(entry: PoolCredential | undefined): entry is PoolCredential {
	if (!entry || typeof entry.id !== "string" || entry.id === "") return false;
	if (entry.type === "api_key")
		return typeof entry.key === "string" && entry.key !== "" && !/[\s\r\n]/.test(entry.key);
	if (entry.type === "oauth") return entry.oauth !== undefined && typeof entry.oauth === "object";
	return false;
}

function parsePoolData(raw: string | undefined): PoolData {
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
	return {
		version: 1,
		providers,
		ledger: data.ledger ?? {},
		unavailable: data.unavailable ?? {},
	};
}
