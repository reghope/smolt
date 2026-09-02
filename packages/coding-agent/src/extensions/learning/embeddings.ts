import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Embeddings: the one model call the vector features need.
 *
 * Two engines, one interface:
 *
 * - `local` (the default): a small sentence-embedding model run in this
 *   process through transformers.js. The weights (~34 MB) download once
 *   into the smolt models directory and nothing ever leaves the machine.
 *   The module is not imported statically — the folder's boundary is the
 *   public extension surface plus typebox, yaml, and Node built-ins, so it
 *   can be copied out and installed standalone — but resolved at start and
 *   loaded on first use, the same computed-specifier arrangement the vector
 *   store uses for `node:sqlite`. No module means no embedder, and every
 *   caller degrades to lexical search.
 * - `server`: an OpenAI-compatible `/v1/embeddings` client, which is what
 *   llama.cpp, Ollama, OpenAI, and every gateway in between speak. Chosen
 *   by `engine: "server"` in `~/.smolt/agent/embeddings.json`, or implied
 *   when that file names a `baseUrl` without an engine, so a config written
 *   before the local engine existed keeps working.
 *
 * Vectors come back unit-normalized, which makes cosine similarity a plain
 * dot product everywhere downstream.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type EmbeddingEngine = "local" | "server";

export interface EmbeddingConfig {
	enabled: boolean;
	engine: EmbeddingEngine;
	/**
	 * Local: a transformers.js model id (org/name on the Hub). Server: the
	 * model id sent with each request, where empty means "not configured".
	 */
	model: string;
	/** Server root; `/v1/embeddings` is appended. Default is llama.cpp's. */
	baseUrl: string;
	/**
	 * Name of the environment variable holding the API key, for a hosted
	 * endpoint. The key itself is never stored in this file: config lives in
	 * plain JSON that ends up in backups and screen shares.
	 */
	apiKeyEnv: string;
	/** Texts per model call. */
	batchSize: number;
	/** Per-request timeout for the server engine. */
	timeoutMs: number;
	/**
	 * Minimum cosine similarity for a vector hit to count. Model-specific:
	 * embedding models differ in how tightly they pack unrelated text, so
	 * raise it if unrelated sessions surface and lower it if nothing does.
	 */
	minScore: number;
	/**
	 * Chunks embedded per session start. Caps the first run after enabling
	 * so it cannot stall a session; the next start continues from there.
	 */
	backfillPerSession: number;
	/** Where local weights are cached. Empty means the caller's default. */
	modelsDir: string;
	/**
	 * Explicit location of the transformers.js package (its directory or
	 * its Node entry file). Empty means the `SMOLT_EMBEDDINGS_MODULE`
	 * variable, then the package as installed beside smolt.
	 */
	modulePath: string;
}

export const DEFAULT_LOCAL_MODEL = "Xenova/bge-small-en-v1.5";

/**
 * Measured on the default model: unrelated messages score 0.35–0.55 against
 * each other and related ones 0.64 and up, so the floor sits in the gap.
 */
export const LOCAL_MIN_SCORE = 0.55;
/** The floor for a server model whose distribution is unknown; any positive lean counts. */
export const SERVER_MIN_SCORE = 0.25;

export const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = {
	enabled: true,
	engine: "local",
	model: DEFAULT_LOCAL_MODEL,
	baseUrl: "http://127.0.0.1:8080",
	apiKeyEnv: "",
	batchSize: 32,
	timeoutMs: 30_000,
	minScore: LOCAL_MIN_SCORE,
	backfillPerSession: 500,
	modelsDir: "",
	modulePath: "",
};

export function readEmbeddingConfig(configPath: string | undefined): EmbeddingConfig {
	const config = { ...DEFAULT_EMBEDDING_CONFIG };
	if (!configPath) return config;
	try {
		if (!existsSync(configPath)) return config;
		const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as Partial<EmbeddingConfig>;
		const namesServer = typeof parsed.baseUrl === "string" && parsed.baseUrl.trim() !== "";
		if (parsed.engine === "local" || parsed.engine === "server") config.engine = parsed.engine;
		else if (namesServer) config.engine = "server";
		if (typeof parsed.enabled === "boolean") config.enabled = parsed.enabled;
		if (namesServer) config.baseUrl = (parsed.baseUrl as string).trim();
		if (typeof parsed.model === "string") config.model = parsed.model.trim();
		if (config.engine === "local" && config.model === "") config.model = DEFAULT_LOCAL_MODEL;
		if (typeof parsed.apiKeyEnv === "string") config.apiKeyEnv = parsed.apiKeyEnv.trim();
		if (typeof parsed.batchSize === "number" && parsed.batchSize > 0) {
			config.batchSize = Math.floor(parsed.batchSize);
		}
		if (typeof parsed.timeoutMs === "number" && parsed.timeoutMs > 0) {
			config.timeoutMs = Math.floor(parsed.timeoutMs);
		}
		if (typeof parsed.minScore === "number" && parsed.minScore >= 0 && parsed.minScore < 1) {
			config.minScore = parsed.minScore;
		} else if (config.engine === "server") {
			config.minScore = SERVER_MIN_SCORE;
		}
		if (typeof parsed.backfillPerSession === "number" && parsed.backfillPerSession > 0) {
			config.backfillPerSession = Math.floor(parsed.backfillPerSession);
		}
		if (typeof parsed.modelsDir === "string") config.modelsDir = parsed.modelsDir.trim();
		if (typeof parsed.modulePath === "string") config.modulePath = parsed.modulePath.trim();
	} catch {
		// A malformed config falls back to the defaults rather than failing a session.
		return { ...DEFAULT_EMBEDDING_CONFIG };
	}
	return config;
}

// ---------------------------------------------------------------------------
// Vector helpers
// ---------------------------------------------------------------------------

/**
 * Scale to unit length in place and return it. A zero vector (an empty or
 * all-whitespace input) is left alone: it scores 0 against everything,
 * which is the right answer for a chunk with no content.
 */
export function normalizeVector(vec: Float32Array): Float32Array {
	let sum = 0;
	for (let i = 0; i < vec.length; i++) sum += vec[i]! * vec[i]!;
	if (sum === 0) return vec;
	const scale = 1 / Math.sqrt(sum);
	for (let i = 0; i < vec.length; i++) vec[i] = vec[i]! * scale;
	return vec;
}

// ---------------------------------------------------------------------------
// Embedder
// ---------------------------------------------------------------------------

export interface Embedder {
	/** Model id, stored alongside the vectors so a model swap invalidates them. */
	readonly modelId: string;
	/** Vector width. 0 until the first successful response. */
	readonly dim: number;
	embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
}

/** Server root to `/v1/embeddings`, tolerating a base that already ends in /v1. */
export function embeddingsUrl(baseUrl: string): string {
	const url = new URL(baseUrl.trim());
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Embedding baseUrl must use http or https");
	}
	url.hash = "";
	url.search = "";
	const path = url.pathname.replace(/\/+$/u, "").replace(/\/v1$/u, "");
	url.pathname = `${path}/v1/embeddings`;
	return url.toString();
}

function errorMessage(payload: unknown, fallback: string): string {
	if (typeof payload !== "object" || payload === null) return fallback;
	const error = (payload as { error?: unknown }).error;
	if (typeof error === "string" && error !== "") return error;
	if (typeof error !== "object" || error === null) return fallback;
	const message = (error as { message?: unknown }).message;
	return typeof message === "string" && message !== "" ? message : fallback;
}

/**
 * Pull the vectors out of an OpenAI-shaped response, in request order.
 *
 * `index` is honoured when present because a server is free to return the
 * batch out of order, and a silently misaligned batch would attach every
 * vector to the wrong message.
 */
function parseEmbeddings(payload: unknown, expected: number): Float32Array[] {
	const data = (payload as { data?: unknown } | null)?.data;
	if (!Array.isArray(data)) throw new Error("Embedding response had no data array");
	if (data.length !== expected) {
		throw new Error(`Embedding response returned ${data.length} vectors for ${expected} inputs`);
	}
	const out: (Float32Array | undefined)[] = new Array(expected).fill(undefined);
	for (let position = 0; position < data.length; position++) {
		const entry = data[position] as { embedding?: unknown; index?: unknown } | null;
		const embedding = entry?.embedding;
		if (!Array.isArray(embedding)) throw new Error("Embedding response entry had no embedding array");
		if (Array.isArray(embedding[0])) {
			// llama.cpp with `--pooling none` returns one vector per token.
			// Pooling them here would be an unannounced quality decision, so
			// say what to change instead.
			throw new Error("Embedding server returned per-token vectors; start it with pooling enabled (e.g. mean)");
		}
		const index = typeof entry?.index === "number" ? entry.index : position;
		if (index < 0 || index >= expected) throw new Error(`Embedding response index ${index} is out of range`);
		const vec = new Float32Array(embedding.length);
		for (let i = 0; i < embedding.length; i++) {
			const value = embedding[i];
			if (typeof value !== "number" || !Number.isFinite(value)) {
				throw new Error("Embedding response contained a non-numeric value");
			}
			vec[i] = value;
		}
		out[index] = normalizeVector(vec);
	}
	const vectors: Float32Array[] = [];
	for (const vec of out) {
		if (vec === undefined) throw new Error("Embedding response skipped an index");
		vectors.push(vec);
	}
	return vectors;
}

export class HttpEmbedder implements Embedder {
	readonly modelId: string;
	private readonly endpoint: string;
	private readonly apiKey: string | undefined;
	private readonly batchSize: number;
	private readonly timeoutMs: number;
	private observedDim = 0;

	constructor(config: EmbeddingConfig, apiKey?: string) {
		this.modelId = config.model;
		this.endpoint = embeddingsUrl(config.baseUrl);
		this.apiKey = apiKey;
		this.batchSize = config.batchSize;
		this.timeoutMs = config.timeoutMs;
	}

	get dim(): number {
		return this.observedDim;
	}

	async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
		if (texts.length === 0) return [];
		const out: Float32Array[] = [];
		for (let start = 0; start < texts.length; start += this.batchSize) {
			const batch = await this.embedBatch(texts.slice(start, start + this.batchSize), signal);
			for (const vec of batch) out.push(vec);
		}
		return out;
	}

	private async embedBatch(batch: string[], signal: AbortSignal | undefined): Promise<Float32Array[]> {
		const headers = new Headers({ "Content-Type": "application/json" });
		if (this.apiKey) headers.set("Authorization", `Bearer ${this.apiKey}`);
		const timeout = AbortSignal.timeout(this.timeoutMs);
		const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
		const response = await fetch(this.endpoint, {
			method: "POST",
			headers,
			body: JSON.stringify({ model: this.modelId, input: batch }),
			signal: combined,
		});
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			payload = undefined;
		}
		if (!response.ok) {
			throw new Error(errorMessage(payload, `Embedding server returned HTTP ${response.status}`));
		}
		const vectors = parseEmbeddings(payload, batch.length);
		const dim = vectors[0]?.length ?? 0;
		for (const vec of vectors) {
			if (vec.length !== dim) throw new Error("Embedding response mixed vector widths");
		}
		if (this.observedDim === 0) this.observedDim = dim;
		else if (dim !== this.observedDim) {
			throw new Error(`Embedding width changed from ${this.observedDim} to ${dim} mid-run`);
		}
		return vectors;
	}
}

// ---------------------------------------------------------------------------
// Local embedder (transformers.js in this process)
// ---------------------------------------------------------------------------

/** The slice of transformers.js this module touches. */
export interface TransformersModule {
	env: { cacheDir?: string; [key: string]: unknown };
	pipeline(task: string, model: string, options?: Record<string, unknown>): Promise<FeatureExtractor>;
}

/** A loaded feature-extraction pipeline: texts in, one tensor of rows out. */
export type FeatureExtractor = (
	texts: string[],
	options: { pooling: "mean" | "cls"; normalize: boolean },
) => Promise<{ dims: number[]; data: ArrayLike<number> }>;

export type ModuleLoader = () => Promise<TransformersModule>;

export const EMBEDDINGS_MODULE_ENV = "SMOLT_EMBEDDINGS_MODULE";
const TRANSFORMERS_PACKAGE = "@huggingface/transformers";
const TRANSFORMERS_ENTRY_FILE = "transformers.node.mjs";
const TRANSFORMERS_ENTRY = join("dist", TRANSFORMERS_ENTRY_FILE);

/**
 * Characters kept per text. The model reads 512 tokens and the tokenizer
 * truncates anything longer, so tokenizing a 40 KB message would be work
 * thrown away; this cuts it first. Roughly the same 512 tokens of English
 * or code.
 */
export const MAX_CHARS_PER_TEXT = 2000;

/** Weights on disk for a Hub model id: transformers.js lays the cache out as <dir>/<org>/<name>. */
export function localModelCached(modelsDir: string, modelId: string): boolean {
	return existsSync(join(modelsDir, ...modelId.split("/")));
}

export function defaultModelsDir(): string {
	return join(homedir(), ".smolt", "agent", "models");
}

/**
 * Locate the transformers.js Node entry.
 *
 * An explicit location wins — the config's `modulePath`, then the
 * `SMOLT_EMBEDDINGS_MODULE` variable, which is how the desktop app hands its
 * own bundled copy to the agents it spawns — accepting either the package
 * directory or the entry file. Failing those, the package as installed
 * beside smolt. Undefined when nothing exists, which is how the caller
 * learns it has nothing to run on; a missing explicit path falls through to
 * the next candidate rather than ending the search, because a stale
 * variable should not hide a working install.
 */
export function resolveTransformersEntry(explicit?: string): string | undefined {
	for (const candidate of [explicit, process.env[EMBEDDINGS_MODULE_ENV]]) {
		const location = candidate?.trim() ?? "";
		if (location === "" || !isAbsolute(location)) continue;
		const entry = /\.[cm]?js$/iu.test(location) ? location : join(location, TRANSFORMERS_ENTRY);
		if (existsSync(entry)) return entry;
	}
	try {
		// The package exports no package.json, so resolve its CommonJS entry
		// and take the ESM entry beside it.
		const require = createRequire(import.meta.url);
		const entry = join(dirname(require.resolve(TRANSFORMERS_PACKAGE)), TRANSFORMERS_ENTRY_FILE);
		return existsSync(entry) ? entry : undefined;
	} catch {
		return undefined;
	}
}

/** Import an entry file by absolute path. A computed specifier keeps bundlers from inlining it. */
export function transformersLoader(entry: string): ModuleLoader {
	return async () => {
		const specifier = pathToFileURL(entry).href;
		return (await import(specifier)) as TransformersModule;
	};
}

function tensorRows(tensor: { dims: number[]; data: ArrayLike<number> }, expected: number): Float32Array[] {
	const [rows, dim] = tensor.dims;
	if (tensor.dims.length !== 2 || rows !== expected || dim === undefined || dim <= 0) {
		throw new Error(`Embedding model returned shape [${tensor.dims.join(", ")}] for ${expected} inputs`);
	}
	if (tensor.data.length !== rows * dim) {
		throw new Error("Embedding model returned a tensor whose data does not match its shape");
	}
	const out: Float32Array[] = [];
	for (let r = 0; r < rows; r++) {
		const vec = new Float32Array(dim);
		for (let i = 0; i < dim; i++) {
			const value = tensor.data[r * dim + i];
			if (typeof value !== "number" || !Number.isFinite(value)) {
				throw new Error("Embedding model returned a non-numeric value");
			}
			vec[i] = value;
		}
		out.push(normalizeVector(vec));
	}
	return out;
}

/**
 * Runs the model in-process. The module and the weights load on the first
 * `embed`, not on construction: construction happens at every session
 * start, and the first-ever load includes a download.
 *
 * Concurrent callers share one load — the backfill and a search can both
 * ask at once — and a failed load is forgotten so the next call tries
 * again rather than inheriting an offline moment for the whole session.
 */
export class LocalEmbedder implements Embedder {
	readonly modelId: string;
	readonly modelsDir: string;
	private readonly batchSize: number;
	private readonly loadModule: ModuleLoader;
	private extractor: Promise<FeatureExtractor> | undefined;
	private observedDim = 0;

	constructor(config: EmbeddingConfig, options: { modelsDir: string; loadModule: ModuleLoader }) {
		this.modelId = config.model;
		this.modelsDir = options.modelsDir;
		this.batchSize = config.batchSize;
		this.loadModule = options.loadModule;
	}

	get dim(): number {
		return this.observedDim;
	}

	/** True once the weights are on disk, so the next load is not a download. */
	get modelCached(): boolean {
		return localModelCached(this.modelsDir, this.modelId);
	}

	private load(): Promise<FeatureExtractor> {
		if (this.extractor) return this.extractor;
		const loading = (async () => {
			const transformers = await this.loadModule();
			// Keep the weights beside the rest of smolt's state rather than in
			// a cache folder next to the executable.
			transformers.env.cacheDir = this.modelsDir;
			return transformers.pipeline("feature-extraction", this.modelId, { dtype: "q8" });
		})();
		this.extractor = loading;
		loading.catch(() => {
			if (this.extractor === loading) this.extractor = undefined;
		});
		return loading;
	}

	async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
		if (texts.length === 0) return [];
		signal?.throwIfAborted();
		const extractor = await this.load();
		const out: Float32Array[] = [];
		for (let start = 0; start < texts.length; start += this.batchSize) {
			signal?.throwIfAborted();
			const batch = texts
				.slice(start, start + this.batchSize)
				.map((text) => (text.length > MAX_CHARS_PER_TEXT ? text.slice(0, MAX_CHARS_PER_TEXT) : text));
			const tensor = await extractor(batch, { pooling: "mean", normalize: true });
			const vectors = tensorRows(tensor, batch.length);
			const dim = vectors[0]!.length;
			if (this.observedDim === 0) this.observedDim = dim;
			else if (dim !== this.observedDim) {
				throw new Error(`Embedding width changed from ${this.observedDim} to ${dim} mid-run`);
			}
			for (const vec of vectors) out.push(vec);
		}
		return out;
	}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface EmbedderOptions {
	/** Server engine: overrides the key read from `apiKeyEnv`. */
	apiKey?: string;
	/** Local engine: overrides the config's `modelsDir` and the built-in default. */
	modelsDir?: string;
	/** Local engine: replaces module resolution and import entirely (tests). */
	loadModule?: ModuleLoader;
	/** Local engine: replaces module resolution only (tests). */
	resolveEntry?: (explicit: string) => string | undefined;
}

/**
 * An embedder for the config, or undefined when embeddings are off, the
 * server engine has no model, or the local engine has no module to run.
 * Undefined is the whole signal: a caller with no embedder claims no
 * semantic recall, so the model is never told about a search that cannot
 * happen.
 */
export function createEmbedder(config: EmbeddingConfig, options: EmbedderOptions = {}): Embedder | undefined {
	if (!config.enabled || config.model === "") return undefined;
	if (config.engine === "server") {
		const key = options.apiKey ?? (config.apiKeyEnv === "" ? undefined : process.env[config.apiKeyEnv]);
		try {
			return new HttpEmbedder(config, key);
		} catch {
			// A malformed baseUrl means no embedder, not a broken session.
			return undefined;
		}
	}
	let loadModule = options.loadModule;
	if (!loadModule) {
		const entry = (options.resolveEntry ?? resolveTransformersEntry)(config.modulePath);
		if (!entry) return undefined;
		loadModule = transformersLoader(entry);
	}
	const modelsDir = options.modelsDir ?? (config.modelsDir !== "" ? config.modelsDir : defaultModelsDir());
	return new LocalEmbedder(config, { modelsDir, loadModule });
}
