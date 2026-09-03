import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { isModelCached, modelCacheDir, speechStatus, transcribeSamples } from "../src/main/speech.ts";

/**
 * Local dictation: where the model lives and how its absence is reported.
 *
 * The weights are not shipped, so the first use downloads them. These cover
 * the cheap, deterministic half — the cache location and the status the
 * window reads to decide whether to say "fetching" — without pulling the weights
 * over the network in a unit test.
 */

let previous: string | undefined;
let dir: string;

beforeEach(() => {
	previous = process.env.SMOLT_CODING_AGENT_DIR;
	dir = mkdtempSync(join(tmpdir(), "smolt-speech-"));
	process.env.SMOLT_CODING_AGENT_DIR = dir;
});

afterEach(() => {
	if (previous === undefined) delete process.env.SMOLT_CODING_AGENT_DIR;
	else process.env.SMOLT_CODING_AGENT_DIR = previous;
	rmSync(dir, { recursive: true, force: true });
});

describe("modelCacheDir", () => {
	test("keeps the weights beside the rest of smolt's state", () => {
		expect(modelCacheDir()).toBe(join(dir, "models"));
	});

	test("follows the agent directory when it moves", () => {
		process.env.SMOLT_CODING_AGENT_DIR = join(dir, "elsewhere");
		expect(modelCacheDir()).toBe(join(dir, "elsewhere", "models"));
	});
});

describe("isModelCached", () => {
	test("is false before anything has been downloaded", () => {
		expect(isModelCached()).toBe(false);
	});

	test("is true once the model's folder exists", () => {
		mkdirSync(join(modelCacheDir(), "onnx-community", "moonshine-base-ONNX"), { recursive: true });
		expect(isModelCached()).toBe(true);
	});
});

describe("speechStatus", () => {
	test("reports a model that has not been fetched, so the window can say so", () => {
		const status = speechStatus();
		expect(status.ready).toBe(false);
		expect(status.downloading).toBe(false);
		expect(status.modelId).toContain("moonshine");
		expect(status.cacheDir).toBe(modelCacheDir());
	});

	test("reports ready once the weights are on disk", () => {
		mkdirSync(join(modelCacheDir(), "onnx-community", "moonshine-base-ONNX"), { recursive: true });
		expect(speechStatus().ready).toBe(true);
	});
});

describe("transcribeSamples", () => {
	test("returns nothing for silence of no length, without loading a model", async () => {
		// Guards the common case of stopping before saying anything: it must
		// not download the weights to tell you that you said nothing.
		await expect(transcribeSamples(new Float32Array(0))).resolves.toBe("");
	});
});
