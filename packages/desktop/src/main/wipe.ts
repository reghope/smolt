import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
	return envDir && envDir !== "" ? envDir : join(homedir(), ".smolt", "agent");
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
}

/** Everything a wipe removes, resolved against the agent directory in use. */
export function wipeTargets(): WipeTarget[] {
	const dir = agentDir();
	const home = homedir();
	return [
		{ label: "Chats", path: join(dir, "sessions") },
		{ label: "Memory (MEMORY.md, USER.md)", path: join(home, ".smolt", "memories") },
		{ label: "Skills the agent wrote", path: join(dir, "skills") },
		{ label: "Cues", path: join(dir, "cues") },
		{ label: "Session index and tool telemetry", path: join(dir, "state.db") },
		// SQLite's sidecars: leaving them behind would restore rows into a
		// database that is supposed to be gone.
		{ label: "Session index (write-ahead log)", path: join(dir, "state.db-wal") },
		{ label: "Session index (shared memory)", path: join(dir, "state.db-shm") },
		{ label: "Scratch files", path: join(dir, "scratch") },
	];
}

export interface WipeReport {
	removed: string[];
	/** Paths that resisted deletion, with the reason. */
	failed: { path: string; error: string }[];
}

/**
 * Delete every target that exists. The agent must already be stopped: on
 * Windows it holds state.db open, and an open handle makes the delete fail
 * rather than the database disappear.
 */
export function wipeLocalData(): WipeReport {
	const report: WipeReport = { removed: [], failed: [] };
	for (const target of wipeTargets()) {
		if (!existsSync(target.path)) continue;
		try {
			rmSync(target.path, { recursive: true, force: true });
			report.removed.push(target.label);
		} catch (error) {
			report.failed.push({
				path: target.path,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return report;
}
