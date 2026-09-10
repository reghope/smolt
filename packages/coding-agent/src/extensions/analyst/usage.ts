import { createHash } from "node:crypto";
import type { FileEntry } from "../../core/session-manager.ts";
import { BUILT_IN_CUES } from "../cues/cues.ts";
import { approxTokens } from "../tools/budget.ts";

/**
 * Token usage, attributed.
 *
 * A session's bill is not "what the model said": it is the context re-sent
 * on every turn, and that context is put there by named mechanisms — the
 * system prompt and the blocks extensions append to it, the results tools
 * return, the messages extensions inject, the user's own words, and the
 * model's output. Each of those has an owner in this repository, so a token
 * can be traced to the extension that spent it and the file to fix.
 *
 * Two measures matter for a piece of context: how big it is, and how many
 * turns it rides. A 12K tool result read on turn 3 of a 60-turn session is
 * re-sent 57 times: 684K tokens, almost all of it cache reads if the
 * provider caches and full price if it does not. That product — tokens ×
 * turns still in context — is the *carry*, and it is what the findings
 * rank by.
 *
 * Everything here is pure: entries in, numbers and findings out. Nothing
 * asks a model anything; an analysis of token spend must not itself spend.
 */

/** Below this much context a turn with no cache read is not worth calling a miss. */
export const CACHE_MISS_FLOOR = 20_000;
/** What one image in a tool result is taken to cost, when the provider does not say. */
export const IMAGE_TOKENS = 1600;

// ----------------------------------------------------------------------------
// Sources: what puts context into a turn, and who owns it
// ----------------------------------------------------------------------------

/** Where a tool's results come from, and where to go to change them. */
export const TOOL_SOURCES: Record<string, { extension: string; file: string }> = {
	read: { extension: "built-in tools", file: "src/core/tools/read.ts" },
	bash: { extension: "built-in tools", file: "src/core/tools/bash.ts" },
	powershell: { extension: "built-in tools", file: "src/core/tools/powershell.ts" },
	edit: { extension: "built-in tools", file: "src/core/tools/edit.ts" },
	write: { extension: "built-in tools", file: "src/core/tools/write.ts" },
	grep: { extension: "built-in tools", file: "src/core/tools/grep.ts" },
	find: { extension: "built-in tools", file: "src/core/tools/find.ts" },
	ls: { extension: "built-in tools", file: "src/core/tools/ls.ts" },
	view_image: { extension: "tools", file: "src/extensions/tools/index.ts" },
	research: { extension: "research", file: "src/extensions/research/index.ts" },
	notebook: { extension: "research", file: "src/extensions/research/index.ts" },
	browse: { extension: "research", file: "src/extensions/research/index.ts" },
	fetch: { extension: "research", file: "src/extensions/research/index.ts" },
	search: { extension: "research", file: "src/extensions/research/index.ts" },
	battletest: { extension: "battletest", file: "src/extensions/battletest/index.ts" },
	wayfinder: { extension: "wayfinder", file: "src/extensions/wayfinder/index.ts" },
	goal: { extension: "goal", file: "src/extensions/goal/index.ts" },
	memory: { extension: "learning", file: "src/extensions/learning/index.ts" },
	skill_manage: { extension: "learning", file: "src/extensions/learning/index.ts" },
	session_search: { extension: "learning", file: "src/extensions/learning/index.ts" },
	subagent: { extension: "subagents", file: "src/extensions/subagents/index.ts" },
	review: { extension: "review", file: "src/extensions/review/index.ts" },
	screenshot: { extension: "screenshot", file: "src/extensions/screenshot/index.ts" },
	telegram: { extension: "telegram", file: "src/extensions/telegram/index.ts" },
	advise: { extension: "advisor", file: "src/extensions/advisor/index.ts" },
};

/** The line a system-prompt block starts with, and the extension that appends it. */
export interface BlockSignature {
	source: string;
	file: string;
	/** The block begins with this text. */
	prefix: string;
}

export const BLOCK_SIGNATURES: BlockSignature[] = [
	{ source: "learning", file: "src/extensions/learning/index.ts", prefix: "## Self-learning" },
	{
		source: "learning (memory)",
		file: "src/extensions/learning/memory.ts",
		prefix: `${"═".repeat(46)}\nMEMORY (your personal notes)`,
	},
	{
		source: "learning (user profile)",
		file: "src/extensions/learning/memory.ts",
		prefix: `${"═".repeat(46)}\nUSER PROFILE (who the user is)`,
	},
	{
		source: "learning (hindsight)",
		file: "src/extensions/learning/hindsight.ts",
		prefix: "## Hindsight — observed tool usage",
	},
	{ source: "wayfinder", file: "src/extensions/wayfinder/index.ts", prefix: "## Wayfinder" },
	{ source: "goal", file: "src/extensions/goal/prompts.ts", prefix: "## Active goal" },
	{ source: "tools", file: "src/extensions/tools/index.ts", prefix: "Working with files and tool output:" },
	...BUILT_IN_CUES.map((cue) => ({
		source: `cues (${cue.id})`,
		file: "src/extensions/cues/cues.ts",
		prefix: cue.note.split("\n")[0] ?? cue.note,
	})),
];

/** Which extension a custom message type belongs to. */
export const CUSTOM_MESSAGE_SOURCES: Record<string, string> = {
	"learning-nudge": "learning",
	"command-outcome": "core (command narration)",
	"analyst-report": "analyst",
};

// ----------------------------------------------------------------------------
// Attributing a system prompt
// ----------------------------------------------------------------------------

export interface PromptAttribution {
	/** The whole prompt, in tokens. */
	tokens: number;
	/** The part built by the core (identity, tools, guidelines, context files, skills). */
	base: number;
	/** Every appended block, by source, in tokens. */
	sources: Record<string, number>;
}

/**
 * Split what extensions appended to the base prompt into blocks, each
 * credited to the extension whose signature it starts with. Text before
 * the first recognised signature, or a block no signature claims, is
 * credited to "other extensions" with its first line kept so the report
 * can name it.
 */
export function attributePrompt(systemPrompt: string, basePrompt: string): PromptAttribution {
	const tokens = approxTokens(systemPrompt);
	if (basePrompt === "" || !systemPrompt.startsWith(basePrompt)) {
		return { tokens, base: tokens, sources: {} };
	}
	const extra = systemPrompt.slice(basePrompt.length);
	const starts: { at: number; source: string }[] = [];
	for (const signature of BLOCK_SIGNATURES) {
		let from = 0;
		for (;;) {
			const at = extra.indexOf(signature.prefix, from);
			if (at < 0) break;
			starts.push({ at, source: signature.source });
			from = at + signature.prefix.length;
		}
	}
	starts.sort((a, b) => a.at - b.at);
	// A block nobody signed still starts somewhere: a top-level heading after
	// a blank line is taken as a boundary.
	const boundaries = [...starts];
	const heading = /(?:^|\n\n)(#{1,2} \S[^\n]*)/g;
	for (let match = heading.exec(extra); match !== null; match = heading.exec(extra)) {
		const at = match.index + match[0].length - (match[1]?.length ?? 0);
		if (starts.some((start) => start.at === at)) continue;
		boundaries.push({ at, source: otherLabel(match[1] ?? "") });
	}
	boundaries.sort((a, b) => a.at - b.at);
	const sources: Record<string, number> = {};
	const credit = (source: string, text: string) => {
		const count = approxTokens(text.trim());
		if (count === 0) return;
		sources[source] = (sources[source] ?? 0) + count;
	};
	if (boundaries.length === 0) {
		credit(otherLabel(extra), extra);
	} else {
		const lead = extra.slice(0, boundaries[0]?.at ?? 0);
		credit(otherLabel(lead), lead);
		for (const [index, boundary] of boundaries.entries()) {
			const end = boundaries[index + 1]?.at ?? extra.length;
			credit(boundary.source, extra.slice(boundary.at, end));
		}
	}
	return { tokens, base: approxTokens(basePrompt), sources };
}

/** The record's slot for a key, made on first use. */
function bucket<T>(map: Record<string, T>, key: string, make: () => T): T {
	const existing = map[key];
	if (existing !== undefined) return existing;
	const created = make();
	map[key] = created;
	return created;
}

function otherLabel(text: string): string {
	const line = text.trim().split("\n")[0]?.trim() ?? "";
	return line === "" ? "other extensions" : `other extensions ("${line.slice(0, 48)}${line.length > 48 ? "…" : ""}")`;
}

// ----------------------------------------------------------------------------
// Reading one session
// ----------------------------------------------------------------------------

export interface TurnUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	cost: number;
	/** Everything the model read this turn: fresh input plus the cache. */
	context: number;
	model: string;
}

export interface ToolUsage {
	count: number;
	errors: number;
	tokens: number;
	/** Tokens × turns each result stayed in context. */
	carry: number;
	largest: number;
}

export interface SourceUsage {
	/** Tokens this source put into the prompt, summed over every turn it rode. */
	carry: number;
	/** Its size on a typical turn. */
	perTurn: number;
	turns: number;
}

export interface SessionUsage {
	path: string;
	id: string;
	title: string;
	startedAt: number;
	endedAt: number;
	turns: number;
	/** Every token billed: input, output, and both kinds of cache. */
	billed: number;
	cost: number;
	input: number;
	output: number;
	reasoning: number;
	cacheRead: number;
	cacheWrite: number;
	/** Context re-sent on turns after the first, the part caching could have covered. */
	cacheable: number;
	/** Cache reads on those same turns: the part caching did cover. */
	cacheHits: number;
	missTurns: number;
	/** Context re-sent on miss turns at full price. */
	missTokens: number;
	peakContext: number;
	meanContext: number;
	compactions: number;
	tools: Record<string, ToolUsage>;
	largest: { tool: string; tokens: number; turn: number }[];
	duplicates: { count: number; tokens: number; carry: number };
	prompt?: { samples: number; perTurn: number; base: number; sources: Record<string, SourceUsage> };
	customMessages: Record<string, { count: number; tokens: number; carry: number }>;
	userTokens: number;
	assistantTextTokens: number;
	byModel: Record<string, { turns: number; billed: number; cost: number; cacheRead: number; cacheable: number }>;
}

interface PromptSample {
	prompt: number;
	base: number;
	sources: Record<string, number>;
}

function contentTokens(content: unknown): number {
	if (typeof content === "string") return approxTokens(content);
	if (!Array.isArray(content)) return 0;
	let total = 0;
	for (const block of content as { type?: string; text?: string; thinking?: string }[]) {
		if (block.type === "text" && typeof block.text === "string") total += approxTokens(block.text);
		else if (block.type === "image") total += IMAGE_TOKENS;
		else if (block.type === "thinking" && typeof block.thinking === "string") total += approxTokens(block.thinking);
		else if (block.type === "toolCall") total += approxTokens(JSON.stringify(block));
	}
	return total;
}

function contentHash(content: unknown): string {
	const text = typeof content === "string" ? content : JSON.stringify(content);
	return createHash("sha1").update(text).digest("hex");
}

/** Read one session's entries into attributed usage. */
export function analyzeSession(entries: FileEntry[], path: string): SessionUsage {
	const usage: SessionUsage = {
		path,
		id: "",
		title: "",
		startedAt: 0,
		endedAt: 0,
		turns: 0,
		billed: 0,
		cost: 0,
		input: 0,
		output: 0,
		reasoning: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cacheable: 0,
		cacheHits: 0,
		missTurns: 0,
		missTokens: 0,
		peakContext: 0,
		meanContext: 0,
		compactions: 0,
		tools: {},
		largest: [],
		duplicates: { count: 0, tokens: 0, carry: 0 },
		customMessages: {},
		userTokens: 0,
		assistantTextTokens: 0,
		byModel: {},
	};

	// Things whose carry depends on how many turns follow them.
	const pending: { kind: "tool" | "custom" | "duplicate"; key: string; tokens: number; turn: number }[] = [];
	const compactionTurns: number[] = [];
	const promptSamples: PromptSample[] = [];
	let currentPrompt: PromptSample | undefined;
	const promptCarry: Record<string, { carry: number; turns: number }> = {};
	let promptTurns = 0;
	let promptTokenSum = 0;
	let baseTokenSum = 0;
	let contextSum = 0;
	const seenResults = new Map<string, number>();
	let model = "";

	for (const entry of entries) {
		const timestamp = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number(entry.timestamp);
		if (Number.isFinite(timestamp) && timestamp > 0) {
			if (usage.startedAt === 0) usage.startedAt = timestamp;
			usage.endedAt = Math.max(usage.endedAt, timestamp);
		}
		switch (entry.type) {
			case "session":
				usage.id = entry.id;
				break;
			case "session_info":
				usage.title = entry.name ?? "";
				break;
			case "model_change":
				model = `${entry.provider}/${entry.modelId}`;
				break;
			case "compaction":
				usage.compactions++;
				compactionTurns.push(usage.turns);
				if (entry.usage) {
					usage.billed += entry.usage.input + entry.usage.output + entry.usage.cacheRead + entry.usage.cacheWrite;
					usage.cost += entry.usage.cost?.total ?? 0;
				}
				break;
			case "custom":
				if (entry.customType === "analyst-turn" && entry.data && typeof entry.data === "object") {
					const data = entry.data as Partial<PromptSample>;
					currentPrompt = {
						prompt: data.prompt ?? 0,
						base: data.base ?? 0,
						sources: data.sources ?? {},
					};
					promptSamples.push(currentPrompt);
				}
				break;
			case "custom_message": {
				const tokens = contentTokens(entry.content);
				const key = entry.customType;
				const record = bucket(usage.customMessages, key, () => ({ count: 0, tokens: 0, carry: 0 }));
				record.count++;
				record.tokens += tokens;
				pending.push({ kind: "custom", key, tokens, turn: usage.turns });
				break;
			}
			case "message": {
				const message = entry.message as {
					role?: string;
					content?: unknown;
					toolName?: string;
					isError?: boolean;
					provider?: string;
					model?: string;
					usage?: {
						input?: number;
						output?: number;
						cacheRead?: number;
						cacheWrite?: number;
						reasoning?: number;
						cost?: { total?: number };
					};
				};
				if (message.role === "user") {
					usage.userTokens += contentTokens(message.content);
				} else if (message.role === "assistant") {
					const turn: TurnUsage = {
						input: message.usage?.input ?? 0,
						output: message.usage?.output ?? 0,
						cacheRead: message.usage?.cacheRead ?? 0,
						cacheWrite: message.usage?.cacheWrite ?? 0,
						reasoning: message.usage?.reasoning ?? 0,
						cost: message.usage?.cost?.total ?? 0,
						context: 0,
						model: message.provider && message.model ? `${message.provider}/${message.model}` : model,
					};
					turn.context = turn.input + turn.cacheRead + turn.cacheWrite;
					if (turn.context === 0 && turn.output === 0) break; // an aborted or empty turn
					usage.turns++;
					usage.input += turn.input;
					usage.output += turn.output;
					usage.reasoning += turn.reasoning;
					usage.cacheRead += turn.cacheRead;
					usage.cacheWrite += turn.cacheWrite;
					usage.cost += turn.cost;
					usage.billed += turn.context + turn.output;
					usage.peakContext = Math.max(usage.peakContext, turn.context);
					contextSum += turn.context;
					usage.assistantTextTokens += contentTokens(
						Array.isArray(message.content)
							? (message.content as { type?: string }[]).filter((block) => block.type === "text")
							: message.content,
					);
					const byModel = bucket(usage.byModel, turn.model || "unknown", () => ({
						turns: 0,
						billed: 0,
						cost: 0,
						cacheRead: 0,
						cacheable: 0,
					}));
					byModel.turns++;
					byModel.billed += turn.context + turn.output;
					byModel.cost += turn.cost;
					if (usage.turns > 1) {
						usage.cacheable += turn.context;
						usage.cacheHits += turn.cacheRead;
						byModel.cacheable += turn.context;
						byModel.cacheRead += turn.cacheRead;
						if (turn.cacheRead === 0 && turn.cacheWrite === 0 && turn.context >= CACHE_MISS_FLOOR) {
							usage.missTurns++;
							usage.missTokens += turn.context;
						}
					}
					if (currentPrompt) {
						promptTurns++;
						promptTokenSum += currentPrompt.prompt;
						baseTokenSum += currentPrompt.base;
						for (const [source, tokens] of Object.entries(currentPrompt.sources)) {
							const record = bucket(promptCarry, source, () => ({ carry: 0, turns: 0 }));
							record.carry += tokens;
							record.turns++;
						}
					}
				} else if (message.role === "toolResult") {
					const name = message.toolName ?? "unknown";
					const tokens = contentTokens(message.content);
					const tool = bucket(usage.tools, name, () => ({ count: 0, errors: 0, tokens: 0, carry: 0, largest: 0 }));
					tool.count++;
					if (message.isError) tool.errors++;
					tool.tokens += tokens;
					tool.largest = Math.max(tool.largest, tokens);
					pending.push({ kind: "tool", key: name, tokens, turn: usage.turns });
					usage.largest.push({ tool: name, tokens, turn: usage.turns });
					if (tokens >= 500) {
						const hash = contentHash(message.content);
						const seen = seenResults.get(hash) ?? 0;
						seenResults.set(hash, seen + 1);
						if (seen > 0) {
							usage.duplicates.count++;
							usage.duplicates.tokens += tokens;
							pending.push({ kind: "duplicate", key: name, tokens, turn: usage.turns });
						}
					}
				}
				break;
			}
			default:
				break;
		}
	}

	// Carry: a piece of context recorded after turn t rides every later turn
	// until the next compaction folds it away, or the session ends.
	const turnsCarried = (turn: number): number => {
		const next = compactionTurns.find((at) => at > turn) ?? usage.turns;
		return Math.max(0, next - turn);
	};
	for (const item of pending) {
		const carry = item.tokens * turnsCarried(item.turn);
		if (item.kind === "tool") {
			const tool = usage.tools[item.key];
			if (tool) tool.carry += carry;
		} else if (item.kind === "custom") {
			const record = usage.customMessages[item.key];
			if (record) record.carry += carry;
		} else {
			usage.duplicates.carry += carry;
		}
	}
	usage.largest.sort((a, b) => b.tokens - a.tokens);
	usage.largest = usage.largest.slice(0, 5);
	usage.meanContext = usage.turns === 0 ? 0 : Math.round(contextSum / usage.turns);
	if (promptSamples.length > 0 && promptTurns > 0) {
		const sources: Record<string, SourceUsage> = {};
		for (const [source, record] of Object.entries(promptCarry)) {
			sources[source] = {
				carry: record.carry,
				perTurn: Math.round(record.carry / record.turns),
				turns: record.turns,
			};
		}
		usage.prompt = {
			samples: promptSamples.length,
			perTurn: Math.round(promptTokenSum / promptTurns),
			base: Math.round(baseTokenSum / promptTurns),
			sources,
		};
	}
	return usage;
}

// ----------------------------------------------------------------------------
// Across sessions: totals and findings
// ----------------------------------------------------------------------------

export interface ChildRunUsage {
	extension: "research" | "battletest";
	run: string;
	members: number;
	tokens: number;
	cost: number;
	/** Rows written before cache tokens were counted show a fraction of the truth. */
	whole: boolean;
}

export interface Finding {
	/** What kind of hole this is. */
	kind:
		| "prompt-block"
		| "tool-carry"
		| "cache-miss"
		| "duplicates"
		| "no-compaction"
		| "reasoning"
		| "custom-messages"
		| "child-runs";
	/** Tokens at stake, for ranking. */
	tokens: number;
	title: string;
	evidence: string;
	/** The extension, and the file, where the fix goes. */
	where: string;
	fix: string;
}

export interface UsageReport {
	sessions: SessionUsage[];
	childRuns: ChildRunUsage[];
	totals: {
		sessions: number;
		turns: number;
		billed: number;
		cost: number;
		output: number;
		reasoning: number;
		cacheRead: number;
		cacheable: number;
		missTokens: number;
		missTurns: number;
	};
	/** Tokens riding context, by the extension or mechanism that put them there. */
	bySource: { source: string; carry: number; where: string }[];
	findings: Finding[];
}

function sourceFile(source: string): string {
	const signature = BLOCK_SIGNATURES.find((candidate) => candidate.source === source);
	if (signature) return signature.file;
	if (source.startsWith("cues")) return "src/extensions/cues/cues.ts";
	return "the extension that appends it";
}

function toolOwner(name: string): { extension: string; file: string } {
	return TOOL_SOURCES[name] ?? { extension: `an extension registering '${name}'`, file: "its index.ts" };
}

const PROMPT_FIXES: Record<string, string> = {
	learning: "Trim the self-learning instructions; they need to say what to persist, not how memory works.",
	"learning (memory)":
		"Lower the memory char limit, or prune entries: every character here is re-sent on every turn of every session.",
	"learning (user profile)": "Keep the profile to what changes how the agent works; drop the rest.",
	wayfinder:
		"Only the active map's one-line summary belongs on every turn; the doctrine can live in the tool description.",
	goal: "Keep the objective block to the objective and the stop condition.",
	tools: "This one is small by design; leave it.",
};

/** Turn per-session usage into the cross-session picture and the ranked findings. */
export function buildReport(sessions: SessionUsage[], childRuns: ChildRunUsage[] = []): UsageReport {
	const totals = {
		sessions: sessions.length,
		turns: 0,
		billed: 0,
		cost: 0,
		output: 0,
		reasoning: 0,
		cacheRead: 0,
		cacheable: 0,
		missTokens: 0,
		missTurns: 0,
	};
	const promptCarry: Record<string, { carry: number; perTurnSum: number; sessions: number }> = {};
	const toolCarry: Record<string, ToolUsage> = {};
	const customCarry: Record<string, { count: number; tokens: number; carry: number }> = {};
	const byModel: Record<
		string,
		{ turns: number; billed: number; cost: number; cacheRead: number; cacheable: number }
	> = {};
	let basePromptCarry = 0;
	let contextTotal = 0;
	let userCarry = 0;
	let outputCarry = 0;
	let duplicates = { count: 0, tokens: 0, carry: 0 };
	let noCompaction: { session: SessionUsage; over: number }[] = [];

	for (const session of sessions) {
		totals.turns += session.turns;
		totals.billed += session.billed;
		totals.cost += session.cost;
		totals.output += session.output;
		totals.reasoning += session.reasoning;
		totals.cacheRead += session.cacheHits;
		totals.cacheable += session.cacheable;
		contextTotal += Math.max(0, session.billed - session.output);
		totals.missTokens += session.missTokens;
		totals.missTurns += session.missTurns;
		if (session.prompt) {
			basePromptCarry += session.prompt.base * session.turns;
			for (const [source, record] of Object.entries(session.prompt.sources)) {
				const total = bucket(promptCarry, source, () => ({ carry: 0, perTurnSum: 0, sessions: 0 }));
				total.carry += record.carry;
				total.perTurnSum += record.perTurn;
				total.sessions++;
			}
		}
		for (const [name, tool] of Object.entries(session.tools)) {
			const total = bucket(toolCarry, name, () => ({ count: 0, errors: 0, tokens: 0, carry: 0, largest: 0 }));
			total.count += tool.count;
			total.errors += tool.errors;
			total.tokens += tool.tokens;
			total.carry += tool.carry;
			total.largest = Math.max(total.largest, tool.largest);
		}
		for (const [type, record] of Object.entries(session.customMessages)) {
			const total = bucket(customCarry, type, () => ({ count: 0, tokens: 0, carry: 0 }));
			total.count += record.count;
			total.tokens += record.tokens;
			total.carry += record.carry;
		}
		for (const [model, record] of Object.entries(session.byModel)) {
			const total = bucket(byModel, model, () => ({ turns: 0, billed: 0, cost: 0, cacheRead: 0, cacheable: 0 }));
			total.turns += record.turns;
			total.billed += record.billed;
			total.cost += record.cost;
			total.cacheRead += record.cacheRead;
			total.cacheable += record.cacheable;
		}
		// The user's words and the model's replies ride too; roughly half the
		// session on average, since they arrive spread across it.
		userCarry += Math.round((session.userTokens * session.turns) / 2);
		outputCarry += Math.round((session.assistantTextTokens * session.turns) / 2);
		duplicates = {
			count: duplicates.count + session.duplicates.count,
			tokens: duplicates.tokens + session.duplicates.tokens,
			carry: duplicates.carry + session.duplicates.carry,
		};
		// A long session that never compacted is the commonest hole of all: the
		// threshold sits at the context window minus a reserve, which a large
		// window never reaches, so every tool result ever returned rides to the end.
		if (session.compactions === 0 && session.turns >= 30 && session.peakContext >= 100_000) {
			noCompaction.push({ session, over: session.peakContext });
		}
	}
	noCompaction = noCompaction.sort((a, b) => b.session.billed - a.session.billed).slice(0, 5);

	const bySource: UsageReport["bySource"] = [];
	if (basePromptCarry > 0) {
		bySource.push({ source: "core system prompt", carry: basePromptCarry, where: "src/core/system-prompt.ts" });
	}
	for (const [source, record] of Object.entries(promptCarry)) {
		bySource.push({ source: `${source} (system prompt)`, carry: record.carry, where: sourceFile(source) });
	}
	for (const [name, tool] of Object.entries(toolCarry)) {
		const owner = toolOwner(name);
		bySource.push({ source: `${name} results (${owner.extension})`, carry: tool.carry, where: owner.file });
	}
	for (const [type, record] of Object.entries(customCarry)) {
		bySource.push({
			source: `${type} messages (${CUSTOM_MESSAGE_SOURCES[type] ?? "an extension"})`,
			carry: record.carry,
			where: "the extension calling sendMessage",
		});
	}
	if (userCarry > 0) bySource.push({ source: "the user's messages", carry: userCarry, where: "—" });
	if (outputCarry > 0) bySource.push({ source: "the agent's replies", carry: outputCarry, where: "—" });
	// What the bill holds beyond everything above: the system prompt and tool
	// schemas in sessions with no per-turn record, and the rounding in the
	// estimates. Shown so a share is a share of the bill, not of what was traced.
	const attributed = bySource.reduce((sum, row) => sum + row.carry, 0);
	if (contextTotal > attributed) {
		bySource.push({
			source: "system prompt, tool schemas, and context not traced",
			carry: contextTotal - attributed,
			where: "src/core/system-prompt.ts — the analyst records the prompt per turn from now on",
		});
	}
	bySource.sort((a, b) => b.carry - a.carry);

	const findings: Finding[] = [];

	for (const [source, record] of Object.entries(promptCarry)) {
		const perTurn = Math.round(record.perTurnSum / record.sessions);
		if (perTurn < 1500) continue;
		findings.push({
			kind: "prompt-block",
			tokens: record.carry,
			title: `${source} rides every turn at ~${fmt(perTurn)} tokens`,
			evidence: `Present in ${record.sessions} of ${sessions.length} sessions; ${fmt(record.carry)} tokens of context over ${fmt(totals.turns)} turns came from this block alone.`,
			where: sourceFile(source),
			fix:
				PROMPT_FIXES[source] ??
				"Ask whether every turn needs this; inject it when its trigger is live, and keep it short.",
		});
	}

	for (const [name, tool] of Object.entries(toolCarry)) {
		if (tool.carry < 100_000 && tool.carry < totals.billed * 0.05) continue;
		const owner = toolOwner(name);
		const mean = Math.round(tool.tokens / Math.max(1, tool.count));
		findings.push({
			kind: "tool-carry",
			tokens: tool.carry,
			title: `${name} results carried ${fmt(tool.carry)} tokens through later turns`,
			evidence: `${tool.count} results, ${fmt(tool.tokens)} tokens returned (mean ${fmt(mean)}, largest ${fmt(tool.largest)}${tool.errors > 0 ? `, ${tool.errors} errors` : ""}).`,
			where: `${owner.extension} — ${owner.file}`,
			fix:
				tool.count >= 100 && mean < 2000
					? "The results are small; the hole is that every one of them rides to the end of the session. Shed old tool results before each model call in the parent session the way lean.ts does for research and battletest children (a context handler that stubs results older than the last few), or compact sooner."
					: tool.largest >= 8000
						? "Cap the result at the boundary (the tools extension's 10K budget does this for the built-ins), and ask for the range or the field rather than the whole thing."
						: "Many small results add up: batch reads into one call, and shed results once their substance is in a note or a file.",
		});
	}

	if (totals.missTokens >= 50_000) {
		const worst = Object.entries(byModel)
			.filter(([, record]) => record.cacheable > 0)
			.map(([model, record]) => ({ model, hit: record.cacheRead / record.cacheable, cacheable: record.cacheable }))
			.sort((a, b) => a.hit - b.hit)
			.slice(0, 3)
			.map(
				(entry) =>
					`${entry.model}: ${Math.round(entry.hit * 100)}% of ${fmt(entry.cacheable)} cacheable tokens read from cache`,
			)
			.join("; ");
		findings.push({
			kind: "cache-miss",
			tokens: totals.missTokens,
			title: `${fmt(totals.missTokens)} tokens re-sent at full price with no cache hit`,
			evidence: `${totals.missTurns} turns over ${fmt(CACHE_MISS_FLOOR)} tokens of context reported neither a cache read nor a cache write. By model — ${worst || "no model reported cacheable turns"}.`,
			where: "the provider adapter in packages/ai/src/api, or whatever changes the prompt prefix between turns",
			fix: "Confirm the provider caches at all (some report cached_tokens only on some routes), and that nothing near the front of the prompt varies per turn — a timestamp, a live roster line, a re-ordered tool list. Prefer a model whose provider reports cache reads.",
		});
	}

	if (duplicates.tokens >= 20_000) {
		findings.push({
			kind: "duplicates",
			tokens: duplicates.carry,
			title: `${duplicates.count} tool results were exact repeats of earlier ones`,
			evidence: `${fmt(duplicates.tokens)} tokens returned twice or more, riding ${fmt(duplicates.carry)} tokens of later context.`,
			where: "the reading habits in the system prompt — src/extensions/tools/index.ts",
			fix: "Re-reading a file already in context is the commonest cause; the tools extension's habits say not to, so check it is on, and that compaction is not dropping what the agent then re-fetches.",
		});
	}

	if (noCompaction.length > 0) {
		const worst = noCompaction[0]?.session;
		const listed = noCompaction
			.map(
				(entry) =>
					`${sessionLabel(entry.session)} (${entry.session.turns} turns, mean context ${fmt(entry.session.meanContext)}, ${fmt(entry.session.billed)} billed)`,
			)
			.join("; ");
		findings.push({
			kind: "no-compaction",
			tokens: noCompaction.reduce((sum, entry) => sum + entry.session.billed, 0),
			title: `${noCompaction.length} long session${noCompaction.length === 1 ? "" : "s"} never compacted — the biggest ran ${worst?.turns ?? 0} turns to ${fmt(worst?.peakContext ?? 0)} tokens of context`,
			evidence: `Every tool result these sessions ever returned rode to their last turn: ${listed}.`,
			where: "compaction — src/core/settings-manager.ts (reserveTokens), src/core/compaction; shedding — nothing in the parent session does what src/extensions/battletest/lean.ts does for children",
			fix: "Compaction fires at the context window minus reserveTokens (16K by default), which a large-window model never reaches. Either set a lower ceiling for compaction, or give the parent session the lean child's context handler: stub tool results older than the last few before each model call, in batches so the cached prefix survives.",
		});
	}

	if (totals.output >= 50_000 && totals.reasoning >= totals.output * 0.4) {
		findings.push({
			kind: "reasoning",
			tokens: totals.reasoning,
			title: `Thinking is ${Math.round((totals.reasoning / totals.output) * 100)}% of everything the model wrote`,
			evidence: `${fmt(totals.reasoning)} reasoning tokens of ${fmt(totals.output)} output.`,
			where: "the thinking level — settings.json defaultThinkingLevel, src/extensions/auto-thinking",
			fix: "Output tokens cost several times input. A lower default with auto-thinking raising it for the hard turns is usually cheaper than a high default for every turn.",
		});
	}

	for (const [type, record] of Object.entries(customCarry)) {
		if (record.carry < 50_000) continue;
		findings.push({
			kind: "custom-messages",
			tokens: record.carry,
			title: `'${type}' messages carried ${fmt(record.carry)} tokens through later turns`,
			evidence: `${record.count} messages, ${fmt(record.tokens)} tokens, from ${CUSTOM_MESSAGE_SOURCES[type] ?? "an extension"}.`,
			where: "the extension calling sendMessage with that customType",
			fix: "A message injected into the conversation stays there; if it is a nudge or a status, make it short, or send it once rather than on a schedule.",
		});
	}

	const childTotal = childRuns.reduce((sum, run) => sum + run.tokens, 0);
	if (childTotal > 0) {
		const top = [...childRuns]
			.sort((a, b) => b.tokens - a.tokens)
			.slice(0, 5)
			.map(
				(run) =>
					`${run.extension} '${run.run}': ${run.members} members, ${fmt(run.tokens)} tokens${run.cost > 0 ? ` ($${run.cost.toFixed(2)})` : ""}${run.whole ? "" : " (fresh tokens only; recorded before cache reads were counted)"}`,
			)
			.join("; ");
		findings.push({
			kind: "child-runs",
			tokens: childTotal,
			title: `Research and battletest runs spent ${fmt(childTotal)} tokens in child sessions`,
			evidence: `${childRuns.length} runs recorded in this project's store. Largest — ${top}.`,
			where: "src/extensions/battletest/lean.ts (what children carry), src/extensions/research/index.ts (action budgets, waves)",
			fix: "Every child action re-reads the child's whole context: cut the action budgets, keep the lean extension's shedding on, and put children on a cheaper model with 'using <provider> <model>'.",
		});
	}

	findings.sort((a, b) => b.tokens - a.tokens);
	return { sessions, childRuns, totals, bySource, findings };
}

// ----------------------------------------------------------------------------
// Rendering
// ----------------------------------------------------------------------------

export function fmt(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
	if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
	return String(Math.round(tokens));
}

function sessionLabel(session: SessionUsage): string {
	const when = session.startedAt > 0 ? new Date(session.startedAt).toISOString().slice(0, 16).replace("T", " ") : "";
	const title = session.title.trim() !== "" ? session.title.trim() : session.id.slice(0, 8);
	return `${when} ${title}`.trim();
}

/** The report as Markdown, written to disk and handed to the agent. */
export function renderReport(
	report: UsageReport,
	options: { scope: string; generatedAt?: Date } = { scope: "" },
): string {
	const { totals } = report;
	const hit = totals.cacheable > 0 ? Math.min(100, Math.round((totals.cacheRead / totals.cacheable) * 100)) : 0;
	const lines: string[] = [];
	lines.push(`# Token usage — ${options.scope}`);
	lines.push("");
	lines.push(`Generated ${(options.generatedAt ?? new Date()).toISOString()}.`);
	lines.push("");
	lines.push("## Headline");
	lines.push("");
	lines.push("| | |");
	lines.push("|---|---|");
	lines.push(`| Sessions | ${totals.sessions} |`);
	lines.push(`| Model turns | ${fmt(totals.turns)} |`);
	lines.push(`| Tokens billed | ${fmt(totals.billed)}${totals.cost > 0 ? ` ($${totals.cost.toFixed(2)})` : ""} |`);
	lines.push(`| Output (thinking) | ${fmt(totals.output)} (${fmt(totals.reasoning)}) |`);
	lines.push(`| Cache hit rate | ${hit}% of ${fmt(totals.cacheable)} cacheable tokens |`);
	lines.push(`| Full-price re-sends | ${fmt(totals.missTokens)} tokens over ${totals.missTurns} turns |`);
	lines.push("");
	lines.push("## What rides the context, by source");
	lines.push("");
	lines.push("Tokens × turns each piece stayed in context. This is the bill, attributed.");
	lines.push("");
	lines.push("| Source | Carried tokens | Share | Where |");
	lines.push("|---|---:|---:|---|");
	const carried = report.bySource.reduce((sum, row) => sum + row.carry, 0);
	for (const row of report.bySource.slice(0, 15)) {
		const share = carried > 0 ? Math.round((row.carry / carried) * 100) : 0;
		lines.push(`| ${row.source} | ${fmt(row.carry)} | ${share}% | ${row.where} |`);
	}
	lines.push("");
	lines.push("## Findings — where to fix");
	lines.push("");
	if (report.findings.length === 0) {
		lines.push(
			"Nothing egregious in this range: no prompt block over 1.5K tokens a turn, no tool carrying more than a twentieth of the bill, no uncached re-sends worth naming.",
		);
	}
	for (const [index, finding] of report.findings.entries()) {
		lines.push(`### ${index + 1}. ${finding.title}`);
		lines.push("");
		lines.push(`- **At stake:** ${fmt(finding.tokens)} tokens`);
		lines.push(`- **Evidence:** ${finding.evidence}`);
		lines.push(`- **Where:** ${finding.where}`);
		lines.push(`- **Fix:** ${finding.fix}`);
		lines.push("");
	}
	lines.push("## Sessions");
	lines.push("");
	lines.push("| Session | Turns | Billed | Cache hit | Peak context | Compactions |");
	lines.push("|---|---:|---:|---:|---:|---:|");
	for (const session of [...report.sessions].sort((a, b) => b.billed - a.billed).slice(0, 20)) {
		const sessionHit =
			session.cacheable > 0 ? `${Math.min(100, Math.round((session.cacheHits / session.cacheable) * 100))}%` : "—";
		lines.push(
			`| ${sessionLabel(session)} | ${session.turns} | ${fmt(session.billed)} | ${sessionHit} | ${fmt(session.peakContext)} | ${session.compactions} |`,
		);
	}
	const withoutPrompt = report.sessions.filter((session) => session.prompt === undefined).length;
	if (withoutPrompt > 0) {
		lines.push("");
		lines.push(
			`${withoutPrompt} of ${report.sessions.length} sessions predate the analyst's per-turn prompt records, so their system-prompt blocks are not attributed; their tool results and cache figures are.`,
		);
	}
	return `${lines.join("\n")}\n`;
}
