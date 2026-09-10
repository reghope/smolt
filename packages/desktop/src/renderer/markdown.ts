/** Minimal, dependency-free markdown renderer for chat messages.
 * Supports: headings, bold/italic/strikethrough, inline code, fenced code
 * blocks, unordered/ordered lists, blockquotes, links, tables, horizontal
 * rules, paragraphs. All input is HTML-escaped before any markup is
 * applied. */

export function escapeHtml(s: string): string {
	return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/**
 * How sure a bracketed tag is, from its first word: the research and review
 * extensions open findings with markers like "[confirmed/fact]" or
 * "[likely/mechanism]", and a wall of those reads far better when the
 * confidence is a colour. Anything unfamiliar stays neutral.
 */
function tagTone(word: string): string {
	switch (word.toLowerCase()) {
		case "confirmed":
		case "verified":
		case "fact":
		case "done":
		case "fixed":
		case "pass":
		case "passed":
		case "ok":
			return "ok";
		case "likely":
		case "probable":
		case "partial":
		case "warning":
		case "warn":
		case "caution":
		case "todo":
			return "warn";
		case "unconfirmed":
		case "unlikely":
		case "speculative":
		case "refuted":
		case "wrong":
		case "failed":
		case "fail":
		case "error":
		case "blocked":
		case "bug":
			return "bad";
		default:
			return "note";
	}
}

/** A "[confidence/kind]" or "[label]" marker at the start of a line, as a coloured chip. */
function tagChips(s: string): string {
	// Not a link: "[text](url)" keeps its brackets for the link rule below.
	return s.replace(/^\[([A-Za-z][\w-]*)(?:\/([A-Za-z][\w-]*))?\](?!\()/, (_m, first: string, second?: string) => {
		const tone = tagTone(first);
		const rest = second ? `<span class="md-tag-kind">/${second}</span>` : "";
		return `<span class="md-tag md-tag-${tone}">${first}${rest}</span>`;
	});
}

/** The shape of a session id: five hex groups, as the session index writes them. */
const SESSION_ID = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;

/**
 * A session id in a reply, whether bare or in inline code, becomes a link
 * that opens the chat it names. The agent quotes ids when it searches past
 * sessions, and an id nobody can click is a thing to copy out by hand.
 */
function sessionLinks(s: string): string {
	return s.replace(SESSION_ID, (id) => `<a class="md-session" data-session="${id}" title="Open this chat">${id}</a>`);
}

/**
 * What reads as a local path: something with a directory separator and a
 * file extension, or an explicit relative or absolute start. URLs and
 * shell commands are not paths, and a bare word never is.
 */
const LOCAL_PATH =
	/^(?:\.{1,2}[/\\]|~[/\\]|[/\\]|[A-Za-z]:[/\\])?[\w.@-][\w.@ -]*(?:[/\\][\w.@-][\w.@ -]*)*(?::\d+(?::\d+)?)?$/;

/** A path in inline code becomes a link that opens the file; the reply itself is unchanged. */
function fileLink(code: string): string {
	const text = code.trim();
	if (!/[/\\]/.test(text) || /^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /\s{2,}|["<>|*?]/.test(text)) return code;
	if (!LOCAL_PATH.test(text)) return code;
	// A slash inside a command or a flag is not a path: "a/b" alone might be,
	// but only when it carries an extension or starts like a path.
	const explicit = /^(?:\.{1,2}[/\\]|~[/\\]|[/\\]|[A-Za-z]:[/\\])/.test(text);
	if (!explicit && !/\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?$/.test(text)) return code;
	// "/wayfinder" is a slash command, not the root of a filesystem: one
	// leading slash, one segment, no extension is left alone.
	if (/^\/[^/\\]+$/.test(text) && !/\.[A-Za-z0-9]{1,8}$/.test(text)) return code;
	return `<a class="md-file" data-file="${text}" title="Open this file">${code}</a>`;
}

function inline(s: string): string {
	return tagChips(s)
		.replace(/`([^`]+)`/g, (_m, code) => `<code>${fileLink(sessionLinks(code))}</code>`)
		.replace(/~~([^~]+)~~/g, "<del>$1</del>")
		.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
		.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
		.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>')
		.replace(
			/(^|[^"=\w-])([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![\w-]|[^<]*<\/a>)/gi,
			(_m, before: string, id: string) =>
				`${before}<a class="md-session" data-session="${id}" title="Open this chat">${id}</a>`,
		);
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
