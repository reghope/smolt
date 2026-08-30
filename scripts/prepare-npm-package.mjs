// Stage the publishable "smolt" package into packages/coding-agent/dist-npm/.
//
// The workspace builds a self-contained bundle (dist/bundle) whose only
// external npm dependency is @silvia-odwyer/photon-node — enforced by
// build-coding-agent-bundle.mjs. Publishing that bundle alone means the
// internal workspace packages never need to exist on the registry.
//
// Usage:  node scripts/prepare-npm-package.mjs
// Then:   cd packages/coding-agent/dist-npm && npm publish

import fs, { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = join(repoRoot, "packages", "coding-agent");
const outDir = join(pkgDir, "dist-npm");

const source = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8"));

if (!existsSync(join(pkgDir, "dist", "bundle", "cli.js"))) {
	console.error("dist/bundle/cli.js missing — run the coding-agent build first (npm run build).");
	process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// Minimal payload: the self-contained bundle plus the non-code runtime
// assets it reads from the unbundled dist tree (themes and friends). The
// compiled workspace JS is dead weight for a CLI-only package.
cpSync(join(pkgDir, "dist", "bundle"), join(outDir, "dist", "bundle"), { recursive: true });
cpSync(join(pkgDir, "dist"), join(outDir, "dist"), {
	recursive: true,
	filter: (src) => {
		if (src.includes("dist-npm") || src.includes(String.raw`distundle`) || src.includes("dist/bundle")) return false;
		const stat = fs.statSync(src, { throwIfNoEntry: false });
		if (stat?.isDirectory()) return true;
		return !/.(js|mjs|cjs|d.ts|map)$/.test(src);
	},
});
cpSync(join(pkgDir, "README.npm.md"), join(outDir, "README.md"));
cpSync(join(repoRoot, "LICENSE"), join(outDir, "LICENSE"));

const photonVersion = source.dependencies["@silvia-odwyer/photon-node"];
if (!photonVersion) {
	console.error("Expected @silvia-odwyer/photon-node in coding-agent dependencies.");
	process.exit(1);
}

const manifest = {
	name: process.env.SMOLT_PUBLISH_NAME || "@smolt/cli",
	version: source.version,
	description: source.description,
	license: source.license ?? "MIT",
	author: source.author,
	repository: source.repository,
	homepage: source.homepage,
	bugs: source.bugs,
	keywords: ["coding-agent", "cli", "ai", "agent", "memory"],
	type: "module",
	bin: { smolt: "dist/bundle/cli.js" },
	engines: source.engines,
	// The bundle's single external runtime dependency (wasm image codec).
	dependencies: { "@silvia-odwyer/photon-node": photonVersion },
};

writeFileSync(join(outDir, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);

console.log(`Staged ${manifest.name}@${manifest.version} in packages/coding-agent/dist-npm/`);
console.log("Publish with: cd packages/coding-agent/dist-npm && npm publish --access=public");
