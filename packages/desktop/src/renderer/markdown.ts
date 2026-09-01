/** Minimal, dependency-free markdown renderer for chat messages.
 * Supports: headings, bold/italic/strikethrough, inline code, fenced code
 * blocks, unordered/ordered lists, blockquotes, links, tables, horizontal
 * rules, paragraphs. All input is HTML-escaped before any markup is
 * applied. */

export function escapeHtml(s: string): string {
	return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function inline(s: string): string {
	return s
		.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`)
		.replace(/~~([^~]+)~~/g, "<del>$1</del>")
		.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
		.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
		.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');
}

export function renderMarkdown(source: string): string {
	const lines = escapeHtml(source).split("\n");
	const out: string[] = [];
	let inCode = false;
	let codeLines: string[] = [];
	let listKind: "ul" | "ol" | null = null;
	let paragraph: string[] = [];
	let tableLines: string[] = [];

	const flushParagraph = () => {
		if (paragraph.length > 0) {
			out.push(`<p>${inline(paragraph.join(" "))}</p>`);
			paragraph = [];
		}
	};
	const flushList = () => {
		if (listKind) {
			out.push(`</${listKind}>`);
			listKind = null;
		}
	};
	const isTableSeparator = (line: string): boolean => /^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*:?-{0,}:?\s*$/.test(line);
	const splitRow = (line: string): string[] =>
		line
			.trim()
			.replace(/^\|/, "")
			.replace(/\|$/, "")
			.split("|")
			.map((cell) => cell.trim());
	const flushTable = () => {
		if (tableLines.length === 0) return;
		// Pipe lines without a separator row were never a table; hand them
		// back as a paragraph rather than guessing at cells.
		if (tableLines.length < 2 || !isTableSeparator(tableLines[1]!)) {
			for (const line of tableLines) paragraph.push(line.trim());
			tableLines = [];
			flushParagraph();
			return;
		}
		const aligns = splitRow(tableLines[1]!).map((cell) =>
			cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : null,
		);
		const attr = (i: number): string => (aligns[i] ? ` style="text-align:${aligns[i]}"` : "");
		const row = (line: string, tag: "th" | "td"): string =>
			`<tr>${splitRow(line)
				.map((cell, i) => `<${tag}${attr(i)}>${inline(cell)}</${tag}>`)
				.join("")}</tr>`;
		const body = tableLines
			.slice(2)
			.map((line) => row(line, "td"))
			.join("");
		out.push(`<table><thead>${row(tableLines[0]!, "th")}</thead><tbody>${body}</tbody></table>`);
		tableLines = [];
	};

	for (const line of lines) {
		if (line.startsWith("```")) {
			if (inCode) {
				out.push(`<pre><code>${codeLines.join("\n")}</code></pre>`);
				codeLines = [];
				inCode = false;
			} else {
				flushParagraph();
				flushList();
				inCode = true;
			}
			continue;
		}
		if (inCode) {
			codeLines.push(line);
			continue;
		}

		// A pipe-framed line joins the pending table; anything else settles it.
		if (/^\s*\|.*\|\s*$/.test(line)) {
			flushParagraph();
			flushList();
			tableLines.push(line);
			continue;
		}
		flushTable();

		if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line) && paragraph.length === 0) {
			flushList();
			out.push("<hr>");
			continue;
		}

		const heading = /^(#{1,4})\s+(.*)$/.exec(line);
		if (heading) {
			flushParagraph();
			flushList();
			const level = Math.min(heading[1]!.length + 2, 6);
			out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
			continue;
		}
		const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
		const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
		if (bullet || ordered) {
			flushParagraph();
			const kind = bullet ? "ul" : "ol";
			if (listKind !== kind) {
				flushList();
				out.push(`<${kind}>`);
				listKind = kind;
			}
			out.push(`<li>${inline((bullet ?? ordered)![1]!)}</li>`);
			continue;
		}
		if (/^\s*&gt;\s?/.test(line)) {
			flushParagraph();
			flushList();
			out.push(`<blockquote>${inline(line.replace(/^\s*&gt;\s?/, ""))}</blockquote>`);
			continue;
		}
		if (line.trim() === "") {
			flushParagraph();
			flushList();
			continue;
		}
		paragraph.push(line.trim());
	}
	if (inCode) out.push(`<pre><code>${codeLines.join("\n")}</code></pre>`);
	flushTable();
	flushParagraph();
	flushList();
	return out.join("\n");
}
