/** Minimal, dependency-free markdown renderer for chat messages.
 * Supports: headings, bold/italic, inline code, fenced code blocks,
 * unordered/ordered lists, blockquotes, links, paragraphs. All input is
 * HTML-escaped before any markup is applied. */

export function escapeHtml(s: string): string {
	return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function inline(s: string): string {
	return s
		.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`)
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
	flushParagraph();
	flushList();
	return out.join("\n");
}
