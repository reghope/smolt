import { describe, expect, test } from "vitest";
import { escapeHtml, renderMarkdown } from "../src/renderer/markdown.ts";

describe("renderMarkdown", () => {
	test("renders GFM tables with alignment and inline markup in cells", () => {
		const html = renderMarkdown("| # | Finding | Sev |\n|---|:---:|---:|\n| 1 | ~~gone~~ **bad** | major |");
		expect(html).toContain("<table><thead><tr><th>#</th>");
		expect(html).toContain(`<th style="text-align:center">Finding</th>`);
		expect(html).toContain(`<th style="text-align:right">Sev</th>`);
		expect(html).toContain("<td>1</td>");
		expect(html).toContain("<del>gone</del> <strong>bad</strong>");
		expect(html).toContain("</tbody></table>");
	});

	test("pipe lines without a separator row fall back to a paragraph", () => {
		const html = renderMarkdown("| just | pipes |\nplain text after");
		expect(html).not.toContain("<table>");
		expect(html).toContain("| just | pipes |");
	});

	test("renders strikethrough and horizontal rules", () => {
		const html = renderMarkdown("before\n\n---\n\nafter with ~~struck~~ text");
		expect(html).toContain("<hr>");
		expect(html).toContain("<del>struck</del>");
	});

	test("a table at the end of the message still closes", () => {
		const html = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |");
		expect(html).toContain("<td>2</td></tr></tbody></table>");
	});

	test("escapes HTML before applying markup", () => {
		const html = renderMarkdown('<script>alert("x")</script>');
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
	});

	test("renders headings, bold, italic, inline code", () => {
		const html = renderMarkdown("## Title\n\nSome **bold** and *soft* and `code`.");
		expect(html).toContain("<h4>Title</h4>");
		expect(html).toContain("<strong>bold</strong>");
		expect(html).toContain("<em>soft</em>");
		expect(html).toContain("<code>code</code>");
	});

	test("renders fenced code blocks verbatim without inline markup", () => {
		const html = renderMarkdown("```\nconst a = **not bold**;\n```");
		expect(html).toContain("<pre><code>const a = **not bold**;</code></pre>");
	});

	test("renders unordered and ordered lists", () => {
		const html = renderMarkdown("- one\n- two\n\n1. first\n2. second");
		expect(html).toContain("<ul>");
		expect(html).toContain("<li>one</li>");
		expect(html).toContain("<ol>");
		expect(html).toContain("<li>second</li>");
	});

	test("renders links with safe targets and blockquotes", () => {
		const html = renderMarkdown("> quoted\n\n[site](https://example.com)");
		expect(html).toContain("<blockquote>quoted</blockquote>");
		expect(html).toContain('<a href="https://example.com"');
		expect(html).toContain('rel="noreferrer noopener"');
	});

	test("does not linkify javascript: URLs", () => {
		const html = renderMarkdown("[x](javascript:alert(1))");
		expect(html).not.toContain("<a ");
	});

	test("escapeHtml covers quotes and angle brackets", () => {
		expect(escapeHtml('<a href="x">&</a>')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
	});
});
