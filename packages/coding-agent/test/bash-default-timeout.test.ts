import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBashTool } from "../src/core/tools/bash.ts";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("");
}

describe("bash tool default timeout", () => {
	const testDirs: string[] = [];

	function makeTestDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "smolt-bash-default-timeout-"));
		testDirs.push(dir);
		return dir;
	}

	afterEach(() => {
		for (const dir of testDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("stops a call that omits the timeout after the configured default", async () => {
		const tool = createBashTool(makeTestDir(), { defaultTimeoutSeconds: 1 });
		await expect(tool.execute("t1", { command: "sleep 5" })).rejects.toThrow(/timed out after 1 seconds/);
	}, 15_000);

	it("still runs fast commands normally under a default timeout", async () => {
		const tool = createBashTool(makeTestDir(), { defaultTimeoutSeconds: 30 });
		const result = await tool.execute("t2", { command: "echo ok" });
		expect(textOf(result)).toContain("ok");
	}, 15_000);

	it("lets an explicit timeout override the default", async () => {
		const tool = createBashTool(makeTestDir(), { defaultTimeoutSeconds: 1 });
		const result = await tool.execute("t3", { command: "echo ok", timeout: 30 });
		expect(textOf(result)).toContain("ok");
	}, 15_000);

	it("keeps no default timeout when none is configured", async () => {
		const tool = createBashTool(makeTestDir());
		const result = await tool.execute("t4", { command: "echo ok" });
		expect(textOf(result)).toContain("ok");
	}, 15_000);
});
