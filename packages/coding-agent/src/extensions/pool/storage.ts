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
import { getAgentDir } from "../../config.ts";
import { FileAuthStorageBackend } from "../../core/auth-storage.ts";
import { getFileRevision } from "../../utils/paths.ts";
import { emptyPoolData, type PoolData, parsePoolData } from "./model.ts";

export * from "./model.ts";

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
