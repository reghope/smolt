/**
 * Dependency-free web access for researchers: fetch a URL as text, HTML,
 * JSON, its links or its scripts; and search the web through the HTML
 * front-ends of public engines. Built on global fetch (Node 22+) so the
 * extension carries no new dependency, and every network call is injectable
 * so tests never touch the network.
 *
 * The fetch tool is the first rung of a researcher's ladder: the raw page,
 * as a crawler sees it. What it cannot see — rendered content, blocked
 * responses, script-built pages — is what the browse tool's rungs are for.
 */

export type FetchAs = "text" | "html" | "json" | "links" | "scripts" | "headers";

export interface FetchRequest {
	url: string;
	as?: FetchAs;
	/** Cap on the returned body; the default fits a page in a tool result. */
	maxChars?: number;
	headers?: Record<string, string>;
	method?: "GET" | "HEAD" | "POST";
	body?: string;
}

export interface FetchResult {
	ok: boolean;
	status: number;
	/** The final URL after redirects. */
	url: string;
	contentType: string;
	body: string;
	truncated: boolean;
	/** Total characters before truncation. */
	length: number;
	/** Set when the response looks like a bot wall rather than the page. */
	blocked?: string;
}

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

export interface SearchOutcome {
	engine: string;
	results: SearchResult[];
	/** When both engines failed: what each said. */
	errors?: string[];
}

/** The subset of fetch the helpers use; injectable for tests. */
export type FetchImpl = (
	url: string,
	init: {
		method?: string;
		headers?: Record<string, string>;
		body?: string;
		redirect?: "follow";
		signal?: AbortSignal;
	},
) => Promise<{
	ok: boolean;
	status: number;
	url: string;
	headers: { get(name: string): string | null; forEach(callback: (value: string, key: string) => void): void };
	text(): Promise<string>;
}>;

export const DEFAULT_MAX_CHARS = 12_000;
const HARD_MAX_CHARS = 200_000;
const TIMEOUT_MS = 25_000;

/** A plain, current desktop browser: what the page would serve a person. */
export const BROWSER_USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	copy: "©",
	reg: "®",
	trade: "™",
	pound: "£",
	euro: "€",
	yen: "¥",
	cent: "¢",
	deg: "°",
	times: "×",
	middot: "·",
	bull: "•",
	laquo: "«",
	raquo: "»",
	sect: "§",
	hellip: "…",
	mdash: "—",
	ndash: "–",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
};

export function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
		if (code[0] === "#") {
			const value =
				code[1]?.toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
			return Number.isFinite(value) && value > 0 ? String.fromCodePoint(value) : whole;
		}
		return ENTITIES[code.toLowerCase()] ?? whole;
	});
}

/**
 * Rendered-ish text from HTML: scripts, styles and comments dropped, block
 * elements turned into line breaks, entities decoded, whitespace collapsed.
 * Nowhere near a browser, but enough to read an article, a docs page, or a
 * forum thread from the raw response.
 */
export function htmlToText(html: string): string {
	const stripped = html
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, " ")
		.replace(/<head[\s\S]*?<\/head>/gi, (head) => {
			const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? "";
			return title.trim() === "" ? " " : `${title.trim()}\n\n`;
		})
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(
			/<\/(p|div|section|article|header|footer|main|aside|nav|li|tr|h[1-6]|blockquote|pre|dd|dt|figcaption|summary|details|table|thead|tbody|form|fieldset)>/gi,
			"\n",
		)
		.replace(/<(h[1-6])[^>]*>/gi, "\n")
		.replace(/<li[^>]*>/gi, "\n- ")
		.replace(/<\/(td|th)>/gi, "\t")
		.replace(/<[^>]+>/g, " ");
	return decodeEntities(stripped)
		.replace(/\r/g, "")
		.replace(/[ \t\f\v]+/g, " ")
		.replace(/ ?\n ?/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function resolveUrl(href: string, base: string): string | undefined {
	try {
		return new URL(href, base).toString();
	} catch {
		return undefined;
	}
}

/** Every anchor on the page, resolved against its URL, deduplicated, in document order. */
export function extractLinks(html: string, base: string, limit = 300): { url: string; text: string }[] {
	const links: { url: string; text: string }[] = [];
	const seen = new Set<string>();
	const pattern = /<a\b[^>]*?href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
	for (const match of html.matchAll(pattern)) {
		const href = (match[2] ?? match[3] ?? match[4] ?? "").trim();
		if (href === "" || href.startsWith("#") || /^(javascript|mailto|tel):/i.test(href)) continue;
		const url = resolveUrl(href, base);
		if (!url || seen.has(url)) continue;
		seen.add(url);
		const text = htmlToText(match[5] ?? "")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 120);
		links.push({ url, text });
		if (links.length >= limit) break;
	}
	return links;
}

/** The scripts a page loads — the bundle URLs a source diver goes after — plus inline script sizes. */
export function extractScripts(html: string, base: string): { external: string[]; inline: number[] } {
	const external: string[] = [];
	const inline: number[] = [];
	const seen = new Set<string>();
	const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
	for (const match of html.matchAll(pattern)) {
		const attrs = match[1] ?? "";
		const src = /\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
		if (src) {
			const url = resolveUrl((src[2] ?? src[3] ?? src[4] ?? "").trim(), base);
			if (url && !seen.has(url)) {
				seen.add(url);
				external.push(url);
			}
		} else if ((match[2] ?? "").trim() !== "") {
			inline.push((match[2] ?? "").length);
		}
	}
	// Modulepreload and preload hints name bundles the markup never references directly.
	const hints = /<link\b[^>]*rel\s*=\s*["'](?:module)?preload["'][^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi;
	for (const match of html.matchAll(hints)) {
		const url = resolveUrl(match[1] ?? "", base);
		if (url && /\.m?js(\?|$)/i.test(url) && !seen.has(url)) {
			seen.add(url);
			external.push(url);
		}
	}
	return { external, inline };
}

/** Signs that a response is a bot wall or interstitial rather than the page itself. */
export function detectBlock(status: number, body: string): string | undefined {
	const head = body.slice(0, 6000).toLowerCase();
	if (status === 403 || status === 429 || status === 503) {
		if (/cloudflare|cf-chl|challenge|captcha|access denied|attention required|just a moment/.test(head)) {
			return `HTTP ${status} with a bot-check page`;
		}
		return `HTTP ${status}`;
	}
	if (/<title>[^<]*(just a moment|attention required|access denied|are you a human|verify you are human)/.test(head)) {
		return "interstitial bot check in the page body";
	}
	if (/cf-chl-|_cf_chl_opt|challenge-platform|hcaptcha\.com|recaptcha\/api\.js|px-captcha|datadome/.test(head)) {
		return "bot-check script in the page body";
	}
	return undefined;
}

function looksLikeHtml(contentType: string, body: string): boolean {
	return /html|xml/i.test(contentType) || /^\s*<(!doctype|html|head|body)/i.test(body.slice(0, 200));
}

/** Fetch one URL and shape the body the way the researcher asked. */
export async function fetchPage(
	request: FetchRequest,
	fetchImpl: FetchImpl = fetch as unknown as FetchImpl,
): Promise<FetchResult> {
	const as = request.as ?? "text";
	const maxChars = Math.max(500, Math.min(request.maxChars ?? DEFAULT_MAX_CHARS, HARD_MAX_CHARS));
	const headers: Record<string, string> = {
		"user-agent": BROWSER_USER_AGENT,
		accept:
			as === "json"
				? "application/json, text/plain, */*"
				: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
		"accept-language": "en-US,en;q=0.9",
		...Object.fromEntries(Object.entries(request.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])),
	};
	const response = await fetchImpl(request.url, {
		method: as === "headers" ? (request.method ?? "HEAD") : (request.method ?? "GET"),
		headers,
		body: request.body,
		redirect: "follow",
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	const contentType = response.headers.get("content-type") ?? "";
	if (as === "headers") {
		const lines: string[] = [];
		response.headers.forEach((value, key) => {
			lines.push(`${key}: ${value}`);
		});
		const body = lines.sort().join("\n");
		return {
			ok: response.ok,
			status: response.status,
			url: response.url || request.url,
			contentType,
			body,
			truncated: false,
			length: body.length,
		};
	}
	const raw = await response.text();
	const finalUrl = response.url || request.url;
	let body: string;
	switch (as) {
		case "html":
			body = raw;
			break;
		case "json": {
			try {
				body = JSON.stringify(JSON.parse(raw), null, 2);
			} catch {
				body = raw;
			}
			break;
		}
		case "links":
			body = extractLinks(raw, finalUrl)
				.map((link) => (link.text === "" ? link.url : `${link.text} — ${link.url}`))
				.join("\n");
			break;
		case "scripts": {
			const scripts = extractScripts(raw, finalUrl);
			body =
				`${scripts.external.length} external script(s):\n${scripts.external.join("\n")}` +
				(scripts.inline.length > 0
					? `\n\n${scripts.inline.length} inline script(s), sizes: ${scripts.inline.join(", ")} chars (fetch as 'html' to read them)`
					: "");
			break;
		}
		default:
			body = looksLikeHtml(contentType, raw) ? htmlToText(raw) : raw;
	}
	const truncated = body.length > maxChars;
	return {
		ok: response.ok,
		status: response.status,
		url: finalUrl,
		contentType,
		body: truncated ? body.slice(0, maxChars) : body,
		truncated,
		length: body.length,
		blocked: detectBlock(response.status, raw),
	};
}

// ------------------------------------------------------------------
// Search: the HTML front-ends of public engines, parsed with regexes.
// Fragile by nature — a markup change breaks a parser — so two engines are
// tried and the researcher is told to search from the browser when both fail.
// ------------------------------------------------------------------

function cleanSnippet(html: string): string {
	return htmlToText(html).replace(/\s+/g, " ").trim().slice(0, 300);
}

/** Results from DuckDuckGo's HTML endpoint; hrefs come wrapped in a redirect. */
export function parseDuckDuckGo(html: string): SearchResult[] {
	const results: SearchResult[] = [];
	const blocks = html.split(/<div[^>]*class="[^"]*\bresult\b[^"]*"/i).slice(1);
	for (const block of blocks) {
		const anchor = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
		if (!anchor) continue;
		let url = decodeEntities(anchor[1] ?? "");
		const wrapped = /[?&]uddg=([^&]+)/.exec(url);
		if (wrapped) {
			try {
				url = decodeURIComponent(wrapped[1] ?? "");
			} catch {
				// Keep the wrapped form; it still resolves.
			}
		}
		if (url.startsWith("//")) url = `https:${url}`;
		if (!/^https?:\/\//i.test(url)) continue;
		const snippet = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block)?.[1] ?? "";
		results.push({ title: cleanSnippet(anchor[2] ?? ""), url, snippet: cleanSnippet(snippet) });
	}
	return results;
}

/** Results from Bing's HTML search page. */
export function parseBing(html: string): SearchResult[] {
	const results: SearchResult[] = [];
	const blocks = html.split(/<li[^>]*class="[^"]*\bb_algo\b[^"]*"/i).slice(1);
	for (const block of blocks) {
		const anchor = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
		if (!anchor) continue;
		const url = decodeEntities(anchor[1] ?? "");
		if (!/^https?:\/\//i.test(url)) continue;
		const snippet = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block)?.[1] ?? "";
		results.push({ title: cleanSnippet(anchor[2] ?? ""), url, snippet: cleanSnippet(snippet) });
	}
	return results;
}

/** Search the web; DuckDuckGo first, Bing when it yields nothing. */
export async function webSearch(
	query: string,
	fetchImpl: FetchImpl = fetch as unknown as FetchImpl,
	limit = 10,
): Promise<SearchOutcome> {
	const errors: string[] = [];
	const engines: { name: string; url: string; parse: (html: string) => SearchResult[] }[] = [
		{
			name: "duckduckgo",
			url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
			parse: parseDuckDuckGo,
		},
		{ name: "bing", url: `https://www.bing.com/search?q=${encodeURIComponent(query)}`, parse: parseBing },
	];
	for (const engine of engines) {
		try {
			const response = await fetchImpl(engine.url, {
				method: "GET",
				headers: { "user-agent": BROWSER_USER_AGENT, "accept-language": "en-US,en;q=0.9" },
				redirect: "follow",
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
			const html = await response.text();
			if (!response.ok) {
				errors.push(
					`${engine.name}: HTTP ${response.status}${detectBlock(response.status, html) ? " (bot check)" : ""}`,
				);
				continue;
			}
			const results = engine.parse(html).slice(0, limit);
			if (results.length > 0) return { engine: engine.name, results };
			errors.push(`${engine.name}: no results parsed${detectBlock(response.status, html) ? " (bot check)" : ""}`);
		} catch (error) {
			errors.push(`${engine.name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { engine: "none", results: [], errors };
}
