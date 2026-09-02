import { homedir } from "node:os";
import { join } from "node:path";

// Self-contained path resolution (no runtime imports from the host tree) so
// the module stays drop-in portable as a regular extension.
const CONFIG_DIR_NAME = ".smolt";

/** smolt's own directory, `~/.smolt`, which holds the curated memory files. */
export function configDir(): string {
	return join(homedir(), CONFIG_DIR_NAME);
}

/** The agent's state directory: `SMOLT_CODING_AGENT_DIR`, else `~/.smolt/agent`. */
export function agentDir(): string {
	const envDir = process.env.SMOLT_CODING_AGENT_DIR;
	if (envDir) {
		return envDir.startsWith("~") ? join(homedir(), envDir.slice(1)) : envDir;
	}
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}
