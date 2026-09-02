import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
// Type-only import: a standalone install of this module outside the smolt
// tree switches this single line to `from "smolt"`.
import type { ExtensionAPI, ToolDefinition } from "../../core/extensions/types.ts";
import { createReadToolDefinition, type ReadToolDetails } from "../../core/tools/read.ts";
import { applyOutputBudget, DEFAULT_OUTPUT_TOKEN_LIMIT } from "./budget.ts";
import { createTargetedReadToolDefinition, readImageAutoResize } from "./read.ts";

/**
 * Tools: the built-in tools with leaner habits.
 *
 * Reading code efficiently is less a matter of the read tool than of three
 * things around it: a single token budget applied to every tool result at
 * the boundary where it enters history (10,000 tokens, middle truncated
 * behind a marker that says how much was cut); a handful of prompt lines
 * about searching with rg, parallel reads and not re-reading after edits;
 * and, optionally, no read tool at all — files are read with shell commands
 * and only images need a tool, view_image.
 *
 * Config: `~/.smolt/agent/tools.json` —
 * `{ "read": "tool" | "shell", "outputTokenLimit": 10000, "firstLookLines": null }`.
 */

export interface ToolsConfig {
	/** "tool": the read tool, with narrower guidance. "shell": no read tool; files are read with shell commands. */
	read: "tool" | "shell";
	/** Token budget for every tool result. Default 10,000. */
	outputTokenLimit: number;
	/** Lines an unranged read returns before asking for a range. Off unless set. */
	firstLookLines?: number;
}

export const DEFAULT_TOOLS_CONFIG: ToolsConfig = {
	read: "tool",
	outputTokenLimit: DEFAULT_OUTPUT_TOKEN_LIMIT,
};

export function readToolsConfig(configPath: string | undefined): ToolsConfig {
	const config = { ...DEFAULT_TOOLS_CONFIG };
	if (!configPath) return config;
	try {
		if (!existsSync(configPath)) return config;
		const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as Partial<ToolsConfig>;
		if (parsed.read === "tool" || parsed.read === "shell") config.read = parsed.read;
		if (typeof parsed.outputTokenLimit === "number" && parsed.outputTokenLimit > 0) {
			config.outputTokenLimit = Math.floor(parsed.outputTokenLimit);
		}
		if (typeof parsed.firstLookLines === "number" && parsed.firstLookLines > 0) {
			config.firstLookLines = Math.floor(parsed.firstLookLines);
		}
	} catch {
		// A malformed config is not a reason to change how tools behave.
	}
	return config;
}

/** The habits as prompt lines, with the shell-only reading habit spelled out. */
export function toolHabitsPrompt(config: ToolsConfig): string {
	const lines = [
		`Every tool result is capped at ${config.outputTokenLimit} tokens; when one is cut, the head and tail are kept and a marker says how many tokens were dropped.`,
		"When searching for text or files, prefer rg or rg --files over grep or find: rg is much faster. If rg is not found, use alternatives.",
		"Do not use python scripts to attempt to output larger chunks of a file.",
		"Parallelize tool calls whenever possible, especially file reads (cat, rg, sed, ls, git show, nl, wc).",
		"Do not waste tokens by re-reading files after editing them; the edit fails if it did not apply.",
		"Don't dump large files or command output into your answer; reference paths and summarise the key lines.",
	];
	if (config.read === "shell") {
		lines.push(
			"There is no read tool. Read files with shell commands: sed -n 'START,ENDp' FILE for a range, nl -ba FILE | sed -n 'START,ENDp' for numbered lines, cat only for small files. Find the range with rg -n first. Use view_image for images.",
		);
	}
	return `Working with files and tool output:\n${lines.map((line) => `- ${line}`).join("\n")}`;
}

const viewImageSchema = Type.Object({
	path: Type.String({ description: "Path to the image file (relative or absolute)" }),
});

/** view_image: the one file operation a shell cannot do is attach an image. */
export function createViewImageToolDefinition(
	autoResizeFor: (cwd: string) => boolean,
): ToolDefinition<typeof viewImageSchema, ReadToolDetails | undefined> {
	const base = createReadToolDefinition("");
	let bound: { cwd: string; definition: ReturnType<typeof createReadToolDefinition> } | undefined;
	const forCwd = (cwd: string) => {
		if (bound?.cwd !== cwd) {
			bound = { cwd, definition: createReadToolDefinition(cwd, { autoResizeImages: autoResizeFor(cwd) }) };
		}
		return bound.definition;
	};
	return {
		...base,
		name: "view_image",
		label: "view image",
		description:
			"Attach a local image (jpg, png, gif, webp, bmp) to the conversation so you can see it. Text files are read with shell commands, not this tool.",
		promptSnippet: "View an image file",
		promptGuidelines: [],
		parameters: viewImageSchema,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const result = await forCwd(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
			const isImage = result.content.some(
				(block) => block.type === "image" || (block.type === "text" && block.text.startsWith("Read image file")),
			);
			if (isImage) return result;
			return {
				content: [
					{ type: "text" as const, text: `${params.path} is not an image. Read text files with shell commands.` },
				],
				details: undefined,
			};
		},
	};
}

const CONFIG_DIR_NAME = ".smolt";

function agentDir(): string {
	const envDir = process.env.SMOLT_CODING_AGENT_DIR;
	if (envDir) {
		return envDir.startsWith("~") ? join(homedir(), envDir.slice(1)) : envDir;
	}
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

export function createToolsExtension(smolt: ExtensionAPI, config: ToolsConfig): void {
	const autoResizeFor = (cwd: string) => readImageAutoResize(cwd, agentDir());

	smolt.registerTool(
		createTargetedReadToolDefinition((cwd) => ({ autoResizeImages: autoResizeFor(cwd) }), config.firstLookLines),
	);
	if (config.read === "shell") {
		smolt.registerTool(createViewImageToolDefinition(autoResizeFor));
		// The read tool is registered so its slot is ours, then switched off:
		// files are read with the shell, and only images need a tool.
		smolt.on("session_start", async () => {
			smolt.setActiveTools(smolt.getActiveTools().filter((name) => name !== "read"));
		});
	}

	// The boundary: every result is cut to the budget as it enters history.
	smolt.on("tool_result", async (event) => {
		if (event.isError) return;
		const content = applyOutputBudget(event.content, config.outputTokenLimit);
		return content ? { content } : undefined;
	});

	smolt.on("before_agent_start", async (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${toolHabitsPrompt(config)}`,
	}));
}

export default function toolsExtension(smolt: ExtensionAPI): void {
	createToolsExtension(smolt, readToolsConfig(join(agentDir(), "tools.json")));
}
