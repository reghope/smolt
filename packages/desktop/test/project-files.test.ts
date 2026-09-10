import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { searchProjectFiles } from "../src/main/project-files.ts";

/**
 * A plain directory, not a git repository, so these exercise the fallback
 * walk: the path taken for a folder someone opened that git knows nothing
 * about.
 */
let root = "";

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "smolt-files-"));
	mkdirSync(join(root, "src", "components"), { recursive: true });
	mkdirSync(join(root, "node_modules", "left-pad"), { recursive: true });
	writeFileSync(join(root, "README.md"), "# hi\n");
	writeFileSync(join(root, "src", "main.ts"), "export {};\n");
	writeFileSync(join(root, "src", "components", "footer.ts"), "export {};\n");
	writeFileSync(join(root, "src", "components", "footer-data.ts"), "export {};\n");
	writeFileSync(join(root, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("searchProjectFiles", () => {
	test("matches on the file's own name first", async () => {
		expect(await searchProjectFiles(root, "footer")).toEqual([
			"src/components/footer.ts",
			"src/components/footer-data.ts",
		]);
	});

	test("matches a path fragment across directories", async () => {
		expect(await searchProjectFiles(root, "components/foot")).toContain("src/components/footer.ts");
	});

	test("never offers dependencies", async () => {
		expect(await searchProjectFiles(root, "left-pad")).toEqual([]);
	});

	test("an empty query lists the top of the tree first", async () => {
		expect((await searchProjectFiles(root, ""))[0]).toBe("README.md");
	});

	test("honours the limit", async () => {
		expect(await searchProjectFiles(root, "", 2)).toHaveLength(2);
	});
});
