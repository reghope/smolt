import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";

/**
 * Where the agent finds transformers.js.
 *
 * The app already ships the library for dictation, and the agents it spawns
 * embed past sessions with the same one; the CLI package does not carry it
 * (it is a few hundred megabytes of native runtime). So the app resolves its
 * own copy and names it to each agent in `SMOLT_EMBEDDINGS_MODULE`.
 *
 * Packaged, the package sits inside app.asar, which a child process cannot
 * import from; electron-builder unpacks it beside the archive, and that is
 * the path handed over.
 */

export function unpackedPath(path: string): string {
	return path.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`);
}

export function transformersEntry(): string | undefined {
	try {
		// The package exports no package.json; its CommonJS entry resolves to
		// the dist folder, and the ESM entry the agent imports sits beside it.
		const require = createRequire(__filename);
		const entry = unpackedPath(join(dirname(require.resolve("@huggingface/transformers")), "transformers.node.mjs"));
		return existsSync(entry) ? entry : undefined;
	} catch {
		return undefined;
	}
}
