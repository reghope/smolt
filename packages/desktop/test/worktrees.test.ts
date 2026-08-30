import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createWorktree, listWorktrees, removeWorktree, repoRoot, worktreeName } from "../src/main/worktrees.ts";

/**
 * Session isolation runs against real git: a worktree is only useful if the
 * agent's writes there genuinely leave the repository's checkout alone.
 */

let repo: string;

function git(args: string[], cwd = repo): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

beforeEach(() => {
	repo = mkdtempSync(join(tmpdir(), "smolt-wt-"));
	git(["init", "-q", "-b", "main"]);
	git(["config", "user.email", "test@example.invalid"]);
	git(["config", "user.name", "Test"]);
	writeFileSync(join(repo, "file.txt"), "original\n");
	git(["add", "."]);
	git(["commit", "-qm", "initial"]);
});

afterEach(() => {
	rmSync(repo, { recursive: true, force: true });
});

describe("worktreeName", () => {
	test("slugifies a session title", () => {
		expect(worktreeName("Fix the login bug!", "fallback")).toBe("fix-the-login-bug");
	});

	test("falls back when nothing usable remains", () => {
		expect(worktreeName("...", "fallback")).toBe("fallback");
	});

	test("bounds the length", () => {
		expect(worktreeName("a".repeat(80), "fallback").length).toBeLessThanOrEqual(40);
	});
});

describe("repoRoot", () => {
	test("finds the repository", async () => {
		expect(await repoRoot(repo)).toBeTruthy();
	});

	test("is undefined outside one", async () => {
		const plain = mkdtempSync(join(tmpdir(), "smolt-plain-"));
		try {
			expect(await repoRoot(plain)).toBeUndefined();
		} finally {
			rmSync(plain, { recursive: true, force: true });
		}
	});
});

describe("createWorktree", () => {
	test("creates a branch and checkout that isolate writes from the repository", async () => {
		const worktree = await createWorktree(repo, "My Session");
		expect(worktree.branch).toBe("smolt/my-session");

		// Writing inside the worktree must not touch the repository's copy.
		writeFileSync(join(worktree.path, "file.txt"), "changed by the agent\n");
		expect(readFileSync(join(repo, "file.txt"), "utf-8")).toBe("original\n");
	});

	test("does not collide when the same name is used twice", async () => {
		const first = await createWorktree(repo, "dup");
		const second = await createWorktree(repo, "dup");
		expect(second.name).not.toBe(first.name);
		expect(second.branch).not.toBe(first.branch);
	});

	test("refuses outside a repository", async () => {
		const plain = mkdtempSync(join(tmpdir(), "smolt-plain-"));
		try {
			await expect(createWorktree(plain, "x")).rejects.toThrow(/not a git repository/i);
		} finally {
			rmSync(plain, { recursive: true, force: true });
		}
	});
});

describe("listWorktrees", () => {
	test("reports the worktrees it created, with branches", async () => {
		await createWorktree(repo, "alpha");
		await createWorktree(repo, "beta");
		const names = (await listWorktrees(repo)).map((worktree) => worktree.name).sort();
		expect(names).toEqual(["alpha", "beta"]);
		expect((await listWorktrees(repo)).every((worktree) => worktree.branch.startsWith("smolt/"))).toBe(true);
	});

	test("is empty in a repository with none", async () => {
		expect(await listWorktrees(repo)).toEqual([]);
	});
});

describe("removeWorktree", () => {
	test("removes a clean worktree but keeps its branch", async () => {
		const worktree = await createWorktree(repo, "gone");
		await removeWorktree(repo, worktree.path);
		expect(await listWorktrees(repo)).toEqual([]);
		expect(git(["branch", "--list", worktree.branch])).toContain("smolt/gone");
	});

	test("refuses to discard uncommitted work unless forced", async () => {
		const worktree = await createWorktree(repo, "dirty");
		writeFileSync(join(worktree.path, "file.txt"), "unsaved\n");
		await expect(removeWorktree(repo, worktree.path)).rejects.toThrow(/uncommitted/i);
		await removeWorktree(repo, worktree.path, true);
		expect(await listWorktrees(repo)).toEqual([]);
	});
});
