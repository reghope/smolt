import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The local llama.cpp server as a service: found, installed, and started on
 * demand, so picking a local model is enough to end up talking to it.
 *
 * Everything here is about the process, not the models on it: those are the
 * client's business. Detection mirrors the desktop's launcher so the two
 * agree on where llama-server lives and which folder holds the GGUF files.
 */

export type Notify = (message: string, type?: "info" | "warning" | "error") => void;

const exeSuffix = process.platform === "win32" ? ".exe" : "";

/** Every llama-server on this machine: an explicit path, the scoop installs, then PATH. */
export function findLlamaServerBinaries(env: NodeJS.ProcessEnv = process.env): string[] {
	const candidates: string[] = [];
	const configured = env.LLAMA_SERVER_PATH?.trim();
	if (configured) candidates.push(configured);
	// Scoop keeps one app per backend (cu133, vulkan, cpu, ...), and which of
	// them can drive the GPU depends on the driver, so all of them are offered.
	const scoopApps = join(homedir(), "scoop", "apps");
	try {
		for (const entry of readdirSync(scoopApps, { withFileTypes: true })) {
			if (entry.isDirectory() && entry.name.startsWith("llama.cpp")) {
				candidates.push(join(scoopApps, entry.name, "current", `llama-server${exeSuffix}`));
			}
		}
	} catch {
		// No scoop.
	}
	candidates.push(join("/opt", "homebrew", "bin", "llama-server"));
	candidates.push(join("/usr", "local", "bin", "llama-server"));
	candidates.push(
		...(env.PATH ?? "")
			.split(process.platform === "win32" ? ";" : ":")
			.filter((part) => part.trim() !== "")
			.map((part) => join(part.trim(), `llama-server${exeSuffix}`)),
	);
	const seen = new Set<string>();
	return candidates.filter((candidate) => {
		const key = candidate.toLowerCase();
		if (seen.has(key) || !existsSync(candidate)) return false;
		seen.add(key);
		return true;
	});
}

/** The first llama-server on this machine, whatever it can drive. */
export function findLlamaServerBinary(env: NodeJS.ProcessEnv = process.env): string | undefined {
	return findLlamaServerBinaries(env)[0];
}

/**
 * The accelerator devices a llama-server build reports from `--list-devices`.
 * A build whose backend cannot initialise, such as a CUDA build on an older
 * driver, lists none and would run the model on the CPU without a word.
 */
export function parseListedDevices(output: string): string[] {
	const devices: string[] = [];
	let listing = false;
	for (const line of output.split(/\r?\n/u)) {
		if (/^Available devices:/u.test(line)) {
			listing = true;
			continue;
		}
		if (!listing) continue;
		const match = /^\s+([A-Za-z]+\d+):\s*(.*)$/u.exec(line);
		if (match) devices.push(`${match[1]}: ${match[2]}`);
		else if (line.trim() !== "" && !line.trim().startsWith("(none)")) listing = false;
	}
	return devices;
}

const probedDevices = new Map<string, string[]>();

/** What a binary can see, remembered for the life of the process. */
export function llamaServerDevices(binary: string): string[] {
	const cached = probedDevices.get(binary);
	if (cached) return cached;
	let devices: string[] = [];
	try {
		const result = spawnSync(binary, ["--list-devices"], {
			encoding: "utf8",
			timeout: 60_000,
			windowsHide: true,
		});
		devices = parseListedDevices(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
	} catch {
		// Treated as a build with no devices.
	}
	probedDevices.set(binary, devices);
	return devices;
}

/**
 * The llama-server to run: the first build that can see a GPU, or failing
 * that the first build there is. Picking by backend name would not do; the
 * CUDA build is the right one only when the driver is new enough for it.
 */
export function pickLlamaServerBinary(
	env: NodeJS.ProcessEnv = process.env,
): { binary: string; devices: string[] } | undefined {
	const binaries = findLlamaServerBinaries(env);
	for (const binary of binaries) {
		const devices = llamaServerDevices(binary);
		if (devices.length > 0) return { binary, devices };
	}
	return binaries[0] === undefined ? undefined : { binary: binaries[0], devices: [] };
}

export interface LlamaModelsDir {
	dir: string;
	/** How many GGUF models the folder holds. */
	models: number;
	/** A per-model preset file beside the models, when there is one. */
	presets?: string;
	/** True when the folder holds the model that was asked for. */
	hasModel: boolean;
}

function inspectModelsDir(dir: string, modelId: string | undefined): LlamaModelsDir | undefined {
	if (!existsSync(dir)) return undefined;
	let models = 0;
	let hasModel = false;
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const name = entry.name;
			if (entry.isFile() && name.toLowerCase().endsWith(".gguf")) {
				models += 1;
				if (modelId !== undefined && name.slice(0, -".gguf".length) === modelId) hasModel = true;
			}
			if (entry.isDirectory() && existsSync(join(dir, name, "mmproj-F16.gguf"))) {
				models += 1;
				if (modelId !== undefined && name === modelId) hasModel = true;
			}
		}
	} catch {
		return undefined;
	}
	if (models === 0) return undefined;
	const presets = join(dir, "presets.ini");
	return { dir, models, presets: existsSync(presets) ? presets : undefined, hasModel };
}

/** Every place a models folder is looked for, most deliberate first. */
function modelsDirCandidates(env: NodeJS.ProcessEnv): string[] {
	const candidates: string[] = [];
	const configured = env.LLAMA_MODELS_DIR?.trim();
	if (configured) candidates.push(configured);
	candidates.push(join(homedir(), "models"));
	if (process.platform === "win32") {
		// A models folder at the root of another drive: large GGUF files tend
		// to live on whichever disk has the room, not under the profile.
		for (let code = "C".charCodeAt(0); code <= "Z".charCodeAt(0); code++) {
			candidates.push(`${String.fromCharCode(code)}:\\models`);
		}
	}
	candidates.push(join(homedir(), ".cache", "llama.cpp"));
	return candidates;
}

/**
 * The GGUF folder the router should serve. With a model id, the first folder
 * that holds that model wins over one that merely holds models, so a router
 * started for a pick can actually serve it.
 */
export function llamaModelsDir(modelId?: string, env: NodeJS.ProcessEnv = process.env): LlamaModelsDir | undefined {
	let fallback: LlamaModelsDir | undefined;
	for (const candidate of modelsDirCandidates(env)) {
		const found = inspectModelsDir(candidate, modelId);
		if (!found) continue;
		if (found.hasModel) return found;
		fallback ??= found;
	}
	return fallback;
}

export async function llamaServerReachable(serverUrl: string, timeoutMs = 1500): Promise<boolean> {
	try {
		const response = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
		return response.ok;
	} catch {
		return false;
	}
}

function commandExists(command: string): boolean {
	return (process.env.PATH ?? "")
		.split(process.platform === "win32" ? ";" : ":")
		.filter((part) => part.trim() !== "")
		.some((part) => {
			const base = join(part.trim(), command);
			return process.platform === "win32"
				? existsSync(`${base}.exe`) || existsSync(`${base}.cmd`) || existsSync(`${base}.ps1`)
				: existsSync(base);
		});
}

function run(command: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: "ignore", shell: process.platform === "win32", windowsHide: true });
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}`));
		});
	});
}

/**
 * Install llama.cpp with whatever package manager the machine already has.
 * Returns the binary once it is on disk.
 */
export async function installLlamaServer(notify: Notify): Promise<string> {
	if (process.platform === "win32" && commandExists("scoop")) {
		// The Vulkan build: it drives NVIDIA, AMD, and Intel GPUs on whatever
		// driver is installed, where a CUDA build must match the driver.
		notify("Installing llama.cpp with scoop…");
		await run("scoop", ["install", "llama.cpp-vulkan"]);
	} else if (process.platform === "win32" && commandExists("winget")) {
		notify("Installing llama.cpp with winget…");
		await run("winget", [
			"install",
			"--id",
			"ggml.llamacpp",
			"-e",
			"--accept-source-agreements",
			"--accept-package-agreements",
		]);
	} else if ((process.platform === "darwin" || process.platform === "linux") && commandExists("brew")) {
		notify("Installing llama.cpp with Homebrew…");
		await run("brew", ["install", "llama.cpp"]);
	} else {
		throw new Error(
			"llama-server was not found and no package manager can install it. Install llama.cpp from https://github.com/ggml-org/llama.cpp/releases and set LLAMA_SERVER_PATH.",
		);
	}
	const binary = findLlamaServerBinary();
	if (!binary) throw new Error("llama.cpp was installed but llama-server is still not on the PATH.");
	return binary;
}

function parseHostPort(serverUrl: string): { host: string; port: number } {
	const url = new URL(serverUrl);
	return { host: url.hostname || "127.0.0.1", port: Number(url.port || 8080) };
}

/** The llama-server command line for a router over a models folder. */
export function llamaServerArgs(models: LlamaModelsDir, serverUrl: string): string[] {
	const { host, port } = parseHostPort(serverUrl);
	const args = ["--models-dir", models.dir];
	args.push("--jinja", "--host", host, "--port", String(port), "-ngl", "999");
	// A context size on the command line wins over the per-model preset, so a
	// preset file beside the models is left to set it: the 32k default here is
	// only for folders that have no say of their own.
	if (models.presets) args.push("--models-preset", models.presets);
	else args.push("-c", "32768");
	return args;
}

/** Start llama-server in router mode over the models folder and wait until it answers. */
export async function startLlamaServer(options: {
	binary: string;
	models: LlamaModelsDir;
	serverUrl: string;
	timeoutMs?: number;
}): Promise<void> {
	const child = spawn(options.binary, llamaServerArgs(options.models, options.serverUrl), {
		detached: true,
		stdio: "ignore",
		windowsHide: true,
	});
	child.unref();
	const deadline = Date.now() + (options.timeoutMs ?? 30_000);
	while (Date.now() < deadline) {
		if (await llamaServerReachable(options.serverUrl)) return;
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(`llama-server started but did not answer on ${options.serverUrl} within 30 seconds.`);
}

function isLocal(serverUrl: string): boolean {
	const host = new URL(serverUrl).hostname;
	return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "0.0.0.0";
}

/**
 * Make sure the configured server answers: already up, or installed and
 * started here. Only a local URL is ever started; a remote one is someone
 * else's to run. With a model id, the router is started over the folder
 * that holds that model.
 */
export async function ensureLlamaServer(serverUrl: string, notify: Notify, modelId?: string): Promise<void> {
	if (await llamaServerReachable(serverUrl)) return;
	if (!isLocal(serverUrl)) throw new Error(`Could not reach the llama.cpp server at ${serverUrl}.`);
	const picked = pickLlamaServerBinary() ?? { binary: await installLlamaServer(notify), devices: [] };
	const binary = picked.binary;
	if (picked.devices.length === 0) {
		notify(
			`${binary} cannot see a GPU: the model will run on the CPU. Install a llama.cpp build that matches the driver.`,
			"warning",
		);
	}
	const models = llamaModelsDir(modelId);
	if (!models) {
		throw new Error(
			`No GGUF models were found in ${process.env.LLAMA_MODELS_DIR?.trim() || join(homedir(), "models")}. Download one with /llama first, or set LLAMA_MODELS_DIR.`,
		);
	}
	if (modelId !== undefined && !models.hasModel) {
		throw new Error(`${modelId} is not in ${models.dir}. Set LLAMA_MODELS_DIR to the folder that holds it.`);
	}
	const device = picked.devices[0] === undefined ? "" : ` on ${picked.devices[0]}`;
	notify(`Starting llama-server on ${serverUrl} over ${models.dir}${device}…`);
	await startLlamaServer({ binary, models, serverUrl });
}
