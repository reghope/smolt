import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { filesCovered, reviewingBody } from "../src/extensions/review/index.ts";

/**
 * The line a pull request shows while a review runs. It exists because a review
 * of a 249-file pull request said "Reviewing this pull request now" and then
 * nothing for twenty minutes, which reads exactly like a review that has died.
 */
describe("review progress line", () => {
	it("says only what it knows when it has just started", () => {
		const body = reviewingBody("2026-09-10 18:35", { minutes: 0, findings: 0, covered: 0, total: 0 });
		expect(body).toContain("started 2026-09-10 18:35 UTC.");
		// No minutes, no files, and above all no estimate built on nothing.
		expect(body).not.toContain("minutes in");
		expect(body).not.toContain("files");
		expect(body).not.toContain("Estimated");
	});

	it("counts files and the share of them done", () => {
		const body = reviewingBody("2026-09-10 18:35", { minutes: 10, findings: 0, covered: 34, total: 249 });
		expect(body).toContain("10 minutes in");
		expect(body).toContain("34/249 files (14%)");
		expect(body).toContain("nothing recorded yet");
	});

	it("estimates the rest from the rate so far", () => {
		// 20 of 100 in 10 minutes: 80 left at 2 files a minute is 40 more.
		const body = reviewingBody("2026-09-10 18:35", { minutes: 10, findings: 2, covered: 20, total: 100 });
		expect(body).toContain("Estimated 40 more minutes");
		expect(body).toContain("2 findings so far");
	});

	it("holds the estimate back until there is a rate worth extrapolating", () => {
		// Two files in twenty minutes would promise the rest of the afternoon on
		// the strength of almost nothing.
		const early = reviewingBody("2026-09-10 18:35", { minutes: 20, findings: 0, covered: 2, total: 249 });
		expect(early).not.toContain("Estimated");
		// Nor when there is nothing left to estimate.
		const done = reviewingBody("2026-09-10 18:35", { minutes: 20, findings: 1, covered: 8, total: 8 });
		expect(done).not.toContain("Estimated");
	});

	it("says one finding, not 1 findings", () => {
		const body = reviewingBody("2026-09-10 18:35", { minutes: 1, findings: 1, covered: 0, total: 0 });
		expect(body).toContain("1 minute in");
		expect(body).toContain("1 finding so far");
	});
});

/** Files covered are read out of the review's own transcript. */
describe("files covered", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "smolt-review-progress-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("counts the changed files the transcript mentions", () => {
		const transcript = join(dir, "session.jsonl");
		writeFileSync(
			transcript,
			[
				JSON.stringify({ command: "sed -n 1,40p packages/desktop/src/main/main.ts" }),
				JSON.stringify({ command: "rg -n foo packages/coding-agent/src/extensions/review/watch.ts" }),
			].join("\n"),
			"utf-8",
		);

		const covered = filesCovered(transcript, [
			"packages/desktop/src/main/main.ts",
			"packages/coding-agent/src/extensions/review/watch.ts",
			"packages/ai/src/api/lazy.ts",
		]);

		expect(covered).toBe(2);
	});

	it("counts nothing when there is no transcript yet", () => {
		expect(filesCovered(undefined, ["packages/ai/src/api/lazy.ts"])).toBe(0);
		expect(filesCovered(join(dir, "not-written-yet.jsonl"), ["packages/ai/src/api/lazy.ts"])).toBe(0);
	});
});
