import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { build } from "esbuild";

mkdirSync("dist", { recursive: true });

// Main process: CommonJS (Electron main), external electron + the agent
// package (resolved from node_modules at runtime so the CLI subprocess and
// types stay in sync with the workspace build).
//
// The speech stack stays external too: it loads a native .node binding that
// esbuild cannot inline, and it is imported lazily so nothing is paid for it
// until someone dictates.
const speechExternals = ["@huggingface/transformers", "onnxruntime-node", "onnxruntime-web", "sharp"];
await build({
	entryPoints: ["src/main/main.ts"],
	bundle: true,
	platform: "node",
	format: "cjs",
	outfile: "dist/main.cjs",
	external: ["electron", ...speechExternals],
	sourcemap: true,
});

await build({
	entryPoints: ["src/preload.ts"],
	bundle: true,
	platform: "node",
	format: "cjs",
	outfile: "dist/preload.cjs",
	external: ["electron"],
	sourcemap: true,
});

await build({
	entryPoints: ["src/renderer/main.tsx"],
	bundle: true,
	platform: "browser",
	format: "iife",
	outfile: "dist/renderer.js",
	jsx: "automatic",
	sourcemap: true,
});

// Tailwind compiles the theme + used utilities into one static stylesheet,
// which the page's CSP (style-src 'self') then loads like any other file.
const require = createRequire(import.meta.url);
const tailwindBin = require.resolve("@tailwindcss/cli/package.json").replace(/package\.json$/, "dist/index.mjs");
const tailwind = spawnSync(
	process.execPath,
	[tailwindBin, "-i", "src/renderer/app.css", "-o", "dist/styles.css", "--minify"],
	{ stdio: "inherit" },
);
if (tailwind.status !== 0) process.exit(tailwind.status ?? 1);

copyFileSync("src/renderer/index.html", "dist/index.html");
console.log("desktop build complete");
