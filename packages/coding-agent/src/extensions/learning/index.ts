import { join } from "node:path";
import { Type } from "typebox";
// Type-only import: a standalone install of this module outside the smolt
// tree switches this single line to `from "smolt"`.
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { LocalEmbedder } from "./embeddings.ts";
import { type HindsightStore, type SkillLoad, wireHindsight } from "./hindsight.ts";
import { MemoryStore, memoryTool } from "./memory.ts";
import { agentDir, configDir } from "./paths.ts";
import { type SemanticRecall, takeSemanticRecall } from "./semantic.ts";
import { type BackfillResult, SessionStore } from "./sessions.ts";
import { SkillManager, skillManageTool } from "./skills.ts";
import type { VectorStore } from "./vectors.ts";

/**
 * Self-learning: agent-curated memory, autonomous skill creation, and
 * search over past sessions.
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
 *   discovery, scroll, read, and browse. With the semantic-recall
 *   extension on (see semantic.ts), discovery also searches by meaning and
 *   fuses both rankings; `/embeddings` reports its state.
 * - `/skills` pairs authored skills against how often each was actually
 *   loaded, which is the only measured evidence that a self-reported skill
 *   was worth writing.
 * - Hindsight (observed learning): every tool call is measured, failures
 *   are classified, and recurring patterns feed back as "Tool field notes"
 *   in the frozen prompt block plus reactive remedy hints on known
 *   failures. See hindsight.ts.
 * - A periodic nudge reminds the model to persist anything durable.
 */

const NUDGE_EVERY_TURNS = 8;

function memoriesDir(): string {
	return join(configDir(), "memories");
}

function skillsRoot(): string {
	return join(agentDir(), "skills");
}

function sessionsRoot(): string {
	return join(agentDir(), "sessions");
}

function stateDbPath(): string {
	return join(agentDir(), "state.db");
}

function hindsightConfigPath(): string {
	return join(agentDir(), "hindsight.json");
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
- session_search searches all prior conversations (full-text, and by meaning when embeddings are configured). Pass query to discover, session_id + around_message_id to scroll, session_id alone to read a whole session, or nothing to browse recent sessions.`;

/**
 * How a status report reaches the transcript. A message sent with default
 * options while the agent is streaming is steered into the model's
 * conversation: it lands between two assistant messages, the model reads it
 * as input, and the reply splits in two. A report is for the reader only, so
 * it is shown at once when the agent is idle and held to the end of the turn
 * when it is not.
 */
const REPORT_DELIVERY = { triggerTurn: false } as const;

const NEVER_LOADED_NOTE =
	"Never loaded does not mean useless — a skill for a rare task can be right and idle. " +
	"It means nothing has yet shown it earns its place.";

/**
 * Pair authored skills against measured loads.
 *
 * Skills are written on self-report (the model decides it learned a
 * procedure) and read on demand, so the only evidence a skill was worth
 * writing is whether anything ever loaded it. Hindsight records that as a
 * `read` of SKILL.md; this is the report that puts the two halves together.
 *
 * Deliberately a human-facing command rather than something injected into
 * the prompt: retiring a skill is destructive, and "idle for a while" is not
 * enough evidence to hand an agent a reason to delete its own work.
 */
export function renderSkillUsage(skills: { name: string; writtenAt: number }[], loads: SkillLoad[]): string {
	if (skills.length === 0) return "No skills have been recorded yet.";
	const byName = new Map(loads.map((entry) => [entry.skill, entry]));
	const used = skills.filter((skill) => byName.has(skill.name));
	const idle = skills.filter((skill) => !byName.has(skill.name));
	const asDay = (ms: number): string => (ms > 0 ? new Date(ms).toISOString().slice(0, 10) : "unknown");

	const lines = [
		"## Skills — authored vs loaded",
		`- ${skills.length} skills · ${used.length} ever loaded · ${idle.length} never loaded`,
	];
	if (used.length > 0) {
		lines.push("", "**Loaded**");
		for (const skill of used
			.map((skill) => ({ skill, load: byName.get(skill.name)! }))
			.sort((a, b) => b.load.loads - a.load.loads)) {
			lines.push(`- ${skill.skill.name} — ${skill.load.loads} loads, last ${asDay(skill.load.lastAt)}`);
		}
	}
	if (idle.length > 0) {
		lines.push("", "**Never loaded**");
		for (const skill of idle.sort((a, b) => a.writtenAt - b.writtenAt)) {
			lines.push(`- ${skill.name} — written ${asDay(skill.writtenAt)}`);
		}
		lines.push("", NEVER_LOADED_NOTE);
	}
	return lines.join("\n");
}

const SEMANTIC_OFF_REPORT =
	"## Semantic recall — off\n" +
	"Session search is lexical only. Switch on the semantic-recall extension (desktop: Settings → " +
	"Extensions) to also search past sessions by meaning, or point `~/.smolt/agent/embeddings.json` " +
	"at an embedding server.";

/** The `/embeddings` report: what runs, where the weights are, and how far the index has got. */
export function renderSemanticStatus(
	semantic: SemanticRecall,
	stored: number,
	lastBackfill: BackfillResult | undefined,
	started: boolean,
): string {
	const { config, embedder } = semantic;
	const lines = ["## Semantic recall — on"];
	if (embedder instanceof LocalEmbedder) {
		const weights = embedder.modelCached ? "weights on disk" : "weights download on first use";
		lines.push(`- Model: ${embedder.modelId}, running on this machine (${weights}, ${embedder.modelsDir})`);
	} else {
		lines.push(`- Model: ${embedder.modelId} via ${config.baseUrl}`);
	}
	const width = embedder.dim > 0 ? embedder.dim : semantic.vectors.dim;
	lines.push(`- Vectors stored: ${stored}${width > 0 ? ` (${width}-wide)` : ""}`);
	if (lastBackfill) {
		const tail = lastBackfill.incomplete ? "; the next session continues" : "";
		const pruned = lastBackfill.pathsPruned > 0 ? `, ${lastBackfill.pathsPruned} deleted sessions pruned` : "";
		const work =
			lastBackfill.embedded === 0
				? "nothing new to embed"
				: `${lastBackfill.embedded} chunks across ${lastBackfill.filesTouched} sessions`;
		lines.push(`- Last index run: ${work}${pruned}${tail}`);
	} else {
		lines.push(started ? "- Index run: in progress" : "- Index run: not yet started");
	}
	lines.push(`- Match floor: ${config.minScore} cosine similarity`);
	return lines.join("\n");
}

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
	/** Optional hindsight.json path; defaults apply when absent. */
	hindsightConfigPath?: string;
}

export default function learningExtension(smolt: ExtensionAPI): void {
	createLearningExtension(smolt, {
		memoriesDir: memoriesDir(),
		skillsRoot: skillsRoot(),
		sessionsRoot: sessionsRoot(),
		stateDbPath: stateDbPath(),
		hindsightConfigPath: hindsightConfigPath(),
	});
}

export interface LearningStores {
	memory: MemoryStore;
	skills: SkillManager;
	sessions: SessionStore;
	hindsight: HindsightStore;
	/** Present only when semantic recall is on. */
	vectors: VectorStore | undefined;
}

export interface LearningOptions {
	/**
	 * Semantic recall to wire in. Defaults to whatever the semantic-recall
	 * extension handed over at load; absent, session search stays lexical.
	 */
	semantic?: SemanticRecall;
}

export function createLearningExtension(
	smolt: ExtensionAPI,
	paths: LearningPaths,
	options: LearningOptions = {},
): LearningStores {
	const memory = new MemoryStore(paths.memoriesDir);
	const skills = new SkillManager(paths.skillsRoot);
	const semantic = options.semantic ?? takeSemanticRecall();
	const vectors = semantic?.vectors;
	const sessions = new SessionStore(paths.sessionsRoot, paths.stateDbPath, {
		embedder: semantic?.embedder,
		vectors,
		minScore: semantic?.config.minScore,
	});
	// Hindsight (observed learning) shares state.db but versions its own
	// tables; its notes are folded into the frozen block built below.
	const hindsight = wireHindsight(smolt, {
		dbPath: paths.stateDbPath,
		configPath: paths.hindsightConfigPath,
		injectNotes: false,
	});

	let frozen: string | undefined;
	let turnCount = 0;
	let nudgePending = false;
	// Backfill runs detached: a session start must never wait on a model
	// load or an embedding server, and shutdown must not wait on the backfill.
	let backfill: Promise<unknown> | undefined;
	let lastBackfill: BackfillResult | undefined;
	const backfillAbort = new AbortController();

	smolt.on("session_start", async () => {
		frozen = undefined;
		turnCount = 0;
		nudgePending = false;
		memory.resetConsolidationFailures();
		if (semantic && backfill === undefined) {
			backfill = sessions
				.backfill({ maxChunks: semantic.config.backfillPerSession, signal: backfillAbort.signal })
				.then((result) => {
					lastBackfill = result;
				})
				.catch(() => undefined);
		}
	});

	smolt.on("session_shutdown", async () => {
		backfillAbort.abort();
		await backfill;
		vectors?.close();
	});

	smolt.on("turn_start", async () => {
		memory.resetConsolidationFailures();
	});

	smolt.on("turn_end", async () => {
		turnCount += 1;
		if (turnCount > 0 && turnCount % NUDGE_EVERY_TURNS === 0) nudgePending = true;
	});

	smolt.on("before_agent_start", async (event, ctx) => {
		if (frozen === undefined) {
			memory.loadFromDisk();
			const blocks = [memory.formatForSystemPrompt("memory"), memory.formatForSystemPrompt("user")].filter(
				(block) => block !== "",
			);
			if (hindsight.config.enabled) {
				const notes = await hindsight.store.distillNotes(hindsight.config, ctx?.cwd ?? "");
				if (notes !== "") blocks.push(notes);
			}
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

	smolt.registerCommand("skills", {
		description: "Authored skills and how often each was actually loaded",
		handler: async (_args, ctx) => {
			const report = renderSkillUsage(skills.listSkills(), await hindsight.store.skillUsage(50));
			smolt.sendMessage({ customType: "skill-usage-report", content: report, display: true }, REPORT_DELIVERY);
			if (hindsight.store.unavailable) {
				ctx.ui.notify("Load counts are unavailable — hindsight telemetry could not be opened.", "warning");
			}
		},
	});

	smolt.registerCommand("embeddings", {
		description: "Whether past sessions are searched by meaning, and how far the index has got",
		handler: async () => {
			const report = semantic
				? renderSemanticStatus(semantic, await semantic.vectors.count(), lastBackfill, backfill !== undefined)
				: SEMANTIC_OFF_REPORT;
			smolt.sendMessage({ customType: "embeddings-report", content: report, display: true }, REPORT_DELIVERY);
		},
	});

	// Only claim semantic recall when it is actually running: a tool
	// description promising meaning-based search that silently isn't there
	// would teach the model to phrase queries that cannot match.
	const semanticNote = sessions.semanticEnabled
		? "SEMANTIC RECALL: this machine also searches by meaning, so a query that shares no " +
			"words with the original conversation can still find it. Prefer describing what the " +
			"session was about over guessing its exact wording. Each result carries matched_by: " +
			'"fts" (wording), "vector" (meaning), or "both".\n\n'
		: "";

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
			semanticNote +
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

	return { memory, skills, sessions, hindsight: hindsight.store, vectors };
}
