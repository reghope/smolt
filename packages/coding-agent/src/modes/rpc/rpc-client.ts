/**
 * RPC Client for programmatic access to the coding agent.
 *
 * Spawns the agent in RPC mode and provides a typed API for all operations.
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { AgentMessage, ThinkingLevel } from "@smolt/agent-core";
import type { ImageContent } from "@smolt/ai";
import type { SessionStats } from "../../core/agent-session.ts";
import type { BashResult } from "../../core/bash-executor.ts";
import type { CompactionResult } from "../../core/compaction/index.ts";
import type { SessionEntry, SessionTreeNode } from "../../core/session-manager.ts";
import type { JsonAgentSessionEvent } from "../json-event.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import type { RpcCommand, RpcExtensionInfo, RpcResponse, RpcSessionState, RpcSlashCommand } from "./rpc-types.ts";

// ============================================================================
// Types
// ============================================================================

/** Distributive Omit that works with union types */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** RpcCommand without the id field (for internal send) */
type RpcCommandBody = DistributiveOmit<RpcCommand, "id">;

export interface RpcClientOptions {
	/** Path to the CLI entry point (default: searches for dist/cli.js) */
	cliPath?: string;
	/** Working directory for the agent */
	cwd?: string;
	/** Environment variables */
	env?: Record<string, string | undefined>;
	/** Provider to use */
	provider?: string;
	/** Model ID to use */
	model?: string;
	/** Additional CLI arguments */
	args?: string[];
	/**
	 * Executable to run the CLI with, when plain `node` will not do.
	 *
	 * A packaged desktop app cannot assume Node is installed, but it ships one
	 * inside Electron; pointing this at that binary is how it starts the agent
	 * on a machine that has no Node of its own.
	 */
	execPath?: string;
	/**
	 * Where slow-request warnings go (default: this process's stderr).
	 *
	 * A request pending far longer than a healthy agent takes is the earliest
	 * visible sign of a wedged agent process; a host that keeps its own log
	 * (the desktop's crash log) hooks it here so the evidence survives.
	 */
	onDiagnostic?: (line: string) => void;
}

/**
 * How long each command may take before the client gives up.
 *
 * The 30s default fits calls a healthy agent answers immediately. Commands
 * that legitimately run long get their own ceiling: compaction is an LLM
 * summarization call, a user bash command runs until it finishes, session
 * moves replay transcripts from disk. Timing those out at 30s reported
 * phantom failures while the agent was still working — which read as
 * "the desktop is stuck" even though nothing was.
 */
const RPC_TIMEOUT_MS: Partial<Record<RpcCommand["type"], number>> = {
	// A prompt's response can be held open by an extension command's dialogs.
	prompt: 10 * 60 * 1000,
	compact: 10 * 60 * 1000,
	bash: 30 * 60 * 1000,
	switch_session: 5 * 60 * 1000,
	new_session: 5 * 60 * 1000,
	fork: 5 * 60 * 1000,
	clone: 5 * 60 * 1000,
	export_html: 2 * 60 * 1000,
};
const RPC_DEFAULT_TIMEOUT_MS = 30_000;

/** A request pending this long is worth a log line before its timeout fires. */
const SLOW_REQUEST_WARN_MS = 60_000;

export interface ModelInfo {
	provider: string;
	id: string;
	contextWindow: number;
	reasoning: boolean;
}

export type RpcEventListener = (event: JsonAgentSessionEvent) => void;

// ============================================================================
// RPC Client
// ============================================================================

export class RpcClient {
	private process: ChildProcess | null = null;
	private stopReadingStdout: (() => void) | null = null;
	private eventListeners: RpcEventListener[] = [];
	private exitListeners: ((info: { code: number | null; signal: string | null }) => void)[] = [];
	private pendingRequests: Map<
		string,
		{
			resolve: (response: RpcResponse) => void;
			reject: (error: Error) => void;
			type: string;
			createdAt: number;
			warned?: boolean;
		}
	> = new Map();
	private requestId = 0;
	private slowRequestSweep: ReturnType<typeof setInterval> | null = null;
	private stderr = "";
	private exitError: Error | null = null;
	private options: RpcClientOptions;

	constructor(options: RpcClientOptions = {}) {
		this.options = options;
	}

	/**
	 * Start the RPC agent process.
	 */
	async start(): Promise<void> {
		if (this.process) {
			throw new Error("Client already started");
		}

		this.exitError = null;

		const cliPath = this.options.cliPath ?? "dist/cli.js";
		const args = ["--mode", "rpc"];

		if (this.options.provider) {
			args.push("--provider", this.options.provider);
		}
		if (this.options.model) {
			args.push("--model", this.options.model);
		}
		if (this.options.args) {
			args.push(...this.options.args);
		}

		const childProcess = spawn(this.options.execPath ?? "node", [cliPath, ...args], {
			cwd: this.options.cwd,
			// An explicit `undefined` value deletes an inherited variable rather
			// than setting it, so a host can strip ambient variables it does not
			// want the agent to see instead of only adding to them.
			env: Object.fromEntries(
				Object.entries({ ...process.env, ...this.options.env }).filter(
					(entry): entry is [string, string] => entry[1] !== undefined,
				),
			),
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.process = childProcess;

		// Collect stderr for debugging
		childProcess.stderr?.on("data", (data) => {
			this.stderr += data.toString();
			process.stderr.write(data);
		});

		childProcess.once("exit", (code, signal) => {
			if (this.process !== childProcess) return;
			const error = this.createProcessExitError(code, signal);
			this.exitError = error;
			this.rejectPendingRequests(error);
			for (const listener of this.exitListeners) listener({ code, signal: signal ?? null });
		});
		childProcess.once("error", (error) => {
			if (this.process !== childProcess) return;
			const processError = new Error(`Agent process error: ${error.message}. Stderr: ${this.stderr}`);
			this.exitError = processError;
			this.rejectPendingRequests(processError);
		});
		childProcess.stdin?.on("error", (error) => {
			if (this.process !== childProcess) return;
			const stdinError =
				this.exitError ?? new Error(`Agent process stdin error: ${error.message}. Stderr: ${this.stderr}`);
			this.exitError = stdinError;
			this.rejectPendingRequests(stdinError);
		});

		// Set up strict JSONL reader for stdout.
		this.stopReadingStdout = attachJsonlLineReader(childProcess.stdout!, (line) => {
			this.handleLine(line);
		});

		// The stuck-detector: a request pending for over a minute names itself
		// once, before its own timeout turns it into an anonymous failure.
		this.slowRequestSweep = setInterval(() => {
			const now = Date.now();
			for (const [id, pending] of this.pendingRequests) {
				if (pending.warned || now - pending.createdAt < SLOW_REQUEST_WARN_MS) continue;
				pending.warned = true;
				this.diagnostic(
					`[rpc-client] still waiting on ${pending.type} (${id}) after ${Math.round((now - pending.createdAt) / 1000)}s (agent pid ${childProcess.pid})`,
				);
			}
		}, 30_000);
		this.slowRequestSweep.unref?.();

		// Wait a moment for process to initialize
		await new Promise((resolve) => setTimeout(resolve, 100));

		if (this.process.exitCode !== null) {
			const error = this.exitError ?? this.createProcessExitError(this.process.exitCode, this.process.signalCode);
			this.exitError = error;
			throw error;
		}
	}

	/**
	 * Stop the RPC agent process.
	 */
	async stop(): Promise<void> {
		if (!this.process) return;

		if (this.slowRequestSweep) clearInterval(this.slowRequestSweep);
		this.slowRequestSweep = null;
		this.stopReadingStdout?.();
		this.stopReadingStdout = null;
		this.process.kill("SIGTERM");

		// Wait for process to exit
		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				this.process?.kill("SIGKILL");
				resolve();
			}, 1000);

			this.process?.on("exit", () => {
				clearTimeout(timeout);
				resolve();
			});
		});

		this.process = null;
		this.pendingRequests.clear();
	}

	/**
	 * Subscribe to agent events.
	 */
	onEvent(listener: RpcEventListener): () => void {
		this.eventListeners.push(listener);
		return () => {
			const index = this.eventListeners.indexOf(listener);
			if (index !== -1) {
				this.eventListeners.splice(index, 1);
			}
		};
	}

	/** The agent process's OS pid, while it is running. */
	get pid(): number | undefined {
		return this.process?.pid;
	}

	/** Called once when the agent process exits, for any reason. */
	onExit(listener: (info: { code: number | null; signal: string | null }) => void): () => void {
		this.exitListeners.push(listener);
		return () => {
			const index = this.exitListeners.indexOf(listener);
			if (index !== -1) {
				this.exitListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Get collected stderr output (useful for debugging).
	 */
	getStderr(): string {
		return this.stderr;
	}

	// =========================================================================
	// Command Methods
	// =========================================================================

	/**
	 * Send a prompt to the agent.
	 * Returns immediately after sending; use onEvent() to receive streaming events.
	 * Use waitForIdle() to wait for completion.
	 */
	async prompt(message: string, images?: ImageContent[], streamingBehavior?: "steer" | "followUp"): Promise<void> {
		// streamingBehavior makes the call safe in either agent state: idle
		// starts a turn, streaming queues per the behavior — decided in the
		// agent process, so a client's possibly-stale view of streaming can
		// never route a message somewhere nothing reads.
		await this.send({ type: "prompt", message, images, streamingBehavior });
	}

	/**
	 * Queue a steering message to interrupt the agent mid-run.
	 */
	async steer(message: string, images?: ImageContent[]): Promise<void> {
		await this.send({ type: "steer", message, images });
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 */
	async followUp(message: string, images?: ImageContent[]): Promise<void> {
		await this.send({ type: "follow_up", message, images });
	}

	/**
	 * Abort current operation.
	 */
	async abort(): Promise<void> {
		await this.send({ type: "abort" });
	}

	/**
	 * Clear queued steering and follow-up messages, returning their text.
	 */
	async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
		const response = await this.send({ type: "clear_queue" });
		return this.getData(response);
	}

	/**
	 * Start a new session, optionally with parent tracking.
	 * @param parentSession - Optional parent session path for lineage tracking
	 * @returns Object with `cancelled: true` if an extension cancelled the new session
	 */
	async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "new_session", parentSession });
		return this.getData(response);
	}

	/**
	 * Get current session state.
	 */
	async getState(): Promise<RpcSessionState> {
		const response = await this.send({ type: "get_state" });
		return this.getData(response);
	}

	/**
	 * Set model by provider and ID.
	 * With persist, the choice also becomes the global default — the same
	 * settings.json write the interactive selector makes.
	 */
	async setModel(provider: string, modelId: string, persist?: boolean): Promise<{ provider: string; id: string }> {
		const response = await this.send({ type: "set_model", provider, modelId, persist });
		return this.getData(response);
	}

	/**
	 * Cycle to next model.
	 */
	async cycleModel(): Promise<{
		model: { provider: string; id: string };
		thinkingLevel: ThinkingLevel;
		isScoped: boolean;
	} | null> {
		const response = await this.send({ type: "cycle_model" });
		return this.getData(response);
	}

	/**
	 * Get list of available models.
	 */
	async getAvailableModels(): Promise<ModelInfo[]> {
		const response = await this.send({ type: "get_available_models" });
		return this.getData<{ models: ModelInfo[] }>(response).models;
	}

	/**
	 * Set thinking level. With persist, it also becomes the global default.
	 */
	async setThinkingLevel(level: ThinkingLevel, persist?: boolean): Promise<void> {
		await this.send({ type: "set_thinking_level", level, persist });
	}

	/**
	 * Cycle thinking level.
	 */
	async cycleThinkingLevel(): Promise<{ level: ThinkingLevel } | null> {
		const response = await this.send({ type: "cycle_thinking_level" });
		return this.getData(response);
	}

	/**
	 * Get list of available thinking levels for the current model.
	 */
	async getAvailableThinkingLevels(): Promise<ThinkingLevel[]> {
		const response = await this.send({ type: "get_available_thinking_levels" });
		return this.getData<{ levels: ThinkingLevel[] }>(response).levels;
	}

	/**
	 * Set steering mode.
	 */
	async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.send({ type: "set_steering_mode", mode });
	}

	/**
	 * Set follow-up mode.
	 */
	async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.send({ type: "set_follow_up_mode", mode });
	}

	/**
	 * Compact session context.
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		const response = await this.send({ type: "compact", customInstructions });
		return this.getData(response);
	}

	/**
	 * Set auto-compaction enabled/disabled.
	 */
	async setAutoCompaction(enabled: boolean): Promise<void> {
		await this.send({ type: "set_auto_compaction", enabled });
	}

	/**
	 * Set auto-retry enabled/disabled.
	 */
	async setAutoRetry(enabled: boolean): Promise<void> {
		await this.send({ type: "set_auto_retry", enabled });
	}

	/**
	 * Every extension this install knows about, switched on or off.
	 */
	async listExtensions(): Promise<{ extensions: RpcExtensionInfo[] }> {
		const response = await this.send({ type: "list_extensions" });
		return this.getData(response);
	}

	/**
	 * Switch one extension on or off. Takes effect on the next session start.
	 */
	async setExtensionEnabled(extensionId: string, enabled: boolean): Promise<void> {
		await this.send({ type: "set_extension_enabled", extensionId, enabled });
	}

	/**
	 * Abort in-progress retry.
	 */
	async abortRetry(): Promise<void> {
		await this.send({ type: "abort_retry" });
	}

	/**
	 * Execute a bash command.
	 */
	async bash(command: string): Promise<BashResult> {
		const response = await this.send({ type: "bash", command });
		return this.getData(response);
	}

	/**
	 * Abort running bash command.
	 */
	async abortBash(): Promise<void> {
		await this.send({ type: "abort_bash" });
	}

	/**
	 * Get session statistics.
	 */
	async getSessionStats(): Promise<SessionStats> {
		const response = await this.send({ type: "get_session_stats" });
		return this.getData(response);
	}

	/**
	 * Export session to HTML.
	 */
	async exportHtml(outputPath?: string): Promise<{ path: string }> {
		const response = await this.send({ type: "export_html", outputPath });
		return this.getData(response);
	}

	/**
	 * Switch to a different session file.
	 * @returns Object with `cancelled: true` if an extension cancelled the switch
	 */
	async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "switch_session", sessionPath });
		return this.getData(response);
	}

	/**
	 * Fork from a specific message.
	 * @returns Object with `text` (the message text) and `cancelled` (if extension cancelled)
	 */
	async fork(entryId: string): Promise<{ text: string; cancelled: boolean }> {
		const response = await this.send({ type: "fork", entryId });
		return this.getData(response);
	}

	/**
	 * Clone the current active branch into a new session.
	 * @returns Object with `cancelled: true` if an extension cancelled the clone
	 */
	async clone(): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "clone" });
		return this.getData(response);
	}

	/**
	 * Get messages available for forking.
	 */
	async getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
		const response = await this.send({ type: "get_fork_messages" });
		return this.getData<{ messages: Array<{ entryId: string; text: string }> }>(response).messages;
	}

	/**
	 * Get session entries in append order, optionally only those after the `since` entry id.
	 */
	async getEntries(since?: string): Promise<{ entries: SessionEntry[]; leafId: string | null }> {
		const response = await this.send({ type: "get_entries", since });
		return this.getData<{ entries: SessionEntry[]; leafId: string | null }>(response);
	}

	/**
	 * Get the session entry tree.
	 */
	async getTree(): Promise<{ tree: SessionTreeNode[]; leafId: string | null }> {
		const response = await this.send({ type: "get_tree" });
		return this.getData<{ tree: SessionTreeNode[]; leafId: string | null }>(response);
	}

	/**
	 * Get text of last assistant message.
	 */
	async getLastAssistantText(): Promise<string | null> {
		const response = await this.send({ type: "get_last_assistant_text" });
		return this.getData<{ text: string | null }>(response).text;
	}

	/**
	 * Set the session display name.
	 */
	async setSessionName(name: string): Promise<void> {
		await this.send({ type: "set_session_name", name });
	}

	/**
	 * Get all messages in the session.
	 */
	async getMessages(): Promise<AgentMessage[]> {
		const response = await this.send({ type: "get_messages" });
		return this.getData<{ messages: AgentMessage[] }>(response).messages;
	}

	/**
	 * Get available commands (extension commands, prompt templates, skills).
	 */
	async getCommands(): Promise<RpcSlashCommand[]> {
		const response = await this.send({ type: "get_commands" });
		return this.getData<{ commands: RpcSlashCommand[] }>(response).commands;
	}

	// =========================================================================
	// Helpers
	// =========================================================================

	/**
	 * Wait for agent to become idle (no streaming).
	 * Resolves when agent_settled event is received.
	 */
	waitForIdle(timeout = 60000): Promise<void> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				unsubscribe();
				reject(new Error(`Timeout waiting for agent to become idle. Stderr: ${this.stderr}`));
			}, timeout);

			const unsubscribe = this.onEvent((event) => {
				if (event.type === "agent_settled") {
					clearTimeout(timer);
					unsubscribe();
					resolve();
				}
			});
		});
	}

	/**
	 * Collect events until agent becomes idle.
	 */
	collectEvents(timeout = 60000): Promise<JsonAgentSessionEvent[]> {
		return new Promise((resolve, reject) => {
			const events: JsonAgentSessionEvent[] = [];
			const timer = setTimeout(() => {
				unsubscribe();
				reject(new Error(`Timeout collecting events. Stderr: ${this.stderr}`));
			}, timeout);

			const unsubscribe = this.onEvent((event) => {
				events.push(event);
				if (event.type === "agent_settled") {
					clearTimeout(timer);
					unsubscribe();
					resolve(events);
				}
			});
		});
	}

	/**
	 * Send prompt and wait for completion, returning all events.
	 */
	async promptAndWait(message: string, images?: ImageContent[], timeout = 60000): Promise<JsonAgentSessionEvent[]> {
		const eventsPromise = this.collectEvents(timeout);
		await this.prompt(message, images);
		return eventsPromise;
	}

	// =========================================================================
	// Internal
	// =========================================================================

	private handleLine(line: string): void {
		try {
			const data = JSON.parse(line);

			// Check if it's a response to a pending request
			if (data.type === "response" && data.id && this.pendingRequests.has(data.id)) {
				const pending = this.pendingRequests.get(data.id)!;
				this.pendingRequests.delete(data.id);
				pending.resolve(data as RpcResponse);
				return;
			}

			// Otherwise it's an event
			for (const listener of this.eventListeners) {
				listener(data as JsonAgentSessionEvent);
			}
		} catch {
			// Ignore non-JSON lines
		}
	}

	private createProcessExitError(code: number | null, signal: NodeJS.Signals | null): Error {
		// A person reads this in an error card: say what happened in words,
		// and only append the parts that carry information — "code=null
		// signal=SIGTERM. Stderr:" with a dangling nothing helped no one.
		const how =
			signal !== null
				? `was stopped by signal ${signal}`
				: code === 0
					? "exited normally"
					: `crashed with exit code ${code}`;
		const stderr = this.stderr.trim();
		return new Error(`The agent process ${how}.${stderr !== "" ? ` Last output:\n${stderr}` : ""}`);
	}

	private diagnostic(line: string): void {
		if (this.options.onDiagnostic) {
			this.options.onDiagnostic(line);
			return;
		}
		process.stderr.write(`${line}\n`);
	}

	private rejectPendingRequests(error: Error): void {
		for (const pending of this.pendingRequests.values()) {
			pending.reject(error);
		}
		this.pendingRequests.clear();
	}

	/**
	 * Answer an extension_ui_request event (select / confirm / input / editor).
	 * Fire-and-forget: the agent matches the response by the request id and
	 * sends nothing back.
	 */
	respondExtensionUI(response: { id: string; value?: string; confirmed?: boolean; cancelled?: boolean }): void {
		const stdin = this.process?.stdin;
		if (!stdin || stdin.destroyed || !stdin.writable) return;
		const body: Record<string, unknown> = { type: "extension_ui_response", id: response.id };
		if (response.cancelled === true) body.cancelled = true;
		else if (response.value !== undefined) body.value = response.value;
		else body.confirmed = response.confirmed === true;
		stdin.write(serializeJsonLine(body));
	}

	private async send(command: RpcCommandBody): Promise<RpcResponse> {
		const childProcess = this.process;
		const stdin = childProcess?.stdin;
		if (!childProcess || !stdin) {
			throw new Error("Client not started");
		}
		if (this.exitError) {
			throw this.exitError;
		}
		if (childProcess.exitCode !== null) {
			const error = this.createProcessExitError(childProcess.exitCode, childProcess.signalCode);
			this.exitError = error;
			throw error;
		}
		if (stdin.destroyed || !stdin.writable) {
			const error = new Error(`Agent process stdin is not writable. Stderr: ${this.stderr}`);
			this.exitError = error;
			throw error;
		}

		const id = `req_${++this.requestId}`;
		const fullCommand = { ...command, id } as RpcCommand;

		const timeoutMs = RPC_TIMEOUT_MS[command.type] ?? RPC_DEFAULT_TIMEOUT_MS;
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pendingRequests.delete(id);
				this.diagnostic(`[rpc-client] gave up on ${command.type} (${id}) after ${Math.round(timeoutMs / 1000)}s`);
				reject(new Error(`Timeout waiting for response to ${command.type}. Stderr: ${this.stderr}`));
			}, timeoutMs);

			this.pendingRequests.set(id, {
				resolve: (response) => {
					clearTimeout(timeout);
					resolve(response);
				},
				reject: (error) => {
					clearTimeout(timeout);
					reject(error);
				},
				type: command.type,
				createdAt: Date.now(),
			});

			try {
				stdin.write(serializeJsonLine(fullCommand));
			} catch (error: unknown) {
				const writeError = error instanceof Error ? error : new Error(String(error));
				const pending = this.pendingRequests.get(id);
				this.pendingRequests.delete(id);
				pending?.reject(writeError);
			}
		});
	}

	private getData<T>(response: RpcResponse): T {
		if (!response.success) {
			const errorResponse = response as Extract<RpcResponse, { success: false }>;
			throw new Error(errorResponse.error);
		}
		// Type assertion: we trust response.data matches T based on the command sent.
		// This is safe because each public method specifies the correct T for its command.
		const successResponse = response as Extract<RpcResponse, { success: true; data: unknown }>;
		return successResponse.data as T;
	}
}
