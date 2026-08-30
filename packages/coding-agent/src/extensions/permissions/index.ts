import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "../../core/extensions/types.ts";

/**
 * Permission modes: how much the agent may change without being asked.
 *
 * Enforced on the `tool_call` event, which can block a call outright, so a
 * mode is a real constraint rather than a label — in `plan` the model cannot
 * write, edit, or run a shell no matter what it decides to do.
 *
 * The mode lives in a small file under the agent directory instead of session
 * state, so a GUI or another process can change it mid-session and the next
 * tool call sees the new value.
 *
 * Modes that ask rather than decide need an answer from whoever is watching.
 * The agent runs as its own process, so the question goes through a directory
 * both sides can see: this writes a request file and waits for a reply file
 * beside it. A front end that never answers is the same as no front end, so
 * the wait times out into a refusal rather than hanging the turn forever.
 */

export type PermissionMode = "manual" | "acceptEdits" | "auto" | "bypass" | "plan";

export const PERMISSION_MODES: readonly PermissionMode[] = ["manual", "acceptEdits", "auto", "bypass", "plan"];

/**
 * Commands that destroy work rather than change it.
 *
 * This is what separates auto from bypass: auto runs everything without
 * asking except these, which are the handful where a wrong call cannot be
 * undone — wiping a tree, rewriting published history, overwriting a disk.
 * The list is deliberately short and specific, because a guard that fires on
 * ordinary work would train you to wave it through.
 */
const DESTRUCTIVE_PATTERNS: { pattern: RegExp; why: string }[] = [
	{
		pattern: /\brm\s+(-[a-z]*\s+)*-[a-z]*[rR][a-z]*f|\brm\s+(-[a-z]*\s+)*-[a-z]*f[a-z]*[rR]/,
		why: "a recursive force delete",
	},
	{ pattern: /\bgit\s+push\b[^\n]*\s(--force|-f)\b/, why: "a force push" },
	{ pattern: /\bgit\s+reset\b[^\n]*--hard\b/, why: "a hard reset, which discards uncommitted work" },
	{ pattern: /\bgit\s+clean\b[^\n]*-[a-z]*f/, why: "deleting untracked files" },
	{ pattern: /\bmkfs(\.[a-z0-9]+)?\b/, why: "formatting a filesystem" },
	{ pattern: /\bdd\b[^\n]*\bof=\/dev\//, why: "writing directly to a device" },
	{ pattern: /\bdrop\s+(database|table|schema)\b/i, why: "dropping a database object" },
	{ pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, why: "a fork bomb" },
	{ pattern: /\bchmod\b[^\n]*-[a-z]*R[^\n]*\s777\s+\//, why: "opening permissions on a root path" },
	{ pattern: /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(ba)?sh\b/, why: "piping a downloaded script into a shell" },
	{ pattern: /\b(shutdown|reboot|halt)\b/, why: "shutting the machine down" },
	{ pattern: /Remove-Item[^\n]*-Recurse[^\n]*-Force/i, why: "a recursive force delete" },
	{ pattern: /\bformat\s+[a-z]:/i, why: "formatting a drive" },
	{ pattern: /\bdel\b[^\n]*\/s\b[^\n]*\/q\b/i, why: "a recursive quiet delete" },
];

/** The reason a command looks destructive, or undefined when it does not. */
export function destructiveReason(command: string): string | undefined {
	for (const { pattern, why } of DESTRUCTIVE_PATTERNS) {
		if (pattern.test(command)) return why;
	}
	return undefined;
}

/** The command text a shell tool was called with, if any. */
export function commandOf(input: unknown): string {
	const args = (input ?? {}) as Record<string, unknown>;
	const command = args.command ?? args.script;
	return typeof command === "string" ? command : "";
}

/** What a mode wants to happen before a tool runs. */
export type Decision = "allow" | "ask" | "block";

/** How a request was answered. */
export type Answer = "allow" | "always" | "deny";

/** Tools that write to files but touch nothing else. */
const EDIT_TOOLS = new Set(["write", "edit", "multi_edit", "notebook_edit"]);
/** Tools that run arbitrary commands on the machine. */
const SHELL_TOOLS = new Set(["bash", "powershell"]);
/** Tools that can change something outside the conversation. */
const MUTATING_TOOLS = new Set([...EDIT_TOOLS, ...SHELL_TOOLS]);

const CONFIG_DIR_NAME = ".smolt";
/** How long a pending request waits for an answer before refusing. */
export const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 120;

export function agentDir(): string {
	const envDir = process.env.SMOLT_CODING_AGENT_DIR;
	if (envDir?.trim()) return envDir.startsWith("~") ? join(homedir(), envDir.slice(1)) : envDir;
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

export function permissionModePath(): string {
	return join(agentDir(), "permission-mode");
}

/** Where pending questions and their answers live. */
export function requestsDir(): string {
	return join(agentDir(), "permission-requests");
}

export function readPermissionMode(path = permissionModePath()): PermissionMode {
	try {
		const raw = readFileSync(path, "utf-8").trim();
		return (PERMISSION_MODES as readonly string[]).includes(raw) ? (raw as PermissionMode) : "auto";
	} catch {
		return "auto";
	}
}

export function writePermissionMode(mode: PermissionMode, path = permissionModePath()): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, mode, "utf-8");
}

/** What a mode wants to do about one tool, before anyone is asked. */
export function decide(mode: PermissionMode, toolName: string, input?: unknown): Decision {
	// Bypass is the only mode that checks nothing at all.
	if (mode === "bypass") return "allow";
	if (mode === "auto") {
		// Auto runs everything unasked except what cannot be undone.
		if (!SHELL_TOOLS.has(toolName)) return "allow";
		return destructiveReason(commandOf(input)) ? "ask" : "allow";
	}
	if (!MUTATING_TOOLS.has(toolName)) return "allow";
	if (mode === "plan") return "block";
	if (mode === "acceptEdits") return SHELL_TOOLS.has(toolName) ? "ask" : "allow";
	return "ask";
}

/** Kept for callers that only need the yes/no of a non-asking mode. */
export function isToolAllowed(mode: PermissionMode, toolName: string): boolean {
	return decide(mode, toolName) === "allow";
}

export function blockReason(mode: PermissionMode, toolName: string): string {
	if (mode === "acceptEdits") {
		return (
			`Accept-edits mode is on, so ${toolName} needs approval and none came. File edits apply without ` +
			`asking; commands do not. Say what you would run and wait, or ask the user to switch to auto.`
		);
	}
	if (mode === "bypass") {
		return `${toolName} was declined.`;
	}
	if (mode === "manual") {
		return (
			`Manual mode is on, so ${toolName} needs approval and none came. Describe what you were about to ` +
			`do and wait for the user rather than trying another way around it.`
		);
	}
	return (
		`Plan mode is on, so ${toolName} is not available. Investigate with read, grep, find, and ls, ` +
		`then describe what you would change and wait — the user switches to auto when they want it applied.`
	);
}

export function deniedReason(toolName: string): string {
	return (
		`The user declined ${toolName}. Do not retry it or reach for another tool to accomplish the same ` +
		`thing; ask what they would like instead.`
	);
}

export interface PermissionRequest {
	id: string;
	tool: string;
	/** A short, readable form of what the call would do. */
	summary: string;
	mode: PermissionMode;
	/** Why this looks destructive, when it does; drives a louder prompt. */
	danger?: string;
	createdAt: number;
}

/** A compact one-line description of a call, for the approval card. */
export function summarise(toolName: string, input: unknown): string {
	const args = (input ?? {}) as Record<string, unknown>;
	const first = args.command ?? args.file_path ?? args.path ?? args.pattern ?? args.query;
	const text = typeof first === "string" ? first : "";
	const trimmed = text.replace(/\s+/g, " ").trim();
	if (trimmed === "") return toolName;
	return trimmed.length > 160 ? `${trimmed.slice(0, 159)}…` : trimmed;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function readAnswer(replyPath: string): Answer | undefined {
	try {
		const raw = readFileSync(replyPath, "utf-8").trim();
		return raw === "allow" || raw === "always" || raw === "deny" ? raw : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Post a question and wait for the answer, cleaning up either way so a
 * refused or abandoned request never lingers to confuse the next one.
 */
export async function askForApproval(
	request: PermissionRequest,
	dir = requestsDir(),
	timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Answer> {
	mkdirSync(dir, { recursive: true });
	const requestPath = join(dir, `${request.id}.json`);
	const replyPath = join(dir, `${request.id}.reply`);
	writeFileSync(requestPath, JSON.stringify(request), "utf-8");
	try {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const answer = readAnswer(replyPath);
			if (answer) return answer;
			await sleep(POLL_INTERVAL_MS);
		}
		return "deny";
	} finally {
		rmSync(requestPath, { force: true });
		rmSync(replyPath, { force: true });
	}
}

/** Drop anything left behind by an earlier run. */
export function clearStaleRequests(dir = requestsDir()): void {
	try {
		for (const name of readdirSync(dir)) {
			if (name.endsWith(".json") || name.endsWith(".reply")) rmSync(join(dir, name), { force: true });
		}
	} catch {
		// No directory yet is the normal first-run case.
	}
}

let requestCounter = 0;

export default function permissionsExtension(smolt: ExtensionAPI): void {
	const path = permissionModePath();
	if (!existsSync(path)) writePermissionMode("auto", path);
	clearStaleRequests();

	/** Tools the user approved for the rest of this agent process. */
	const alwaysAllow = new Set<string>();

	smolt.on("tool_call", async (event) => {
		const mode = readPermissionMode(path);
		const input = (event as { input?: unknown }).input;
		const decision = decide(mode, event.toolName, input);
		if (decision === "allow") return {};
		if (decision === "block") return { block: true, reason: blockReason(mode, event.toolName) };
		// An always-allow covers the ordinary case, never a destructive command:
		// approving one `rm -rf` should not approve every later one.
		const danger = destructiveReason(commandOf(input));
		if (!danger && alwaysAllow.has(event.toolName)) return {};

		requestCounter += 1;
		const answer = await askForApproval({
			id: `${process.pid}-${requestCounter}`,
			tool: event.toolName,
			summary: summarise(event.toolName, input),
			mode,
			danger,
			createdAt: Date.now(),
		});
		if (answer === "always") {
			alwaysAllow.add(event.toolName);
			return {};
		}
		if (answer === "allow") return {};
		return { block: true, reason: deniedReason(event.toolName) };
	});
}
