import type {
	ApiKeyCredential,
	AuthContext,
	AuthResult,
	Model,
	Provider,
	ProviderStreamOptions,
	RefreshModelsContext,
} from "@smolt/ai";
import { stream, streamSimple } from "@smolt/ai/compat";
import {
	LlamaClient,
	type LlamaModelInfo,
	type LlamaServerProps,
	llamaInferenceUrl,
	normalizeLlamaServerUrl,
	templateSupportsThinking,
} from "./client.ts";

export const LLAMA_PROVIDER_ID = "llama.cpp";
export const DEFAULT_LLAMA_SERVER_URL = "http://127.0.0.1:8080";
/** The most a local model is asked to write in one reply. */
export const LLAMA_MAX_OUTPUT_TOKENS = 32768;
function credentialServerUrl(credential: ApiKeyCredential | undefined): string | undefined {
	const value = credential?.env?.LLAMA_BASE_URL;
	return typeof value === "string" && value.trim() ? normalizeLlamaServerUrl(value) : undefined;
}

async function resolveServerUrl(
	ctx: AuthContext,
	credential: ApiKeyCredential | undefined,
): Promise<string | undefined> {
	const configured = credentialServerUrl(credential) ?? (await ctx.env("LLAMA_BASE_URL"))?.trim();
	return configured ? normalizeLlamaServerUrl(configured) : undefined;
}

function modelIsSelectable(model: LlamaModelInfo, routerAutoload: boolean): boolean {
	if (model.status.value === "loaded") return true;
	// llama.cpp reports idle-slept models as "sleeping"; requests wake them automatically.
	if (model.status.value === "sleeping") return true;
	// Any unloaded entry is routable when the router's autoload can start it on
	// first use, whatever put it in the catalog. The router synthesises a preset
	// for the GGUFs it finds in the models directory and the HuggingFace cache
	// just as it does for a hand-written one, and loads them the same way — so
	// requiring `source === "preset"` hid every local model except the one
	// already running, which is not what a picker of local models is for.
	// One whose last load failed is listed too, ranked last rather than hidden:
	// dropping it made a models folder look emptier than it is, and the usual
	// cause is a preset the reader can fix once they can see what is missing.
	return routerAutoload && model.status.value === "unloaded";
}

/**
 * Where an entry sits in the picker. The model already up comes first: it is
 * the one that answers without a load, and on a single-GPU box choosing any
 * other evicts it. Models the router would start on demand follow, and the
 * ones whose last start failed come last.
 */
function selectionRank(model: LlamaModelInfo): number {
	if (model.status.value === "loaded" || model.status.value === "sleeping") return 0;
	return model.status.failed === true ? 2 : 1;
}

/** The catalog as picker entries: the unroutable dropped, the running one first. */
function selectableModels(
	catalog: readonly LlamaModelInfo[],
	serverUrl: string,
	routerAutoload: boolean,
	props?: ReadonlyMap<string, LlamaServerProps>,
): Model<"openai-completions">[] {
	return catalog
		.filter((model) => modelIsSelectable(model, routerAutoload))
		.sort((left, right) => selectionRank(left) - selectionRank(right))
		.map((model) => toSmoltModel(model, serverUrl, props?.get(model.id)));
}

async function routerAutoloadEnabled(
	client: LlamaClient,
	catalog: readonly LlamaModelInfo[],
	signal: AbortSignal,
): Promise<boolean> {
	if (!catalog.some((model) => model.status.value === "unloaded")) return false;
	try {
		return (await client.props({ signal })).models_autoload === true;
	} catch {
		return false;
	}
}

/**
 * A catalog entry as a Smolt model. The loaded model's own props, when they
 * are known, say what the catalog cannot: the context it was really started
 * with, and whether its chat template can switch thinking on. The catalog's
 * n_ctx is a snapshot from load time and lags a restart with a new preset.
 */
function toSmoltModel(model: LlamaModelInfo, serverUrl: string, props?: LlamaServerProps): Model<"openai-completions"> {
	const reportedContextWindow = props?.n_ctx ?? model.meta?.n_ctx ?? model.meta?.n_ctx_train;
	const contextWindow = reportedContextWindow && reportedContextWindow > 0 ? reportedContextWindow : 128000;
	const reasoning = templateSupportsThinking(props?.chat_template);
	return {
		id: model.id,
		name: model.id,
		api: "openai-completions",
		provider: LLAMA_PROVIDER_ID,
		baseUrl: llamaInferenceUrl(serverUrl),
		reasoning,
		input: model.architecture?.input_modalities?.includes("image") ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		// An output cap of the whole window asked llama.cpp for replies as
		// long as the context, which it can only honour with an empty context.
		maxTokens: Math.min(contextWindow, LLAMA_MAX_OUTPUT_TOKENS),
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			supportsUsageInStreaming: true,
			supportsStrictMode: false,
			maxTokensField: "max_tokens",
			// llama.cpp switches thinking through the chat template and streams
			// the result back as reasoning_content.
			...(reasoning ? { thinkingFormat: "qwen-chat-template" as const } : {}),
		},
	};
}

/** Props for every loaded model, keyed by id. A model that will not answer is simply left out. */
export async function loadedModelProps(
	client: LlamaClient,
	catalog: readonly LlamaModelInfo[],
	signal: AbortSignal,
): Promise<Map<string, LlamaServerProps>> {
	const props = new Map<string, LlamaServerProps>();
	await Promise.all(
		catalog
			.filter((model) => model.status.value === "loaded" || model.status.value === "sleeping")
			.map(async (model) => {
				try {
					props.set(model.id, await client.props({ model: model.id, signal }));
				} catch {
					// The catalog's own figures stand in.
				}
			}),
	);
	return props;
}

export interface LlamaProviderController {
	provider: Provider<"openai-completions">;
	setCatalog(
		models: readonly LlamaModelInfo[],
		serverUrl: string,
		options?: { routerAutoload?: boolean; props?: ReadonlyMap<string, LlamaServerProps> },
	): void;
}

export function createLlamaProvider(): LlamaProviderController {
	let models: readonly Model<"openai-completions">[] = [];

	const setCatalog = (
		catalog: readonly LlamaModelInfo[],
		serverUrl: string,
		options: { routerAutoload?: boolean; props?: ReadonlyMap<string, LlamaServerProps> } = {},
	): void => {
		models = selectableModels(catalog, serverUrl, options.routerAutoload === true, options.props);
	};

	const provider: Provider<"openai-completions"> = {
		id: LLAMA_PROVIDER_ID,
		name: "llama.cpp",
		baseUrl: llamaInferenceUrl(DEFAULT_LLAMA_SERVER_URL),
		auth: {
			apiKey: {
				name: "llama.cpp server",
				login: async (interaction): Promise<ApiKeyCredential> => {
					const enteredUrl = await interaction.prompt({
						type: "text",
						message: "llama.cpp server URL",
						placeholder: process.env.LLAMA_BASE_URL ?? DEFAULT_LLAMA_SERVER_URL,
					});
					const serverUrl = normalizeLlamaServerUrl(
						enteredUrl.trim() || process.env.LLAMA_BASE_URL || DEFAULT_LLAMA_SERVER_URL,
					);
					const apiKey = (
						await interaction.prompt({
							type: "secret",
							message: "API key (optional)",
						})
					).trim();
					await new LlamaClient(serverUrl, apiKey || undefined).list({ signal: interaction.signal });
					return {
						type: "api_key",
						key: apiKey || undefined,
						env: { LLAMA_BASE_URL: serverUrl },
					};
				},
				check: async ({ ctx, credential }) => {
					const serverUrl = await resolveServerUrl(ctx, credential);
					return serverUrl
						? { type: "api_key", source: credential ? "stored credential" : "LLAMA_BASE_URL" }
						: undefined;
				},
				resolve: async ({ ctx, credential }): Promise<AuthResult | undefined> => {
					const serverUrl = await resolveServerUrl(ctx, credential);
					if (!serverUrl) return undefined;
					const apiKey = credential?.key ?? (await ctx.env("LLAMA_API_KEY")) ?? "local";
					return {
						auth: { apiKey, baseUrl: llamaInferenceUrl(serverUrl) },
						env: { ...credential?.env, LLAMA_BASE_URL: serverUrl },
						source: credential ? "stored credential" : "LLAMA_BASE_URL",
					};
				},
			},
		},
		getModels: () => models,
		refreshModels: async (context: RefreshModelsContext): Promise<void> => {
			if (context.stored) {
				const restored = context.stored.models.filter(
					(model): model is Model<"openai-completions"> =>
						model.provider === LLAMA_PROVIDER_ID && model.api === "openai-completions",
				);
				if (
					!(await context.publish({
						update: () => {
							models = restored;
						},
					}))
				) {
					return;
				}
			}

			if (!context.allowNetwork || context.signal.aborted || context.credential?.type !== "api_key") return;
			const serverUrl = credentialServerUrl(context.credential);
			if (!serverUrl) return;
			const client = new LlamaClient(serverUrl, context.credential.key);
			const catalog = await client.list({ signal: context.signal });
			if (context.signal.aborted) return;
			const routerAutoload = await routerAutoloadEnabled(client, catalog, context.signal);
			if (context.signal.aborted) return;
			const props = await loadedModelProps(client, catalog, context.signal);
			if (context.signal.aborted) return;
			const refreshed = selectableModels(catalog, serverUrl, routerAutoload, props);
			await context.publish({
				persist: { models: refreshed, checkedAt: Date.now() },
				update: () => {
					models = refreshed;
				},
			});
		},
		stream: (model, context, options) => stream(model, context, options as ProviderStreamOptions | undefined),
		streamSimple: (model, context, options) => streamSimple(model, context, options),
	};

	return { provider, setCatalog };
}
