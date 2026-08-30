import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { listSessions, projectDirName } from "../src/main/sessions.ts";

/**
 * The sidebar lists every chat, whatever folder it ran in: a folder is where
 * the agent works, not a compartment for chats, and hiding the rest reads as
 * having lost them. What does get dropped is a chat whose folder is gone,
 * which is how the throwaway sessions the test suite leaves behind in temp
 * directories stay out of the sidebar.
 */

let root: string;
let project: string;
let other: string;

function writeSession(cwd: string, name: string, text: string): void {
	const dir = join(root, projectDirName(cwd));
	mkdirSync(dir, { recursive: true });
	const lines = [
		JSON.stringify({ type: "session", id: `id-${name}`, cwd }),
		JSON.stringify({ type: "session_info", name }),
		JSON.stringify({ type: "message", message: { role: "user", content: text } }),
	];
	writeFileSync(join(dir, `${name}.jsonl`), `${lines.join("\n")}\n`);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "smolt-sessions-"));
	project = join(root, "project");
	other = join(root, "other");
	mkdirSync(project, { recursive: true });
	mkdirSync(other, { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("projectDirName", () => {
	test("encodes a Windows path the way the agent does", () => {
		expect(projectDirName("C:\\Users\\dev\\project")).toBe("--C--Users-dev-project--");
	});

	test("encodes a POSIX path without a leading separator", () => {
		expect(projectDirName("/home/dev/project")).toBe("--home-dev-project--");
	});
});

describe("listSessions", () => {
	test("lists chats from every folder, not just the active one", () => {
		writeSession(project, "mine", "hello from the project");
		writeSession(other, "theirs", "hello from somewhere else");

		const titles = listSessions(root, 50).map((row) => row.title);
		expect(titles.slice().sort()).toEqual(["mine", "theirs"]);
	});

	test("carries the folder each chat ran in", () => {
		writeSession(project, "mine", "hello");
		expect(listSessions(root, 50)[0]?.cwd).toBe(project);
	});

	test("drops chats whose folder has been deleted", () => {
		writeSession(project, "mine", "kept");
		writeSession(other, "theirs", "dropped");
		rmSync(other, { recursive: true, force: true });

		expect(listSessions(root, 50).map((row) => row.title)).toEqual(["mine"]);
	});

	test("falls back to the first user message when a session is unnamed", () => {
		const dir = join(root, projectDirName(project));
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "unnamed.jsonl"),
			`${JSON.stringify({ type: "session", id: "id-1", cwd: project })}\n${JSON.stringify({
				type: "message",
				message: { role: "user", content: "explain the retry logic" },
			})}\n`,
		);
		expect(listSessions(root, 50)[0]?.title).toBe("explain the retry logic");
	});

	test("honours the limit", () => {
		for (let i = 0; i < 5; i++) writeSession(project, `s${i}`, "x");
		expect(listSessions(root, 2)).toHaveLength(2);
	});
});
