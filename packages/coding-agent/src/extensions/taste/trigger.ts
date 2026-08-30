import { extname, resolve, sep } from "node:path";

/**
 * Two questions, both answered without a model call: is this design work, and
 * did that write touch something that renders?
 *
 * Both lean the same way. A false positive costs some context and a review the
 * work did not need; a false negative is design work shipped past the gate,
 * which is the thing the gate exists to stop. So when in doubt, trigger.
 */

/**
 * Words that mean design work is under way.
 *
 * Deliberately broad. "design a database schema" arms the doctrine too, and
 * that is the cheaper mistake.
 */
const DESIGN_WORDS = [
	"ui",
	"ux",
	"design",
	"redesign",
	"landing",
	"hero",
	"mockup",
	"frontend",
	"front-end",
	"layout",
	"style",
	"styles",
	"styling",
	"stylesheet",
	"theme",
	"css",
	"tailwind",
	"component",
	"components",
	"page",
	"screen",
	"dashboard",
	"admin",
	"nav",
	"navbar",
	"navigation",
	"sidebar",
	"button",
	"card",
	"modal",
	"dialog",
	"form",
	"typography",
	"font",
	"fonts",
	"color",
	"colors",
	"colour",
	"colours",
	"palette",
	"spacing",
	"animation",
	"animate",
	"responsive",
	"mobile",
	"figma",
	"screenshot",
	"section",
	"block",
	"widget",
	"tile",
	"banner",
	"footer",
	"header",
	"icon",
	"logo",
	"brand",
	"branding",
	"marketing",
	"portfolio",
];

/** Extensions that are, or directly control, something that renders. */
const UI_EXTENSIONS = new Set([
	".tsx",
	".jsx",
	".html",
	".htm",
	".css",
	".scss",
	".sass",
	".less",
	".vue",
	".svelte",
	".astro",
	".mdx",
	".twig",
	".ejs",
	".hbs",
	".pug",
]);

/** Files that set the look of everything, whatever their extension. */
const UI_FILENAMES = [/^tailwind\.config\.[cm]?[jt]s$/i, /^postcss\.config\.[cm]?[jt]s$/i, /^theme\.[cm]?[jt]s$/i];

/**
 * Directories whose contents never reach a viewer.
 *
 * This filters which writes arm the gate. It never filters what the model is
 * shown — the doctrine is always served whole.
 */
const IGNORED_SEGMENTS = new Set([
	"node_modules",
	".git",
	".smolt",
	"dist",
	"build",
	"out",
	".next",
	".nuxt",
	".svelte-kit",
	"coverage",
	"__tests__",
	"__snapshots__",
]);

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/i;
const MINIFIED = /\.min\.[a-z]+$/i;

const wordBoundary = (word: string): RegExp => new RegExp(`(^|[^a-z0-9])${word}(?![a-z0-9])`, "i");
const DESIGN_PATTERNS = DESIGN_WORDS.map(wordBoundary);
/** A path mentioned in the prompt counts even when no design word is present. */
const UI_MENTION = /\.(tsx|jsx|html?|css|s[ca]ss|less|vue|svelte|astro|mdx)\b/i;

/** Whether a prompt is asking for design work. */
export function isDesignPrompt(text: string, hasImages = false): boolean {
	// An attached image during a build is a mockup or a screenshot far more
	// often than it is anything else.
	if (hasImages) return true;
	if (text.trim() === "") return false;
	if (UI_MENTION.test(text)) return true;
	return DESIGN_PATTERNS.some((pattern) => pattern.test(text));
}

/** Whether a written file is something a person will look at. */
export function isUiPath(path: string, cwd: string, extraGlobs: string[] = []): boolean {
	if (path.trim() === "") return false;
	const absolute = resolve(cwd, path);
	const segments = absolute.split(/[\\/]/);
	const name = segments[segments.length - 1] ?? "";
	if (segments.some((segment) => IGNORED_SEGMENTS.has(segment))) return false;
	if (TEST_FILE.test(name) || MINIFIED.test(name)) return false;
	if (UI_FILENAMES.some((pattern) => pattern.test(name))) return true;
	if (UI_EXTENSIONS.has(extname(name).toLowerCase())) return true;
	// Project-specific token or theme files, named in .smolt/taste.json.
	const relative = absolute.slice(resolve(cwd).length).replaceAll(sep, "/").replace(/^\//, "");
	return extraGlobs.some((glob) => matchesGlob(relative, glob));
}

/**
 * The small part of glob that a config file actually needs: `*` within a
 * segment, `**` across them. Anything more would be a dependency.
 */
export function matchesGlob(path: string, glob: string): boolean {
	const pattern = glob
		.split("**")
		.map((part) =>
			part
				.split("*")
				.map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, String.raw`\$&`))
				.join("[^/]*"),
		)
		.join(".*");
	return new RegExp(`^${pattern}$`).test(path);
}

/** Shell text that looks like it wrote a file, for the bash escape hatch. */
const SHELL_WRITE = /(^|[\s;|&])(tee|cp|mv|sed\s+-i|install)\b|>>?\s*\S/;

/**
 * Best-effort: did this shell command write to something that renders?
 *
 * Deliberately not trusted — indirection through npm scripts or xargs slips
 * past it. It catches the common `cat > page.tsx` and `sed -i` cases, which is
 * worth having even though it cannot be complete.
 */
export function uiPathsInCommand(command: string, cwd: string, extraGlobs: string[] = []): string[] {
	if (!SHELL_WRITE.test(command)) return [];
	const found = new Set<string>();
	for (const token of command.split(/[\s'"();|&]+/)) {
		const cleaned = token.replace(/^[<>]+/, "");
		if (cleaned === "" || !isUiPath(cleaned, cwd, extraGlobs)) continue;
		found.add(cleaned);
	}
	return [...found];
}
