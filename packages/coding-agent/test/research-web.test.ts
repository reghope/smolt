import { describe, expect, test } from "vitest";
import {
	detectBlock,
	extractLinks,
	extractScripts,
	type FetchImpl,
	fetchPage,
	htmlToText,
	parseBing,
	parseDuckDuckGo,
	webSearch,
} from "../src/extensions/research/web.ts";

/**
 * The researchers' first rung: fetching a page as a crawler sees it and
 * searching through public engines' HTML front-ends. Everything here runs
 * against fixture HTML through an injected fetch — no network.
 */

const PAGE = `<!doctype html><html><head><title>Pricing &amp; Plans</title><style>.x{}</style>
<script src="/static/app.3f2a.js"></script><link rel="modulepreload" href="https://cdn.example.dev/chunk.mjs">
</head><body><!-- comment --><nav><a href="/docs">Docs</a><a href="#top">top</a><a href="mailto:x@y.z">mail</a></nav>
<h1>Plans</h1><p>Starter costs &pound;9 &#8212; per month.</p><ul><li>Fast</li><li>Cheap</li></ul>
<script>window.__DATA__ = {"plans": 3};</script><a href="https://other.example.org/x?y=1">Other</a>
<a href="/docs">Docs again</a></body></html>`;

function fakeFetch(
	responses: Record<string, { status?: number; body: string; contentType?: string; url?: string }>,
	calls: { url: string; method: string; headers: Record<string, string> }[] = [],
): FetchImpl {
	return async (url, init) => {
		calls.push({ url, method: init.method ?? "GET", headers: init.headers ?? {} });
		const entry = responses[url] ?? { status: 404, body: "not found" };
		const status = entry.status ?? 200;
		const headers = new Map<string, string>([["content-type", entry.contentType ?? "text/html; charset=utf-8"]]);
		return {
			ok: status >= 200 && status < 300,
			status,
			url: entry.url ?? url,
			headers: {
				get: (name: string) => headers.get(name.toLowerCase()) ?? null,
				forEach: (callback: (value: string, key: string) => void) => {
					for (const [key, value] of headers) callback(value, key);
				},
			},
			text: async () => entry.body,
		};
	};
}

describe("htmlToText", () => {
	test("drops scripts, styles and comments, keeps the title and the words", () => {
		const text = htmlToText(PAGE);
		expect(text).toContain("Pricing & Plans");
		expect(text).toContain("Starter costs £9 — per month.");
		expect(text).toContain("- Fast");
		expect(text).not.toContain("window.__DATA__");
		expect(text).not.toContain(".x{}");
		expect(text).not.toContain("comment");
	});
});

describe("extractLinks / extractScripts", () => {
	test("links resolve against the page, skip anchors and mailto, and dedupe", () => {
		const links = extractLinks(PAGE, "https://example.dev/pricing");
		expect(links.map((link) => link.url)).toEqual(["https://example.dev/docs", "https://other.example.org/x?y=1"]);
		expect(links[0]!.text).toBe("Docs");
	});

	test("scripts list external bundles, preload hints, and inline sizes", () => {
		const scripts = extractScripts(PAGE, "https://example.dev/pricing");
		expect(scripts.external).toEqual(["https://example.dev/static/app.3f2a.js", "https://cdn.example.dev/chunk.mjs"]);
		expect(scripts.inline.length).toBe(1);
	});
});

describe("detectBlock", () => {
	test("names a bot wall by status and by body", () => {
		expect(detectBlock(403, "<title>Just a moment...</title><script src=cf-chl-x></script>")).toContain("bot-check");
		expect(detectBlock(429, "slow down")).toBe("HTTP 429");
		expect(detectBlock(200, "<title>Attention Required! | Cloudflare</title>")).toContain("interstitial");
		expect(detectBlock(200, PAGE)).toBeUndefined();
	});
});

describe("fetchPage", () => {
	test("shapes the body by 'as' and flags truncation", async () => {
		const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
		const impl = fakeFetch({ "https://example.dev/pricing": { body: PAGE } }, calls);
		const text = await fetchPage({ url: "https://example.dev/pricing" }, impl);
		expect(text.ok).toBe(true);
		expect(text.body).toContain("Starter costs £9");
		expect(calls[0]!.headers["user-agent"]).toContain("Chrome");

		const links = await fetchPage({ url: "https://example.dev/pricing", as: "links" }, impl);
		expect(links.body).toContain("Docs — https://example.dev/docs");

		const scripts = await fetchPage({ url: "https://example.dev/pricing", as: "scripts" }, impl);
		expect(scripts.body).toContain("app.3f2a.js");
		expect(scripts.body).toContain("1 inline script");

		const html = await fetchPage({ url: "https://example.dev/pricing", as: "html", maxChars: 500 }, impl);
		expect(html.truncated).toBe(true);
		expect(html.body.length).toBe(500);
		expect(html.length).toBe(PAGE.length);
	});

	test("json is pretty-printed and headers mode sends HEAD", async () => {
		const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
		const impl = fakeFetch(
			{ "https://api.example.dev/v1/plans": { body: '{"plans":[1,2]}', contentType: "application/json" } },
			calls,
		);
		const json = await fetchPage({ url: "https://api.example.dev/v1/plans", as: "json" }, impl);
		expect(json.body).toBe('{\n  "plans": [\n    1,\n    2\n  ]\n}');
		const headers = await fetchPage({ url: "https://api.example.dev/v1/plans", as: "headers" }, impl);
		expect(calls[1]!.method).toBe("HEAD");
		expect(headers.body).toContain("content-type: application/json");
	});

	test("a bot wall comes back flagged, not silently as the page", async () => {
		const impl = fakeFetch({
			"https://walled.example.dev/": { status: 403, body: "<title>Just a moment...</title>cf-chl-bypass" },
		});
		const result = await fetchPage({ url: "https://walled.example.dev/" }, impl);
		expect(result.ok).toBe(false);
		expect(result.blocked).toContain("HTTP 403");
	});
});

const DDG = `<div class="result results_links"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.dev%2Fdocs%2Fsearch&amp;rut=abc">Search docs &amp; more</a>
<a class="result__snippet" href="x">How <b>search</b> works</a></div>
<div class="result"><a class="result__a" href="https://github.com/example/repo">example/repo</a><a class="result__snippet">The source</a></div>`;

const BING = `<li class="b_algo"><h2><a href="https://example.dev/docs">Docs</a></h2><div class="b_caption"><p>Official docs</p></div></li>
<li class="b_algo"><h2><a href="https://blog.example.dev/post">A post</a></h2><p>Snippet here</p></li>`;

describe("search parsers", () => {
	test("duckduckgo results unwrap the redirect and keep the snippet", () => {
		const results = parseDuckDuckGo(DDG);
		expect(results.length).toBe(2);
		expect(results[0]!.url).toBe("https://example.dev/docs/search");
		expect(results[0]!.title).toBe("Search docs & more");
		expect(results[0]!.snippet).toBe("How search works");
		expect(results[1]!.url).toBe("https://github.com/example/repo");
	});

	test("bing results carry title, url, snippet", () => {
		const results = parseBing(BING);
		expect(results.map((result) => result.url)).toEqual([
			"https://example.dev/docs",
			"https://blog.example.dev/post",
		]);
		expect(results[1]!.snippet).toBe("Snippet here");
	});

	test("webSearch falls back to bing when duckduckgo yields nothing, and reports both failures", async () => {
		const ddgUrl = "https://html.duckduckgo.com/html/?q=example%20docs";
		const bingUrl = "https://www.bing.com/search?q=example%20docs";
		const fallback = await webSearch(
			"example docs",
			fakeFetch({ [ddgUrl]: { status: 403, body: "captcha" }, [bingUrl]: { body: BING } }),
		);
		expect(fallback.engine).toBe("bing");
		expect(fallback.results.length).toBe(2);
		const nothing = await webSearch("example docs", fakeFetch({}));
		expect(nothing.results.length).toBe(0);
		expect(nothing.errors?.length).toBe(2);
		const first = await webSearch("example docs", fakeFetch({ [ddgUrl]: { body: DDG } }), 1);
		expect(first.engine).toBe("duckduckgo");
		expect(first.results.length).toBe(1);
	});
});
