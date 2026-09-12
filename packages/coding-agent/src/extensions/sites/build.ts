import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnProcess, waitForChildProcess } from "../../utils/child-process.ts";

/**
 * Turning a working directory into the file list a publish uploads.
 *
 * A Vite project builds to `dist/` and that is what goes live; a directory
 * with nothing to build — an `index.html` and its assets — is uploaded as it
 * is. The limits are the host's own, checked here so a build that would be
 * refused is refused with a reason before a single byte is sent.
 */

/** The site host's limits for one published build. */
export const LIMITS = {
	files: 250,
	fileBytes: 8 * 1024 * 1024,
	totalBytes: 30 * 1024 * 1024,
} as const;

export interface SiteFile {
	path: string;
	bytes: Uint8Array;
}

/** Directories that are never part of a site, whichever layout is in use. */
const SKIPPED_DIRS = new Set(["node_modules", ".git", ".smolt", ".vite", ".cache"]);

/** Files that must never leave the machine, or would only be noise on a site. */
function skippedFile(name: string): boolean {
	return name.startsWith(".env") || name === ".DS_Store" || name === "Thumbs.db";
}

function walk(root: string, dir: string, out: string[]): void {
	for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.isDirectory()) {
			if (!SKIPPED_DIRS.has(entry.name)) walk(root, join(dir, entry.name), out);
			continue;
		}
		if (!entry.isFile() || skippedFile(entry.name)) continue;
		out.push(relative(root, join(dir, entry.name)).split("\\").join("/"));
	}
}

/**
 * Every file under `dir` as an upload list, or why it cannot be one.
 *
 * `index.html` at the root is mandatory: the host refuses a build without it,
 * and a site without a front page is not a site.
 */
export function collectSite(dir: string): { files: SiteFile[] } | { error: string } {
	if (!existsSync(dir) || !statSync(dir).isDirectory()) return { error: `${dir} is not a directory.` };
	const paths: string[] = [];
	walk(dir, dir, paths);
	if (!paths.includes("index.html")) return { error: `No index.html in ${dir}; a site needs a front page.` };
	if (paths.length > LIMITS.files) {
		return { error: `${paths.length} files, but a site can have at most ${LIMITS.files}.` };
	}
	const files: SiteFile[] = [];
	let total = 0;
	for (const path of paths) {
		const bytes = new Uint8Array(readFileSync(join(dir, path)));
		if (bytes.byteLength > LIMITS.fileBytes) {
			return {
				error: `${path} is ${formatBytes(bytes.byteLength)}; one file can be at most ${formatBytes(LIMITS.fileBytes)}.`,
			};
		}
		total += bytes.byteLength;
		files.push({ path, bytes });
	}
	if (total > LIMITS.totalBytes) {
		return { error: `The site is ${formatBytes(total)}; the limit is ${formatBytes(LIMITS.totalBytes)}.` };
	}
	return { files };
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What a working directory is: something to build, or something to serve as is. */
export type SiteLayout = { kind: "vite"; outDir: string } | { kind: "static"; dir: string } | { kind: "none" };

/**
 * Read the directory's shape from what is in it.
 *
 * A `package.json` with a build script is a project whose output is `dist/`.
 * Without one, an `index.html` at the top makes it a static site. Anything
 * else has nothing to publish yet.
 */
export function detectLayout(cwd: string): SiteLayout {
	const pkgPath = join(cwd, "package.json");
	if (existsSync(pkgPath)) {
		try {
			const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { scripts?: Record<string, string> };
			if (typeof pkg.scripts?.build === "string") return { kind: "vite", outDir: join(cwd, "dist") };
		} catch {
			// An unreadable package.json is treated like none: the build script is
			// what matters, and it cannot be found.
		}
	}
	if (existsSync(join(cwd, "index.html"))) return { kind: "static", dir: cwd };
	return { kind: "none" };
}

export type BuildRunner = (command: string, args: string[], cwd: string) => Promise<{ code: number; output: string }>;

/** Run a command to completion, output interleaved as the terminal would show it. */
export const runCommand: BuildRunner = (command, args, cwd) =>
	new Promise((resolve) => {
		const child = spawnProcess(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		child.on("error", (error) => resolve({ code: 1, output: `${output}${error.message}` }));
		waitForChildProcess(child).then((code) => resolve({ code: code ?? 1, output }));
	});

/** The last lines of a build log: enough to see the error, not the whole scroll. */
function tail(output: string, lines = 30): string {
	const all = output.trim().split(/\r?\n/);
	return all.slice(-lines).join("\n");
}

/**
 * Produce the directory to upload: build the project when there is one,
 * otherwise point at the static files. Dependencies are installed first when
 * they are missing, because a fresh checkout cannot build without them.
 */
export async function prepareSite(
	cwd: string,
	run: BuildRunner = runCommand,
): Promise<{ dir: string; log?: string } | { error: string }> {
	const layout = detectLayout(cwd);
	if (layout.kind === "none") {
		return { error: "Nothing to publish here: no package.json with a build script and no index.html." };
	}
	if (layout.kind === "static") return { dir: layout.dir };
	if (!existsSync(join(cwd, "node_modules"))) {
		const install = await run("npm", ["install", "--no-audit", "--no-fund"], cwd);
		if (install.code !== 0) return { error: `npm install failed:\n${tail(install.output)}` };
	}
	const build = await run("npm", ["run", "build"], cwd);
	if (build.code !== 0) return { error: `The build failed:\n${tail(build.output)}` };
	if (!existsSync(layout.outDir)) return { error: `The build finished but produced no ${layout.outDir}.` };
	return { dir: layout.outDir, log: tail(build.output, 8) };
}
