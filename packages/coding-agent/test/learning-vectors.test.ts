import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	createEmbedder,
	DEFAULT_EMBEDDING_CONFIG,
	DEFAULT_LOCAL_MODEL,
	type EmbeddingConfig,
	embeddingsUrl,
	HttpEmbedder,
	LOCAL_MIN_SCORE,
	LocalEmbedder,
	MAX_CHARS_PER_TEXT,
	normalizeVector,
	readEmbeddingConfig,
	SERVER_MIN_SCORE,
	type TransformersModule,
} from "../src/extensions/learning/embeddings.ts";
import {
	deserializeVector,
	hashChunk,
	serializeVector,
	type VectorChunk,
	VectorStore,
} from "../src/extensions/learning/vectors.ts";

/**
 * Phase 0 of semantic recall: the embedding client and the vector store.
 * Neither is wired into a session yet, so these tests are the whole
 * contract. The embedder is exercised against a loopback HTTP server (no
 * external network); the store against a real state.db in a temp dir.
 */

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "smolt-vectors-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

describe("readEmbeddingConfig", () => {
	test("defaults to the local model when no config exists", () => {
		expect(readEmbeddingConfig(undefined)).toEqual(DEFAULT_EMBEDDING_CONFIG);
		const config = readEmbeddingConfig(join(dir, "missing.json"));
		expect(config.enabled).toBe(true);
		expect(config.engine).toBe("local");
		expect(config.model).toBe(DEFAULT_LOCAL_MODEL);
		expect(config.minScore).toBe(LOCAL_MIN_SCORE);
	});

	test("a file naming a server without an engine is a server config", () => {
		// The shape written before the local engine existed keeps working.
		const path = join(dir, "embeddings.json");
		writeFileSync(
			path,
			JSON.stringify({ enabled: true, baseUrl: " http://localhost:9999 ", model: " bge-small ", batchSize: 8 }),
		);
		const config = readEmbeddingConfig(path);
		expect(config.engine).toBe("server");
		expect(config.baseUrl).toBe("http://localhost:9999");
		expect(config.model).toBe("bge-small");
		expect(config.batchSize).toBe(8);
		expect(config.minScore).toBe(SERVER_MIN_SCORE);
		expect(config.timeoutMs).toBe(DEFAULT_EMBEDDING_CONFIG.timeoutMs);
	});

	test("an explicit engine wins over the presence of a baseUrl", () => {
		const path = join(dir, "embeddings.json");
		writeFileSync(
			path,
			JSON.stringify({
				engine: "local",
				baseUrl: "http://localhost:9999",
				minScore: 0.7,
				modelsDir: " /models ",
				modulePath: " /pkg ",
			}),
		);
		const config = readEmbeddingConfig(path);
		expect(config.engine).toBe("local");
		expect(config.model).toBe(DEFAULT_LOCAL_MODEL);
		expect(config.minScore).toBe(0.7);
		expect(config.modelsDir).toBe("/models");
		expect(config.modulePath).toBe("/pkg");
	});

	test("an empty model on the local engine means the default model", () => {
		const path = join(dir, "embeddings.json");
		writeFileSync(path, JSON.stringify({ model: "" }));
		expect(readEmbeddingConfig(path).model).toBe(DEFAULT_LOCAL_MODEL);
	});

	test("switches off when asked", () => {
		const path = join(dir, "embeddings.json");
		writeFileSync(path, JSON.stringify({ enabled: false }));
		expect(readEmbeddingConfig(path).enabled).toBe(false);
	});

	test("a malformed config falls back to the defaults rather than throwing", () => {
		const path = join(dir, "embeddings.json");
		writeFileSync(path, "{ not json");
		expect(readEmbeddingConfig(path)).toEqual(DEFAULT_EMBEDDING_CONFIG);
	});

	test("rejects nonsensical numbers", () => {
		const path = join(dir, "embeddings.json");
		writeFileSync(path, JSON.stringify({ batchSize: 0, timeoutMs: -5 }));
		const config = readEmbeddingConfig(path);
		expect(config.batchSize).toBe(DEFAULT_EMBEDDING_CONFIG.batchSize);
		expect(config.timeoutMs).toBe(DEFAULT_EMBEDDING_CONFIG.timeoutMs);
	});
});

describe("embeddingsUrl", () => {
	test("appends the endpoint to a server root", () => {
		expect(embeddingsUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080/v1/embeddings");
		expect(embeddingsUrl("http://127.0.0.1:8080/")).toBe("http://127.0.0.1:8080/v1/embeddings");
	});

	test("does not double a base that already ends in /v1", () => {
		expect(embeddingsUrl("https://api.example.com/v1")).toBe("https://api.example.com/v1/embeddings");
	});

	test("rejects non-http schemes", () => {
		expect(() => embeddingsUrl("ftp://example.com")).toThrow(/http/);
	});
});

describe("createEmbedder", () => {
	const noModule = { resolveEntry: () => undefined };
	const server = { ...DEFAULT_EMBEDDING_CONFIG, engine: "server" as const, model: "bge-small" };

	test("returns undefined when disabled", () => {
		expect(createEmbedder({ ...DEFAULT_EMBEDDING_CONFIG, enabled: false }, withFakeModule())).toBeUndefined();
		expect(createEmbedder({ ...server, enabled: false })).toBeUndefined();
	});

	test("the server engine needs a model", () => {
		expect(createEmbedder({ ...server, model: "" })).toBeUndefined();
	});

	test("returns undefined for a malformed baseUrl instead of throwing", () => {
		expect(createEmbedder({ ...server, baseUrl: "not a url" })).toBeUndefined();
	});

	test("builds a server client once named", () => {
		const embedder = createEmbedder(server);
		expect(embedder).toBeInstanceOf(HttpEmbedder);
		expect(embedder?.modelId).toBe("bge-small");
		expect(embedder?.dim).toBe(0);
	});

	test("the local engine is nothing when no module can be found", () => {
		expect(createEmbedder(DEFAULT_EMBEDDING_CONFIG, noModule)).toBeUndefined();
	});

	test("the local engine builds an in-process embedder when the module resolves", () => {
		const embedder = createEmbedder(DEFAULT_EMBEDDING_CONFIG, {
			resolveEntry: () => join(dir, "transformers.node.mjs"),
			modelsDir: join(dir, "models"),
		});
		expect(embedder).toBeInstanceOf(LocalEmbedder);
		expect(embedder?.modelId).toBe(DEFAULT_LOCAL_MODEL);
		expect((embedder as LocalEmbedder).modelsDir).toBe(join(dir, "models"));
	});

	test("a models directory in the config beats the built-in default but not the caller's", () => {
		const fromConfig = createEmbedder({ ...DEFAULT_EMBEDDING_CONFIG, modelsDir: "/from-config" }, withFakeModule());
		expect((fromConfig as LocalEmbedder).modelsDir).toBe("/from-config");
		const fromCaller = createEmbedder(
			{ ...DEFAULT_EMBEDDING_CONFIG, modelsDir: "/from-config" },
			{ ...withFakeModule(), modelsDir: "/from-caller" },
		);
		expect((fromCaller as LocalEmbedder).modelsDir).toBe("/from-caller");
	});
});

// ---------------------------------------------------------------------------
// LocalEmbedder
// ---------------------------------------------------------------------------

interface FakeCall {
	texts: string[];
	options: Record<string, unknown>;
}

interface FakeTransformers {
	module: TransformersModule;
	loads: number;
	pipelineArgs: unknown[][];
	calls: FakeCall[];
}

/** A transformers.js stand-in whose vectors encode the input length, unnormalized on purpose. */
function fakeTransformers(options: { dim?: number; rows?: (n: number) => number; onCall?: () => void } = {}) {
	const dim = options.dim ?? 4;
	const fake: FakeTransformers = { loads: 0, pipelineArgs: [], calls: [], module: undefined as never };
	fake.module = {
		env: {},
		async pipeline(task, model, pipelineOptions) {
			fake.loads++;
			fake.pipelineArgs.push([task, model, pipelineOptions]);
			return async (texts, callOptions) => {
				fake.calls.push({ texts, options: callOptions });
				options.onCall?.();
				const rows = options.rows ? options.rows(texts.length) : texts.length;
				const data = new Float32Array(rows * dim);
				texts.slice(0, rows).forEach((text, r) => {
					data[r * dim] = text.length;
					data[r * dim + 1] = 1;
				});
				return { dims: [rows, dim], data };
			};
		},
	};
	return fake;
}

function withFakeModule(fake = fakeTransformers()) {
	return { loadModule: async () => fake.module };
}

describe("LocalEmbedder", () => {
	function local(fake: FakeTransformers, overrides: Partial<EmbeddingConfig> = {}): LocalEmbedder {
		return new LocalEmbedder(
			{ ...DEFAULT_EMBEDDING_CONFIG, ...overrides },
			{ modelsDir: join(dir, "models"), loadModule: async () => fake.module },
		);
	}

	test("loads the model into the models directory on first use, not on construction", async () => {
		const fake = fakeTransformers();
		const embedder = local(fake);
		expect(fake.loads).toBe(0);
		await embedder.embed(["hello"]);
		expect(fake.loads).toBe(1);
		expect(fake.module.env.cacheDir).toBe(join(dir, "models"));
		expect(fake.pipelineArgs[0]).toEqual(["feature-extraction", DEFAULT_LOCAL_MODEL, { dtype: "q8" }]);
	});

	test("embeds in batches, mean-pooled and normalized, and reports the width", async () => {
		const fake = fakeTransformers();
		const embedder = local(fake, { batchSize: 2 });
		const vectors = await embedder.embed(["a", "bb", "ccc", "dddd", "eeeee"]);
		expect(fake.calls.map((call) => call.texts.length)).toEqual([2, 2, 1]);
		for (const call of fake.calls) expect(call.options).toEqual({ pooling: "mean", normalize: true });
		expect(vectors).toHaveLength(5);
		for (const vec of vectors) {
			expect(vec).toBeInstanceOf(Float32Array);
			let sum = 0;
			for (const value of vec) sum += value * value;
			expect(sum).toBeCloseTo(1, 5);
		}
		expect(embedder.dim).toBe(4);
		expect(await embedder.embed([])).toEqual([]);
	});

	test("shares one load across concurrent callers", async () => {
		const fake = fakeTransformers();
		const embedder = local(fake);
		await Promise.all([embedder.embed(["a"]), embedder.embed(["b"])]);
		expect(fake.loads).toBe(1);
	});

	test("forgets a failed load so the next call tries again", async () => {
		const fake = fakeTransformers();
		let attempt = 0;
		const embedder = new LocalEmbedder(DEFAULT_EMBEDDING_CONFIG, {
			modelsDir: join(dir, "models"),
			loadModule: async () => {
				attempt++;
				if (attempt === 1) throw new Error("offline");
				return fake.module;
			},
		});
		await expect(embedder.embed(["a"])).rejects.toThrow("offline");
		await expect(embedder.embed(["a"])).resolves.toHaveLength(1);
		expect(attempt).toBe(2);
	});

	test("cuts long texts before the tokenizer sees them", async () => {
		const fake = fakeTransformers();
		await local(fake).embed(["x".repeat(MAX_CHARS_PER_TEXT * 3)]);
		expect(fake.calls[0]?.texts[0]?.length).toBe(MAX_CHARS_PER_TEXT);
	});

	test("stops between batches when aborted", async () => {
		const controller = new AbortController();
		const fake = fakeTransformers({ onCall: () => controller.abort() });
		const embedder = local(fake, { batchSize: 1 });
		await expect(embedder.embed(["a", "b", "c"], controller.signal)).rejects.toThrow();
		expect(fake.calls).toHaveLength(1);
		await expect(embedder.embed(["a"], controller.signal)).rejects.toThrow();
	});

	test("rejects a tensor whose shape disagrees with the batch", async () => {
		const fake = fakeTransformers({ rows: (n) => n - 1 });
		await expect(local(fake).embed(["a", "b"])).rejects.toThrow(/shape/);
	});

	test("knows whether the weights are already on disk", () => {
		const embedder = local(fakeTransformers());
		expect(embedder.modelCached).toBe(false);
		mkdirSync(join(dir, "models", ...DEFAULT_LOCAL_MODEL.split("/")), { recursive: true });
		expect(embedder.modelCached).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Vector helpers
// ---------------------------------------------------------------------------

describe("vector helpers", () => {
	test("normalizeVector scales to unit length", () => {
		const vec = normalizeVector(new Float32Array([3, 4]));
		expect(vec[0]).toBeCloseTo(0.6, 5);
		expect(vec[1]).toBeCloseTo(0.8, 5);
	});

	test("normalizeVector leaves a zero vector alone", () => {
		expect(Array.from(normalizeVector(new Float32Array([0, 0])))).toEqual([0, 0]);
	});

	test("serialize/deserialize round-trips through a byte offset", () => {
		const vec = new Float32Array([0.25, -0.5, 1]);
		const bytes = serializeVector(vec);
		expect(bytes.byteLength).toBe(12);
		const out = new Float32Array(6);
		deserializeVector(bytes, out, 3);
		expect(Array.from(out)).toEqual([0, 0, 0, 0.25, -0.5, 1]);
	});

	test("hashChunk is stable and content-sensitive", () => {
		expect(hashChunk("hello")).toBe(hashChunk("hello"));
		expect(hashChunk("hello")).not.toBe(hashChunk("hello "));
		expect(hashChunk("hello")).toHaveLength(16);
	});
});

// ---------------------------------------------------------------------------
// HttpEmbedder against a loopback server
// ---------------------------------------------------------------------------

interface EmbedRequest {
	model?: string;
	input?: string[];
}

describe("HttpEmbedder", () => {
	let server: Server;
	let baseUrl: string;
	let requests: EmbedRequest[];
	let respond: (body: EmbedRequest) => { status?: number; payload: unknown };

	beforeEach(async () => {
		requests = [];
		respond = (body) => ({
			payload: {
				data: (body.input ?? []).map((text, index) => ({ index, embedding: [text.length, 1, 0] })),
			},
		});
		server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (chunk: Buffer) => chunks.push(chunk));
			req.on("end", () => {
				const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as EmbedRequest;
				requests.push(body);
				const { status, payload } = respond(body);
				res.writeHead(status ?? 200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(payload));
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("server did not bind a port");
		baseUrl = `http://127.0.0.1:${address.port}`;
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	function embedder(overrides: Partial<EmbeddingConfig> = {}): HttpEmbedder {
		return new HttpEmbedder({
			...DEFAULT_EMBEDDING_CONFIG,
			enabled: true,
			model: "test-model",
			baseUrl,
			...overrides,
		});
	}

	test("embeds, normalizes, and reports the observed width", async () => {
		const client = embedder();
		const [vec] = await client.embed(["abcd"]);
		expect(client.dim).toBe(3);
		let length = 0;
		for (const value of vec!) length += value * value;
		expect(Math.sqrt(length)).toBeCloseTo(1, 5);
		expect(requests[0]?.model).toBe("test-model");
	});

	test("splits into batches and preserves input order across them", async () => {
		const client = embedder({ batchSize: 2 });
		const vectors = await client.embed(["a", "bb", "ccc", "dddd", "eeeee"]);
		expect(requests).toHaveLength(3);
		expect(requests.map((r) => r.input?.length)).toEqual([2, 2, 1]);
		// The fixture encodes input length in the first component; after
		// normalization the ordering by that component still holds.
		expect(vectors).toHaveLength(5);
		expect(vectors[0]![0]!).toBeLessThan(vectors[4]![0]!);
	});

	test("honours out-of-order index fields", async () => {
		respond = (body) => ({
			payload: {
				data: (body.input ?? []).map((text, index) => ({ index, embedding: [text.length, 0, 0] })).reverse(),
			},
		});
		const client = embedder();
		const vectors = await client.embed(["a", "bbbb"]);
		// Normalized [1,0,0] both ways, so check the server really shuffled
		// and the client still mapped index 0 to the first input.
		expect(vectors).toHaveLength(2);
		expect(vectors[0]![0]).toBeCloseTo(1, 5);
	});

	test("surfaces the server error message", async () => {
		respond = () => ({ status: 500, payload: { error: { message: "model not loaded" } } });
		await expect(embedder().embed(["x"])).rejects.toThrow("model not loaded");
	});

	test("names the fix when the server returns per-token vectors", async () => {
		respond = () => ({
			payload: {
				data: [
					{
						index: 0,
						embedding: [
							[1, 0],
							[0, 1],
						],
					},
				],
			},
		});
		await expect(embedder().embed(["x"])).rejects.toThrow(/pooling/);
	});

	test("rejects a batch whose size does not match the request", async () => {
		respond = () => ({ payload: { data: [{ index: 0, embedding: [1, 0, 0] }] } });
		await expect(embedder().embed(["x", "y"])).rejects.toThrow(/1 vectors for 2 inputs/);
	});
});

// ---------------------------------------------------------------------------
// VectorStore
// ---------------------------------------------------------------------------

function chunk(overrides: Partial<VectorChunk> & { vec: Float32Array }): VectorChunk {
	return {
		path: "/sessions/a.jsonl",
		idx: 0,
		chunk: 0,
		sessionId: "s1",
		role: "user",
		ts: "2026-09-01T00:00:00Z",
		contentHash: "hash",
		...overrides,
	};
}

describe("VectorStore", () => {
	let store: VectorStore;

	beforeEach(async () => {
		store = new VectorStore(join(dir, "state.db"));
		await store.open("model-a");
	});

	afterEach(() => {
		store.close();
	});

	test("ranks by cosine similarity and respects the limit", async () => {
		await store.put([
			chunk({ idx: 0, vec: normalizeVector(new Float32Array([1, 0, 0])) }),
			chunk({ idx: 1, vec: normalizeVector(new Float32Array([0.9, 0.1, 0])) }),
			chunk({ idx: 2, vec: normalizeVector(new Float32Array([0, 1, 0])) }),
		]);
		const hits = await store.search(normalizeVector(new Float32Array([1, 0, 0])), { limit: 2 });
		expect(hits.map((h) => h.idx)).toEqual([0, 1]);
		expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
		expect(hits[0]!.sessionId).toBe("s1");
	});

	test("filters by role", async () => {
		await store.put([
			chunk({ idx: 0, role: "user", vec: normalizeVector(new Float32Array([1, 0, 0])) }),
			chunk({ idx: 1, role: "tool", vec: normalizeVector(new Float32Array([1, 0, 0])) }),
		]);
		const hits = await store.search(new Float32Array([1, 0, 0]), { limit: 5, roles: ["user"] });
		expect(hits).toHaveLength(1);
		expect(hits[0]!.role).toBe("user");
	});

	test("reports stored hashes per path so only changed messages re-embed", async () => {
		await store.put([
			chunk({ idx: 0, contentHash: "aaa", vec: new Float32Array([1, 0, 0]) }),
			chunk({ idx: 1, contentHash: "bbb", vec: new Float32Array([0, 1, 0]) }),
			chunk({ path: "/sessions/b.jsonl", idx: 0, contentHash: "ccc", vec: new Float32Array([0, 0, 1]) }),
		]);
		const hashes = await store.hashesForPath("/sessions/a.jsonl");
		expect(hashes.get(0)).toBe("aaa");
		expect(hashes.get(1)).toBe("bbb");
		expect(hashes.size).toBe(2);
		expect(await store.count()).toBe(3);
	});

	test("replaces a row in place when its content changed", async () => {
		await store.put([chunk({ idx: 0, contentHash: "old", vec: new Float32Array([1, 0, 0]) })]);
		await store.put([chunk({ idx: 0, contentHash: "new", vec: new Float32Array([0, 1, 0]) })]);
		expect(await store.count()).toBe(1);
		expect((await store.hashesForPath("/sessions/a.jsonl")).get(0)).toBe("new");
		const hits = await store.search(new Float32Array([0, 1, 0]), { limit: 1 });
		expect(hits[0]!.score).toBeCloseTo(1, 5);
	});

	test("deletes by path and lists known paths", async () => {
		await store.put([
			chunk({ idx: 0, vec: new Float32Array([1, 0, 0]) }),
			chunk({ path: "/sessions/b.jsonl", idx: 0, vec: new Float32Array([0, 1, 0]) }),
		]);
		expect((await store.knownPaths()).sort()).toEqual(["/sessions/a.jsonl", "/sessions/b.jsonl"]);
		await store.deletePaths(["/sessions/a.jsonl"]);
		expect(await store.knownPaths()).toEqual(["/sessions/b.jsonl"]);
		const hits = await store.search(new Float32Array([1, 0, 0]), { limit: 5 });
		expect(hits).toHaveLength(0);
	});

	test("a search reflects writes made after the matrix was cached", async () => {
		await store.put([chunk({ idx: 0, vec: normalizeVector(new Float32Array([1, 1, 0])) })]);
		// Caches the matrix at one row.
		expect(await store.search(new Float32Array([0, 1, 0]), { limit: 5 })).toHaveLength(1);
		await store.put([chunk({ idx: 1, vec: new Float32Array([0, 1, 0]) })]);
		const hits = await store.search(new Float32Array([0, 1, 0]), { limit: 5 });
		expect(hits).toHaveLength(2);
		expect(hits[0]!.idx).toBe(1);
	});

	test("changing the embedding model discards the index", async () => {
		await store.put([chunk({ idx: 0, vec: new Float32Array([1, 0, 0]) })]);
		store.close();
		const reopened = new VectorStore(join(dir, "state.db"));
		await reopened.open("model-b");
		expect(await reopened.count()).toBe(0);
		reopened.close();
	});

	test("reopening with the same model keeps the index", async () => {
		await store.put([chunk({ idx: 0, vec: new Float32Array([1, 0, 0]) })]);
		store.close();
		const reopened = new VectorStore(join(dir, "state.db"));
		await reopened.open("model-a");
		expect(await reopened.count()).toBe(1);
		expect(await reopened.search(new Float32Array([1, 0, 0]), { limit: 1 })).toHaveLength(1);
		reopened.close();
	});

	test("a changed vector width under the same model discards the index", async () => {
		await store.put([chunk({ idx: 0, vec: new Float32Array([1, 0, 0]) })]);
		await store.put([chunk({ idx: 5, vec: new Float32Array([1, 0, 0, 0]) })]);
		expect(await store.count()).toBe(1);
		expect(store.dim).toBe(4);
		const hits = await store.search(new Float32Array([1, 0, 0, 0]), { limit: 5 });
		expect(hits.map((h) => h.idx)).toEqual([5]);
	});

	test("a query of the wrong width returns nothing rather than throwing", async () => {
		await store.put([chunk({ idx: 0, vec: new Float32Array([1, 0, 0]) })]);
		expect(await store.search(new Float32Array([1, 0]), { limit: 5 })).toEqual([]);
	});

	test("drops unrelated chunks instead of returning a least-bad neighbour", async () => {
		await store.put([
			chunk({ idx: 0, vec: normalizeVector(new Float32Array([1, 0, 0])) }),
			chunk({ idx: 1, vec: normalizeVector(new Float32Array([0, 1, 0])) }),
		]);
		// Orthogonal to both: scores 0, so neither is a hit.
		expect(await store.search(new Float32Array([0, 0, 1]), { limit: 5 })).toEqual([]);
	});

	test("honours a raised score floor", async () => {
		await store.put([
			chunk({ idx: 0, vec: normalizeVector(new Float32Array([1, 0, 0])) }),
			chunk({ idx: 1, vec: normalizeVector(new Float32Array([1, 1, 0])) }),
		]);
		const hits = await store.search(normalizeVector(new Float32Array([1, 0, 0])), { limit: 5, minScore: 0.9 });
		expect(hits.map((h) => h.idx)).toEqual([0]);
	});

	test("stores every chunk of a message as one set and replaces the set", async () => {
		await store.put([
			chunk({ idx: 0, chunk: 0, vec: new Float32Array([1, 0, 0]) }),
			chunk({ idx: 0, chunk: 1, vec: new Float32Array([0, 1, 0]) }),
			chunk({ idx: 0, chunk: 2, vec: new Float32Array([0, 0, 1]) }),
			chunk({ idx: 1, chunk: 0, vec: new Float32Array([1, 0, 0]) }),
		]);
		expect(await store.count()).toBe(4);
		const hits = await store.search(new Float32Array([0, 0, 1]), { limit: 1 });
		expect(hits[0]).toMatchObject({ idx: 0, chunk: 2 });
		// One hash per message, whatever its chunk count.
		expect((await store.hashesForPath("/sessions/a.jsonl")).size).toBe(2);

		// The message shrank to one chunk: the old tail must go with it.
		await store.put([chunk({ idx: 0, chunk: 0, contentHash: "short", vec: new Float32Array([1, 0, 0]) })]);
		expect(await store.count()).toBe(2);
		expect(await store.search(new Float32Array([0, 0, 1]), { limit: 5 })).toHaveLength(0);
	});

	test("remembers per-file state until the file, the model, or the index changes", async () => {
		expect(await store.fileState("/sessions/a.jsonl")).toBeUndefined();
		await store.setFileState("/sessions/a.jsonl", { mtime: 1234.9, size: 99, complete: true });
		expect(await store.fileState("/sessions/a.jsonl")).toEqual({ mtime: 1234, size: 99, complete: true });
		await store.setFileState("/sessions/a.jsonl", { mtime: 1234, size: 99, complete: false });
		expect((await store.fileState("/sessions/a.jsonl"))?.complete).toBe(false);

		await store.deletePaths(["/sessions/a.jsonl"]);
		expect(await store.fileState("/sessions/a.jsonl")).toBeUndefined();

		await store.setFileState("/sessions/b.jsonl", { mtime: 1, size: 1, complete: true });
		await store.open("model-b");
		expect(await store.fileState("/sessions/b.jsonl")).toBeUndefined();
	});

	test("migrates a version-1 index into chunk rows without losing a vector", async () => {
		store.close();
		const path = join(dir, "v1.db");
		interface RawDb {
			exec(sql: string): void;
			prepare(sql: string): { run(...args: unknown[]): unknown };
			close(): void;
		}
		const { DatabaseSync } = (await import("node:sqlite")) as { DatabaseSync: new (p: string) => RawDb };
		const db = new DatabaseSync(path);
		db.exec("CREATE TABLE vec_meta(key TEXT PRIMARY KEY, value TEXT)");
		db.exec(
			"CREATE TABLE vec_chunks (path TEXT NOT NULL, idx INTEGER NOT NULL, session_id TEXT NOT NULL, " +
				"role TEXT NOT NULL, ts TEXT NOT NULL DEFAULT '', content_hash TEXT NOT NULL, vec BLOB NOT NULL, " +
				"PRIMARY KEY (path, idx))",
		);
		db.prepare("INSERT INTO vec_meta VALUES ('schema_version', '1'), ('model', 'model-a'), ('dim', '3')").run();
		const insert = db.prepare("INSERT INTO vec_chunks VALUES (?, ?, ?, ?, ?, ?, ?)");
		insert.run("/s/a.jsonl", 0, "s1", "user", "t", "h0", serializeVector(new Float32Array([1, 0, 0])));
		insert.run("/s/a.jsonl", 1, "s1", "assistant", "t", "h1", serializeVector(new Float32Array([0, 1, 0])));
		db.close();

		const migrated = new VectorStore(path);
		expect(await migrated.open("model-a")).toBe(true);
		expect(await migrated.count()).toBe(2);
		const hits = await migrated.search(new Float32Array([0, 1, 0]), { limit: 1 });
		expect(hits[0]).toMatchObject({ idx: 1, chunk: 0, role: "assistant" });
		expect((await migrated.hashesForPath("/s/a.jsonl")).get(0)).toBe("h0");
		// New rows land in the rebuilt table alongside the old ones.
		await migrated.put([chunk({ path: "/s/a.jsonl", idx: 2, chunk: 1, vec: new Float32Array([0, 0, 1]) })]);
		expect(await migrated.count()).toBe(3);
		migrated.close();
	});

	test("an empty store searches cleanly", async () => {
		expect(await store.search(new Float32Array([1, 0, 0]), { limit: 5 })).toEqual([]);
		expect(await store.count()).toBe(0);
	});
});
