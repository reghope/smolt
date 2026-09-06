import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "../../core/extensions/types.ts";
import { projectStore } from "../../core/project-store.ts";
import { type FileEntry, loadEntriesFromFile, SessionManager } from "../../core/session-manager.ts";
import { buildSystemPrompt } from "../../core/system-prompt.ts";
import {
	analyzeSession,
	attributePrompt,
	buildReport,
	type ChildRunUsage,
	renderReport,
	type SessionUsage,
} from "./usage.ts";

/**
 * Analyst: reads what this user's sessions and extensions leave behind, and
 * says what it shows.
 *
 * The first analysis is token usage. `/analyze-token-usage` reads the
 * project's session files (every model turn's usage, every tool result,
 * every injected message), the per-turn prompt records this extension
 * keeps, and the research and battletest stores, attributes the bill to the
 * mechanism that ran it up — a prompt block an extension appends, a tool
 * whose results ride forty turns, a provider that never reports a cache
 * hit — and ranks the holes with the file each fix belongs in. The report
 * is written to the project store and handed to the agent, which tells the
 * user where to go.
 *
 * Two rules. The analysis is arithmetic, never a model call: an analysis of
 * spend that itself spends would be part of the problem. And the analyst
 * loads last, so the system prompt it sees on each turn is the one every
 * other extension has already added to; that is what lets a block be
 * credited to its author.
 */

export const COMMAND = "analyze-token-usage";
/** The per-turn record: how big the prompt was and who put what in it. */
export const TURN_ENTRY = "analyst-turn";
/** The hidden message that carries a report to the agent. */
export const REPORT_MESSAGE = "analyst-report";
export const DEFAULT_SESSION_LIMIT = 40;

export type Scope = "session" | "project" | "all";

export interface ScopeRequest {
	scope: Scope;
	limit: number;
}

/** `/analyze-token-usage [session|project|all] [N]` — N most recent sessions, default 40. */
export function parseScope(args: string): ScopeRequest {
	let scope: Scope = "project";
	let limit = DEFAULT_SESSION_LIMIT;
	for (const word of args.trim().toLowerCase().split(/\s+/).filter(Boolean)) {
		if (word === "session" || word === "this" || word === "current") scope = "session";
		else if (word === "project" || word === "here") scope = "project";
		else if (word === "all" || word === "everything") scope = "all";
		else if (/^\d+$/.test(word)) limit = Math.max(1, Math.min(500, Number(word)));
	}
	return { scope, limit };
}

/** The seams a test replaces: where sessions and stores are, and the clock. */
export interface AnalystDeps {
	listSessions(request: ScopeRequest, ctx: ExtensionCommandContext): Promise<string[]>;
	readEntries(path: string): FileEntry[];
	childRuns(cwd: string): ChildRunUsage[];
	reportDir(cwd: string): string;
	now(): Date;
}

/** Sum the child-session spend the research and battletest stores recorded. */
export function readChildRuns(cwd: string): ChildRunUsage[] {
	const runs: ChildRunUsage[] = [];
	for (const extension of ["research", "battletest"] as const) {
		let root: string;
		try {
			root = projectStore(cwd, extension);
		} catch {
			continue;
		}
		let dirs: string[];
		try {
			dirs = readdirSync(root, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name);
		} catch {
			continue;
		}
		for (const dir of dirs) {
			const file = join(root, dir, "performance.json");
			if (!existsSync(file)) continue;
			try {
				const payload = JSON.parse(readFileSync(file, "utf-8")) as {
					researchers?: { tokens?: number; cost?: number }[];
					testers?: { tokens?: number; cost?: number }[];
				};
				const members = payload.researchers ?? payload.testers ?? [];
				if (members.length === 0) continue;
				runs.push({
					extension,
					run: dir,
					members: members.length,
					tokens: members.reduce((sum, member) => sum + (member.tokens ?? 0), 0),
					cost: members.reduce((sum, member) => sum + (member.cost ?? 0), 0),
					whole: members.every((member) => typeof member.cost === "number"),
				});
			} catch {
				// A malformed record is not a reason to lose the rest.
			}
		}
	}
	return runs;
}

async function defaultListSessions(request: ScopeRequest, ctx: ExtensionCommandContext): Promise<string[]> {
	if (request.scope === "session") {
		const file = ctx.sessionManager.getSessionFile();
		return file ? [file] : [];
	}
	const sessions = request.scope === "all" ? await SessionManager.listAll() : await SessionManager.list(ctx.cwd);
	return sessions
		.sort((a, b) => b.modified.getTime() - a.modified.getTime())
		.slice(0, request.limit)
		.map((session) => session.path);
}

const defaultDeps: AnalystDeps = {
	listSessions: defaultListSessions,
	readEntries: loadEntriesFromFile,
	childRuns: readChildRuns,
	reportDir: (cwd) => projectStore(cwd, "analyst"),
	now: () => new Date(),
};

/** What the agent is told alongside the report, so it speaks to the user about it rather than reciting it. */
export function reportBrief(scopeLabel: string, reportPath: string): string {
	return `The user ran /${COMMAND}. The report below was computed from ${scopeLabel} — arithmetic over session files, not a model's opinion — and is saved at ${reportPath}.

Tell the user, in plain language and in your own voice, where their tokens are going and where to fix it: the two or three biggest holes, each with the extension and file the fix belongs in and what to change there. Lead with the largest. Quote the numbers that matter and no others; do not restate the tables. If the findings are empty, say what the headline shows and that nothing stood out.`;
}

export interface AnalystHandle {
	/** Run the analysis without the command: the report's markdown and where it was written. */
	analyze(
		request: ScopeRequest,
		ctx: ExtensionCommandContext,
	): Promise<{ markdown: string; path: string; sessions: SessionUsage[] }>;
}

export function createAnalystExtension(smolt: ExtensionAPI, deps: AnalystDeps = defaultDeps): AnalystHandle {
	// The per-turn record. Rebuilding the base prompt from the same options the
	// harness used is what separates the core's share from what extensions
	// appended; if the rebuild does not match (a custom prompt, a version
	// skew), the whole prompt is credited to the base rather than guessed at.
	smolt.on("before_agent_start", async (event) => {
		try {
			let base = "";
			try {
				base = buildSystemPrompt(event.systemPromptOptions);
			} catch {
				base = "";
			}
			const attribution = attributePrompt(event.systemPrompt, base);
			smolt.appendEntry(TURN_ENTRY, {
				prompt: attribution.tokens,
				base: attribution.base,
				sources: attribution.sources,
				tools: smolt.getActiveTools().length,
			});
		} catch {
			// The record is a convenience for later analysis; it must never cost a turn.
		}
		return undefined;
	});

	const analyze: AnalystHandle["analyze"] = async (request, ctx) => {
		const paths = await deps.listSessions(request, ctx);
		const sessions: SessionUsage[] = [];
		for (const path of paths) {
			try {
				sessions.push(analyzeSession(deps.readEntries(path), path));
			} catch {
				// An unreadable session file drops out of the range, not the report.
			}
		}
		const childRuns = request.scope === "session" ? [] : deps.childRuns(ctx.cwd);
		const report = buildReport(sessions, childRuns);
		const scopeLabel =
			request.scope === "session"
				? "this session"
				: request.scope === "all"
					? `the ${sessions.length} most recent sessions across every project`
					: `the ${sessions.length} most recent sessions of this project`;
		const now = deps.now();
		const markdown = renderReport(report, { scope: scopeLabel, generatedAt: now });
		const dir = deps.reportDir(ctx.cwd);
		mkdirSync(dir, { recursive: true });
		const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
		const path = join(dir, `token-usage-${stamp}.md`);
		writeFileSync(path, markdown, "utf-8");
		return { markdown, path, sessions };
	};

	smolt.registerCommand(COMMAND, {
		description:
			"Analyze where this project's tokens go — by extension, tool, prompt block and provider — and name the holes to fix. Args: session | project | all, and a session count.",
		handler: async (args, ctx) => {
			const request = parseScope(args);
			const { markdown, path, sessions } = await analyze(request, ctx);
			if (sessions.length === 0) {
				ctx.ui.notify("No session files to analyze in that range.", "warning");
				return;
			}
			ctx.ui.notify(`Token usage report written to ${path}`, "info");
			const scopeLabel =
				request.scope === "session"
					? "this session"
					: request.scope === "all"
						? `${sessions.length} sessions across every project`
						: `${sessions.length} sessions of this project`;
			smolt.sendMessage(
				{
					customType: REPORT_MESSAGE,
					content: `${reportBrief(scopeLabel, path)}\n\n${markdown}`,
					display: false,
				},
				{ triggerTurn: true },
			);
		},
	});

	return { analyze };
}

export default function analystExtension(smolt: ExtensionAPI): void {
	createAnalystExtension(smolt);
}
