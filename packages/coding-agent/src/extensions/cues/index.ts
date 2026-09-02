import { homedir } from "node:os";
import { join } from "node:path";
// Type-only import: a standalone install of this module outside the smolt
// tree switches this single line to `from "smolt"`.
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { BUILT_IN_CUES, type Cue, loadCueDir, matchingCues, mergeCues } from "./cues.ts";

/**
 * Cues: house notes that arrive when their subject does.
 *
 * Standing guidance in the system prompt is paid for on every request of
 * every session, including the ones that never touch its subject. A cue is
 * the same note with a condition on it — "a new web app defaults to Vite with
 * React Router" is worth saying to somebody starting a web app and worth
 * nothing to everybody else.
 *
 * Cues ship built in and can be written as files under
 * `~/.smolt/agent/cues/*.md`, so a house rule needs no code. A file whose
 * name matches a built-in replaces it.
 *
 * One cost worth knowing: an armed cue changes the system prompt, so a cue
 * that arms deep into a session invalidates the cached prefix. Triggers are
 * therefore written to fire on the message that opens a subject, not on
 * passing mention of it much later.
 */

const CONFIG_DIR_NAME = ".smolt";

function agentDir(): string {
	const envDir = process.env.SMOLT_CODING_AGENT_DIR;
	if (envDir) {
		return envDir.startsWith("~") ? join(homedir(), envDir.slice(1)) : envDir;
	}
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

function cuesDir(): string {
	return join(agentDir(), "cues");
}

export default function cuesExtension(smolt: ExtensionAPI): void {
	let cues: Cue[] = [];
	/** Ids armed this session, in the order their subject came up. */
	const armed = new Map<string, Cue>();

	smolt.on("session_start", async () => {
		armed.clear();
		// Read the directory once per session: a cue added mid-session belongs
		// to the next one, the same way memory and skills do.
		cues = mergeCues(BUILT_IN_CUES, loadCueDir(cuesDir()));
	});

	smolt.on("input", async (event) => {
		// Messages the harness sent on an extension's behalf are not somebody
		// asking for anything; only a real prompt arms a cue.
		if (event.source === "extension") return;
		for (const cue of matchingCues(cues, event.text)) {
			if (!armed.has(cue.id)) armed.set(cue.id, cue);
		}
	});

	smolt.on("before_agent_start", async (event) => {
		// Armed stays armed: the web app is still being built three turns later.
		if (armed.size === 0) return;
		const notes = [...armed.values()].map((cue) => cue.note).join("\n\n");
		return { systemPrompt: `${event.systemPrompt}\n\n${notes}` };
	});

	smolt.registerCommand("cues", {
		description: "Notes that arrive when their subject does; lists them and which are armed",
		handler: async (_args, ctx) => {
			if (cues.length === 0) {
				ctx.ui.notify(`No cues. Add one as a markdown file under ${cuesDir()}.`, "info");
				return;
			}
			const lines = cues.map((cue) => {
				const state = armed.has(cue.id) ? "armed" : "waiting";
				const where = cue.source === "built-in" ? "built-in" : "file";
				return `- ${cue.id} (${where}, ${state}): ${cue.summary}`;
			});
			smolt.sendMessage({
				customType: "cues-report",
				content: [`## Cues`, "", ...lines, "", `Files live in ${cuesDir()}.`].join("\n"),
				display: true,
			});
		},
	});
}
