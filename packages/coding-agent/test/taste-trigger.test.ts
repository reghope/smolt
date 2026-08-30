import { describe, expect, test } from "vitest";
import { checkFile, summarizeFile } from "../src/extensions/taste/checks.ts";
import { isDesignPrompt, isUiPath, matchesGlob, uiPathsInCommand } from "../src/extensions/taste/trigger.ts";

/**
 * Both halves of the trigger lean toward firing. A false positive costs some
 * context and a review that was not needed; a false negative is unreviewed UI,
 * which is the thing the gate exists to prevent.
 */

const CWD = "/repo";

describe("recognising design work", () => {
	test("design vocabulary arms it", () => {
		expect(isDesignPrompt("redo the dashboard layout")).toBe(true);
		expect(isDesignPrompt("make the sidebar collapsible")).toBe(true);
		expect(isDesignPrompt("pick a better palette")).toBe(true);
	});

	test("a mentioned UI file arms it with no design words at all", () => {
		expect(isDesignPrompt("update Header.tsx to take a title prop")).toBe(true);
		expect(isDesignPrompt("fix the bug in styles.css")).toBe(true);
	});

	test("an attached image arms it whatever the words", () => {
		expect(isDesignPrompt("like this", true)).toBe(true);
		expect(isDesignPrompt("", true)).toBe(true);
	});

	test("plain work does not", () => {
		expect(isDesignPrompt("fix the failing parser test")).toBe(false);
		expect(isDesignPrompt("why is the migration slow")).toBe(false);
		expect(isDesignPrompt("")).toBe(false);
	});

	test("words are matched whole, not as fragments", () => {
		// "design" inside "designation" is not design work.
		expect(isDesignPrompt("update the designation field")).toBe(false);
		expect(isDesignPrompt("rename the uid column")).toBe(false);
	});

	test("it over-triggers where the doctrine is cheap and a miss is not", () => {
		// Accepted cost, recorded rather than hidden: this is not design work,
		// but the word is design vocabulary and the bias rule says trigger.
		expect(isDesignPrompt("design a database schema")).toBe(true);
	});
});

describe("recognising a file that renders", () => {
	test("markup, styles and templates count", () => {
		for (const path of ["src/Hero.tsx", "app/page.html", "styles/main.scss", "ui/Card.vue", "docs/post.mdx"]) {
			expect(isUiPath(path, CWD)).toBe(true);
		}
	});

	test("theme config counts whatever its extension", () => {
		expect(isUiPath("tailwind.config.ts", CWD)).toBe(true);
		expect(isUiPath("postcss.config.mjs", CWD)).toBe(true);
	});

	test("server code and docs do not", () => {
		for (const path of ["src/server.ts", "README.md", "data/rows.json"]) {
			expect(isUiPath(path, CWD)).toBe(false);
		}
	});

	test("things nobody looks at are excluded", () => {
		for (const path of [
			"node_modules/x/index.css",
			"dist/app.css",
			".next/static/page.html",
			"src/Hero.test.tsx",
			"vendor/lib.min.css",
			"__tests__/Card.tsx",
		]) {
			expect(isUiPath(path, CWD)).toBe(false);
		}
	});

	test("a project can name its own token files", () => {
		expect(isUiPath("src/tokens/colors.ts", CWD)).toBe(false);
		expect(isUiPath("src/tokens/colors.ts", CWD, ["src/tokens/*.ts"])).toBe(true);
	});
});

describe("globs", () => {
	test("a star stays inside its segment and a double star crosses them", () => {
		expect(matchesGlob("src/tokens/colors.ts", "src/tokens/*.ts")).toBe(true);
		expect(matchesGlob("src/tokens/deep/colors.ts", "src/tokens/*.ts")).toBe(false);
		expect(matchesGlob("src/tokens/deep/colors.ts", "src/**/*.ts")).toBe(true);
	});
});

describe("writes hidden in shell commands", () => {
	test("a redirect into a UI file is caught", () => {
		expect(uiPathsInCommand("cat tpl > src/Hero.tsx", CWD)).toContain("src/Hero.tsx");
	});

	test("an in-place edit is caught", () => {
		expect(uiPathsInCommand("sed -i s/a/b/ app/page.css", CWD)).toContain("app/page.css");
	});

	test("a command that only reads is not", () => {
		expect(uiPathsInCommand("cat src/Hero.tsx", CWD)).toHaveLength(0);
		expect(uiPathsInCommand("npm run build", CWD)).toHaveLength(0);
	});
});

describe("mechanical checks", () => {
	const idOf = (text: string, id: string) => checkFile(text).find((result) => result.id === id);

	test("an em-dash in rendered text fails, in a comment does not", () => {
		expect(idOf("<p>one — two</p>", "em-dash")?.passed).toBe(false);
		expect(idOf("// one — two", "em-dash")?.passed).toBe(true);
	});

	test("h-screen fails and min-h-[100dvh] does not", () => {
		expect(idOf('<div className="h-screen">', "viewport-stability")?.passed).toBe(false);
		expect(idOf('<div className="min-h-[100dvh]">', "viewport-stability")?.passed).toBe(true);
	});

	test("a window scroll listener fails", () => {
		expect(idOf('window.addEventListener("scroll", onScroll)', "scroll-listener")?.passed).toBe(false);
		expect(idOf("const { scrollYProgress } = useScroll()", "scroll-listener")?.passed).toBe(true);
	});

	test("placeholder people and companies fail", () => {
		expect(idOf("<cite>Jane Doe</cite>", "ai-tells")?.passed).toBe(false);
		expect(idOf("<cite>Acme Inc</cite>", "ai-tells")?.passed).toBe(false);
	});

	test("the eyebrow budget is one per three sections", () => {
		const three = "<section>x</section><section>y</section><section>z</section>";
		const one = `${three}<span class="uppercase tracking-wide">a</span>`;
		const two = `${one}<span class="uppercase tracking-wide">b</span>`;
		expect(checkFile(one).find((result) => result.id === "eyebrow-density")?.passed).toBe(true);
		expect(checkFile(two).find((result) => result.id === "eyebrow-density")?.passed).toBe(false);
	});

	test("a file with no sections is not judged on eyebrows", () => {
		expect(checkFile('<span class="uppercase tracking-wide">a</span>').some((r) => r.id === "eyebrow-density")).toBe(
			false,
		);
	});

	test("failures name the line they are on", () => {
		const results = checkFile('ok\n<div className="h-screen">\n');
		const line = summarizeFile("src/Hero.tsx", results);
		expect(line.startsWith("FAIL")).toBe(true);
		expect(line).toContain("viewport-stability (line 2)");
	});

	test("a clean file passes every rule", () => {
		const clean = '<div className="min-h-[100dvh]"><p>Straight copy, no tells.</p></div>';
		expect(checkFile(clean).every((result) => result.passed)).toBe(true);
		expect(summarizeFile("src/Hero.tsx", checkFile(clean)).startsWith("PASS")).toBe(true);
	});
});
