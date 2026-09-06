import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelThinkingLevel } from "@smolt/ai";
import { parse as parseYaml } from "yaml";

const CONFIG_DIR_NAME = ".smolt";

function getAgentDir(): string {
	const envDir = process.env.SMOLT_CODING_AGENT_DIR;
	if (envDir) {
		return envDir.startsWith("~") ? path.join(os.homedir(), envDir.slice(1)) : envDir;
	}
	return path.join(os.homedir(), CONFIG_DIR_NAME, "agent");
}

/** Settings from advisor.json (user agent dir, then project .smolt overrides). */
export interface AdvisorSettings {
	enabled?: boolean;
	model?: string;
	immuneTurns?: number;
	syncBacklog?: "off" | 1 | 3 | 5;
	/** In-progress reviews happen every this many primary steps; the settled review always happens. Default 6. */
	reviewEvery?: number;
	/**
	 * Review depth. "deep" is the default: the usual review with the configured
	 * thinking level and tool grants. "quick" is a deliberately shallow pass on
	 * what is going on: no thinking, a tiny reply cap, no investigative tools,
	 * and in-progress reviews only on busier stretches.
	 */
	mode?: "quick" | "deep";
	/**
	 * Session token budget for the advisor: reviews stop once the advisors have
	 * spent this many tokens (input + output + cache read/write) in total.
	 * Undefined means no budget.
	 */
	tokenBudget?: number;
	/**
	 * Thinking level for a review. Output tokens are the bulk of what an advisor
	 * costs and the usual review is the word "ok", so the default is "minimal".
	 */
	thinking?: ModelThinkingLevel;
}

/** One roster entry from WATCHDOG.yml, or the synthesized default advisor. */
export interface AdvisorSpec {
	name: string;
	slug: string;
	enabled: boolean;
	model?: string;
	/** Granted investigative tool names. Undefined means the default: none, advise only. */
	tools?: string[];
	instructions?: string;
}

export interface AdvisorRosterConfig {
	settings: AdvisorSettings;
	/** Shared instructions from all WATCHDOG.yml files, concatenated. */
	sharedInstructions: string[];
	/** WATCHDOG.md guidance blocks, user-level first, then ancestors down toward cwd. */
	watchdogBlocks: string[];
	advisors: AdvisorSpec[];
}

/**
 * No investigative tools unless a roster grants them: every call an
 * investigation makes is another request carrying the whole conversation,
 * which made a review three or four requests where one will do.
 */
export const DEFAULT_ADVISOR_TOOLS: string[] = [];
/** What a roster entry gets when it names tools but none of them is grantable. */
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const THINKING_LEVELS = new Set<string>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const GRANTABLE_TOOLS = new Set(["read", "grep", "find", "ls", "bash", "powershell", "edit", "write"]);
const TOOL_ALIASES: Record<string, string> = { glob: "find", search: "grep" };

export function slugify(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "advisor"
	);
}

function readFileIfExists(file: string): string | undefined {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

/** Directories from cwd up to the git repository root (or home when no repo), nearest first. */
function projectDirs(cwd: string): string[] {
	const dirs: string[] = [];
	const home = os.homedir();
	let dir = path.resolve(cwd);
	for (;;) {
		dirs.push(dir);
		if (fs.existsSync(path.join(dir, ".git"))) break;
		const parent = path.dirname(dir);
		if (parent === dir || dir === home) break;
		dir = parent;
	}
	return dirs;
}

/** The user-level advisor.json, where settings pages write. */
export function advisorSettingsFile(): string {
	return path.join(getAgentDir(), "advisor.json");
}

/** Effective settings: the user-level advisor.json, then the project's overrides. */
export function loadAdvisorSettings(cwd: string): AdvisorSettings {
	const settings: AdvisorSettings = {};
	const candidates = [advisorSettingsFile(), path.join(cwd, CONFIG_DIR_NAME, "advisor.json")];
	for (const file of candidates) {
		const raw = readFileIfExists(file);
		if (!raw) continue;
		try {
			const parsed = JSON.parse(raw) as AdvisorSettings;
			if (typeof parsed.enabled === "boolean") settings.enabled = parsed.enabled;
			if (typeof parsed.model === "string") settings.model = parsed.model;
			if (typeof parsed.immuneTurns === "number") settings.immuneTurns = parsed.immuneTurns;
			if (typeof parsed.thinking === "string" && THINKING_LEVELS.has(parsed.thinking)) {
				settings.thinking = parsed.thinking;
			}
			if (typeof parsed.reviewEvery === "number" && parsed.reviewEvery >= 1) {
				settings.reviewEvery = Math.floor(parsed.reviewEvery);
			}
			if (parsed.mode === "quick" || parsed.mode === "deep") settings.mode = parsed.mode;
			if (typeof parsed.tokenBudget === "number" && parsed.tokenBudget > 0) {
				settings.tokenBudget = Math.floor(parsed.tokenBudget);
			}
			if (
				parsed.syncBacklog === "off" ||
				parsed.syncBacklog === 1 ||
				parsed.syncBacklog === 3 ||
				parsed.syncBacklog === 5
			) {
				settings.syncBacklog = parsed.syncBacklog;
			}
		} catch {
			// malformed settings file: ignore rather than break the session
		}
	}
	return settings;
}

/**
 * Set or clear the advisor model in the user-level advisor.json, keeping the
 * file's other fields. Undefined means the advisor follows the session model.
 */
export function writeAdvisorModel(model: string | undefined): void {
	const file = advisorSettingsFile();
	let current: Record<string, unknown> = {};
	const raw = readFileIfExists(file);
	if (raw) {
		try {
			const parsed: unknown = JSON.parse(raw);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
				current = parsed as Record<string, unknown>;
		} catch {
			// malformed file: rewrite it with what we know
		}
	}
	if (model) current.model = model;
	else delete current.model;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`, "utf8");
}

/** Set the advisor mode in the user-level advisor.json, keeping the file's other fields. */
export function writeAdvisorMode(mode: "quick" | "deep"): void {
	const file = advisorSettingsFile();
	const current = readAdvisorSettingsObject(file);
	current.mode = mode;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`, "utf8");
}

/** Set or clear the advisor token budget in the user-level advisor.json. Undefined clears it. */
export function writeAdvisorTokenBudget(budget: number | undefined): void {
	const file = advisorSettingsFile();
	const current = readAdvisorSettingsObject(file);
	if (budget === undefined) delete current.tokenBudget;
	else current.tokenBudget = budget;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`, "utf8");
}

/** A change to the user-level advisor.json. Fields left out stay; null clears a field. */
export interface AdvisorSettingsUpdate {
	enabled?: boolean;
	model?: string | null;
	mode?: "quick" | "deep";
	reviewEvery?: number;
	thinking?: ModelThinkingLevel;
	tokenBudget?: number | null;
	immuneTurns?: number;
	syncBacklog?: "off" | 1 | 3 | 5;
}

/**
 * Apply a change to the user-level advisor.json, keeping the file's other
 * fields. This is what the desktop's settings page writes through; a
 * running chat reads the file again at its next turn and review.
 */
export function writeAdvisorSettings(update: AdvisorSettingsUpdate): void {
	const file = advisorSettingsFile();
	const current = readAdvisorSettingsObject(file);
	if (update.enabled !== undefined) current.enabled = update.enabled;
	if (update.model !== undefined) {
		if (update.model === null || update.model === "") delete current.model;
		else current.model = update.model;
	}
	if (update.mode !== undefined) current.mode = update.mode;
	if (update.reviewEvery !== undefined) current.reviewEvery = Math.max(1, Math.floor(update.reviewEvery));
	if (update.thinking !== undefined && THINKING_LEVELS.has(update.thinking)) current.thinking = update.thinking;
	if (update.tokenBudget !== undefined) {
		if (update.tokenBudget === null || update.tokenBudget <= 0) delete current.tokenBudget;
		else current.tokenBudget = Math.floor(update.tokenBudget);
	}
	if (update.immuneTurns !== undefined) current.immuneTurns = Math.max(0, Math.floor(update.immuneTurns));
	if (update.syncBacklog !== undefined) current.syncBacklog = update.syncBacklog;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`, "utf8");
}

function readAdvisorSettingsObject(file: string): Record<string, unknown> {
	const raw = readFileIfExists(file);
	if (!raw) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
	} catch {
		// malformed file: rewrite it with what we know
	}
	return {};
}

/** WATCHDOG.md blocks: user level first, then project ancestors down toward cwd. */
function loadWatchdogMarkdown(cwd: string): string[] {
	const blocks: string[] = [];
	const userFile = readFileIfExists(path.join(getAgentDir(), "WATCHDOG.md"));
	if (userFile?.trim()) blocks.push(userFile.trim());
	const dirs = projectDirs(cwd).reverse(); // farthest ancestor first
	for (const dir of dirs) {
		for (const candidate of [path.join(dir, "WATCHDOG.md"), path.join(dir, CONFIG_DIR_NAME, "WATCHDOG.md")]) {
			const content = readFileIfExists(candidate);
			if (content?.trim()) blocks.push(content.trim());
		}
	}
	return blocks;
}

interface RawRosterEntry {
	name?: unknown;
	enabled?: unknown;
	model?: unknown;
	tools?: unknown;
	instructions?: unknown;
}

interface RawRoster {
	instructions?: unknown;
	advisors?: unknown;
}

export function normalizeToolGrant(tools: unknown): string[] | undefined {
	if (!Array.isArray(tools)) return undefined;
	if (tools.length === 0) return [];
	const granted: string[] = [];
	for (const raw of tools) {
		if (typeof raw !== "string") continue;
		const name = TOOL_ALIASES[raw] ?? raw;
		if (GRANTABLE_TOOLS.has(name) && !granted.includes(name)) granted.push(name);
	}
	// A nonempty input with no valid names meant to grant something: the read-only set.
	return granted.length > 0 ? granted : READ_ONLY_TOOLS;
}

function parseRosterFile(raw: string): { shared?: string; advisors: AdvisorSpec[] } | undefined {
	let parsed: RawRoster;
	try {
		parsed = parseYaml(raw) as RawRoster;
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object") return undefined;
	const advisors: AdvisorSpec[] = [];
	if (Array.isArray(parsed.advisors)) {
		for (const entry of parsed.advisors as RawRosterEntry[]) {
			if (!entry || typeof entry !== "object" || typeof entry.name !== "string" || !entry.name.trim()) continue;
			advisors.push({
				name: entry.name.trim(),
				slug: slugify(entry.name),
				enabled: entry.enabled !== false,
				model: typeof entry.model === "string" ? entry.model : undefined,
				tools: normalizeToolGrant(entry.tools),
				instructions: typeof entry.instructions === "string" ? entry.instructions : undefined,
			});
		}
	}
	return {
		shared: typeof parsed.instructions === "string" ? parsed.instructions : undefined,
		advisors,
	};
}

/**
 * Load WATCHDOG.yml rosters. A more specific file (project leaf > ancestor > user)
 * replaces an earlier entry with the same slug.
 */
function loadRoster(cwd: string): { shared: string[]; advisors: AdvisorSpec[] } {
	const shared: string[] = [];
	const bySlug = new Map<string, AdvisorSpec>();
	const files: string[] = [];
	for (const ext of ["yml", "yaml"]) files.push(path.join(getAgentDir(), `WATCHDOG.${ext}`));
	for (const dir of projectDirs(cwd).reverse()) {
		for (const ext of ["yml", "yaml"]) {
			files.push(path.join(dir, `WATCHDOG.${ext}`), path.join(dir, CONFIG_DIR_NAME, `WATCHDOG.${ext}`));
		}
	}
	for (const file of files) {
		const raw = readFileIfExists(file);
		if (!raw) continue;
		const roster = parseRosterFile(raw);
		if (!roster) continue;
		if (roster.shared?.trim()) shared.push(roster.shared.trim());
		for (const advisor of roster.advisors) bySlug.set(advisor.slug, advisor);
	}
	return { shared, advisors: [...bySlug.values()] };
}

export function loadAdvisorConfig(cwd: string): AdvisorRosterConfig {
	const settings = loadAdvisorSettings(cwd);
	const roster = loadRoster(cwd);
	const advisors =
		roster.advisors.length > 0
			? roster.advisors
			: [{ name: "Advisor", slug: "advisor", enabled: true } satisfies AdvisorSpec];
	return {
		settings,
		sharedInstructions: roster.shared,
		watchdogBlocks: loadWatchdogMarkdown(cwd),
		advisors,
	};
}
