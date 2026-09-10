import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearReviewPending,
	listPendingReviews,
	MAX_REVIEW_ATTEMPTS,
	markReviewPending,
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
});
