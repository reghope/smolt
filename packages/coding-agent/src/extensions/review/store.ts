import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";

/**
 * Review: evidence-backed code-review findings, recorded as markdown in
 * this project's review store — `~/.smolt/projects/<project>/review/`,
 * outside the repo the same way battletest runs and wayfinder maps now are.
 *
 * A review holds the resolved target (what diff was looked at), the findings
 * that survived verification, and a closing summary. Findings follow the
 * house ticket shape — frontmatter plus `##` sections — and the store holds
 * the quality bar as machinery, not advice: a finding without a concrete
 * failure scenario and evidence is rejected at the door.
 *
 * The ratchet: reviews of the same target key (a branch, a PR, the working
 * tree) remember each other. A finding that matches a standing one from an
 * earlier review bounces with a pointer instead of being re-reported, so a
 * re-review speaks only about what is new — and marking a standing finding
 * 'fixed' when the code shows it gone is part of the job.
 */

export type FindingSeverity = "blocker" | "major" | "minor" | "polish";
export type FindingCategory =
	| "bug"
	| "security"
	| "data-loss"
	| "performance"
	| "api-compat"
	| "simplification"
	| "test-gap"
	| "other";
export type FindingConfidence = "certain" | "likely" | "possible";
export type FindingStatus = "open" | "fixed" | "wont-fix" | "stale";
export type ReviewStatus = "reviewing" | "complete";

export const FINDING_SEVERITIES: readonly FindingSeverity[] = ["blocker", "major", "minor", "polish"];
export const FINDING_CATEGORIES: readonly FindingCategory[] = [
	"bug",
	"security",
	"data-loss",
	"performance",
	"api-compat",
	"simplification",
	"test-gap",
	"other",
];
export const FINDING_CONFIDENCES: readonly FindingConfidence[] = ["certain", "likely", "possible"];
export const FINDING_STATUSES: readonly FindingStatus[] = ["open", "fixed", "wont-fix", "stale"];

export type ReviewResult = Record<string, unknown>;

export interface ReviewFinding {
	slug: string;
	title: string;
	/** Repo-relative path the finding anchors to. */
	file: string;
	/** 1-indexed line, when one line pins it down. */
	line?: number;
	severity: FindingSeverity;
	category: FindingCategory;
	confidence: FindingConfidence;
	status: FindingStatus;
	created: string;
	/** The defect, stated as a claim about behavior. */
	claim: string;
	/** Concrete inputs or state that produce the wrong outcome. Required. */
	failureScenario: string;
	/** What in the code supports the claim. Required. */
	evidence: string;
	suggestedFix?: string;
}

export interface Review {
	slug: string;
	title: string;
	/** The target as the user named it. */
	target: string;
	/**
	 * Normalized identity of what was reviewed — a branch name, `pr-123`,
	 * `worktree`, a commit range. Reviews sharing a key ratchet against each
	 * other.
	 */
	targetKey: string;
	status: ReviewStatus;
	created: string;
	updated: string;
	summary: string;
}

interface ReviewFrontmatter {
	title?: string;
	target?: string;
	targetKey?: string;
	status?: string;
	created?: string;
	updated?: string;
}

interface FindingFrontmatter {
	title?: string;
	file?: string;
	line?: number;
	severity?: string;
	category?: string;
	confidence?: string;
	status?: string;
	created?: string;
}

function err(error: string): ReviewResult {
	return { success: false, error };
}

function slugify(text: string): string {
	const slug = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64)
		.replace(/-+$/g, "");
	return slug || "item";
}

function atomicWrite(path: string, content: string): void {
	const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(temp, content, "utf-8");
	renameSync(temp, path);
}

function splitFrontmatter(content: string): { yaml: string | null; body: string } {
	const normalized = content.replace(/\r\n/g, "\n").replace(/^﻿/, "");
	if (!normalized.startsWith("---")) return { yaml: null, body: normalized };
	const end = normalized.indexOf("\n---", 3);
	if (end === -1) return { yaml: null, body: normalized };
	return { yaml: normalized.slice(4, end), body: normalized.slice(end + 4).trim() };
}

/** Split a markdown body into its `## Heading` sections. */
function parseSections(body: string): Record<string, string> {
	const sections: Record<string, string> = {};
	let current: string | undefined;
	let buffer: string[] = [];
	const flush = () => {
		if (current !== undefined) sections[current] = buffer.join("\n").trim();
		buffer = [];
	};
	for (const line of body.split("\n")) {
		const heading = /^## (.+)$/.exec(line);
		if (heading) {
			flush();
			current = heading[1]!.trim();
		} else if (current !== undefined) {
			buffer.push(line);
		}
	}
	flush();
	return sections;
}

const SEVERITY_ORDER: Record<FindingSeverity, number> = { blocker: 0, major: 1, minor: 2, polish: 3 };

function normText(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

function textTokens(text: string): Set<string> {
	return new Set(
		normText(text)
			.split(" ")
			.filter((word) => word.length > 2),
	);
}

/**
 * Whether two findings read like the same problem: same file and an
 * identical or mostly-overlapping title. Same trade-off as battletest's
 * matcher — a false match costs one `force` refile, a missed match costs one
 * duplicate comment.
 */
function sameFinding(candidate: { file: string; title: string }, existing: { file: string; title: string }): boolean {
	if (existing.file !== candidate.file) return false;
	if (normText(existing.title) === normText(candidate.title)) return true;
	const want = textTokens(candidate.title);
	if (want.size === 0) return false;
	const theirs = textTokens(existing.title);
	let overlap = 0;
	for (const word of want) if (theirs.has(word)) overlap++;
	const needed = Math.max(2, Math.ceil(Math.min(want.size, theirs.size) * 0.6));
	return overlap >= needed;
}

export class ReviewStore {
	readonly root: string;

	constructor(root: string) {
		this.root = root;
	}

	// ------------------------------------------------------------------
	// Disk layout:
	//   <root>/<review-slug>/review.md
	//   <root>/<review-slug>/findings/<slug>.md
	// ------------------------------------------------------------------

	private reviewDir(slug: string): string {
		return join(this.root, slug);
	}

	private findingsDir(slug: string): string {
		return join(this.reviewDir(slug), "findings");
	}

	readReview(slug: string): Review | undefined {
		const path = join(this.reviewDir(slug), "review.md");
		if (!existsSync(path)) return undefined;
		const { yaml, body } = splitFrontmatter(readFileSync(path, "utf-8"));
		const fm = (yaml ? (parse(yaml) as ReviewFrontmatter) : {}) ?? {};
		const sections = parseSections(body);
		return {
			slug,
			title: fm.title ?? slug,
			target: fm.target ?? "",
			targetKey: fm.targetKey ?? "",
			status: fm.status === "complete" ? "complete" : "reviewing",
			created: fm.created ?? "",
			updated: fm.updated ?? "",
			summary: sections.Summary ?? "",
		};
	}

	private writeReview(review: Review): void {
		mkdirSync(this.reviewDir(review.slug), { recursive: true });
		const frontmatter = stringify({
			title: review.title,
			target: review.target,
			targetKey: review.targetKey,
			status: review.status,
			created: review.created,
			updated: review.updated,
		});
		const body = review.summary === "" ? "" : `## Summary\n\n${review.summary}\n`;
		atomicWrite(join(this.reviewDir(review.slug), "review.md"), `---\n${frontmatter}---\n\n${body}`);
	}

	listReviewSlugs(): string[] {
		if (!existsSync(this.root)) return [];
		return readdirSync(this.root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && existsSync(join(this.root, entry.name, "review.md")))
			.map((entry) => entry.name)
			.sort();
	}

	listReviews(): Review[] {
		return this.listReviewSlugs()
			.map((slug) => this.readReview(slug))
			.filter((review): review is Review => review !== undefined);
	}

	/** The review a reference names: exact slug, else the newest when empty. */
	resolveReview(ref: string): Review | undefined {
		const needle = ref.trim();
		if (needle !== "") return this.readReview(needle) ?? this.readReview(slugify(needle));
		const slugs = this.listReviewSlugs();
		const last = slugs[slugs.length - 1];
		return last ? this.readReview(last) : undefined;
	}

	createReview(params: { target: string; targetKey: string; title?: string; now?: Date }): Review {
		const now = params.now ?? new Date();
		const stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
		const keyPart = slugify(params.targetKey).slice(0, 24);
		let slug = `${stamp}-${keyPart}`;
		for (let n = 2; this.readReview(slug); n++) slug = `${stamp}-${keyPart}-${n}`;
		const review: Review = {
			slug,
			title: params.title?.trim() || `Review: ${params.target}`,
			target: params.target.trim(),
			targetKey: params.targetKey.trim(),
			status: "reviewing",
			created: now.toISOString(),
			updated: now.toISOString(),
			summary: "",
		};
		this.writeReview(review);
		mkdirSync(this.findingsDir(slug), { recursive: true });
		return review;
	}

	// ------------------------------------------------------------------
	// Findings
	// ------------------------------------------------------------------

	readFinding(reviewSlug: string, findingSlug: string): ReviewFinding | undefined {
		const path = join(this.findingsDir(reviewSlug), `${findingSlug}.md`);
		if (!existsSync(path)) return undefined;
		const { yaml, body } = splitFrontmatter(readFileSync(path, "utf-8"));
		const fm = (yaml ? (parse(yaml) as FindingFrontmatter) : {}) ?? {};
		const sections = parseSections(body);
		const finding: ReviewFinding = {
			slug: findingSlug,
			title: fm.title ?? findingSlug,
			file: fm.file ?? "",
			severity: FINDING_SEVERITIES.includes(fm.severity as FindingSeverity)
				? (fm.severity as FindingSeverity)
				: "minor",
			category: FINDING_CATEGORIES.includes(fm.category as FindingCategory)
				? (fm.category as FindingCategory)
				: "other",
			confidence: FINDING_CONFIDENCES.includes(fm.confidence as FindingConfidence)
				? (fm.confidence as FindingConfidence)
				: "likely",
			status: FINDING_STATUSES.includes(fm.status as FindingStatus) ? (fm.status as FindingStatus) : "open",
			created: fm.created ?? "",
			claim: sections.Claim ?? "",
			failureScenario: sections["Failure scenario"] ?? "",
			evidence: sections.Evidence ?? "",
		};
		if (typeof fm.line === "number" && Number.isFinite(fm.line)) finding.line = fm.line;
		if (sections["Suggested fix"]) finding.suggestedFix = sections["Suggested fix"];
		return finding;
	}

	private writeFinding(reviewSlug: string, finding: ReviewFinding): void {
		mkdirSync(this.findingsDir(reviewSlug), { recursive: true });
		const fm: Record<string, unknown> = {
			title: finding.title,
			file: finding.file,
			severity: finding.severity,
			category: finding.category,
			confidence: finding.confidence,
			status: finding.status,
			created: finding.created,
		};
		if (finding.line !== undefined) fm.line = finding.line;
		const body =
			`## Claim\n\n${finding.claim}\n\n## Failure scenario\n\n${finding.failureScenario}\n\n` +
			`## Evidence\n\n${finding.evidence}\n` +
			(finding.suggestedFix ? `\n## Suggested fix\n\n${finding.suggestedFix}\n` : "");
		atomicWrite(join(this.findingsDir(reviewSlug), `${finding.slug}.md`), `---\n${stringify(fm)}---\n\n${body}`);
	}

	listFindings(reviewSlug: string): ReviewFinding[] {
		const dir = this.findingsDir(reviewSlug);
		if (!existsSync(dir)) return [];
		return readdirSync(dir)
			.filter((name) => name.endsWith(".md"))
			.sort()
			.map((name) => this.readFinding(reviewSlug, name.slice(0, -3)))
			.filter((finding): finding is ReviewFinding => finding !== undefined)
			.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.slug.localeCompare(b.slug));
	}

	/**
	 * A standing finding from an earlier review of the same target: open, in
	 * the same file, reading like the same problem. This is the ratchet — a
	 * re-review reports only what is new.
	 */
	findStandingFinding(
		targetKey: string,
		file: string,
		title: string,
		excludeReview?: string,
	): { review: string; finding: ReviewFinding } | undefined {
		const key = targetKey.trim();
		if (key === "") return undefined;
		for (const review of this.listReviews()) {
			if (review.slug === excludeReview || review.targetKey !== key) continue;
			for (const finding of this.listFindings(review.slug)) {
				if (finding.status !== "open") continue;
				if (sameFinding({ file, title }, finding)) return { review: review.slug, finding };
			}
		}
		return undefined;
	}

	addFinding(
		reviewSlug: string,
		params: {
			title: string;
			file: string;
			line?: number;
			severity: FindingSeverity;
			category: FindingCategory;
			confidence: FindingConfidence;
			claim: string;
			failureScenario: string;
			evidence: string;
			suggestedFix?: string;
		},
	): ReviewResult {
		const review = this.readReview(reviewSlug);
		if (!review) return err(`Unknown review '${reviewSlug}'`);
		const existing = new Set(this.listFindings(reviewSlug).map((finding) => finding.slug));
		let slug = slugify(params.title);
		for (let n = 2; existing.has(slug); n++) slug = `${slugify(params.title)}-${n}`;
		const finding: ReviewFinding = {
			slug,
			title: params.title.trim(),
			file: params.file.trim(),
			severity: params.severity,
			category: params.category,
			confidence: params.confidence,
			status: "open",
			created: new Date().toISOString(),
			claim: params.claim.trim(),
			failureScenario: params.failureScenario.trim(),
			evidence: params.evidence.trim(),
		};
		if (params.line !== undefined) finding.line = params.line;
		if (params.suggestedFix?.trim()) finding.suggestedFix = params.suggestedFix.trim();
		this.writeFinding(reviewSlug, finding);
		review.updated = new Date().toISOString();
		this.writeReview(review);
		return { success: true, review: reviewSlug, finding: slug };
	}

	updateFinding(reviewRef: string, findingRef: string, status: FindingStatus): ReviewResult {
		const review = this.resolveReview(reviewRef);
		if (!review) return err(`Unknown review '${reviewRef}'`);
		const finding =
			this.readFinding(review.slug, findingRef.trim()) ?? this.readFinding(review.slug, slugify(findingRef));
		if (!finding) {
			const slugs = this.listFindings(review.slug).map((entry) => entry.slug);
			return err(
				`Unknown finding '${findingRef}' on review '${review.slug}'. Findings: ${slugs.join(", ") || "(none)"}`,
			);
		}
		finding.status = status;
		this.writeFinding(review.slug, finding);
		return { success: true, review: review.slug, finding: finding.slug, status };
	}

	completeReview(reviewRef: string, summary: string): ReviewResult {
		const review = this.resolveReview(reviewRef);
		if (!review) return err(`Unknown review '${reviewRef}'`);
		review.summary = summary.trim();
		review.status = "complete";
		review.updated = new Date().toISOString();
		this.writeReview(review);
		return { success: true, review: review.slug };
	}

	/** The full picture of one review: target, findings by severity, summary. */
	viewReview(reviewRef: string): ReviewResult {
		const review = this.resolveReview(reviewRef);
		if (!review) {
			return err(`Unknown review '${reviewRef}'. Reviews: ${this.listReviewSlugs().join(", ") || "(none)"}`);
		}
		const findings = this.listFindings(review.slug);
		return {
			success: true,
			review: review.slug,
			title: review.title,
			target: review.target,
			target_key: review.targetKey,
			status: review.status,
			summary: review.summary,
			open_findings: findings
				.filter((finding) => finding.status === "open")
				.map((finding) => ({
					finding: finding.slug,
					title: finding.title,
					file: finding.file,
					...(finding.line !== undefined ? { line: finding.line } : {}),
					severity: finding.severity,
					category: finding.category,
					confidence: finding.confidence,
				})),
			closed_findings: findings
				.filter((finding) => finding.status !== "open")
				.map((finding) => ({ finding: finding.slug, title: finding.title, status: finding.status })),
		};
	}
}

// ------------------------------------------------------------------
// Tool dispatcher for the `review` tool: everything that only touches disk.
// ------------------------------------------------------------------

export interface ReviewToolParams {
	action?: string;
	review?: string | null;
	finding?: string | null;
	target?: string | null;
	target_key?: string | null;
	title?: string | null;
	file?: string | null;
	line?: number | null;
	severity?: string | null;
	category?: string | null;
	confidence?: string | null;
	claim?: string | null;
	failure_scenario?: string | null;
	evidence?: string | null;
	suggested_fix?: string | null;
	status?: string | null;
	summary?: string | null;
	force?: boolean | null;
}

export function reviewTool(store: ReviewStore, params: ReviewToolParams): ReviewResult {
	const action = params.action ?? "";
	const need = (name: keyof ReviewToolParams): string | undefined => {
		const value = params[name];
		return typeof value === "string" && value.trim() !== "" ? value : undefined;
	};

	switch (action) {
		case "list": {
			const reviews = store.listReviews().map((review) => {
				const findings = store.listFindings(review.slug);
				return {
					review: review.slug,
					title: review.title,
					target_key: review.targetKey,
					status: review.status,
					open_findings: findings.filter((finding) => finding.status === "open").length,
					findings: findings.length,
				};
			});
			return { success: true, reviews };
		}
		case "start": {
			const target = need("target");
			const targetKey = need("target_key");
			if (!target || !targetKey) return err("start requires 'target' and 'target_key'");
			const review = store.createReview({ target, targetKey, title: need("title") });
			const standing = store
				.listReviews()
				.filter((other) => other.slug !== review.slug && other.targetKey === review.targetKey)
				.flatMap((other) =>
					store
						.listFindings(other.slug)
						.filter((finding) => finding.status === "open")
						.map((finding) => ({
							review: other.slug,
							finding: finding.slug,
							title: finding.title,
							file: finding.file,
							severity: finding.severity,
						})),
				);
			return {
				success: true,
				review: review.slug,
				standing_findings: standing,
				note:
					standing.length === 0
						? "No earlier reviews of this target. Everything you find is new."
						: "Earlier reviews of this target left the standing findings above. Do NOT re-report them; " +
							"verify each against the current code and mark the ones that are gone 'fixed' with " +
							"update_finding. Report only what is new.",
			};
		}
		case "view":
			return store.viewReview(need("review") ?? "");
		case "view_finding": {
			const review = store.resolveReview(need("review") ?? "");
			if (!review) return err(`Unknown review '${need("review") ?? ""}'`);
			const finding = need("finding");
			if (!finding) return err("view_finding requires 'finding'");
			const full = store.readFinding(review.slug, finding);
			if (!full) return err(`Unknown finding '${finding}' on review '${review.slug}'`);
			return { success: true, review: review.slug, ...full };
		}
		case "add_finding": {
			const review = store.resolveReview(need("review") ?? "");
			if (!review) return err(`Unknown review '${need("review") ?? ""}'`);
			const missing = (["title", "file", "claim", "failure_scenario", "evidence"] as const).filter(
				(field) => need(field) === undefined,
			);
			if (missing.length > 0) {
				return err(
					`a finding needs: ${missing.join(", ")}. The failure scenario must name concrete inputs or ` +
						"state that produce the wrong outcome — a finding that cannot is not a finding.",
				);
			}
			const severity = need("severity") ?? "minor";
			const category = need("category") ?? "other";
			const confidence = need("confidence") ?? "likely";
			if (!FINDING_SEVERITIES.includes(severity as FindingSeverity)) {
				return err(`invalid severity '${severity}'; one of: ${FINDING_SEVERITIES.join(", ")}`);
			}
			if (!FINDING_CATEGORIES.includes(category as FindingCategory)) {
				return err(`invalid category '${category}'; one of: ${FINDING_CATEGORIES.join(", ")}`);
			}
			if (!FINDING_CONFIDENCES.includes(confidence as FindingConfidence)) {
				return err(`invalid confidence '${confidence}'; one of: ${FINDING_CONFIDENCES.join(", ")}`);
			}
			// The ratchet: a finding an earlier review of this target already
			// holds open is not re-reported, it is pointed at.
			if (params.force !== true) {
				const standing = store.findStandingFinding(
					review.targetKey,
					(need("file") ?? "").trim(),
					need("title") ?? "",
					review.slug,
				);
				if (standing) {
					return {
						success: false,
						standing_finding: standing.finding.slug,
						from_review: standing.review,
						message:
							`Review '${standing.review}' already holds this open as '${standing.finding.slug}'. ` +
							"Do not re-report it. If the current code shows it fixed, mark it with update_finding " +
							"status 'fixed'. Refile with force=true only if this is truly a different problem.",
					};
				}
			}
			const line = typeof params.line === "number" && Number.isFinite(params.line) ? params.line : undefined;
			return store.addFinding(review.slug, {
				title: need("title") ?? "",
				file: (need("file") ?? "").trim(),
				line,
				severity: severity as FindingSeverity,
				category: category as FindingCategory,
				confidence: confidence as FindingConfidence,
				claim: need("claim") ?? "",
				failureScenario: need("failure_scenario") ?? "",
				evidence: need("evidence") ?? "",
				suggestedFix: need("suggested_fix"),
			});
		}
		case "update_finding": {
			const finding = need("finding");
			const status = need("status");
			if (!finding || !status) return err("update_finding requires 'finding' and 'status'");
			if (!FINDING_STATUSES.includes(status as FindingStatus)) {
				return err(`invalid status '${status}'; one of: ${FINDING_STATUSES.join(", ")}`);
			}
			return store.updateFinding(need("review") ?? "", finding, status as FindingStatus);
		}
		case "complete": {
			const summary = need("summary");
			if (!summary) return err("complete requires 'summary'");
			return store.completeReview(need("review") ?? "", summary);
		}
		default:
			return err(
				`unknown action '${action}'; one of: list, start, view, view_finding, add_finding, update_finding, complete`,
			);
	}
}
