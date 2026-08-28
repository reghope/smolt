import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	findAndReplace,
	MAX_SKILL_CONTENT_CHARS,
	SkillManager,
	skillManageTool,
	validateFilePath,
	validateFrontmatter,
	validateName,
} from "../src/extensions/learning/skills.ts";

let root: string;
let manager: SkillManager;

const VALID_SKILL = `---
name: test-skill
description: Run the project test suite reliably.
---

# Test Skill

## When to Use
- When running tests.

## Procedure
1. Run the tests.

## Pitfalls
- None known.

## Verification
- Tests pass.
`;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "learning-skills-"));
	manager = new SkillManager(root);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("validateName", () => {
	test("accepts lowercase names with digits, hyphens, dots, underscores", () => {
		expect(validateName("my-skill_2.0")).toBeUndefined();
	});

	test("rejects empty, too-long, and invalid names", () => {
		expect(validateName("")).toBe("Skill name is required.");
		expect(validateName("a".repeat(65))).toContain("exceeds 64 characters");
		expect(validateName("My-Skill")).toContain("Invalid skill name");
		expect(validateName("-leading")).toContain("Invalid skill name");
	});
});

describe("validateFrontmatter", () => {
	test("accepts valid frontmatter", () => {
		expect(validateFrontmatter(VALID_SKILL)).toBeUndefined();
	});

	test("rejects missing frontmatter fence, unclosed fence, missing fields, empty body", () => {
		expect(validateFrontmatter("# no frontmatter")).toContain("must start with YAML frontmatter");
		expect(validateFrontmatter("---\nname: x\ndescription: y")).toContain("not closed");
		expect(validateFrontmatter("---\ndescription: y\n---\nbody")).toBe("Frontmatter must include 'name' field.");
		expect(validateFrontmatter("---\nname: x\n---\nbody")).toBe("Frontmatter must include 'description' field.");
		expect(validateFrontmatter("---\nname: x\ndescription: y\n---\n\n")).toContain(
			"must have content after the frontmatter",
		);
	});

	test("enforces the 60-char description budget only for new skills", () => {
		const long = `---\nname: x\ndescription: ${"d".repeat(80)}\n---\nbody`;
		expect(validateFrontmatter(long, true)).toContain("60-char system-prompt budget");
		expect(validateFrontmatter(long, false)).toBeUndefined();
	});

	test("tolerates a leading BOM", () => {
		expect(validateFrontmatter(`﻿${VALID_SKILL}`)).toBeUndefined();
	});
});

describe("validateFilePath", () => {
	test("accepts allowed subdirectories and SKILL.md", () => {
		expect(validateFilePath("references/notes.md")).toBeUndefined();
		expect(validateFilePath("scripts/run.sh")).toBeUndefined();
		expect(validateFilePath("SKILL.md")).toBeUndefined();
	});

	test("rejects traversal, disallowed dirs, and bare directories", () => {
		expect(validateFilePath("../escape.md")).toBe("Path traversal ('..') is not allowed.");
		expect(validateFilePath("references/../../escape.md")).toBe("Path traversal ('..') is not allowed.");
		expect(validateFilePath("random/notes.md")).toContain("File must be under one of:");
		expect(validateFilePath("references")).toContain("Provide a file path, not just a directory.");
		expect(validateFilePath("")).toBe("file_path is required.");
	});
});

describe("create", () => {
	test("creates a skill at the root and returns path + hint", () => {
		const result = manager.create("test-skill", VALID_SKILL);
		expect(result).toMatchObject({ success: true, message: "Skill 'test-skill' created." });
		expect(String(result.hint)).toContain("write_file");
		expect(readFileSync(join(root, "test-skill", "SKILL.md"), "utf-8")).toBe(VALID_SKILL);
	});

	test("creates a skill under a category", () => {
		const result = manager.create("test-skill", VALID_SKILL, "devops");
		expect(result).toMatchObject({ success: true, category: "devops" });
		expect(existsSync(join(root, "devops", "test-skill", "SKILL.md"))).toBe(true);
	});

	test("rejects a duplicate name anywhere under the root", () => {
		manager.create("test-skill", VALID_SKILL, "devops");
		const result = manager.create("test-skill", VALID_SKILL);
		expect(result.success).toBe(false);
		expect(String(result.error)).toContain("already exists");
	});

	test("rejects invalid names, categories, missing content, and over-limit descriptions", () => {
		expect(manager.create("Bad Name", VALID_SKILL).success).toBe(false);
		expect(manager.create("ok-name", VALID_SKILL, "bad/category").success).toBe(false);
		expect(manager.create("ok-name", undefined).success).toBe(false);
		const longDesc = `---\nname: ok-name\ndescription: ${"d".repeat(80)}\n---\nbody`;
		expect(String(manager.create("ok-name", longDesc).error)).toContain("60-char");
	});

	test("rejects content over the size limit", () => {
		const huge = `${VALID_SKILL}\n${"x".repeat(MAX_SKILL_CONTENT_CHARS)}`;
		expect(String(manager.create("test-skill", huge).error)).toContain("limit: 100,000");
	});
});

describe("edit", () => {
	test("rewrites SKILL.md, validating frontmatter", () => {
		manager.create("test-skill", VALID_SKILL);
		const updated = VALID_SKILL.replace("Run the project test suite reliably.", "Run tests with retries.");
		expect(manager.edit("test-skill", updated)).toMatchObject({
			success: true,
			message: "Skill 'test-skill' updated (full rewrite).",
		});
		expect(readFileSync(join(root, "test-skill", "SKILL.md"), "utf-8")).toBe(updated);
		expect(String(manager.edit("test-skill", "no frontmatter").error)).toContain("YAML frontmatter");
	});

	test("errors on a missing skill", () => {
		expect(manager.edit("missing", VALID_SKILL)).toMatchObject({
			success: false,
			error: "Skill 'missing' not found.",
		});
	});
});

describe("patch", () => {
	beforeEach(() => {
		manager.create("test-skill", VALID_SKILL);
	});

	test("replaces a unique match in SKILL.md", () => {
		const result = manager.patch("test-skill", "- None known.", "- Flaky on Windows CI.");
		expect(result).toMatchObject({
			success: true,
			message: "Patched SKILL.md in skill 'test-skill' (1 replacement).",
		});
		expect(readFileSync(join(root, "test-skill", "SKILL.md"), "utf-8")).toContain("Flaky on Windows CI.");
	});

	test("requires a unique match unless replace_all", () => {
		const ambiguous = manager.patch("test-skill", "##", "###");
		expect(ambiguous.success).toBe(false);
		expect(String(ambiguous.error)).toContain("matches 4 times");
		const all = manager.patch("test-skill", "##", "###", undefined, true);
		expect(all).toMatchObject({ success: true, message: "Patched SKILL.md in skill 'test-skill' (4 replacements)." });
	});

	test("returns a file preview when the match is missing", () => {
		const result = manager.patch("test-skill", "text that is not there", "x");
		expect(result.success).toBe(false);
		expect(String(result.file_preview)).toContain("name: test-skill");
	});

	test("matches across CRLF/LF differences", () => {
		writeFileSync(join(root, "test-skill", "SKILL.md"), VALID_SKILL.replaceAll("\n", "\r\n"), "utf-8");
		const result = manager.patch("test-skill", "## Pitfalls\n- None known.", "## Pitfalls\n- Windows line endings.");
		expect(result.success).toBe(true);
	});

	test("refuses a patch that would break the frontmatter", () => {
		const result = manager.patch("test-skill", "description: Run the project test suite reliably.", "");
		expect(result.success).toBe(false);
		expect(String(result.error)).toContain("Patch would break SKILL.md structure");
	});

	test("patches a supporting file via file_path", () => {
		manager.writeFile("test-skill", "references/notes.md", "old note");
		const result = manager.patch("test-skill", "old note", "new note", "references/notes.md");
		expect(result).toMatchObject({
			success: true,
			message: "Patched references/notes.md in skill 'test-skill' (1 replacement).",
		});
		expect(readFileSync(join(root, "test-skill", "references", "notes.md"), "utf-8")).toBe("new note");
	});

	test("errors on missing old_string/new_string and missing files", () => {
		expect(String(manager.patch("test-skill", undefined, "x").error)).toContain("old_string is required");
		expect(String(manager.patch("test-skill", "x", undefined).error)).toContain("new_string is required");
		expect(manager.patch("test-skill", "a", "b", "references/missing.md").success).toBe(false);
	});
});

describe("delete", () => {
	test("deletes a skill and cleans up an empty category directory", () => {
		manager.create("test-skill", VALID_SKILL, "devops");
		expect(manager.delete("test-skill")).toMatchObject({ success: true, message: "Skill 'test-skill' deleted." });
		expect(existsSync(join(root, "devops"))).toBe(false);
	});

	test("keeps a category directory that still has other skills", () => {
		manager.create("skill-a", VALID_SKILL, "devops");
		manager.create("skill-b", VALID_SKILL.replace("test-skill", "skill-b"), "devops");
		manager.delete("skill-a");
		expect(existsSync(join(root, "devops", "skill-b", "SKILL.md"))).toBe(true);
	});

	test("errors on a missing skill", () => {
		expect(manager.delete("missing").success).toBe(false);
	});

	test("refuses to delete a symlinked skill directory", () => {
		const outside = mkdtempSync(join(tmpdir(), "learning-skills-outside-"));
		try {
			writeFileSync(join(outside, "SKILL.md"), VALID_SKILL, "utf-8");
			try {
				symlinkSync(outside, join(root, "test-skill"), "junction");
			} catch {
				return; // symlink creation not permitted in this environment; skip
			}
			const result = manager.delete("test-skill");
			expect(result.success).toBe(false);
			expect(String(result.error)).toContain("symlink");
			expect(existsSync(join(outside, "SKILL.md"))).toBe(true);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});
});

describe("write_file / remove_file", () => {
	beforeEach(() => {
		manager.create("test-skill", VALID_SKILL);
	});

	test("writes and removes a supporting file", () => {
		const write = manager.writeFile("test-skill", "templates/report.md", "# Template");
		expect(write).toMatchObject({
			success: true,
			message: "File 'templates/report.md' written to skill 'test-skill'.",
		});
		expect(readFileSync(join(root, "test-skill", "templates", "report.md"), "utf-8")).toBe("# Template");

		const remove = manager.removeFile("test-skill", "templates/report.md");
		expect(remove).toMatchObject({ success: true });
		expect(existsSync(join(root, "test-skill", "templates", "report.md"))).toBe(false);
	});

	test("lists available files when removing a missing one", () => {
		manager.writeFile("test-skill", "references/a.md", "a");
		manager.writeFile("test-skill", "scripts/b.sh", "b");
		const result = manager.removeFile("test-skill", "references/missing.md");
		expect(result.success).toBe(false);
		const available = result.available_files as string[];
		expect(available.some((p) => p.endsWith("a.md"))).toBe(true);
		expect(available.some((p) => p.endsWith("b.sh"))).toBe(true);
	});

	test("rejects disallowed directories and traversal", () => {
		expect(manager.writeFile("test-skill", "secrets/creds.md", "x").success).toBe(false);
		expect(manager.writeFile("test-skill", "../escape.md", "x").success).toBe(false);
	});

	test("rejects oversized files", () => {
		const result = manager.writeFile("test-skill", "references/big.md", "x".repeat(1_048_577));
		expect(String(result.error)).toContain("1 MiB");
	});

	test("validates frontmatter when overwriting SKILL.md through write_file", () => {
		const result = manager.writeFile("test-skill", "SKILL.md", "not a valid skill file");
		expect(result.success).toBe(false);
		expect(String(result.error)).toContain("YAML frontmatter");
	});

	test("errors when the skill does not exist", () => {
		const result = manager.writeFile("missing", "references/a.md", "x");
		expect(String(result.error)).toContain("Create it first with action='create'.");
	});
});

describe("findAndReplace", () => {
	test("counts and replaces occurrences", () => {
		expect(findAndReplace("a b a", "a", "c", false).error).toContain("matches 2 times");
		expect(findAndReplace("a b a", "a", "c", true)).toMatchObject({ content: "c b c", count: 2 });
		expect(findAndReplace("a b", "a", "c", false)).toMatchObject({ content: "c b", count: 1 });
		expect(findAndReplace("a b", "z", "c", false).error).toContain("old_string not found");
	});
});

describe("skillManageTool dispatch", () => {
	test("routes every action and rejects unknown ones", () => {
		expect(skillManageTool(manager, { action: "create", name: "test-skill", content: VALID_SKILL }).success).toBe(
			true,
		);
		expect(
			skillManageTool(manager, {
				action: "patch",
				name: "test-skill",
				old_string: "None known.",
				new_string: "One.",
			}).success,
		).toBe(true);
		expect(
			skillManageTool(manager, {
				action: "write_file",
				name: "test-skill",
				file_path: "references/x.md",
				file_content: "x",
			}).success,
		).toBe(true);
		expect(
			skillManageTool(manager, { action: "remove_file", name: "test-skill", file_path: "references/x.md" }).success,
		).toBe(true);
		expect(skillManageTool(manager, { action: "edit", name: "test-skill", content: VALID_SKILL }).success).toBe(true);
		expect(skillManageTool(manager, { action: "delete", name: "test-skill" }).success).toBe(true);
		expect(String(skillManageTool(manager, { action: "rename", name: "x" }).error)).toContain(
			"Unknown action 'rename'",
		);
	});
});
