import { describe, expect, it } from "vitest";
import { getSmoltUserAgent } from "../src/utils/smolt-user-agent.ts";

describe("getSmoltUserAgent", () => {
	it("formats the user agent expected by pi.dev", () => {
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		const userAgent = getSmoltUserAgent("1.2.3");

		expect(userAgent).toBe(`smolt/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(/^smolt\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});
});
