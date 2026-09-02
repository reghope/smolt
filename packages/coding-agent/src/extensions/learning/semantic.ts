import { join } from "node:path";
// Type-only import: a standalone install of this module outside the smolt
// tree switches this single line to `from "smolt"`.
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import {
	createEmbedder,
	type Embedder,
	type EmbedderOptions,
	type EmbeddingConfig,
	readEmbeddingConfig,
} from "./embeddings.ts";
import { agentDir } from "./paths.ts";
import { VectorStore } from "./vectors.ts";

/**
 * Semantic recall as its own switch.
 *
 * Searching past sessions by meaning is part of the learning extension, but
 * it is the one part with a real cost: a model in memory, a one-time
 * download, and a few seconds of embedding at session start. So it is
 * listed in settings as an extension of its own — `semantic-recall` — that
 * can be turned off without losing memory, skills, or lexical search.
 *
 * The extension itself does no work in the session. It reads the config,
 * builds the embedder and the vector store, and hands them to the learning
 * extension through `takeSemanticRecall`, which runs next in the built-in
 * order. Switched off, it never loads, nothing is handed over, and session
 * search stays lexical. The handoff is a take, not a read: an extension
 * reload without this one must not inherit the previous load's embedder.
 */

export interface SemanticRecall {
	config: EmbeddingConfig;
	embedder: Embedder;
	vectors: VectorStore;
}

let provided: SemanticRecall | undefined;

export function provideSemanticRecall(recall: SemanticRecall | undefined): void {
	provided = recall;
}

/** The pending handoff, cleared on read. */
export function takeSemanticRecall(): SemanticRecall | undefined {
	const recall = provided;
	provided = undefined;
	return recall;
}

export interface SemanticRecallPaths {
	/** embeddings.json; defaults apply when absent. */
	configPath?: string;
	/** Where local weights are cached, unless the config names its own. */
	modelsDir: string;
	stateDbPath: string;
}

export function createSemanticRecall(
	paths: SemanticRecallPaths,
	options: Pick<EmbedderOptions, "loadModule" | "resolveEntry"> = {},
): SemanticRecall | undefined {
	const config = readEmbeddingConfig(paths.configPath);
	const embedder = createEmbedder(config, {
		...options,
		modelsDir: config.modelsDir !== "" ? config.modelsDir : paths.modelsDir,
	});
	if (!embedder) return undefined;
	return { config, embedder, vectors: new VectorStore(paths.stateDbPath) };
}

export default function semanticRecallExtension(_smolt: ExtensionAPI): void {
	const dir = agentDir();
	provideSemanticRecall(
		createSemanticRecall({
			configPath: join(dir, "embeddings.json"),
			modelsDir: join(dir, "models"),
			stateDbPath: join(dir, "state.db"),
		}),
	);
}
