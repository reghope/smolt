import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * A cue: a note that belongs in the prompt only once its subject comes up.
 *
 * Standing context is paid for on every request of every session, including
 * the ones that never go near its subject. A cue is the same guidance with a
 * condition attached — it costs nothing until the conversation earns it.
 */
export interface Cue {
	/** Stable id: what `/cues` lists, and what a file's name becomes. */
	id: string;
	/** One line describing what the note is for. */
	summary: string;
	/** Any one of these arms the cue. */
	trigger: string[];
	/** When present, one of these must appear too — both halves or nothing. */
	with?: string[];
	/** Any one of these means the note has nothing to add; never arms. */
	unless?: string[];
	/** The note itself, injected verbatim. */
	note: string;
	/** Where it came from, for the listing. */
	source: "built-in" | string;
}

/** Verbs that mean something is being started rather than discussed. */
const BUILD_WORDS = [
	"build",
	"make",
	"create",
	"start",
	"scaffold",
	"bootstrap",
	"spin up",
	"set up",
	"setup",
	"new",
	"init",
	"generate",
];

/** Things that are a web app when you build one. */
const WEB_WORDS = [
	"web app",
	"webapp",
	"web application",
	"website",
	"web site",
	"landing page",
	"marketing site",
	"dashboard",
	"single page app",
	"single-page app",
	"spa",
	"frontend",
	"front-end",
	"admin panel",
	"web ui",
	"site",
];

/**
 * Stacks and starters. Naming one answers the question the note exists to
 * answer, so the note stays out — including when the answer is Vite itself.
 */
const STACK_WORDS = [
	"vite",
	"react router",
	"next.js",
	"nextjs",
	"next js",
	"remix",
	"astro",
	"sveltekit",
	"svelte",
	"nuxt",
	"angular",
	"solidstart",
	"solid.js",
	"gatsby",
	"create-react-app",
	"cra",
	"vue",
	"qwik",
	"tanstack",
	"htmx",
	"rails",
	"django",
	"laravel",
	"phoenix",
];

/**
 * The cues that ship with smolt.
 *
 * Deliberately few. Every entry here is context somebody will pay for, so a
 * cue earns its place by answering a question the model would otherwise
 * answer differently each time.
 */
export const BUILT_IN_CUES: Cue[] = [
	{
		id: "web-stack",
		summary: "Default stack for a new web app",
		trigger: BUILD_WORDS,
		with: WEB_WORDS,
		unless: STACK_WORDS,
		note:
			"## Web stack\n" +
			"A new web app with no stack named starts on Vite with React Router. " +
			"What the user asks for wins, and so does the stack a project already builds with.",
		source: "built-in",
	},
];

/** Whole-word, whitespace-tolerant phrase match. */
function mentions(text: string, phrases: string[] | undefined): boolean {
	if (!phrases || phrases.length === 0) return false;
	return phrases.some((phrase) => {
		const trimmed = phrase.trim();
		if (trimmed === "") return false;
		const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
		return new RegExp(`\\b${escaped}\\b`, "i").test(text);
	});
}

/**
 * Does this prompt call for the cue?
 *
 * `unless` is checked first: a prompt that already settles the question gets
 * no note, however well the triggers match.
 */
export function cueMatches(cue: Cue, text: string): boolean {
	if (text.trim() === "") return false;
	if (mentions(text, cue.unless)) return false;
	if (!mentions(text, cue.trigger)) return false;
	if (cue.with && cue.with.length > 0 && !mentions(text, cue.with)) return false;
	return true;
}

/** Every cue the prompt arms, in table order. */
export function matchingCues(cues: Cue[], text: string): Cue[] {
	return cues.filter((cue) => cueMatches(cue, text));
}

function asStringList(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Read a cue file: YAML frontmatter over the note itself.
 *
 * ---
 * summary: Which test runner this house uses
 * trigger: [test, tests, spec]
 * with: [write, add, run]
 * unless: [jest, mocha]
 * ---
 * ## Tests
 * New test files go under test/ and run with vitest.
 */
export function parseCueFile(id: string, raw: string, source: string): Cue | undefined {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
	if (!match) return undefined;
	let front: unknown;
	try {
		front = parseYaml(match[1] ?? "");
	} catch {
		return undefined;
	}
	if (front === null || typeof front !== "object" || Array.isArray(front)) return undefined;
	const fields = front as Record<string, unknown>;
	const trigger = asStringList(fields.trigger);
	const note = (match[2] ?? "").trim();
	// A cue with no trigger would be standing context wearing a disguise, and a
	// cue with no note has nothing to say: both are dropped rather than half-run.
	if (trigger.length === 0 || note === "") return undefined;
	return {
		id,
		summary: typeof fields.summary === "string" ? fields.summary : id,
		trigger,
		with: asStringList(fields.with),
		unless: asStringList(fields.unless),
		note,
		source,
	};
}

/**
 * Load user cues from a directory of markdown files, newest definition of a
 * given id winning over the built-in of the same name.
 */
export function loadCueDir(dir: string): Cue[] {
	if (!existsSync(dir)) return [];
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const cues: Cue[] = [];
	for (const name of names.sort()) {
		if (extname(name).toLowerCase() !== ".md") continue;
		const path = join(dir, name);
		try {
			const cue = parseCueFile(name.slice(0, -3), readFileSync(path, "utf-8"), path);
			if (cue) cues.push(cue);
		} catch {
			// An unreadable cue is one missing note, never a broken session.
		}
	}
	return cues;
}

/** Built-ins plus user files, with a user file of the same id replacing one. */
export function mergeCues(builtIn: Cue[], user: Cue[]): Cue[] {
	const byId = new Map<string, Cue>();
	for (const cue of builtIn) byId.set(cue.id, cue);
	for (const cue of user) byId.set(cue.id, cue);
	return [...byId.values()];
}
