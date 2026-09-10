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

	test("colours bracketed confidence tags at the start of a line, leaving links alone", () => {
		const html = renderMarkdown(
			[
				"[confirmed/fact] sure",
				"",
				"- [likely/mechanism] maybe",
				"- [unconfirmed] not yet",
				"- [docs](https://example.com) a link",
			].join("\n"),
		);
		expect(html).toContain(
			'<span class="md-tag md-tag-ok">confirmed<span class="md-tag-kind">/fact</span></span> sure',
		);
		expect(html).toContain('<span class="md-tag md-tag-warn">likely');
		expect(html).toContain('<span class="md-tag md-tag-bad">unconfirmed</span> not yet');
		expect(html).toContain('<a href="https://example.com"');
		expect(html).not.toContain('md-tag-note">docs');
	});

	test("turns a quoted session id into a link, bare or in code", () => {
		const id = "01a062db-93b6-725d-9935-02f2452bf339";
		const html = renderMarkdown(`see \`${id}\` and ${id} here`);
		expect(html.match(/data-session="01a062db-93b6-725d-9935-02f2452bf339"/g)).toHaveLength(2);
		expect(html).toContain(`<code><a class="md-session" data-session="${id}"`);
	});

	test("links a local path in inline code, but not a URL or a command", () => {
		const html = renderMarkdown(
			"wrote `.smolt/wayfinder/advisor-extension/spec.md` and `src/app.ts:42`, ran `npm run check`, see `https://x.y/z`",
		);
		expect(html).toContain('<a class="md-file" data-file=".smolt/wayfinder/advisor-extension/spec.md"');
		expect(html).toContain('<a class="md-file" data-file="src/app.ts:42"');
		expect(html).not.toContain('data-file="npm run check"');
		expect(renderMarkdown("use `/wayfinder` then `/etc/hosts`")).not.toContain('data-file="/wayfinder"');
		expect(renderMarkdown("use `/wayfinder` then `/etc/hosts`")).toContain('data-file="/etc/hosts"');
		expect(html).not.toContain('data-file="https://x.y/z"');
	});
});
