/**
 * smolt pool extension: multiple credentials per provider with automatic
 * failover. When the active credential hits a usage limit, the next one in
 * the provider's pool is tried (attempt-based: the request only fails once
 * every credential has been tried). Detection is reactive (provider limit
 * errors mark a credential until its stated reset) plus a proactive local
 * usage ledger with per-plan window caps. Managed with /pool; the desktop
 * drives /pool add-key from its settings boxes (the desktop is a proxy of
 * the TUI).
 */

import { randomUUID } from "node:crypto";
import type { OAuthCredential, Provider } from "@smolt/ai";
import type { ExtensionAPI, ExtensionCommandContext } from "../../core/extensions/types.ts";
import type { ModelRegistry } from "../../core/model-registry.ts";
import { isLimitError, isModelUnavailableError, markUntil } from "./errors.ts";
import {
	orderedChain,
	POOL_PRIMARY_ID,
	type PoolCredential,
	type PoolData,
	PoolStore,
	providerPoolOf,
	type WindowKind,
} from "./storage.ts";
import { describeUsage, PLAN_PRESETS, recordUsage } from "./windows.ts";
import { nextCandidate, type PoolEngineHooks, sourceLabel, wrapProviderWithPool } from "./wrapper.ts";

export const POOL_RETRY_PROMPT =
	"[pool] The previous request failed on a provider usage limit. The next credential in the pool is now active — continue the interrupted work exactly where it stopped.";

const WINDOW_KINDS: WindowKind[] = ["5h", "weekly"];

interface EngineState {
	/** Provider id -> credential id the pool believes served the current/most recent request. Set by resolve() and advanced by the driver on re-issue. */
	current: Map<string, string>;
	/** Failure cascade for one settled run: credentials already tried. */
	cascade: { providerId: string; tried: Set<string> } | undefined;
	/** Provider awaiting a re-issue at agent_settled. */
	pendingReissue: string | undefined;
	/** Provider awaiting a model re-pick after a capability mismatch. */
	pendingModelPick: string | undefined;
	/** Toasts queued by resolve-time rotation (no ctx there); flushed on the next event. */
	toasts: string[];
}

export interface PoolExtensionOptions {
	/** Storage override; defaults to <agentDir>/pool.json. */
	store?: PoolStore;
}

export function createPoolExtension(options: PoolExtensionOptions = {}): (smolt: ExtensionAPI) => void {
	const store = options.store ?? PoolStore.create();

	return (smolt: ExtensionAPI): void => {
		const state: EngineState = {
			current: new Map(),
			cascade: undefined,
			pendingReissue: undefined,
			pendingModelPick: undefined,
			toasts: [],
		};

		const originals = new Map<string, Provider>();
		const wrapped = new Map<string, Provider>();

		const hooks: PoolEngineHooks = {
			noteResolved: (providerId, credentialId) => {
				state.current.set(providerId, credentialId);
			},
			noteRotation: (_providerId, message) => {
				state.toasts.push(`smolt pool: ${message}`);
			},
		};

		const hasPoolEntries = (data: PoolData, providerId: string): boolean =>
			providerPoolOf(data, providerId).credentials.length > 0;

		const syncWrappers = (modelRegistry: ModelRegistry): void => {
			const data = store.read();
			for (const providerId of Object.keys(data.providers)) {
				if (!hasPoolEntries(data, providerId) || wrapped.has(providerId)) continue;
				const base = originals.get(providerId) ?? modelRegistry.getProvider(providerId);
				if (!base) continue;
				originals.set(providerId, base);
				const wrapper = wrapProviderWithPool(base, store, hooks);
				wrapped.set(providerId, wrapper);
				smolt.registerProvider(wrapper);
			}
			for (const providerId of [...wrapped.keys()]) {
				if (hasPoolEntries(data, providerId)) continue;
				smolt.unregisterProvider(providerId);
				wrapped.delete(providerId);
			}
		};

		const appendCredential = (providerId: string, credential: Omit<PoolCredential, "id" | "addedAt">): string => {
			const id = randomUUID();
			store.modify((data) => ({
				result: id,
				next: {
					...data,
					providers: {
						...data.providers,
						[providerId]: {
							...providerPoolOf(data, providerId),
							credentials: [
								...providerPoolOf(data, providerId).credentials,
								{ ...credential, id, addedAt: Date.now() },
							],
						},
					},
				},
			}));
			return id;
		};

		const pooledProviderIds = (data: PoolData): string[] =>
			Object.keys(data.providers).filter((providerId) => hasPoolEntries(data, providerId));

		const knownProviderIds = (modelRegistry: ModelRegistry): string[] => {
			const ids = new Set<string>();
			for (const model of modelRegistry.getAll()) ids.add(model.provider);
			return [...ids].sort();
		};

		const runOAuthLogin = async (
			ctx: ExtensionCommandContext,
			providerId: string,
		): Promise<OAuthCredential | undefined> => {
			const oauth = originals.get(providerId)?.auth.oauth ?? ctx.modelRegistry.getProvider(providerId)?.auth.oauth;
			if (!oauth) {
				ctx.ui.notify(`${providerId} does not support subscription (OAuth) credentials.`, "warning");
				return undefined;
			}
			try {
				return await oauth.login({
					signal: AbortSignal.timeout(10 * 60 * 1000),
					prompt: async (prompt) => {
						if (prompt.type === "select") {
							const labels = prompt.options.map((option) => option.label);
							const choice = await ctx.ui.select(prompt.message, labels);
							if (choice === undefined) throw new Error("Login cancelled");
							return prompt.options.find((option) => option.label === choice)?.id ?? choice;
						}
						const placeholder = "placeholder" in prompt ? prompt.placeholder : undefined;
						const value = await ctx.ui.input(prompt.message, placeholder);
						if (value === undefined || !value.trim()) throw new Error("Login cancelled");
						return value;
					},
					notify: (event) => {
						if (event.type === "auth_url") ctx.ui.notify(`Open ${event.url} to authorize.`, "info");
						else if (event.type === "device_code") {
							ctx.ui.notify(`Enter code ${event.userCode} at ${event.verificationUri}`, "info");
						} else ctx.ui.notify(event.message, "info");
					},
				});
			} catch (error) {
				ctx.ui.notify(
					`Subscription login failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return undefined;
			}
		};

		const selectPlan = async (
			ctx: ExtensionCommandContext,
		): Promise<{ preset: string | undefined; caps: PoolCredential["caps"] } | undefined> => {
			const presetIds = Object.keys(PLAN_PRESETS);
			const labels = ["None", ...presetIds.map((id) => PLAN_PRESETS[id]?.label ?? id)];
			const picked = await ctx.ui.select("Plan for proactive rotation (optional, local estimates)", labels);
			if (picked === undefined) return undefined;
			const index = labels.indexOf(picked);
			if (index === 0) return { preset: undefined, caps: undefined };
			if (index < 0) {
				// A surface answering with something other than a listed label must
				// not silently abort the whole add — keep the credential, skip caps.
				ctx.ui.notify("Plan choice not recognised — credential kept, no caps set.", "warning");
				return { preset: undefined, caps: undefined };
			}
			const id = presetIds[index - 1]!;
			return { preset: id, caps: PLAN_PRESETS[id]?.caps };
		};

		/** Reject strings that cannot be a real API key before they reach disk. */
		const keyProblem = (key: string): string | undefined => {
			if (key === "") return "No key entered — nothing was added.";
			if (/[\s\r\n]/.test(key))
				return "That doesn't look like an API key (it contains whitespace) — nothing was added.";
			return undefined;
		};

		/** Canonical provider id, warning when the id isn't in the model catalog. */
		const canonicalProviderId = (ctx: ExtensionCommandContext, providerId: string): string => {
			const known = knownProviderIds(ctx.modelRegistry);
			const canonical =
				known.find((id) => id === providerId) ?? known.find((id) => id.toLowerCase() === providerId.toLowerCase());
			if (!canonical) {
				ctx.ui.notify(
					`"${providerId}" is not a provider in the model catalog — the pool entry will sit unused until a provider with that id exists.`,
					"warning",
				);
				return providerId;
			}
			return canonical;
		};

		const poolAdd = async (ctx: ExtensionCommandContext): Promise<void> => {
			const providerId = await ctx.ui.select(
				"Add a credential to the pool for which provider?",
				knownProviderIds(ctx.modelRegistry),
			);
			if (!providerId) return;
			const base = originals.get(providerId) ?? ctx.modelRegistry.getProvider(providerId);
			if (!base) {
				ctx.ui.notify(`Unknown provider: ${providerId}`, "error");
				return;
			}
			for (;;) {
				const kind =
					base.auth.oauth === undefined
						? "API key"
						: ((await ctx.ui.select(`Add which kind of credential for ${providerId}?`, [
								"API key",
								`Subscription (${base.auth.oauth.name})`,
							])) ?? undefined);
				if (kind === undefined) return;
				if (kind === "API key") {
					const key = (await ctx.ui.input(`API key for ${providerId}`))?.trim() ?? "";
					const problem = keyProblem(key);
					if (problem) {
						ctx.ui.notify(problem, "warning");
						return;
					}
					const label = (await ctx.ui.input("Label (optional)"))?.trim();
					const plan = await selectPlan(ctx);
					if (plan === undefined) return;
					appendCredential(providerId, {
						type: "api_key",
						key,
						label: label || undefined,
						plan: plan.preset,
						caps: plan.caps,
					});
				} else {
					const credential = await runOAuthLogin(ctx, providerId);
					if (!credential) return;
					const plan = await selectPlan(ctx);
					if (plan === undefined) return;
					appendCredential(providerId, {
						type: "oauth",
						oauth: credential,
						plan: plan.preset,
						caps: plan.caps,
					});
				}
				syncWrappers(ctx.modelRegistry);
				ctx.ui.notify(`Credential added to the ${providerId} pool.`, "info");
				if ((await ctx.ui.confirm("Credential pool", "Add another credential?")) !== true) return;
			}
		};

		/** A command-line token that reads like a pasted secret rather than a label. */
		const looksLikeSecret = (part: string): boolean =>
			/^(sk-|sk_|gsk_|csk-|xai-|AIza|api-|key-)/i.test(part) ||
			(part.length >= 28 && /\d/.test(part) && /[A-Za-z]/.test(part));

		const poolAddKey = async (ctx: ExtensionCommandContext, rest: string[]): Promise<void> => {
			const [rawProviderId, ...labelParts] = rest;
			if (!rawProviderId) {
				ctx.ui.notify(
					"Usage: /pool add-key <provider> [label] — you are asked for the key separately, so it never touches the transcript.",
					"warning",
				);
				return;
			}
			// The command line is transcript: a key pasted into it is already
			// recorded (and can become the session title). Refuse to store it and
			// say so plainly — the only safe key at that point is a rotated one.
			if (labelParts.some(looksLikeSecret)) {
				ctx.ui.notify(
					"That looks like an API key on the command line — it has already landed in this chat's transcript, so treat it as exposed and rotate it. " +
						`Run /pool add-key ${rawProviderId} (no key) and paste the new key into the prompt instead.`,
					"error",
				);
				return;
			}
			const providerId = canonicalProviderId(ctx, rawProviderId);
			const key =
				(await ctx.ui.input(`API key for ${providerId} (stored in pool.json, never echoed)`))?.trim() ?? "";
			const problem = keyProblem(key);
			if (problem) {
				ctx.ui.notify(problem, "warning");
				return;
			}
			appendCredential(providerId, { type: "api_key", key, label: labelParts.join(" ").trim() || undefined });
			syncWrappers(ctx.modelRegistry);
			ctx.ui.notify(`Added an API key to the ${providerId} pool.`, "info");
		};

		/** The provider to act on: the inline argument when given, else a selector. */
		const chooseProvider = async (
			ctx: ExtensionCommandContext,
			providers: string[],
			inline: string | undefined,
			title: string,
		): Promise<string | undefined> => {
			if (inline) {
				const match = providers.find((id) => id.toLowerCase() === inline.toLowerCase());
				if (match) return match;
				ctx.ui.notify(`No pool for "${inline}". Pooled providers: ${providers.join(", ") || "(none)"}.`, "warning");
				return undefined;
			}
			if (providers.length === 0) {
				ctx.ui.notify("No credential pools configured yet. Use /pool add.", "warning");
				return undefined;
			}
			return providers.length === 1 ? providers[0] : await ctx.ui.select(title, providers);
		};

		const poolRemove = async (ctx: ExtensionCommandContext, rest: string[]): Promise<void> => {
			const data = store.read();
			const providers = pooledProviderIds(data);
			const providerId = await chooseProvider(ctx, providers, rest[0], "Remove from which provider's pool?");
			if (!providerId) return;
			const pool = providerPoolOf(data, providerId);
			if (pool.credentials.length === 0) {
				ctx.ui.notify(`The ${providerId} pool has no removable credentials.`, "warning");
				return;
			}
			const labels = pool.credentials.map((entry) => sourceLabel(entry));
			const picked = await ctx.ui.select(`Remove which ${providerId} credential?`, labels);
			if (picked === undefined) return;
			const target = pool.credentials[labels.indexOf(picked)];
			if (!target) return;
			if (
				(await ctx.ui.confirm(
					"Remove credential",
					`Remove ${sourceLabel(target)} from the ${providerId} pool?`,
				)) !== true
			)
				return;
			store.modify((current) => {
				const currentPool = providerPoolOf(current, providerId);
				const remaining = currentPool.credentials.filter((entry) => entry.id !== target.id);
				// No ghosts: an empty provider disappears, an activeId pointing at
				// the removed credential falls back to the primary, and the
				// credential's ledger and marks go with it.
				const providers = { ...current.providers };
				if (remaining.length === 0) delete providers[providerId];
				else {
					providers[providerId] = {
						...currentPool,
						credentials: remaining,
						activeId: currentPool.activeId === target.id ? undefined : currentPool.activeId,
					};
				}
				const ledger = { ...current.ledger };
				delete ledger[target.id];
				const unavailable = { ...current.unavailable };
				delete unavailable[target.id];
				return { result: undefined, next: { ...current, providers, ledger, unavailable } };
			});
			syncWrappers(ctx.modelRegistry);
			ctx.ui.notify(`Removed ${sourceLabel(target)} from the ${providerId} pool.`, "info");
		};

		const poolActive = async (ctx: ExtensionCommandContext, rest: string[]): Promise<void> => {
			const data = store.read();
			const providers = pooledProviderIds(data);
			const providerId = await chooseProvider(
				ctx,
				providers,
				rest[0],
				"Set the active credential for which provider?",
			);
			if (!providerId) return;
			const chain = orderedChain(data, providerId);
			const labels = chain.map(
				(step) =>
					`${step.id === (providerPoolOf(data, providerId).activeId ?? POOL_PRIMARY_ID) ? "[active] " : ""}${step.id === POOL_PRIMARY_ID ? "primary credential" : sourceLabel(step.entry)}`,
			);
			const picked = await ctx.ui.select(`Which ${providerId} credential should be active?`, labels);
			if (picked === undefined) return;
			const target = chain[labels.indexOf(picked)];
			if (!target) return;
			store.modify((current) => ({
				result: undefined,
				next: {
					...current,
					providers: {
						...current.providers,
						[providerId]: { ...providerPoolOf(current, providerId), activeId: target.id },
					},
				},
			}));
			ctx.ui.notify(
				`Active credential for ${providerId}: ${target.id === POOL_PRIMARY_ID ? "primary" : sourceLabel(target.entry)}.`,
				"info",
			);
		};

		const poolModel = async (ctx: ExtensionCommandContext): Promise<void> => {
			const currentProviderId = ctx.model?.provider;
			const data = store.read();
			const providers = pooledProviderIds(data);
			const providerId =
				currentProviderId && providers.includes(currentProviderId)
					? currentProviderId
					: ((await ctx.ui.select(
							"Which provider?",
							providers.length > 0 ? providers : knownProviderIds(ctx.modelRegistry),
						)) ?? undefined);
			if (!providerId) return;

			// Previous models used for this provider (most recent first), then the full list.
			const history: string[] = [];
			for (const entry of ctx.sessionManager.getEntries()) {
				if (entry.type !== "model_change" || entry.provider !== providerId) continue;
				if (!history.includes(entry.modelId)) history.push(entry.modelId);
			}
			const catalogue = ctx.modelRegistry
				.getAll()
				.filter((model) => model.provider === providerId)
				.map((model) => model.id);
			const options = [...history, ...catalogue.filter((id) => !history.includes(id))];
			const picked = await ctx.ui.select(`Model for ${providerId} (recently used first)`, options.slice(0, 15));
			if (picked === undefined) return;
			const model = ctx.modelRegistry.find(providerId, picked);
			if (!model) {
				ctx.ui.notify(`Unknown model: ${picked}`, "error");
				return;
			}
			// Switching models mid-chat changes the context window and capabilities;
			// say so before doing it rather than after.
			if (
				(await ctx.ui.confirm(
					"Switch model",
					`Switch this chat to ${providerId}/${picked}? The context window and capabilities change with the model.`,
				)) !== true
			)
				return;
			const switched = await smolt.setModel(model);
			if (switched) {
				ctx.ui.notify(`Switched to ${providerId}/${picked}.`, "info");
			} else {
				const primaryAuthed = ctx.modelRegistry.hasConfiguredAuth(model);
				ctx.ui.notify(
					primaryAuthed
						? `Could not switch to ${picked} — the session refused the model change.`
						: `Could not switch to ${picked}: the model gate only sees the provider's primary credential (auth.json), and ${providerId} has none configured. Pooled keys alone cannot drive a switch yet — add a primary with /login ${providerId} first.`,
					"error",
				);
			}
		};

		const poolStatus = (ctx: ExtensionCommandContext): void => {
			const data = store.read();
			const lines: string[] = [];
			for (const providerId of pooledProviderIds(data)) {
				const pool = providerPoolOf(data, providerId);
				lines.push(`${providerId}:`);
				for (const step of orderedChain(data, providerId)) {
					const activeId = pool.activeId ?? POOL_PRIMARY_ID;
					const mark = data.unavailable[step.id];
					const unavailable =
						mark && mark.until > Date.now()
							? ` — unavailable until ${new Date(mark.until).toLocaleTimeString()}`
							: "";
					const usage = describeUsage(data.ledger[step.id], step.entry?.caps, Date.now());
					lines.push(
						`  ${step.id === activeId ? "[active] " : ""}${step.id === POOL_PRIMARY_ID ? "primary credential" : sourceLabel(step.entry)}${unavailable} — ${usage}`,
					);
				}
			}
			ctx.ui.notify(lines.length > 0 ? lines.join("\n") : "No credential pools configured. Use /pool add.", "info");
		};

		const flushToasts = (ui: { notify(message: string, type?: "info" | "warning" | "error"): void }): void => {
			while (state.toasts.length > 0) {
				const toast = state.toasts.shift();
				if (toast) ui.notify(toast, "info");
			}
		};

		smolt.on("session_start", async (_event, ctx) => {
			syncWrappers(ctx.modelRegistry);
		});

		smolt.on("before_agent_start", async (_event, ctx) => {
			state.cascade = undefined;
			syncWrappers(ctx.modelRegistry);
		});

		smolt.on("message_end", async (event, ctx) => {
			const message = event.message;
			if (message.role !== "assistant") return;
			flushToasts(ctx.ui);
			const providerId = message.provider;
			const data = store.read();
			if (!hasPoolEntries(data, providerId)) return;
			const credentialId =
				state.current.get(providerId) ?? providerPoolOf(data, providerId).activeId ?? POOL_PRIMARY_ID;

			if (message.stopReason === "error") {
				if (credentialId !== undefined && isLimitError(message.errorMessage)) {
					const until = markUntil(message.errorMessage, Date.now());
					const reason = (message.errorMessage ?? "usage limit").slice(0, 120);
					store.modify((current) => ({
						result: undefined,
						next: { ...current, unavailable: { ...current.unavailable, [credentialId]: { until, reason } } },
					}));
					const cascade =
						state.cascade && state.cascade.providerId === providerId
							? state.cascade
							: { providerId, tried: new Set<string>() };
					cascade.tried.add(credentialId);
					state.cascade = cascade;
					state.pendingReissue = providerId;
				} else if (isModelUnavailableError(message.errorMessage)) {
					state.pendingModelPick = providerId;
					state.cascade = undefined;
				}
				return;
			}
			if (message.stopReason === "aborted" || credentialId === undefined) return;

			// Success: record usage and make the working credential sticky.
			state.cascade = undefined;
			const tokens = message.usage?.totalTokens ?? 0;
			store.modify((current) => {
				if (!hasPoolEntries(current, providerId)) return { result: undefined };
				const existing = current.ledger[credentialId] ?? {};
				const nextLedger = { ...existing };
				for (const kind of WINDOW_KINDS) nextLedger[kind] = recordUsage(existing, kind, Date.now(), tokens);
				const pool = providerPoolOf(current, providerId);
				return {
					result: undefined,
					next: {
						...current,
						ledger: { ...current.ledger, [credentialId]: nextLedger },
						providers: { ...current.providers, [providerId]: { ...pool, activeId: credentialId } },
					},
				};
			});
		});

		smolt.on("agent_settled", async (_event, ctx) => {
			flushToasts(ctx.ui);
			if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
				state.pendingReissue = undefined;
				state.pendingModelPick = undefined;
				return;
			}

			if (state.pendingModelPick !== undefined) {
				const providerId = state.pendingModelPick;
				state.pendingModelPick = undefined;
				ctx.ui.notify(
					`Model unavailable on the current ${providerId} pool credential — run /pool model to pick one (recently used first).`,
					"warning",
				);
			}

			const providerId = state.pendingReissue;
			if (providerId === undefined) return;
			state.pendingReissue = undefined;
			if (!ctx.isIdle() || ctx.hasPendingMessages()) return;

			const data = store.read();
			const cascade = state.cascade;
			const failedId = state.current.get(providerId) ?? POOL_PRIMARY_ID;
			if (!cascade || cascade.providerId !== providerId) return;
			const next = nextCandidate(data, providerId, failedId, cascade.tried, Date.now());
			if (!next) {
				const count = providerPoolOf(data, providerId).credentials.length + 1;
				ctx.ui.notify(`All ${count} credentials for ${providerId} hit their usage limit.`, "error");
				state.cascade = undefined;
				return;
			}
			const pool = providerPoolOf(data, providerId);
			const failed =
				failedId === POOL_PRIMARY_ID ? undefined : pool.credentials.find((entry) => entry.id === failedId);
			ctx.ui.notify(`Usage limit on ${sourceLabel(failed)} — retrying with ${sourceLabel(next.entry)}.`, "warning");
			state.current.set(providerId, next.id);
			smolt.sendUserMessage(POOL_RETRY_PROMPT);
		});

		smolt.registerCommand("pool", {
			description: "Credential pools: failover keys per provider",
			handler: async (args, ctx) => {
				const [verb, ...rest] = args
					.trim()
					.split(/\s+/)
					.filter((part) => part.length > 0);
				switch (verb ?? "status") {
					case "add":
						return await poolAdd(ctx);
					case "add-key":
						return await poolAddKey(ctx, rest);
					case "remove":
						return await poolRemove(ctx, rest);
					case "active":
						return await poolActive(ctx, rest);
					case "model":
						return await poolModel(ctx);
					case "clear-marks": {
						store.modify((current) => ({ result: undefined, next: { ...current, unavailable: {} } }));
						ctx.ui.notify("Cleared availability marks.", "info");
						return;
					}
					case "status":
						return poolStatus(ctx);
					default:
						ctx.ui.notify(
							`Unknown /pool action: ${verb}. Actions: status, add, add-key, active, remove, model, clear-marks.`,
							"warning",
						);
				}
			},
		});
	};
}

/** Built-in extension instance. */
export function poolExtension(smolt: ExtensionAPI): void {
	createPoolExtension()(smolt);
}
