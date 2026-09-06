import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Deleting everything the agent has accumulated on this machine.
 *
 * "Local data" is what smolt has written about your work: chats, the memory
 * it curates, the skills it wrote, the cues, the tool telemetry, and the
 * indexes over them. It is deliberately NOT your credentials or your
 * settings — losing an API key is unrecoverable from inside the app, and a
 * wipe is meant to clear history, not to sign you out. Those are listed here
 * as `KEPT` so the reason is written down next to the code that spares them.
 */

function agentDir(): string {
	const envDir = process.env.SMOLT_CODING_AGENT_DIR;
	return envDir?.trim()
		? envDir.startsWith("~")
			? join(homedir(), envDir.slice(1))
			: envDir
		: join(homedir(), ".smolt", "agent");
}

/** Never removed, and why. */
export const KEPT = [
	"auth.json — provider credentials",
	"pool.json — pooled credentials",
	"telegram.json — bot credentials",
	"settings.json — your preferences",
	"trust.json — project trust decisions",
];

export interface WipeTarget {
	/** Shown to the reader before they confirm. */
	label: string;
	path: string;
	/**
	 * A SQLite database. If the file itself cannot go — another smolt has it
	 * open — its rows are deleted instead, which reaches the same data.
	 */
	database?: boolean;
	/** Removed with the target, and only if the target itself goes. */
	sidecars?: string[];
}

/** Everything a wipe removes, resolved against the agent directory in use. */
export function wipeTargets(): WipeTarget[] {
	const dir = agentDir();
	// The memories live beside the agent directory rather than under it, so
	// they follow it: pointing SMOLT_CODING_AGENT_DIR at a scratch directory
	// has to move every target, or a test run reaches the real ones.
	const stateDb = join(dir, "state.db");
	return [
		{ label: "Chats", path: join(dir, "sessions") },
		{ label: "Memory (MEMORY.md, USER.md)", path: join(dirname(dir), "memories") },
		{ label: "Skills the agent wrote", path: join(dir, "skills") },
		{ label: "Cues", path: join(dir, "cues") },
		{
			label: "Session index and tool telemetry",
			path: stateDb,
			database: true,
			// SQLite's sidecars: leaving them behind would restore rows into a
			// database that is supposed to be gone.
			sidecars: [`${stateDb}-wal`, `${stateDb}-shm`],
		},
		{ label: "Scratch files", path: join(dir, "scratch") },
	];
}

export interface WipeReport {
	removed: string[];
	/** Paths that resisted deletion, with the reason. */
	failed: { path: string; error: string }[];
}

/** The little of node:sqlite this file uses. */
interface SqliteDatabase {
	exec(sql: string): void;
	prepare(sql: string): { all(): unknown[] };
	close(): void;
}

/**
 * Empty a database in place, for when the file itself cannot be deleted.
 *
 * Windows refuses to unlink a file that another process holds open, and one
 * state.db is shared by every smolt on the machine: other windows, terminals,
 * a bot. Stopping this app's own agents therefore is not enough to free it.
 * Deleting the rows reaches the same data, leaves the schema for the holders
 * that are mid-query, and needs nothing from them.
 *
 * Returns nothing when the database is empty afterwards, or the reason it
 * could not be emptied.
 */
export async function emptyDatabase(path: string): Promise<string | undefined> {
	let db: SqliteDatabase | undefined;
	try {
		// Computed specifier: node:sqlite ships with the Node inside Electron,
		// and the bundler must leave the import alone.
		const specifier = "node:sqlite";
		const mod = (await import(specifier)) as { DatabaseSync: new (file: string) => SqliteDatabase };
		db = new mod.DatabaseSync(path);
		// Another smolt may be mid-write; wait for it rather than failing.
		db.exec("PRAGMA busy_timeout = 5000");
		const rows = db
			.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
			.all() as { name: string; sql: string | null }[];
		// A virtual table owns shadow tables (`messages`, then `messages_data`
		// and the rest). Deleting from the virtual table clears them all;
		// writing to a shadow table directly is refused, and would corrupt the
		// index it belongs to if it were not.
		const virtual = rows.filter((row) => /^\s*create\s+virtual\s+table/i.test(row.sql ?? "")).map((row) => row.name);
		const tables = rows.filter((row) => !virtual.some((name) => row.name.startsWith(`${name}_`)));
		db.exec("BEGIN IMMEDIATE");
		for (const table of tables) db.exec(`DELETE FROM "${table.name.replaceAll('"', '""')}"`);
		db.exec("COMMIT");
		try {
			// Give the disk space back. A reader holding the database can refuse
			// this, and an emptied database that is still large is no reason to
			// call the wipe a failure.
			db.exec("VACUUM");
		} catch {
			// Left as it is.
		}
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	} finally {
		try {
			db?.close();
		} catch {
			// Already gone.
		}
	}
}

/** Windows hands back a lock a moment after the holder lets go; wait for it. */
const REMOVE_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const;

/**
 * Delete a file or a whole tree, and when something inside will not go, take
 * everything around it rather than stopping there.
 *
 * A single locked file used to abort the entire branch and leave the rest of
 * a reader's history sitting on disk. Windows locks are ordinary here: a
 * scratch directory is some running program's working directory, a log is
 * open. What survives is returned, so the reader is told exactly what stayed
 * instead of being told the wipe failed.
 *
 * An emptied directory that itself refuses to go is not counted as survivor:
 * nothing of the reader's is left in it.
 */
function removeTree(path: string): { path: string; error: string }[] {
	let message: string;
	try {
		rmSync(path, REMOVE_OPTIONS);
		return [];
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}
	let entries: { name: string }[];
	try {
		entries = readdirSync(path, { withFileTypes: true });
	} catch {
		// A file, or a directory that will not even open: it stays.
		return [{ path, error: message }];
	}
	const left = entries.flatMap((entry) => removeTree(join(path, entry.name)));
	if (left.length > 0) return left;
	try {
		rmSync(path, REMOVE_OPTIONS);
	} catch {
		// Emptied but still there, which is what Windows does with a directory
		// a running program is sitting in. The data inside it is gone.
	}
	return [];
}

/**
 * Delete every target that exists.
 *
 * The agents this app started must already be stopped: on Windows a running
 * one holds state.db open, and an open handle makes the delete fail rather
 * than the database disappear. Agents belonging to other smolts are outside
 * this app's reach, so the database is emptied in place when its file cannot
 * be removed, and every other target gives up as much as it can.
 */
export async function wipeLocalData(): Promise<WipeReport> {
	const report: WipeReport = { removed: [], failed: [] };
	for (const target of wipeTargets()) {
		if (!existsSync(target.path)) continue;
		const left = removeTree(target.path);
		if (left.length === 0) {
			for (const sidecar of target.sidecars ?? []) removeTree(sidecar);
			report.removed.push(target.label);
			continue;
		}
		if (target.database) {
			const refused = await emptyDatabase(target.path);
			if (refused === undefined) {
				report.removed.push(`${target.label} (emptied: another Smolt is holding the file open)`);
				continue;
			}
			report.failed.push({ path: target.path, error: `it could not be emptied either: ${refused}` });
			continue;
		}
		for (const survivor of left) {
			report.failed.push({ path: survivor.path, error: `another program is using it (${survivor.error})` });
		}
	}
	return report;
}

/** What to tell the reader when part of a wipe stayed behind. */
export function describeFailure(report: WipeReport): string | undefined {
	if (report.failed.length === 0) return undefined;
	const [first] = report.failed;
	const rest = report.failed.length - 1;
	return (
		`Everything else is deleted. ${first?.path} stayed: ${first?.error}` +
		`${rest > 0 ? `, and ${rest} other ${rest === 1 ? "item" : "items"} did too` : ""}. ` +
		`Close what is using it and delete again.`
	);
}
