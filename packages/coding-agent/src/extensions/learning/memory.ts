import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Persistent curated memory.
 *
 * Bounded, file-backed memory that persists across sessions. Two stores:
 *   - MEMORY.md: the agent's personal notes and observations (environment
 *     facts, project conventions, tool quirks, things learned)
 *   - USER.md: what the agent knows about the user (preferences,
 *     communication style, expectations, workflow habits)
 *
 * Both are injected into the system prompt as a frozen snapshot at session
 * start. Mid-session writes update files on disk immediately (durable) but do
 * NOT change the system prompt — this preserves the prefix cache for the
 * entire session. The snapshot refreshes on the next session start.
 *
 * Entry delimiter: § (section sign). Entries can be multiline.
 * Character limits (not tokens) because char counts are model-independent.
 */

export const ENTRY_DELIMITER = "\n§\n";

export const MEMORY_BLOCK_HEADERS: Record<MemoryTarget, string> = {
	memory: "MEMORY (your personal notes)",
	user: "USER PROFILE (who the user is)",
};

export type MemoryTarget = "memory" | "user";

export interface MemoryOperation {
	action?: string;
	content?: string;
	new_text?: string;
	old_text?: string;
}

export type MemoryResult = Record<string, unknown>;

/** After this many failed consolidation attempts (overflow / zero-match) in
 * ONE turn, stop instructing the model to retry and return a terminal "save
 * skipped" result so a fragile replace/add can't loop the turn to budget
 * exhaustion and suppress the user's reply. */
const MAX_CONSOLIDATION_FAILURES_PER_TURN = 3;

function fmt(n: number): string {
	return n.toLocaleString("en-US");
}

function stripBom(raw: string): string {
	return raw.startsWith("﻿") ? raw.slice(1) : raw;
}

function atomicWriteText(path: string, content: string): void {
	const tmp = join(dirname(path), `.mem_${process.pid}_${Math.floor(Math.random() * 1e9)}.tmp`);
	writeFileSync(tmp, content, "utf-8");
	renameSync(tmp, path);
}

function parseEntries(raw: string): string[] {
	if (raw.trim() === "") return [];
	// Split on the full delimiter so entries containing a bare "§" survive.
	return raw
		.split(ENTRY_DELIMITER)
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "");
}

function dedupe(entries: string[]): string[] {
	return [...new Set(entries)];
}

function previews(entries: string[], width = 80): string[] {
	return entries.map((entry) => entry.slice(0, width) + (entry.length > width ? "..." : ""));
}

/** Sentinel: the target file exists but could not be read. The caller must
 * abort the mutation — persisting over an unreadable file would wipe it. */
const READ_FAILED = Symbol("read-failed");

export class MemoryStore {
	private readonly dir: string;
	readonly memoryCharLimit: number;
	readonly userCharLimit: number;
	private memoryEntries: string[] = [];
	private userEntries: string[] = [];
	private snapshot: Record<MemoryTarget, string> = { memory: "", user: "" };
	private consolidationFailures = 0;

	constructor(dir: string, memoryCharLimit = 2200, userCharLimit = 1375) {
		this.dir = dir;
		this.memoryCharLimit = memoryCharLimit;
		this.userCharLimit = userCharLimit;
	}

	pathFor(target: MemoryTarget): string {
		return join(this.dir, target === "user" ? "USER.md" : "MEMORY.md");
	}

	private fileName(target: MemoryTarget): string {
		return target === "user" ? "USER.md" : "MEMORY.md";
	}

	private entriesFor(target: MemoryTarget): string[] {
		return target === "user" ? this.userEntries : this.memoryEntries;
	}

	private setEntries(target: MemoryTarget, entries: string[]): void {
		if (target === "user") this.userEntries = entries;
		else this.memoryEntries = entries;
	}

	charLimit(target: MemoryTarget): number {
		return target === "user" ? this.userCharLimit : this.memoryCharLimit;
	}

	private charCount(target: MemoryTarget): number {
		const entries = this.entriesFor(target);
		if (entries.length === 0) return 0;
		return entries.join(ENTRY_DELIMITER).length;
	}

	resetConsolidationFailures(): void {
		this.consolidationFailures = 0;
	}

	/** Count an at-capacity consolidation failure and degrade gracefully:
	 * under the per-turn cap the response passes through unchanged (it already
	 * tells the model how to self-correct); past the cap, return a TERMINAL
	 * result so the model stops looping memory calls and answers the user. */
	private consolidationFailure(response: MemoryResult): MemoryResult {
		this.consolidationFailures += 1;
		if (this.consolidationFailures <= MAX_CONSOLIDATION_FAILURES_PER_TURN) return response;
		return {
			success: false,
			done: true,
			error:
				`Memory consolidation failed ${this.consolidationFailures} times this turn. ` +
				"Stop retrying memory calls — leave memory unchanged for now and continue with your " +
				"reply to the user. The fact can be saved in a later turn.",
		};
	}

	/** Read a memory file's raw text, distinguishing unreadable from empty.
	 * An absent file is a clean `["", true]`; a file that exists but cannot be
	 * read returns `["", false]` and the caller MUST abort any rewrite. */
	private readRawChecked(path: string): [string, boolean] {
		if (!existsSync(path)) return ["", true];
		try {
			return [stripBom(readFileSync(path, "utf-8")), true];
		} catch {
			return ["", false];
		}
	}

	loadFromDisk(): void {
		mkdirSync(this.dir, { recursive: true });
		this.memoryEntries = dedupe(parseEntries(this.readRawChecked(this.pathFor("memory"))[0]));
		this.userEntries = dedupe(parseEntries(this.readRawChecked(this.pathFor("user"))[0]));
		this.snapshot = {
			memory: this.renderBlock("memory", this.memoryEntries),
			user: this.renderBlock("user", this.userEntries),
		};
	}

	/** Return the frozen snapshot for system prompt injection (state captured
	 * at loadFromDisk() time — mid-session writes do not affect it). Empty
	 * string when there were no entries at load time. */
	formatForSystemPrompt(target: MemoryTarget): string {
		return this.snapshot[target];
	}

	private renderBlock(target: MemoryTarget, entries: string[]): string {
		if (entries.length === 0) return "";
		const limit = this.charLimit(target);
		const content = entries.join(ENTRY_DELIMITER);
		const current = content.length;
		const pct = limit > 0 ? Math.min(100, Math.floor((current / limit) * 100)) : 0;
		const header = `${MEMORY_BLOCK_HEADERS[target]} [${pct}% — ${fmt(current)}/${fmt(limit)} chars]`;
		const separator = "═".repeat(46);
		return `${separator}\n${header}\n${separator}\n${content}`;
	}

	private saveToDisk(target: MemoryTarget): void {
		mkdirSync(this.dir, { recursive: true });
		const entries = this.entriesFor(target);
		atomicWriteText(this.pathFor(target), entries.length > 0 ? entries.join(ENTRY_DELIMITER) : "");
	}

	/** Detect external drift: the on-disk file holds content that would not
	 * round-trip through the parser/serializer, or a single entry exceeds the
	 * whole-store char limit (an external writer appended free-form content).
	 * Flushing would discard it, so mutations must refuse. Returns the .bak
	 * path when drift was found and backed up, undefined when clean. */
	private detectExternalDrift(target: MemoryTarget, raw: string): string | undefined {
		if (raw.trim() === "") return undefined;
		const parsed = raw
			.split(ENTRY_DELIMITER)
			.map((entry) => entry.trim())
			.filter((entry) => entry !== "");
		const roundtrip = parsed.join(ENTRY_DELIMITER);
		const maxEntryLen = parsed.reduce((max, entry) => Math.max(max, entry.length), 0);
		if (raw.trim() === roundtrip && maxEntryLen <= this.charLimit(target)) return undefined;
		const path = this.pathFor(target);
		const bakPath = `${path}.bak.${Math.floor(Date.now() / 1000)}`;
		try {
			writeFileSync(bakPath, raw, "utf-8");
		} catch {
			return `${bakPath} (BACKUP FAILED — file unchanged on disk)`;
		}
		return bakPath;
	}

	private driftError(target: MemoryTarget, bakPath: string): MemoryResult {
		const name = this.fileName(target);
		return {
			success: false,
			error:
				`Refusing to write ${name}: file on disk has content that wouldn't round-trip ` +
				"through the memory tool (likely added by an editor, a shell append, a manual edit, " +
				`or a concurrent session). A snapshot was saved to ${bakPath}. Resolve the drift ` +
				"first — either rewrite the file as a clean §-delimited list of entries, or move " +
				"the extra content out — then retry. This guard exists to prevent silent data loss.",
			drift_backup: bakPath,
			remediation:
				"Open the .bak file, integrate the missing entries into the memory tool one at a " +
				"time via memory(action=add, content=...), then remove or rewrite the original " +
				"file to a clean state.",
		};
	}

	private readFailedError(target: MemoryTarget): MemoryResult {
		const name = this.fileName(target);
		return {
			success: false,
			error:
				`Refusing to write ${name}: the file exists on disk but could not be read right ` +
				"now (temporarily locked by another program, a permission change, invalid/corrupt " +
				"text encoding, or a filesystem error). Treating an unreadable file as empty and " +
				"saving would wipe existing memory, so the write is refused. Nothing was changed — " +
				"retry in a moment.",
		};
	}

	/** Re-read entries from disk into in-memory state before mutating.
	 * Returns a .bak path string on drift, READ_FAILED when the file exists
	 * but is unreadable, undefined on clean reload. `skipDrift` is used by
	 * `add`, which appends without discarding un-roundtrippable content. */
	private reloadTarget(target: MemoryTarget, skipDrift = false): string | typeof READ_FAILED | undefined {
		const [raw, readOk] = this.readRawChecked(this.pathFor(target));
		if (!readOk) return READ_FAILED;
		const bak = skipDrift ? undefined : this.detectExternalDrift(target, raw);
		this.setEntries(target, dedupe(parseEntries(raw)));
		return bak;
	}

	private successResponse(target: MemoryTarget, message?: string): MemoryResult {
		// A successful write means the consolidation loop made progress — the
		// cap counts consecutive failures within a turn, not lifetime ones.
		this.consolidationFailures = 0;
		const entries = this.entriesFor(target);
		const current = this.charCount(target);
		const limit = this.charLimit(target);
		const pct = limit > 0 ? Math.min(100, Math.floor((current / limit) * 100)) : 0;
		// Intentionally TERMINAL: confirms the write landed and tells the model
		// to stop. The full entries list is only echoed on error paths, where
		// the model genuinely needs it to decide what to consolidate.
		const resp: MemoryResult = {
			success: true,
			done: true,
			target,
			usage: `${pct}% — ${fmt(current)}/${fmt(limit)} chars`,
			entry_count: entries.length,
		};
		if (message) resp.message = message;
		resp.note = "Write saved. This update is complete — do not repeat it.";
		return resp;
	}

	usage(target: MemoryTarget): string {
		return `${fmt(this.charCount(target))}/${fmt(this.charLimit(target))}`;
	}

	add(target: MemoryTarget, content: string): MemoryResult {
		content = content.trim();
		if (content === "") return { success: false, error: "Content cannot be empty." };

		// Re-read from disk to pick up writes from other sessions. Append-only,
		// so the drift guard is skipped — but an unreadable file still aborts,
		// because add rewrites the whole file from the parsed entries.
		if (this.reloadTarget(target, true) === READ_FAILED) return this.readFailedError(target);

		const entries = this.entriesFor(target);
		const limit = this.charLimit(target);

		if (entries.includes(content)) {
			return this.successResponse(target, "Entry already exists (no duplicate added).");
		}

		const newTotal = [...entries, content].join(ENTRY_DELIMITER).length;
		if (newTotal > limit) {
			const current = this.charCount(target);
			return this.consolidationFailure({
				success: false,
				error:
					`Memory at ${fmt(current)}/${fmt(limit)} chars. ` +
					`Adding this entry (${content.length} chars) would exceed the limit. ` +
					"Consolidate now: use 'replace' to merge overlapping entries into shorter ones " +
					"or 'remove' stale or less important entries (see current_entries below), then " +
					"retry this add — all in this turn.",
				current_entries: entries,
				usage: `${fmt(current)}/${fmt(limit)}`,
			});
		}

		entries.push(content);
		this.setEntries(target, entries);
		this.saveToDisk(target);
		return this.successResponse(target, "Entry added.");
	}

	replace(target: MemoryTarget, oldText: string, newContent: string): MemoryResult {
		oldText = oldText.trim();
		newContent = newContent.trim();
		if (oldText === "") return { success: false, error: "old_text cannot be empty." };
		if (newContent === "") {
			return { success: false, error: "new_content cannot be empty. Use 'remove' to delete entries." };
		}

		const bak = this.reloadTarget(target);
		if (bak === READ_FAILED) return this.readFailedError(target);
		if (bak) return this.driftError(target, bak);

		const entries = this.entriesFor(target);
		const matches = entries.map((entry, i) => [i, entry] as const).filter(([, entry]) => entry.includes(oldText));

		if (matches.length === 0) {
			return this.consolidationFailure({
				success: false,
				error: `No entry matched '${oldText}'. Check current_entries below and retry with the exact text of the entry you want to replace.`,
				current_entries: entries,
			});
		}
		if (matches.length > 1) {
			const uniqueTexts = new Set(matches.map(([, entry]) => entry));
			if (uniqueTexts.size > 1) {
				return {
					success: false,
					error: `Multiple entries matched '${oldText}'. Be more specific.`,
					matches: previews(matches.map(([, entry]) => entry)),
				};
			}
			// All identical — safe to replace just the first.
		}

		const idx = matches[0]![0];
		const limit = this.charLimit(target);
		const testEntries = [...entries];
		testEntries[idx] = newContent;
		const newTotal = testEntries.join(ENTRY_DELIMITER).length;
		if (newTotal > limit) {
			const current = this.charCount(target);
			return this.consolidationFailure({
				success: false,
				error:
					`Replacement would put memory at ${fmt(newTotal)}/${fmt(limit)} chars. ` +
					"Shorten the new content, or 'remove' other stale or less important entries to " +
					"make room (see current_entries below), then retry — all in this turn.",
				current_entries: entries,
				usage: `${fmt(current)}/${fmt(limit)}`,
			});
		}

		entries[idx] = newContent;
		this.setEntries(target, entries);
		this.saveToDisk(target);
		return this.successResponse(target, "Entry replaced.");
	}

	remove(target: MemoryTarget, oldText: string): MemoryResult {
		oldText = oldText.trim();
		if (oldText === "") return { success: false, error: "old_text cannot be empty." };

		const bak = this.reloadTarget(target);
		if (bak === READ_FAILED) return this.readFailedError(target);
		if (bak) return this.driftError(target, bak);

		const entries = this.entriesFor(target);
		const matches = entries.map((entry, i) => [i, entry] as const).filter(([, entry]) => entry.includes(oldText));

		if (matches.length === 0) {
			return this.consolidationFailure({
				success: false,
				error: `No entry matched '${oldText}'. Check current_entries below and retry with the exact text of the entry you want to remove.`,
				current_entries: entries,
			});
		}
		if (matches.length > 1) {
			const uniqueTexts = new Set(matches.map(([, entry]) => entry));
			if (uniqueTexts.size > 1) {
				return {
					success: false,
					error: `Multiple entries matched '${oldText}'. Be more specific.`,
					matches: previews(matches.map(([, entry]) => entry)),
				};
			}
			// All identical — safe to remove just the first.
		}

		entries.splice(matches[0]![0], 1);
		this.setEntries(target, entries);
		this.saveToDisk(target);
		return this.successResponse(target, "Entry removed.");
	}

	/** Apply a sequence of add/replace/remove ops to one target atomically.
	 * All operations are validated and applied against the FINAL budget —
	 * intermediate overflow is irrelevant. All-or-nothing: if any op is
	 * malformed, doesn't match, or the net result would exceed the char
	 * limit, NOTHING is written. */
	applyBatch(target: MemoryTarget, operations: MemoryOperation[]): MemoryResult {
		if (operations.length === 0) return { success: false, error: "operations list is empty." };

		const bak = this.reloadTarget(target);
		if (bak === READ_FAILED) return this.readFailedError(target);
		if (bak) return this.driftError(target, bak);

		const working = [...this.entriesFor(target)];
		const limit = this.charLimit(target);

		for (let i = 0; i < operations.length; i++) {
			const op = operations[i] ?? {};
			const act = op.action;
			const content = (op.content ?? op.new_text ?? "").trim();
			const oldText = (op.old_text ?? "").trim();
			const pos = `Operation ${i + 1} (${act || "unknown"})`;

			if (act === "add") {
				if (content === "") return this.batchError(target, `${pos}: content is required.`);
				if (working.includes(content)) continue; // idempotent — skip duplicate
				working.push(content);
			} else if (act === "replace") {
				if (oldText === "") return this.batchError(target, `${pos}: old_text is required.`);
				if (content === "") {
					return this.batchError(target, `${pos}: content is required (use action='remove' to delete).`);
				}
				const matches = working.map((_entry, j) => j).filter((j) => working[j]!.includes(oldText));
				if (matches.length === 0) return this.batchError(target, `${pos}: no entry matched '${oldText}'.`);
				if (new Set(matches.map((j) => working[j]!)).size > 1) {
					return this.batchError(
						target,
						`${pos}: '${oldText}' matched multiple distinct entries -- be more specific.`,
					);
				}
				working[matches[0]!] = content;
			} else if (act === "remove") {
				if (oldText === "") return this.batchError(target, `${pos}: old_text is required.`);
				const matches = working.map((_entry, j) => j).filter((j) => working[j]!.includes(oldText));
				if (matches.length === 0) return this.batchError(target, `${pos}: no entry matched '${oldText}'.`);
				if (new Set(matches.map((j) => working[j]!)).size > 1) {
					return this.batchError(
						target,
						`${pos}: '${oldText}' matched multiple distinct entries -- be more specific.`,
					);
				}
				working.splice(matches[0]!, 1);
			} else {
				return this.batchError(target, `${pos}: unknown action. Use add, replace, or remove.`);
			}
		}

		const newTotal = working.length > 0 ? working.join(ENTRY_DELIMITER).length : 0;
		if (newTotal > limit) {
			const current = this.charCount(target);
			return this.consolidationFailure({
				success: false,
				error:
					`After applying all ${operations.length} operations, memory would be at ` +
					`${fmt(newTotal)}/${fmt(limit)} chars -- over the limit. Remove or shorten more ` +
					"entries in the same batch (see current_entries below), then retry.",
				current_entries: this.entriesFor(target),
				usage: `${fmt(current)}/${fmt(limit)}`,
			});
		}

		this.setEntries(target, working);
		this.saveToDisk(target);
		return this.successResponse(target, `Applied ${operations.length} operation(s).`);
	}

	private batchError(target: MemoryTarget, message: string): MemoryResult {
		const current = this.charCount(target);
		const limit = this.charLimit(target);
		return this.consolidationFailure({
			success: false,
			error: `${message} No operations were applied (batch is all-or-nothing).`,
			current_entries: this.entriesFor(target),
			usage: `${fmt(current)}/${fmt(limit)}`,
		});
	}

	/** Recoverable error for a replace/remove call that arrived without
	 * old_text: returns the current entry inventory plus a retry instruction
	 * instead of a dead-end error. */
	missingOldTextError(target: MemoryTarget, action: string): MemoryResult {
		const entries = this.entriesFor(target);
		const current = this.charCount(target);
		const limit = this.charLimit(target);
		return {
			success: false,
			error:
				`'${action}' needs old_text -- a short unique substring of the entry to ${action}. ` +
				`None was provided. Reissue the ${action} with old_text set to part of one of the ` +
				"current_entries below.",
			current_entries: entries,
			usage: `${fmt(current)}/${fmt(limit)}`,
		};
	}
}

/** Single entry point for the memory tool. Dispatches to MemoryStore methods.
 * Two shapes: single op (action + content/old_text) or batch (operations
 * applied atomically against the final char budget in ONE call). `new_text`
 * is accepted as an alias for `content` on both shapes. Returns a JSON
 * result object. */
export function memoryTool(
	store: MemoryStore,
	params: {
		action?: string;
		target?: string | null;
		content?: string | null;
		old_text?: string | null;
		new_text?: string | null;
		operations?: MemoryOperation[] | null;
	},
): MemoryResult {
	let content = params.content ?? undefined;
	if (content === undefined && params.new_text != null) content = params.new_text;
	const oldText = params.old_text ?? undefined;
	const target = params.target ?? "memory";

	if (target !== "memory" && target !== "user") {
		return { success: false, error: `Invalid target '${target}'. Use 'memory' or 'user'.` };
	}

	if (params.operations && params.operations.length > 0) {
		return store.applyBatch(target, params.operations);
	}

	const action = params.action ?? "";
	if (action === "add" && !content) {
		return { success: false, error: "Content is required for 'add' action." };
	}
	if (action === "replace") {
		if (!oldText) return store.missingOldTextError(target, "replace");
		if (!content) return { success: false, error: "content is required for 'replace' action." };
	}
	if (action === "remove" && !oldText) {
		return store.missingOldTextError(target, "remove");
	}

	if (action === "add") return store.add(target, content!);
	if (action === "replace") return store.replace(target, oldText!, content!);
	if (action === "remove") return store.remove(target, oldText!);
	return { success: false, error: `Unknown action '${action}'. Use: add, replace, remove` };
}
