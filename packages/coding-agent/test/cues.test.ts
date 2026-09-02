import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	BUILT_IN_CUES,
	type Cue,
	cueMatches,
	loadCueDir,
	matchingCues,
	mergeCues,
	parseCueFile,
} from "../src/extensions/cues/cues.ts";

/**
 * A cue costs nothing while it stays out and misleads when it goes in
 * uninvited, so the trigger is most of the extension.
 */

function cue(over: Partial<Cue> = {}): Cue {
	return {
		id: "test",
		summary: "a test cue",
		trigger: ["build", "make"],
		note: "## Test\nSomething worth saying.",
		source: "built-in",
		...over,
	};
}

describe("matching", () => {
	test("a trigger alone arms a cue that asks for nothing else", () => {
		expect(cueMatches(cue(), "build the parser")).toBe(true);
		expect(cueMatches(cue(), "explain the parser")).toBe(false);
	});

	test("`with` demands both halves", () => {
		const both = cue({ with: ["web app", "site"] });
		expect(cueMatches(both, "build a web app")).toBe(true);
		expect(cueMatches(both, "build the parser")).toBe(false);
		expect(cueMatches(both, "the web app is slow")).toBe(false);
	});

	test("`unless` wins over any trigger", () => {
		const guarded = cue({ with: ["web app"], unless: ["next.js"] });
		expect(cueMatches(guarded, "build a web app")).toBe(true);
		expect(cueMatches(guarded, "build a web app with Next.js")).toBe(false);
	});

	test("phrases match whole words only", () => {
		const short = cue({ trigger: ["spa"] });
		expect(cueMatches(short, "make a spa page")).toBe(true);
		expect(cueMatches(short, "make a space invaders clone")).toBe(false);
	});

	test("an empty prompt arms nothing", () => {
		expect(cueMatches(cue(), "")).toBe(false);
		expect(cueMatches(cue(), "   ")).toBe(false);
	});

	test("every matching cue arms, not just the first", () => {
		const cues = [
			cue({ id: "one" }),
			cue({ id: "two", trigger: ["parser"] }),
			cue({ id: "three", trigger: ["zzz"] }),
		];
		expect(matchingCues(cues, "build the parser").map((entry) => entry.id)).toEqual(["one", "two"]);
	});
});

describe("the shipped web-stack cue", () => {
	const webStack = BUILT_IN_CUES.find((entry) => entry.id === "web-stack") as Cue;

	test("arms on starting a web app", () => {
		expect(cueMatches(webStack, "build me a web app for tracking runs")).toBe(true);
		expect(cueMatches(webStack, "can you make a landing page for the shop")).toBe(true);
	});

	test("stays out of everything else", () => {
		expect(cueMatches(webStack, "build the parser")).toBe(false);
		expect(cueMatches(webStack, "the dashboard is rendering the wrong totals")).toBe(false);
		expect(cueMatches(webStack, "build a scraper for the pricing pages")).toBe(false);
	});

	test("stays out when a stack is already named, its own included", () => {
		expect(cueMatches(webStack, "build a web app with Next.js")).toBe(false);
		expect(cueMatches(webStack, "start a new web app with vite and react router")).toBe(false);
	});

	test("says what the default is and what beats it", () => {
		expect(webStack.note).toContain("Vite with React Router");
		expect(webStack.note).toContain("What the user asks for wins");
	});
});

describe("cue files", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "cues-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function write(name: string, body: string): void {
		writeFileSync(join(dir, name), body);
	}

	test("frontmatter over a note becomes a cue", () => {
		const parsed = parseCueFile(
			"tests",
			[
				"---",
				"summary: Which runner this house uses",
				"trigger: [test, spec]",
				"with: [write, add]",
				"---",
				"## Tests",
				"New tests run with vitest.",
			].join("\n"),
			"/somewhere/tests.md",
		);
		expect(parsed).toMatchObject({
			id: "tests",
			summary: "Which runner this house uses",
			trigger: ["test", "spec"],
			with: ["write", "add"],
			source: "/somewhere/tests.md",
		});
		expect(parsed?.note).toBe("## Tests\nNew tests run with vitest.");
	});

	test("a cue with no trigger or no note is dropped, not half-run", () => {
		expect(parseCueFile("x", "---\nsummary: no trigger\n---\nA note.", "x.md")).toBeUndefined();
		expect(parseCueFile("x", "---\ntrigger: [a]\n---\n", "x.md")).toBeUndefined();
		expect(parseCueFile("x", "no frontmatter at all", "x.md")).toBeUndefined();
	});

	test("a directory loads its markdown, and nothing else", () => {
		write("house.md", "---\ntrigger: [deploy]\n---\n## Deploys\nStaging first.");
		write("notes.txt", "---\ntrigger: [deploy]\n---\nignored");
		write("broken.md", "no frontmatter");
		const loaded = loadCueDir(dir);
		expect(loaded.map((entry) => entry.id)).toEqual(["house"]);
	});

	test("a missing directory is simply no cues", () => {
		expect(loadCueDir(join(dir, "nope"))).toEqual([]);
	});

	test("a file replaces the built-in it shares a name with", () => {
		const merged = mergeCues(
			[cue({ id: "web-stack", note: "built-in note" })],
			[cue({ id: "web-stack", note: "mine", source: "f.md" })],
		);
		expect(merged).toHaveLength(1);
		expect(merged[0]?.note).toBe("mine");
	});
});
