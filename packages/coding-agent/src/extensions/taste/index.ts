import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { Type } from "typebox";
import { getTasteDoctrineDir } from "../../config.ts";
// Type-only import: a standalone install of this module outside the smolt
// tree switches this single line to `from "smolt"`.
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { isReadOnlyCommand } from "../permissions/index.ts";
import { BROWSER_CHECKS, type CheckResult, checkFile, summarizeFile } from "./checks.ts";
import { isDesignPrompt, isUiPath, uiPathsInCommand } from "./trigger.ts";

/**
 * Taste: design doctrine that arrives on its own, and a finish it can refuse.
 *
 * A skill is passive — it waits to be invoked, and the turn that most needed
 * it is the turn nobody thought to invoke it on. This does two things a skill
 * cannot. It arms itself: any prompt that reads as design work puts the whole
 * doctrine into the system prompt for the rest of the session. And it holds a
 * gate: a session that wrote files which render, and never reviewed them,
 * does not get to end quietly. The agent is sent back with the checklist.
 *
 * The gate is honest about what it knows. Rules a machine can settle — an
 * em-dash is present or it is not — are computed from the files themselves
 * and can fail a review the model claimed had passed. Rules that need
 * judgment stay with the model, which must answer them with evidence. Rules
 * that need a browser are recorded as skips, never as passes.
 */

/** How many times the gate re-sends the agent back before it gives up. */
const MAX_BITES = 2;

interface TasteConfig {
	enabled: boolean;
	/** Extra project paths that count as UI, as simple globs. */
	extraGlobs: string[];
	/** Checklist ids the project has deliberately waived. */
	checklistWaivers: string[];
}

const DEFAULT_CONFIG: TasteConfig = { enabled: true, extraGlobs: [], checklistWaivers: [] };

function readConfig(cwd: string): TasteConfig {
	const files = [join(homedir(), ".smolt", "agent", "taste.json"), join(cwd, ".smolt", "taste.json")];
	let config = { ...DEFAULT_CONFIG };
	for (const file of files) {
		try {
			if (!existsSync(file)) continue;
			const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<TasteConfig>;
			config = {
				enabled: parsed.enabled ?? config.enabled,
				extraGlobs: parsed.extraGlobs ?? config.extraGlobs,
				checklistWaivers: parsed.checklistWaivers ?? config.checklistWaivers,
			};
		} catch {
			// A malformed config is not a reason to stop enforcing taste.
		}
	}
	return config;
}

/** The doctrine, read once and held: it is the same bytes every turn. */
function readDoctrine(directory: string): string {
	const parts: string[] = [];
	for (const name of ["taste-skill.md", "dense-ui.md"]) {
		try {
			parts.push(readFileSync(join(directory, name), "utf-8"));
		} catch {
			// A missing file degrades to less doctrine, never to a crash.
		}
	}
	if (parts.length === 0) return "";
	return [
		"# Design doctrine (in force for this session)",
		"",
		"Design work has been detected, so the full doctrine below applies to everything visual you produce",
		"this session. It is not a summary and must not be treated as one. Its final pre-flight check is a",
		"gate: files you write that render are reviewed with the taste_review tool before this session can",
		"end. Vendored from github.com/Leonxlnx/taste-skill (MIT), plus this project's dense-UI supplement.",
		"",
		...parts,
	].join("\n");
}

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
}

/** The follow-up that sends the agent back to review what it wrote. */
function gatePrompt(paths: string[]): string {
	const list = paths.map((path) => `- ${path}`).join("\n");
	return `[taste gate] This session wrote ${paths.length} file${paths.length === 1 ? "" : "s"} that render, and has not reviewed them:

${list}

Call taste_review with those paths. It returns the mechanical results plus the pre-flight checklist. Answer every checklist item PASS, FAIL or SKIP with one line of evidence each — a claim without evidence is a FAIL. Fix everything that fails, then run taste_review again. Repeat until it passes, and only then finish.

Do not argue the gate down. If a check genuinely does not apply to these files, mark it SKIP and say why in one line.`;
}

export default function tasteExtension(smolt: ExtensionAPI): void {
	createTasteExtension(smolt, getTasteDoctrineDir());
}

export interface TasteHandle {
	armed(): boolean;
	pending(): string[];
}

export function createTasteExtension(smolt: ExtensionAPI, doctrineDir: string): TasteHandle {
	let config = { ...DEFAULT_CONFIG };
	let doctrine = "";
	/**
	 * Sticky by design. A design session interleaves logic turns, and dropping
	 * the doctrine for those would be serving it in slices — which is the thing
	 * that damages results. Once armed, armed for the session.
	 */
	let armed = false;
	/** Turned off for this session by /taste off; tracking continues underneath. */
	let disabled = false;
	/** UI files written since the last passing review. */
	const touched = new Set<string>();
	/** Shell calls in flight: UI paths a command mentioned, with their pre-run
	 * stat signatures, awaiting the result that proves the command changed them. */
	const shellCandidates = new Map<string, { path: string; signature: string | undefined }[]>();
	/** Times the gate has sent the agent back for the current set. */
	let bites = 0;
	/** The gate started the run now settling, so its result is the review. */
	let gateRun = false;
	/** The run now settling was aborted by the user; Stop means stop. */
	let lastRunAborted = false;

	const paint = (ctx: ExtensionContext): void => {
		if (!armed || disabled) {
			ctx.ui.setStatus("taste", undefined);
			ctx.ui.setWidget("taste", undefined);
			return;
		}
		ctx.ui.setStatus("taste", "taste: armed");
		if (touched.size === 0) {
			ctx.ui.setWidget("taste", undefined);
			return;
		}
		if (bites >= MAX_BITES) {
			ctx.ui.setWidget("taste", [
				`taste gate: BLOCKED — ${touched.size} file(s) unreviewed`,
				"/taste review | /taste off",
			]);
			return;
		}
		ctx.ui.setWidget("taste", [
			`taste gate: ${touched.size} file(s) awaiting review`,
			[...touched].slice(0, 3).join(", "),
		]);
	};

	const note = (path: string, cwd: string): void => {
		if (disabled) return;
		const relativePath = relative(cwd, resolve(cwd, path)).replaceAll("\\", "/");
		touched.add(relativePath === "" ? path : relativePath);
		// A file rewritten after a pass is unreviewed again; a passing review is
		// not a licence for the rest of the session.
		bites = 0;
	};

	smolt.on("session_start", async (_event, ctx) => {
		config = readConfig(ctx.cwd);
		doctrine = readDoctrine(doctrineDir);
		armed = false;
		disabled = !config.enabled;
		touched.clear();
		shellCandidates.clear();
		bites = 0;
		gateRun = false;
		paint(ctx);
	});

	smolt.on("input", async (event, ctx) => {
		// Messages the extension itself sent must not re-arm anything.
		if (event.source === "extension" || disabled || armed) return;
		const images = (event.images as unknown[] | undefined) ?? [];
		if (!isDesignPrompt(event.text, images.length > 0)) return;
		armed = true;
		paint(ctx);
	});

	smolt.on("before_agent_start", async (event) => {
		if (!armed || disabled || doctrine === "") return;
		return { systemPrompt: `${event.systemPrompt}\n\n${doctrine}` };
	});

	/** mtime plus size: coarse-mtime file systems still show a same-second
	 * rewrite when the byte count moves. Undefined means the file is absent. */
	const statSignatureOf = (path: string, cwd: string): string | undefined => {
		try {
			const stat = statSync(resolve(cwd, path));
			return `${stat.mtimeMs}:${stat.size}`;
		} catch {
			return undefined;
		}
	};

	// The gate counts only files this session actually changed. A write the
	// user denied, an edit whose old text was not found, or a shell command
	// that merely mentions a page — `git add index.html` — updated nothing,
	// and must not put that file on the review list. Tool calls therefore
	// only nominate candidates; the successful result confirms them, and for
	// shell commands the file system gets the final word via mtime.
	smolt.on("tool_call", async (event, ctx) => {
		if (disabled) return;
		if (event.toolName !== "bash" && event.toolName !== "powershell") return;
		const input = event.input as { command?: unknown };
		const command = typeof input.command === "string" ? input.command : "";
		// Only commands that can WRITE arm the gate. `ls *.html` and its
		// kin merely mention UI files, and counting those once put a bare
		// glob on the review list of a chat that had changed nothing.
		if (isReadOnlyCommand(command)) return;
		const candidates = uiPathsInCommand(command, ctx.cwd, config.extraGlobs).filter((path) => !path.includes("*"));
		if (candidates.length === 0) return;
		shellCandidates.set(
			event.toolCallId,
			candidates.map((path) => ({ path, signature: statSignatureOf(path, ctx.cwd) })),
		);
	});

	smolt.on("tool_result", async (event, ctx) => {
		if (event.toolName === "write" || event.toolName === "edit") {
			if (disabled || event.isError) return;
			const path = typeof event.input.path === "string" ? event.input.path : "";
			if (isUiPath(path, ctx.cwd, config.extraGlobs)) {
				note(path, ctx.cwd);
				paint(ctx);
			}
			return;
		}
		if (event.toolName === "bash" || event.toolName === "powershell") {
			const candidates = shellCandidates.get(event.toolCallId);
			shellCandidates.delete(event.toolCallId);
			if (disabled || event.isError || !candidates) return;
			let changed = false;
			for (const { path, signature } of candidates) {
				// Only files the command left changed on disk count: created where
				// there was nothing, or rewritten so the stat signature moved.
				const now = statSignatureOf(path, ctx.cwd);
				if (now === undefined || now === signature) continue;
				note(path, ctx.cwd);
				changed = true;
			}
			if (changed) paint(ctx);
		}
	});

	smolt.on("agent_end", async (event) => {
		const last = [...event.messages].reverse().find((message) => message.role === "assistant");
		lastRunAborted = (last as { stopReason?: string } | undefined)?.stopReason === "aborted";
	});

	smolt.on("agent_settled", async (_event, ctx) => {
		// A run that ended without results for calls in flight leaves stale
		// candidates; a settled agent has no shell command still running.
		shellCandidates.clear();
		const wasGateRun = gateRun;
		gateRun = false;
		paint(ctx);
		if (disabled || touched.size === 0) return;
		// The user pressed Stop: the whole conversation stops, gate included.
		// The files stay on the list; the next natural settle picks them up.
		if (lastRunAborted) return;
		if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
		if (ctx.hasPendingMessages()) return;
		if (bites >= MAX_BITES) {
			// The agent may legitimately be right that nothing needs fixing.
			// Stop pushing and leave the state where the user can see it.
			if (wasGateRun) ctx.ui.notify(`taste gate: ${touched.size} file(s) still unreviewed.`, "error");
			return;
		}
		bites += 1;
		gateRun = true;
		smolt.sendUserMessage(gatePrompt([...touched]));
	});

	smolt.registerTool({
		name: "taste_review",
		label: "Taste review",
		description:
			"Review files that render against the design doctrine's pre-flight check. Returns the mechanical " +
			"results computed from the files themselves, the checklist to answer, and the checks that need a " +
			"browser.\n\n" +
			"Pass 'files' (paths written this session) and, once you have judged them, 'verdict' with one " +
			"PASS/FAIL/SKIP line of evidence per checklist item. A review passes only when your verdict is " +
			"pass AND no mechanical check failed — an assertion cannot override what the files actually say.\n\n" +
			"WHEN: before finishing any session that wrote UI, and whenever the taste gate sends you back.",
		parameters: Type.Object({
			files: Type.Optional(
				Type.Array(Type.String(), {
					description: "Paths to review. Omit to review everything this session has written.",
				}),
			),
			verdict: Type.Optional(
				Type.Union([Type.Literal("pass"), Type.Literal("fail")], {
					description: "Your judgment after working through the checklist. Omit on the first call.",
				}),
			),
			findings: Type.Optional(
				Type.String({
					description: "One line per checklist item: PASS/FAIL/SKIP plus the evidence for it.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const paths = params.files && params.files.length > 0 ? params.files : [...touched];
			if (paths.length === 0) return textResult("Nothing to review: no files that render were written.");

			const reviewed: { path: string; results: CheckResult[]; error?: string }[] = [];
			for (const path of paths) {
				try {
					const text = readFileSync(resolve(ctx.cwd, path), "utf-8");
					reviewed.push({ path, results: checkFile(text) });
				} catch {
					reviewed.push({ path, results: [], error: "could not be read" });
				}
			}

			const mechanical = reviewed
				.map((file) => (file.error ? `SKIP ${file.path} — ${file.error}` : summarizeFile(file.path, file.results)))
				.join("\n");
			const failures = reviewed.flatMap((file) =>
				file.results
					.filter((result) => !result.passed && !config.checklistWaivers.includes(result.id))
					.map((result) => ({ path: file.path, result })),
			);
			const mechanicalPassed = failures.length === 0;

			if (params.verdict === undefined) {
				return textResult(
					[
						"MECHANICAL CHECKS (computed from the files, not from your judgment)",
						mechanical,
						"",
						failures.length === 0
							? "No mechanical failures."
							: `${failures.length} mechanical failure(s) — these must be fixed; a pass verdict cannot override them:\n${failures
									.map(
										({ path, result }) =>
											`- ${path}: ${result.label}${result.hits.length > 0 ? ` at line ${result.hits.map((hit) => hit.line).join(", ")}` : ""}`,
									)
									.join("\n")}`,
						"",
						"NEEDS A BROWSER (record as SKIP with a reason, or check them yourself and report evidence)",
						BROWSER_CHECKS.map((check) => `- ${check.id}: ${check.label} — ${check.reason}`).join("\n"),
						"",
						"NOW: work through the doctrine's Section 14 pre-flight matrix, plus the dense-UI additions if",
						"these are product surfaces. Answer every item PASS, FAIL or SKIP with one line of evidence.",
						"Fix what fails, then call taste_review again with verdict and findings.",
					].join("\n"),
				);
			}

			const passed = params.verdict === "pass" && mechanicalPassed;
			if (passed) {
				touched.clear();
				bites = 0;
				paint(ctx);
				ctx.ui.notify(`taste: review passed (${paths.length} file(s)).`, "info");
				return textResult(
					`Review PASSED for ${paths.length} file(s). The gate is clear; you may finish.\n\n${mechanical}`,
				);
			}
			return textResult(
				[
					`Review NOT passed.${params.verdict === "pass" && !mechanicalPassed ? " Your verdict was pass, but mechanical checks failed — those decide." : ""}`,
					"",
					mechanical,
					"",
					failures
						.map(
							({ path, result }) =>
								`- ${path}: ${result.label}${result.hits.length > 0 ? ` at line ${result.hits.map((hit) => hit.line).join(", ")}` : ""}`,
						)
						.join("\n"),
					"",
					params.findings ? `Your findings:\n${params.findings}` : "",
					"",
					"Fix these and run taste_review again.",
				]
					.filter((part) => part !== "")
					.join("\n"),
			);
		},
	});

	smolt.registerCommand("taste", {
		description: "Design doctrine and the review gate: status, on, off, review",
		getArgumentCompletions: (argumentPrefix) => {
			const items = [
				{ value: "on", label: "on", description: "Arm the doctrine and the gate now" },
				{ value: "off", label: "off", description: "Stand both down for this session" },
				{ value: "review", label: "review", description: "Review what has been written so far" },
				{ value: "reset", label: "reset", description: "Forget the pending files" },
			];
			const prefix = argumentPrefix.trim().toLowerCase();
			return items.filter((item) => item.value.startsWith(prefix));
		},
		handler: async (args, ctx) => {
			const verb = args.trim().toLowerCase();
			if (verb === "on") {
				armed = true;
				disabled = false;
				paint(ctx);
				ctx.ui.notify("taste: armed.", "info");
				return;
			}
			if (verb === "off") {
				disabled = true;
				paint(ctx);
				ctx.ui.notify("taste: off for this session. Files written are still tracked.", "info");
				return;
			}
			if (verb === "reset") {
				touched.clear();
				bites = 0;
				paint(ctx);
				ctx.ui.notify("taste: pending files cleared.", "info");
				return;
			}
			if (verb === "review") {
				// A review the user asked for ignores the bite cap: the cap exists
				// to stop the gate nagging, not to stop a person asking.
				bites = 0;
				gateRun = true;
				smolt.sendUserMessage(
					touched.size === 0
						? "Run taste_review on the files that render in this project, and work through its checklist with evidence."
						: gatePrompt([...touched]),
				);
				return;
			}
			ctx.ui.notify(
				disabled
					? "taste: off for this session. /taste on to arm it."
					: `taste: ${armed ? "armed" : "not armed yet"}, ${touched.size} file(s) awaiting review.`,
				"info",
			);
		},
	});

	return { armed: () => armed, pending: () => [...touched] };
}
