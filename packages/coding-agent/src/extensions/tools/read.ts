import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createReadToolDefinition, type ReadToolOptions } from "../../core/tools/read.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "../../core/tools/truncate.ts";

/**
 * The built-in read tells the model that output is capped and that it
 * should "continue with offset until complete" — the only sizing advice it
 * gets, and it points at the whole file. This definition is the built-in
 * with that guidance inverted: when you already know which part of the file
 * you need, only read that part. Everything the tool does is inherited.
 *
 * An optional first look — an unranged read returning only the first N
 * lines — measured well on a small model (whole-file reads 4/5 -> 0/5) but
 * is a stricter cap than the default, so it is off unless configured.
 */

export function readDescription(firstLookLines?: number): string {
	const sizing =
		firstLookLines === undefined
			? `Output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). `
			: `A read with no range returns the first ${firstLookLines} lines and says how many remain; a read with offset or limit returns up to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB. `;
	return (
		"Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. " +
		"When you already know which part of the file you need, only read that part: pass offset and limit. " +
		sizing +
		"Continue with offset only when the rest is actually needed."
	);
}

export const READ_DESCRIPTION = readDescription();

export const READ_GUIDELINES: readonly string[] = [
	"Use read to examine files instead of cat or sed. When you already know which part of the file you need, only read that part (offset and limit); read a whole file only when the task needs all of it.",
];

type ReadDefinition = ReturnType<typeof createReadToolDefinition>;

/** The built-in's continuation note when a limit stops short of the file's end. */
const CONTINUE_NOTE = /\[(\d+) more lines in file\. Use offset=(\d+) to continue\.\]$/;

/**
 * The built-in binds its cwd at construction and an extension factory has
 * none; every tool call carries one on its context instead. Only execute
 * consumes the cwd — parameters and renderers are cwd-free — so the bound
 * definition is built on first use and kept while the cwd holds.
 */
export function createTargetedReadToolDefinition(
	optionsFor: (cwd: string) => ReadToolOptions = () => ({}),
	firstLookLines?: number,
): ReadDefinition {
	let bound: { cwd: string; definition: ReadDefinition } | undefined;
	const forCwd = (cwd: string): ReadDefinition => {
		if (bound?.cwd !== cwd) {
			bound = { cwd, definition: createReadToolDefinition(cwd, optionsFor(cwd)) };
		}
		return bound.definition;
	};

	return {
		...createReadToolDefinition(""),
		description: readDescription(firstLookLines),
		promptGuidelines: [...READ_GUIDELINES],
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const firstLook = firstLookLines !== undefined && params.offset === undefined && params.limit === undefined;
			const ranged = firstLook ? { ...params, limit: firstLookLines } : params;
			const result = await forCwd(ctx.cwd).execute(toolCallId, ranged, signal, onUpdate, ctx);
			if (!firstLook) return result;
			// The model asked for nothing in particular and got a first look;
			// say so, and name the cheaper way to the rest than paging through it.
			return {
				...result,
				content: result.content.map((block) =>
					block.type === "text" && CONTINUE_NOTE.test(block.text)
						? {
								...block,
								text: block.text.replace(
									CONTINUE_NOTE,
									`[First ${firstLookLines} lines shown; $1 more in file. Use offset=$2 to continue, or search with rg and read just the range you need.]`,
								),
							}
						: block,
				),
			};
		},
	};
}

/**
 * Core hands the built-in read the `images.autoResize` setting; an extension
 * has no settings handle, so this reads the same files the same way — project
 * settings over global, default on.
 */
export function readImageAutoResize(cwd: string, agentDir: string): boolean {
	const project = readAutoResize(join(cwd, ".smolt", "settings.json"));
	if (project !== undefined) return project;
	return readAutoResize(join(agentDir, "settings.json")) ?? true;
}

function readAutoResize(settingsPath: string): boolean | undefined {
	try {
		if (!existsSync(settingsPath)) return undefined;
		const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as { images?: { autoResize?: unknown } };
		const value = parsed.images?.autoResize;
		return typeof value === "boolean" ? value : undefined;
	} catch {
		// An unreadable settings file is not a reason to change how images are read.
		return undefined;
	}
}
