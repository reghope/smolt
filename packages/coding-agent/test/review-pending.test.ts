import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearReviewPending,
	listPendingReviews,
	MAX_REVIEW_ATTEMPTS,
	markReviewPending,
	recordReviewSession,
} from "../src/extensions/review/config.ts";

/**
 * Reviews owed: a review runs for minutes in a hidden chat, and closing smolt
 * or a failed run ends it silently. What is owed survives on disk so the next
 * session picks it up.
 */
describe("pending reviews", () => {
	let agentDir: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "smolt-review-pending-"));
		previousAgentDir = process.env.SMOLT_CODING_AGENT_DIR;
		process.env.SMOLT_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		if (previousAgentDir === undefined) delete process.env.SMOLT_CODING_AGENT_DIR;
		else process.env.SMOLT_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("remembers a review that was started", () => {
		markReviewPending("owner/name", 11);
		expect(listPendingReviews()).toEqual([{ repo: "owner/name", number: 11, attempts: 1, at: expect.any(Number) }]);
	});

	it("counts every start of the same review", () => {
		markReviewPending("owner/name", 11);
		const second = markReviewPending("owner/name", 11);
		expect(second.attempts).toBe(2);
		expect(listPendingReviews()).toHaveLength(1);
	});

	it("forgets a review that was delivered", () => {
		markReviewPending("owner/name", 11);
		markReviewPending("owner/other", 4);
		clearReviewPending("owner/name", 11);
		expect(listPendingReviews().map((entry) => entry.number)).toEqual([4]);
	});

	it("gives up after the attempt limit", () => {
		let entry = markReviewPending("owner/name", 11);
		while (entry.attempts < MAX_REVIEW_ATTEMPTS) entry = markReviewPending("owner/name", 11);
		expect(entry.attempts).toBe(MAX_REVIEW_ATTEMPTS);
	});

	it("says nothing is owed when nothing was started", () => {
		expect(listPendingReviews()).toEqual([]);
	});

	it("remembers the transcript so a retry carries on in it", () => {
		// Reading a big pull request takes tens of minutes. A retry that starts a
		// new transcript reads all of it a second time; one that reopens this file
		// costs a single turn.
		const transcript = join(agentDir, "review-session.jsonl");
		writeFileSync(transcript, "{}\n", "utf-8");
		markReviewPending("owner/name", 11);
		recordReviewSession("owner/name", 11, transcript);

		const retry = markReviewPending("owner/name", 11);

		expect(retry.attempts).toBe(2);
		expect(retry.session).toBe(transcript);
		expect(listPendingReviews()[0]?.session).toBe(transcript);
	});

	it("forgets a transcript that is no longer on disk", () => {
		// Sessions are files someone may have cleared out between runs. Resuming
		// one that has gone would fail where starting again would have worked.
		const transcript = join(agentDir, "deleted-session.jsonl");
		writeFileSync(transcript, "{}\n", "utf-8");
		markReviewPending("owner/name", 11);
		recordReviewSession("owner/name", 11, transcript);
		rmSync(transcript);

		expect(listPendingReviews()[0]?.session).toBeUndefined();
	});

	it("does not record a transcript for a review nothing is owed on", () => {
		recordReviewSession("owner/name", 99, join(agentDir, "stray.jsonl"));
		expect(listPendingReviews()).toEqual([]);
	});
});
