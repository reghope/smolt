/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * This class is shared between all run modes (interactive, print, rpc).
 * It encapsulates:
 * - Agent state access
 * - Event subscription with automatic session persistence
 * - Model and thinking level management
 * - Compaction (manual and auto)
 * - Bash execution
 * - Session switching and branching
 *
 * Modes use this class and add their own I/O layer on top.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
	Agent,
	AgentEvent,
	AgentMessage,
	AgentState,
	AgentTool,
	PrepareNextTurnContext,
	ThinkingLevel,
} from "@smolt/agent-core";
import { type Credential, contentText, type ProviderUsage, supportsProviderUsage, type UsageWindow } from "@smolt/ai";
import type {
	AssistantMessage,
	AuthResult,
	ImageContent,
	Model,
	ProviderHeaders,
	TextContent,
	Usage,
} from "@smolt/ai/compat";
import {
	clampThinkingLevel,
	cleanupSessionResources,
	fetchProviderUsage,
	getSupportedThinkingLevels,
	isContextOverflow,
	isRecoverableLength,
	isRetryableAssistantError,
	modelsAreEqual,
	type RetryCallbacks,
	resetApiProviders,
	streamSimple,
} from "@smolt/ai/compat";
import { Type } from "typebox";
import { getAgentDir } from "../config.ts";
import { isProviderPooled, type PoolData, PoolStore, primaryLabelOf } from "../extensions/pool/storage.ts";
import { getThemeByName, theme } from "../modes/interactive/theme/theme.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import { sleep } from "../utils/sleep.ts";
import { normalizeToolResultImages } from "../utils/tool-result-images.ts";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "./auth-guidance.ts";
import { type BashResult, executeBashWithOperations } from "./bash-executor.ts";
import {
	type CompactionPreparation,
	type CompactionResult,
	type CompactionSettings,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	compact,
	compactionSettingsFor,
	completeSummarization,
	estimateContextTokens,
	estimateTokens,
	generateBranchSummary,
	prepareCompaction,
	shouldCompact,
	shouldCompactBeforeNextStep,
} from "./compaction/index.ts";
import { DEFAULT_THINKING_LEVEL, THINKING_LEVEL_OPTIONS } from "./defaults.ts";
import { exportSessionToHtml, type ToolHtmlRenderer } from "./export-html/index.ts";
import { createToolHtmlRenderer } from "./export-html/tool-renderer.ts";
import {
	type ContextBreakdown,
	type ContextBreakdownItem,
	type ContextBreakdownPart,
	type ContextUsage,
	type ExtensionCommandContext,
	type ExtensionCommandContextActions,
	type ExtensionErrorListener,
	type ExtensionMode,
	ExtensionRunner,
	type ExtensionUIContext,
	type InputSource,
	type MessageEndEvent,
	type MessageStartEvent,
	type MessageUpdateEvent,
	type ReplacedSessionContext,
	type SessionBeforeCompactResult,
	type SessionBeforeTreeResult,
	type SessionCompactFailedEvent,
	type SessionStartEvent,
	type ShutdownHandler,
	type ToolDefinition,
	type ToolExecutionEndEvent,
	type ToolExecutionStartEvent,
	type ToolExecutionUpdateEvent,
	type ToolInfo,
	type TreePreparation,
	type TurnEndEvent,
	type TurnStartEvent,
	wrapRegisteredTools,
} from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import type { BashExecutionMessage, CustomMessage } from "./messages.ts";
import { countImages, MAX_IMAGES_PER_REQUEST } from "./messages.ts";
import { ModelRegistry } from "./model-registry.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.ts";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.ts";
import { exportSessionToJsonl } from "./session-export.ts";
import type { BranchSummaryEntry, CompactionEntry, SessionEntry, SessionManager } from "./session-manager.ts";
import { getLatestCompactionEntry } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";
import type { SlashCommandInfo } from "./slash-commands.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "./system-prompt.ts";
import { type BashOperations, createLocalBashOperations } from "./tools/bash.ts";
import { createAllToolDefinitions, type ToolsOptions } from "./tools/index.ts";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.ts";
import { addUsageToTotals, createUsageTotals } from "./usage-totals.ts";

// ============================================================================
// Skill Block Parsing
// ============================================================================

/** Parsed skill block from a user message */
export interface ParsedSkillBlock {
	name: string;
	location: string;
	content: string;
	userMessage: string | undefined;
}

/**
 * Parse a skill block from message text.
 * Returns null if the text doesn't contain a skill block.
 */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
	if (!match) return null;
	return {
		name: match[1],
		location: match[2],
		content: match[3],
		userMessage: match[4]?.trim() || undefined,
	};
}

/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent =
	| Exclude<AgentEvent, { type: "agent_end" }>
	| {
			type: "agent_end";
			messages: AgentMessage[];
			willRetry: boolean;
	  }
	| { type: "agent_settled" }
	| {
			type: "queue_update";
			steering: readonly string[];
			followUp: readonly string[];
	  }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| { type: "entry_appended"; entry: SessionEntry }
	| { type: "session_info_changed"; name: string | undefined }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| {
			type: "summarization_retry_scheduled";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| { type: "summarization_retry_attempt_start"; source: "branchSummary" }
	| {
			type: "summarization_retry_attempt_start";
			source: "compaction";
			reason: "manual" | "threshold" | "overflow";
	  }
	| { type: "summarization_retry_finished" }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| { type: "bash_execution_update"; id?: string; delta: string };

/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

// ============================================================================
// Types
// ============================================================================

function withoutDeletedHeaders(headers: ProviderHeaders | undefined): Record<string, string> | undefined {
	return headers
		? Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null))
		: undefined;
}

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	cwd: string;
	/** Models to cycle through with Ctrl+P (from --models flag) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	/** Resource loader for extensions, skills, prompts, themes, context files, and system prompt */
	resourceLoader: ResourceLoader;
	/** SDK custom tools registered outside extensions */
	customTools?: ToolDefinition[];
	/** Canonical model/auth runtime used by coding-agent internals. */
	modelRuntime: ModelRuntime;
	/** Initial active built-in tool names. Default: [read, bash, edit, write] */
	initialActiveToolNames?: string[];
	/** Optional allowlist of tool names. When provided, only these tool names are exposed. */
	allowedToolNames?: string[];
	/** Optional denylist of tool names. When provided, these tool names are not exposed. */
	excludedToolNames?: string[];
	/**
	 * Override base tools (useful for custom runtimes).
	 *
	 * These are synthesized into minimal ToolDefinitions internally so AgentSession can keep
	 * a definition-first registry even when callers provide plain AgentTool instances.
	 */
	baseToolsOverride?: Record<string, AgentTool>;
	/**
	 * Per-tool construction options for the built-in tools.
	 *
	 * Merged over the settings-derived options (shell path, command prefix),
	 * so a session can tune one aspect — a default shell timeout, say —
	 * without re-specifying the rest.
	 */
	toolsOptions?: ToolsOptions;
	/** Mutable ref used by Agent to access the current ExtensionRunner */
	extensionRunnerRef?: { current?: ExtensionRunner };
	/** Session start event metadata emitted when extensions bind to this runtime. */
	sessionStartEvent?: SessionStartEvent;
}

export interface ExtensionBindings {
	uiContext?: ExtensionUIContext;
	mode?: ExtensionMode;
	commandContextActions?: ExtensionCommandContextActions;
	abortHandler?: () => void;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
}

/**
 * What the one-line answer to a command is asked for.
 *
 * Deliberately narrow. The call exists to fill a silence, so anything beyond
 * a single plain sentence is worse than nothing: it pushes the real work down
 * the screen and invites the model to invent detail it was never given.
 */
const COMMAND_LINE_SYSTEM_PROMPT =
	"You are the assistant in a coding chat. The user ran a command that the app carried out " +
	"by itself. Tell them what happened in one short, plain sentence, in your own words, as if " +
	"you had done it. Do not greet them, do not offer to help further, do not use markdown, and " +
	"do not add anything after the sentence. If the command asked the user for something, ask " +
	"them for it in that sentence.";

/** Room for a sentence and no more; a ceiling is cheaper than a plea. */
const COMMAND_LINE_MAX_TOKENS = 200;

/** The tool the agent reaches for when it decides a slash command is what was asked for. */
const COMMAND_TOOL_NAME = "command";

/**
 * Commands the agent must not be handed.
 *
 * `/telegram new` and `/telegram inbound` call `ctx.newSession()` from inside
 * the handler. Run from a tool call that is itself inside a turn, that would
 * be starting a session on top of the one currently executing it, so these
 * stay on the harness's own dispatch.
 */
const HARNESS_ONLY_COMMANDS = new Set(["telegram"]);

/** Build user content, giving image-only input a placeholder so no provider sees an empty text part. */
function userContentOf(text: string, images?: ImageContent[]): (TextContent | ImageContent)[] {
	const hasImages = images !== undefined && images.length > 0;
	const body = text.trim() === "" && hasImages ? "The user has provided an image with this message" : text;
	return [{ type: "text", text: body }, ...(images ?? [])];
}

/** Options for AgentSession.prompt() */
export interface PromptOptions {
	/** Whether to dispatch extension commands and expand skill commands and prompt templates (default: true) */
	expandPromptTemplates?: boolean;
	/** Image attachments */
	images?: ImageContent[];
	/** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). Required if streaming. */
	streamingBehavior?: "steer" | "followUp";
	/** Source of input for extension input event handlers. Defaults to "interactive". */
	source?: InputSource;
	/** Internal hook used by RPC mode to observe prompt preflight acceptance or rejection. */
	preflightResult?: (success: boolean) => void;
}

/** Options for model/thinking mutations. */
export interface ModelMutationOptions {
	/** Persist the new value to global defaults. Defaults to session-only. */
	persist?: boolean;
}

/** Result from cycleModel() */
export interface ModelCycleResult {
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	/** Whether cycling through scoped models (--models flag) or all available */
	isScoped: boolean;
}

/** Session statistics for /session command */
export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	contextUsage?: ContextUsage;
	/**
	 * Spend on the session's behalf outside its own requests: a research
	 * team's sessions reported through its tool results, an advisor's
	 * reviews filed as custom entries. Counted in `tokens` and `cost` too.
	 */
	background: BackgroundSpend[];
}

export interface BackgroundSpend {
	key: string;
	label: string;
	tokens: number;
	cost: number;
	requests: number;
}

/** What an advisor files after each review, as a custom entry. */
export const ADVISOR_USAGE_ENTRY = "advisor-usage";

/** Subscription usage for the session's provider, with a drain-rate projection. */
export interface ProviderUsageSnapshot extends ProviderUsage {
	/** Most-consumed window; the one that limits the session first. */
	bindingWindow?: string;
	/** Hours until the binding window is exhausted at the observed rate. */
	hoursLeft?: number;
	/** Minutes of history the projection is based on; absent when unmeasurable. */
	rateSampleMinutes?: number;
	/** Per-account usage when the provider has pool credentials beyond the primary. */
	accounts?: UsageAccount[];
	/**
	 * Every other configured provider that reports usage, so the reader sees
	 * the whole set of allowances they pay for, not only the one in use.
	 */
	others?: ProviderUsageSnapshot[];
	/** True when this is the last good reading, kept while the endpoint is not answering. */
	stale?: boolean;
}

/** One pool credential's own usage. */
export interface UsageAccount {
	label: string;
	windows: UsageWindow[];
}

/** How far back drain-rate samples reach. */
const RATE_SAMPLE_SPAN_MS = 30 * 60 * 1000;

/** How long a provider keeps showing its last good usage reading after its endpoint stops answering. */
const USAGE_STALE_MS = 30 * 60 * 1000;

/**
 * Last good usage reading per provider, shared across agent processes.
 *
 * Every chat runs its own agent process, and usage endpoints rate-limit
 * eagerly when several of them poll at once. A process whose own poll
 * fails — most visibly the first poll after a chat switch — used to show
 * that provider as simply gone; the newest reading any process managed is
 * a far better answer than nothing.
 */
function usageCachePath(): string {
	return join(getAgentDir(), "usage-cache.json");
}

function readUsageCache(): Record<string, ProviderUsage & { accounts: UsageAccount[] }> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(usageCachePath(), "utf8"));
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, ProviderUsage & { accounts: UsageAccount[] }>;
		}
	} catch {
		// Missing or torn file: no shared history to offer.
	}
	return {};
}

function writeUsageCache(reading: ProviderUsage & { accounts: UsageAccount[] }): void {
	try {
		const merged = readUsageCache();
		const previous = merged[reading.providerId];
		if (previous && previous.fetchedAt >= reading.fetchedAt) return;
		merged[reading.providerId] = reading;
		mkdirSync(getAgentDir(), { recursive: true });
		// Write-then-rename so a concurrent reader never sees half a file.
		const tmp = `${usageCachePath()}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(merged));
		renameSync(tmp, usageCachePath());
	} catch {
		// Best-effort cache; a failed write costs nothing but the fallback.
	}
}

/** The shortest gap between two rounds of usage requests, however often the front end asks. */
const USAGE_POLL_MIN_MS = 60 * 1000;

/**
 * Combine per-account windows into one set, assuming equal-size plans: the
 * pooled remaining share of a window is the mean of the accounts' remaining
 * shares. A window is "limited" only when every account is limited, since
 * the pool fails over to whichever account still has headroom.
 */
function aggregateUsageWindows(accounts: UsageAccount[]): UsageWindow[] {
	const keys: string[] = [];
	const byKey = new Map<string, { label: string; percents: number[]; resets: string[]; limited: number }>();
	for (const account of accounts) {
		for (const window_ of account.windows) {
			let bucket = byKey.get(window_.key);
			if (!bucket) {
				bucket = { label: window_.label, percents: [], resets: [], limited: 0 };
				byKey.set(window_.key, bucket);
				keys.push(window_.key);
			}
			bucket.percents.push(window_.percent);
			if (window_.status === "rate-limited") bucket.limited += 1;
			if (window_.resetsAt) bucket.resets.push(window_.resetsAt);
		}
	}
	return keys.map((key) => {
		const bucket = byKey.get(key)!;
		const meanRemaining = bucket.percents.reduce((sum, percent) => sum + (100 - percent), 0) / bucket.percents.length;
		const percent = 100 - meanRemaining;
		const allLimited = bucket.limited === bucket.percents.length;
		const latestReset = bucket.resets.sort().at(-1);
		return {
			key,
			label: bucket.label,
			status: allLimited ? "rate-limited" : percent >= 100 ? "rate-limited" : "ok",
			percent: Math.min(100, Math.max(0, percent)),
			resetsAt: latestReset,
		};
	});
}

/** The most-consumed window: the one that limits the session first. */
function bindingOf(usage: ProviderUsage): UsageWindow | undefined {
	return usage.windows.reduce<UsageWindow | undefined>(
		(top, window_) => (top === undefined || window_.percent > top.percent ? window_ : top),
		undefined,
	);
}

interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

function estimateMessagesTokens(messages: AgentMessage[]): number {
	let tokens = 0;
	for (const message of messages) {
		tokens += estimateTokens(message);
	}
	return tokens;
}

// ============================================================================
// Constants
// ============================================================================

// ============================================================================
// AgentSession Class
// ============================================================================

/**
 * The extension a registered tool belongs to, from where it was loaded:
 * "research" for .../extensions/research/index.ts, "my-hook" for
 * my-hook.ts, nothing for a synthetic source like <sdk:name>.
 */
function extensionLabel(sourcePath: string | undefined): string | undefined {
	if (!sourcePath || sourcePath.startsWith("<")) return undefined;
	const parts = sourcePath.split(/[\\/]/);
	const file = parts.pop() ?? "";
	const stem = file.replace(/\.[cm]?[jt]sx?$/, "");
	return stem === "index" ? parts.pop() : stem;
}

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;

	private _scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	// Event subscription state
	private _unsubscribeAgent?: () => void;
	private _eventListeners: AgentSessionEventListener[] = [];
	private _isAgentRunActive = false;
	private _idleWaitPromise: Promise<void> | undefined;
	private _resolveIdleWait: (() => void) | undefined;

	/** Tracks pending steering messages for UI display. Removed when delivered. */
	private _steeringMessages: string[] = [];
	/** Tracks pending follow-up messages for UI display. Removed when delivered. */
	private _followUpMessages: string[] = [];
	/**
	 * Queued texts that came from an extension rather than the reader — a
	 * research kickoff, a battletest brief. They are not the reader's words,
	 * so a surface restoring the queue to its editor must not get them.
	 */
	private _extensionQueued = new Set<string>();
	/** Messages queued to be included with the next user prompt as context ("asides"). */
	private _pendingNextTurnMessages: CustomMessage[] = [];
	/**
	 * How many times this session has been asked to put something in front of
	 * the model.
	 *
	 * Counted on the way in rather than on arrival, because an extension briefs
	 * the agent without waiting for it: a count taken once the handler returned
	 * would miss a brief still working its way through the awaits, and narrate
	 * over the top of it.
	 *
	 * Only ever compared against itself: a command handler that leaves this
	 * untouched asked the model nothing, and so has nobody to say what it did.
	 */
	private _modelInputs = 0;
	/** Context-only custom messages queued during a run, flushed once the current turn's tool results are in. */
	private _pendingCustomMessages: CustomMessage[] = [];

	// Compaction state
	private _compactionAbortController: AbortController | undefined = undefined;
	private _autoCompactionAbortController: AbortController | undefined = undefined;
	private _overflowRecoveryAttempted = false;
	/** A step crossed the compaction threshold mid-turn: the run was stopped to compact and go on. */
	private _compactBeforeNextStep = false;

	// Branch summarization state
	private _branchSummaryAbortController: AbortController | undefined = undefined;

	// Retry state
	private _retryAbortController: AbortController | undefined = undefined;
	private _retryAttempt = 0;

	// Pending extension abortResponse() request, consumed by _handlePostAgentRun.
	private _abortResponseRequest: { reason: string; retry: boolean; attempt: number; maxAttempts: number } | undefined =
		undefined;

	// Bash execution state
	private readonly _bashAbortControllers = new Set<AbortController>();
	private _pendingBashMessages: BashExecutionMessage[] = [];

	// Extension system
	private _extensionRunner!: ExtensionRunner;
	private _turnIndex = 0;

	private _resourceLoader: ResourceLoader;
	private _customTools: ToolDefinition[];
	private _baseToolDefinitions: Map<string, ToolDefinition> = new Map();
	private _cwd: string;
	private _extensionRunnerRef?: { current?: ExtensionRunner };
	private _initialActiveToolNames?: string[];
	private _allowedToolNames?: Set<string>;
	private _excludedToolNames?: Set<string>;
	private _baseToolsOverride?: Record<string, AgentTool>;
	private _toolsOptions?: ToolsOptions;
	private _sessionStartEvent: SessionStartEvent;
	private _extensionUIContext?: ExtensionUIContext;
	private _extensionMode: ExtensionMode = "print";
	private _extensionCommandContextActions?: ExtensionCommandContextActions;
	private _extensionAbortHandler?: () => void;
	private _extensionShutdownHandler?: ShutdownHandler;
	private _extensionErrorListener?: ExtensionErrorListener;
	private _extensionErrorUnsubscriber?: () => void;

	private _modelRuntime: ModelRuntime;

	// Tool registry for extension getTools/setTools
	private _toolRegistry: Map<string, AgentTool> = new Map();
	private _toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
	private _toolPromptSnippets: Map<string, string> = new Map();
	private _toolPromptGuidelines: Map<string, string[]> = new Map();

	// Base system prompt (without extension appends) - used to apply fresh appends each turn
	private _baseSystemPrompt = "";
	private _baseSystemPromptOptions!: BuildSystemPromptOptions;
	private _systemPromptOverride?: string;

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this.settingsManager = config.settingsManager;
		this._scopedModels = config.scopedModels ?? [];
		this._resourceLoader = config.resourceLoader;
		this._customTools = config.customTools ?? [];
		this._cwd = config.cwd;
		this._modelRuntime = config.modelRuntime;
		this._extensionRunnerRef = config.extensionRunnerRef;
		this._initialActiveToolNames = config.initialActiveToolNames;
		this._allowedToolNames = config.allowedToolNames ? new Set(config.allowedToolNames) : undefined;
		this._excludedToolNames = config.excludedToolNames ? new Set(config.excludedToolNames) : undefined;
		this._baseToolsOverride = config.baseToolsOverride;
		this._toolsOptions = config.toolsOptions;
		this._sessionStartEvent = config.sessionStartEvent ?? { type: "session_start", reason: "startup" };

		// Always subscribe to agent events for internal handling
		// (session persistence, extensions, auto-compaction, retry logic)
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		this._installAgentToolHooks();
		this._installAgentNextTurnRefresh();

		this._buildRuntime({
			activeToolNames: this._initialActiveToolNames,
			includeAllExtensionTools: true,
		});
	}

	get modelRuntime(): ModelRuntime {
		return this._modelRuntime;
	}

	private async _getRequiredRequestAuth(model: Model<any>): Promise<{
		model: Model<any>;
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}> {
		let result: AuthResult | undefined;
		try {
			result = await this._modelRuntime.getAuth(model);
		} catch (error) {
			const cause = error instanceof Error ? error.cause : undefined;
			if (cause instanceof Error && cause.message === "authHeader requires a resolved API key") {
				throw new Error(formatNoApiKeyFoundMessage(model.provider));
			}
			throw error;
		}
		if (result && (result.auth.apiKey || result.auth.headers)) {
			const requestModel = result.auth.baseUrl ? { ...model, baseUrl: result.auth.baseUrl } : model;
			return {
				model: requestModel,
				apiKey: result.auth.apiKey,
				headers: withoutDeletedHeaders(result.auth.headers),
				env: result.env,
			};
		}

		const isOAuth = this._modelRuntime.isUsingOAuth(model.provider);
		if (isOAuth) {
			throw new Error(
				`Authentication failed for "${model.provider}". ` +
					`Credentials may have expired or network is unavailable. ` +
					`Run '/login ${model.provider}' to re-authenticate.`,
			);
		}
		throw new Error(formatNoApiKeyFoundMessage(model.provider));
	}

	private async _getSummarizationRequestAuth(model: Model<any>): Promise<{
		model: Model<any>;
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}> {
		if (this.agent.streamFunction === streamSimple) {
			return this._getRequiredRequestAuth(model);
		}

		try {
			const result = await this._modelRuntime.getAuth(model);
			if (!result) return { model };
			const requestModel = result.auth.baseUrl ? { ...model, baseUrl: result.auth.baseUrl } : model;
			return {
				model: requestModel,
				apiKey: result.auth.apiKey,
				headers: withoutDeletedHeaders(result.auth.headers),
				env: result.env,
			};
		} catch {
			return { model };
		}
	}

	/**
	 * Install tool hooks once on the Agent instance.
	 *
	 * The callbacks read `this._extensionRunner` at execution time, so extension reload swaps in the
	 * new runner without reinstalling hooks. Extension-specific tool wrappers are still used to adapt
	 * registered tool execution to the extension context. Tool call and tool result interception now
	 * happens here instead of in wrappers.
	 */
	private _installAgentToolHooks(): void {
		this.agent.beforeToolCall = async ({ toolCall, args }) => {
			const runner = this._extensionRunner;
			if (!runner.hasHandlers("tool_call")) {
				return undefined;
			}

			try {
				return await runner.emitToolCall({
					type: "tool_call",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					input: args as Record<string, unknown>,
				});
			} catch (err) {
				if (err instanceof Error) {
					throw err;
				}
				throw new Error(`Extension failed, blocking execution: ${String(err)}`);
			}
		};

		this.agent.afterToolCall = async ({ toolCall, args, result, isError }) => {
			const runner = this._extensionRunner;
			const hookResult = runner.hasHandlers("tool_result")
				? await runner.emitToolResult({
						type: "tool_result",
						toolName: toolCall.name,
						toolCallId: toolCall.id,
						input: args as Record<string, unknown>,
						content: result.content,
						details: result.details,
						isError,
						usage: result.usage,
					})
				: undefined;

			const content = hookResult?.content ?? result.content ?? [];
			// Runs after the extension hook so images injected or replaced by extensions are normalized too.
			const normalizedContent = await normalizeToolResultImages(content, {
				autoResizeImages: this.settingsManager.getImageAutoResize(),
			});

			if (!hookResult && normalizedContent === content) {
				return undefined;
			}

			return {
				content: normalizedContent,
				details: hookResult?.details,
				isError: hookResult?.isError ?? isError,
				usage: hookResult?.usage,
			};
		};
	}

	private _installAgentNextTurnRefresh(): void {
		const previousPrepareNextTurnWithContext =
			this.agent.prepareNextTurnWithContext ??
			(this.agent.prepareNextTurn
				? async (_turn: PrepareNextTurnContext, signal?: AbortSignal) => await this.agent.prepareNextTurn?.(signal)
				: undefined);
		this.agent.prepareNextTurnWithContext = async (turn, signal) => {
			const previousSnapshot = await previousPrepareNextTurnWithContext?.(turn, signal);
			const previousContext = previousSnapshot?.context ?? turn.context;

			return {
				...previousSnapshot,
				context: {
					...previousContext,
					systemPrompt: this._systemPromptOverride ?? this._baseSystemPrompt,
					tools: this.agent.state.tools.slice(),
				},
				model: this.agent.state.model,
				thinkingLevel: this.agent.state.thinkingLevel,
			};
		};
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	/** Emit an event to all listeners */
	private _emit(event: AgentSessionEvent): void {
		for (const l of this._eventListeners) {
			l(event);
		}
	}

	private _emitQueueUpdate(): void {
		this._emit({
			type: "queue_update",
			steering: [...this._steeringMessages],
			followUp: [...this._followUpMessages],
		});
	}

	private async _emitSessionCompactFailed(event: Omit<SessionCompactFailedEvent, "type">): Promise<void> {
		if (this._extensionRunner.hasHandlers("session_compact_failed")) {
			await this._extensionRunner.emit({ type: "session_compact_failed", ...event });
		}
	}

	private _getIdleWaitPromise(): Promise<void> {
		if (!this._idleWaitPromise) {
			this._idleWaitPromise = new Promise((resolve) => {
				this._resolveIdleWait = resolve;
			});
		}
		return this._idleWaitPromise;
	}

	private _resolveIdleWaitIfIdle(): void {
		if (this._isAgentRunActive || !this._resolveIdleWait) {
			return;
		}
		const resolve = this._resolveIdleWait;
		this._idleWaitPromise = undefined;
		this._resolveIdleWait = undefined;
		resolve();
	}

	private async _emitAgentSettled(): Promise<void> {
		this._isAgentRunActive = false;
		try {
			await this._extensionRunner.emit({ type: "agent_settled" });
			this._emit({ type: "agent_settled" });
		} finally {
			this._resolveIdleWaitIfIdle();
		}
	}

	// Track last assistant message for auto-compaction check
	private _lastAssistantMessage: AssistantMessage | undefined = undefined;

	/** Internal handler for agent events - shared by subscribe and reconnect */
	private _handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		// When a user message starts, check if it's from either queue and remove it BEFORE emitting
		// This ensures the UI sees the updated queue state
		if (event.type === "message_start" && event.message.role === "user") {
			this._overflowRecoveryAttempted = false;
			const messageText = contentText(event.message.content, "");
			if (messageText) {
				// Check steering queue first
				const steeringIndex = this._steeringMessages.indexOf(messageText);
				if (steeringIndex !== -1) {
					this._steeringMessages.splice(steeringIndex, 1);
					this._emitQueueUpdate();
				} else {
					// Check follow-up queue
					const followUpIndex = this._followUpMessages.indexOf(messageText);
					if (followUpIndex !== -1) {
						this._followUpMessages.splice(followUpIndex, 1);
						this._emitQueueUpdate();
					}
				}
			}
		}

		// Emit to extensions first
		await this._emitExtensionEvent(event);

		// Notify all listeners
		this._emit(event.type === "agent_end" ? { ...event, willRetry: this._willRetryAfterAgentEnd(event) } : event);

		// Handle session persistence
		if (event.type === "message_end") {
			// Check if this is a custom message from extensions
			if (event.message.role === "custom") {
				// Persist as CustomMessageEntry
				this.sessionManager.appendCustomMessageEntry(
					event.message.customType,
					event.message.content,
					event.message.display,
					event.message.details,
				);
			} else if (
				event.message.role === "user" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult"
			) {
				// Regular LLM message - persist as SessionMessageEntry
				this.sessionManager.appendMessage(event.message);
			}
			// Other message types (bashExecution, compactionSummary, branchSummary) are persisted elsewhere

			// Track assistant message for auto-compaction (checked on agent_end)
			if (event.message.role === "assistant") {
				this._lastAssistantMessage = event.message;

				const assistantMsg = event.message as AssistantMessage;
				// A turn that will go on with more tool calls, and has already
				// filled the window: stop it here, compact, and continue, rather
				// than let the next steps run out of room.
				if (
					this._isAgentRunActive &&
					!this._compactBeforeNextStep &&
					this.model &&
					assistantMsg.provider === this.model.provider &&
					assistantMsg.model === this.model.id &&
					shouldCompactBeforeNextStep(assistantMsg, this.model.contextWindow ?? 0, this._compactionSettings())
				) {
					this._compactBeforeNextStep = true;
					this.agent.abort();
				}
				if (assistantMsg.stopReason !== "error" && assistantMsg.stopReason !== "length") {
					this._overflowRecoveryAttempted = false;
				}

				// Reset retry counter immediately on successful assistant response
				// This prevents accumulation across multiple LLM calls within a turn
				if (assistantMsg.stopReason !== "error" && this._retryAttempt > 0) {
					this._emit({
						type: "auto_retry_end",
						success: true,
						attempt: this._retryAttempt,
					});
					this._retryAttempt = 0;
				}
			}
		}

		// A turn ends after its assistant message and every tool result has been appended,
		// so this is the first point in the run where a context-only custom message can be
		// inserted without landing between a tool call and its result. Flushing after the
		// extension and listener dispatch above also picks up messages that turn_end
		// handlers queued.
		if (event.type === "turn_end") {
			this._flushPendingCustomMessages();
		}
	};

	private _willRetryAfterAgentEnd(event: Extract<AgentEvent, { type: "agent_end" }>): boolean {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled || this._retryAttempt >= settings.maxRetries) {
			return false;
		}

		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message.role === "assistant") {
				return this._isRetryableError(message as AssistantMessage);
			}
		}
		return false;
	}

	/** Find the last assistant message in agent state (including aborted ones) */
	private _findLastAssistantMessage(): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				return msg as AssistantMessage;
			}
		}
		return undefined;
	}

	private _replaceMessageInPlace(target: AgentMessage, replacement: AgentMessage): void {
		// Agent-core stores the finalized message object in its state before emitting message_end.
		// SessionManager persistence happens later in _handleAgentEvent() with event.message.
		// Mutating this object in place keeps agent state, later turn/agent events, listeners,
		// and the eventual SessionManager.appendMessage(event.message) persistence in sync.
		if (target === replacement) {
			return;
		}

		const targetRecord = target as unknown as Record<string, unknown>;
		for (const key of Object.keys(targetRecord)) {
			delete targetRecord[key];
		}
		Object.assign(targetRecord, replacement);
	}

	/** Emit extension events based on agent events */
	private async _emitExtensionEvent(event: AgentEvent): Promise<void> {
		if (event.type === "agent_start") {
			this._turnIndex = 0;
			await this._extensionRunner.emit({ type: "agent_start" });
		} else if (event.type === "agent_end") {
			await this._extensionRunner.emit({ type: "agent_end", messages: event.messages });
		} else if (event.type === "turn_start") {
			const extensionEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this._turnIndex,
				timestamp: Date.now(),
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "turn_end") {
			const extensionEvent: TurnEndEvent = {
				type: "turn_end",
				turnIndex: this._turnIndex,
				message: event.message,
				toolResults: event.toolResults,
			};
			await this._extensionRunner.emit(extensionEvent);
			this._turnIndex++;
		} else if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: event.message,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_update") {
			const extensionEvent: MessageUpdateEvent = {
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_end") {
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message: event.message,
			};
			const replacement = await this._extensionRunner.emitMessageEnd(extensionEvent);
			if (replacement) {
				// Untyped extension handlers can return messages with null/missing content;
				// normalize so it never enters agent state or session history.
				const normalized =
					(replacement.role === "user" ||
						replacement.role === "assistant" ||
						replacement.role === "toolResult" ||
						replacement.role === "custom") &&
					replacement.content == null
						? ({ ...replacement, content: [] } as AgentMessage)
						: replacement;
				this._replaceMessageInPlace(event.message, normalized);
			}
		} else if (event.type === "tool_execution_start") {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
			};
			await this._extensionRunner.emit(extensionEvent);
		}
	}

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		this._eventListeners.push(listener);

		// Return unsubscribe function for this specific listener
		return () => {
			const index = this._eventListeners.indexOf(listener);
			if (index !== -1) {
				this._eventListeners.splice(index, 1);
			}
		};
	}

	/** Disconnect from agent events during disposal. */
	private _disconnectFromAgent(): void {
		if (this._unsubscribeAgent) {
			this._unsubscribeAgent();
			this._unsubscribeAgent = undefined;
		}
	}

	/**
	 * Remove all listeners and disconnect from agent.
	 * Call this when completely done with the session.
	 */
	dispose(): void {
		try {
			this.abortRetry();
			this.abortCompaction();
			this.abortBranchSummary();
			this.abortBash();
			this.agent.abort();
		} catch {
			// Dispose must succeed even if an abort hook throws.
		}

		this._extensionRunner.invalidate(
			"This extension ctx is stale after session replacement or reload. Do not use a captured smolt or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		this._disconnectFromAgent();
		this._eventListeners = [];
		cleanupSessionResources(this.sessionId);
	}

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	/** Full agent state */
	get state(): AgentState {
		return this.agent.state;
	}

	/** Current model (may be undefined if not yet selected) */
	get model(): Model<any> | undefined {
		return this.agent.state.model;
	}

	/** Current thinking level */
	get thinkingLevel(): ThinkingLevel {
		return this.agent.state.thinkingLevel;
	}

	/** Whether the session is currently processing an agent run or post-run continuation. */
	get isStreaming(): boolean {
		return this._isAgentRunActive;
	}

	/** Whether the session has no active agent run, retry, auto-compaction, or queued continuation. */
	get isIdle(): boolean {
		return !this._isAgentRunActive;
	}

	/** Current effective system prompt (includes any per-turn extension modifications) */
	get systemPrompt(): string {
		return this.agent.state.systemPrompt;
	}

	/** Current retry attempt (0 if not retrying) */
	get retryAttempt(): number {
		return this._retryAttempt;
	}

	/**
	 * Get the names of currently active tools.
	 * Returns the names of tools currently set on the agent.
	 */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map((t) => t.name);
	}

	/**
	 * Get all configured tools with name, description, parameter schema, prompt guidelines, and source metadata.
	 */
	getAllTools(): ToolInfo[] {
		return Array.from(this._toolDefinitions.values()).map(({ definition, sourceInfo }) => ({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			promptGuidelines: definition.promptGuidelines,
			sourceInfo,
		}));
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._toolDefinitions.get(name)?.definition;
	}

	/**
	 * Set active tools by name.
	 * Only tools in the registry can be enabled. Unknown tool names are ignored.
	 * Also rebuilds the system prompt to reflect the new tool set.
	 * Changes take effect on the next provider request, including one later in the same run.
	 */
	setActiveToolsByName(toolNames: string[]): void {
		const tools: AgentTool[] = [];
		const validToolNames: string[] = [];
		for (const name of toolNames) {
			const tool = this._toolRegistry.get(name);
			if (tool) {
				tools.push(tool);
				validToolNames.push(name);
			}
		}
		this.agent.state.tools = tools;

		// Rebuild base system prompt with new tool set
		this._baseSystemPrompt = this._rebuildSystemPrompt(validToolNames);
		this.agent.state.systemPrompt = this._systemPromptOverride ?? this._baseSystemPrompt;
	}

	/** Whether compaction or branch summarization is currently running */
	get isCompacting(): boolean {
		return (
			this._autoCompactionAbortController !== undefined ||
			this._compactionAbortController !== undefined ||
			this._branchSummaryAbortController !== undefined
		);
	}

	/** All messages including custom types like BashExecutionMessage */
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	/** Current steering mode */
	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.steeringMode;
	}

	/** Current follow-up mode */
	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.followUpMode;
	}

	/** Current session file path, or undefined if sessions are disabled */
	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	/** Current session ID */
	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	/** Current session display name, if set */
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	/** Scoped models for cycling (from --models flag) */
	get scopedModels(): ReadonlyArray<{ model: Model<any>; thinkingLevel?: ThinkingLevel }> {
		return this._scopedModels;
	}

	/** Update scoped models for cycling */
	setScopedModels(scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>): void {
		this._scopedModels = scopedModels;
	}

	/** File-based prompt templates */
	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this._resourceLoader.getPrompts().prompts;
	}

	private _normalizePromptSnippet(text: string | undefined): string | undefined {
		if (!text) return undefined;
		const oneLine = text
			.replace(/[\r\n]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return oneLine.length > 0 ? oneLine : undefined;
	}

	private _normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
		if (!guidelines || guidelines.length === 0) {
			return [];
		}

		const unique = new Set<string>();
		for (const guideline of guidelines) {
			const normalized = guideline.trim();
			if (normalized.length > 0) {
				unique.add(normalized);
			}
		}
		return Array.from(unique);
	}

	private _rebuildSystemPrompt(toolNames: string[]): string {
		const validToolNames = toolNames.filter((name) => this._toolRegistry.has(name));
		const toolSnippets: Record<string, string> = {};
		const promptGuidelines: string[] = [];
		for (const name of validToolNames) {
			const snippet = this._toolPromptSnippets.get(name);
			if (snippet) {
				toolSnippets[name] = snippet;
			}

			const toolGuidelines = this._toolPromptGuidelines.get(name);
			if (toolGuidelines) {
				promptGuidelines.push(...toolGuidelines);
			}
		}

		const loaderSystemPrompt = this._resourceLoader.getSystemPrompt();
		const loaderAppendSystemPrompt = this._resourceLoader.getAppendSystemPrompt();
		const appendSystemPrompt =
			loaderAppendSystemPrompt.length > 0 ? loaderAppendSystemPrompt.join("\n\n") : undefined;
		const loadedSkills = this._resourceLoader.getSkills().skills;
		const loadedContextFiles = this._resourceLoader.getAgentsFiles().agentsFiles;

		// The agent cannot interpret "/research how X works" without being told
		// that /research exists and what it is for. Named here rather than in
		// the tool's description because the decision to reach for the tool at
		// all depends on recognising the command first.
		const commands = this._agentCommands();
		const commandSection =
			commands.length === 0
				? undefined
				: [
						"## Slash commands",
						"The user may type one of these, or ask in words for what one does. Work out which was " +
							`meant and run it with the \`${COMMAND_TOOL_NAME}\` tool; say in one short sentence what ` +
							"you are doing as you go.",
						commands
							.map((entry) => `- \`/${entry.name}\`${entry.description === "" ? "" : ` - ${entry.description}`}`)
							.join("\n"),
					].join("\n\n");

		this._baseSystemPromptOptions = {
			cwd: this._cwd,
			skills: loadedSkills,
			contextFiles: loadedContextFiles,
			customPrompt: loaderSystemPrompt,
			appendSystemPrompt:
				[appendSystemPrompt, commandSection].filter((part) => part !== undefined).join("\n\n") || undefined,
			selectedTools: validToolNames,
			toolSnippets,
			promptGuidelines,
		};
		return buildSystemPrompt(this._baseSystemPromptOptions);
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	private async _runAgentPrompt(messages: AgentMessage | AgentMessage[]): Promise<void> {
		this._isAgentRunActive = true;
		try {
			await this.agent.prompt(messages);
			while (await this._handlePostAgentRun()) {
				await this.agent.continue();
			}
		} finally {
			this._systemPromptOverride = undefined;
			this._flushPendingBashMessages();
			this._flushPendingCustomMessages();
			await this._emitAgentSettled();
		}
	}

	private async _handlePostAgentRun(): Promise<boolean> {
		const msg = this._lastAssistantMessage;
		this._lastAssistantMessage = undefined;

		// An extension asked to abort this response (e.g. a degeneration guard).
		// Keyed on the request, not on stopReason: a provider that ignores the
		// abort signal may finish the stream normally and still needs handling.
		const abortRequest = this._abortResponseRequest;
		if (abortRequest) {
			this._abortResponseRequest = undefined;
			if (msg && abortRequest.retry) {
				this._emit({
					type: "auto_retry_start",
					attempt: abortRequest.attempt,
					maxAttempts: abortRequest.maxAttempts,
					delayMs: 0,
					errorMessage: abortRequest.reason,
				});
				// Drop the aborted response from agent state (it stays in session
				// history) so continue() re-issues the identical request.
				const messages = this.agent.state.messages;
				if (messages.length > 0 && messages[messages.length - 1]?.role === "assistant") {
					this.agent.state.messages = messages.slice(0, -1);
				}
				return true;
			}
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt: abortRequest.attempt,
				finalError: abortRequest.reason,
			});
			return false;
		}

		if (!msg) {
			return false;
		}

		if (this._isRetryableError(msg) && (await this._prepareRetry(msg))) {
			return true;
		}

		if (msg.stopReason === "error" && this._retryAttempt > 0) {
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt: this._retryAttempt,
				finalError: msg.errorMessage,
			});
			this._retryAttempt = 0;
		}

		if (this._compactBeforeNextStep) {
			this._compactBeforeNextStep = false;
			// The step that crossed the line stays in the session file, so the
			// summary knows of it; it leaves the live context so the turn can be
			// continued from the summary. Tool results it may have gathered go
			// with it: a tool call without its call is not a state to continue from.
			const messages = this.agent.state.messages;
			let lastAssistant = messages.length - 1;
			while (lastAssistant >= 0 && messages[lastAssistant]?.role !== "assistant") lastAssistant--;
			if (lastAssistant >= 0) this.agent.state.messages = messages.slice(0, lastAssistant);
			return await this._runAutoCompaction("threshold", true);
		}

		if (await this._checkCompaction(msg)) {
			return true;
		}

		// The agent loop drains both queues before emitting agent_end. Any messages
		// here were queued by agent_end extension handlers and need a continuation.
		return this.agent.hasQueuedMessages();
	}

	/** The compaction settings, sized to the current model's window. */
	private _compactionSettings(): CompactionSettings {
		return compactionSettingsFor(this.settingsManager.getCompactionSettings(), this.model?.contextWindow ?? 0);
	}

	/**
	 * Send a prompt to the agent.
	 * - Handles extension commands (registered via smolt.registerCommand) immediately, even during streaming
	 * - Expands file-based prompt templates by default
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 */
	async prompt(text: string, options?: PromptOptions): Promise<void> {
		this._modelInputs++;
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;
		const preflightResult = options?.preflightResult;
		let messages: AgentMessage[] | undefined;

		try {
			// Handle extension commands first (execute immediately, even during streaming)
			// Extension commands manage their own LLM interaction via smolt.sendMessage()
			if (expandPromptTemplates && text.startsWith("/")) {
				// The preflight fires the moment the handler is done rather than
				// after: the caller waits to hear the command was taken, not for
				// the agent to finish saying what it did.
				const handled = await this._tryExecuteExtensionCommand(text, () => preflightResult?.(true));
				if (handled) return;
			}

			if (this._compactionAbortController !== undefined) {
				throw new Error(
					"Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.",
				);
			}

			// Emit input event for extension interception (before skill/template expansion)
			let currentText = text;
			let currentImages = options?.images;
			if (this._extensionRunner.hasHandlers("input")) {
				const inputResult = await this._extensionRunner.emitInput(
					currentText,
					currentImages,
					options?.source ?? "interactive",
					this.isStreaming ? options?.streamingBehavior : undefined,
				);
				if (inputResult.action === "handled") {
					preflightResult?.(true);
					return;
				}
				if (inputResult.action === "transform") {
					currentText = inputResult.text;
					currentImages = inputResult.images ?? currentImages;
				}
			}

			// Expand skill commands (/skill:name args) and prompt templates (/template args)
			let expandedText = currentText;
			if (expandPromptTemplates) {
				expandedText = this._expandSkillCommand(expandedText);
				expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
			}

			// If streaming, queue via steer() or followUp() based on option
			if (this.isStreaming) {
				if (!options?.streamingBehavior) {
					throw new Error(
						"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
					);
				}
				if (options.streamingBehavior === "followUp") {
					await this._queueFollowUp(expandedText, currentImages, options.source);
				} else {
					await this._queueSteer(expandedText, currentImages, options.source);
				}
				preflightResult?.(true);
				return;
			}

			// Flush any pending bash and custom messages before the new prompt
			this._flushPendingBashMessages();
			this._flushPendingCustomMessages();

			// Validate model
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const hasConfiguredAuth =
				this._modelRuntime.hasConfiguredAuth(this.model.provider) ||
				(await this._modelRuntime.checkAuth(this.model.provider)) !== undefined;
			if (!hasConfiguredAuth) {
				const isOAuth = this._modelRuntime.isUsingOAuth(this.model.provider);
				if (isOAuth) {
					throw new Error(
						`Authentication failed for "${this.model.provider}". ` +
							`Credentials may have expired or network is unavailable. ` +
							`Run '/login ${this.model.provider}' to re-authenticate.`,
					);
				}
				throw new Error(formatNoApiKeyFoundMessage(this.model.provider));
			}

			// Check if we need to compact before sending (catches aborted responses).
			// The user's new prompt is sent below, so do not call agent.continue() here.
			const lastAssistant = this._findLastAssistantMessage();
			if (lastAssistant) {
				await this._checkCompaction(lastAssistant, false);
			}

			// Build messages array (custom message if any, then user message)
			messages = [];

			// Add user message
			const userContent = userContentOf(expandedText, currentImages);
			messages.push({
				role: "user",
				content: userContent,
				timestamp: Date.now(),
				// A prompt an extension sent is a brief, not the reader talking:
				// marked here so every surface can render it collapsed rather
				// than putting a command's instructions in the reader's voice.
				...(options?.source === "extension" ? { internal: true } : {}),
			});

			if (options?.source === "extension") {
				messages.push(this._briefNarrationMessage());
			}

			// Inject any pending "nextTurn" messages as context alongside the user message
			for (const msg of this._pendingNextTurnMessages) {
				messages.push(msg);
			}
			this._pendingNextTurnMessages = [];

			// Emit before_agent_start extension event
			const result = await this._extensionRunner.emitBeforeAgentStart(
				expandedText,
				currentImages,
				this._baseSystemPrompt,
				this._baseSystemPromptOptions,
			);
			// Add all custom messages from extensions
			if (result?.messages) {
				for (const msg of result.messages) {
					messages.push({
						role: "custom",
						customType: msg.customType,
						// Untyped extensions can pass null/missing content; normalize at ingestion.
						content: msg.content ?? [],
						display: msg.display,
						details: msg.details,
						timestamp: Date.now(),
					});
				}
			}
			// Apply extension-modified system prompt, or reset to base
			if (result?.systemPrompt !== undefined) {
				this._systemPromptOverride = result.systemPrompt;
				this.agent.state.systemPrompt = result.systemPrompt;
			} else {
				// Ensure we're using the base prompt (in case previous turn had modifications)
				this._systemPromptOverride = undefined;
				this.agent.state.systemPrompt = this._baseSystemPrompt;
			}
		} catch (error) {
			preflightResult?.(false);
			throw error;
		}

		if (!messages) {
			return;
		}

		preflightResult?.(true);
		await this._runAgentPrompt(messages);
	}

	/**
	 * Try to execute an extension command. Returns true if command was found and executed.
	 */
	private async _tryExecuteExtensionCommand(text: string, onHandled?: () => void): Promise<boolean> {
		// Parse command name and args
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		const command = this._extensionRunner.getCommand(commandName);
		if (!command) return false;

		// Get command context from extension runner (includes session control methods)
		const ctx = this._extensionRunner.createCommandContext();
		// What the command told the reader while it ran. A command that answers
		// entirely inside the app never puts anything in front of the model, so
		// its own words are all the agent has to go on afterwards.
		const reported: string[] = [];
		// Held rather than shown. A command the reader just typed is answered by
		// the agent, so its own announcement must not float past as a toast
		// saying the same thing in the harness's voice; it is released only if
		// the agent turns out not to be speaking for it.
		const held: { message: string; type?: "info" | "warning" | "error" }[] = [];
		const restoreUi = this._captureCommandNotices(ctx, reported, held);
		const inputsBefore = this._modelInputs;
		let failure: string | undefined;

		try {
			await command.handler(args, ctx);
		} catch (err) {
			failure = err instanceof Error ? err.message : String(err);
			// Emit error via extension runner
			this._extensionRunner.emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: failure,
			});
		} finally {
			restoreUi();
		}
		onHandled?.();

		// A command that handed work to the model is already narrating it through
		// the brief; a second line would talk over the first. Whatever it said on
		// the way is its own, so that goes to the reader as it always did.
		if (this._modelInputs !== inputsBefore) {
			this._replayCommandNotices(ctx, held);
			return true;
		}
		const narrated = await this._narrateCommandOutcome(commandName, args, reported, failure, command.description);
		// Nobody spoke for it after all - no model, no key, no network. Better
		// the harness's own words than a command that answers with silence.
		if (!narrated) this._replayCommandNotices(ctx, held);
		return true;
	}

	/** Hand a command's held announcements to the reader after all. */
	private _replayCommandNotices(
		ctx: ExtensionCommandContext,
		held: { message: string; type?: "info" | "warning" | "error" }[],
	): void {
		for (const notice of held) {
			try {
				ctx.ui.notify(notice.message, notice.type);
			} catch {
				// A stale session's ui throws on access; there is nobody left to tell.
			}
		}
	}

	/**
	 * Hold an extension command's notifications while its handler runs, and
	 * hand back the undo.
	 *
	 * They go into `sink` for the agent to read and into `held` in case they
	 * have to be shown after all - and nowhere else, because the reader hears
	 * about a command they typed from the agent, not from a toast.
	 *
	 * The context's `ui` is a guarded getter - it re-checks on every read that
	 * this session is still the live one - so the stand-in is a getter too,
	 * wrapping whatever the original hands back rather than a copy taken once
	 * and frozen.
	 */
	private _captureCommandNotices(
		ctx: ExtensionCommandContext,
		sink: string[],
		held: { message: string; type?: "info" | "warning" | "error" }[],
	): () => void {
		const original = Object.getOwnPropertyDescriptor(ctx, "ui");
		if (!original) return () => {};
		Object.defineProperty(ctx, "ui", {
			configurable: true,
			enumerable: original.enumerable ?? true,
			get: () => {
				const ui = original.get
					? (original.get.call(ctx) as ExtensionUIContext)
					: (original.value as ExtensionUIContext);
				return new Proxy(ui, {
					get(target, property, receiver) {
						if (property !== "notify") return Reflect.get(target, property, receiver);
						return (message: string, type?: "info" | "warning" | "error") => {
							if (typeof message === "string" && message.trim() !== "") {
								sink.push(message.trim());
								held.push({ message, type });
							}
						};
					},
				});
			},
		});
		return () => Object.defineProperty(ctx, "ui", original);
	}

	/**
	 * Say what a command did, in one sentence, in the agent's own voice.
	 *
	 * A command that resolves inside the app - a toggle, a status read - never
	 * reaches the model, so the chat was left holding the reader's own words
	 * and nothing back: a command that had plainly been taken and then said
	 * nothing about itself.
	 *
	 * It is a side call rather than a turn. The full model is not needed to say
	 * "the advisor is on now", and a turn is a lot of machinery for one line:
	 * the whole context, the tools, the thinking budget, and a second or two of
	 * silence before any of it reaches the screen. This asks the same model
	 * at its lowest thinking level, with a tight ceiling and only the few facts
	 * it needs, so
	 * the answer is there almost at once and costs almost nothing.
	 *
	 * The facts go into the session as a hidden note as well as into the
	 * prompt. Without it the next real turn would find a line the agent
	 * apparently said for no reason, with no request of any kind before it.
	 *
	 * True when something was said, so the caller knows whether anything spoke
	 * for the command at all.
	 */
	private async _narrateCommandOutcome(
		commandName: string,
		args: string,
		reported: string[],
		failure?: string,
		description?: string,
	): Promise<boolean> {
		const outcome =
			failure !== undefined
				? `It failed: ${failure}`
				: reported.length > 0
					? `What it reported:\n${reported.join("\n")}`
					: "It reported nothing back.";
		return this._sayOneLine({
			systemPrompt: COMMAND_LINE_SYSTEM_PROMPT,
			facts: `${this._commandFacts(commandName, args, description)}\n${outcome}`,
			noteType: "command-outcome",
			commandName,
			complaint: "Could not say what the command did",
		});
	}

	/** The command, its arguments and what it is for, as the model needs them. */
	private _commandFacts(commandName: string, args: string, description?: string): string {
		const trimmed = args.trim();
		const invocation = `/${commandName}${trimmed === "" ? "" : ` ${trimmed}`}`;
		// What the command is for, in the extension's own words. Without it the
		// agent has only a name to go on, and a name is not enough to say what is
		// happening in a sentence a reader would recognise.
		const what = description?.trim() ? `\nWhat it does: ${description.trim()}` : "";
		return `The user ran ${invocation}.${what}`;
	}

	/**
	 * One sentence from a cheap side call, put into the chat as the agent's own.
	 *
	 * A side call rather than a turn: the full model is not needed to say "the
	 * advisor is on now", and a turn is a lot of machinery for one line - the
	 * whole context, the tools, the thinking budget, and a second or two of
	 * silence before any of it reaches the screen. This asks the same model at
	 * its lowest thinking level, with a tight ceiling and only the few facts it
	 * needs.
	 *
	 * The facts go into the session as a hidden note as well as into the prompt.
	 * Without it the next real turn would find a line the agent apparently said
	 * for no reason, with no request of any kind before it.
	 *
	 * True when something was said.
	 */
	private async _sayOneLine(options: {
		systemPrompt: string;
		facts: string;
		noteType: string;
		commandName: string;
		complaint: string;
	}): Promise<boolean> {
		if (!this.model) return false;
		try {
			const { model: requestModel, apiKey, headers, env } = await this._getSummarizationRequestAuth(this.model);
			const answer = await completeSummarization(
				requestModel,
				{
					systemPrompt: options.systemPrompt,
					messages: [{ role: "user", content: [{ type: "text", text: options.facts }], timestamp: Date.now() }],
				},
				{ apiKey, headers, env, reasoning: "minimal", maxTokens: COMMAND_LINE_MAX_TOKENS },
				this.agent.streamFunction,
			);
			if (answer.stopReason === "error" || answer.stopReason === "aborted") return false;
			const said = answer.content
				.filter((block): block is TextContent => block.type === "text")
				.map((block) => block.text)
				.join("")
				.trim();
			if (said === "") return false;
			// The note first, so the line has something before it that explains it.
			await this.sendCustomMessage({ customType: options.noteType, content: options.facts, display: false });
			this.agent.state.messages.push(answer);
			this.sessionManager.appendMessage(answer);
			this._emit({ type: "message_start", message: answer });
			this._emit({ type: "message_end", message: answer });
			return true;
		} catch (err) {
			// A command that worked must not read as broken because the line about
			// it could not be fetched (no model, no key, no network).
			this._extensionRunner.emitError({
				extensionPath: `command:${options.commandName}`,
				event: "command",
				error: `${options.complaint}: ${err instanceof Error ? err.message : String(err)}`,
			});
			return false;
		}
	}

	/**
	 * Expand skill commands (/skill:name args) to their full content.
	 * Returns the expanded text, or the original text if not a skill command or skill not found.
	 * Emits errors via extension runner if file read fails.
	 */
	private _expandSkillCommand(text: string): string {
		if (!text.startsWith("/skill:")) return text;

		const spaceIndex = text.indexOf(" ");
		const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

		const skill = this.resourceLoader.getSkills().skills.find((s) => s.name === skillName);
		if (!skill) return text; // Unknown skill, pass through

		try {
			const content = readFileSync(skill.filePath, "utf-8");
			const body = stripFrontmatter(content).trim();
			const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
			return args ? `${skillBlock}\n\n${args}` : skillBlock;
		} catch (err) {
			// Emit error like extension commands do
			this._extensionRunner.emitError({
				extensionPath: skill.filePath,
				event: "skill_expansion",
				error: err instanceof Error ? err.message : String(err),
			});
			return text; // Return original on error
		}
	}

	/**
	 * Queue a steering message while the agent is running.
	 * Delivered after the current assistant turn finishes executing its tool calls,
	 * before the next LLM call.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async steer(text: string, images?: ImageContent[]): Promise<void> {
		// Check for extension commands (cannot be queued)
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		// Expand skill commands and prompt templates
		let expandedText = this._expandSkillCommand(text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		await this._queueSteer(expandedText, images);
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async followUp(text: string, images?: ImageContent[]): Promise<void> {
		// Check for extension commands (cannot be queued)
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		// Expand skill commands and prompt templates
		let expandedText = this._expandSkillCommand(text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		await this._queueFollowUp(expandedText, images);
	}

	/**
	 * The context-only nudge that rides with every extension brief: surfaces
	 * hide the brief itself, so the agent opens by saying, in its own words,
	 * what it is about to do — narration instead of a pasted prompt.
	 */
	private _briefNarrationMessage(): CustomMessage {
		return {
			role: "custom",
			customType: "brief-narration",
			content:
				"The brief above came from harness machinery and is hidden from the user's view. " +
				"Open your reply with one short sentence telling the user, in your own words, what " +
				"you are about to do — then carry out the brief. Do not mention the brief or repeat " +
				"its instructions.",
			display: false,
			timestamp: Date.now(),
		};
	}

	/**
	 * Internal: Queue a steering message (already expanded, no extension command check).
	 */
	private async _queueSteer(text: string, images?: ImageContent[], source?: InputSource): Promise<void> {
		this._modelInputs++;
		this._steeringMessages.push(text);
		this._emitQueueUpdate();
		const content = userContentOf(text, images);
		this.agent.steer({
			role: "user",
			content,
			timestamp: Date.now(),
			// An extension's brief, not the reader talking — surfaces hide it.
			...(source === "extension" ? { internal: true } : {}),
		});
		if (source === "extension") {
			this._extensionQueued.add(text);
			this.agent.steer(this._briefNarrationMessage());
		}
	}

	/**
	 * Internal: Queue a follow-up message (already expanded, no extension command check).
	 */
	private async _queueFollowUp(text: string, images?: ImageContent[], source?: InputSource): Promise<void> {
		this._modelInputs++;
		this._followUpMessages.push(text);
		this._emitQueueUpdate();
		const content = userContentOf(text, images);
		this.agent.followUp({
			role: "user",
			content,
			timestamp: Date.now(),
			// An extension's brief, not the reader talking — surfaces hide it.
			...(source === "extension" ? { internal: true } : {}),
		});
		if (source === "extension") {
			this._extensionQueued.add(text);
			this.agent.followUp(this._briefNarrationMessage());
		}
	}

	/**
	 * Throw an error if the text is an extension command.
	 */
	private _throwIfExtensionCommand(text: string): void {
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const command = this._extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	/**
	 * Send a custom message to the session. Creates a CustomMessageEntry.
	 *
	 * Handles four cases:
	 * - Streaming: queues message, processed when loop pulls from queue
	 * - Streaming + triggerTurn false: appended to state/session once the current turn ends
	 * - Not streaming + triggerTurn: appends to state/session, starts new turn
	 * - Not streaming + no trigger: appends to state/session, no turn
	 *
	 * @param message Custom message with customType, content, display, details
	 * @param options.triggerTurn If true and not streaming, triggers a new LLM turn
	 * @param options.deliverAs Delivery mode: "steer", "followUp", or "nextTurn"
	 */
	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> {
		const appMessage = {
			role: "custom" as const,
			customType: message.customType,
			// Untyped extensions can pass null/missing content; normalize at ingestion.
			content: message.content ?? [],
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		} satisfies CustomMessage<T>;
		this._modelInputs++;
		if (options?.deliverAs === "nextTurn") {
			this._pendingNextTurnMessages.push(appMessage);
		} else if (this.isStreaming && options?.triggerTurn !== false) {
			if (options?.deliverAs === "followUp") {
				this.agent.followUp(appMessage);
			} else {
				this.agent.steer(appMessage);
			}
		} else if (options?.triggerTurn) {
			await this._runAgentPrompt(appMessage);
		} else if (this.isStreaming) {
			// Appending now would put the message between an assistant tool call and its
			// result, which providers that validate message order reject on replay. Defer
			// to the end of the turn. Nothing is emitted yet: message events must not
			// describe messages the session tree does not contain.
			this._pendingCustomMessages.push(appMessage);
		} else {
			this._appendCustomMessage(appMessage);
		}
	}

	private _appendCustomMessage(appMessage: CustomMessage): void {
		this.agent.state.messages.push(appMessage);
		this.sessionManager.appendCustomMessageEntry(
			appMessage.customType,
			appMessage.content,
			appMessage.display,
			appMessage.details,
		);
		this._emit({ type: "message_start", message: appMessage });
		this._emit({ type: "message_end", message: appMessage });
	}

	/**
	 * Append custom messages queued while the agent was running.
	 * Called once the current turn's tool results are in agent state and session history.
	 */
	private _flushPendingCustomMessages(): void {
		if (this._pendingCustomMessages.length === 0) return;

		const pending = this._pendingCustomMessages;
		this._pendingCustomMessages = [];
		for (const appMessage of pending) {
			this._appendCustomMessage(appMessage);
		}
	}

	/**
	 * Send a user message to the agent. Always triggers a turn.
	 * When the agent is streaming, use deliverAs to specify how to queue the message.
	 *
	 * @param content User message content (string or content array)
	 * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
	 * @param options.expandPromptTemplates Whether to dispatch extension commands and expand skill commands and prompt templates. Default: false.
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
	): Promise<void> {
		// Normalize content to text string + optional images
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		await this.prompt(text, {
			expandPromptTemplates: options?.expandPromptTemplates ?? false,
			streamingBehavior: options?.deliverAs,
			images,
			source: "extension",
		});
	}

	/**
	 * Clear all queued messages and return them.
	 * Useful for restoring to editor when user aborts.
	 * @returns Object with steering and followUp arrays
	 */
	clearQueue(): { steering: string[]; followUp: string[] } {
		const mine = (text: string): boolean => !this._extensionQueued.has(text);
		const steering = this._steeringMessages.filter(mine);
		const followUp = this._followUpMessages.filter(mine);
		this._steeringMessages = [];
		this._followUpMessages = [];
		this._extensionQueued.clear();
		this.agent.clearAllQueues();
		this._emitQueueUpdate();
		return { steering, followUp };
	}

	/** Number of pending messages (includes both steering and follow-up) */
	get pendingMessageCount(): number {
		return this._steeringMessages.length + this._followUpMessages.length;
	}

	/** Get pending steering messages (read-only) */
	getSteeringMessages(): readonly string[] {
		return this._steeringMessages;
	}

	/** Get pending follow-up messages (read-only) */
	getFollowUpMessages(): readonly string[] {
		return this._followUpMessages;
	}

	get resourceLoader(): ResourceLoader {
		return this._resourceLoader;
	}

	/**
	 * Abort current operation and wait for agent to become idle.
	 */
	async abort(): Promise<void> {
		this.abortRetry();
		// Extensions first, and not awaited. Stopping means everything in this
		// chat: a research team, a battletest, an advisor reading along all run
		// their own agents, and nothing here can reach those but the extension
		// that started them. Left out, the reader presses stop, one request dies
		// and the rest carry on - so they press it again, and again.
		//
		// Not awaited because an extension winding down its own agents can take
		// as long as it likes, and the stop the reader asked for is this one:
		// the turn in front of them has to end now, not after the slowest
		// handler has finished tidying up.
		if (this._extensionRunner.hasHandlers("agent_abort")) {
			void this._extensionRunner.emit({ type: "agent_abort" }).catch(() => {
				// A handler that throws on the way down is not worth reporting:
				// the abort itself must not fail because a listener did.
			});
		}
		// Whatever was queued behind this turn goes with it. A research run
		// queues its kickoff brief as a follow-up, and the brief's narration
		// nudge behind that: left in place, each started a fresh turn the
		// moment the stopped one died, and stopping a run took three presses.
		// A surface that wants the reader's own queued words back in its editor
		// takes them from clearQueue() before calling this.
		this.clearQueue();
		this.agent.abort();
		await this.waitForIdle();
	}

	async waitForIdle(): Promise<void> {
		if (this.isIdle) {
			return;
		}
		await this._getIdleWaitPromise();
	}

	// =========================================================================
	// Model Management
	// =========================================================================

	private async _emitModelSelect(
		nextModel: Model<any>,
		previousModel: Model<any> | undefined,
		source: "set" | "cycle" | "restore",
	): Promise<void> {
		if (modelsAreEqual(previousModel, nextModel)) return;
		await this._extensionRunner.emit({
			type: "model_select",
			model: nextModel,
			previousModel,
			source,
		});
	}

	/**
	 * Set model directly.
	 * Validates that auth is configured and saves to the session transcript.
	 * Persists to global defaults only when options.persist is true.
	 * @throws Error if no auth is configured for the model
	 */
	async setModel(model: Model<any>, options: ModelMutationOptions = {}): Promise<void> {
		if (!(await this._modelRuntime.checkAuth(model.provider))) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		const previousModel = this.model;
		const thinkingLevel = this._getThinkingLevelForModelSwitch(model);
		this.agent.state.model = model;
		this.sessionManager.appendModelChange(model.provider, model.id);
		if (options.persist) {
			this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
			this._addPersistedDefaultToNonEmptyScope(model);
		}

		// Apply thinking level for the new model.
		// Per-model thinking level overrides take priority over the global default.
		// Model persistence does not implicitly rewrite the global thinking default.
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(model, previousModel, "set");
	}

	private _addPersistedDefaultToNonEmptyScope(model: Model<any>): void {
		if (this._scopedModels.length === 0) return;
		if (this._scopedModels.some((scoped) => modelsAreEqual(scoped.model, model))) return;

		this._scopedModels = [...this._scopedModels, { model }];

		const enabledModels = this.settingsManager.getEnabledModels();
		if (!enabledModels?.length) return;

		const modelReference = `${model.provider}/${model.id}`;
		if (enabledModels.some((pattern) => pattern.toLowerCase() === modelReference.toLowerCase())) return;
		this.settingsManager.setEnabledModels([...enabledModels, modelReference]);
	}

	/**
	 * Cycle to next/previous model.
	 * Uses scoped models (from --models flag) if available, otherwise all available models.
	 * @param direction - "forward" (default) or "backward"
	 * @returns The new model info, or undefined if only one model available
	 */
	async cycleModel(
		direction: "forward" | "backward" = "forward",
		options: ModelMutationOptions = {},
	): Promise<ModelCycleResult | undefined> {
		if (this._scopedModels.length > 0) {
			return this._cycleScopedModel(direction, options);
		}
		return this._cycleAvailableModel(direction, options);
	}

	private async _cycleScopedModel(
		direction: "forward" | "backward",
		options: ModelMutationOptions,
	): Promise<ModelCycleResult | undefined> {
		const availableIds = new Set(
			this._modelRuntime.getAvailableSnapshot().map((model) => `${model.provider}\0${model.id}`),
		);
		const scopedModels = this._scopedModels.filter((scoped) =>
			availableIds.has(`${scoped.model.provider}\0${scoped.model.id}`),
		);
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];
		const thinkingLevel = this._getThinkingLevelForModelSwitch(next.model, next.thinkingLevel);

		// Apply model
		this.agent.state.model = next.model;
		this.sessionManager.appendModelChange(next.model.provider, next.model.id);
		if (options.persist) {
			this.settingsManager.setDefaultModelAndProvider(next.model.provider, next.model.id);
			this._addPersistedDefaultToNonEmptyScope(next.model);
		}

		// Apply thinking level for the new model.
		// - Explicit scoped model thinking level overrides defaults
		// - Per-model thinking level overrides take priority over the global default
		// setThinkingLevel clamps to model capabilities.
		// Model persistence does not implicitly rewrite the global thinking default.
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(next.model, currentModel, "cycle");

		return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
	}

	private async _cycleAvailableModel(
		direction: "forward" | "backward",
		options: ModelMutationOptions,
	): Promise<ModelCycleResult | undefined> {
		const availableModels = this._modelRuntime.getAvailableSnapshot();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = availableModels.findIndex((m) => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];

		const thinkingLevel = this._getThinkingLevelForModelSwitch(nextModel);
		this.agent.state.model = nextModel;
		this.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
		if (options.persist) {
			this.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);
			this._addPersistedDefaultToNonEmptyScope(nextModel);
		}

		// Apply thinking level for the new model.
		// Model persistence does not implicitly rewrite the global thinking default.
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(nextModel, currentModel, "cycle");

		return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false };
	}

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

	/**
	 * Set thinking level.
	 * Clamps to model capabilities based on available thinking levels.
	 * Saves the clamped level to the session transcript only if the level actually changes.
	 * Persists the requested level to global defaults only when options.persist is true.
	 */
	setThinkingLevel(level: ThinkingLevel, options: ModelMutationOptions = {}): void {
		const availableLevels = this.getAvailableThinkingLevels();
		const effectiveLevel = availableLevels.includes(level) ? level : this._clampThinkingLevel(level, availableLevels);

		// Only persist if actually changing
		const previousLevel = this.agent.state.thinkingLevel;
		const isChanging = effectiveLevel !== previousLevel;

		this.agent.state.thinkingLevel = effectiveLevel;

		if (options.persist) {
			this.settingsManager.setDefaultThinkingLevel(level);
		}

		if (isChanging) {
			this.sessionManager.appendThinkingLevelChange(effectiveLevel);
			this._emit({ type: "thinking_level_changed", level: effectiveLevel });
			void this._extensionRunner.emit({
				type: "thinking_level_select",
				level: effectiveLevel,
				previousLevel,
			});
		}
	}

	/**
	 * Cycle to next thinking level.
	 * @returns New level, or undefined if model doesn't support thinking
	 */
	cycleThinkingLevel(options: ModelMutationOptions = {}): ThinkingLevel | undefined {
		if (!this.supportsThinking()) return undefined;

		const levels = this.getAvailableThinkingLevels();
		const currentIndex = levels.indexOf(this.thinkingLevel);
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];

		this.setThinkingLevel(nextLevel, options);
		return nextLevel;
	}

	/**
	 * Get available thinking levels for current model.
	 * The provider will clamp to what the specific model supports internally.
	 */
	getAvailableThinkingLevels(): ThinkingLevel[] {
		if (!this.model) return [...THINKING_LEVEL_OPTIONS];
		return getSupportedThinkingLevels(this.model) as ThinkingLevel[];
	}

	/**
	 * Check if current model supports thinking/reasoning.
	 */
	supportsThinking(): boolean {
		return !!this.model?.reasoning;
	}

	private _getThinkingLevelForModelSwitch(targetModel?: Model<any>, explicitLevel?: ThinkingLevel): ThinkingLevel {
		if (explicitLevel !== undefined) {
			return explicitLevel;
		}
		// Per-model default takes priority when switching to a model that has one
		if (targetModel) {
			const perModel = this.settingsManager.getModelThinkingLevel(targetModel.provider, targetModel.id);
			if (perModel !== undefined) {
				return perModel;
			}
		}
		return this.settingsManager.getDefaultThinkingLevel() ?? this.thinkingLevel ?? DEFAULT_THINKING_LEVEL;
	}

	private _clampThinkingLevel(level: ThinkingLevel, _availableLevels: ThinkingLevel[]): ThinkingLevel {
		return this.model ? (clampThinkingLevel(this.model, level) as ThinkingLevel) : "off";
	}

	// =========================================================================
	// Queue Mode Management
	// =========================================================================

	private syncQueueModesFromSettings(): void {
		this.agent.steeringMode = this.settingsManager.getSteeringMode();
		this.agent.followUpMode = this.settingsManager.getFollowUpMode();
	}

	/**
	 * Set steering message mode.
	 * Saves to settings.
	 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.steeringMode = mode;
		this.settingsManager.setSteeringMode(mode);
	}

	/**
	 * Set follow-up message mode.
	 * Saves to settings.
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.followUpMode = mode;
		this.settingsManager.setFollowUpMode(mode);
	}

	// =========================================================================
	// Compaction
	// =========================================================================

	/** Generate Smolt's built-in compaction summary for manual and automatic compaction. */
	private async _runDefaultCompaction(
		preparation: CompactionPreparation,
		requestModel: Model<any>,
		apiKey: string | undefined,
		headers: Record<string, string> | undefined,
		customInstructions: string | undefined,
		signal: AbortSignal,
		env: Record<string, string> | undefined,
		reason: "manual" | "threshold" | "overflow",
	): Promise<CompactionResult> {
		return compact(
			preparation,
			requestModel,
			apiKey,
			headers,
			customInstructions,
			signal,
			this.thinkingLevel,
			this.agent.streamFunction,
			env,
			this.settingsManager.getRetrySettings(),
			this._summarizationRetryCallbacks({ source: "compaction", reason }),
			undefined, // sessionId
		);
	}

	/**
	 * Manually compact the session context.
	 *
	 * This is the manual entry point used by `/compact`, RPC, and extensions. It is
	 * separate from automatic threshold/overflow compaction, which enters through
	 * `_checkCompaction()` and `_runAutoCompaction()`. After preparation and the
	 * `session_before_compact` hook, both paths call the lower-level `compact()`
	 * function imported from `./compaction/index.ts`, unless the hook cancels or
	 * supplies a custom result.
	 *
	 * Aborts the current agent operation first. Manual compaction never retries or
	 * continues the interrupted agent turn.
	 *
	 * @param customInstructions Optional instructions for the compaction summary
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		await this.abort();
		this._compactionAbortController = new AbortController();
		this._emit({ type: "compaction_start", reason: "manual" });
		let fromExtension = false;

		try {
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const { model: requestModel, apiKey, headers, env } = await this._getSummarizationRequestAuth(this.model);

			const pathEntries = this.sessionManager.getBranch();
			const settings = this._compactionSettings();

			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				// Check why we can't compact
				const lastEntry = pathEntries[pathEntries.length - 1];
				if (lastEntry?.type === "compaction") {
					throw new Error("Already compacted");
				}
				throw new Error("Nothing to compact (session too small)");
			}

			let extensionCompaction: CompactionResult | undefined;

			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions,
					reason: "manual",
					willRetry: false,
					signal: this._compactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (result?.cancel) {
					throw new Error("Compaction cancelled");
				}

				if (result?.compaction) {
					extensionCompaction = result.compaction;
					fromExtension = true;
				}
			}

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let usage: Usage | undefined;
			let details: unknown;

			if (extensionCompaction) {
				// Extension provided compaction content
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				usage = extensionCompaction.usage;
				details = extensionCompaction.details;
			} else {
				// Shared default summary generator, also used by automatic compaction.
				const result = await this._runDefaultCompaction(
					preparation,
					requestModel,
					apiKey,
					headers,
					customInstructions,
					this._compactionAbortController.signal,
					env,
					"manual",
				);
				summary = result.summary;
				firstKeptEntryId = result.firstKeptEntryId;
				tokensBefore = result.tokensBefore;
				usage = result.usage;
				details = result.details;
			}

			if (this._compactionAbortController.signal.aborted) {
				throw new Error("Compaction cancelled");
			}

			this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension, usage);
			const newEntries = this.sessionManager.getEntries();
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;
			const estimatedTokensAfter = estimateMessagesTokens(sessionContext.messages);

			// Get the saved compaction entry for the extension event
			const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this._extensionRunner && savedCompactionEntry) {
				await this._extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
					reason: "manual",
					willRetry: false,
				});
			}

			const compactionResult: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				estimatedTokensAfter,
				usage,
				details,
			};
			// compaction_end listeners may submit queued prompts, so expose idle state before notifying them.
			this._compactionAbortController = undefined;
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: compactionResult,
				aborted: false,
				willRetry: false,
			});
			return compactionResult;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const aborted = message === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError");
			const errorMessage = aborted ? undefined : `Compaction failed: ${message}`;
			this._compactionAbortController = undefined;
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted,
				willRetry: false,
				errorMessage,
			});
			await this._emitSessionCompactFailed({
				reason: "manual",
				errorMessage,
				aborted,
				willRetry: false,
				fromExtension,
			});
			throw error;
		} finally {
			this._compactionAbortController = undefined;
		}
	}

	/**
	 * Cancel in-progress compaction (manual or auto).
	 */
	abortCompaction(): void {
		this._compactionAbortController?.abort();
		this._autoCompactionAbortController?.abort();
	}

	/**
	 * Cancel in-progress branch summarization.
	 */
	abortBranchSummary(): void {
		this._branchSummaryAbortController?.abort();
	}

	/**
	 * Dispatch automatic compaction after `agent_end` or before prompt submission.
	 * Manual compaction does not call this method; it enters through `compact()`.
	 *
	 * Automatic cases:
	 * 1. Overflow with retry: a context-overflow error or recoverable length stop;
	 *    remove the failed assistant message, compact, and retry the turn once.
	 * 2. Overflow without retry: a successful response exceeded the configured
	 *    context window; compact but preserve the completed response.
	 * 3. Threshold without retry: valid or estimated context usage crossed the
	 *    configured threshold; compact without retrying the completed response.
	 *
	 * Each case calls `_runAutoCompaction()`. After preparation and the
	 * `session_before_compact` hook, that method calls the lower-level `compact()`
	 * function imported from `./compaction/index.ts`, unless the hook cancels or
	 * supplies a custom result.
	 *
	 * @param assistantMessage The assistant message to check
	 * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
	 * @returns Whether the post-run loop should call `agent.continue()` for overflow recovery or queued messages
	 */
	private async _checkCompaction(assistantMessage: AssistantMessage, skipAbortedCheck = true): Promise<boolean> {
		const settings = this._compactionSettings();
		if (!settings.enabled) return false;

		// Skip if message was aborted (user cancelled) - unless skipAbortedCheck is false
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return false;

		const contextWindow = this.model?.contextWindow ?? 0;

		// Skip overflow check if the message came from a different model.
		// This handles the case where user switched from a smaller-context model (e.g. opus)
		// to a larger-context model (e.g. codex) - the overflow error from the old model
		// shouldn't trigger compaction for the new model.
		const sameModel =
			this.model && assistantMessage.provider === this.model.provider && assistantMessage.model === this.model.id;

		// Skip compaction checks if this assistant message is older than the latest
		// compaction boundary. This prevents a stale pre-compaction usage/error
		// from retriggering compaction on the first prompt after compaction.
		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		const assistantIsFromBeforeCompaction =
			compactionEntry !== null && assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
		if (assistantIsFromBeforeCompaction) {
			return false;
		}

		// Automatic cases 1 and 2: context overflow.
		// A length stop is recoverable when output ended below the model's original desired limit,
		// independent of the configured context size or any context-clamped provider request limit.
		const contextOverflow = sameModel && isContextOverflow(assistantMessage, contextWindow);
		const recoverableLength = sameModel && isRecoverableLength(assistantMessage, this.model?.maxTokens ?? 0);
		if (contextOverflow || recoverableLength) {
			const willRetry = assistantMessage.stopReason !== "stop";

			// Case 2: the response completed successfully. Compact, but do not retry because
			// agent.continue() cannot continue from a completed assistant response.
			if (!willRetry) {
				return await this._runAutoCompaction("overflow", false);
			}

			if (this._overflowRecoveryAttempted) {
				const errorMessage = contextOverflow
					? "Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model."
					: "Truncated response recovery failed after one compact-and-retry attempt.";
				this._emit({
					type: "compaction_end",
					reason: "overflow",
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage,
				});
				await this._emitSessionCompactFailed({
					reason: "overflow",
					errorMessage,
					aborted: false,
					willRetry: false,
					fromExtension: false,
				});
				return false;
			}

			// Case 1: remove the failed or truncated message from agent state, compact, and
			// retry once. The message remains in session history but is excluded from retry context.
			this._overflowRecoveryAttempted = true;
			const messages = this.agent.state.messages;
			if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
				this.agent.state.messages = messages.slice(0, -1);
			}
			return await this._runAutoCompaction("overflow", willRetry);
		}

		// Case 3: threshold compaction without retry.
		// For error messages or all-zero usage messages, estimate from the last valid response.
		// This ensures sessions that hit persistent API errors (e.g. 529) or malformed zero-usage
		// responses can still compact and do not reset context accounting.
		let contextTokens: number;
		const directContextTokens = assistantMessage.usage ? calculateContextTokens(assistantMessage.usage) : 0;
		if (assistantMessage.stopReason === "error" || directContextTokens === 0) {
			const messages = this.agent.state.messages;
			const estimate = estimateContextTokens(messages);
			// Without provider usage, estimate.tokens is the pure message-size estimate.
			// Only usage-backed estimates need the stale pre-compaction check.
			if (estimate.lastUsageIndex !== null) {
				// Verify the usage source is post-compaction. Kept pre-compaction messages
				// have stale usage reflecting the old (larger) context and would falsely
				// trigger compaction right after one just finished.
				const usageMsg = messages[estimate.lastUsageIndex];
				if (
					compactionEntry &&
					usageMsg.role === "assistant" &&
					(usageMsg as AssistantMessage).timestamp <= new Date(compactionEntry.timestamp).getTime()
				) {
					return false;
				}
			}
			contextTokens = estimate.tokens;
		} else {
			contextTokens = directContextTokens;
		}
		if (shouldCompact(contextTokens, contextWindow, settings)) {
			return await this._runAutoCompaction("threshold", false);
		}
		return false;
	}

	/**
	 * Execute threshold or overflow compaction. Manual compaction uses
	 * `AgentSession.compact()` instead. Both paths call the lower-level `compact()`
	 * function imported from `./compaction/index.ts` after preparation and extension
	 * interception.
	 *
	 * @param reason Automatic trigger selected by `_checkCompaction()`
	 * @param willRetry Whether to continue the interrupted turn after overflow compaction
	 * @returns Whether the post-run loop should call `agent.continue()`
	 */
	private async _runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<boolean> {
		const settings = this._compactionSettings();
		let started = false;
		let fromExtension = false;

		try {
			if (!this.model) {
				return false;
			}

			const { model: requestModel, apiKey, headers, env } = await this._getSummarizationRequestAuth(this.model);

			const pathEntries = this.sessionManager.getBranch();

			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				return false;
			}

			this._emit({ type: "compaction_start", reason });
			this._autoCompactionAbortController = new AbortController();
			started = true;

			let extensionCompaction: CompactionResult | undefined;

			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				const extensionResult = (await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions: undefined,
					reason,
					willRetry,
					signal: this._autoCompactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (extensionResult?.cancel) {
					this._emit({
						type: "compaction_end",
						reason,
						result: undefined,
						aborted: true,
						willRetry: false,
					});
					await this._emitSessionCompactFailed({
						reason,
						aborted: true,
						willRetry: false,
						fromExtension: false,
					});
					return false;
				}

				if (extensionResult?.compaction) {
					extensionCompaction = extensionResult.compaction;
					fromExtension = true;
				}
			}

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let usage: Usage | undefined;
			let details: unknown;

			if (extensionCompaction) {
				// Extension provided compaction content
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				usage = extensionCompaction.usage;
				details = extensionCompaction.details;
			} else {
				// Shared default summary generator, also used by manual compaction.
				const compactResult = await this._runDefaultCompaction(
					preparation,
					requestModel,
					apiKey,
					headers,
					undefined,
					this._autoCompactionAbortController.signal,
					env,
					reason,
				);
				summary = compactResult.summary;
				firstKeptEntryId = compactResult.firstKeptEntryId;
				tokensBefore = compactResult.tokensBefore;
				usage = compactResult.usage;
				details = compactResult.details;
			}

			if (this._autoCompactionAbortController.signal.aborted) {
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				await this._emitSessionCompactFailed({
					reason,
					aborted: true,
					willRetry: false,
					fromExtension,
				});
				return false;
			}

			this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension, usage);
			const newEntries = this.sessionManager.getEntries();
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;
			const estimatedTokensAfter = estimateMessagesTokens(sessionContext.messages);

			// Get the saved compaction entry for the extension event
			const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this._extensionRunner && savedCompactionEntry) {
				await this._extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
					reason,
					willRetry,
				});
			}

			const result: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				estimatedTokensAfter,
				usage,
				details,
			};
			this._emit({ type: "compaction_end", reason, result, aborted: false, willRetry });

			if (willRetry) {
				const messages = this.agent.state.messages;
				const lastMsg = messages[messages.length - 1];
				// The overflow response was persisted on message_end before _checkCompaction() removed it
				// from agent state. Rebuilding state from the new compaction can restore that kept entry,
				// leaving an assistant as the final message. agent.continue() rejects that state, so remove
				// the retriable error or truncated-length response again before continuing the interrupted turn.
				if (
					lastMsg?.role === "assistant" &&
					(lastMsg.stopReason === "error" || lastMsg.stopReason === "length" || lastMsg.stopReason === "toolUse")
				) {
					this.agent.state.messages = messages.slice(0, -1);
				}
				return true;
			}

			// Auto-compaction can complete while follow-up/steering/custom messages are waiting.
			// Continue once so queued messages are delivered.
			return this.agent.hasQueuedMessages();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "compaction failed";
			if (started) {
				const formattedErrorMessage =
					reason === "overflow"
						? `Context overflow recovery failed: ${errorMessage}`
						: `Auto-compaction failed: ${errorMessage}`;
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage: formattedErrorMessage,
				});
				await this._emitSessionCompactFailed({
					reason,
					errorMessage: formattedErrorMessage,
					aborted: false,
					willRetry: false,
					fromExtension,
				});
			}
			return false;
		} finally {
			this._autoCompactionAbortController = undefined;
		}
	}

	/**
	 * Toggle auto-compaction setting.
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		this.settingsManager.setCompactionEnabled(enabled);
	}

	/** Whether auto-compaction is enabled */
	get autoCompactionEnabled(): boolean {
		return this.settingsManager.getCompactionEnabled();
	}

	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		if (bindings.uiContext !== undefined) {
			this._extensionUIContext = bindings.uiContext;
		}
		if (bindings.mode !== undefined) {
			this._extensionMode = bindings.mode;
		}
		if (bindings.commandContextActions !== undefined) {
			this._extensionCommandContextActions = bindings.commandContextActions;
		}
		if (bindings.abortHandler !== undefined) {
			this._extensionAbortHandler = bindings.abortHandler;
		}
		if (bindings.shutdownHandler !== undefined) {
			this._extensionShutdownHandler = bindings.shutdownHandler;
		}
		if (bindings.onError !== undefined) {
			this._extensionErrorListener = bindings.onError;
		}

		this._applyExtensionBindings(this._extensionRunner);
		await this._extensionRunner.emit(this._sessionStartEvent);
		await this.extendResourcesFromExtensions(this._sessionStartEvent.reason === "reload" ? "reload" : "startup");
	}

	private async extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void> {
		if (!this._extensionRunner.hasHandlers("resources_discover")) {
			return;
		}

		const { skillPaths, promptPaths, themePaths } = await this._extensionRunner.emitResourcesDiscover(
			this._cwd,
			reason,
		);

		if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
			return;
		}

		const extensionPaths: ResourceExtensionPaths = {
			skillPaths: this.buildExtensionResourcePaths(skillPaths),
			promptPaths: this.buildExtensionResourcePaths(promptPaths),
			themePaths: this.buildExtensionResourcePaths(themePaths),
		};

		this._resourceLoader.extendResources(extensionPaths);
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		this.agent.state.systemPrompt = this._baseSystemPrompt;
	}

	private buildExtensionResourcePaths(entries: Array<{ path: string; extensionPath: string }>): Array<{
		path: string;
		metadata: { source: string; scope: "temporary"; origin: "top-level"; baseDir?: string };
	}> {
		return entries.map((entry) => {
			const source = this.getExtensionSourceLabel(entry.extensionPath);
			const baseDir = entry.extensionPath.startsWith("<") ? undefined : dirname(entry.extensionPath);
			return {
				path: entry.path,
				metadata: {
					source,
					scope: "temporary",
					origin: "top-level",
					baseDir,
				},
			};
		});
	}

	private getExtensionSourceLabel(extensionPath: string): string {
		if (extensionPath.startsWith("<")) {
			return `extension:${extensionPath.replace(/[<>]/g, "")}`;
		}
		const base = basename(extensionPath);
		const name = base.replace(/\.(ts|js)$/, "");
		return `extension:${name}`;
	}

	private _applyExtensionBindings(runner: ExtensionRunner): void {
		runner.setUIContext(this._extensionUIContext, this._extensionMode);
		runner.bindCommandContext(this._extensionCommandContextActions);

		this._extensionErrorUnsubscriber?.();
		this._extensionErrorUnsubscriber = this._extensionErrorListener
			? runner.onError(this._extensionErrorListener)
			: undefined;
	}

	private _refreshCurrentModelFromRegistry(): void {
		const currentModel = this.model;
		if (!currentModel) {
			return;
		}

		const refreshedModel = this._modelRuntime.getModel(currentModel.provider, currentModel.id);
		if (!refreshedModel || refreshedModel === currentModel) {
			return;
		}

		this.agent.state.model = refreshedModel;
	}

	private _bindExtensionCore(runner: ExtensionRunner): void {
		const getCommands = (): SlashCommandInfo[] => {
			const extensionCommands: SlashCommandInfo[] = runner.getRegisteredCommands().map((command) => ({
				name: command.invocationName,
				description: command.description,
				source: "extension",
				sourceInfo: command.sourceInfo,
			}));

			const templates: SlashCommandInfo[] = this.promptTemplates.map((template) => ({
				name: template.name,
				description: template.description,
				source: "prompt",
				sourceInfo: template.sourceInfo,
			}));

			const skills: SlashCommandInfo[] = this._resourceLoader.getSkills().skills.map((skill) => ({
				name: `skill:${skill.name}`,
				description: skill.description,
				source: "skill",
				sourceInfo: skill.sourceInfo,
			}));

			return [...extensionCommands, ...templates, ...skills];
		};

		runner.bindCore(
			{
				sendMessage: (message, options) => {
					this.sendCustomMessage(message, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				sendUserMessage: (content, options) => {
					this.sendUserMessage(content, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_user_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				abortResponse: (reason, options) => {
					if (!this._isAgentRunActive) return false;
					this._abortResponseRequest = {
						reason,
						retry: options?.retry !== false,
						attempt: options?.attempt ?? 1,
						maxAttempts: options?.maxAttempts ?? 1,
					};
					// Direct agent abort: ctx.abort() routes through the host's
					// abort handler (the TUI restores queued messages, etc.),
					// which is wrong for a mechanical guard.
					this.agent.abort();
					return true;
				},
				appendEntry: (customType, data) => {
					const entryId = this.sessionManager.appendCustomEntry(customType, data);
					const entry = this.sessionManager.getEntry(entryId);
					if (entry) {
						this._emit({ type: "entry_appended", entry });
					}
				},
				setSessionName: (name) => {
					this.setSessionName(name);
				},
				getSessionName: () => {
					return this.sessionManager.getSessionName();
				},
				setLabel: (entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
				},
				getActiveTools: () => this.getActiveToolNames(),
				getAllTools: () => this.getAllTools(),
				setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),
				refreshTools: () => this._refreshToolRegistry(),
				getCommands,
				setModel: async (model) => {
					if (!this._modelRuntime.hasConfiguredAuth(model.provider)) return false;
					await this.setModel(model);
					return true;
				},
				getThinkingLevel: () => this.thinkingLevel,
				setThinkingLevel: (level) => this.setThinkingLevel(level),
			},
			{
				getModel: () => this.model,
				getScopedModels: () => this._scopedModels,
				isIdle: () => this.isIdle,
				isProjectTrusted: () => this.settingsManager.isProjectTrusted(),
				getSignal: () => this.agent.signal,
				abort: () => {
					if (this._extensionAbortHandler) {
						this._extensionAbortHandler();
						return;
					}
					void this.abort();
				},
				hasPendingMessages: () => this.pendingMessageCount > 0,
				shutdown: () => {
					this._extensionShutdownHandler?.();
				},
				getContextUsage: () => this.getContextUsage(),
				compact: (options) => {
					void (async () => {
						try {
							const result = await this.compact(options?.customInstructions);
							options?.onComplete?.(result);
						} catch (error) {
							const err = error instanceof Error ? error : new Error(String(error));
							options?.onError?.(err);
						}
					})();
				},
				getSystemPrompt: () => this.systemPrompt,
				getSystemPromptOptions: () => this._baseSystemPromptOptions,
			},
			{
				registerProvider: (name, config) => {
					this._modelRuntime.registerProvider(name, config);
					this._refreshCurrentModelFromRegistry();
				},
				registerNativeProvider: (provider) => {
					this._modelRuntime.registerNativeProvider(provider);
					this._refreshCurrentModelFromRegistry();
				},
				unregisterProvider: (name) => {
					this._modelRuntime.unregisterProvider(name);
					this._refreshCurrentModelFromRegistry();
				},
			},
		);
	}

	/**
	 * The commands this session has, as the agent needs to see them.
	 *
	 * Read live rather than baked into the tool's description: extensions load
	 * after the builtin definitions are seeded, and a session can gain or lose
	 * them on a reload.
	 */
	private _agentCommands(): { name: string; description: string }[] {
		return this._extensionRunner
			.getRegisteredCommands()
			.filter((command) => !command.internal && !HARNESS_ONLY_COMMANDS.has(command.invocationName))
			.map((command) => ({
				name: command.invocationName,
				description: command.description?.trim() ?? "",
			}));
	}

	/**
	 * One tool for every slash command, rather than a tool apiece.
	 *
	 * The commands are already written: fifteen handlers that know how to start
	 * a battletest, toggle the advisor, read a status. What was missing was the
	 * agent ever being asked - the harness parsed the slash itself and ran the
	 * handler, so `/research` with no subject answered with a popup instead of
	 * a question, and nothing in the chat was the agent's. Now the agent reads
	 * what was typed, works out which command was meant and what its arguments
	 * are, and calls it. A generic tool rather than fifteen means a command
	 * added tomorrow is reachable the same day, with no tool written for it.
	 */
	private _buildCommandTool(): ToolDefinition {
		return {
			name: COMMAND_TOOL_NAME,
			label: "Command",
			description:
				"Run one of this session's slash commands. Use it when the user types a slash command, or " +
				"asks in words for something a command does. `name` is the command without its slash; " +
				"`args` is everything the user gave after it, verbatim. The result is whatever the command " +
				"reported - relay it in your own words. If a command needs an argument the user did not " +
				"give, ask them for it rather than guessing.",
			parameters: Type.Object({
				name: Type.String({ description: "The command to run, without the leading slash." }),
				args: Type.Optional(Type.String({ description: "Everything after the command name, verbatim." })),
			}),
			execute: async (_toolCallId, params) => {
				const { name, args } = params as { name: string; args?: string };
				const wanted = String(name ?? "").replace(/^\/+/, "");
				const command = this._extensionRunner.getCommand(wanted);
				if (!command || HARNESS_ONLY_COMMANDS.has(wanted)) {
					const known = this._agentCommands()
						.map((entry) => entry.name)
						.join(", ");
					return {
						content: [{ type: "text", text: `No command "${wanted}". This session has: ${known || "none"}.` }],
						isError: true,
						details: { command: wanted, ran: false },
					};
				}
				// The handler talks to the reader through notifications, which is
				// the harness's voice. Held here and handed back as the result, so
				// the agent is the one who says what happened.
				const reported: string[] = [];
				const held: { message: string; type?: "info" | "warning" | "error" }[] = [];
				const ctx = this._extensionRunner.createCommandContext();
				const restoreUi = this._captureCommandNotices(ctx, reported, held);
				try {
					await command.handler(String(args ?? ""), ctx);
				} catch (err) {
					const failure = err instanceof Error ? err.message : String(err);
					return {
						content: [{ type: "text", text: `/${wanted} failed: ${failure}` }],
						isError: true,
						details: { command: wanted, ran: true },
					};
				} finally {
					restoreUi();
				}
				const said = reported.join("\n").trim();
				return {
					content: [{ type: "text", text: said === "" ? `/${wanted} ran and reported nothing.` : said }],
					details: { command: wanted, ran: true },
				};
			},
		} as ToolDefinition;
	}

	private _refreshToolRegistry(options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void {
		const previousRegistryNames = new Set(this._toolRegistry.keys());
		const previousActiveToolNames = this.getActiveToolNames();
		const allowedToolNames = this._allowedToolNames;
		const excludedToolNames = this._excludedToolNames;
		const isAllowedTool = (name: string): boolean =>
			(!allowedToolNames || allowedToolNames.has(name)) && !excludedToolNames?.has(name);

		const registeredTools = this._extensionRunner.getAllRegisteredTools();
		const allCustomTools = [
			...registeredTools,
			...this._customTools.map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
			})),
		].filter((tool) => isAllowedTool(tool.definition.name));
		const definitionRegistry = new Map<string, ToolDefinitionEntry>(
			Array.from(this._baseToolDefinitions.entries())
				.filter(([name]) => isAllowedTool(name))
				.map(([name, definition]) => [
					name,
					{
						definition,
						sourceInfo: createSyntheticSourceInfo(`<builtin:${name}>`, { source: "builtin" }),
					},
				]),
		);
		for (const tool of allCustomTools) {
			definitionRegistry.set(tool.definition.name, {
				definition: tool.definition,
				sourceInfo: tool.sourceInfo,
			});
		}
		this._toolDefinitions = definitionRegistry;
		this._toolPromptSnippets = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const snippet = this._normalizePromptSnippet(definition.promptSnippet);
					return snippet ? ([definition.name, snippet] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string] => entry !== undefined),
		);
		this._toolPromptGuidelines = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const guidelines = this._normalizePromptGuidelines(definition.promptGuidelines);
					return guidelines.length > 0 ? ([definition.name, guidelines] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string[]] => entry !== undefined),
		);
		const runner = this._extensionRunner;
		const wrappedExtensionTools = wrapRegisteredTools(allCustomTools, runner);
		const wrappedBuiltInTools = wrapRegisteredTools(
			Array.from(this._baseToolDefinitions.values())
				.filter((definition) => isAllowedTool(definition.name))
				.map((definition) => ({
					definition,
					sourceInfo: createSyntheticSourceInfo(`<builtin:${definition.name}>`, { source: "builtin" }),
				})),
			runner,
		);

		const toolRegistry = new Map(wrappedBuiltInTools.map((tool) => [tool.name, tool]));
		for (const tool of wrappedExtensionTools as AgentTool[]) {
			toolRegistry.set(tool.name, tool);
		}
		this._toolRegistry = toolRegistry;

		const nextActiveToolNames = (
			options?.activeToolNames ? [...options.activeToolNames] : [...previousActiveToolNames]
		).filter((name) => isAllowedTool(name));

		if (allowedToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (allowedToolNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		} else if (options?.includeAllExtensionTools) {
			for (const tool of wrappedExtensionTools) {
				nextActiveToolNames.push(tool.name);
			}
		} else if (!options?.activeToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (!previousRegistryNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		}

		this.setActiveToolsByName([...new Set(nextActiveToolNames)]);
	}

	private _buildRuntime(options: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
	}): void {
		const autoResizeImages = this.settingsManager.getImageAutoResize();
		const shellCommandPrefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const baseToolDefinitions = this._baseToolsOverride
			? Object.fromEntries(
					Object.entries(this._baseToolsOverride).map(([name, tool]) => [
						name,
						createToolDefinitionFromAgentTool(tool),
					]),
				)
			: createAllToolDefinitions(this._cwd, {
					read: { autoResizeImages, ...this._toolsOptions?.read },
					bash: { commandPrefix: shellCommandPrefix, shellPath, ...this._toolsOptions?.bash },
					powershell: this._toolsOptions?.powershell,
					write: this._toolsOptions?.write,
					edit: this._toolsOptions?.edit,
					grep: this._toolsOptions?.grep,
					find: this._toolsOptions?.find,
					ls: this._toolsOptions?.ls,
				});

		this._baseToolDefinitions = new Map(
			Object.entries(baseToolDefinitions).map(([name, tool]) => [name, tool as ToolDefinition]),
		);
		this._baseToolDefinitions.set(COMMAND_TOOL_NAME, this._buildCommandTool());

		const extensionsResult = this._resourceLoader.getExtensions();
		if (options.flagValues) {
			for (const [name, value] of options.flagValues) {
				extensionsResult.runtime.flagValues.set(name, value);
			}
		}

		this._extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			this._cwd,
			this.sessionManager,
			new ModelRegistry(this._modelRuntime),
		);
		if (this._extensionRunnerRef) {
			this._extensionRunnerRef.current = this._extensionRunner;
		}
		this._bindExtensionCore(this._extensionRunner);
		this._applyExtensionBindings(this._extensionRunner);

		const defaultActiveToolNames = this._baseToolsOverride
			? Object.keys(this._baseToolsOverride)
			: ["read", "bash", "edit", "write"];
		const baseActiveToolNames = options.activeToolNames ?? defaultActiveToolNames;
		this._refreshToolRegistry({
			activeToolNames: baseActiveToolNames,
			includeAllExtensionTools: options.includeAllExtensionTools,
		});
	}

	async reload(options?: { beforeSessionStart?: () => void | Promise<void> }): Promise<void> {
		const oldRunner = this._extensionRunner;
		const previousFlagValues = oldRunner.getFlagValues();
		await emitSessionShutdownEvent(oldRunner, { type: "session_shutdown", reason: "reload" });
		oldRunner.invalidate();
		await this.settingsManager.reload();
		this.syncQueueModesFromSettings();
		resetApiProviders();
		await this._resourceLoader.reload();
		this._buildRuntime({
			activeToolNames: this.getActiveToolNames(),
			flagValues: previousFlagValues,
			includeAllExtensionTools: true,
		});

		const hasBindings =
			this._extensionUIContext ||
			this._extensionCommandContextActions ||
			this._extensionShutdownHandler ||
			this._extensionErrorListener;
		if (hasBindings) {
			await options?.beforeSessionStart?.();
			await this._extensionRunner.emit({ type: "session_start", reason: "reload" });
			await this.extendResourcesFromExtensions("reload");
		}
	}

	// =========================================================================
	// Auto-Retry
	// =========================================================================

	/**
	 * Check if an error is retryable (overloaded, rate limit, server errors).
	 * Context overflow errors are NOT retryable (handled by compaction instead).
	 */
	private _isRetryableError(message: AssistantMessage): boolean {
		// Context overflow is handled by compaction, not retry.
		if (isContextOverflow(message, this.model?.contextWindow ?? 0)) return false;
		return isRetryableAssistantError(message);
	}

	/**
	 * Retry policy + callbacks shared by compaction and branch-summary summarization calls.
	 * Uses the same `settings.retry` budget/backoff as agent-turn retries so a single transient
	 * stream drop no longer fails the whole operation. `source` carries the context
	 * the TUI needs to render the retry and recreate the underlying indicator.
	 */
	private _summarizationRetryCallbacks(
		source: { source: "branchSummary" } | { source: "compaction"; reason: "manual" | "threshold" | "overflow" },
	): RetryCallbacks {
		return {
			onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => {
				this._emit({
					type: "summarization_retry_scheduled",
					attempt,
					maxAttempts,
					delayMs,
					errorMessage,
				});
			},
			onRetryAttemptStart: () => {
				this._emit({
					type: "summarization_retry_attempt_start",
					...source,
				});
			},
			onRetryFinished: () => {
				this._emit({ type: "summarization_retry_finished" });
			},
		};
	}

	/**
	 * Prepare a retryable error for continuation with exponential backoff.
	 * @returns true if the caller should continue the agent, false otherwise
	 */
	private async _prepareRetry(message: AssistantMessage): Promise<boolean> {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled) {
			return false;
		}

		this._retryAttempt++;

		if (this._retryAttempt > settings.maxRetries) {
			// Preserve the completed attempt count so post-run handling can emit the final failure.
			this._retryAttempt--;
			return false;
		}

		const delayMs = settings.baseDelayMs * 2 ** (this._retryAttempt - 1);

		this._emit({
			type: "auto_retry_start",
			attempt: this._retryAttempt,
			maxAttempts: settings.maxRetries,
			delayMs,
			errorMessage: message.errorMessage || "Unknown error",
		});

		// Remove error message from agent state (keep in session for history)
		const messages = this.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
			this.agent.state.messages = messages.slice(0, -1);
		}

		// Wait with exponential backoff (abortable)
		this._retryAbortController = new AbortController();
		try {
			await sleep(delayMs, this._retryAbortController.signal);
		} catch {
			// Aborted during sleep - emit end event so UI can clean up
			const attempt = this._retryAttempt;
			this._retryAttempt = 0;
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: "Retry cancelled",
			});
			return false;
		} finally {
			this._retryAbortController = undefined;
		}

		return true;
	}

	/**
	 * Cancel in-progress retry.
	 */
	abortRetry(): void {
		this._retryAbortController?.abort();
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this._retryAbortController !== undefined;
	}

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return this.settingsManager.getRetryEnabled();
	}

	/**
	 * Toggle auto-retry setting.
	 */
	setAutoRetryEnabled(enabled: boolean): void {
		this.settingsManager.setRetryEnabled(enabled);
	}

	// =========================================================================
	// Bash Execution
	// =========================================================================

	/**
	 * Execute a bash command.
	 * Adds result to agent context and session.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 * @param options.id Optional identifier included in bash execution update events
	 * @param options.operations Custom BashOperations for remote execution
	 */
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; id?: string; operations?: BashOperations },
	): Promise<BashResult> {
		const abortController = new AbortController();
		this._bashAbortControllers.add(abortController);

		// Apply command prefix if configured (e.g., "shopt -s expand_aliases" for alias support)
		const prefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const resolvedCommand = prefix ? `${prefix}\n${command}` : command;

		try {
			const result = await executeBashWithOperations(
				resolvedCommand,
				this.sessionManager.getCwd(),
				options?.operations ?? createLocalBashOperations({ shellPath }),
				{
					onChunk: (delta) => {
						onChunk?.(delta);
						this._emit({ type: "bash_execution_update", id: options?.id, delta });
					},
					signal: abortController.signal,
				},
			);

			this.recordBashResult(command, result, options);
			return result;
		} finally {
			this._bashAbortControllers.delete(abortController);
		}
	}

	/**
	 * Record a bash execution result in session history.
	 * Used by executeBash and by extensions that handle bash execution themselves.
	 */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			fullOutputPath: result.fullOutputPath,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.isStreaming) {
			// Queue for later - will be flushed on agent_end
			this._pendingBashMessages.push(bashMessage);
		} else {
			// Add to agent state immediately
			this.agent.state.messages.push(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}
	}

	/**
	 * Cancel running bash command.
	 */
	abortBash(): void {
		for (const abortController of [...this._bashAbortControllers]) {
			abortController.abort();
		}
	}

	/** Whether a bash command is currently running */
	get isBashRunning(): boolean {
		return this._bashAbortControllers.size > 0;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this._pendingBashMessages.length > 0;
	}

	/**
	 * Flush pending bash messages to agent state and session.
	 * Called after agent turn completes to maintain proper message ordering.
	 */
	private _flushPendingBashMessages(): void {
		if (this._pendingBashMessages.length === 0) return;

		for (const bashMessage of this._pendingBashMessages) {
			// Add to agent state
			this.agent.state.messages.push(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}

		this._pendingBashMessages = [];
	}

	// =========================================================================
	// Session Management
	// =========================================================================

	/**
	 * Set a display name for the current session.
	 */
	setSessionName(name: string): void {
		this.sessionManager.appendSessionInfo(name);
		const event = { type: "session_info_changed", name: this.sessionManager.getSessionName() } as const;
		this._emit(event);
		void this._extensionRunner.emit(event);
	}

	// =========================================================================
	// Tree Navigation
	// =========================================================================

	/**
	 * Navigate to a different node in the session tree.
	 * Unlike fork() which creates a new session file, this stays in the same file.
	 *
	 * @param targetId The entry ID to navigate to
	 * @param options.summarize Whether user wants to summarize abandoned branch
	 * @param options.customInstructions Custom instructions for summarizer
	 * @param options.replaceInstructions If true, customInstructions replaces the default prompt
	 * @param options.label Label to attach to the branch summary entry
	 * @returns Result with editorText (if user message) and cancelled status
	 */
	async navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {},
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
		if (this.isStreaming) {
			throw new Error("Wait for the current response to finish before navigating the session tree.");
		}

		const oldLeafId = this.sessionManager.getLeafId();

		// No-op if already at target
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

		// Model required for summarization
		if (options.summarize && !this.model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = this.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		// Collect entries to summarize (from old leaf to common ancestor)
		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.sessionManager,
			oldLeafId,
			targetId,
		);

		// Prepare event data - mutable so extensions can override
		let customInstructions = options.customInstructions;
		let replaceInstructions = options.replaceInstructions;
		let label = options.label;

		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
			customInstructions,
			replaceInstructions,
			label,
		};

		// Set up abort controller for summarization
		this._branchSummaryAbortController = new AbortController();

		try {
			let extensionSummary: { summary: string; details?: unknown; usage?: Usage } | undefined;
			let fromExtension = false;

			// Emit session_before_tree event
			if (this._extensionRunner.hasHandlers("session_before_tree")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_tree",
					preparation,
					signal: this._branchSummaryAbortController.signal,
				})) as SessionBeforeTreeResult | undefined;

				if (result?.cancel) {
					return { cancelled: true };
				}

				if (result?.summary && options.summarize) {
					extensionSummary = result.summary;
					fromExtension = true;
				}

				// Allow extensions to override instructions and label
				if (result?.customInstructions !== undefined) {
					customInstructions = result.customInstructions;
				}
				if (result?.replaceInstructions !== undefined) {
					replaceInstructions = result.replaceInstructions;
				}
				if (result?.label !== undefined) {
					label = result.label;
				}
			}

			// Run default summarizer if needed
			let summaryText: string | undefined;
			let summaryDetails: unknown;
			let summaryUsage: Usage | undefined;
			if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
				const model = this.model!;
				const { model: requestModel, apiKey, headers, env } = await this._getSummarizationRequestAuth(model);
				const branchSummarySettings = this.settingsManager.getBranchSummarySettings();
				const result = await generateBranchSummary(entriesToSummarize, {
					model: requestModel,
					apiKey,
					headers,
					env,
					signal: this._branchSummaryAbortController.signal,
					customInstructions,
					replaceInstructions,
					reserveTokens: branchSummarySettings.reserveTokens,
					streamFn: this.agent.streamFunction,
					retry: this.settingsManager.getRetrySettings(),
					callbacks: this._summarizationRetryCallbacks({ source: "branchSummary" }),
				});
				if (result.aborted) {
					return { cancelled: true, aborted: true };
				}
				if (result.error) {
					throw new Error(result.error);
				}
				summaryText = result.summary;
				summaryUsage = result.usage;
				summaryDetails = {
					readFiles: result.readFiles || [],
					modifiedFiles: result.modifiedFiles || [],
				};
			} else if (extensionSummary) {
				summaryText = extensionSummary.summary;
				summaryDetails = extensionSummary.details;
				summaryUsage = extensionSummary.usage;
			}

			// Determine the new leaf position based on target type
			let newLeafId: string | null;
			let editorText: string | undefined;

			if (targetEntry.type === "message" && targetEntry.message.role === "user") {
				// User message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.message.content, "");
			} else if (targetEntry.type === "custom_message") {
				// Custom message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.content, "");
			} else {
				// Non-user message: leaf = selected node
				newLeafId = targetId;
			}

			// Switch leaf (with or without summary)
			// Summary is attached at the navigation target position (newLeafId), not the old branch
			let summaryEntry: BranchSummaryEntry | undefined;
			if (summaryText) {
				// Create summary at target position (can be null for root)
				const summaryId = this.sessionManager.branchWithSummary(
					newLeafId,
					summaryText,
					summaryDetails,
					fromExtension,
					summaryUsage,
				);
				summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;

				// Attach label to the summary entry
				if (label) {
					this.sessionManager.appendLabelChange(summaryId, label);
				}
			} else if (newLeafId === null) {
				// No summary, navigating to root - reset leaf
				this.sessionManager.resetLeaf();
			} else {
				// No summary, navigating to non-root
				this.sessionManager.branch(newLeafId);
			}

			// Attach label to target entry when not summarizing (no summary entry to label)
			if (label && !summaryText) {
				this.sessionManager.appendLabelChange(targetId, label);
			}

			// Update agent state
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;

			// Emit session_tree event
			await this._extensionRunner.emit({
				type: "session_tree",
				newLeafId: this.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});

			// Emit to custom tools

			return { editorText, cancelled: false, summaryEntry };
		} finally {
			this._branchSummaryAbortController = undefined;
		}
	}

	/**
	 * Get all user messages from session for fork selector.
	 */
	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		const entries = this.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = contentText(entry.message.content, "");
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	/** Percent consumed of the binding usage window, sampled per poll for the drain-rate projection. */
	private usageSamples: { at: number; key: string; percent: number }[] = [];
	/**
	 * The last good reading per provider. A usage endpoint that answers 429
	 * or times out for one poll must not make the provider vanish from the
	 * view until the next: the previous figures stand, marked stale, for a
	 * while.
	 */
	private lastUsage = new Map<string, ProviderUsage & { accounts: UsageAccount[] }>();
	/**
	 * The last answer handed out, reused for a minute. The desktop asks on
	 * every state refresh as well as on its own timer, and each answer costs
	 * a request per provider per account; usage endpoints rate-limit long
	 * before anything else does.
	 */
	private usageAnswer: { at: number; model: string | undefined; value: ProviderUsageSnapshot | undefined } | undefined;

	/**
	 * Subscription usage, polled live: the provider in use first, then every
	 * other configured provider that reports an allowance.
	 *
	 * Each call records a sample of the most-consumed window of the provider
	 * in use; with enough history the drain rate gives an estimate of when
	 * the allowance runs out at the current pace. Undefined when no
	 * configured provider exposes a usage endpoint.
	 */
	async getProviderUsage(): Promise<ProviderUsageSnapshot | undefined> {
		const active = this.model?.provider;
		const cached = this.usageAnswer;
		if (cached && cached.model === active && Date.now() - cached.at < USAGE_POLL_MIN_MS) return cached.value;
		const value = await this.pollProviderUsage(active);
		this.usageAnswer = { at: Date.now(), model: active, value };
		return value;
	}

	private async pollProviderUsage(active: string | undefined): Promise<ProviderUsageSnapshot | undefined> {
		const poolData = PoolStore.create().read();
		// Every provider with a stored credential, primary or pooled, in the
		// order they were added; the one in use goes first.
		const stored = await this.modelRuntime.listCredentials();
		const ids = new Set<string>(stored.map((entry) => entry.providerId));
		for (const providerId of Object.keys(poolData.providers)) ids.add(providerId);
		const ordered = [...ids].filter((id) => supportsProviderUsage(id) && isProviderPooled(poolData, id));
		if (active && ordered.includes(active)) {
			ordered.splice(ordered.indexOf(active), 1);
			ordered.unshift(active);
		}

		const snapshots: (ProviderUsage & { accounts: UsageAccount[]; stale?: boolean })[] = [];
		const fresh = await Promise.all(ordered.map((providerId) => this.usageForProvider(providerId, poolData)));
		for (const [index, providerId] of ordered.entries()) {
			const reading = fresh[index];
			if (reading) {
				this.lastUsage.set(providerId, reading);
				writeUsageCache(reading);
				snapshots.push(reading);
				continue;
			}
			// Own memory first, then the newest reading any other chat's agent
			// process managed — without it a provider vanished from the panel
			// whenever this process's own poll failed or had not run yet.
			const previous = this.lastUsage.get(providerId) ?? readUsageCache()[providerId];
			if (previous && Date.now() - previous.fetchedAt <= USAGE_STALE_MS)
				snapshots.push({ ...previous, stale: true });
		}
		if (snapshots.length === 0) return undefined;

		const [first, ...rest] = snapshots;
		const lead: ProviderUsageSnapshot =
			first.providerId === active ? this.projectDrain(first) : { ...first, bindingWindow: bindingOf(first)?.key };
		return { ...lead, others: rest.map((usage) => ({ ...usage, bindingWindow: bindingOf(usage)?.key })) };
	}

	/** One provider: every credential that can serve it, fetched and aggregated. */
	private async usageForProvider(
		provider: string,
		poolData: PoolData,
	): Promise<(ProviderUsage & { accounts: UsageAccount[] }) | undefined> {
		// Every credential that can serve this provider: the primary from
		// auth.json plus the pool's extras. Pool failover means the session's
		// real allowance is the sum of these, so usage is fetched per account
		// and aggregated; a single-account provider skips the pool entirely.
		const entries: { label: string; credential: Credential }[] = [];
		let primary = await this.modelRuntime.getCredential(provider);
		if (primary?.type === "oauth") {
			// Resolving auth refreshes a stale token and writes it back, so the
			// credential read afterwards is the live one.
			await this.modelRuntime.getAuth(provider).catch(() => undefined);
			primary = await this.modelRuntime.getCredential(provider);
		}
		if (primary) entries.push({ label: primaryLabelOf(poolData, provider), credential: primary });
		const poolCredentials = poolData.providers[provider]?.credentials ?? [];
		for (const [index, entry] of poolCredentials.entries()) {
			if (entry.type !== "api_key" || !entry.key) continue;
			entries.push({
				label: entry.label ?? `Account ${index + 2}`,
				credential: { type: "api_key", key: entry.key },
			});
		}
		if (entries.length === 0) return undefined;

		const settled = await Promise.allSettled(entries.map((entry) => fetchProviderUsage(provider, entry.credential)));
		const accounts: UsageAccount[] = [];
		let providerName = provider;
		for (const [index, result] of settled.entries()) {
			if (result.status === "fulfilled" && result.value) {
				providerName = result.value.providerName;
				accounts.push({ label: entries[index].label, windows: result.value.windows });
			}
		}
		if (accounts.length === 0) return undefined;
		const windows = accounts.length === 1 ? accounts[0].windows : aggregateUsageWindows(accounts);
		return { providerId: provider, providerName, windows, fetchedAt: Date.now(), accounts };
	}

	/** The provider in use: sample its binding window and project when it runs out. */
	private projectDrain(usage: ProviderUsage & { accounts: UsageAccount[] }): ProviderUsageSnapshot {
		const binding = bindingOf(usage);
		let hoursLeft: number | undefined;
		let rateSampleMinutes: number | undefined;
		if (binding) {
			const samples = this.usageSamples;
			const last = samples.at(-1);
			// A different key or a falling percent means the window switched or
			// reset; history from before that says nothing about the new window.
			if (!last || last.key !== binding.key || binding.percent < last.percent) samples.length = 0;
			samples.push({ at: usage.fetchedAt, key: binding.key, percent: binding.percent });
			while (samples.length > 2 && usage.fetchedAt - samples[0].at > RATE_SAMPLE_SPAN_MS) samples.shift();

			const first = samples[0];
			const latest = samples.at(-1);
			if (first && latest && samples.length >= 2) {
				const dt = latest.at - first.at;
				const dp = latest.percent - first.percent;
				// Skip spans too short to distinguish a real drain from polling noise.
				if (dt >= 60_000 && dp > 0) {
					hoursLeft = ((100 - latest.percent) / dp) * (dt / 3_600_000);
					rateSampleMinutes = dt / 60_000;
				}
			}
		}
		return { ...usage, bindingWindow: binding?.key, hoursLeft, rateSampleMinutes };
	}

	/**
	 * Get session statistics. Aggregates over ALL session entries (including
	 * history that was compacted away), so token/cost totals reflect what was
	 * actually billed across the session.
	 */
	getSessionStats(): SessionStats {
		let userMessages = 0;
		let assistantMessages = 0;
		let toolResults = 0;
		let totalMessages = 0;
		let toolCalls = 0;
		const usageTotals = createUsageTotals();
		const background = new Map<string, BackgroundSpend>();
		const bank = (key: string, label: string, usage: Usage): void => {
			addUsageToTotals(usageTotals, usage);
			const spend = background.get(key) ?? { key, label, tokens: 0, cost: 0, requests: 0 };
			spend.tokens += usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
			spend.cost += usage.cost?.total ?? 0;
			spend.requests += 1;
			background.set(key, spend);
		};

		for (const entry of this.sessionManager.getEntries()) {
			if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				addUsageToTotals(usageTotals, entry.usage);
			}
			if (entry.type === "custom" && entry.customType === ADVISOR_USAGE_ENTRY) {
				const data = entry.data as { advisor?: string; usage?: Usage } | undefined;
				if (data?.usage) {
					const name = data.advisor ?? "Advisor";
					bank(`advisor:${name}`, `Advisor · ${name}`, data.usage);
				}
			}
			if (entry.type !== "message") continue;
			totalMessages++;
			const message = entry.message;
			if (message.role === "user") {
				userMessages++;
			} else if (message.role === "toolResult") {
				toolResults++;
				if (message.usage) {
					const name = message.toolName;
					bank(`tool:${name}`, name.charAt(0).toUpperCase() + name.slice(1), message.usage);
				}
			} else if (message.role === "assistant") {
				assistantMessages++;
				const assistantMsg = message as AssistantMessage;
				if (Array.isArray(assistantMsg.content)) {
					toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
				}
				addUsageToTotals(usageTotals, assistantMsg.usage);
			}
		}

		return {
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			userMessages,
			assistantMessages,
			toolCalls,
			toolResults,
			totalMessages,
			tokens: {
				input: usageTotals.input,
				output: usageTotals.output,
				cacheRead: usageTotals.cacheRead,
				cacheWrite: usageTotals.cacheWrite,
				total: usageTotals.input + usageTotals.output + usageTotals.cacheRead + usageTotals.cacheWrite,
			},
			cost: usageTotals.cost,
			contextUsage: this.getContextUsage(),
			background: [...background.values()].sort((a, b) => b.tokens - a.tokens),
		};
	}

	/**
	 * Images the next request will carry, against what the context holds.
	 *
	 * Counted off the live context rather than the session file, because
	 * that is what actually gets sent: history compacted away costs nothing,
	 * and a picture read an hour ago costs the same as one read just now.
	 */
	private imageUsage(): { sent: number; held: number } {
		const held = countImages(this.messages);
		const sent = this.settingsManager.getBlockImages() ? 0 : Math.min(held, MAX_IMAGES_PER_REQUEST);
		return { sent, held };
	}

	getContextUsage(): ContextUsage | undefined {
		const model = this.model;
		if (!model) return undefined;

		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

		// After compaction, the last assistant usage reflects pre-compaction context size.
		// We can only trust usage from an assistant that responded after the latest compaction.
		// If no such assistant exists, context token count is unknown until the next LLM response.
		const branchEntries = this.sessionManager.getBranch();
		const latestCompaction = getLatestCompactionEntry(branchEntries);

		if (latestCompaction) {
			// Check if there's a valid assistant usage after the compaction boundary
			const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
			let hasPostCompactionUsage = false;
			for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
				const entry = branchEntries[i];
				if (entry.type === "message" && entry.message.role === "assistant") {
					const assistant = entry.message;
					if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error") {
						const contextTokens = calculateContextTokens(assistant.usage);
						if (contextTokens > 0) {
							hasPostCompactionUsage = true;
							break;
						}
					}
				}
			}

			if (!hasPostCompactionUsage) {
				return {
					tokens: null,
					contextWindow,
					percent: null,
					images: this.imageUsage(),
					breakdown: this.contextBreakdown(null),
				};
			}
		}

		const estimate = estimateContextTokens(this.messages);
		const percent = (estimate.tokens / contextWindow) * 100;

		return {
			tokens: estimate.tokens,
			contextWindow,
			percent,
			images: this.imageUsage(),
			breakdown: this.contextBreakdown(estimate.tokens),
		};
	}

	/**
	 * What the next request carries, part by part. Sizes come from text
	 * length, four characters to a token — the heuristic compaction uses —
	 * and when the provider has reported the real total they are scaled to
	 * it, so the parts add up to the figure on the ring.
	 */
	private contextBreakdown(reported: number | null): ContextBreakdown {
		const size = (text: string): number => Math.ceil(text.length / 4);
		const prompt = this.agent.state.systemPrompt ?? "";
		const section = (open: string, close: string): string => {
			const start = prompt.indexOf(open);
			if (start < 0) return "";
			const end = prompt.indexOf(close, start);
			return end < 0 ? prompt.slice(start) : prompt.slice(start, end + close.length);
		};
		const skills = section("<available_skills>", "</available_skills>");
		const contextFiles = section("<project_context>", "</project_context>");
		const base = prompt.replace(skills, "").replace(contextFiles, "");
		const fileItems: ContextBreakdownItem[] = [];
		for (const match of contextFiles.matchAll(
			/<project_instructions path="([^"]*)">[\s\S]*?<\/project_instructions>/g,
		)) {
			fileItems.push({ name: match[1] ?? "", tokens: size(match[0]) });
		}
		const systemTools: ContextBreakdownItem[] = [];
		const extensionTools: ContextBreakdownItem[] = [];
		for (const tool of this.agent.state.tools) {
			const tokens = size(
				JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }),
			);
			const sourceInfo = this._toolDefinitions.get(tool.name)?.sourceInfo;
			if (sourceInfo?.source === "builtin") systemTools.push({ name: tool.name, tokens });
			else extensionTools.push({ name: tool.name, tokens, source: extensionLabel(sourceInfo?.path) });
		}
		let messages = 0;
		for (const message of this.messages) messages += estimateTokens(message);
		const largestFirst = (items: ContextBreakdownItem[]): ContextBreakdownItem[] =>
			[...items].sort((a, b) => b.tokens - a.tokens);
		const total = (items: ContextBreakdownItem[]): number => items.reduce((sum, item) => sum + item.tokens, 0);
		const parts: ContextBreakdownPart[] = [
			{ key: "messages", label: "Messages", tokens: messages },
			{ key: "systemTools", label: "System tools", tokens: total(systemTools), items: largestFirst(systemTools) },
			{
				key: "extensionTools",
				label: "Extension tools",
				tokens: total(extensionTools),
				items: largestFirst(extensionTools),
			},
			{ key: "systemPrompt", label: "System prompt", tokens: size(base) },
			{ key: "skills", label: "Skills", tokens: size(skills) },
			{
				key: "contextFiles",
				label: "Context files",
				tokens: fileItems.length > 0 ? total(fileItems) : size(contextFiles),
				items: largestFirst(fileItems),
			},
		];
		const estimated = parts.reduce((sum, part) => sum + part.tokens, 0);
		if (reported !== null && reported > 0 && estimated > 0) {
			const factor = reported / estimated;
			for (const part of parts) {
				part.tokens = Math.round(part.tokens * factor);
				for (const item of part.items ?? []) item.tokens = Math.round(item.tokens * factor);
			}
		}
		return { parts };
	}

	/**
	 * Export session to HTML.
	 * @param outputPath Optional output path (defaults to session directory)
	 * @param options Optional export presentation settings
	 * @returns Path to exported file
	 */
	async exportToHtml(outputPath?: string, options: { themeName?: string } = {}): Promise<string> {
		const themeName = [options.themeName, this.settingsManager.getTheme()].find(
			(candidate) => candidate !== undefined && getThemeByName(candidate) !== undefined,
		);

		// Create tool renderer if we have an extension runner (for custom tool HTML rendering)
		const toolRenderer: ToolHtmlRenderer = createToolHtmlRenderer({
			getToolDefinition: (name) => this.getToolDefinition(name),
			theme,
			cwd: this.sessionManager.getCwd(),
		});

		return await exportSessionToHtml(this.sessionManager, this.state, {
			outputPath,
			themeName,
			toolRenderer,
		});
	}

	/**
	 * Export the current session branch to a JSONL file.
	 * Writes the session header followed by all entries on the current branch path.
	 * @param outputPath Target file path. If omitted, generates a timestamped file in cwd.
	 * @returns The resolved output file path.
	 */
	exportToJsonl(outputPath?: string): string {
		return exportSessionToJsonl(this.sessionManager, outputPath);
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	/**
	 * Get text content of last assistant message.
	 * Useful for /copy command.
	 * @returns Text content, or undefined if no assistant message exists
	 */
	getLastAssistantText(): string | undefined {
		const lastAssistant = this.messages
			.slice()
			.reverse()
			.find((m) => {
				if (m.role !== "assistant") return false;
				const msg = m as AssistantMessage;
				// Skip aborted messages with no content
				if (msg.stopReason === "aborted" && msg.content.length === 0) return false;
				return true;
			});

		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of (lastAssistant as AssistantMessage).content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		return text.trim() || undefined;
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	createReplacedSessionContext(): ReplacedSessionContext {
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this._extensionRunner.createCommandContext()),
		) as ReplacedSessionContext;
		context.sendMessage = (message, options) => this.sendCustomMessage(message, options);
		context.sendUserMessage = (content, options) => this.sendUserMessage(content, options);
		return context;
	}

	/**
	 * Check if extensions have handlers for a specific event type.
	 */
	hasExtensionHandlers(eventType: string): boolean {
		return this._extensionRunner.hasHandlers(eventType);
	}

	/**
	 * Get the extension runner (for setting UI context and error handlers).
	 */
	get extensionRunner(): ExtensionRunner {
		return this._extensionRunner;
	}
}
