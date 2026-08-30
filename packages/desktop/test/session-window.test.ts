import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readSessionMessages } from "../src/main/sessions.ts";

/**
 * A chat is rendered a page at a time. What matters here is that the pages
 * join up: the window has to know where it sits in the whole conversation, or
 * scrolling up asks for the wrong slice and a rewind names the wrong message.
 */

let root: string;
let file: string;

/** Twenty turns: a user message and a reply each, so indices are easy to read. */
function writeTranscript(turns: number): void {
	const lines: string[] = [JSON.stringify({ type: "session", id: "id", cwd: root })];
	for (let turn = 0; turn < turns; turn++) {
		lines.push(JSON.stringify({ type: "message", message: { role: "user", content: `ask ${turn}` } }));
		lines.push(JSON.stringify({ type: "message", message: { role: "assistant", content: `reply ${turn}` } }));
	}
	writeFileSync(file, `${lines.join("\n")}\n`);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "smolt-window-"));
	file = join(root, "chat.jsonl");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("readSessionMessages", () => {
	test("defaults to the newest page and says where it starts", () => {
		writeTranscript(20);
		const page = readSessionMessages(file, { limit: 6 });
		expect(page.messages).toHaveLength(6);
		expect(page.messages[0]).toMatchObject({ content: "ask 17" });
		expect(page.messages.at(-1)).toMatchObject({ content: "reply 19" });
		// 40 messages, the last 6 held: the window opens at 34.
		expect(page.start).toBe(34);
		// Turns 0..16 asked, and turn 17's own question is inside the window.
		expect(page.userStart).toBe(17);
	});

	test("the page above joins onto the one below it", () => {
		writeTranscript(20);
		const tail = readSessionMessages(file, { limit: 6 });
		const above = readSessionMessages(file, { limit: 6, before: tail.start });
		expect(above.start).toBe(28);
		expect(above.messages).toHaveLength(6);
		expect(above.messages.at(-1)).toMatchObject({ content: "reply 16" });
		expect(above.messages[0]).toMatchObject({ content: "ask 14" });
		expect(above.userStart).toBe(14);
	});

	test("a chat shorter than a page starts at the top", () => {
		writeTranscript(2);
		const page = readSessionMessages(file, { limit: 60 });
		expect(page.messages).toHaveLength(4);
		expect(page.start).toBe(0);
		expect(page.userStart).toBe(0);
	});

	test("paging past the top stops at it rather than going negative", () => {
		writeTranscript(4);
		const page = readSessionMessages(file, { limit: 6, before: 4 });
		expect(page.start).toBe(0);
		expect(page.userStart).toBe(0);
		expect(page.messages).toHaveLength(4);
		expect(page.messages.at(-1)).toMatchObject({ content: "reply 1" });
	});

	test("a missing file is an empty window, not a throw", () => {
		const page = readSessionMessages(join(root, "gone.jsonl"));
		expect(page).toEqual({ messages: [], start: 0, userStart: 0 });
	});
});
