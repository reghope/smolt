import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";

/**
 * Session search — long-term conversation recall.
 *
 * Single-shape tool with four calling modes (inferred from args):
 *
 *   1. DISCOVERY — pass `query`. Runs FTS5 and dedupes hits by session
 *      lineage. Adaptive detail (default) fully hydrates the top result with
 *      a ±5 message window and bookends, while lower-ranked results keep the
 *      exact anchor message plus metadata. `detail="full"` hydrates every
 *      result. Zero LLM cost.
 *   2. SCROLL — pass `session_id` + `around_message_id`. Returns a window of
 *      ±window messages centered on the anchor, no FTS5, no bookends.
 *   3. READ — pass `session_id` without an anchor. Whole session, or a
 *      bounded head/tail view for large sessions.
 *   4. BROWSE — no args. Recent sessions chronologically.
 *
 * Backed by SQLite FTS5 (node:sqlite) with an incremental index keyed on
 * file mtime+size; degrades to a plain scan when node:sqlite is unavailable.
 */

const DISCOVER_SCAN_LIMIT = 300;
const WINDOW_DEFAULT = 5;
const BOOKEND = 3;
const READ_HEAD = 20;
const READ_TAIL = 10;
const WINDOW_CONTENT_MAX = 4000;
const BOOKEND_CONTENT_MAX = 1200;
const DB_SCHEMA_VERSION = 3;
const DEFAULT_ROLES = ["user", "assistant"];

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

export interface SessionMessage {
	id: number;
	role: string;
	content: string;
	timestamp: string;
}

export interface ParsedSession {
	path: string;
	sessionId: string;
	parent?: string;
	started?: string;
	title?: string;
	model?: string;
	messages: SessionMessage[];
	lastActive: number;
}

export type SearchResult = Record<string, unknown>;

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

interface CandidateHit {
	sessionId: string;
	path: string;
	idx: number;
	role: string;
	ts: string;
	snippet: string;
}

function extractText(content: unknown): string {
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

const MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

/** Format an ISO timestamp as e.g. "August 27, 2026 at 11:47 PM". */
export function formatTimestamp(ts: string | undefined): string {
	if (!ts) return "unknown";
	const date = new Date(ts);
	if (Number.isNaN(date.getTime())) return ts;
	const hours24 = date.getHours();
	const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
	const ampm = hours24 < 12 ? "AM" : "PM";
	const minutes = String(date.getMinutes()).padStart(2, "0");
	return `${MONTHS[date.getMonth()]} ${String(date.getDate()).padStart(2, "0")}, ${date.getFullYear()} at ${String(hours12).padStart(2, "0")}:${minutes} ${ampm}`;
}

function shapeMessage(m: SessionMessage, anchorId?: number, maxContentLen?: number): Record<string, unknown> {
	let content = m.content;
	if (content.includes("\x1b")) content = content.replace(ANSI_RE, "");
	let truncated = false;
	let originalChars: number | undefined;
	if (maxContentLen && content.length > maxContentLen) {
		originalChars = content.length;
		content = `${content.slice(0, maxContentLen)}…`;
		truncated = true;
	}
	const entry: Record<string, unknown> = { id: m.id, role: m.role, content, timestamp: m.timestamp };
	if (anchorId !== undefined && m.id === anchorId) entry.anchor = true;
	if (truncated) {
		entry.content_truncated = true;
		entry.original_content_chars = originalChars;
	}
	return entry;
}

interface AnchoredView {
	window: SessionMessage[];
	messagesBefore: number;
	messagesAfter: number;
	bookendStart: SessionMessage[];
	bookendEnd: SessionMessage[];
}

/** Anchored window plus session bookends. The window is filtered to
 * keepRoles (the anchor itself is always preserved); bookends are the first
 * and last `bookend` keepRoles messages with non-empty content that fall
 * strictly outside the window's id range. */
export function anchoredView(
	messages: SessionMessage[],
	anchorId: number,
	window: number,
	bookend: number,
	keepRoles: string[] | undefined = DEFAULT_ROLES,
): AnchoredView {
	const pos = messages.findIndex((m) => m.id === anchorId);
	if (pos < 0) return { window: [], messagesBefore: 0, messagesAfter: 0, bookendStart: [], bookendEnd: [] };

	const start = Math.max(0, pos - window);
	const end = Math.min(messages.length, pos + window + 1);
	const windowRows = messages.slice(start, end);
	const keepSet = keepRoles ? new Set(keepRoles) : undefined;
	const filteredWindow = keepSet ? windowRows.filter((m) => m.id === anchorId || keepSet.has(m.role)) : windowRows;

	const windowMinId = windowRows[0]!.id;
	const windowMaxId = windowRows[windowRows.length - 1]!.id;

	let bookendStart: SessionMessage[] = [];
	let bookendEnd: SessionMessage[] = [];
	if (bookend > 0) {
		const eligible = (m: SessionMessage): boolean =>
			(keepSet === undefined || keepSet.has(m.role)) && m.content.length > 0;
		bookendStart = messages.filter((m) => m.id < windowMinId && eligible(m)).slice(0, bookend);
		bookendEnd = messages.filter((m) => m.id > windowMaxId && eligible(m)).slice(-bookend);
	}

	return {
		window: filteredWindow,
		messagesBefore: start,
		messagesAfter: messages.length - end,
		bookendStart,
		bookendEnd,
	};
}

function ftsQuote(query: string): string {
	return query
		.split(/\s+/)
		.filter((term) => term !== "")
		.map((term) => `"${term.replaceAll('"', '""')}"`)
		.join(" ");
}

function normalizeTitleQuery(query: string): string {
	return query.trim().replace(/^[`'"]+|[`'"]+$/g, "");
}

function toolError(message: string): SearchResult {
	return { success: false, error: message };
}

export interface SessionSearchParams {
	query?: string;
	role_filter?: string;
	limit?: number;
	session_id?: string;
	around_message_id?: number;
	window?: number;
	sort?: string;
	detail?: string;
}

export class SessionStore {
	private readonly sessionsRoot: string;
	private readonly dbPath: string;
	private readonly forceScan: boolean;
	private db: SqliteDatabase | undefined;
	private sqliteFailed = false;

	constructor(sessionsRoot: string, dbPath: string, options?: { forceScan?: boolean }) {
		this.sessionsRoot = sessionsRoot;
		this.dbPath = dbPath;
		this.forceScan = options?.forceScan ?? false;
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

	listSessionFiles(): string[] {
		if (!existsSync(this.sessionsRoot)) return [];
		const out: string[] = [];
		const walk = (dir: string): void => {
			let entries: string[];
			try {
				entries = readdirSync(dir);
			} catch {
				return;
			}
			for (const name of entries) {
				const full = join(dir, name);
				let st: ReturnType<typeof statSync>;
				try {
					st = statSync(full);
				} catch {
					continue;
				}
				if (st.isDirectory()) walk(full);
				else if (name.endsWith(".jsonl")) out.push(full);
			}
		};
		walk(this.sessionsRoot);
		return out;
	}

	parseSessionFile(path: string): ParsedSession | undefined {
		let raw: string;
		let mtime = 0;
		try {
			raw = readFileSync(path, "utf-8");
			mtime = Math.floor(statSync(path).mtimeMs);
		} catch {
			return undefined;
		}
		const session: ParsedSession = { path, sessionId: "", messages: [], lastActive: mtime };
		for (const line of raw.split("\n")) {
			if (line.trim() === "") continue;
			let entry: {
				type?: string;
				id?: string;
				timestamp?: string;
				cwd?: string;
				parentSession?: string;
				name?: string;
				modelId?: string;
				message?: { role?: string; content?: unknown };
				customType?: string;
				content?: unknown;
			};
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (entry.type === "session") {
				session.sessionId = entry.id ?? "";
				session.started = entry.timestamp;
				session.parent = entry.parentSession;
				continue;
			}
			if (entry.type === "session_info") {
				session.title = entry.name || session.title;
				continue;
			}
			if (entry.type === "model_change") {
				session.model = entry.modelId || session.model;
				continue;
			}
			let role: string | undefined;
			let text = "";
			if (entry.type === "message" && entry.message) {
				role = entry.message.role;
				if (role === "toolResult") {
					// Indexed as role "tool": excluded from default discovery
					// (tool output is usually noise) but reachable via
					// role_filter — facts that only ever appeared in tool
					// output stay recallable.
					role = "tool";
				} else if (role !== "user" && role !== "assistant") {
					continue;
				}
				text = extractText(entry.message.content);
			} else if (entry.type === "custom_message") {
				role = `custom:${entry.customType ?? "unknown"}`;
				text = extractText(entry.content);
			} else {
				continue;
			}
			if (text.trim() === "") continue;
			session.messages.push({
				id: session.messages.length,
				role: role ?? "unknown",
				content: text,
				timestamp: entry.timestamp ?? "",
			});
		}
		if (session.sessionId === "") session.sessionId = path;
		return session;
	}

	private async openDb(): Promise<SqliteDatabase | undefined> {
		if (this.forceScan) return undefined;
		if (this.db) return this.db;
		if (this.sqliteFailed) return undefined;
		try {
			// Computed specifier: node:sqlite ships with the supported Node
			// versions but has no stable type declarations.
			const specifier = "node:sqlite";
			const mod = (await import(specifier)) as { DatabaseSync: new (path: string) => SqliteDatabase };
			mkdirSync(dirname(this.dbPath), { recursive: true });
			const db = new mod.DatabaseSync(this.dbPath);
			const versionRow = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
			if ((versionRow?.user_version ?? 0) !== DB_SCHEMA_VERSION) {
				db.exec("DROP TABLE IF EXISTS files");
				db.exec("DROP TABLE IF EXISTS messages");
				db.exec(`PRAGMA user_version = ${DB_SCHEMA_VERSION}`);
			}
			db.exec(
				"CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, mtime INTEGER, size INTEGER, " +
					"session_id TEXT, parent TEXT, title TEXT, started TEXT, model TEXT, " +
					"message_count INTEGER, preview TEXT)",
			);
			db.exec(
				"CREATE VIRTUAL TABLE IF NOT EXISTS messages USING fts5(" +
					"text, role UNINDEXED, path UNINDEXED, session_id UNINDEXED, idx UNINDEXED, ts UNINDEXED)",
			);
			this.db = db;
			return db;
		} catch {
			this.sqliteFailed = true;
			return undefined;
		}
	}

	private syncIndex(db: SqliteDatabase): void {
		const files = this.listSessionFiles();
		const seen = new Set(files);
		const known = db.prepare("SELECT path, mtime, size FROM files").all() as {
			path: string;
			mtime: number;
			size: number;
		}[];
		for (const row of known) {
			if (!seen.has(row.path)) {
				db.prepare("DELETE FROM messages WHERE path = ?").run(row.path);
				db.prepare("DELETE FROM files WHERE path = ?").run(row.path);
			}
		}
		const knownByPath = new Map(known.map((row) => [row.path, row]));
		const insert = db.prepare(
			"INSERT INTO messages(text, role, path, session_id, idx, ts) VALUES (?, ?, ?, ?, ?, ?)",
		);
		for (const file of files) {
			let st: ReturnType<typeof statSync>;
			try {
				st = statSync(file);
			} catch {
				continue;
			}
			const prior = knownByPath.get(file);
			const mtime = Math.floor(st.mtimeMs);
			if (prior && prior.mtime === mtime && prior.size === st.size) continue;
			const parsed = this.parseSessionFile(file);
			if (!parsed) continue;
			db.prepare("DELETE FROM messages WHERE path = ?").run(file);
			for (const message of parsed.messages) {
				insert.run(message.content, message.role, file, parsed.sessionId, String(message.id), message.timestamp);
			}
			const preview = parsed.messages.find((m) => m.role === "user")?.content.slice(0, 150) ?? "";
			db.prepare(
				"INSERT OR REPLACE INTO files(path, mtime, size, session_id, parent, title, started, model, message_count, preview) " +
					"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			).run(
				file,
				mtime,
				st.size,
				parsed.sessionId,
				parsed.parent ?? null,
				parsed.title ?? null,
				parsed.started ?? null,
				parsed.model ?? null,
				parsed.messages.length,
				preview,
			);
		}
	}

	private metadataRows(db: SqliteDatabase | undefined): ParsedSession[] {
		if (db) {
			const rows = db
				.prepare("SELECT path, session_id, parent, title, started, model, mtime, message_count, preview FROM files")
				.all() as {
				path: string;
				session_id: string;
				parent: string | null;
				title: string | null;
				started: string | null;
				model: string | null;
				mtime: number;
				message_count: number;
				preview: string | null;
			}[];
			return rows.map((row) => ({
				path: row.path,
				sessionId: row.session_id,
				parent: row.parent ?? undefined,
				title: row.title ?? undefined,
				started: row.started ?? undefined,
				model: row.model ?? undefined,
				messages: [],
				lastActive: row.mtime,
				messageCount: row.message_count,
				preview: row.preview ?? "",
			})) as ParsedSession[];
		}
		return this.listSessionFiles()
			.map((path) => this.parseSessionFile(path))
			.filter((session): session is ParsedSession => session !== undefined);
	}

	private resolveLineageRoot(sessionId: string, parents: Map<string, string | undefined>): string {
		const visited = new Set<string>();
		let cur = sessionId;
		while (cur && !visited.has(cur)) {
			visited.add(cur);
			const parent = parents.get(cur);
			if (!parent) break;
			cur = parent;
		}
		return cur;
	}

	private findSessionPath(db: SqliteDatabase | undefined, sessionId: string): string | undefined {
		// Tolerate a file path passed where a session id is expected.
		if ((sessionId.includes(sep) || sessionId.includes("/")) && existsSync(sessionId)) return sessionId;
		if (db) {
			const row = db.prepare("SELECT path FROM files WHERE session_id = ? ORDER BY mtime DESC").get(sessionId) as
				| { path: string }
				| undefined;
			return row?.path;
		}
		for (const path of this.listSessionFiles()) {
			const parsed = this.parseSessionFile(path);
			if (parsed?.sessionId === sessionId) return path;
		}
		return undefined;
	}

	/** Run the tool. `currentSessionId` (when known) is excluded from
	 * discovery and browse, and scroll into it is rejected — that content is
	 * already in the active context. */
	async search(params: SessionSearchParams, currentSessionId?: string): Promise<SearchResult> {
		const db = await this.openDb();
		if (db) this.syncIndex(db);

		const sessionId = typeof params.session_id === "string" ? params.session_id.trim() : "";

		// Scroll shape takes precedence — explicit anchor beats any query.
		if (sessionId !== "" && params.around_message_id !== undefined && params.around_message_id !== null) {
			return this.scroll(db, sessionId, params.around_message_id, params.window ?? WINDOW_DEFAULT, currentSessionId);
		}

		// Read shape: a session_id with no anchor → dump the whole session.
		if (sessionId !== "") {
			return this.read(db, sessionId);
		}

		let limit = typeof params.limit === "number" && Number.isFinite(params.limit) ? Math.trunc(params.limit) : 3;
		limit = Math.max(1, Math.min(limit, 10));

		// Browse shape: no query → recent sessions.
		const query = typeof params.query === "string" ? params.query.trim() : "";
		if (query === "") {
			return this.browse(db, limit, currentSessionId);
		}

		let roleList = DEFAULT_ROLES;
		if (typeof params.role_filter === "string" && params.role_filter.trim() !== "") {
			roleList = params.role_filter
				.split(",")
				.map((role) => role.trim())
				.filter((role) => role !== "");
		}

		let sort: "newest" | "oldest" | undefined;
		if (typeof params.sort === "string") {
			const candidate = params.sort.trim().toLowerCase();
			if (candidate === "newest" || candidate === "oldest") sort = candidate;
		}

		const detail =
			typeof params.detail === "string" && params.detail.trim().toLowerCase() === "full" ? "full" : "adaptive";

		return this.discover(db, query, roleList, limit, sort, detail, currentSessionId);
	}

	private discover(
		db: SqliteDatabase | undefined,
		query: string,
		roleList: string[],
		limit: number,
		sort: "newest" | "oldest" | undefined,
		detail: "adaptive" | "full",
		currentSessionId: string | undefined,
	): SearchResult {
		const metadata = this.metadataRows(db);
		const parents = new Map(metadata.map((s) => [s.sessionId, s.parent]));
		const byId = new Map(metadata.map((s) => [s.sessionId, s]));
		const currentRoot = currentSessionId ? this.resolveLineageRoot(currentSessionId, parents) : undefined;

		// Title match: an exact (case-insensitive) session-title hit surfaces
		// that session as a full-detail result ahead of the FTS rows.
		const titleQuery = normalizeTitleQuery(query);
		let titleSession: ParsedSession | undefined;
		if (titleQuery !== "") {
			const candidates = metadata
				.filter((s) => s.title && s.title.toLowerCase() === titleQuery.toLowerCase())
				.filter((s) => s.sessionId !== currentSessionId)
				.sort((a, b) => b.lastActive - a.lastActive);
			titleSession = candidates[0];
		}

		let raw: CandidateHit[];
		try {
			raw = db ? this.searchDb(db, query, roleList, sort) : this.searchScan(query, roleList, sort);
		} catch (e) {
			return toolError(`Search failed: ${e instanceof Error ? e.message : String(e)}`);
		}

		if (raw.length === 0 && !titleSession) {
			return {
				success: true,
				mode: "discover",
				query,
				detail,
				results: [],
				count: 0,
				message: "No matching sessions found.",
			};
		}

		// Dedupe by lineage: one result per session lineage, first (best
		// ranked) hit wins. The current session is excluded — its content is
		// already in the active context.
		const seenRoots = new Map<string, CandidateHit | { titleOnly: true }>();
		const results: SearchResult[] = [];

		if (titleSession) {
			const root = this.resolveLineageRoot(titleSession.sessionId, parents);
			seenRoots.set(root, { titleOnly: true });
			const parsed = this.parseSessionFile(titleSession.path);
			if (parsed && parsed.messages.length > 0) {
				const anchorId = parsed.messages[0]!.id;
				const view = anchoredView(parsed.messages, anchorId, WINDOW_DEFAULT, BOOKEND);
				results.push({
					session_id: parsed.sessionId,
					when: formatTimestamp(parsed.started),
					model: parsed.model ?? "unknown",
					title: parsed.title ?? titleQuery,
					matched_role: "session_title",
					match_message_id: anchorId,
					snippet: `Session title matched: ${parsed.title ?? titleQuery}`,
					bookend_start: view.bookendStart.map((m) => shapeMessage(m)),
					messages: view.window.map((m) => shapeMessage(m, anchorId)),
					bookend_end: view.bookendEnd.map((m) => shapeMessage(m)),
					messages_before: view.messagesBefore,
					messages_after: view.messagesAfter,
					detail: "full",
				});
			}
		}

		for (const hit of raw) {
			if (seenRoots.size >= limit) break;
			if (currentSessionId && hit.sessionId === currentSessionId) continue;
			const root = this.resolveLineageRoot(hit.sessionId, parents);
			if (currentRoot && root === currentRoot && hit.sessionId === currentSessionId) continue;
			if (!seenRoots.has(root)) seenRoots.set(root, hit);
		}

		for (const [root, match] of seenRoots) {
			if ("titleOnly" in match) continue;
			const hit = match as CandidateHit;
			const parsed = this.parseSessionFile(hit.path);
			if (!parsed) continue;
			const meta = byId.get(root);

			const resultDetail = detail === "full" || results.length === 0 ? "full" : "compact";
			const view = anchoredView(parsed.messages, hit.idx, WINDOW_DEFAULT, BOOKEND);
			let windowMessages = view.window;
			if (resultDetail === "compact") windowMessages = windowMessages.filter((m) => m.id === hit.idx);

			const entry: SearchResult = {
				session_id: hit.sessionId,
				when: formatTimestamp(parsed.started ?? meta?.started),
				model: parsed.model ?? meta?.model ?? "unknown",
				title: parsed.title ?? null,
				matched_role: hit.role,
				match_message_id: hit.idx,
				snippet: hit.snippet,
				bookend_start:
					resultDetail === "full"
						? view.bookendStart.map((m) => shapeMessage(m, undefined, BOOKEND_CONTENT_MAX))
						: [],
				messages: windowMessages.map((m) => shapeMessage(m, hit.idx, WINDOW_CONTENT_MAX)),
				bookend_end:
					resultDetail === "full"
						? view.bookendEnd.map((m) => shapeMessage(m, undefined, BOOKEND_CONTENT_MAX))
						: [],
				messages_before: view.messagesBefore,
				messages_after: view.messagesAfter,
				detail: resultDetail,
			};
			if (root !== hit.sessionId) entry.parent_session_id = root;
			results.push(entry);
		}

		return {
			success: true,
			mode: "discover",
			query,
			detail,
			results,
			count: results.length,
			sessions_searched: seenRoots.size,
		};
	}

	private searchDb(
		db: SqliteDatabase,
		query: string,
		roleList: string[],
		sort: "newest" | "oldest" | undefined,
	): CandidateHit[] {
		const rolePlaceholders = roleList.map(() => "?").join(",");
		const order = sort === "newest" ? "ts DESC" : sort === "oldest" ? "ts ASC" : "rank";
		const select =
			"SELECT path, session_id, idx, role, ts, snippet(messages, 0, '>>>', '<<<', '...', 40) AS snippet " +
			`FROM messages WHERE messages MATCH ? AND role IN (${rolePlaceholders}) ORDER BY ${order} LIMIT ?`;
		let rows: unknown[];
		try {
			rows = db.prepare(select).all(query, ...roleList, DISCOVER_SCAN_LIMIT);
		} catch {
			rows = db.prepare(select).all(ftsQuote(query), ...roleList, DISCOVER_SCAN_LIMIT);
		}
		return (
			rows as { path: string; session_id: string; idx: string; role: string; ts: string; snippet: string }[]
		).map((row) => ({
			path: row.path,
			sessionId: row.session_id,
			idx: Number(row.idx),
			role: row.role,
			ts: row.ts,
			snippet: row.snippet,
		}));
	}

	private searchScan(query: string, roleList: string[], sort: "newest" | "oldest" | undefined): CandidateHit[] {
		const terms = query
			.toLowerCase()
			.split(/\s+/)
			.map((term) => term.replace(/^"+|"+$/g, ""))
			.filter((term) => term !== "");
		const roleSet = new Set(roleList);
		const hits: CandidateHit[] = [];
		const files = this.listSessionFiles()
			.map((path) => ({ path, mtime: safeMtime(path) }))
			.sort((a, b) => b.mtime - a.mtime);
		for (const { path } of files) {
			const parsed = this.parseSessionFile(path);
			if (!parsed) continue;
			for (const message of parsed.messages) {
				if (!roleSet.has(message.role)) continue;
				const lower = message.content.toLowerCase();
				if (!terms.every((term) => lower.includes(term))) continue;
				const pos = lower.indexOf(terms[0] ?? "");
				const matchLen = (terms[0] ?? "").length;
				const before = message.content.slice(Math.max(0, pos - 40), pos);
				const match = message.content.slice(pos, pos + matchLen);
				const after = message.content.slice(pos + matchLen, pos + matchLen + 40);
				hits.push({
					path,
					sessionId: parsed.sessionId,
					idx: message.id,
					role: message.role,
					ts: message.timestamp,
					snippet: `...${before}>>>${match}<<<${after}...`,
				});
				if (hits.length >= DISCOVER_SCAN_LIMIT) break;
			}
			if (hits.length >= DISCOVER_SCAN_LIMIT) break;
		}
		if (sort === "newest") hits.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
		if (sort === "oldest") hits.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
		return hits;
	}

	private scroll(
		db: SqliteDatabase | undefined,
		sessionId: string,
		aroundMessageId: number,
		window: number,
		currentSessionId: string | undefined,
	): SearchResult {
		const anchor = Math.trunc(Number(aroundMessageId));
		if (!Number.isFinite(anchor)) return toolError("scroll requires integer around_message_id");
		let win = Math.trunc(Number(window));
		if (!Number.isFinite(win)) win = WINDOW_DEFAULT;
		win = Math.max(1, Math.min(win, 20));

		if (currentSessionId && sessionId === currentSessionId) {
			return toolError("scroll rejected: anchor lives in the current session (already in your active context)");
		}

		const path = this.findSessionPath(db, sessionId);
		if (!path) return toolError(`session_id not found: ${sessionId}`);
		const parsed = this.parseSessionFile(path);
		if (!parsed) return toolError(`session_id not found: ${sessionId}`);

		const view = anchoredView(parsed.messages, anchor, win, 0, undefined);
		if (view.window.length === 0) {
			return toolError(`around_message_id ${anchor} not in session_id ${sessionId}`);
		}

		return {
			success: true,
			mode: "scroll",
			session_id: parsed.sessionId,
			around_message_id: anchor,
			session_meta: {
				when: formatTimestamp(parsed.started),
				model: parsed.model ?? null,
				title: parsed.title ?? null,
			},
			window: win,
			messages: view.window.map((m) => shapeMessage(m, anchor)),
			messages_before: view.messagesBefore,
			messages_after: view.messagesAfter,
		};
	}

	private read(db: SqliteDatabase | undefined, sessionId: string): SearchResult {
		const path = this.findSessionPath(db, sessionId);
		if (!path) return toolError(`session_id not found: ${sessionId}`);
		const parsed = this.parseSessionFile(path);
		if (!parsed) return toolError(`session_id not found: ${sessionId}`);

		const shaped = parsed.messages.map((m) => shapeMessage(m));
		const total = shaped.length;
		const truncated = total > READ_HEAD + READ_TAIL;
		const window = truncated ? [...shaped.slice(0, READ_HEAD), ...shaped.slice(-READ_TAIL)] : shaped;

		const response: SearchResult = {
			success: true,
			mode: "read",
			session_id: parsed.sessionId,
			session_meta: {
				when: formatTimestamp(parsed.started),
				model: parsed.model ?? null,
				title: parsed.title ?? null,
			},
			message_count: total,
			truncated,
			messages: window,
		};
		if (truncated) {
			response.message =
				`Session has ${total} messages; showing first ${READ_HEAD} + last ${READ_TAIL}. ` +
				"Pass around_message_id (any id above) to scroll the middle.";
		}
		return response;
	}

	private browse(db: SqliteDatabase | undefined, limit: number, currentSessionId: string | undefined): SearchResult {
		const metadata = this.metadataRows(db)
			.filter((s) => s.sessionId !== currentSessionId)
			.sort((a, b) => b.lastActive - a.lastActive);

		const results = metadata.slice(0, limit).map((s) => {
			const withCounts = s as ParsedSession & { messageCount?: number; preview?: string };
			let messageCount = withCounts.messageCount;
			let preview = withCounts.preview;
			if (messageCount === undefined) {
				messageCount = s.messages.length;
				preview = s.messages.find((m) => m.role === "user")?.content.slice(0, 150) ?? "";
			}
			return {
				session_id: s.sessionId,
				title: s.title ?? null,
				started_at: s.started ?? "",
				last_active: new Date(s.lastActive).toISOString(),
				message_count: messageCount,
				preview: preview ?? "",
			};
		});

		return {
			success: true,
			mode: "browse",
			results,
			count: results.length,
			message: `Showing ${results.length} most recent sessions. Pass a query= to search, or session_id+around_message_id to scroll.`,
		};
	}
}

function safeMtime(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}
