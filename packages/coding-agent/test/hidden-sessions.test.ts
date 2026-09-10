import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionHeader } from "../src/core/session-manager.ts";
import { getDefaultSessionDir, getHiddenSessionDir, SessionManager } from "../src/core/session-manager.ts";

/**
 * Hidden chats: a session an extension ran on the reader's behalf (the one
 * /review auto-fix uses) is kept, but stays out of every session list until
 * `showHiddenChats` turns it on. It lives one directory down, so listers that
 * read a project's `.jsonl` files skip it without being taught to.
 */
describe("hidden sessions", () => {
	let sessionDir: string;

	function writeSession(dir: string, id: string): void {
		const header: SessionHeader = {
			type: "session",
			id,
			version: 3,
			timestamp: new Date(0).toISOString(),
			cwd: "/tmp",
		};
		writeFileSync(join(dir, `${id}.jsonl`), `${JSON.stringify(header)}\n`, "utf8");
	}

	beforeEach(() => {
		sessionDir = mkdtempSync(join(tmpdir(), "smolt-hidden-"));
		mkdirSync(join(sessionDir, "hidden"), { recursive: true });
	});

	afterEach(() => rmSync(sessionDir, { recursive: true, force: true }));

	it("leaves hidden sessions out of the list", async () => {
		writeSession(sessionDir, "visible-one");
		writeSession(join(sessionDir, "hidden"), "hidden-one");

		const listed = await SessionManager.list("/tmp", sessionDir);
		expect(listed.map((session) => session.id)).toEqual(["visible-one"]);
	});

	it("returns hidden sessions when they are asked for", async () => {
		writeSession(sessionDir, "visible-one");
		writeSession(join(sessionDir, "hidden"), "hidden-one");

		const listed = await SessionManager.list("/tmp", sessionDir, undefined, { includeHidden: true });
		expect(listed.map((session) => session.id).sort()).toEqual(["hidden-one", "visible-one"]);
	});

	it("puts the hidden directory inside the project's own session directory", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "smolt-hidden-agent-"));
		try {
			expect(getHiddenSessionDir("/tmp", agentDir)).toBe(join(getDefaultSessionDir("/tmp", agentDir), "hidden"));
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
