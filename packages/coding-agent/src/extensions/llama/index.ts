import type { Model } from "@smolt/ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../core/extensions/types.ts";
import { formatBytes, LlamaClient, type LlamaModelInfo, normalizeLlamaServerUrl } from "./client.ts";
import { findHuggingFaceToken, HuggingFaceClient } from "./huggingface.ts";
import { freeGpuNeighbours, normalizeOllamaUrl } from "./neighbours.ts";
import { createLlamaProvider, LLAMA_PROVIDER_ID } from "./provider.ts";
import { ensureLlamaServer } from "./server.ts";
import { type LlamaUi, runWithProgress, showLlamaUi } from "./ui.ts";

function modelIsLoaded(model: LlamaModelInfo): boolean {
	return model.status.value === "loaded" || model.status.value === "sleeping";
}

/**
 * Whether a model is taking GPU memory, or about to. A model still loading
 * is the case that matters: two chats on different local models each stop
 * "the others" on their turn, and one that only counted loaded models let
 * the other chat's load run on beside its own until neither fit.
 */
/**
 * Whether another runtime's models are left alone. Stopping them is what
 * keeps a local model at full speed, so it is the default; someone running
 * Ollama deliberately alongside can set this and accept the CPU offload.
 */
function keepingNeighbours(): boolean {
	const value = process.env.SMOLT_LLAMA_KEEP_NEIGHBOURS?.trim().toLowerCase();
	return value === "1" || value === "true";
}

function modelHoldsMemory(model: LlamaModelInfo): boolean {
	return modelIsLoaded(model) || model.status.value === "loading";
}

function isConnectionError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const message = `${error.name} ${error.message}`.toLowerCase();
	return message.includes("fetch failed") || message.includes("timeout") || message.includes("network");
}

function connectionErrorMessage(error: unknown): string {
	if (isConnectionError(error)) return "Could not connect to the server.";
	return error instanceof Error ? error.message : String(error);
}

function parseHuggingFaceModel(value: string): { repository: string; quantization?: string } {
	const colon = value.indexOf(":", value.indexOf("/") + 1);
	return colon < 0
		? { repository: value }
		: { repository: value.slice(0, colon), quantization: value.slice(colon + 1) };
}

async function configuredClient(ctx: Pick<ExtensionContext, "modelRegistry" | "ui">): Promise<LlamaClient | undefined> {
	const result = await ctx.modelRegistry.getProviderAuth(LLAMA_PROVIDER_ID);
	if (!result) {
		ctx.ui.notify(`Configure llama.cpp with /login ${LLAMA_PROVIDER_ID}`, "warning");
		return undefined;
	}
	const configuredUrl = result.env?.LLAMA_BASE_URL;
	const serverUrl = normalizeLlamaServerUrl(
		typeof configuredUrl === "string" && configuredUrl ? configuredUrl : (result.auth.baseUrl ?? ""),
	);
	return new LlamaClient(serverUrl, result.auth.apiKey);
}

export default function llamaExtension(smolt: ExtensionAPI): void {
	const provider = createLlamaProvider();
	smolt.registerProvider(provider.provider);

	const syncCatalog = async (
		ctx: Pick<ExtensionContext, "modelRegistry">,
		client: LlamaClient,
		catalog?: LlamaModelInfo[],
	): Promise<LlamaModelInfo[]> => {
		const signal = AbortSignal.timeout(15_000);
		const current = catalog ?? (await client.list({ signal }));
		provider.setCatalog(current, client.serverUrl);
		const result = await ctx.modelRegistry.refresh({
			providers: [LLAMA_PROVIDER_ID],
			// /llama already contacted the configured llama.cpp server, so keep this refresh live even in SMOLT_OFFLINE.
			allowNetwork: true,
			signal,
		});
		if (result.aborted) throw new Error("Model catalog refresh timed out.");
		const refreshError = result.errors.get(LLAMA_PROVIDER_ID);
		if (refreshError) throw refreshError;
		return current;
	};

	const loadModel = async (
		ctx: ExtensionCommandContext,
		ui: LlamaUi,
		client: LlamaClient,
		catalog: LlamaModelInfo[],
		target: LlamaModelInfo,
	): Promise<void> => {
		const loaded = catalog.filter((model) => model.id !== target.id && modelIsLoaded(model));
		let replace = false;
		if (loaded.length > 0) {
			const choice = await ui.select(`${loaded.length} model${loaded.length === 1 ? " is" : "s are"} loaded`, [
				"Unload all and load",
				"Keep loaded and load",
				"Cancel",
			]);
			if (!choice || choice === "Cancel") return;
			replace = choice === "Unload all and load";
		}

		const restoreLoaded = async (): Promise<void> => {
			ctx.ui.notify("Restoring previously loaded models");
			for (const model of loaded) await client.loadAndWait(model.id, () => {});
			await syncCatalog(ctx, client);
		};
		if (replace) {
			for (const model of loaded) await client.unloadAndWait(model.id);
		}

		try {
			const result = await runWithProgress(ui, {
				title: "Loading model",
				model: target.id,
				initialMessage: "Starting…",
				cancelTitle: "Stop loading?",
				cancelMessage: target.id,
				run: (signal, update) => client.loadAndWait(target.id, update, signal),
				cancel: () => client.unload(target.id),
			});
			if (result.cancelled) {
				if (replace) await restoreLoaded();
				return;
			}
			const refreshed = await syncCatalog(ctx, client);
			const loadedModel = refreshed.find((model) => model.id === target.id);
			ctx.ui.notify(
				loadedModel?.status.value === "loaded" ? `Loaded ${target.id}` : `Load started for ${target.id}`,
			);
		} catch (error) {
			if (replace) {
				try {
					await restoreLoaded();
				} catch {
					// Preserve the original load error.
				}
			}
			throw error;
		}
	};

	const unloadModel = async (
		ctx: ExtensionCommandContext,
		ui: LlamaUi,
		client: LlamaClient,
		model: LlamaModelInfo,
	): Promise<void> => {
		if (!(await ui.confirm("Unload model?", model.id))) return;
		await client.unloadAndWait(model.id);
		await syncCatalog(ctx, client);
		ctx.ui.notify(`Unloaded ${model.id}`);
	};

	const downloadModel = async (ctx: ExtensionCommandContext, ui: LlamaUi, client: LlamaClient): Promise<void> => {
		const huggingFace = new HuggingFaceClient(await findHuggingFaceToken());
		const selected = await ui.searchModels((query, signal) => huggingFace.search(query, signal));
		if (!selected) return;
		const parsed = parseHuggingFaceModel(selected);
		ui.showStatus("Loading model details", parsed.repository);
		const details = await huggingFace.details(parsed.repository);
		if (details.gated) {
			const approval = details.gated === "manual" ? "Manual approval is required" : "Accept the access terms";
			const choice = await ui.select(
				`Hugging Face access required\n${details.id}\n\n${approval} at:\nhttps://huggingface.co/${details.id}\n\nThe llama.cpp server needs HF_TOKEN with access.`,
				["Continue", "Back"],
			);
			if (choice !== "Continue") return;
		}
		let quantization = parsed.quantization;
		if (!quantization && details.quantizations.length > 0) {
			const options = details.quantizations.map((entry) => {
				const detail = [
					entry.size === undefined ? undefined : formatBytes(entry.size),
					entry.name === "Q4_K_M" ? "recommended" : undefined,
				]
					.filter((value): value is string => Boolean(value))
					.join(" · ");
				return detail ? `${entry.name} · ${detail}` : entry.name;
			});
			const choice = await ui.select(`Select quantization\n${details.id}`, options);
			if (!choice) return;
			quantization = details.quantizations[options.indexOf(choice)]?.name;
			if (!quantization) return;
		}
		const model = quantization ? `${details.id}:${quantization}` : details.id;
		const result = await runWithProgress(ui, {
			title: "Downloading model",
			model,
			initialMessage: "Starting…",
			cancelTitle: "Stop download?",
			cancelMessage: model,
			run: (signal, update) => client.downloadAndWait(model, update, signal),
			cancel: () => client.unload(model),
		});
		if (result.cancelled) return;
		await syncCatalog(ctx, client, result.value);
		ctx.ui.notify(`Downloaded ${model}`);
	};

	/**
	 * Picking a local model is the whole request: the server it runs on comes
	 * up if it is not, and it is the only model left in memory when it is
	 * done. One model in VRAM at a time, because two do not fit and a slow,
	 * swapped-out model is worse than a moment of loading. Selections are
	 * queued so two quick picks cannot fight over the GPU.
	 */
	let preparing: Promise<void> = Promise.resolve();
	/**
	 * Put the refreshed catalog's figures on the model the chat is using. A
	 * registry refresh replaces the provider's models but leaves the session
	 * holding the object it selected, which is how a chat kept showing a 32k
	 * context and no thinking after the router came back with 131k and a
	 * template that can think. Same id, so no model_select fires from this.
	 */
	const thinkingFormatOf = (model: Model<any>): string | undefined =>
		(model.compat as { thinkingFormat?: string } | undefined)?.thinkingFormat;
	const adoptRefreshedModel = async (ctx: ExtensionContext, modelId: string): Promise<void> => {
		const current = ctx.model;
		const refreshed = ctx.modelRegistry.find(LLAMA_PROVIDER_ID, modelId);
		if (!refreshed || !current || current.provider !== LLAMA_PROVIDER_ID || current.id !== modelId) return;
		const same =
			refreshed.contextWindow === current.contextWindow &&
			refreshed.maxTokens === current.maxTokens &&
			refreshed.reasoning === current.reasoning &&
			thinkingFormatOf(refreshed) === thinkingFormatOf(current);
		if (same) return;
		await smolt.setModel(refreshed);
	};
	/**
	 * A line in the chat itself about what the local model is doing. A toast
	 * goes in seconds and the footer is the TUI's alone; a load that takes a
	 * minute or more has to be seen where the reader is looking, and stay
	 * there, or the chat looks stuck. Nothing here starts a turn.
	 */
	const say = (content: string): void => {
		smolt.sendMessage({ customType: "llama-status", content, display: true }, { triggerTurn: false });
	};
	const prepareLocalModel = async (ctx: ExtensionContext, modelId: string): Promise<void> => {
		const client = await configuredClient(ctx);
		if (!client) return;
		const status = (text: string | undefined) => ctx.ui.setStatus("llama", text);
		try {
			status("llama.cpp: checking server");
			await ensureLlamaServer(
				client.serverUrl,
				(message, type) => {
					ctx.ui.notify(message, type);
					say(message);
				},
				modelId,
			);
			const catalog = await client.list({ signal: AbortSignal.timeout(15_000) });
			const target = catalog.find((model) => model.id === modelId);
			if (!target) {
				throw new Error(
					`${modelId} is not on the llama.cpp server at ${client.serverUrl}. Download it with /llama.`,
				);
			}
			const keepNeighbours = keepingNeighbours();
			const others = catalog.filter((model) => model.id !== modelId && modelHoldsMemory(model));
			for (const model of others) {
				status(`llama.cpp: stopping ${model.id}`);
				say(`Stopping ${model.id} to free the GPU…`);
				await client.unloadAndWait(model.id, AbortSignal.timeout(60_000));
			}
			// Runtimes smolt did not start hold the same card. llama.cpp will
			// load beside them rather than refuse, putting most of the layers
			// on the CPU, so this has to happen before the load and not only
			// when the model is missing: a neighbour that woke up since the
			// last turn can evict a model that was already resident.
			const neighbours = keepNeighbours
				? []
				: await freeGpuNeighbours({
						ollamaUrl: normalizeOllamaUrl(process.env.OLLAMA_HOST),
						report: (neighbour) => {
							status(`llama.cpp: stopping ${neighbour.runtime} ${neighbour.model}`);
							say(`Stopping ${neighbour.model} in ${neighbour.runtime} to free the GPU…`);
						},
					});
			const needsLoad = !modelIsLoaded(target);
			if (needsLoad) {
				const size = target.meta?.size === undefined ? "" : ` (${formatBytes(target.meta.size)})`;
				status(`llama.cpp: loading ${modelId}`);
				say(`Loading ${modelId}${size} into memory… the first reply waits for this.`);
				let stage = "";
				await client.loadAndWait(
					modelId,
					(progress) => {
						status(`llama.cpp: ${progress.message}`);
						// One line per stage, not one per tick.
						if (progress.message !== stage && progress.message !== "Loading model") {
							stage = progress.message;
							say(`${modelId}: ${progress.message.toLowerCase()}…`);
						}
					},
					AbortSignal.timeout(10 * 60_000),
				);
			}
			await syncCatalog(ctx, client);
			await adoptRefreshedModel(ctx, modelId);
			if (others.length > 0 || needsLoad || neighbours.length > 0) {
				const names = [...others.map((model) => model.id), ...neighbours.map((n) => `${n.model} (${n.runtime})`)];
				const stopped = names.length > 0 ? `, stopped ${names.join(", ")}` : "";
				const context = ctx.modelRegistry.find(LLAMA_PROVIDER_ID, modelId)?.contextWindow;
				const window = context === undefined ? "" : ` with a ${Math.round(context / 1024)}k context`;
				ctx.ui.notify(`Running ${modelId} on llama.cpp${stopped}`);
				say(`${modelId} is loaded${window}${stopped}.`);
			}
		} catch (error) {
			ctx.ui.notify(`llama.cpp: ${connectionErrorMessage(error)}`, "error");
			say(`llama.cpp: ${connectionErrorMessage(error)}`);
		} finally {
			status(undefined);
		}
	};
	const queuePrepare = (ctx: ExtensionContext, modelId: string): Promise<void> => {
		preparing = preparing.then(() => prepareLocalModel(ctx, modelId));
		return preparing;
	};
	smolt.on("model_select", (event, ctx) => {
		if (event.model.provider !== LLAMA_PROVIDER_ID) return;
		// A restored model is the session coming back, not a pick: the server
		// is not started or reshuffled under a chat that only opened. The
		// first turn does that instead, below.
		if (event.source === "restore") return;
		// Not awaited: loading a 16 GB model takes minutes, and a pick that
		// does not answer for that long times out at the desktop as if it had
		// failed. The pick returns at once; the next message waits for the
		// load, in before_agent_start.
		void queuePrepare(ctx, event.model.id);
	});
	/**
	 * Whether the chat's model is loaded and alone on its server, refreshing
	 * the chat's figures for it on the way when they have gone stale: a
	 * router restarted with a new preset changes the context size, and a
	 * model picked from the cache has never been asked whether it can think.
	 * False when the server is unreachable, the model is not loaded, or
	 * another model is loaded beside it.
	 */
	const modelInPlace = async (ctx: ExtensionContext, client: LlamaClient, model: Model<any>): Promise<boolean> => {
		try {
			const catalog = await client.list({ signal: AbortSignal.timeout(5_000) });
			const target = catalog.find((entry) => entry.id === model.id);
			const alone = !catalog.some((entry) => entry.id !== model.id && modelHoldsMemory(entry));
			if (!target || !modelIsLoaded(target) || !alone) return false;
			const nCtx = target.meta?.n_ctx;
			if ((nCtx !== undefined && nCtx > 0 && nCtx !== model.contextWindow) || !model.reasoning) {
				await syncCatalog(ctx, client);
				await adoptRefreshedModel(ctx, model.id);
			}
			return true;
		} catch {
			return false;
		}
	};
	// A turn on a local model that was restored rather than picked, or whose
	// server has since gone away, would only fail with a connection error. And
	// another agent may have loaded its own model since the pick: the desktop
	// runs several, each with a pick of its own, and only one fits. So each
	// turn confirms that the model is loaded and alone. One local catalog
	// request when everything is in place.
	smolt.on("before_agent_start", async (_event, ctx) => {
		const model = ctx.model;
		if (!model || model.provider !== LLAMA_PROVIDER_ID) return;
		// A pick still loading finishes first; this turn is what it was for.
		await preparing;
		const client = await configuredClient(ctx);
		if (!client) return;
		if (await modelInPlace(ctx, client, model)) return;
		await queuePrepare(ctx, model.id);
	});
	// A chat that opens on a local model shows that model's cached figures
	// until something refreshes them. When the model is already up, the
	// real ones are a catalog read away, so the chat need not show 32k and
	// no thinking until its first message. Nothing is started from here.
	smolt.on("session_start", async (_event, ctx) => {
		const model = ctx.model;
		if (!model || model.provider !== LLAMA_PROVIDER_ID) return;
		const client = await configuredClient(ctx);
		if (!client) return;
		await modelInPlace(ctx, client, model);
	});

	smolt.registerCommand("llama", {
		description: "Manage llama.cpp router models",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/llama is available in interactive mode", "warning");
				return;
			}
			const client = await configuredClient(ctx);
			if (!client) return;
			await showLlamaUi(ctx, async (ui) => {
				const readCatalog = async (): Promise<LlamaModelInfo[] | undefined> => {
					while (true) {
						try {
							return await syncCatalog(ctx, client);
						} catch (error) {
							if ((await ui.connectionError(client.serverUrl, connectionErrorMessage(error))) === "close") {
								return undefined;
							}
						}
					}
				};

				let catalog = await readCatalog();
				if (!catalog) return;
				while (true) {
					const action = await ui.showModels(client.serverUrl, catalog);
					if (action.type === "close") return;
					let actionError: unknown;
					try {
						if (action.type === "download") await downloadModel(ctx, ui, client);
						else if (modelIsLoaded(action.model)) await unloadModel(ctx, ui, client, action.model);
						else if (action.model.status.value === "unloaded")
							await loadModel(ctx, ui, client, catalog, action.model);
						else ctx.ui.notify(`${action.model.id} is ${action.model.status.value}`, "warning");
					} catch (error) {
						actionError = error;
					}
					const refreshed = await readCatalog();
					if (!refreshed) return;
					catalog = refreshed;
					if (actionError && !isConnectionError(actionError)) {
						ctx.ui.notify(actionError instanceof Error ? actionError.message : String(actionError), "error");
					}
				}
			});
		},
	});
}
