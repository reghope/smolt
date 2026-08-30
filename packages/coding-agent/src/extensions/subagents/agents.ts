import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "@smolt/agent-core";
import { parseFrontmatter } from "../../utils/frontmatter.ts";

/**
 * Who a subagent is: a name, a description the model picks by, and the
 * instructions it works under.
 *
 * Definitions are markdown with frontmatter, the same shape the rest of smolt
 * uses for skills and prompts, discovered from the project first and the
 * user's own directory second. Three are built in so the feature works before
 * anyone has written a definition.
 */

export interface AgentDefinition {
	name: string;
	description: string;
	/** Tool allowlist. Omitted means the built-in default set. */
	tools?: string[];
	/** `provider/id` or a bare model id. Omitted means the parent's model. */
	model?: string;
	/** Omitted means the parent's level. */
	thinking?: ThinkingLevel;
	/** The body of the file: what this agent is told about its job. */
	instructions: string;
	source: "built-in" | "user" | "project";
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "max"]);

/**
 * The three that always exist, with the roles Codex defines.
 *
 * `default` is a plain hand; `explorer` reads and reports without touching
 * anything; `worker` builds, and is told it is not alone in the codebase —
 * the rule that stops parallel agents trampling each other.
 */
export const BUILT_IN_AGENTS: AgentDefinition[] = [
	{
		name: "default",
		description: "A general-purpose agent with the same tools as the parent.",
		instructions:
			"You are a subagent working on one delegated task. Do that task and report back. " +
			"Your reply is read by another agent, not by a person: lead with the answer, keep it dense, " +
			"and name files and symbols precisely.",
		source: "built-in",
	},
	{
		name: "explorer",
		description: "Reads and searches the codebase to answer questions. Never modifies anything.",
		tools: ["read", "grep", "find", "ls"],
		instructions:
			"You are an explorer. You investigate and report; you never modify anything, and you have no " +
			"tools that could. Answer the question you were given with specifics — file paths with line " +
			"numbers, exact symbol names, the actual text that matters. Say plainly when you could not " +
			"find something rather than guessing at it.",
		source: "built-in",
	},
	{
		name: "worker",
		description: "Implements a scoped change end to end, including edits.",
		instructions:
			"You are a worker. You own the task you were given, from start to finish, and you report what " +
			"you actually did rather than what you intended.\n\n" +
			"You are not alone in this codebase. Other agents may be working in it at the same time. So: " +
			"stay inside the scope you were given, do not refactor or reformat code outside it, do not " +
			"revert or 'fix' changes you did not make, and if a file has moved under you, re-read it " +
			"rather than writing over it from memory.",
		source: "built-in",
	},
];

/**
 * Raw frontmatter. A type alias rather than an interface: only an alias
 * carries the implicit index signature parseFrontmatter constrains on.
 */
type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
	thinking?: unknown;
};

/**
 * `tools: read, bash` and `tools: [read, bash]` are both valid YAML and both
 * are in use, so accept either. Anything else yields no tools rather than
 * throwing: one bad file must not take down every other agent beside it.
 */
function parseTools(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "");
	return tools.length > 0 ? tools : undefined;
}

function loadDirectory(dir: string, source: "user" | "project"): AgentDefinition[] {
	if (!existsSync(dir)) return [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	const found: AgentDefinition[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".md")) continue;
		let content: string;
		try {
			content = readFileSync(join(dir, entry), "utf-8");
		} catch {
			continue;
		}
		const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);
		if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") continue;
		const thinking = typeof frontmatter.thinking === "string" ? frontmatter.thinking : undefined;
		found.push({
			name: frontmatter.name.trim(),
			description: frontmatter.description.trim(),
			tools: parseTools(frontmatter.tools),
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			thinking: thinking && THINKING_LEVELS.has(thinking) ? (thinking as ThinkingLevel) : undefined,
			instructions: body.trim(),
			source,
		});
	}
	return found;
}

/**
 * Every agent available here, nearest definition winning.
 *
 * Project beats user beats built-in, so a repo can redefine `worker` for its
 * own conventions without anyone editing their home directory.
 */
export function discoverAgents(cwd: string, agentDir: string): AgentDefinition[] {
	const byName = new Map<string, AgentDefinition>();
	for (const agent of BUILT_IN_AGENTS) byName.set(agent.name, agent);
	for (const agent of loadDirectory(join(agentDir, "agents"), "user")) byName.set(agent.name, agent);
	for (const agent of loadDirectory(join(cwd, ".smolt", "agents"), "project")) byName.set(agent.name, agent);
	return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}
