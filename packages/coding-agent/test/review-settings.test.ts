import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadReviewSettings, reviewSettingsFile, saveReviewSettings } from "../src/extensions/review/config.ts";

/**
 * Review settings: auto-fix is off until it is asked for, and a project cannot
 * ask for it. A cloned repository must not be able to turn on a mode that
 * edits the reader's working tree, or point a webhook at their account, by
 * shipping a .smolt/review.json.
 */
describe("review settings", () => {
	let agentDir: string;
	let project: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "smolt-review-agent-"));
		project = mkdtempSync(join(tmpdir(), "smolt-review-project-"));
		previousAgentDir = process.env.SMOLT_CODING_AGENT_DIR;
		process.env.SMOLT_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		if (previousAgentDir === undefined) delete process.env.SMOLT_CODING_AGENT_DIR;
		else process.env.SMOLT_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(project, { recursive: true, force: true });
	});

	function writeProjectSettings(contents: object): void {
		mkdirSync(join(project, ".smolt"), { recursive: true });
		writeFileSync(join(project, ".smolt", "review.json"), JSON.stringify(contents), "utf-8");
	}

	it("is off when nothing has been configured", () => {
		expect(loadReviewSettings(project).autoFix).toBeUndefined();
	});

	it("turns on and off again, keeping the rest of the file", () => {
		saveReviewSettings({ watchRepos: ["owner/name"] });
		saveReviewSettings({ autoFix: true });
		expect(loadReviewSettings(project)).toMatchObject({ autoFix: true, watchRepos: ["owner/name"] });

		saveReviewSettings({ autoFix: false });
		expect(loadReviewSettings(project)).toMatchObject({ autoFix: false, watchRepos: ["owner/name"] });
		expect(reviewSettingsFile().startsWith(agentDir)).toBe(true);
	});

	it("ignores autoFix and watchRepos from a project's own file", () => {
		writeProjectSettings({ autoFix: true, watchRepos: ["attacker/repo"], maxFindings: 3 });
		const settings = loadReviewSettings(project);
		expect(settings.autoFix).toBeUndefined();
		expect(settings.watchRepos).toBeUndefined();
		// A project may still narrow what a review reports.
		expect(settings.maxFindings).toBe(3);
	});
});
