import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ReviewStore, reviewTool } from "../src/extensions/review/store.ts";

/**
 * The review store is the record of what a review looked at and what
 * survived verification. These tests cover the round-trips, the quality bar
 * (no finding without a failure scenario), and the ratchet (a standing
 * finding from an earlier review of the same target bounces instead of
 * being re-reported).
 */

let dir: string;
let store: ReviewStore;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "review-store-"));
	store = new ReviewStore(join(dir, "review"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const finding = (over?: Record<string, unknown>) => ({
	action: "add_finding",
	title: "Null deref when config is missing",
	file: "src/config.ts",
	line: 42,
	severity: "major",
	category: "bug",
	confidence: "certain",
	claim: "loadConfig() dereferences parse(raw).options without a null check.",
	failure_scenario: "A config file containing only whitespace makes parse() return null; startup crashes.",
	evidence: "parse() returns null for empty input (parser.ts:12); loadConfig has no guard.",
	...over,
});

describe("reviews", () => {
	test("create, view, complete round-trip", () => {
		const review = store.createReview({ target: "feature-x", targetKey: "feature-x" });
		expect(review.status).toBe("reviewing");
		const started = reviewTool(store, finding({ review: review.slug }));
		expect(started.success).toBe(true);
		const done = reviewTool(store, { action: "complete", review: review.slug, summary: "One real bug." });
		expect(done.success).toBe(true);
		const viewed = store.viewReview(review.slug) as { status: string; open_findings: unknown[]; summary: string };
		expect(viewed.status).toBe("complete");
		expect(viewed.open_findings).toHaveLength(1);
		expect(viewed.summary).toBe("One real bug.");
	});

	test("empty ref resolves to the newest review", () => {
		store.createReview({ target: "a", targetKey: "a", now: new Date("2026-01-01T10:00:00Z") });
		const newer = store.createReview({ target: "b", targetKey: "b", now: new Date("2026-06-01T10:00:00Z") });
		expect(store.resolveReview("")?.slug).toBe(newer.slug);
	});
});

describe("quality bar", () => {
	test("a finding without a failure scenario is rejected", () => {
		const review = store.createReview({ target: "x", targetKey: "x" });
		const result = reviewTool(store, finding({ review: review.slug, failure_scenario: "" }));
		expect(result.success).toBe(false);
		expect(String(result.error)).toContain("failure_scenario");
	});

	test("a finding without evidence is rejected", () => {
		const review = store.createReview({ target: "x", targetKey: "x" });
		const result = reviewTool(store, finding({ review: review.slug, evidence: undefined }));
		expect(result.success).toBe(false);
		expect(String(result.error)).toContain("evidence");
	});

	test("finding round-trips its sections and line", () => {
		const review = store.createReview({ target: "x", targetKey: "x" });
		const added = reviewTool(store, finding({ review: review.slug, suggested_fix: "Guard the null." }));
		const full = store.readFinding(review.slug, String(added.finding));
		expect(full?.line).toBe(42);
		expect(full?.claim).toContain("dereferences");
		expect(full?.failureScenario).toContain("whitespace");
		expect(full?.suggestedFix).toBe("Guard the null.");
	});
});

describe("ratchet", () => {
	test("start reports standing findings from earlier reviews of the same target", () => {
		const first = store.createReview({ target: "feature-x", targetKey: "feature-x" });
		reviewTool(store, finding({ review: first.slug }));
		const started = reviewTool(store, { action: "start", target: "feature-x again", target_key: "feature-x" }) as {
			standing_findings: Array<{ finding: string }>;
		};
		expect(started.standing_findings).toHaveLength(1);
	});

	test("a standing finding bounces a re-report on a later review", () => {
		const first = store.createReview({ target: "feature-x", targetKey: "feature-x" });
		reviewTool(store, finding({ review: first.slug }));
		const second = store.createReview({
			target: "feature-x",
			targetKey: "feature-x",
			now: new Date("2026-06-01T10:00:00Z"),
		});
		const bounced = reviewTool(
			store,
			finding({ review: second.slug, title: "Null deref when the config file is missing" }),
		);
		expect(bounced.success).toBe(false);
		expect(bounced.from_review).toBe(first.slug);
		// force records it anyway; a different target key never bounces.
		const forced = reviewTool(store, finding({ review: second.slug, force: true }));
		expect(forced.success).toBe(true);
	});

	test("fixed findings stop bouncing and different files never match", () => {
		const first = store.createReview({ target: "feature-x", targetKey: "feature-x" });
		const added = reviewTool(store, finding({ review: first.slug }));
		store.updateFinding(first.slug, String(added.finding), "fixed");
		const second = store.createReview({
			target: "feature-x",
			targetKey: "feature-x",
			now: new Date("2026-06-01T10:00:00Z"),
		});
		expect(reviewTool(store, finding({ review: second.slug })).success).toBe(true);
		expect(reviewTool(store, finding({ review: second.slug, file: "src/other.ts" })).success).toBe(true);
	});
});

describe("dispatcher", () => {
	test("validates enums and unknown actions", () => {
		const review = store.createReview({ target: "x", targetKey: "x" });
		expect(reviewTool(store, finding({ review: review.slug, severity: "catastrophic" })).success).toBe(false);
		expect(reviewTool(store, { action: "update_finding", finding: "nope", status: "weird" }).success).toBe(false);
		expect(reviewTool(store, { action: "explode" }).success).toBe(false);
	});

	test("list counts open findings per review", () => {
		const review = store.createReview({ target: "x", targetKey: "x" });
		reviewTool(store, finding({ review: review.slug }));
		const listed = reviewTool(store, { action: "list" }) as {
			reviews: Array<{ open_findings: number; findings: number }>;
		};
		expect(listed.reviews[0]?.open_findings).toBe(1);
	});
});
