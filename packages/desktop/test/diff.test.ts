import { describe, expect, test } from "vitest";
import {
	additionHunk,
	attributeChanges,
	baseBranchAmong,
	changedBetween,
	classifyToolCall,
	countLines,
	parseDiff,
	parseNumstat,
	toGitPath,
	webUrlOf,
} from "../src/main/diff.ts";

/**
 * Splitting `git diff` output into per-file entries for the changes pane.
 * The counts drive the +/− badges, so they must ignore the `---`/`+++`
 * file headers that would otherwise read as one added and one removed line.
 */

const SAMPLE = `diff --git a/src/app.ts b/src/app.ts
index 1234567..89abcde 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,5 @@
 import { start } from "./start.ts";
-const port = 3000;
+const port = Number(process.env.PORT ?? 3000);
+const host = "0.0.0.0";
 start(port);
diff --git a/README.md b/README.md
new file mode 100644
index 0000000..fedcba9
--- /dev/null
+++ b/README.md
@@ -0,0 +1,2 @@
+# Project
+Docs.
`;

describe("parseDiff", () => {
	test("returns one entry per file", () => {
		expect(parseDiff(SAMPLE).map((file) => file.path)).toEqual(["src/app.ts", "README.md"]);
	});

	test("counts changed lines without counting the file headers", () => {
		const [app] = parseDiff(SAMPLE);
		expect(app?.added).toBe(2);
		expect(app?.removed).toBe(1);
	});

	test("recognises a new file", () => {
		const readme = parseDiff(SAMPLE)[1];
		expect(readme?.status).toBe("added");
		expect(readme?.added).toBe(2);
		expect(readme?.removed).toBe(0);
	});

	test("keeps the hunk body for rendering", () => {
		const [app] = parseDiff(SAMPLE);
		expect(app?.hunks).toContain("@@ -1,4 +1,5 @@");
		expect(app?.hunks).toContain('+const host = "0.0.0.0";');
	});

	test("marks a deleted file", () => {
		const deleted = `diff --git a/old.ts b/old.ts
deleted file mode 100644
index 1234567..0000000
--- a/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-const gone = true;
-export default gone;
`;
		const [file] = parseDiff(deleted);
		expect(file?.status).toBe("deleted");
		expect(file?.removed).toBe(2);
	});

	test("marks a rename", () => {
		const renamed = `diff --git a/a.ts b/b.ts
similarity index 95%
rename from a.ts
rename to b.ts
index 1234567..89abcde 100644
--- a/a.ts
+++ b/b.ts
@@ -1 +1 @@
-const name = "a";
+const name = "b";
`;
		expect(parseDiff(renamed)[0]?.status).toBe("renamed");
	});

	test("is empty for an unchanged tree", () => {
		expect(parseDiff("")).toEqual([]);
	});
});

describe("baseline subtraction", () => {
	/**
	 * A chat should report what it changed, not what it walked in on. Without a
	 * baseline, opening a fresh chat in a repository with uncommitted work
	 * showed a changes bar for edits it had nothing to do with.
	 */
	const files = parseDiff(SAMPLE);
	const appFile = files.find((file) => file.path === "src/app.ts")!;

	test("a file untouched since the chat opened is not the chat's doing", () => {
		const baseline = new Map(files.map((file) => [file.path, file.hunks]));
		expect(attributeChanges(files, baseline).mine).toEqual([]);
		expect(attributeChanges(files, baseline).preexisting).toBe(files.length);
	});

	test("a file the chat edited further still counts, even if it was already dirty", () => {
		const baseline = new Map([[appFile.path, "an older diff body"]]);
		expect(attributeChanges([appFile], baseline).mine.map((file) => file.path)).toEqual(["src/app.ts"]);
	});

	test("a file that did not exist at the baseline counts", () => {
		expect(attributeChanges(files, new Map()).mine.length).toBe(files.length);
	});

	test("without a baseline everything counts, as before", () => {
		expect(attributeChanges(files).mine.length).toBe(files.length);
	});
});

describe("turn attribution", () => {
	/**
	 * Differing from the chat-open snapshot is not enough: the tree also moves
	 * under editors, builds and other sessions while a chat sits open, and those
	 * edits kept resurrecting the composer's review bar. Only files an agent
	 * turn moved belong to the chat.
	 */
	const files = parseDiff(SAMPLE);
	const appFile = files.find((file) => file.path === "src/app.ts")!;
	const readme = files.find((file) => file.path === "README.md")!;
	const emptyBaseline = new Map<string, string>();

	test("an outside edit is changed-since-open but not the chat's", () => {
		const { mine } = attributeChanges(files, emptyBaseline, { paths: new Set() });
		expect(mine).toEqual([]);
	});

	test("a file a settled turn touched is the chat's", () => {
		const { mine } = attributeChanges(files, emptyBaseline, { paths: new Set([appFile.path]) });
		expect(mine.map((file) => file.path)).toEqual(["src/app.ts"]);
	});

	test("a running turn's edits count live, via the turn-start snapshot", () => {
		const turnStart = new Map([[appFile.path, appFile.hunks]]); // README.md appeared mid-turn
		const { mine } = attributeChanges(files, emptyBaseline, { paths: new Set(), turnStart });
		expect(mine.map((file) => file.path)).toEqual(["README.md"]);
	});

	test("an attributed file reverted back to the baseline drops out", () => {
		const baseline = new Map([[readme.path, readme.hunks]]);
		const { mine } = attributeChanges([readme], baseline, { paths: new Set([readme.path]) });
		expect(mine).toEqual([]);
	});
});

describe("changedBetween", () => {
	test("reports moved, appeared and vanished paths, and skips untouched ones", () => {
		const before = new Map([
			["same.ts", "@@ unchanged"],
			["moved.ts", "@@ old"],
			["gone.ts", "@@ deleted body"],
		]);
		const after = new Map([
			["same.ts", "@@ unchanged"],
			["moved.ts", "@@ new"],
			["new.ts", "@@ created"],
		]);
		expect(changedBetween(before, after).sort()).toEqual(["gone.ts", "moved.ts", "new.ts"]);
	});

	test("identical snapshots attribute nothing", () => {
		const snapshot = new Map([["a.ts", "@@ body"]]);
		expect(changedBetween(snapshot, new Map(snapshot))).toEqual([]);
	});
});

describe("classifyToolCall", () => {
	/**
	 * Attribution follows what a turn ran, not its wall-clock window: a turn
	 * that only read or talked must not be blamed for edits landing from
	 * elsewhere while it happened to be running.
	 */
	test("edit and write name their target, from object or JSON-string arguments", () => {
		expect(classifyToolCall("edit", { path: "src/a.ts", edits: [] })).toEqual({
			target: "src/a.ts",
			sweeping: false,
		});
		expect(classifyToolCall("write", '{"path":"b.ts","content":"x"}')).toEqual({ target: "b.ts", sweeping: false });
		expect(classifyToolCall("edit", { file_path: "c.ts" })).toEqual({ target: "c.ts", sweeping: false });
	});

	test("shell tools sweep: they can write anywhere", () => {
		expect(classifyToolCall("bash", { command: "npm test" }).sweeping).toBe(true);
		expect(classifyToolCall("powershell", "{}").sweeping).toBe(true);
	});

	test("read-only and unknown tools attribute nothing", () => {
		for (const name of ["read", "grep", "find", "ls", "telegram", "unheard_of"]) {
			expect(classifyToolCall(name, {})).toEqual({ sweeping: false });
		}
	});

	test("a writer with unreadable arguments falls back to sweeping", () => {
		expect(classifyToolCall("edit", "not json").sweeping).toBe(true);
		expect(classifyToolCall("write", undefined).sweeping).toBe(true);
	});
});

describe("webUrlOf", () => {
	test("turns an ssh remote into its browsable form", () => {
		expect(webUrlOf("git@github.com:reghope/smolt.git")).toBe("https://github.com/reghope/smolt");
	});

	test("keeps an https remote, without the .git suffix", () => {
		expect(webUrlOf("https://github.com/reghope/smolt.git")).toBe("https://github.com/reghope/smolt");
		expect(webUrlOf("https://github.com/reghope/smolt\n")).toBe("https://github.com/reghope/smolt");
	});

	test("declines a remote it cannot turn into a URL", () => {
		expect(webUrlOf("/srv/git/local.git")).toBeUndefined();
	});
});

describe("toGitPath", () => {
	test("resolves relative tool paths against the cwd and reports them from the repo root", () => {
		expect(toGitPath("src/a.ts", "/repo", "/repo")).toBe("src/a.ts");
		expect(toGitPath("../shared/x.ts", "/repo/packages/desktop", "/repo")).toBe("packages/shared/x.ts");
	});

	test("normalises separators to git's forward slashes", () => {
		expect(toGitPath("src\\deep\\a.ts", "/repo", "/repo")).toBe("src/deep/a.ts");
	});
});

describe("countLines", () => {
	test("counts newline-terminated lines", () => {
		expect(countLines(Buffer.from("a\nb\nc\n"))).toBe(3);
	});

	test("a last line without a newline still counts, as git counts it", () => {
		expect(countLines(Buffer.from("a\nb\nc"))).toBe(3);
	});

	test("an empty file has no lines", () => {
		expect(countLines(Buffer.from(""))).toBe(0);
	});

	test("a NUL near the start means binary, which has no lines to count", () => {
		expect(countLines(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0a, 0x00, 0x0a]))).toBeUndefined();
	});
});

describe("additionHunk", () => {
	test("renders a new file as one hunk of added lines", () => {
		expect(additionHunk("a\nb\n")).toBe("@@ -0,0 +1,2 @@\n+a\n+b\n");
	});

	test("says when the file has no newline at its end", () => {
		expect(additionHunk("a\nb")).toBe("@@ -0,0 +1,2 @@\n+a\n+b\n\\ No newline at end of file\n");
	});

	test("an empty file has no hunk", () => {
		expect(additionHunk("")).toBe("");
	});
});

describe("parseNumstat", () => {
	test("totals lines and files, treating a binary file as changed without lines", () => {
		const raw = "12\t3\tsrc/a.ts\n-\t-\timage.png\n0\t0\told.ts => new.ts\n";
		expect(parseNumstat(raw)).toEqual({ changed: 3, added: 12, removed: 3 });
	});

	test("an empty diff totals nothing", () => {
		expect(parseNumstat("")).toEqual({ changed: 0, added: 0, removed: 0 });
	});
});

describe("baseBranchAmong", () => {
	test("prefers the remote's own default", () => {
		const listing = "origin/HEAD\torigin/develop\norigin/main\t\nmain\t\n";
		expect(baseBranchAmong(listing, "feature")).toBe("origin/develop");
	});

	test("falls back through the usual names, remote first", () => {
		expect(baseBranchAmong("main\t\norigin/master\t\n", "feature")).toBe("origin/master");
		expect(baseBranchAmong("main\t\n", "feature")).toBe("main");
	});

	test("a branch is never its own base", () => {
		expect(baseBranchAmong("origin/main\t\nmain\t\n", "main")).toBeUndefined();
	});

	test("nothing listed means no base", () => {
		expect(baseBranchAmong("", "feature")).toBeUndefined();
	});
});
