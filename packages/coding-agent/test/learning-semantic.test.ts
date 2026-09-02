import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import {
	DEFAULT_LOCAL_MODEL,
	HttpEmbedder,
	LocalEmbedder,
	type TransformersModule,
} from "../src/extensions/learning/embeddings.ts";
import semanticRecallExtension, {
	createSemanticRecall,
	provideSemanticRecall,
	type SemanticRecall,
	takeSemanticRecall,
} from "../src/extensions/learning/semantic.ts";

/**
 * The semantic-recall switch: a built-in of its own that builds the
 * embedder and hands it to the learning extension at load, so that turning
 * it off in settings turns off exactly the model and nothing else.
 */

let dir: string;

const fakeModule: TransformersModule = {
	env: {},
	async pipeline() {
		return async (texts) => ({ dims: [texts.length, 2], data: new Float32Array(texts.length * 2).fill(1) });
	},
};
const withFakeModule = { loadModule: async () => fakeModule };

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "smolt-semantic-"));
	takeSemanticRecall();
});

afterEach(() => {
	takeSemanticRecall()?.vectors.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("handoff", () => {
	test("take returns what was provided once, then nothing", () => {
		const recall = createSemanticRecall(
			{ modelsDir: join(dir, "models"), stateDbPath: join(dir, "state.db") },
			withFakeModule,
		);
		expect(recall).toBeDefined();
		provideSemanticRecall(recall);
		expect(takeSemanticRecall()).toBe(recall);
		expect(takeSemanticRecall()).toBeUndefined();
		recall?.vectors.close();
	});
});

describe("createSemanticRecall", () => {
	const paths = () => ({
		configPath: join(dir, "embeddings.json"),
		modelsDir: join(dir, "models"),
		stateDbPath: join(dir, "state.db"),
	});

	test("defaults to the local model cached under the given models directory", () => {
		const recall = createSemanticRecall(paths(), withFakeModule) as SemanticRecall;
		expect(recall.embedder).toBeInstanceOf(LocalEmbedder);
		expect(recall.embedder.modelId).toBe(DEFAULT_LOCAL_MODEL);
		expect((recall.embedder as LocalEmbedder).modelsDir).toBe(join(dir, "models"));
		expect(recall.config.engine).toBe("local");
		recall.vectors.close();
	});

	test("a models directory named in the config wins", () => {
		writeFileSync(join(dir, "embeddings.json"), JSON.stringify({ modelsDir: join(dir, "elsewhere") }));
		const recall = createSemanticRecall(paths(), withFakeModule) as SemanticRecall;
		expect((recall.embedder as LocalEmbedder).modelsDir).toBe(join(dir, "elsewhere"));
		recall.vectors.close();
	});

	test("is nothing when switched off in the config", () => {
		writeFileSync(join(dir, "embeddings.json"), JSON.stringify({ enabled: false }));
		expect(createSemanticRecall(paths(), withFakeModule)).toBeUndefined();
	});

	test("is nothing when no transformers module can be found", () => {
		expect(createSemanticRecall(paths(), { resolveEntry: () => undefined })).toBeUndefined();
	});

	test("a server config builds the HTTP client instead", () => {
		writeFileSync(
			join(dir, "embeddings.json"),
			JSON.stringify({ baseUrl: "http://127.0.0.1:9999", model: "bge-small" }),
		);
		const recall = createSemanticRecall(paths(), { resolveEntry: () => undefined }) as SemanticRecall;
		expect(recall.embedder).toBeInstanceOf(HttpEmbedder);
		expect(recall.embedder.modelId).toBe("bge-small");
		recall.vectors.close();
	});
});

describe("the built-in extension", () => {
	test("hands over a local embedder from the agent directory", () => {
		// Resolves the real transformers.js the workspace carries for the
		// desktop; nothing is loaded, only located.
		const previous = process.env.SMOLT_CODING_AGENT_DIR;
		process.env.SMOLT_CODING_AGENT_DIR = dir;
		try {
			semanticRecallExtension({} as ExtensionAPI);
		} finally {
			if (previous === undefined) delete process.env.SMOLT_CODING_AGENT_DIR;
			else process.env.SMOLT_CODING_AGENT_DIR = previous;
		}
		const recall = takeSemanticRecall();
		expect(recall?.embedder).toBeInstanceOf(LocalEmbedder);
		expect((recall?.embedder as LocalEmbedder).modelsDir).toBe(join(dir, "models"));
		recall?.vectors.close();
	});

	test("is registered before learning so the handoff lands, and both say what they do", () => {
		const names = builtInExtensions.map((entry) => (typeof entry === "function" ? "" : entry.name));
		const semantic = names.indexOf("semantic-recall");
		const learning = names.indexOf("learning");
		expect(semantic).toBeGreaterThanOrEqual(0);
		expect(learning).toBeGreaterThan(semantic);
		for (const entry of builtInExtensions) {
			if (typeof entry === "function") continue;
			expect(entry.description, entry.name).toBeTruthy();
		}
	});
});
