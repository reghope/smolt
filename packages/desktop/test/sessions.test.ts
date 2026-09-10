import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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

	test("leaves hidden chats out of the sidebar", () => {
		writeSession(project, "mine", "an ordinary chat");
		const hidden = join(root, projectDirName(project), "hidden");
		mkdirSync(hidden, { recursive: true });
		const lines = [
			JSON.stringify({ type: "session", id: "id-autofix", cwd: project }),
			JSON.stringify({ type: "session_info", name: "autofix" }),
			JSON.stringify({ type: "message", message: { role: "user", content: "fixing what the review found" } }),
		];
		writeFileSync(join(hidden, "autofix.jsonl"), `${lines.join("\n")}\n`);

		expect(listSessions(root, 50).map((row) => row.title)).toEqual(["mine"]);
	});

	test("hides a chat a fork replaced, and keeps one still being used", () => {
		const dir = join(root, projectDirName(project));
		mkdirSync(dir, { recursive: true });
		const write = (name: string, entry: object): string => {
			const path = join(dir, `${name}.jsonl`);
			writeFileSync(
				path,
				`${JSON.stringify(entry)}\n${JSON.stringify({ type: "session_info", name: "Fix the retry logic" })}\n`,
			);
			return path;
		};
		const forkedAt = "2026-01-02T12:00:00.000Z";
		// Abandoned at the fork: its file has not been touched since.
		const abandoned = write("abandoned", {
			type: "session",
			id: "abandoned",
			cwd: project,
			timestamp: "2026-01-02T11:00:00.000Z",
		});
		utimesSync(abandoned, new Date(forkedAt), new Date(forkedAt));
		write("fork-of-abandoned", {
			type: "session",
			id: "fork-of-abandoned",
			cwd: project,
			timestamp: forkedAt,
			parentSession: abandoned,
		});
		// Carried on after the fork was taken, so it is a conversation of its own.
		const carriedOn = write("carried-on", {
			type: "session",
			id: "carried-on",
			cwd: project,
			timestamp: "2026-01-02T11:00:00.000Z",
		});
		write("fork-of-carried-on", {
			type: "session",
			id: "fork-of-carried-on",
			cwd: project,
			timestamp: forkedAt,
			parentSession: carriedOn,
		});

		const ids = listSessions(root, 50).map((row) => row.id);
		expect(ids).not.toContain("abandoned");
		expect(ids).toContain("carried-on");
		expect(ids).toContain("fork-of-abandoned");
		expect(ids).toContain("fork-of-carried-on");
	});

	test("keeps a chat whose parent is not listed", () => {
		const dir = join(root, projectDirName(project));
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "forked.jsonl"),
			`${JSON.stringify({
				type: "session",
				id: "id-2",
				cwd: project,
				parentSession: join(dir, "deleted.jsonl"),
			})}\n${JSON.stringify({ type: "session_info", name: "kept" })}\n`,
		);

		expect(listSessions(root, 50).map((row) => row.title)).toEqual(["kept"]);
	});

	test("carries the chat's own model and thinking level, latest wins", () => {
		const dir = join(root, projectDirName(project));
		mkdirSync(dir, { recursive: true });
		const lines = [
			JSON.stringify({ type: "session", id: "id-1", cwd: project }),
			JSON.stringify({ type: "model_change", provider: "anthropic", modelId: "claude-opus-5" }),
			JSON.stringify({ type: "thinking_level_change", thinkingLevel: "high" }),
			JSON.stringify({ type: "model_change", provider: "llama.cpp", modelId: "qwen3" }),
			JSON.stringify({ type: "thinking_level_change", thinkingLevel: "low" }),
		];
		writeFileSync(join(dir, "switched.jsonl"), `${lines.join("\n")}\n`);

		const row = listSessions(root, 50)[0];
		expect(row?.model).toBe("llama.cpp/qwen3");
		expect(row?.thinking).toBe("low");
	});

	test("leaves the model empty for a chat that never named one", () => {
		writeSession(project, "mine", "hello");
		expect(listSessions(root, 50)[0]?.model).toBe("");
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

	test("titles an unnamed session and keeps the first user message as its preview", () => {
		const dir = join(root, projectDirName(project));
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "unnamed.jsonl"),
			`${JSON.stringify({ type: "session", id: "id-1", cwd: project })}\n${JSON.stringify({
				type: "message",
				message: { role: "user", content: "explain the retry logic" },
			})}\n`,
		);
		const row = listSessions(root, 50)[0];
		expect(row?.title).toBe("New session");
		expect(row?.preview).toBe("explain the retry logic");
	});

	test("honours the limit", () => {
		for (let i = 0; i < 5; i++) writeSession(project, `s${i}`, "x");
		expect(listSessions(root, 2)).toHaveLength(2);
	});
});
