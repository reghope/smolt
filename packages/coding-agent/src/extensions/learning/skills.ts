import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * Agent-managed skill creation & editing.
 *
 * Lets the agent create, update, and delete skills, turning successful
 * approaches into reusable procedural knowledge. Skills are the agent's
 * procedural memory: they capture *how to do a specific type of task* based
 * on proven experience. General memory (MEMORY.md, USER.md) is broad and
 * declarative; skills are narrow and actionable.
 *
 * Actions:
 *   create      -- Create a new skill (SKILL.md + directory structure)
 *   edit        -- Replace the SKILL.md content of a skill (full rewrite)
 *   patch       -- Targeted find-and-replace within SKILL.md or a supporting file
 *   delete      -- Remove a skill entirely
 *   write_file  -- Add/overwrite a supporting file (reference, template, script, asset)
 *   remove_file -- Remove a supporting file from a skill
 */

export const MAX_NAME_LENGTH = 64;
export const MAX_DESCRIPTION_LENGTH = 1024;
export const SKILL_PROMPT_DESC_LIMIT = 60;
export const MAX_SKILL_CONTENT_CHARS = 100_000; // ~36k tokens at 2.75 chars/token
export const MAX_SKILL_FILE_BYTES = 1_048_576; // 1 MiB per supporting file

// Characters allowed in skill names (filesystem-safe, URL-friendly)
const VALID_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

// Subdirectories allowed for write_file/remove_file
export const ALLOWED_SUBDIRS = new Set(["references", "templates", "scripts", "assets"]);

export type SkillResult = Record<string, unknown>;

function atomicWriteText(path: string, content: string): void {
	const tmp = join(dirname(path), `.skill_${process.pid}_${Math.floor(Math.random() * 1e9)}.tmp`);
	writeFileSync(tmp, content, "utf-8");
	try {
		renameSync(tmp, path);
	} catch {
		// Windows rename can fail over an existing open file; fall back.
		writeFileSync(path, content, "utf-8");
		try {
			unlinkSync(tmp);
		} catch {
			// tmp already gone
		}
	}
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateName(name: string): string | undefined {
	if (!name) return "Skill name is required.";
	if (name.length > MAX_NAME_LENGTH) return `Skill name exceeds ${MAX_NAME_LENGTH} characters.`;
	if (!VALID_NAME_RE.test(name)) {
		return (
			`Invalid skill name '${name}'. Use lowercase letters, numbers, ` +
			"hyphens, dots, and underscores. Must start with a letter or digit."
		);
	}
	return undefined;
}

export function validateCategory(category: string | undefined): string | undefined {
	if (category === undefined) return undefined;
	category = category.trim();
	if (category === "") return undefined;
	if (category.includes("/") || category.includes("\\")) {
		return (
			`Invalid category '${category}'. Use lowercase letters, numbers, ` +
			"hyphens, dots, and underscores. Categories must be a single directory name."
		);
	}
	if (category.length > MAX_NAME_LENGTH) return `Category exceeds ${MAX_NAME_LENGTH} characters.`;
	if (!VALID_NAME_RE.test(category)) {
		return (
			`Invalid category '${category}'. Use lowercase letters, numbers, ` +
			"hyphens, dots, and underscores. Categories must be a single directory name."
		);
	}
	return undefined;
}

/** Validate that SKILL.md content has proper frontmatter with required
 * fields. When `newSkill` is true (create path only), the description must
 * also fit the 60-char system-prompt budget so newly authored skills never
 * lose routing signal to index truncation. Edit and patch paths skip this so
 * existing over-limit skills remain maintainable. */
export function validateFrontmatter(content: string, newSkill = false): string | undefined {
	if (content.trim() === "") return "Content cannot be empty.";

	// Tolerate a leading UTF-8 BOM (Windows editors) before the fence.
	content = content.replace(/^﻿/, "");

	if (!content.startsWith("---")) {
		return "SKILL.md must start with YAML frontmatter (---). See existing skills for format.";
	}
	const endMatch = /\n---[ \t]*\n/.exec(content.slice(3));
	if (!endMatch) return "SKILL.md frontmatter is not closed. Ensure you have a closing '---' line.";

	const yamlContent = content.slice(3, endMatch.index + 3);
	let parsed: unknown;
	try {
		parsed = parseYaml(yamlContent);
	} catch (e) {
		return `YAML frontmatter parse error: ${e instanceof Error ? e.message : String(e)}`;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return "Frontmatter must be a YAML mapping (key: value pairs).";
	}
	const fm = parsed as Record<string, unknown>;
	if (!("name" in fm)) return "Frontmatter must include 'name' field.";
	if (!("description" in fm)) return "Frontmatter must include 'description' field.";
	const desc = String(fm.description);
	if (desc.length > MAX_DESCRIPTION_LENGTH) {
		return `Description exceeds ${MAX_DESCRIPTION_LENGTH} characters.`;
	}
	if (newSkill && desc.trim().replace(/^['"]+|['"]+$/g, "").length > SKILL_PROMPT_DESC_LIMIT) {
		return (
			`Description is ${desc.trim().length} chars — new skills must fit the ` +
			`${SKILL_PROMPT_DESC_LIMIT}-char system-prompt budget (one sentence, trigger first, ` +
			"ends with a period). The skill index truncates longer descriptions to " +
			`${SKILL_PROMPT_DESC_LIMIT - 3} chars + '...', destroying the routing signal. ` +
			"Move detail into the skill body."
		);
	}
	const body = content.slice(3 + endMatch.index! + endMatch[0].length).trim();
	if (body === "") {
		return "SKILL.md must have content after the frontmatter (instructions, procedures, etc.).";
	}
	return undefined;
}

export function validateContentSize(content: string, label = "SKILL.md"): string | undefined {
	if (content.length > MAX_SKILL_CONTENT_CHARS) {
		return (
			`${label} content is ${content.length.toLocaleString("en-US")} characters ` +
			`(limit: ${MAX_SKILL_CONTENT_CHARS.toLocaleString("en-US")}). ` +
			"Consider splitting into a smaller SKILL.md with supporting files in references/ or templates/."
		);
	}
	return undefined;
}

/** Validate a file path for write_file/remove_file: must be SKILL.md at the
 * skill root, or live under an allowed subdirectory, and must not traverse. */
export function validateFilePath(filePath: string): string | undefined {
	if (!filePath) return "file_path is required.";

	const parts = filePath.split(/[/\\]/).filter((part) => part !== "");
	if (parts.some((part) => part === "..")) return "Path traversal ('..') is not allowed.";

	// SKILL.md is the canonical skill file and lives at the skill root.
	// Accept 'SKILL.md' and '<skill-name>/SKILL.md'.
	if (parts.length >= 1 && parts[parts.length - 1] === "SKILL.md" && parts.length <= 2) {
		return undefined;
	}

	if (parts.length === 0 || !ALLOWED_SUBDIRS.has(parts[0]!)) {
		const allowed = [...ALLOWED_SUBDIRS].sort().join(", ");
		return `File must be under one of: ${allowed}. Got: '${filePath}'`;
	}
	if (parts.length < 2) {
		return `Provide a file path, not just a directory. Example: '${parts[0]}/myfile.md'`;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function findSkillMdDirs(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of entries) {
			const full = join(dir, name);
			let st: ReturnType<typeof statSync>;
			try {
				st = statSync(full);
			} catch {
				continue;
			}
			if (st.isDirectory()) walk(full);
			else if (name === "SKILL.md") out.push(dir);
		}
	};
	walk(root);
	return out;
}

export class SkillManager {
	private readonly root: string;

	constructor(root: string) {
		this.root = root;
	}

	/** Find a skill by directory name anywhere under the skills root. */
	findSkill(name: string): string | undefined {
		if (!existsSync(this.root)) return undefined;
		for (const dir of findSkillMdDirs(this.root)) {
			if (dir.split(sep).pop() === name) return dir;
		}
		return undefined;
	}

	private resolveSkillDir(name: string, category?: string): string {
		return category ? join(this.root, category, name) : join(this.root, name);
	}

	private skillNotFoundError(name: string, suffix = ""): string {
		return `Skill '${name}' not found.${suffix}`;
	}

	/** Resolve a supporting-file path, ensuring it stays within the skill dir. */
	private resolveSkillTarget(skillDir: string, filePath: string): [string | undefined, string | undefined] {
		const target = resolve(skillDir, filePath);
		const rel = relative(resolve(skillDir), target);
		if (rel === "" || rel.startsWith("..") || rel.includes(`..${sep}`)) {
			return [undefined, `file_path must stay within the skill directory. Got: '${filePath}'`];
		}
		return [target, undefined];
	}

	/** Guards before the recursive delete: never remove a path outside the
	 * skills root, the root itself, or a directory reached via a symlink. */
	private validateDeleteTarget(skillDir: string): string | undefined {
		try {
			if (lstatSync(skillDir).isSymbolicLink()) {
				return (
					`Refusing to delete '${skillDir}': the skill directory is a symlink/junction. ` +
					"Remove the link target manually if intended."
				);
			}
		} catch {
			// lstat failure falls through to the containment check
		}
		const resolved = resolve(skillDir);
		const root = resolve(this.root);
		if (resolved === root) {
			return (
				`Refusing to delete '${skillDir}': resolves to the skills root itself, ` +
				"which would remove every installed skill."
			);
		}
		const rel = relative(root, resolved);
		if (rel === "" || rel.startsWith("..")) {
			return `Refusing to delete '${skillDir}': path does not resolve inside the skills root.`;
		}
		return undefined;
	}

	create(name: string, content: string | undefined, category?: string): SkillResult {
		let err = validateName(name);
		if (err) return { success: false, error: err };
		err = validateCategory(category);
		if (err) return { success: false, error: err };
		if (!content)
			return { success: false, error: "content is required for 'create': the full SKILL.md including frontmatter." };
		err = validateFrontmatter(content, true);
		if (err) return { success: false, error: err };
		err = validateContentSize(content);
		if (err) return { success: false, error: err };

		const existing = this.findSkill(name);
		if (existing) {
			return { success: false, error: `A skill named '${name}' already exists at ${existing}.` };
		}

		const cat = category?.trim() || undefined;
		const skillDir = this.resolveSkillDir(name, cat);
		mkdirSync(skillDir, { recursive: true });
		const skillMd = join(skillDir, "SKILL.md");
		atomicWriteText(skillMd, content);

		const result: SkillResult = {
			success: true,
			message: `Skill '${name}' created.`,
			path: relative(this.root, skillDir),
			skill_md: skillMd,
		};
		if (cat) result.category = cat;
		result.hint =
			"To add reference files, templates, or scripts, use " +
			`skill_manage(action='write_file', name='${name}', file_path='references/example.md', file_content='...')`;
		return result;
	}

	edit(name: string, content: string | undefined): SkillResult {
		if (!content) return { success: false, error: "content is required for 'edit': the full replacement SKILL.md." };
		let err = validateFrontmatter(content);
		if (err) return { success: false, error: err };
		err = validateContentSize(content);
		if (err) return { success: false, error: err };

		const skillDir = this.findSkill(name);
		if (!skillDir) return { success: false, error: this.skillNotFoundError(name) };

		atomicWriteText(join(skillDir, "SKILL.md"), content);
		return { success: true, message: `Skill '${name}' updated (full rewrite).`, path: skillDir };
	}

	/** Targeted find-and-replace within a skill file. Defaults to SKILL.md;
	 * use filePath to patch a supporting file. Requires a unique match unless
	 * replaceAll is true. Falls back to a line-ending-normalized match when
	 * the exact string is not found. */
	patch(
		name: string,
		oldString: string | undefined,
		newString: string | undefined,
		filePath?: string,
		replaceAll = false,
	): SkillResult {
		if (!oldString) return { success: false, error: "old_string is required for 'patch'." };
		if (newString === undefined || newString === null) {
			return {
				success: false,
				error: "new_string is required for 'patch'. Use an empty string to delete matched text.",
			};
		}

		const skillDir = this.findSkill(name);
		if (!skillDir) return { success: false, error: this.skillNotFoundError(name) };

		let target: string;
		if (filePath) {
			const pathErr = validateFilePath(filePath);
			if (pathErr) return { success: false, error: pathErr };
			const [resolved, resolveErr] = this.resolveSkillTarget(skillDir, filePath);
			if (resolveErr) return { success: false, error: resolveErr };
			target = resolved!;
		} else {
			target = join(skillDir, "SKILL.md");
		}

		if (!existsSync(target)) {
			return { success: false, error: `File not found: ${relative(skillDir, target)}` };
		}

		const content = readFileSync(target, "utf-8");
		const replaced = findAndReplace(content, oldString, newString, replaceAll);
		if (replaced.error) {
			const preview = content.slice(0, 500) + (content.length > 500 ? "..." : "");
			return { success: false, error: replaced.error, file_preview: preview };
		}
		const newContent = replaced.content!;

		const targetLabel = filePath || "SKILL.md";
		let err = validateContentSize(newContent, targetLabel);
		if (err) return { success: false, error: err };

		if (!filePath) {
			err = validateFrontmatter(newContent);
			if (err) return { success: false, error: `Patch would break SKILL.md structure: ${err}` };
		}

		atomicWriteText(target, newContent);
		const n = replaced.count!;
		return {
			success: true,
			message: `Patched ${targetLabel} in skill '${name}' (${n} replacement${n > 1 ? "s" : ""}).`,
		};
	}

	delete(name: string): SkillResult {
		const skillDir = this.findSkill(name);
		if (!skillDir) return { success: false, error: this.skillNotFoundError(name) };

		const unsafe = this.validateDeleteTarget(skillDir);
		if (unsafe) return { success: false, error: unsafe };

		rmSync(skillDir, { recursive: true, force: true });

		// Clean up an empty category directory (never the skills root itself).
		const parent = dirname(skillDir);
		if (resolve(parent) !== resolve(this.root) && existsSync(parent) && readdirSync(parent).length === 0) {
			rmdirSync(parent);
		}
		return { success: true, message: `Skill '${name}' deleted.` };
	}

	writeFile(name: string, filePath: string | undefined, fileContent: string | undefined): SkillResult {
		const pathErr = validateFilePath(filePath ?? "");
		if (pathErr) return { success: false, error: pathErr };
		if (fileContent === undefined || fileContent === null) {
			return { success: false, error: "file_content is required." };
		}

		const contentBytes = Buffer.byteLength(fileContent, "utf-8");
		if (contentBytes > MAX_SKILL_FILE_BYTES) {
			return {
				success: false,
				error:
					`File content is ${contentBytes.toLocaleString("en-US")} bytes ` +
					`(limit: ${MAX_SKILL_FILE_BYTES.toLocaleString("en-US")} bytes / 1 MiB). ` +
					"Consider splitting into smaller files.",
			};
		}
		let err = validateContentSize(fileContent, filePath);
		if (err) return { success: false, error: err };

		const skillDir = this.findSkill(name);
		if (!skillDir) {
			return { success: false, error: this.skillNotFoundError(name, " Create it first with action='create'.") };
		}

		// Writing SKILL.md through write_file must keep the frontmatter valid.
		const parts = filePath!.split(/[/\\]/).filter((part) => part !== "");
		if (parts[parts.length - 1] === "SKILL.md") {
			err = validateFrontmatter(fileContent);
			if (err) return { success: false, error: err };
		}

		const [target, resolveErr] = this.resolveSkillTarget(skillDir, filePath!);
		if (resolveErr) return { success: false, error: resolveErr };
		mkdirSync(dirname(target!), { recursive: true });
		atomicWriteText(target!, fileContent);
		return { success: true, message: `File '${filePath}' written to skill '${name}'.`, path: target };
	}

	removeFile(name: string, filePath: string | undefined): SkillResult {
		const pathErr = validateFilePath(filePath ?? "");
		if (pathErr) return { success: false, error: pathErr };

		const skillDir = this.findSkill(name);
		if (!skillDir) return { success: false, error: this.skillNotFoundError(name) };

		const [target, resolveErr] = this.resolveSkillTarget(skillDir, filePath!);
		if (resolveErr) return { success: false, error: resolveErr };

		if (!existsSync(target!)) {
			// List what's actually there for the model to see.
			const available: string[] = [];
			for (const subdir of ALLOWED_SUBDIRS) {
				const dir = join(skillDir, subdir);
				if (!existsSync(dir)) continue;
				const walk = (d: string): void => {
					for (const entry of readdirSync(d)) {
						const full = join(d, entry);
						if (statSync(full).isDirectory()) walk(full);
						else available.push(relative(skillDir, full));
					}
				};
				walk(dir);
			}
			return {
				success: false,
				error: `File '${filePath}' not found in skill '${name}'.`,
				available_files: available.length > 0 ? available : null,
			};
		}

		unlinkSync(target!);
		return { success: true, message: `File '${filePath}' removed from skill '${name}'.` };
	}
}

/** Find-and-replace with a line-ending-normalized fallback. Requires a
 * unique match unless replaceAll. Returns {content, count} or {error}. */
export function findAndReplace(
	content: string,
	oldString: string,
	newString: string,
	replaceAll: boolean,
): { content?: string; count?: number; error?: string } {
	let haystack = content;
	let needle = oldString;
	let count = countOccurrences(haystack, needle);

	if (count === 0) {
		// Normalize CRLF on both sides and retry — the most common formatting
		// mismatch between the model's string and the on-disk file.
		const normContent = content.replaceAll("\r\n", "\n");
		const normNeedle = oldString.replaceAll("\r\n", "\n");
		const normCount = countOccurrences(normContent, normNeedle);
		if (normCount > 0) {
			haystack = normContent;
			needle = normNeedle;
			count = normCount;
		}
	}

	if (count === 0) {
		return {
			error:
				"old_string not found in the file. Provide the exact existing text (check whitespace " +
				"and indentation) — see file_preview.",
		};
	}
	if (count > 1 && !replaceAll) {
		return {
			error: `old_string matches ${count} times; provide a larger unique string or set replace_all=true.`,
		};
	}

	if (replaceAll) {
		return { content: haystack.split(needle).join(newString), count };
	}
	const first = haystack.indexOf(needle);
	return {
		content: haystack.slice(0, first) + newString + haystack.slice(first + needle.length),
		count: 1,
	};
}

function countOccurrences(haystack: string, needle: string): number {
	if (needle === "") return 0;
	let count = 0;
	let pos = haystack.indexOf(needle);
	while (pos >= 0) {
		count += 1;
		pos = haystack.indexOf(needle, pos + needle.length);
	}
	return count;
}

/** Single entry point for the skill_manage tool. */
export function skillManageTool(
	manager: SkillManager,
	params: {
		action?: string;
		name?: string;
		category?: string;
		content?: string;
		old_string?: string;
		new_string?: string;
		replace_all?: boolean;
		file_path?: string;
		file_content?: string;
	},
): SkillResult {
	const name = params.name ?? "";
	switch (params.action) {
		case "create":
			return manager.create(name, params.content, params.category);
		case "edit":
			return manager.edit(name, params.content);
		case "patch":
			return manager.patch(
				name,
				params.old_string,
				params.new_string,
				params.file_path,
				params.replace_all ?? false,
			);
		case "delete":
			return manager.delete(name);
		case "write_file":
			return manager.writeFile(name, params.file_path, params.file_content);
		case "remove_file":
			return manager.removeFile(name, params.file_path);
		default:
			return {
				success: false,
				error: `Unknown action '${params.action}'. Use: create, edit, patch, delete, write_file, remove_file`,
			};
	}
}
