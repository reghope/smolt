import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	CLAIM_TTL_MS,
	type WayfinderSession,
	WayfinderStore,
	wayfinderTool,
} from "../src/extensions/wayfinder/store.ts";

/**
 * Unit tests for the wayfinder store: charting, ticket lifecycle, computed
 * frontier, claim arbitration, blocking validation, fog management, and the
 * one-decision-per-session guard in the tool dispatcher.
 */

let dir: string;
let store: WayfinderStore;
let session: WayfinderSession;

function run(params: Record<string, unknown>): Record<string, unknown> {
	return wayfinderTool(store, session, params);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "wayfinder-"));
	store = new WayfinderStore(join(dir, "wayfinder"));
	session = { id: "session-a", nonResearchResolutions: 0 };
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function chartFixture(): void {
	expect(
		run({
			action: "chart",
			title: "Payments Revamp",
			destination: "A locked provider decision and a migration spec.",
			notes: "Prefer boring tech.",
			fog: ["How refunds interact with the ledger rewrite"],
		}).success,
	).toBe(true);
	expect(
		run({
			action: "add_ticket",
			map: "payments-revamp",
			title: "Compare Stripe and Adyen fees",
			type: "research",
			question: "Which provider is cheaper at our volume?",
		}).success,
	).toBe(true);
	expect(
		run({
			action: "add_ticket",
			map: "payments-revamp",
			title: "Pick the provider",
			type: "grilling",
			question: "Which provider do we commit to?",
			blocked_by: ["compare-stripe-and-adyen-fees"],
		}).success,
	).toBe(true);
}

describe("charting", () => {
	test("creates a map file and refuses duplicates", () => {
		chartFixture();
		const raw = readFileSync(join(dir, "wayfinder", "payments-revamp", "map.md"), "utf-8");
		expect(raw).toContain("## Destination");
		expect(raw).toContain("A locked provider decision");
		const dup = run({ action: "chart", title: "Payments Revamp", destination: "x" });
		expect(dup.success).toBe(false);
	});

	test("list summarizes maps with computed counts", () => {
		chartFixture();
		const result = run({ action: "list" });
		const maps = result.maps as Array<Record<string, unknown>>;
		expect(maps).toHaveLength(1);
		expect(maps[0]).toMatchObject({ map: "payments-revamp", status: "active", open: 2, frontier: 1, fog: 1 });
	});
});

describe("frontier and blocking", () => {
	test("blocked tickets stay off the frontier until blockers close", () => {
		chartFixture();
		const view = run({ action: "view", map: "payments-revamp" });
		const frontier = view.frontier as Array<Record<string, unknown>>;
		expect(frontier.map((t) => t.ticket)).toEqual(["compare-stripe-and-adyen-fees"]);
		const blocked = view.blocked as Array<Record<string, unknown>>;
		expect(blocked[0]).toMatchObject({ ticket: "pick-the-provider", waiting_on: ["compare-stripe-and-adyen-fees"] });
	});

	test("rejects unknown blockers and blocking cycles", () => {
		chartFixture();
		const unknown = run({
			action: "add_ticket",
			map: "payments-revamp",
			title: "Ghost",
			type: "task",
			question: "q",
			blocked_by: ["does-not-exist"],
		});
		expect(unknown.success).toBe(false);
		const cycle = run({
			action: "update_ticket",
			map: "payments-revamp",
			ticket: "compare-stripe-and-adyen-fees",
			blocked_by: ["pick-the-provider"],
		});
		expect(cycle.success).toBe(false);
		expect(String(cycle.error)).toContain("cycle");
		const self = run({
			action: "update_ticket",
			map: "payments-revamp",
			ticket: "pick-the-provider",
			blocked_by: ["pick-the-provider"],
		});
		expect(self.success).toBe(false);
	});

	test("claiming a blocked ticket is refused", () => {
		chartFixture();
		const result = run({ action: "claim", map: "payments-revamp", ticket: "pick-the-provider" });
		expect(result.success).toBe(false);
		expect(String(result.error)).toContain("blocked");
	});
});

describe("claims", () => {
	test("a fresh foreign claim blocks, a stale one does not", () => {
		chartFixture();
		expect(run({ action: "claim", map: "payments-revamp", ticket: "compare-stripe-and-adyen-fees" }).success).toBe(
			true,
		);

		session = { id: "session-b", nonResearchResolutions: 0 };
		const refused = run({ action: "claim", map: "payments-revamp", ticket: "compare-stripe-and-adyen-fees" });
		expect(refused.success).toBe(false);
		expect(String(refused.error)).toContain("another session");

		// Age the claim past the TTL by rewriting claimedAt through the public API surface:
		// stale claims also drop the ticket back onto the frontier.
		const stale = new Date(Date.now() - CLAIM_TTL_MS - 1000).toISOString();
		const path = join(dir, "wayfinder", "payments-revamp", "tickets", "compare-stripe-and-adyen-fees.md");
		const raw = readFileSync(path, "utf-8");
		writeFileSync(path, raw.replace(/claimedAt: .+/, `claimedAt: "${stale}"`), "utf-8");

		expect(store.frontier("payments-revamp").map((t) => t.slug)).toContain("compare-stripe-and-adyen-fees");
		expect(run({ action: "claim", map: "payments-revamp", ticket: "compare-stripe-and-adyen-fees" }).success).toBe(
			true,
		);
	});

	test("release clears a claim", () => {
		chartFixture();
		run({ action: "claim", map: "payments-revamp", ticket: "compare-stripe-and-adyen-fees" });
		expect(store.frontier("payments-revamp")).toHaveLength(0);
		expect(run({ action: "release", map: "payments-revamp", ticket: "compare-stripe-and-adyen-fees" }).success).toBe(
			true,
		);
		expect(store.frontier("payments-revamp").map((t) => t.slug)).toContain("compare-stripe-and-adyen-fees");
	});
});

describe("resolution", () => {
	test("requires a claim, closes the ticket, and reports newly unblocked tickets", () => {
		chartFixture();
		const unclaimed = run({
			action: "resolve",
			map: "payments-revamp",
			ticket: "compare-stripe-and-adyen-fees",
			resolution: "Adyen is 12% cheaper at our volume.",
		});
		expect(unclaimed.success).toBe(false);
		expect(String(unclaimed.error)).toContain("Claim");

		run({ action: "claim", map: "payments-revamp", ticket: "compare-stripe-and-adyen-fees" });
		const resolved = run({
			action: "resolve",
			map: "payments-revamp",
			ticket: "compare-stripe-and-adyen-fees",
			resolution: "Adyen is 12% cheaper at our volume.",
			gist: "Adyen is cheaper",
		});
		expect(resolved.success).toBe(true);
		expect(resolved.newly_unblocked).toEqual(["pick-the-provider"]);

		const view = run({ action: "view", map: "payments-revamp" });
		const decisions = view.decisions_so_far as Array<Record<string, unknown>>;
		expect(decisions[0]).toMatchObject({ ticket: "compare-stripe-and-adyen-fees", gist: "Adyen is cheaper" });
		const ticket = run({ action: "view_ticket", map: "payments-revamp", ticket: "compare-stripe-and-adyen-fees" });
		expect(ticket).toMatchObject({ status: "closed", outcome: "resolved" });
		expect(String(ticket.resolution)).toContain("12% cheaper");
	});

	test("resolving a decision points at research tickets still takeable this session", () => {
		chartFixture();
		run({
			action: "add_ticket",
			map: "payments-revamp",
			title: "Survey migration tooling",
			type: "research",
			question: "What tooling exists for provider migration?",
			blocked_by: ["pick-the-provider"],
		});
		run({ action: "claim", map: "payments-revamp", ticket: "compare-stripe-and-adyen-fees" });
		run({ action: "resolve", map: "payments-revamp", ticket: "compare-stripe-and-adyen-fees", resolution: "Adyen." });
		run({ action: "claim", map: "payments-revamp", ticket: "pick-the-provider" });
		const resolved = run({
			action: "resolve",
			map: "payments-revamp",
			ticket: "pick-the-provider",
			resolution: "We commit to Adyen.",
		});
		expect(resolved.success).toBe(true);
		expect(resolved.research_takeable).toEqual(["survey-migration-tooling"]);
		expect(String(resolved.next)).toContain("exempt");
	});

	test("enforces one non-research decision per session, with an explicit override", () => {
		chartFixture();
		// Research resolutions never count against the limit.
		run({ action: "claim", map: "payments-revamp", ticket: "compare-stripe-and-adyen-fees" });
		run({
			action: "resolve",
			map: "payments-revamp",
			ticket: "compare-stripe-and-adyen-fees",
			resolution: "Adyen is cheaper.",
		});
		expect(session.nonResearchResolutions).toBe(0);

		run({ action: "claim", map: "payments-revamp", ticket: "pick-the-provider" });
		expect(
			run({
				action: "resolve",
				map: "payments-revamp",
				ticket: "pick-the-provider",
				resolution: "We commit to Adyen.",
			}).success,
		).toBe(true);
		expect(session.nonResearchResolutions).toBe(1);

		run({
			action: "add_ticket",
			map: "payments-revamp",
			title: "Choose rollout order",
			type: "grilling",
			question: "Which market migrates first?",
		});
		run({ action: "claim", map: "payments-revamp", ticket: "choose-rollout-order" });
		const second = run({
			action: "resolve",
			map: "payments-revamp",
			ticket: "choose-rollout-order",
			resolution: "EU first.",
		});
		expect(second.success).toBe(false);
		expect(String(second.error)).toContain("per session");

		const overridden = run({
			action: "resolve",
			map: "payments-revamp",
			ticket: "choose-rollout-order",
			resolution: "EU first.",
			override_session_limit: true,
		});
		expect(overridden.success).toBe(true);
	});
});

describe("fog and scope", () => {
	test("fog graduates via update_map and completion requires an empty map", () => {
		chartFixture();
		const premature = run({ action: "update_map", map: "payments-revamp", status: "complete" });
		expect(premature.success).toBe(false);
		expect(String(premature.error)).toContain("open tickets");

		run({ action: "claim", map: "payments-revamp", ticket: "compare-stripe-and-adyen-fees" });
		run({ action: "resolve", map: "payments-revamp", ticket: "compare-stripe-and-adyen-fees", resolution: "Adyen." });
		run({ action: "claim", map: "payments-revamp", ticket: "pick-the-provider" });
		run({ action: "resolve", map: "payments-revamp", ticket: "pick-the-provider", resolution: "Adyen." });

		const foggy = run({ action: "update_map", map: "payments-revamp", status: "complete" });
		expect(foggy.success).toBe(false);
		expect(String(foggy.error)).toContain("fog");

		const graduated = run({ action: "update_map", map: "payments-revamp", remove_fog: ["refunds"] });
		expect(graduated.success).toBe(true);
		expect(graduated.fog).toEqual([]);
		expect(run({ action: "update_map", map: "payments-revamp", status: "complete" }).success).toBe(true);
	});

	test("ambiguous or missing fog removals are refused", () => {
		chartFixture();
		run({ action: "update_map", map: "payments-revamp", add_fog: ["How refunds are reported to finance"] });
		expect(run({ action: "update_map", map: "payments-revamp", remove_fog: ["refunds"] }).success).toBe(false);
		expect(run({ action: "update_map", map: "payments-revamp", remove_fog: ["nope"] }).success).toBe(false);
	});

	test("scope_out closes a ticket off the route and records it on the map", () => {
		chartFixture();
		const result = run({
			action: "scope_out",
			map: "payments-revamp",
			ticket: "pick-the-provider",
			reason: "Provider choice was made by finance last week.",
		});
		expect(result.success).toBe(true);
		const view = run({ action: "view", map: "payments-revamp" });
		expect((view.out_of_scope as string[])[0]).toContain("finance");
		expect(view.decisions_so_far).toEqual([]);
		const ticket = run({ action: "view_ticket", map: "payments-revamp", ticket: "pick-the-provider" });
		expect(ticket).toMatchObject({ status: "closed", outcome: "out-of-scope" });
	});

	test("a resolved ticket cannot be retroactively scoped out", () => {
		chartFixture();
		run({ action: "claim", map: "payments-revamp", ticket: "compare-stripe-and-adyen-fees" });
		run({ action: "resolve", map: "payments-revamp", ticket: "compare-stripe-and-adyen-fees", resolution: "Adyen." });
		const result = run({
			action: "scope_out",
			map: "payments-revamp",
			ticket: "compare-stripe-and-adyen-fees",
			reason: "no longer needed",
		});
		expect(result.success).toBe(false);
	});
});

describe("lookup and errors", () => {
	test("maps and tickets resolve by title as well as slug", () => {
		chartFixture();
		expect(run({ action: "view", map: "Payments Revamp" }).success).toBe(true);
		expect(run({ action: "view_ticket", map: "payments-revamp", ticket: "Pick the provider" }).success).toBe(true);
	});

	test("unknown maps, tickets, and actions return guidance", () => {
		expect(String(run({ action: "view", map: "nope" }).error)).toContain("No wayfinder maps exist");
		chartFixture();
		expect(String(run({ action: "view", map: "nope" }).error)).toContain("payments-revamp");
		expect(String(run({ action: "view_ticket", map: "payments-revamp", ticket: "nope" }).error)).toContain(
			"Unknown ticket",
		);
		expect(String(run({ action: "explode" }).error)).toContain("unknown action");
		expect(run({ action: "chart", title: "x" }).success).toBe(false);
	});
});
