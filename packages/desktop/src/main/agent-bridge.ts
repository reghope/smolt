import { existsSync } from "node:fs";
import { join } from "node:path";
import { RpcClient } from "../../../coding-agent/src/modes/rpc/rpc-client.ts";

/**
 * Bridges the renderer to a smolt agent subprocess running in RPC mode.
 *
 * The renderer sends `{ method, args }` requests over IPC; only methods in
 * ALLOWED_METHODS are dispatched, so the renderer cannot invoke arbitrary
 * main-process code. Agent events are forwarded verbatim to the renderer.
 */

const ALLOWED_METHODS = new Set([
	"prompt",
	"steer",
	"followUp",
	"abort",
	"clearQueue",
	"newSession",
	"getState",
	"setModel",
	"cycleModel",
	"getAvailableModels",
	"setThinkingLevel",
	"cycleThinkingLevel",
	"getAvailableThinkingLevels",
	"setSteeringMode",
	"setFollowUpMode",
	"bash",
	"abortBash",
	"compact",
	"setAutoCompaction",
	"setAutoRetry",
	"abortRetry",
	"getSessionStats",
	"exportHtml",
	"switchSession",
	"getMessages",
	"getCommands",
	"setSessionName",
	"clone",
	"fork",
	"getForkMessages",
	"respondExtensionUI",
]);

export interface BridgeOptions {
	cwd?: string;
	provider?: string;
	model?: string;
	/** Explicit path to the smolt CLI entry (overrides discovery). */
	cliPath?: string;
	/** Extra CLI args (e.g. --continue). */
	args?: string[];
	/** Extra environment for the agent process (e.g. SMOLT_TELEGRAM_POLL). */
	env?: Record<string, string>;
}

/** Locate the workspace CLI build relative to the desktop package. */
export function findCliPath(appDir: string, explicit?: string): string | undefined {
	const candidates = [
		explicit,
		process.env.SMOLT_CLI_PATH,
		join(appDir, "..", "..", "coding-agent", "dist", "cli.js"),
		join(appDir, "..", "node_modules", "@smolt", "coding-agent", "dist", "cli.js"),
	].filter((candidate): candidate is string => !!candidate);
	return candidates.find((candidate) => existsSync(candidate));
}

export class AgentBridge {
	private client: RpcClient | null = null;
	private listeners: ((event: unknown) => void)[] = [];
	private startError: string | null = null;

	async start(options: BridgeOptions, appDir: string): Promise<void> {
		const cliPath = findCliPath(appDir, options.cliPath);
		if (!cliPath) {
			this.startError = "smolt CLI not found. Build the workspace (npm run build:offline) or set SMOLT_CLI_PATH.";
			return;
		}
		try {
			const client = new RpcClient({
				cliPath,
				cwd: options.cwd,
				provider: options.provider,
				model: options.model,
				args: options.args,
				env: options.env,
			});
			client.onEvent((event) => {
				for (const listener of this.listeners) listener(event);
			});
			await client.start();
			this.client = client;
			this.startError = null;
		} catch (e) {
			this.startError = e instanceof Error ? e.message : String(e);
		}
	}

	onEvent(listener: (event: unknown) => void): void {
		this.listeners.push(listener);
	}

	get status(): { running: boolean; error: string | null } {
		return { running: this.client !== null, error: this.startError };
	}

	async call(method: string, args: unknown[]): Promise<unknown> {
		if (!ALLOWED_METHODS.has(method)) {
			throw new Error(`Method not allowed: ${method}`);
		}
		if (!this.client) {
			throw new Error(this.startError ?? "Agent not running");
		}
		const fn = (this.client as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method];
		if (typeof fn !== "function") {
			throw new Error(`Unknown method: ${method}`);
		}
		return await fn.apply(this.client, args);
	}

	async stop(): Promise<void> {
		if (this.client) {
			await this.client.stop();
			this.client = null;
		}
	}
}
