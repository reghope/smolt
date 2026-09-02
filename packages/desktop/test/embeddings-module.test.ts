import { existsSync } from "node:fs";
import { sep } from "node:path";
import { describe, expect, test } from "vitest";
import { transformersEntry, unpackedPath } from "../src/main/embeddings-module.ts";

describe("transformers module for the agents", () => {
	test("resolves the copy the app ships, as an existing entry file", () => {
		const entry = transformersEntry();
		expect(entry).toBeDefined();
		expect(entry?.endsWith(`${sep}dist${sep}transformers.node.mjs`)).toBe(true);
		expect(existsSync(entry as string)).toBe(true);
	});

	test("points inside the unpacked archive once packaged", () => {
		const packed = ["", "app", "resources", "app.asar", "node_modules", "x.mjs"].join(sep);
		expect(unpackedPath(packed)).toBe(
			["", "app", "resources", "app.asar.unpacked", "node_modules", "x.mjs"].join(sep),
		);
		const plain = ["", "workspace", "node_modules", "x.mjs"].join(sep);
		expect(unpackedPath(plain)).toBe(plain);
	});
});
