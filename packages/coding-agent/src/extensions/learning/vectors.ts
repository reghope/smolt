import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Vector storage for semantic recall.
 *
 * Shares the learning extension's state.db, and versions its own `vec_*`
 * tables through `vec_meta` with migrations that keep every row — the same
 * arrangement hindsight uses, and for a sharper reason. The session index
 * migrates by drop-and-rebuild, which is free when rebuilding means
 * re-running an FTS insert. Rebuilding vectors means re-embedding every
 * message, so a schema bump must never trigger it: a table may be rebuilt
 * to change its key, but only by copying every row across.
 *
 * One row is one chunk of one message, keyed (path, idx, chunk). Short
 * messages are one chunk; a long one is several, stored and replaced as a
 * set. `vec_files` remembers each session file's size and mtime after a
 * complete run, so a start skips unchanged files without reading them.
 *
 * SQLite is the container, not the search engine. The query is "score one
 * vector against all of them and keep the best few", which is a dot product
 * over a contiguous Float32Array — vectors arrive unit-normalized from
 * embeddings.ts, so no per-row division is needed. At session-history scale
 * (thousands of messages, not millions) the scan is imperceptible, and the
 * cost that would show up first is deserializing BLOBs, which is why the
 * matrix is built once per process and appended to in place.
 *
 * Everything degrades quietly: no node:sqlite, no store, and the caller
 * falls back to whatever it did before vectors existed.
 */

const CACHE_GROWTH = 1.5;

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
 * Migration ladder. Each entry is one version's statements; new versions
 * append. Existing entries are never edited and no vector is ever lost,
 * because re-embedding is expensive enough to feel like data loss.
 */
const MIGRATIONS: string[][] = [
	[
		"CREATE TABLE IF NOT EXISTS vec_chunks (" +
			"path TEXT NOT NULL, " +
			"idx INTEGER NOT NULL, " +
			"session_id TEXT NOT NULL, " +
			"role TEXT NOT NULL, " +
			"ts TEXT NOT NULL DEFAULT '', " +
			"content_hash TEXT NOT NULL, " +
			"vec BLOB NOT NULL, " +
			"PRIMARY KEY (path, idx))",
		"CREATE INDEX IF NOT EXISTS idx_vec_session ON vec_chunks(session_id)",
	],
	// Version 2: one row per chunk, so a long message keeps its tail. The
	// key gains a chunk column, which SQLite cannot add in place; every
	// existing row is copied across as chunk 0 of its message.
	[
		"CREATE TABLE IF NOT EXISTS vec_chunks_v2 (" +
			"path TEXT NOT NULL, " +
			"idx INTEGER NOT NULL, " +
			"chunk INTEGER NOT NULL DEFAULT 0, " +
			"session_id TEXT NOT NULL, " +
			"role TEXT NOT NULL, " +
			"ts TEXT NOT NULL DEFAULT '', " +
			"content_hash TEXT NOT NULL, " +
			"vec BLOB NOT NULL, " +
			"PRIMARY KEY (path, idx, chunk))",
		"INSERT OR IGNORE INTO vec_chunks_v2 (path, idx, chunk, session_id, role, ts, content_hash, vec) " +
			"SELECT path, idx, 0, session_id, role, ts, content_hash, vec FROM vec_chunks",
		"DROP TABLE vec_chunks",
		"ALTER TABLE vec_chunks_v2 RENAME TO vec_chunks",
		"CREATE INDEX IF NOT EXISTS idx_vec_session ON vec_chunks(session_id)",
		"CREATE TABLE IF NOT EXISTS vec_files (" +
			"path TEXT PRIMARY KEY, " +
			"mtime INTEGER NOT NULL, " +
			"size INTEGER NOT NULL, " +
			"complete INTEGER NOT NULL DEFAULT 0)",
	],
];

export interface VectorChunk {
	path: string;
	idx: number;
	/** Position within the message; 0 for a message that fit in one chunk. */
	chunk: number;
	sessionId: string;
	role: string;
	ts: string;
	contentHash: string;
	vec: Float32Array;
}

export interface FileState {
	mtime: number;
	size: number;
	/** True when every embeddable message in the file had a vector at the end of the run. */
	complete: boolean;
}

export interface VectorHit {
	path: string;
	idx: number;
	chunk: number;
	sessionId: string;
	role: string;
	ts: string;
	/** Cosine similarity in [-1, 1]; higher is closer. */
	score: number;
}

interface CachedRow {
	path: string;
	idx: number;
	chunk: number;
	sessionId: string;
	role: string;
	ts: string;
}

/**
 * Content fingerprint. Truncated to 16 hex chars: this only has to detect
 * that a message changed, and the full digest would cost more disk than the
 * collision risk is worth at this scale.
 */
export function hashChunk(text: string): string {
	return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

/**
 * Little-endian float32 BLOB. Written and read through a DataView rather
 * than a Float32Array view, because a BLOB read back from SQLite carries no
 * alignment guarantee and `new Float32Array(buffer, byteOffset)` throws on
 * an unaligned one.
 */
export function serializeVector(vec: Float32Array): Uint8Array {
	const bytes = new Uint8Array(vec.length * 4);
	const view = new DataView(bytes.buffer);
	for (let i = 0; i < vec.length; i++) view.setFloat32(i * 4, vec[i]!, true);
	return bytes;
}

export function deserializeVector(bytes: Uint8Array, out: Float32Array, offset: number): void {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const count = Math.floor(bytes.byteLength / 4);
	for (let i = 0; i < count; i++) out[offset + i] = view.getFloat32(i * 4, true);
}

export class VectorStore {
	private readonly dbPath: string;
	private db: SqliteDatabase | undefined;
	private sqliteFailed = false;
	private storedDim = 0;
	private cache: { rows: CachedRow[]; matrix: Float32Array; dim: number } | undefined;

	constructor(dbPath: string) {
		this.dbPath = dbPath;
	}

	/** True once an open attempt failed: semantic recall is silently off. */
	get unavailable(): boolean {
		return this.sqliteFailed;
	}

	/** Vector width the stored rows use; 0 when nothing is stored yet. */
	get dim(): number {
		return this.storedDim;
	}

	close(): void {
		try {
			this.db?.close?.();
		} catch {
			// already closed
		}
		this.db = undefined;
		this.cache = undefined;
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
			// The session index, hindsight, and other smolt sessions write to
			// this same file; wait for the lock rather than dropping work.
			db.exec("PRAGMA busy_timeout = 2000");
			db.exec("CREATE TABLE IF NOT EXISTS vec_meta(key TEXT PRIMARY KEY, value TEXT)");
			const row = db.prepare("SELECT value FROM vec_meta WHERE key = 'schema_version'").get() as
				| { value?: string }
				| undefined;
			const version = row?.value ? Number(row.value) : 0;
			for (let i = version; i < MIGRATIONS.length; i++) {
				for (const sql of MIGRATIONS[i]!) db.exec(sql);
			}
			if (version < MIGRATIONS.length) {
				db.prepare("INSERT OR REPLACE INTO vec_meta(key, value) VALUES ('schema_version', ?)").run(
					String(MIGRATIONS.length),
				);
			}
			this.storedDim = Number(this.readMeta(db, "dim") ?? "0");
			this.db = db;
			return db;
		} catch {
			this.sqliteFailed = true;
			return undefined;
		}
	}

	private readMeta(db: SqliteDatabase, key: string): string | undefined {
		const row = db.prepare("SELECT value FROM vec_meta WHERE key = ?").get(key) as { value?: string } | undefined;
		return row?.value;
	}

	private writeMeta(db: SqliteDatabase, key: string, value: string): void {
		db.prepare("INSERT OR REPLACE INTO vec_meta(key, value) VALUES (?, ?)").run(key, value);
	}

	private discardAll(db: SqliteDatabase): void {
		db.exec("DELETE FROM vec_chunks");
		db.exec("DELETE FROM vec_files");
		this.cache = undefined;
		this.storedDim = 0;
	}

	/**
	 * Open the store for a given embedding model, discarding everything if
	 * the model changed. Vectors from two models are not comparable, so a
	 * swapped model has to mean a rebuild rather than a silently mixed index.
	 * Returns false when SQLite is unavailable.
	 */
	async open(modelId: string): Promise<boolean> {
		const db = await this.openDb();
		if (!db) return false;
		try {
			const stored = this.readMeta(db, "model");
			if (stored !== modelId) {
				if (stored !== undefined) this.discardAll(db);
				this.writeMeta(db, "model", modelId);
			}
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Content hashes already stored for one session file, keyed by message
	 * id. A message's chunks are written as one set, so its first chunk
	 * stands for all of them.
	 */
	async hashesForPath(path: string): Promise<Map<number, string>> {
		const out = new Map<number, string>();
		const db = await this.openDb();
		if (!db) return out;
		try {
			const rows = db.prepare("SELECT idx, content_hash FROM vec_chunks WHERE path = ? AND chunk = 0").all(path) as {
				idx: number;
				content_hash: string;
			}[];
			for (const row of rows) out.set(Number(row.idx), row.content_hash);
		} catch {
			// An unreadable index is an empty one: everything re-embeds.
		}
		return out;
	}

	/** Every session file path with stored vectors, for pruning deleted files. */
	async knownPaths(): Promise<string[]> {
		const db = await this.openDb();
		if (!db) return [];
		try {
			const rows = db.prepare("SELECT DISTINCT path FROM vec_chunks").all() as { path: string }[];
			return rows.map((row) => row.path);
		} catch {
			return [];
		}
	}

	/** What a complete index run last saw of one session file. */
	async fileState(path: string): Promise<FileState | undefined> {
		const db = await this.openDb();
		if (!db) return undefined;
		try {
			const row = db.prepare("SELECT mtime, size, complete FROM vec_files WHERE path = ?").get(path) as
				| { mtime: number; size: number; complete: number }
				| undefined;
			if (!row) return undefined;
			return { mtime: Number(row.mtime), size: Number(row.size), complete: Number(row.complete) === 1 };
		} catch {
			return undefined;
		}
	}

	async setFileState(path: string, state: FileState): Promise<void> {
		const db = await this.openDb();
		if (!db) return;
		try {
			db.prepare("INSERT OR REPLACE INTO vec_files(path, mtime, size, complete) VALUES (?, ?, ?, ?)").run(
				path,
				Math.floor(state.mtime),
				Math.floor(state.size),
				state.complete ? 1 : 0,
			);
		} catch {
			// Forgetting a file's state only costs one re-read next start.
		}
	}

	/**
	 * Store vectors. Every chunk of a message in the batch replaces every
	 * chunk previously stored for that message, so a message that shrank
	 * leaves no stale tail behind. A width that disagrees with what is
	 * stored discards the index first: same model id, different geometry
	 * means the server swapped the weights underneath.
	 */
	async put(chunks: VectorChunk[]): Promise<void> {
		if (chunks.length === 0) return;
		const db = await this.openDb();
		if (!db) return;
		const dim = chunks[0]!.vec.length;
		for (const chunk of chunks) {
			if (chunk.vec.length !== dim) throw new Error("Cannot store vectors of mixed width");
		}
		try {
			if (this.storedDim !== 0 && this.storedDim !== dim) this.discardAll(db);
			if (this.storedDim !== dim) {
				this.writeMeta(db, "dim", String(dim));
				this.storedDim = dim;
			}
			const clear = db.prepare("DELETE FROM vec_chunks WHERE path = ? AND idx = ?");
			const insert = db.prepare(
				"INSERT OR REPLACE INTO vec_chunks(path, idx, chunk, session_id, role, ts, content_hash, vec) " +
					"VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			);
			db.exec("BEGIN");
			try {
				const cleared = new Set<string>();
				for (const chunk of chunks) {
					const key = `${chunk.path}\u0000${chunk.idx}`;
					if (!cleared.has(key)) {
						clear.run(chunk.path, chunk.idx);
						cleared.add(key);
					}
				}
				for (const chunk of chunks) {
					insert.run(
						chunk.path,
						chunk.idx,
						chunk.chunk,
						chunk.sessionId,
						chunk.role,
						chunk.ts,
						chunk.contentHash,
						serializeVector(chunk.vec),
					);
				}
				db.exec("COMMIT");
			} catch (e) {
				db.exec("ROLLBACK");
				throw e;
			}
			this.cache = undefined;
		} catch {
			// A failed write costs recall, never the session.
		}
	}

	async deletePaths(paths: string[]): Promise<void> {
		if (paths.length === 0) return;
		const db = await this.openDb();
		if (!db) return;
		try {
			const del = db.prepare("DELETE FROM vec_chunks WHERE path = ?");
			const forget = db.prepare("DELETE FROM vec_files WHERE path = ?");
			db.exec("BEGIN");
			try {
				for (const path of paths) {
					del.run(path);
					forget.run(path);
				}
				db.exec("COMMIT");
			} catch (e) {
				db.exec("ROLLBACK");
				throw e;
			}
			this.cache = undefined;
		} catch {
			// Stale rows are survivable; they lose to fresher ones on rank.
		}
	}

	async count(): Promise<number> {
		const db = await this.openDb();
		if (!db) return 0;
		try {
			const row = db.prepare("SELECT COUNT(*) AS n FROM vec_chunks").get() as { n?: number } | undefined;
			return Number(row?.n ?? 0);
		} catch {
			return 0;
		}
	}

	/**
	 * Load every vector into one contiguous Float32Array. Done once per
	 * process and dropped on any write: the per-query cost that matters is
	 * pulling thousands of BLOBs through SQLite, not the arithmetic.
	 */
	private loadCache(db: SqliteDatabase): { rows: CachedRow[]; matrix: Float32Array; dim: number } | undefined {
		if (this.cache) return this.cache;
		const dim = this.storedDim;
		if (dim === 0) return undefined;
		const rows: CachedRow[] = [];
		let matrix = new Float32Array(dim * 256);
		let count = 0;
		const stored = db
			.prepare("SELECT path, idx, chunk, session_id, role, ts, vec FROM vec_chunks ORDER BY path, idx, chunk")
			.all() as {
			path: string;
			idx: number;
			chunk: number;
			session_id: string;
			role: string;
			ts: string;
			vec: Uint8Array;
		}[];
		for (const row of stored) {
			if (!(row.vec instanceof Uint8Array) || row.vec.byteLength !== dim * 4) continue;
			if ((count + 1) * dim > matrix.length) {
				const grown = new Float32Array(Math.ceil(matrix.length * CACHE_GROWTH) + dim);
				grown.set(matrix);
				matrix = grown;
			}
			deserializeVector(row.vec, matrix, count * dim);
			rows.push({
				path: row.path,
				idx: Number(row.idx),
				chunk: Number(row.chunk),
				sessionId: row.session_id,
				role: row.role,
				ts: row.ts,
			});
			count++;
		}
		this.cache = { rows, matrix, dim };
		return this.cache;
	}

	/**
	 * Top `limit` chunks by cosine similarity, above `minScore` (default: any
	 * positive similarity). The floor matters more than it looks. Full-text
	 * search returns nothing when nothing matches, but a nearest-neighbour
	 * search always has a nearest neighbour — without a floor, a question
	 * about something never discussed comes back with whatever was least
	 * unrelated, and rank fusion would treat that as a real hit.
	 *
	 * Returns nothing when the query vector disagrees with the stored width:
	 * the next write repairs the index, and a read is the wrong place to
	 * throw data away.
	 */
	async search(
		query: Float32Array,
		options: { roles?: string[]; limit: number; minScore?: number },
	): Promise<VectorHit[]> {
		const db = await this.openDb();
		if (!db) return [];
		const limit = Math.max(1, Math.floor(options.limit));
		let cache: { rows: CachedRow[]; matrix: Float32Array; dim: number } | undefined;
		try {
			cache = this.loadCache(db);
		} catch {
			return [];
		}
		if (!cache || cache.dim !== query.length) return [];
		const roles = options.roles ? new Set(options.roles) : undefined;
		const floor = options.minScore ?? 0;
		const { rows, matrix, dim } = cache;

		// Bounded insertion beats sorting every row: `limit` is small, so the
		// worst case is a short shift and most rows fail the threshold test.
		const best: VectorHit[] = [];
		let threshold = Number.NEGATIVE_INFINITY;
		for (let r = 0; r < rows.length; r++) {
			const row = rows[r]!;
			if (roles && !roles.has(row.role)) continue;
			let score = 0;
			const base = r * dim;
			for (let i = 0; i < dim; i++) score += matrix[base + i]! * query[i]!;
			if (score <= floor) continue;
			if (best.length === limit && score <= threshold) continue;
			let at = best.length;
			while (at > 0 && best[at - 1]!.score < score) at--;
			best.splice(at, 0, { ...row, score });
			if (best.length > limit) best.pop();
			threshold = best[best.length - 1]!.score;
		}
		return best;
	}
}
