/**
 * The part of the pre-flight check a machine can settle.
 *
 * The doctrine's checklist is mostly judgment — whether a layout has rhythm,
 * whether motion is motivated. But a good slice of it is mechanical: an
 * em-dash is present or it is not. Those are checked here, from the file's own
 * text, so a review cannot pass by assertion. Everything else stays with the
 * model, which is told to answer with evidence.
 */

export interface CheckHit {
	line: number;
	text: string;
}

export interface CheckResult {
	id: string;
	/** What the check is looking for, in the doctrine's own terms. */
	label: string;
	passed: boolean;
	hits: CheckHit[];
}

/** One rule: a pattern, and how many matches are allowed. */
interface Rule {
	id: string;
	label: string;
	pattern: RegExp;
	/** Skip lines that are only a comment; doctrine is about rendered output. */
	codeOnly?: boolean;
}

const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|#|<!--)/;

const RULES: Rule[] = [
	{
		id: "em-dash",
		label: "Zero em-dashes in rendered text (Section 9.G, non-negotiable)",
		pattern: /—/g,
		codeOnly: true,
	},
	{
		id: "viewport-stability",
		label: "min-h-[100dvh], never h-screen (Section 14)",
		pattern: /\bh-screen\b/g,
	},
	{
		id: "scroll-listener",
		label: "No window scroll listeners; use useScroll / ScrollTrigger / IntersectionObserver",
		pattern: /window\s*\.\s*addEventListener\s*\(\s*["'`]scroll["'`]/g,
	},
	{
		id: "ai-tells",
		label: "No placeholder names or filler copy (Section 9)",
		pattern: /\b(Jane Doe|John Doe|Acme(?:\s+(?:Inc|Corp|Co))?|Lorem ipsum|Quietly in use at)\b/gi,
		codeOnly: true,
	},
	{
		id: "default-serif",
		label: "Serif discipline: not Fraunces or Instrument Serif without justification",
		pattern: /\b(Fraunces|Instrument[_\s-]?Serif)\b/g,
	},
	{
		id: "scroll-cue",
		label: "No scroll cues (Section 14)",
		pattern: /(↓\s*scroll|\bscroll to explore\b|>\s*scroll\s*<)/gi,
		codeOnly: true,
	},
	{
		id: "section-numbering",
		label: "No section-numbering eyebrows (00 / INDEX, 001 · Capabilities)",
		pattern: /\b\d{2,3}\s*[/·]\s*[A-Za-z]/g,
		codeOnly: true,
	},
	{
		id: "ai-purple",
		label: "No AI-default violet gradient (Section 9)",
		pattern: /(#6366f1|#8b5cf6|#7c3aed|from-purple-500\s+to-indigo-500|from-violet-\d00\s+to-indigo-\d00)/gi,
	},
];

/**
 * Eyebrows earn their place; a page of them is a tell.
 *
 * The doctrine's rule is one per three sections. Section count is approximated
 * from `<section` tags, which is what the markup actually offers.
 */
const EYEBROW = /uppercase[^"'`\n]*tracking|tracking[^"'`\n]*uppercase/g;
const SECTION_TAG = /<section\b/g;

function countMatches(text: string, pattern: RegExp): number {
	return (text.match(new RegExp(pattern.source, pattern.flags)) ?? []).length;
}

/** Run every mechanical rule over one file's text. */
export function checkFile(text: string): CheckResult[] {
	const lines = text.split("\n");
	const results: CheckResult[] = RULES.map((rule) => {
		const hits: CheckHit[] = [];
		lines.forEach((line, index) => {
			if (rule.codeOnly && COMMENT_LINE.test(line)) return;
			const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
			if (!pattern.test(line)) return;
			hits.push({ line: index + 1, text: line.trim().slice(0, 120) });
		});
		return { id: rule.id, label: rule.label, passed: hits.length === 0, hits };
	});

	const sections = countMatches(text, SECTION_TAG);
	const eyebrows = countMatches(text, EYEBROW);
	// Only meaningful once the file actually has sections to weigh against.
	if (sections > 0) {
		const allowed = Math.ceil(sections / 3);
		results.push({
			id: "eyebrow-density",
			label: `At most one eyebrow per three sections (${eyebrows} found, ${allowed} allowed across ${sections} sections)`,
			passed: eyebrows <= allowed,
			hits: [],
		});
	}
	return results;
}

/** The checks that need a browser, recorded as skips rather than passed. */
export const BROWSER_CHECKS: { id: string; label: string; reason: string }[] = [
	{
		id: "overflow",
		label: "No horizontal overflow at 390px and 1280px",
		reason: "needs a rendered page; run the project and check the viewports yourself",
	},
	{
		id: "contrast",
		label: "WCAG AA contrast on CTAs, form fields, and focus rings",
		reason: "needs computed styles; check against the rendered page",
	},
	{
		id: "hero-fits",
		label: "Hero fits the viewport with the CTA visible without scrolling",
		reason: "needs a rendered page at a real viewport height",
	},
];

/** A one-line summary of a file's mechanical result. */
export function summarizeFile(path: string, results: CheckResult[]): string {
	const failed = results.filter((result) => !result.passed);
	if (failed.length === 0) return `PASS ${path} — ${results.length} mechanical checks`;
	const detail = failed
		.map((result) => {
			const where = result.hits.length === 0 ? "" : ` (line ${result.hits.map((hit) => hit.line).join(", ")})`;
			return `${result.id}${where}`;
		})
		.join("; ");
	return `FAIL ${path} — ${detail}`;
}
