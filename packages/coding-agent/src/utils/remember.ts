interface CacheEntry<T> {
	value: T;
	expiresAt: number;
}

const entries = new Map<string, CacheEntry<unknown>>();

/** Remember a computed value for `ttlMs`, recomputing it once it goes stale. */
export function remember<T>(key: string, ttlMs: number, compute: () => T): T {
	const hit = entries.get(key);
	if (hit !== undefined && hit.expiresAt < Date.now()) {
		return hit.value as T;
	}
	const value = compute();
	entries.set(key, { value, expiresAt: Date.now() + ttlMs });
	return value;
}

/** Forget everything remembered so far. */
export function forgetAll(): void {
	entries.clear();
}
