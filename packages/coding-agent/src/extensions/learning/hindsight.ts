import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
// Type-only import: a standalone install of this module outside the smolt
// tree switches this single line to `from "smolt"`.
import type { ExtensionAPI } from "../../core/extensions/types.ts";

/**
 * Hindsight: observed tool-usage learning.
 *
 * Where memory and skills are self-reported (the model decides it learned
 * something), hindsight is measured: every tool call is recorded with its
 * duration and outcome, failures are normalized into error classes, and
 * retries are linked to the failure they retried. Two read paths feed the
 * data back:
 *
 * - "Tool field notes" — recurring failure patterns with real counts,
 *   distilled by SQL at session start and injected into the frozen
 *   self-learning prompt block (byte-stable for cache reuse).
 * - Reactive hints — when a failing tool result matches an error class
 *   with an established remedy record, the remedy (with counts) is
 *   appended to the tool result at the moment it is needed.
 *
 * Storage shares the learning extension's state.db, but never the
 * `user_version` pragma: the session index migrates by drop-and-rebuild,
 * while hindsight rows are source of truth and version through their own
 * `hindsight_meta` table with additive migrations only. Because the tables
 * are self-versioned, the same file works with or without the rest of the
 * learning extension present — in-tree, learning wires this module against
 * its state.db; copied out alone, the default export is a complete
 * extension that resolves the same path and injects its own notes block.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface HindsightConfig {
	enabled: boolean;
	notesBudgetChars: number;
	minSamples: number;
}

export const DEFAULT_HINDSIGHT_CONFIG: HindsightConfig = {
	enabled: true,
	notesBudgetChars: 1200,
	minSamples: 5,
};

export function readHindsightConfig(configPath: string | undefined): HindsightConfig {
	const config = { ...DEFAULT_HINDSIGHT_CONFIG };
	if (!configPath) return config;
	try {
		if (!existsSync(configPath)) return config;
		const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as Partial<HindsightConfig>;
		if (typeof parsed.enabled === "boolean") config.enabled = parsed.enabled;
		if (typeof parsed.notesBudgetChars === "number" && parsed.notesBudgetChars > 0) {
			config.notesBudgetChars = parsed.notesBudgetChars;
		}
		if (typeof parsed.minSamples === "number" && parsed.minSamples > 0) {
			config.minSamples = parsed.minSamples;
		}
	} catch {
		// A malformed config is not a reason to stop observing.
	}
	return config;
}

// ---------------------------------------------------------------------------
// Pure helpers: error classification and arg keys
// ---------------------------------------------------------------------------

/** First match wins; ordered specific to generic. */
const ERROR_CLASSES: { cls: string; re: RegExp }[] = [
	{ cls: "ebusy", re: /\bEBUSY\b|resource busy or locked/i },
	{ cls: "enoent", re: /\bENOENT\b|no such file or directory/i },
	{ cls: "eacces", re: /\bEACCES\b|\bEPERM\b|permission denied|operation not permitted/i },
	{ cls: "timeout", re: /\bETIMEDOUT\b|timed? ?out\b|exceeded.*timeout/i },
	{
		cls: "command-not-found",
		re: /command not found|not recognized as (an internal|the name)|\bENOEXEC\b|is not recognized/i,
	},
	{ cls: "edit-mismatch", re: /old_string|old_text.*not found|no match found|not unique/i },
	{ cls: "syntax-error", re: /syntax error|parse error|unexpected token|SyntaxError/i },
	{
		cls: "schema-rejection",
		re: /invalid (params|arguments|input)|required (parameter|property)|does not match schema|InputValidationError/i,
	},
	{ cls: "network", re: /\bECONNREFUSED\b|\bECONNRESET\b|\bENOTFOUND\b|\bEAI_AGAIN\b|fetch failed/i },
	{ cls: "disk-space", re: /\bENOSPC\b|no space left/i },
	{ cls: "interrupted", re: /\bSIGINT\b|\bSIGTERM\b|aborted|cancell?ed/i },
];

const EXIT_CODE_RE = /Command exited with code (\d+)/i;

const SHELL_TOOLS = new Set(["bash", "powershell"]);

/** Advice suffixes for classes where a canned remedy is worth stating. */
const ADVICE: Record<string, string> = {
	"edit-mismatch": "re-read the file before editing",
	enoent: "verify the path exists before retrying",
	"command-not-found": "check the tool is installed and on PATH",
	ebusy: "retry the same call once",
};

export const GENERIC_ADVICE = "retry the same call once before changing approach";

export function adviceFor(errorClass: string): string | undefined {
	return ADVICE[errorClass];
}

/** Normalize a failing tool result's text into a stable error class. */
export function classifyError(toolName: string, errorText: string): string {
	for (const { cls, re } of ERROR_CLASSES) {
		if (re.test(errorText)) return cls;
	}
	if (SHELL_TOOLS.has(toolName)) {
		const match = EXIT_CODE_RE.exec(errorText);
		if (match) {
			const code = Number(match[1]);
			if (code === 127) return "exit-127";
			if (code === 126) return "exit-126";
			return "exit-nonzero";
		}
	}
	return "unclassified";
}

/** Join the text blocks of a tool-result content array. */
export function extractErrorText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
			const text = (block as { text?: string }).text;
			if (typeof text === "string") parts.push(text);
		}
	}
	return parts.join("\n");
}

/** Command tokens whose second word carries the meaning (npm test, git push). */
const RUNNER_TOKENS = new Set([
	"npm",
	"npx",
	"pnpm",
	"yarn",
	"node",
	"python",
	"python3",
	"pip",
	"git",
	"cargo",
	"go",
	"dotnet",
	"docker",
	"make",
]);

const PATH_ARG_TOOLS = new Set(["read", "write", "edit"]);

function firstStringArg(args: Record<string, unknown>, keys: string[]): string {
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string" && value !== "") return value;
	}
	return "";
}

function looksLikePath(value: string): boolean {
	return value.includes("/") || value.includes("\\");
}

/**
 * Derive a short grouping key and a truncated raw detail from a tool call's
 * arguments. The key gates retry linkage; the detail only decorates notes.
 */
export function deriveArgKey(
	toolName: string,
	args: Record<string, unknown> | undefined,
): { argKey: string; argDetail: string } {
	if (!args || typeof args !== "object") return { argKey: "", argDetail: "" };
	let primary = "";
	let key = "";
	if (SHELL_TOOLS.has(toolName)) {
		primary = firstStringArg(args, ["command"]);
		let command = primary.trim();
		// Strip `cd somewhere && ` and leading VAR=value prefixes so the real
		// command groups together regardless of setup noise.
		command = command.replace(/^cd\s+[^&;|]+&&\s*/i, "");
		command = command.replace(/^(?:\w+=\S+\s+)+/, "");
		const tokens = command.split(/\s+/).filter((t) => t !== "");
		if (tokens.length > 0) {
			key = RUNNER_TOKENS.has(tokens[0]!) && tokens.length > 1 ? `${tokens[0]} ${tokens[1]}` : tokens[0]!;
		}
	} else if (PATH_ARG_TOOLS.has(toolName)) {
		primary = firstStringArg(args, ["path", "file_path"]);
		key = primary === "" ? "" : basename(primary);
	} else {
		primary = firstStringArg(args, ["path", "file_path", "command", "pattern", "query", "url", "name"]);
		key = looksLikePath(primary) ? basename(primary) : primary;
	}
	return { argKey: key.slice(0, 80), argDetail: primary.slice(0, 200) };
}

// ---------------------------------------------------------------------------
// Store: SQLite persistence, remedy stats, notes distillation
// ---------------------------------------------------------------------------

export interface ToolCallRow {
	toolCallId: string;
	sessionId: string;
	turnIndex: number;
	tool: string;
	argKey: string;
	argDetail: string;
	cwd: string;
	startedAt: number;
	durationMs: number | undefined;
	isError: boolean;
	errorClass: string | undefined;
	retryOf: string | undefined;
}

export interface RemedyStat {
	seen: number;
	attempts: number;
	successes: number;
}

interface SqliteStatement {
	run(...args: unknown[]): unknown;
	all(...args: unknown[]): unknown[];
	get(...args: unknown[]): unknown;
}

interface SqliteDatabase {
	exec(sql: string): void;
	prepare(sql: string): SqliteStatement;
	close?(): void;
}

/**
 * Additive migration ladder. Each entry is one version's statements; new
 * versions append entries (typically ALTER TABLE ADD COLUMN). Existing
 * entries must never be edited and nothing is ever dropped — these rows are
 * source of truth, unlike the rebuildable session index sharing this file.
 */
const MIGRATIONS: string[][] = [
	[
		"CREATE TABLE IF NOT EXISTS hindsight_tool_calls (" +
			"tool_call_id TEXT PRIMARY KEY, " +
			"session_id TEXT NOT NULL, " +
			"turn_index INTEGER NOT NULL, " +
			"tool TEXT NOT NULL, " +
			"arg_key TEXT NOT NULL DEFAULT '', " +
			"arg_detail TEXT NOT NULL DEFAULT '', " +
			"cwd TEXT NOT NULL DEFAULT '', " +
			"started_at INTEGER NOT NULL, " +
			"duration_ms INTEGER, " +
			"is_error INTEGER NOT NULL DEFAULT 0, " +
			"error_class TEXT, " +
			"retry_of TEXT, " +
			"ts TEXT NOT NULL)",
		"CREATE INDEX IF NOT EXISTS idx_hindsight_err ON hindsight_tool_calls(tool, error_class) " +
			"WHERE error_class IS NOT NULL",
		"CREATE INDEX IF NOT EXISTS idx_hindsight_retry ON hindsight_tool_calls(retry_of) " +
			"WHERE retry_of IS NOT NULL",
	],
];

const NOTES_HEADER =
	"## Tool field notes (observed, this machine)\n" +
	"Recurring tool-failure patterns measured from your own past sessions. " +
	"Counts are real; prefer the listed remedy before improvising.";

export class HindsightStore {
	private readonly dbPath: string;
	private db: SqliteDatabase | undefined;
	private sqliteFailed = false;

	constructor(dbPath: string) {
		this.dbPath = dbPath;
	}

	/** Release the SQLite handle (used by tests and shutdown paths). */
	close(): void {
		try {
			this.db?.close?.();
		} catch {
			// already closed
		}
		this.db = undefined;
	}

	private async openDb(): Promise<SqliteDatabase | undefined> {
		if (this.db) return this.db;
		if (this.sqliteFailed) return undefined;
		try {
			// Computed specifier: node:sqlite ships with the supported Node
			// versions but has no stable type declarations.
			const specifier = "node:sqlite";
			const mod = (await import(specifier)) as { DatabaseSync: new (path: string) => SqliteDatabase };
			mkdirSync(dirname(this.dbPath), { recursive: true });
			const db = new mod.DatabaseSync(this.dbPath);
			// Another session (or the session index sharing this file) may be
			// writing; wait briefly instead of failing.
			db.exec("PRAGMA busy_timeout = 2000");
			db.exec("CREATE TABLE IF NOT EXISTS hindsight_meta(key TEXT PRIMARY KEY, value TEXT)");
			const row = db.prepare("SELECT value FROM hindsight_meta WHERE key = 'schema_version'").get() as
				| { value?: string }
				| undefined;
			const version = row?.value ? Number(row.value) : 0;
			for (let i = version; i < MIGRATIONS.length; i++) {
				for (const sql of MIGRATIONS[i]!) db.exec(sql);
			}
			if (version < MIGRATIONS.length) {
				db.prepare("INSERT OR REPLACE INTO hindsight_meta(key, value) VALUES ('schema_version', ?)").run(
					String(MIGRATIONS.length),
				);
			}
			this.db = db;
			return db;
		} catch {
			this.sqliteFailed = true;
			return undefined;
		}
	}

	/** Persist finalized rows. Idempotent per tool_call_id; silent on failure. */
	async flush(rows: ToolCallRow[]): Promise<void> {
		if (rows.length === 0) return;
		const db = await this.openDb();
		if (!db) return;
		try {
			const insert = db.prepare(
				"INSERT OR REPLACE INTO hindsight_tool_calls(" +
					"tool_call_id, session_id, turn_index, tool, arg_key, arg_detail, cwd, " +
					"started_at, duration_ms, is_error, error_class, retry_of, ts) " +
					"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			);
			for (const row of rows) {
				insert.run(
					row.toolCallId,
					row.sessionId,
					row.turnIndex,
					row.tool,
					row.argKey,
					row.argDetail,
					row.cwd,
					row.startedAt,
					row.durationMs ?? null,
					row.isError ? 1 : 0,
					row.errorClass ?? null,
					row.retryOf ?? null,
					new Date(row.startedAt).toISOString(),
				);
			}
		} catch {
			// Dropped telemetry is never worth an error.
		}
	}

	/**
	 * Per (tool, error_class): how often the failure was seen, how often it
	 * was retried, and how often the retry succeeded. Loaded once at session
	 * start and held in memory so hints stay deterministic and cheap.
	 */
	async loadRemedyStats(): Promise<Map<string, RemedyStat>> {
		const stats = new Map<string, RemedyStat>();
		const db = await this.openDb();
		if (!db) return stats;
		try {
			const rows = db
				.prepare(
					"SELECT f.tool AS tool, f.error_class AS error_class, " +
						"COUNT(*) AS seen, " +
						"(SELECT COUNT(*) FROM hindsight_tool_calls r JOIN hindsight_tool_calls x " +
						"ON r.retry_of = x.tool_call_id " +
						"WHERE x.tool = f.tool AND x.error_class = f.error_class) AS attempts, " +
						"(SELECT COUNT(*) FROM hindsight_tool_calls r JOIN hindsight_tool_calls x " +
						"ON r.retry_of = x.tool_call_id " +
						"WHERE x.tool = f.tool AND x.error_class = f.error_class AND r.is_error = 0) AS successes " +
						"FROM hindsight_tool_calls f " +
						"WHERE f.is_error = 1 AND f.error_class IS NOT NULL AND f.error_class != 'unclassified' " +
						"GROUP BY f.tool, f.error_class",
				)
				.all() as { tool: string; error_class: string; seen: number; attempts: number; successes: number }[];
			for (const row of rows) {
				stats.set(`${row.tool}|${row.error_class}`, {
					seen: row.seen,
					attempts: row.attempts,
					successes: row.successes,
				});
			}
		} catch {
			// No stats beats no session.
		}
		return stats;
	}

	/**
	 * Distill the accumulated telemetry into the "Tool field notes" block.
	 * Returns "" when nothing crosses the sample threshold (prompt untouched).
	 */
	async distillNotes(config: HindsightConfig): Promise<string> {
		const db = await this.openDb();
		if (!db) return "";
		let rows: {
			tool: string;
			error_class: string;
			err_count: number;
			attempts: number;
			successes: number;
			top_arg: string | null;
		}[];
		try {
			rows = db
				.prepare(
					"SELECT f.tool AS tool, f.error_class AS error_class, " +
						"COUNT(*) AS err_count, MAX(f.started_at) AS last_seen, " +
						"(SELECT COUNT(*) FROM hindsight_tool_calls r JOIN hindsight_tool_calls x " +
						"ON r.retry_of = x.tool_call_id " +
						"WHERE x.tool = f.tool AND x.error_class = f.error_class) AS attempts, " +
						"(SELECT COUNT(*) FROM hindsight_tool_calls r JOIN hindsight_tool_calls x " +
						"ON r.retry_of = x.tool_call_id " +
						"WHERE x.tool = f.tool AND x.error_class = f.error_class AND r.is_error = 0) AS successes, " +
						"(SELECT a.arg_detail FROM hindsight_tool_calls a " +
						"WHERE a.tool = f.tool AND a.error_class = f.error_class AND a.arg_detail != '' " +
						"GROUP BY a.arg_detail ORDER BY COUNT(*) DESC, MAX(a.started_at) DESC LIMIT 1) AS top_arg " +
						"FROM hindsight_tool_calls f " +
						"WHERE f.is_error = 1 AND f.error_class IS NOT NULL AND f.error_class != 'unclassified' " +
						"GROUP BY f.tool, f.error_class " +
						"HAVING err_count >= ? " +
						"ORDER BY err_count DESC, last_seen DESC LIMIT 10",
				)
				.all(config.minSamples) as typeof rows;
		} catch {
			return "";
		}
		if (rows.length === 0) return "";
		let block = NOTES_HEADER;
		for (const row of rows) {
			let line = `\n- ${row.tool}: ${row.error_class} ${row.err_count}x`;
			if (row.top_arg) line += ` (most often \`${row.top_arg}\`)`;
			if (row.attempts >= 3) line += `; retry succeeded ${row.successes}/${row.attempts}`;
			const advice = adviceFor(row.error_class);
			if (advice) line += ` — ${advice}`;
			if (block.length + line.length > config.notesBudgetChars) break;
			block += line;
		}
		return block;
	}

	/** Aggregate totals plus top failure patterns and busiest tools. */
	async summary(): Promise<HindsightSummary | undefined> {
		const db = await this.openDb();
		if (!db) return undefined;
		try {
			const totals = db
				.prepare(
					"SELECT COUNT(*) AS calls, COALESCE(SUM(is_error), 0) AS errors, " +
						"COUNT(DISTINCT session_id) AS sessions, COUNT(DISTINCT tool) AS tools, " +
						"MIN(started_at) AS first_at, MAX(started_at) AS last_at, " +
						"AVG(duration_ms) AS avg_ms " +
						"FROM hindsight_tool_calls",
				)
				.get() as {
				calls: number;
				errors: number;
				sessions: number;
				tools: number;
				first_at: number | null;
				last_at: number | null;
				avg_ms: number | null;
			};
			if (totals.calls === 0) return undefined;
			const failures = db
				.prepare(
					"SELECT f.tool AS tool, f.error_class AS error_class, COUNT(*) AS count, " +
						"(SELECT COUNT(*) FROM hindsight_tool_calls r JOIN hindsight_tool_calls x " +
						"ON r.retry_of = x.tool_call_id " +
						"WHERE x.tool = f.tool AND x.error_class = f.error_class) AS attempts, " +
						"(SELECT COUNT(*) FROM hindsight_tool_calls r JOIN hindsight_tool_calls x " +
						"ON r.retry_of = x.tool_call_id " +
						"WHERE x.tool = f.tool AND x.error_class = f.error_class AND r.is_error = 0) AS successes " +
						"FROM hindsight_tool_calls f " +
						"WHERE f.is_error = 1 AND f.error_class IS NOT NULL " +
						"GROUP BY f.tool, f.error_class ORDER BY count DESC LIMIT 8",
				)
				.all() as HindsightSummary["topFailures"];
			const tools = db
				.prepare(
					"SELECT tool, COUNT(*) AS calls, COALESCE(SUM(is_error), 0) AS errors " +
						"FROM hindsight_tool_calls GROUP BY tool ORDER BY calls DESC LIMIT 6",
				)
				.all() as HindsightSummary["topTools"];
			return {
				calls: totals.calls,
				errors: totals.errors,
				sessions: totals.sessions,
				tools: totals.tools,
				firstAt: totals.first_at ?? 0,
				lastAt: totals.last_at ?? 0,
				avgMs: totals.avg_ms,
				topFailures: failures,
				topTools: tools,
			};
		} catch {
			return undefined;
		}
	}

	/** Recent calls whose tool, error class, args, or cwd match any query term. */
	async searchCalls(query: string, limit: number): Promise<HindsightCallMatch[]> {
		const terms = query
			.toLowerCase()
			.split(/\s+/)
			.map((t) => t.replace(/[^\p{L}\p{N}._/-]/gu, ""))
			.filter((t) => t.length >= 3);
		if (terms.length === 0) return [];
		const db = await this.openDb();
		if (!db) return [];
		try {
			const haystack =
				"lower(tool || ' ' || COALESCE(error_class, '') || ' ' || arg_key || ' ' || arg_detail || ' ' || cwd)";
			const where = terms.map(() => `${haystack} LIKE ?`).join(" OR ");
			return db
				.prepare(
					"SELECT tool, arg_detail, error_class, is_error, started_at, duration_ms, retry_of " +
						`FROM hindsight_tool_calls WHERE ${where} ORDER BY started_at DESC LIMIT ?`,
				)
				.all(...terms.map((t) => `%${t}%`), limit) as HindsightCallMatch[];
		} catch {
			return [];
		}
	}
}

export interface HindsightSummary {
	calls: number;
	errors: number;
	sessions: number;
	tools: number;
	firstAt: number;
	lastAt: number;
	avgMs: number | null;
	topFailures: { tool: string; error_class: string; count: number; attempts: number; successes: number }[];
	topTools: { tool: string; calls: number; errors: number }[];
}

export interface HindsightCallMatch {
	tool: string;
	arg_detail: string;
	error_class: string | null;
	is_error: number;
	started_at: number;
	duration_ms: number | null;
	retry_of: string | null;
}

function day(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

function failureLines(failures: HindsightSummary["topFailures"]): string[] {
	return failures.map((f) => {
		let line = `- ${f.tool}: ${f.error_class} ${f.count}x`;
		if (f.attempts > 0) line += ` — retry succeeded ${f.successes}/${f.attempts}`;
		return line;
	});
}

/** Render the /hindsight no-argument breakdown. */
export function renderBreakdown(summary: HindsightSummary): string {
	const errorRate = summary.calls > 0 ? Math.round((summary.errors / summary.calls) * 100) : 0;
	const lines = [
		"## Hindsight — observed tool usage",
		`- ${summary.calls} calls · ${summary.sessions} sessions · ${summary.tools} tools · ${day(summary.firstAt)} → ${day(summary.lastAt)}`,
		`- ${summary.errors} errors (${errorRate}%)${summary.avgMs !== null ? ` · avg call ${Math.round(summary.avgMs)}ms` : ""}`,
	];
	if (summary.topFailures.length > 0) {
		lines.push("", "**Top failure patterns**", ...failureLines(summary.topFailures));
	}
	if (summary.topTools.length > 0) {
		lines.push(
			"",
			"**Busiest tools**",
			...summary.topTools.map((t) => `- ${t.tool} — ${t.calls} calls, ${t.errors} errors`),
		);
	}
	return lines.join("\n");
}

/** Render the /hindsight <question> prompt: the question plus the data to answer it from. */
export function renderQueryPrompt(query: string, summary: HindsightSummary, matches: HindsightCallMatch[]): string {
	const lines = [
		`[hindsight] Answer this question about my observed tool-usage telemetry: "${query}"`,
		"",
		`Overall: ${summary.calls} calls, ${summary.errors} errors across ${summary.sessions} sessions (${day(summary.firstAt)} → ${day(summary.lastAt)}).`,
	];
	if (summary.topFailures.length > 0) {
		lines.push("Top failure patterns:", ...failureLines(summary.topFailures));
	}
	if (matches.length > 0) {
		lines.push("", `Calls matching the question (most recent first, up to ${matches.length}):`);
		for (const m of matches) {
			const outcome = m.is_error ? (m.error_class ?? "error") : "ok";
			const detail = m.arg_detail !== "" ? ` \`${m.arg_detail}\`` : "";
			const retry = m.retry_of ? " (retry)" : "";
			lines.push(`- ${new Date(m.started_at).toISOString()} ${m.tool}${detail} → ${outcome}${retry}`);
		}
	} else {
		lines.push("", "No individual calls matched the question; answer from the overall stats above.");
	}
	lines.push(
		"",
		"Use only this data — do not run tools. If the data cannot answer the question, say what is missing. Keep it brief.",
	);
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tracker: in-session collection, retry linkage, reactive hints
// ---------------------------------------------------------------------------

/** How many previous finalized calls a retry can reach back to its failure. */
const RETRY_LOOKBACK = 3;
/** Ring-buffer size for retry linkage. */
const RECENT_CAP = 10;
/** Remedy quality gates for reactive hints. */
const HINT_MIN_ATTEMPTS = 3;
const HINT_MIN_RATIO = 0.6;

interface PendingCall {
	toolCallId: string;
	tool: string;
	argKey: string;
	argDetail: string;
	cwd: string;
	startedAt: number | undefined;
	durationMs: number | undefined;
	isError: boolean;
	errorClass: string | undefined;
	hasTiming: boolean;
	hasResult: boolean;
}

interface RecentCall {
	toolCallId: string;
	tool: string;
	argKey: string;
	isError: boolean;
	consumed: boolean;
}

/**
 * Collects one session's tool calls. Rows finalize when both the timing half
 * (tool_execution_end) and the result half (tool_result) have arrived — the
 * two come from different emission paths and their order is not guaranteed.
 * Stragglers finalize with what they have at turn end.
 */
export class HindsightTracker {
	private readonly store: HindsightStore;
	private starts = new Map<string, { startedAt: number; tool: string; argKey: string; argDetail: string }>();
	private pending = new Map<string, PendingCall>();
	private recent: RecentCall[] = [];
	private buffer: ToolCallRow[] = [];
	private hinted = new Set<string>();
	private remedyStats = new Map<string, RemedyStat>();
	private sessionId = "";
	turnIndex = 0;

	constructor(store: HindsightStore) {
		this.store = store;
	}

	async onSessionStart(sessionId: string): Promise<void> {
		this.starts.clear();
		this.pending.clear();
		this.recent = [];
		this.buffer = [];
		this.hinted.clear();
		this.sessionId = sessionId;
		this.turnIndex = 0;
		this.remedyStats = await this.store.loadRemedyStats();
	}

	onToolStart(toolCallId: string, toolName: string, args: Record<string, unknown> | undefined): void {
		const { argKey, argDetail } = deriveArgKey(toolName, args);
		this.starts.set(toolCallId, { startedAt: Date.now(), tool: toolName, argKey, argDetail });
	}

	onToolEnd(toolCallId: string, toolName: string, isError: boolean): void {
		const call = this.getPending(toolCallId, toolName);
		const start = this.starts.get(toolCallId);
		if (start) {
			call.startedAt = start.startedAt;
			call.durationMs = Date.now() - start.startedAt;
		}
		call.isError = call.isError || isError;
		call.hasTiming = true;
		this.maybeFinalize(toolCallId);
	}

	/**
	 * Record the result half. Returns a reactive hint to append to the tool
	 * result when the failure matches an established remedy record.
	 */
	onToolResult(
		toolCallId: string,
		toolName: string,
		input: Record<string, unknown> | undefined,
		content: unknown,
		isError: boolean,
		cwd: string,
	): string | undefined {
		const call = this.getPending(toolCallId, toolName);
		if (call.argKey === "" && call.argDetail === "") {
			const { argKey, argDetail } = deriveArgKey(toolName, input);
			call.argKey = argKey;
			call.argDetail = argDetail;
		}
		call.cwd = cwd;
		call.isError = call.isError || isError;
		if (isError) call.errorClass = classifyError(toolName, extractErrorText(content));
		call.hasResult = true;
		this.maybeFinalize(toolCallId);
		if (!isError || !call.errorClass || call.errorClass === "unclassified") return undefined;
		return this.hintFor(toolName, call.errorClass);
	}

	async onTurnEnd(): Promise<void> {
		this.finalizeStragglers();
		const rows = this.buffer;
		this.buffer = [];
		await this.store.flush(rows);
	}

	async onShutdown(): Promise<void> {
		await this.onTurnEnd();
		this.store.close();
	}

	private getPending(toolCallId: string, toolName: string): PendingCall {
		let call = this.pending.get(toolCallId);
		if (!call) {
			const start = this.starts.get(toolCallId);
			call = {
				toolCallId,
				tool: toolName,
				argKey: start?.argKey ?? "",
				argDetail: start?.argDetail ?? "",
				cwd: "",
				startedAt: start?.startedAt,
				durationMs: undefined,
				isError: false,
				errorClass: undefined,
				hasTiming: false,
				hasResult: false,
			};
			this.pending.set(toolCallId, call);
		}
		return call;
	}

	private maybeFinalize(toolCallId: string): void {
		const call = this.pending.get(toolCallId);
		if (!call || !call.hasTiming || !call.hasResult) return;
		this.finalize(call);
	}

	/** Flush half-recorded calls with what they have (one half never arrived). */
	private finalizeStragglers(): void {
		for (const call of [...this.pending.values()]) {
			if (call.hasTiming || call.hasResult) this.finalize(call);
		}
		this.pending.clear();
		this.starts.clear();
	}

	private finalize(call: PendingCall): void {
		this.pending.delete(call.toolCallId);
		this.starts.delete(call.toolCallId);
		const retryOf = this.linkRetry(call);
		this.recent.push({
			toolCallId: call.toolCallId,
			tool: call.tool,
			argKey: call.argKey,
			isError: call.isError,
			consumed: false,
		});
		if (this.recent.length > RECENT_CAP) this.recent.shift();
		this.buffer.push({
			toolCallId: call.toolCallId,
			sessionId: this.sessionId,
			turnIndex: this.turnIndex,
			tool: call.tool,
			argKey: call.argKey,
			argDetail: call.argDetail,
			cwd: call.cwd,
			startedAt: call.startedAt ?? Date.now(),
			durationMs: call.durationMs,
			isError: call.isError,
			errorClass: call.errorClass,
			retryOf,
		});
	}

	/**
	 * A call retries the nearest of the previous RETRY_LOOKBACK finalized
	 * calls that failed with the same tool and arg key and has not already
	 * been retried. A successful retry closes the chain (being non-error it
	 * cannot itself be retried); a failed retry can be retried in turn.
	 */
	private linkRetry(call: PendingCall): string | undefined {
		if (call.argKey === "") return undefined;
		const window = this.recent.slice(-RETRY_LOOKBACK);
		for (let i = window.length - 1; i >= 0; i--) {
			const candidate = window[i]!;
			if (
				candidate.isError &&
				!candidate.consumed &&
				candidate.tool === call.tool &&
				candidate.argKey === call.argKey
			) {
				candidate.consumed = true;
				return candidate.toolCallId;
			}
		}
		return undefined;
	}

	private hintFor(toolName: string, errorClass: string): string | undefined {
		const key = `${toolName}|${errorClass}`;
		if (this.hinted.has(key)) return undefined;
		const stat = this.remedyStats.get(key);
		if (!stat || stat.attempts < HINT_MIN_ATTEMPTS) return undefined;
		if (stat.successes / stat.attempts < HINT_MIN_RATIO) return undefined;
		this.hinted.add(key);
		const advice = adviceFor(errorClass) ?? GENERIC_ADVICE;
		return (
			`[hindsight] Known error pattern: ${toolName} + ${errorClass} on this machine ` +
			`(seen ${stat.seen}x in past sessions; retry succeeded ${stat.successes}/${stat.attempts} times). ` +
			`Suggested: ${advice}.`
		);
	}
}

// ---------------------------------------------------------------------------
// Wiring: event registration, shared or standalone
// ---------------------------------------------------------------------------

export interface HindsightWiring {
	store: HindsightStore;
	tracker: HindsightTracker;
	config: HindsightConfig;
}

export interface HindsightOptions {
	dbPath: string;
	configPath?: string;
	/**
	 * When false, no before_agent_start handler is registered and the host
	 * folds `store.distillNotes(config)` into its own frozen prompt block
	 * (the learning extension does this). Default true: hindsight injects
	 * its own notes block, frozen per session.
	 */
	injectNotes?: boolean;
}

/**
 * Register hindsight's event handlers. The host chooses the database — the
 * learning extension passes its state.db so the two share one file; the
 * standalone default export resolves the same path on its own.
 */
export function wireHindsight(smolt: ExtensionAPI, options: HindsightOptions): HindsightWiring {
	const config = readHindsightConfig(options.configPath);
	const store = new HindsightStore(options.dbPath);
	const tracker = new HindsightTracker(store);
	if (!config.enabled) return { store, tracker, config };

	let frozenNotes: string | undefined;

	smolt.on("session_start", async (_event, ctx) => {
		frozenNotes = undefined;
		await tracker.onSessionStart(ctx?.sessionManager?.getSessionId?.() ?? "");
	});

	smolt.on("turn_start", async (event) => {
		if (typeof event.turnIndex === "number") tracker.turnIndex = event.turnIndex;
	});

	smolt.on("turn_end", async () => {
		await tracker.onTurnEnd();
	});

	smolt.on("tool_execution_start", async (event) => {
		tracker.onToolStart(event.toolCallId, event.toolName, event.args as Record<string, unknown> | undefined);
	});

	smolt.on("tool_execution_end", async (event) => {
		tracker.onToolEnd(event.toolCallId, event.toolName, event.isError === true);
	});

	smolt.on("tool_result", async (event, ctx) => {
		const hint = tracker.onToolResult(
			event.toolCallId,
			event.toolName,
			event.input,
			event.content,
			event.isError === true,
			ctx?.cwd ?? "",
		);
		if (hint === undefined) return;
		return { content: [...(event.content ?? []), { type: "text" as const, text: hint }] };
	});

	smolt.on("session_shutdown", async () => {
		await tracker.onShutdown();
	});

	if (options.injectNotes !== false) {
		smolt.on("before_agent_start", async (event) => {
			if (frozenNotes === undefined) frozenNotes = await store.distillNotes(config);
			if (frozenNotes === "") return;
			return { systemPrompt: `${event.systemPrompt}\n\n${frozenNotes}` };
		});
	}

	smolt.registerCommand("hindsight", {
		description: "Observed tool-usage breakdown; add a question to ask about the data",
		handler: async (args, ctx) => {
			const query = args.trim();
			const summary = await store.summary();
			if (!summary) {
				ctx.ui.notify("No hindsight data yet — telemetry accumulates as tools run.", "info");
				return;
			}
			if (query === "") {
				smolt.sendMessage({ customType: "hindsight-report", content: renderBreakdown(summary), display: true });
				return;
			}
			const matches = await store.searchCalls(query, 20);
			smolt.sendUserMessage(renderQueryPrompt(query, summary, matches));
		},
	});

	return { store, tracker, config };
}

// Self-contained path resolution (no runtime imports from the host tree) so
// the module stays drop-in portable as a regular extension. Deliberately the
// same state.db the learning extension uses: when both are present they
// share the file; alone, hindsight simply owns its tables within it.
const CONFIG_DIR_NAME = ".smolt";

function getAgentDir(): string {
	const envDir = process.env.SMOLT_CODING_AGENT_DIR;
	if (envDir) {
		return envDir.startsWith("~") ? join(homedir(), envDir.slice(1)) : envDir;
	}
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

export default function hindsightExtension(smolt: ExtensionAPI): void {
	wireHindsight(smolt, {
		dbPath: join(getAgentDir(), "state.db"),
		configPath: join(getAgentDir(), "hindsight.json"),
	});
}
