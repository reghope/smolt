/**
 * Pool-aware provider wrapper. Spreads the ORIGINAL built-in provider and
 * overrides only the auth methods so credential selection consults the pool:
 *
 * - apiKey.resolve: full replacement — walks [primary, ...extras] and returns
 *   the first credential that yields auth.
 * - oauth.toAuth: substitutes the pool selection for the stored credential
 *   the core passes in (core's resolveStoredOAuth drives expiry/refresh of
 *   the stored credential before calling toAuth; we re-select here).
 * - oauth.refresh: when the stored credential is inactive, refresh is
   best-effort so a dead stored token can never block healthy pool
 *   credentials; when the active primary fails to refresh, the pool rotates
 *   past it so the subsequent toAuth selects a healthy credential.
 *
 * The attempt itself is the test: marked/cap-exceeded credentials are only
 * skipped while clean alternatives exist (see selectAttemptOrder).
 */

import type { AuthResult, ModelAuth, OAuthAuth, OAuthCredential, Provider } from "@smolt/ai";
import {
	isCapExceeded,
	isMarkedUnavailable,
	orderedChain,
	POOL_PRIMARY_ID,
	type PoolCredential,
	type PoolData,
	type PoolModifyResult,
	type PoolStore,
	providerPoolOf,
} from "./storage.ts";

export interface PoolEngineHooks {
	/** Called when a request path resolved auth to a specific credential. */
	noteResolved(providerId: string, credentialId: string): void;
	/** Called when the pool changes which credential will be used. */
	noteRotation(providerId: string, message: string): void;
}

const OAUTH_FRESH_MARGIN_MS = 5 * 60 * 1000;

export function sourceLabel(entry: PoolCredential | undefined): string {
	if (!entry) return "primary credential";
	const label = entry.label ?? entry.id.slice(0, 8);
	return `pool credential "${label}"`;
}

/**
 * Attempt order for a provider: the chain rotated to the active credential,
 * with marked/cap-exceeded credentials demoted behind clean ones. If nothing
 * is clean the original rotation stands (the attempt is the test).
 */
export function selectAttemptOrder(
	data: PoolData,
	providerId: string,
	now: number,
): Array<{ id: string; entry?: PoolCredential }> {
	const rotated = orderedChain(data, providerId);
	const clean = rotated.filter((step) => !isMarkedUnavailable(data, step.id, now) && !isCapExceeded(data, step, now));
	if (clean.length === 0) return rotated;
	return [...clean, ...rotated.filter((step) => !clean.includes(step))];
}

/** Next candidate to try after `failedId`, skipping this cascade's tried set and known-bad credentials. */
export function nextCandidate(
	data: PoolData,
	providerId: string,
	failedId: string,
	tried: ReadonlySet<string>,
	now: number,
): { id: string; entry?: PoolCredential } | undefined {
	const chain = orderedChain(data, providerId);
	const index = chain.findIndex((step) => step.id === failedId);
	const rotated = index >= 0 ? [...chain.slice(index + 1), ...chain.slice(0, index)] : chain;
	return rotated.find(
		(step) =>
			step.id !== failedId &&
			!tried.has(step.id) &&
			!isMarkedUnavailable(data, step.id, now) &&
			!isCapExceeded(data, step, now),
	);
}

export function wrapProviderWithPool(base: Provider, store: PoolStore, hooks: PoolEngineHooks): Provider {
	const providerId = base.id;

	const credentialAuth = async (entry: PoolCredential): Promise<AuthResult | undefined> => {
		if (entry.type === "api_key") {
			if (!entry.key) return undefined;
			return { auth: { apiKey: entry.key }, env: entry.env, source: sourceLabel(entry) };
		}
		const oauth = base.auth.oauth;
		if (entry.type === "oauth" && entry.oauth && oauth) {
			const fresh = await ensureFreshOAuth(store, oauth, providerId, entry);
			if (!fresh) return undefined;
			return { auth: await oauth.toAuth(fresh), source: sourceLabel(entry) };
		}
		return undefined;
	};

	const wrapped: Provider = {
		...base,
		auth: {},
	};

	if (base.auth.apiKey) {
		const inherited = base.auth.apiKey;
		wrapped.auth.apiKey = {
			...inherited,
			resolve: async (input): Promise<AuthResult | undefined> => {
				const data = store.read();
				const now = Date.now();
				const activeId = providerPoolOf(data, providerId).activeId ?? POOL_PRIMARY_ID;
				for (const step of selectAttemptOrder(data, providerId, now)) {
					try {
						const result =
							step.id === POOL_PRIMARY_ID || !step.entry
								? await inherited.resolve(input)
								: await credentialAuth(step.entry);
						if (!result) continue;
						hooks.noteResolved(providerId, step.id);
						if (step.id !== activeId) {
							hooks.noteRotation(providerId, `using ${sourceLabel(step.entry)}`);
						}
						return result;
					} catch {}
				}
				return undefined;
			},
		};
	}

	if (base.auth.oauth) {
		const inheritedOauth: OAuthAuth = base.auth.oauth;
		const selectAndDerive = async (stored: OAuthCredential): Promise<ModelAuth | undefined> => {
			const data = store.read();
			const now = Date.now();
			const activeId = providerPoolOf(data, providerId).activeId ?? POOL_PRIMARY_ID;
			for (const step of selectAttemptOrder(data, providerId, now)) {
				try {
					if (step.id === POOL_PRIMARY_ID || !step.entry) {
						const auth = await inheritedOauth.toAuth(stored);
						hooks.noteResolved(providerId, POOL_PRIMARY_ID);
						if (POOL_PRIMARY_ID !== activeId) {
							hooks.noteRotation(providerId, "using the primary credential");
						}
						return auth;
					}
					if (step.entry.type === "oauth" && step.entry.oauth) {
						const fresh = await ensureFreshOAuth(store, inheritedOauth, providerId, step.entry);
						if (!fresh) continue;
						const auth = await inheritedOauth.toAuth(fresh);
						hooks.noteResolved(providerId, step.entry.id);
						if (step.entry.id !== activeId) {
							hooks.noteRotation(providerId, `using ${sourceLabel(step.entry)}`);
						}
						return auth;
					}
					if (step.entry.type === "api_key" && step.entry.key) {
						const auth: ModelAuth = { apiKey: step.entry.key };
						hooks.noteResolved(providerId, step.entry.id);
						if (step.entry.id !== activeId) {
							hooks.noteRotation(providerId, `using ${sourceLabel(step.entry)}`);
						}
						return auth;
					}
				} catch {}
			}
			return undefined;
		};

		wrapped.auth.oauth = {
			...inheritedOauth,
			toAuth: async (stored) => {
				const selected = await selectAndDerive(stored);
				if (selected) return selected;
				// No pool selection produced auth; behave exactly like the unwrapped provider.
				return await inheritedOauth.toAuth(stored);
			},
			refresh: async (stored, signal) => {
				const activeId = store.read().providers[providerId]?.activeId ?? POOL_PRIMARY_ID;
				if (activeId !== POOL_PRIMARY_ID) {
					// The stored credential is not the one in use: refresh best-effort so a
					// dead stored token can never block healthy pool credentials.
					try {
						return await inheritedOauth.refresh(stored, signal);
					} catch {
						return stored;
					}
				}
				try {
					return await inheritedOauth.refresh(stored, signal);
				} catch (error) {
					const hasExtras = (store.read().providers[providerId]?.credentials.length ?? 0) > 0;
					if (!hasExtras) throw error;
					// The active primary is dead; rotate past it so the subsequent toAuth
					// selects a healthy pool credential instead of surfacing the refresh error.
					store.modify((data): PoolModifyResult<void> => {
						const now = Date.now();
						const next = nextCandidate(data, providerId, POOL_PRIMARY_ID, new Set<string>(), now);
						if (!next || !next.entry) return { result: undefined };
						return {
							result: undefined,
							next: {
								...data,
								providers: {
									...data.providers,
									[providerId]: { ...providerPoolOf(data, providerId), activeId: next.id },
								},
							},
						};
					});
					hooks.noteRotation(
						providerId,
						"primary credential refresh failed — switched to the next pool credential",
					);
					return stored;
				}
			},
		};
	}

	return wrapped;
}

/** Refresh a pool OAuth entry under the pool lock when its validity is running out (CAS: re-checked inside). */
async function ensureFreshOAuth(
	store: PoolStore,
	oauth: OAuthAuth,
	providerId: string,
	entry: PoolCredential,
): Promise<OAuthCredential | undefined> {
	if (!entry.oauth) return undefined;
	if (entry.oauth.expires - Date.now() > OAUTH_FRESH_MARGIN_MS) return entry.oauth;
	return await store.modifyAsync(async (data): Promise<PoolModifyResult<OAuthCredential | undefined>> => {
		const current = providerPoolOf(data, providerId).credentials.find((candidate) => candidate.id === entry.id);
		if (!current?.oauth) return { result: undefined };
		if (current.oauth.expires - Date.now() > OAUTH_FRESH_MARGIN_MS) return { result: current.oauth };
		try {
			const refreshed = await oauth.refresh(current.oauth, AbortSignal.any([AbortSignal.timeout(15_000)]));
			return {
				result: refreshed,
				next: {
					...data,
					providers: {
						...data.providers,
						[providerId]: {
							...providerPoolOf(data, providerId),
							credentials: providerPoolOf(data, providerId).credentials.map((candidate) =>
								candidate.id === entry.id ? { ...candidate, oauth: refreshed } : candidate,
							),
						},
					},
				},
			};
		} catch {
			// Refresh failed: skip this candidate this round (the attempt is the test).
			return { result: undefined };
		}
	});
}
