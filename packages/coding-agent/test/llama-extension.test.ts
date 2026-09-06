import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type RequestListener, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthContext, AuthPrompt, ModelsPublication, ModelsStoreEntry } from "@smolt/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { LlamaClient, type LlamaProgress, normalizeLlamaServerUrl } from "../src/extensions/llama/client.ts";
import { findHuggingFaceToken, HuggingFaceClient } from "../src/extensions/llama/huggingface.ts";
import llamaExtension from "../src/extensions/llama/index.ts";
import { createLlamaProvider, LLAMA_PROVIDER_ID } from "../src/extensions/llama/provider.ts";
import {
	ensureLlamaServer,
	llamaModelsDir,
	llamaServerArgs,
	parseListedDevices,
} from "../src/extensions/llama/server.ts";

const servers: Server[] = [];

async function listen(handler: RequestListener): Promise<{ server: Server; url: string }> {
	const server = createServer(handler);
	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address() as AddressInfo;
	return { server, url: `http://127.0.0.1:${address.port}` };
}

function json(response: ServerResponse, value: unknown): void {
	response.writeHead(200, { "Content-Type": "application/json" });
	response.end(JSON.stringify(value));
}

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
					server.closeAllConnections();
				}),
		),
	);
});

describe("llama.cpp extension", () => {
	it("registers a native provider and /llama command", async () => {
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			llamaExtension,
			process.cwd(),
			createEventBus(),
			runtime,
			"<inline:llama.cpp>",
		);

		expect(extension.commands.get("llama")?.description).toBe("Manage llama.cpp router models");
		expect(runtime.pendingNativeProviderRegistrations.map((entry) => entry.provider.id)).toEqual([LLAMA_PROVIDER_ID]);
	});

	it("stops every other local model and loads the picked one on model_select", async () => {
		const status = new Map<string, "unloaded" | "loading" | "loaded" | "sleeping">([
			["big-one", "loaded"],
			["napping", "sleeping"],
			["arriving", "loading"],
			["picked", "unloaded"],
			["stays-cold", "unloaded"],
		]);
		const calls: string[] = [];
		const { url } = await listen((request, response) => {
			if (request.url === "/health") return json(response, { status: "ok" });
			if (request.url === "/models/sse") {
				response.writeHead(200, { "Content-Type": "text/event-stream" });
				return;
			}
			if (request.url === "/models") {
				return json(response, { data: [...status].map(([id, value]) => ({ id, status: { value } })) });
			}
			if ((request.url === "/models/load" || request.url === "/models/unload") && request.method === "POST") {
				let body = "";
				request.on("data", (chunk) => {
					body += chunk;
				});
				request.on("end", () => {
					const { model } = JSON.parse(body) as { model: string };
					const action = request.url === "/models/load" ? "load" : "unload";
					calls.push(`${action} ${model}`);
					status.set(model, action === "load" ? "loaded" : "unloaded");
					json(response, { success: true });
				});
				return;
			}
			response.writeHead(404).end();
		});

		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			llamaExtension,
			process.cwd(),
			createEventBus(),
			runtime,
			"<inline:llama.cpp>",
		);
		const notes: string[] = [];
		const refreshed: string[][] = [];
		const adopted: string[] = [];
		const said: string[] = [];
		runtime.sendMessage = (message) => {
			said.push(String(message.content));
		};
		runtime.setModel = async (model) => {
			adopted.push(`${model.id}@${model.contextWindow}${model.reasoning ? "+think" : ""}`);
			return true;
		};
		// The registry answers with the catalog's figures: 131k and thinking for
		// the picked model, once the refresh has run.
		const registryModel = {
			provider: LLAMA_PROVIDER_ID,
			id: "picked",
			contextWindow: 131072,
			maxTokens: 131072,
			reasoning: true,
			compat: { thinkingFormat: "qwen-chat-template" },
		};
		const ctx = {
			ui: { notify: (message: string) => notes.push(message), setStatus: () => {} },
			model: {
				provider: LLAMA_PROVIDER_ID,
				id: "picked",
				contextWindow: 32768,
				maxTokens: 32768,
				reasoning: false,
				compat: {},
			},
			modelRegistry: {
				getProviderAuth: async () => ({
					auth: { apiKey: "local", baseUrl: `${url}/v1` },
					env: { LLAMA_BASE_URL: url },
				}),
				refresh: async (options: { providers: string[] }) => {
					refreshed.push(options.providers);
					return { aborted: false, errors: new Map() };
				},
				find: (provider: string, id: string) =>
					provider === LLAMA_PROVIDER_ID && id === "picked" ? registryModel : undefined,
			},
		};
		const handler = extension.handlers.get("model_select")?.[0];
		expect(handler).toBeDefined();
		if (!handler) return;
		const model = { provider: LLAMA_PROVIDER_ID, id: "picked" };
		// The pick itself answers at once: the desktop times a pick out at 30s,
		// and a load takes longer. The work is watched for instead.
		await handler({ type: "model_select", model, previousModel: undefined, source: "set" }, ctx as never);
		await vi.waitFor(() => expect(notes.length).toBe(1), { timeout: 5_000 });

		// A model another chat is still loading is stopped too, not just the loaded ones.
		expect(calls).toEqual(["unload big-one", "unload napping", "unload arriving", "load picked"]);
		// The chat itself is told what happened, stage by stage.
		expect(said).toEqual([
			"Stopping big-one to free the GPU…",
			"Stopping napping to free the GPU…",
			"Stopping arriving to free the GPU…",
			"Loading picked into memory… the first reply waits for this.",
			"picked is loaded with a 128k context, stopped big-one, napping, arriving.",
		]);
		said.length = 0;
		expect(status.get("picked")).toBe("loaded");
		expect(status.get("stays-cold")).toBe("unloaded");
		expect(refreshed).toEqual([[LLAMA_PROVIDER_ID]]);
		expect(notes).toEqual(["Running picked on llama.cpp, stopped big-one, napping, arriving"]);
		// The chat's model now carries the real context and thinking.
		expect(adopted).toEqual(["picked@131072+think"]);
		ctx.model = registryModel as never;
		adopted.length = 0;

		// Picking the model that is already the only one running does nothing.
		// The turn after it waits for the queue, which is how it is drained here.
		calls.length = 0;
		notes.length = 0;
		await handler({ type: "model_select", model, previousModel: undefined, source: "set" }, ctx as never);
		const beforeStart = extension.handlers.get("before_agent_start")?.[0];
		expect(beforeStart).toBeDefined();
		if (!beforeStart) return;
		const turn = { type: "before_agent_start", prompt: "hi", systemPrompt: "", systemPromptOptions: {} };
		await beforeStart(turn, { ...ctx, model: registryModel } as never);
		expect(calls).toEqual([]);
		expect(notes).toEqual([]);
		expect(said).toEqual([]);

		// A session restoring its model is not a pick.
		status.set("big-one", "loaded");
		await handler({ type: "model_select", model, previousModel: undefined, source: "restore" }, ctx as never);
		expect(calls).toEqual([]);

		// But the first turn on it is: the model that crept back in is stopped.
		await beforeStart(turn, { ...ctx, model } as never);
		expect(calls).toEqual(["unload big-one"]);
		expect(notes).toEqual(["Running picked on llama.cpp, stopped big-one"]);
		// That turn also put the real figures on the chat's bare model.
		expect(adopted).toEqual(["picked@131072+think"]);
		adopted.length = 0;

		// With everything in place a turn costs one catalog read and nothing else.
		calls.length = 0;
		notes.length = 0;
		refreshed.length = 0;
		await beforeStart(turn, { ...ctx, model: registryModel } as never);
		expect(calls).toEqual([]);
		expect(notes).toEqual([]);
		expect(refreshed).toEqual([]);
		expect(adopted).toEqual([]);

		// A chat opening on the loaded model gets the real figures at once, and nothing is started.
		const sessionStart = extension.handlers.get("session_start")?.[0];
		expect(sessionStart).toBeDefined();
		if (!sessionStart) return;
		await sessionStart({ type: "session_start", reason: "startup" }, {
			...ctx,
			model: { ...registryModel, contextWindow: 32768, reasoning: false, compat: {} },
		} as never);
		expect(calls).toEqual([]);
		expect(refreshed).toEqual([[LLAMA_PROVIDER_ID]]);
		expect(adopted).toEqual(["picked@131072+think"]);
		refreshed.length = 0;
		adopted.length = 0;

		// A chat still holding stale figures for a loaded model gets them refreshed on its turn.
		await beforeStart(turn, {
			...ctx,
			model: { ...registryModel, contextWindow: 32768, reasoning: false, compat: {} },
		} as never);
		expect(calls).toEqual([]);
		expect(refreshed).toEqual([[LLAMA_PROVIDER_ID]]);
		expect(adopted).toEqual(["picked@131072+think"]);
		adopted.length = 0;

		// A model the server does not know is an error, not a silent no-op.
		await handler(
			{
				type: "model_select",
				model: { provider: LLAMA_PROVIDER_ID, id: "ghost" },
				previousModel: undefined,
				source: "set",
			},
			ctx as never,
		);
		await vi.waitFor(() => expect(notes.length).toBe(1), { timeout: 5_000 });
		expect(calls).toEqual([]);
		expect(notes[0]).toContain("ghost is not on the llama.cpp server");

		// Other providers are none of llama.cpp's business.
		await handler(
			{ type: "model_select", model: { provider: "anthropic", id: "x" }, previousModel: undefined, source: "set" },
			ctx as never,
		);
		expect(calls).toEqual([]);
	});

	it("leaves a reachable server alone and refuses to start a remote one", async () => {
		const { url } = await listen((request, response) => {
			if (request.url === "/health") return json(response, { status: "ok" });
			response.writeHead(404).end();
		});
		const notes: string[] = [];
		await ensureLlamaServer(url, (message) => notes.push(message));
		expect(notes).toEqual([]);
		await expect(ensureLlamaServer("http://llama.example.com:8080", () => {})).rejects.toThrow("Could not reach");
	});

	it("finds the models folder that holds the picked model and passes its presets", () => {
		const base = mkdtempSync(join(tmpdir(), "smolt-llama-models-"));
		try {
			const withModel = join(base, "big-disk");
			mkdirSync(withModel);
			writeFileSync(join(withModel, "picked.gguf"), "");
			writeFileSync(join(withModel, "presets.ini"), "version = 1\n");
			const env = { LLAMA_MODELS_DIR: withModel } as NodeJS.ProcessEnv;
			const found = llamaModelsDir("picked", env);
			expect(found).toEqual({ dir: withModel, models: 1, presets: join(withModel, "presets.ini"), hasModel: true });
			expect(llamaModelsDir("other", env)?.hasModel).toBe(false);
			// A configured folder that does not exist falls through to the defaults.
			expect(
				llamaModelsDir("picked", { LLAMA_MODELS_DIR: join(base, "missing") } as NodeJS.ProcessEnv)?.dir,
			).not.toBe(withModel);

			const args = llamaServerArgs(found!, "http://127.0.0.1:9090");
			expect(args.slice(0, 2)).toEqual(["--models-dir", withModel]);
			expect(args[args.indexOf("--models-preset") + 1]).toBe(join(withModel, "presets.ini"));
			expect(args).toContain("9090");
			// The preset sets the context; a size on the command line would override it.
			expect(args).not.toContain("-c");
			const bare = llamaServerArgs({ ...found!, presets: undefined }, "http://127.0.0.1:8080");
			expect(bare).not.toContain("--models-preset");
			expect(bare).toContain("-c");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("reads the devices a llama-server build can see", () => {
		expect(
			parseListedDevices(
				"ggml_cuda_init: found 0 CUDA devices\nAvailable devices:\n  Vulkan0: NVIDIA GeForce RTX 4090 (24138 MiB, 23370 MiB free)\n  CUDA0: NVIDIA GeForce RTX 4090 (24138 MiB)\n",
			),
		).toEqual([
			"Vulkan0: NVIDIA GeForce RTX 4090 (24138 MiB, 23370 MiB free)",
			"CUDA0: NVIDIA GeForce RTX 4090 (24138 MiB)",
		]);
		expect(parseListedDevices("Available devices:\n  (none)\n")).toEqual([]);
		expect(parseListedDevices("")).toEqual([]);
	});

	it("takes context and thinking from the loaded model's own props", async () => {
		const asked: string[] = [];
		const { url } = await listen((request, response) => {
			const requestUrl = new URL(request.url ?? "/", "http://localhost");
			if (requestUrl.pathname === "/models") {
				return json(response, {
					data: [
						{ id: "thinker", status: { value: "loaded" }, meta: { n_ctx: 32768 } },
						{ id: "plain", status: { value: "sleeping" }, meta: { n_ctx: 8192 } },
						{ id: "cold", status: { value: "unloaded" }, source: "preset" },
					],
				});
			}
			if (requestUrl.pathname === "/props") {
				const model = requestUrl.searchParams.get("model");
				asked.push(model ?? "(router)");
				if (model === "thinker") {
					return json(response, {
						default_generation_settings: { n_ctx: 131072 },
						chat_template: "{% if enable_thinking %}<think>{% endif %}",
					});
				}
				if (model === "plain") {
					return json(response, { default_generation_settings: { n_ctx: 8192 }, chat_template: "{{ messages }}" });
				}
				return json(response, { models_autoload: false });
			}
			response.writeHead(404).end();
		});

		const controller = createLlamaProvider();
		await controller.provider.refreshModels?.({
			credential: { type: "api_key", key: "local", env: { LLAMA_BASE_URL: url } },
			publish: async (publication: ModelsPublication) => {
				publication.update?.();
				return true;
			},
			allowNetwork: true,
			signal: new AbortController().signal,
		});

		const models = controller.provider.getModels();
		expect(models.map((model) => model.id)).toEqual(["thinker", "plain"]);
		expect(models[0]).toEqual(
			expect.objectContaining({
				contextWindow: 131072,
				maxTokens: 32768,
				reasoning: true,
				compat: expect.objectContaining({ thinkingFormat: "qwen-chat-template" }),
			}),
		);
		expect(models[1]).toEqual(expect.objectContaining({ contextWindow: 8192, reasoning: false }));
		expect(models[1]?.compat).not.toHaveProperty("thinkingFormat");
		// Only loaded models are asked: asking about a cold one could load it.
		expect(asked.filter((model) => model !== "(router)").sort()).toEqual(["plain", "thinker"]);
	});

	it("normalizes management and inference URLs", () => {
		expect(normalizeLlamaServerUrl("http://127.0.0.1:8080/v1/")).toBe("http://127.0.0.1:8080");
		expect(normalizeLlamaServerUrl("https://example.com/prefix/v1")).toBe("https://example.com/prefix");
		expect(() => normalizeLlamaServerUrl("file:///tmp/llama")).toThrow("http or https");
	});

	it("exposes loaded and sleeping models with router metadata", () => {
		const controller = createLlamaProvider();
		controller.setCatalog(
			[
				{
					id: "loaded",
					status: { value: "loaded", args: ["llama-server", "--n-gpu-layers", "999"] },
					architecture: { input_modalities: ["text", "image"] },
					meta: { n_ctx: 65536, n_ctx_train: 131072 },
				},
				{ id: "sleeping", status: { value: "sleeping" } },
				{ id: "unloaded", status: { value: "unloaded" } },
				{ id: "loading", status: { value: "loading" } },
			],
			"http://localhost:8080",
		);

		expect(controller.provider.getModels()).toEqual([
			expect.objectContaining({
				id: "loaded",
				baseUrl: "http://localhost:8080/v1",
				contextWindow: 65536,
				maxTokens: 32768,
				input: ["text", "image"],
			}),
			expect.objectContaining({
				id: "sleeping",
				baseUrl: "http://localhost:8080/v1",
			}),
		]);
	});

	it("persists and restores selectable models for cache-only startup refreshes", async () => {
		let cachedEntry: ModelsStoreEntry | undefined;
		const { url } = await listen((request, response) => {
			if (request.url === "/models") {
				json(response, {
					data: [
						{ id: "loaded", status: { value: "loaded" }, meta: { n_ctx: 32768 } },
						{ id: "sleeping", status: { value: "sleeping" }, meta: { n_ctx: 32768 } },
						{ id: "unloaded", status: { value: "unloaded" } },
					],
				});
				return;
			}
			response.writeHead(404).end();
		});

		const publish = async (publication: ModelsPublication): Promise<boolean> => {
			if (publication.persist === null) cachedEntry = undefined;
			else if (publication.persist !== undefined) cachedEntry = structuredClone(publication.persist);
			publication.update?.();
			return true;
		};
		const first = createLlamaProvider();
		await first.provider.refreshModels?.({
			credential: { type: "api_key", key: "local", env: { LLAMA_BASE_URL: url } },
			stored: cachedEntry,
			publish,
			allowNetwork: true,
			signal: new AbortController().signal,
		});
		expect(first.provider.getModels().map((model) => model.id)).toEqual(["loaded", "sleeping"]);
		expect(cachedEntry?.models.map((model) => model.id)).toEqual(["loaded", "sleeping"]);

		const second = createLlamaProvider();
		await second.provider.refreshModels?.({
			credential: { type: "api_key", key: "local", env: { LLAMA_BASE_URL: url } },
			stored: cachedEntry,
			publish,
			allowNetwork: false,
			signal: new AbortController().signal,
		});
		expect(second.provider.getModels()).toEqual([
			expect.objectContaining({ id: "loaded", baseUrl: `${url}/v1`, contextWindow: 32768 }),
			expect.objectContaining({ id: "sleeping", baseUrl: `${url}/v1`, contextWindow: 32768 }),
		]);
	});

	it("exposes every unloaded local model, whatever put it in the catalog, when router autoload is enabled", async () => {
		let propsRequests = 0;
		const { url } = await listen((request, response) => {
			expect(request.headers.authorization).toBe("Bearer local");
			if (request.url === "/models") {
				json(response, {
					data: [
						{ id: "preset", status: { value: "unloaded" }, source: "preset", meta: { n_ctx: 65536 } },
						{ id: "failed-preset", status: { value: "unloaded", failed: true }, source: "preset" },
						{ id: "cache", status: { value: "unloaded" }, source: "cache" },
						{ id: "models-dir", status: { value: "unloaded" }, source: "models_dir" },
					],
				});
				return;
			}
			if (request.url === "/props") {
				propsRequests++;
				json(response, { role: "router", models_autoload: true });
				return;
			}
			response.writeHead(404).end();
		});

		let cachedEntry: ModelsStoreEntry | undefined;
		const controller = createLlamaProvider();
		await controller.provider.refreshModels?.({
			credential: { type: "api_key", key: "local", env: { LLAMA_BASE_URL: url } },
			stored: undefined,
			publish: async (publication) => {
				if (publication.persist !== undefined && publication.persist !== null) {
					cachedEntry = structuredClone(publication.persist);
				}
				publication.update?.();
				return true;
			},
			allowNetwork: true,
			signal: new AbortController().signal,
		});

		expect(propsRequests).toBe(1);
		// A GGUF the router found in the models directory or the HuggingFace
		// cache loads exactly like a hand-written preset, so it belongs in the
		// picker. Only the one whose last load failed stays out.
		expect(controller.provider.getModels().map((model) => model.id)).toEqual(["preset", "cache", "models-dir"]);
		expect(cachedEntry?.models.map((model) => model.id)).toEqual(["preset", "cache", "models-dir"]);
	});

	it("still asks about autoload when the catalog holds no presets at all", async () => {
		// The autoload check used to skip straight to "no" unless an unloaded
		// preset was in the catalog, so a models directory of plain GGUFs with
		// no preset file showed an empty picker however the router was started.
		let propsRequests = 0;
		const { url } = await listen((request, response) => {
			if (request.url === "/models") {
				json(response, {
					data: [
						{ id: "first.gguf", status: { value: "unloaded" }, source: "models_dir" },
						{ id: "second.gguf", status: { value: "unloaded" }, source: "models_dir" },
					],
				});
				return;
			}
			if (request.url === "/props") {
				propsRequests++;
				json(response, { role: "router", models_autoload: true });
				return;
			}
			response.writeHead(404).end();
		});

		const controller = createLlamaProvider();
		await controller.provider.refreshModels?.({
			credential: { type: "api_key", key: "local", env: { LLAMA_BASE_URL: url } },
			stored: undefined,
			publish: async (publication) => {
				publication.update?.();
				return true;
			},
			allowNetwork: true,
			signal: new AbortController().signal,
		});

		expect(propsRequests).toBe(1);
		expect(controller.provider.getModels().map((model) => model.id)).toEqual(["first.gguf", "second.gguf"]);
	});

	it("hides unloaded presets when router autoload is disabled", async () => {
		const { url } = await listen((request, response) => {
			if (request.url === "/models") {
				json(response, { data: [{ id: "preset", status: { value: "unloaded" }, source: "preset" }] });
				return;
			}
			if (request.url === "/props") {
				json(response, { role: "router", models_autoload: false });
				return;
			}
			response.writeHead(404).end();
		});

		const controller = createLlamaProvider();
		await controller.provider.refreshModels?.({
			credential: { type: "api_key", key: "local", env: { LLAMA_BASE_URL: url } },
			stored: undefined,
			publish: async (publication) => {
				publication.update?.();
				return true;
			},
			allowNetwork: true,
			signal: new AbortController().signal,
		});

		expect(controller.provider.getModels()).toEqual([]);
	});

	it("stays dormant until configured and stores URL plus optional key", async () => {
		const { provider } = createLlamaProvider();
		const auth = provider.auth.apiKey!;
		const emptyContext: AuthContext = {
			env: async () => undefined,
			fileExists: async () => false,
		};
		const signal = new AbortController().signal;
		expect(await auth.check?.({ ctx: emptyContext, signal })).toBeUndefined();
		expect(await auth.resolve({ ctx: emptyContext, signal })).toBeUndefined();

		const { url } = await listen((request, response) => {
			expect(request.headers.authorization).toBe("Bearer secret");
			json(response, { data: [] });
		});
		const answers = [url, "secret"];
		const credential = await auth.login!({
			signal,
			prompt: async (_prompt: AuthPrompt) => answers.shift()!,
			notify: () => {},
		});
		expect(credential).toEqual({
			type: "api_key",
			key: "secret",
			env: { LLAMA_BASE_URL: url },
		});
		expect(await auth.resolve({ ctx: emptyContext, credential, signal })).toEqual({
			auth: { apiKey: "secret", baseUrl: `${url}/v1` },
			env: { LLAMA_BASE_URL: url },
			source: "stored credential",
		});
	});

	it("searches Hugging Face and reads quantizations plus access requirements", async () => {
		const { url } = await listen((request, response) => {
			expect(request.headers.authorization).toBe("Bearer hf-secret");
			if (request.url?.startsWith("/api/models?")) {
				const requestUrl = new URL(request.url, "http://localhost");
				expect(requestUrl.searchParams.get("search")).toBe("qwen coder");
				expect(requestUrl.searchParams.get("filter")).toBe("gguf");
				expect(requestUrl.searchParams.get("sort")).toBe("downloads");
				json(response, [{ id: "owner/model-GGUF", downloads: 1200 }]);
				return;
			}
			if (request.url === "/api/models/owner/model-GGUF?blobs=true") {
				json(response, {
					id: "owner/model-GGUF",
					gated: "manual",
					siblings: [
						{ rfilename: "model-Q5_K_M.gguf", size: 6000 },
						{ rfilename: "model-Q4_K_M-00001-of-00002.gguf", size: 2000 },
						{ rfilename: "model-Q4_K_M-00002-of-00002.gguf", size: 3000 },
						{ rfilename: "mmproj-F16.gguf", size: 1000 },
					],
				});
				return;
			}
			response.writeHead(404).end();
		});
		const client = new HuggingFaceClient("hf-secret", url);

		expect(await client.search("qwen coder")).toEqual([{ id: "owner/model-GGUF", downloads: 1200 }]);
		expect(await client.details("owner/model-GGUF")).toEqual({
			id: "owner/model-GGUF",
			gated: "manual",
			quantizations: [
				{ name: "Q4_K_M", size: 5000 },
				{ name: "Q5_K_M", size: 6000 },
			],
		});
		expect(await findHuggingFaceToken({ HF_TOKEN: " hf-secret " })).toBe("hf-secret");
	});

	it("loads with SSE progress and waits for the loaded catalog state", async () => {
		let status: "unloaded" | "loading" | "loaded" = "unloaded";
		const streams = new Set<ServerResponse>();
		const send = (event: unknown) => {
			for (const response of streams) response.write(`data: ${JSON.stringify(event)}\n\n`);
		};
		const { url } = await listen((request, response) => {
			if (request.url === "/models/sse") {
				response.writeHead(200, { "Content-Type": "text/event-stream" });
				streams.add(response);
				request.on("close", () => streams.delete(response));
				return;
			}
			if (request.url === "/models/load" && request.method === "POST") {
				status = "loading";
				json(response, { success: true });
				setTimeout(() => {
					send({
						model: "test-model",
						event: "status_change",
						data: {
							status: "loading",
							progress: { stages: ["text_model", "mmproj_model"], current: "text_model", value: 0.5 },
						},
					});
					status = "loaded";
					send({ model: "test-model", event: "status_change", data: { status: "loaded" } });
				}, 20);
				return;
			}
			if (request.url === "/models") {
				json(response, { data: [{ id: "test-model", status: { value: status } }] });
				return;
			}
			response.writeHead(404).end();
		});

		const progress: string[] = [];
		const model = await new LlamaClient(url).loadAndWait("test-model", (entry) => progress.push(entry.message));
		expect(model.status.value).toBe("loaded");
		expect(progress).toContain("Loading text model");
	});

	it("downloads with byte progress and returns the refreshed catalog", async () => {
		let status: "missing" | "downloading" | "unloaded" = "missing";
		const streams = new Set<ServerResponse>();
		const send = (event: unknown) => {
			for (const response of streams) response.write(`data: ${JSON.stringify(event)}\n\n`);
		};
		const { url } = await listen((request, response) => {
			if (request.url === "/models/sse") {
				response.writeHead(200, { "Content-Type": "text/event-stream" });
				streams.add(response);
				request.on("close", () => streams.delete(response));
				return;
			}
			if (request.url === "/models" && request.method === "POST") {
				status = "downloading";
				json(response, { success: true });
				setTimeout(() => {
					send({
						model: "owner/repo:Q4_K_M",
						event: "download_progress",
						data: { progress: { "https://example/model.gguf": { done: 512, total: 1024 } } },
					});
					status = "unloaded";
					send({ model: "owner/repo:Q4_K_M", event: "download_finished", data: {} });
				}, 20);
				return;
			}
			if (request.url?.startsWith("/models")) {
				json(response, {
					data: status === "missing" ? [] : [{ id: "owner/repo:Q4_K_M", status: { value: status } }],
				});
				return;
			}
			response.writeHead(404).end();
		});

		const progress: LlamaProgress[] = [];
		const models = await new LlamaClient(url).downloadAndWait("owner/repo:Q4_K_M", (entry) => progress.push(entry));
		expect(models).toEqual([{ id: "owner/repo:Q4_K_M", status: { value: "unloaded" } }]);
		expect(progress).toContainEqual({
			message: "Downloading model",
			ratio: 0.5,
			detail: "512 B / 1.00 KiB",
		});
	});
});
