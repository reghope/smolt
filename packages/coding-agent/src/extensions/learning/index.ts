import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
// Type-only import: a standalone install of this module outside the smolt
// tree switches this single line to `from "smolt"`.
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { MemoryStore, memoryTool } from "./memory.ts";
import { SessionStore } from "./sessions.ts";
import { SkillManager, skillManageTool } from "./skills.ts";

/**
 * Self-learning: agent-curated memory, autonomous skill creation, and
 * full-text search over past sessions.
 *
 * - Two memory files (MEMORY.md, USER.md) are injected into the system
 *   prompt, frozen at session start so the prompt prefix stays byte-stable
 *   for cache reuse. The `memory` tool edits them; edits land on disk
 *   immediately and appear next session.
 * - The `skill_manage` tool lets the agent record procedures it worked out
 *   into the native skills directory, where normal skill discovery picks
 *   them up with progressive disclosure.
 * - The `session_search` tool searches every prior session (SQLite FTS5
 *   when available, plain scan otherwise) with four calling shapes:
 *   discovery, scroll, read, and browse.
 * - A periodic nudge reminds the model to persist anything durable.
 */

const NUDGE_EVERY_TURNS = 8;

// Self-contained path resolution (no runtime imports from the host tree) so
// the module stays drop-in portable as a regular extension.
const CONFIG_DIR_NAME = ".smolt";

function getAgentDir(): string {
	const envDir = process.env.SMOLT_CODING_AGENT_DIR;
	if (envDir) {
		return envDir.startsWith("~") ? join(homedir(), envDir.slice(1)) : envDir;
	}
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

function memoriesDir(): string {
	return join(homedir(), CONFIG_DIR_NAME, "memories");
}

function skillsRoot(): string {
	return join(getAgentDir(), "skills");
}

function sessionsRoot(): string {
	return join(getAgentDir(), "sessions");
}

function stateDbPath(): string {
	return join(getAgentDir(), "state.db");
}

const LEARNING_INSTRUCTIONS = `## Self-learning

You maintain durable memory and skills across sessions.

Memory (frozen at session start; edits appear next session):
- MEMORY.md - your notes: environment facts, project conventions, tool quirks and workarounds, learned techniques.
- USER.md - the user: identity, communication preferences, workflow habits, technical skill level.
- Edit with the memory tool. Make ALL your changes in ONE call via the operations array when touching more than one entry - the batch applies atomically against the final char budget. Capacity is tight: prune stale entries rather than letting them accumulate.

Skills (procedural memory you create and reuse):
- When you figure out a non-trivial workflow, when you hit errors or dead ends and then found the working path, or when the user corrects your approach - record it with skill_manage so it never has to be rediscovered.
- A skill is a SKILL.md with YAML frontmatter (name, description of 60 chars or less) and the sections: When to Use, Procedure, Pitfalls, Verification.
- Prefer action "patch" for updates - it is more token-efficient than "edit".
- New and changed skills are indexed at the next session start and load on demand.

Past sessions:
- session_search performs full-text search over all prior conversations. Pass query to discover, session_id + around_message_id to scroll, session_id alone to read a whole session, or nothing to browse recent sessions.`;

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
}

function jsonResult(value: unknown) {
	return textResult(JSON.stringify(value));
}

export interface LearningPaths {
	memoriesDir: string;
	skillsRoot: string;
	sessionsRoot: string;
	stateDbPath: string;
}

export default function learningExtension(smolt: ExtensionAPI): void {
	createLearningExtension(smolt, {
		memoriesDir: memoriesDir(),
		skillsRoot: skillsRoot(),
		sessionsRoot: sessionsRoot(),
		stateDbPath: stateDbPath(),
	});
}

export interface LearningStores {
	memory: MemoryStore;
	skills: SkillManager;
	sessions: SessionStore;
}

export function createLearningExtension(smolt: ExtensionAPI, paths: LearningPaths): LearningStores {
	const memory = new MemoryStore(paths.memoriesDir);
	const skills = new SkillManager(paths.skillsRoot);
	const sessions = new SessionStore(paths.sessionsRoot, paths.stateDbPath);

	let frozen: string | undefined;
	let turnCount = 0;
	let nudgePending = false;

	smolt.on("session_start", async () => {
		frozen = undefined;
		turnCount = 0;
		nudgePending = false;
		memory.resetConsolidationFailures();
	});

	smolt.on("turn_start", async () => {
		memory.resetConsolidationFailures();
	});

	smolt.on("turn_end", async () => {
		turnCount += 1;
		if (turnCount > 0 && turnCount % NUDGE_EVERY_TURNS === 0) nudgePending = true;
	});

	smolt.on("before_agent_start", async (event) => {
		if (frozen === undefined) {
			memory.loadFromDisk();
			const blocks = [memory.formatForSystemPrompt("memory"), memory.formatForSystemPrompt("user")].filter(
				(block) => block !== "",
			);
			frozen = [LEARNING_INSTRUCTIONS, ...blocks].join("\n\n");
		}
		const systemPrompt = `${event.systemPrompt}\n\n${frozen}`;
		if (!nudgePending) return { systemPrompt };
		nudgePending = false;
		return {
			systemPrompt,
			message: {
				customType: "learning-nudge",
				content:
					"Periodic check: if you learned durable facts about this environment, project, or user this session, persist them now with the memory tool. If you worked out a non-trivial procedure, recovered from errors to a working path, or were corrected by the user, record or update a skill with skill_manage. If nothing qualifies, continue silently.",
				display: false,
			},
		};
	});

	smolt.registerTool({
		name: "memory",
		label: "Memory",
		description:
			"Save durable facts to persistent memory that survive across sessions. Memory is injected " +
			"into every future session, so keep entries compact and high-signal.\n\n" +
			"HOW: make ALL your changes in ONE call via an 'operations' array (each item: {action, " +
			"content?, old_text?}). The batch applies atomically and the char limit is checked only on " +
			"the FINAL result — so a single call can remove/replace stale entries to free room AND add " +
			"new ones, even when an add alone would overflow. The response reports current/limit chars " +
			"and confirms completion; one batch call finishes the update, so don't repeat it. Use the " +
			"bare action/content/old_text fields only for a single lone change.\n\n" +
			"WHEN: save proactively when the user states a preference, correction, or personal detail, " +
			"or you learn a stable fact about their environment, conventions, or workflow. Priority: " +
			"user preferences & corrections > environment facts > procedures. The best memory stops the " +
			"user repeating themselves.\n\n" +
			"IF FULL: an add is rejected with the current entries shown. Reissue as ONE batch that " +
			"removes or shortens enough stale entries and adds the new one together.\n\n" +
			"TARGETS: 'user' = who the user is (name, role, preferences, style). 'memory' = your notes " +
			"(environment, conventions, tool quirks, lessons).\n\n" +
			"SKIP: trivial/obvious info, easily re-discovered facts, raw data dumps, task progress, " +
			"completed-work logs, temporary TODO state (use session_search for those). Reusable " +
			"procedures belong in a skill, not memory.",
		parameters: Type.Object({
			action: Type.Optional(
				Type.Union([Type.Literal("add"), Type.Literal("replace"), Type.Literal("remove")], {
					description: "The action to perform (single-op shape). Omit when using 'operations'.",
				}),
			),
			target: Type.Optional(
				Type.Union([Type.Literal("memory"), Type.Literal("user")], {
					description: "Which memory store: 'memory' for personal notes, 'user' for user profile.",
				}),
			),
			content: Type.Optional(
				Type.String({
					description:
						"The entry content. Required for 'add' and 'replace' (single-op shape). Alias: 'new_text' is also accepted (mirrors old_text).",
				}),
			),
			old_text: Type.Optional(
				Type.String({
					description:
						"REQUIRED for 'replace' and 'remove' (single-op shape): a short unique substring identifying the existing entry to modify. Omit only for 'add'.",
				}),
			),
			new_text: Type.Optional(
				Type.String({
					description:
						"Alias for 'content' (single-op shape). Provided so the replace/remove old_text/new_text pairing works; if both are set, 'content' wins.",
				}),
			),
			operations: Type.Optional(
				Type.Array(
					Type.Object({
						action: Type.Union([Type.Literal("add"), Type.Literal("replace"), Type.Literal("remove")]),
						content: Type.Optional(
							Type.String({ description: "Entry content for add/replace. Alias: 'new_text'." }),
						),
						new_text: Type.Optional(Type.String({ description: "Alias for 'content' in a batch op." })),
						old_text: Type.Optional(
							Type.String({ description: "Substring identifying the entry for replace/remove." }),
						),
					}),
					{
						description:
							"Batch shape: a list of operations applied atomically in one call against the final char budget. Preferred when making multiple changes or consolidating to make room. Each item is {action, content?, old_text?}.",
					},
				),
			),
		}),
		async execute(_toolCallId, params) {
			return jsonResult(memoryTool(memory, params));
		},
	});

	smolt.registerTool({
		name: "skill_manage",
		label: "Manage skills",
		description:
			"Record and maintain your own skills (procedural memory). Skills capture how to do a " +
			"specific type of task based on proven experience — use when you figured out a non-trivial " +
			"workflow, found the working path after errors or dead ends, or were corrected by the " +
			"user.\n\n" +
			"Actions: create (full SKILL.md content with YAML frontmatter name + description <= 60 " +
			"chars, body sections: When to Use, Procedure, Pitfalls, Verification), patch (old_string " +
			"-> new_string, preferred for updates; set file_path to patch a supporting file, " +
			"replace_all for multiple matches), edit (replace full SKILL.md), delete, write_file / " +
			"remove_file (supporting files under references/, templates/, scripts/, or assets/). " +
			"Skills are indexed at the next session start and load on demand.",
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("create"),
					Type.Literal("patch"),
					Type.Literal("edit"),
					Type.Literal("delete"),
					Type.Literal("write_file"),
					Type.Literal("remove_file"),
				],
				{ description: "Operation to perform" },
			),
			name: Type.String({ description: "Skill name (lowercase letters, digits, hyphens, dots, underscores)" }),
			category: Type.Optional(
				Type.String({ description: "Optional category directory (single segment, create only)" }),
			),
			content: Type.Optional(Type.String({ description: "Full SKILL.md content (create, edit)" })),
			old_string: Type.Optional(Type.String({ description: "Exact text to replace (patch)" })),
			new_string: Type.Optional(
				Type.String({ description: "Replacement text (patch); empty string deletes the match" }),
			),
			replace_all: Type.Optional(
				Type.Boolean({ description: "Replace every match instead of requiring a unique one (patch)" }),
			),
			file_path: Type.Optional(
				Type.String({ description: "Relative path within the skill (patch, write_file, remove_file)" }),
			),
			file_content: Type.Optional(Type.String({ description: "File content (write_file)" })),
		}),
		async execute(_toolCallId, params) {
			return jsonResult(skillManageTool(skills, params));
		},
	});

	smolt.registerTool({
		name: "session_search",
		label: "Search past sessions",
		description:
			"Search past sessions, or scroll inside one. FTS5-backed retrieval over stored " +
			"conversations — every shape returns actual messages, not summaries.\n\n" +
			"FOUR CALLING SHAPES\n\n" +
			'  1) DISCOVERY — pass `query`: session_search(query="auth refactor", limit=3). Runs ' +
			"full-text search, dedupes hits by session, and returns the top N sessions. Adaptive " +
			"detail is the default: the top-ranked result carries full context (bookends + a ±5 " +
			"message window), while lower-ranked results stay compact (the exact anchor message " +
			'only). Pass detail="full" to fully hydrate every result. Every result carries ' +
			"session_id, title, when, snippet, match_message_id, messages_before, and " +
			"messages_after.\n\n" +
			"  2) SCROLL — pass `session_id` + `around_message_id`: returns a window of ±window " +
			"messages centered on the anchor. To scroll FORWARD pass the last window message's id " +
			"back as around_message_id; to scroll BACKWARD pass the first. When messages_before or " +
			"messages_after is < window, you're at the start or end of the session.\n\n" +
			"  3) READ — pass `session_id` only: dumps the whole session (first 20 + last 10 " +
			"messages when large).\n\n" +
			"  4) BROWSE — no args: recent sessions chronologically (titles, previews, timestamps). " +
			'Use when the user asks "what was I working on" without naming a topic.\n\n' +
			"FTS5 SYNTAX: AND is the default — multi-word queries require all terms. Use OR " +
			'explicitly for broader recall (alpha OR beta), quoted phrases for exact match ("docker ' +
			'networking"), boolean (python NOT java), or prefix wildcards (deploy*).\n\n' +
			'WHEN TO USE: questions about past conversations — "what did we do about X", "where ' +
			'did we leave Y", "find the session where Z". Session history shows what was said when; ' +
			"it is not evidence about the current state of external sources — inspect those directly.",
		parameters: Type.Object({
			query: Type.Optional(
				Type.String({
					description:
						"Search query (discovery shape). Keywords, phrases, or boolean expressions to find in past sessions. Omit to browse recent sessions. Ignored when session_id + around_message_id are set (scroll shape).",
				}),
			),
			limit: Type.Optional(
				Type.Number({
					description:
						"Discovery/browse shapes. Max sessions to return (default 3, max 10). Bump to 5-10 when the topic likely spans several sessions.",
				}),
			),
			sort: Type.Optional(
				Type.Union([Type.Literal("newest"), Type.Literal("oldest")], {
					description:
						"Discovery shape only. Temporal bias on top of relevance ranking. Omit for relevance-only ordering. Set 'newest' for recency-shaped questions (\"where did we leave X\"), 'oldest' for origin-shaped questions (\"how did X start\").",
				}),
			),
			detail: Type.Optional(
				Type.Union([Type.Literal("adaptive"), Type.Literal("full")], {
					description:
						"Discovery shape only. 'adaptive' (default) fully hydrates the top-ranked result and returns only the exact anchor message for lower-ranked results. 'full' returns bookends and the complete anchored window for every result.",
				}),
			),
			session_id: Type.Optional(
				Type.String({
					description:
						"Scroll/read shapes. Session to read inside — use the session_id returned from a prior discovery or browse call. Pair with around_message_id to scroll; pass alone to read the whole session.",
				}),
			),
			around_message_id: Type.Optional(
				Type.Number({
					description:
						"Scroll shape. Message id to center the window on. From a discovery result use match_message_id, or any id seen in a prior window.",
				}),
			),
			window: Type.Optional(
				Type.Number({
					description:
						"Scroll shape only. Messages to return on each side of the anchor (anchor itself always included). Clamped to [1, 20]. Default 5.",
				}),
			),
			role_filter: Type.Optional(
				Type.String({
					description:
						"Optional. Comma-separated roles to include. Discovery defaults to 'user,assistant' " +
						"(tool output is usually noise). Pass 'user,assistant,tool' to include tool output " +
						"(e.g. facts that only appeared in command output or file reads) or 'tool' to search " +
						"tool output only.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const currentSessionId = ctx.sessionManager.getSessionId();
			return jsonResult(await sessions.search(params, currentSessionId));
		},
	});

	return { memory, skills, sessions };
}
