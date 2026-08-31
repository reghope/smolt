/**
 * Who the testers are.
 *
 * A battletest run is only as good as the spread of people it simulates. One
 * pass by one temperament finds one kind of problem; a first-timer, a power
 * user and a chaos monkey walking the same app find three different apps.
 *
 * Personas are generated fresh for every run and are deliberately
 * non-deterministic: archetypes are dealt without replacement so a run of N
 * testers covers N distinct angles, and the human traits layered on top —
 * patience, expertise, temperament, thoroughness — are rolled per tester. Two
 * runs of the same size never field quite the same team, which is the point:
 * real user bases are not deterministic either.
 */

export interface PersonaTraits {
	/** How long they tolerate friction before it becomes a finding. */
	patience: "low" | "medium" | "high";
	/** How much they already know about software like this. */
	expertise: "novice" | "comfortable" | "expert";
	/** The register their notes and tickets arrive in. */
	temperament: "forgiving" | "blunt" | "exacting";
	/** How much of the surface they cover before moving on. */
	thoroughness: "skims" | "balanced" | "exhaustive";
}

/** The screen a tester lives on for the run. */
export type Viewport = "desktop" | "mobile" | "tablet";

export interface Persona {
	slug: string;
	/** A human name, so notes read like a person wrote them. */
	name: string;
	archetype: string;
	/** How this archetype approaches an app. */
	description: string;
	/** What this archetype notices that others walk past. */
	lens: string;
	viewport: Viewport;
	traits: PersonaTraits;
}

interface Archetype {
	archetype: string;
	description: string;
	lens: string;
}

/**
 * The angles a run deals from, one per tester before any repeats. Together
 * they cover the ground the user cares about: bugs, UI inconsistency, UX
 * friction, performance, wording, accessibility, and plain breakage.
 */
export const ARCHETYPES: readonly Archetype[] = [
	{
		archetype: "first-timer",
		description:
			"Has never seen this app before and was not given a manual. Starts from the first screen and " +
			"follows whatever the interface suggests, getting lost exactly where a new user would.",
		lens: "onboarding, discoverability, empty states, whether the app explains itself",
	},
	{
		archetype: "power-user",
		description:
			"Lives in tools like this all day and expects speed. Reaches for keyboard shortcuts, bulk " +
			"actions, and settings first, and judges the app by how little it gets in the way.",
		lens: "shortcuts, efficiency of repeated actions, advanced settings, muscle-memory conventions",
	},
	{
		archetype: "skimmer",
		description:
			"Impatient and task-driven. Scans instead of reading, clicks the first plausible thing, and " +
			"abandons any flow that takes more steps than it feels like it should.",
		lens: "flow length, visual hierarchy, what happens when you don't read the instructions",
	},
	{
		archetype: "auditor",
		description:
			"Walks every screen side by side looking for the app disagreeing with itself: spacing, " +
			"alignment, capitalisation, icon styles, colours, and states that don't match their siblings.",
		lens: "visual and behavioural consistency between screens, components, and states",
	},
	{
		archetype: "accessibility-advocate",
		description:
			"Uses the app the way someone who cannot rely on a mouse or perfect vision would: keyboard " +
			"only, checking focus order, contrast, target sizes, and whether state is conveyed by more " +
			"than colour.",
		lens: "keyboard navigation, focus visibility, contrast, labels, target sizes",
	},
	{
		archetype: "performance-hawk",
		description:
			"Feels every dropped frame. Times the slow paths, feeds the app more data than it expects, " +
			"resizes and scrolls hard, and watches for jank, spinners that overstay, and memory creep.",
		lens: "latency, jank, large inputs, startup time, anything that feels heavier than it should",
	},
	{
		archetype: "wordsmith",
		description:
			"Reads everything the app says, out loud if necessary. Catches typos, inconsistent " +
			"terminology, truncated labels, robotic error messages, and tone that changes mid-app.",
		lens: "copy, terminology consistency, truncation, error message quality, tone",
	},
	{
		archetype: "chaos-monkey",
		description:
			"Uses the app wrong on purpose: pastes the unexpected, double-clicks everything, cancels " +
			"mid-operation, goes back at the worst moment, and fills every field with the weirdest " +
			"thing that fits.",
		lens: "edge-case input, interrupted operations, rapid interaction, whatever nobody tested",
	},
	{
		archetype: "everyday-regular",
		description:
			"Represents the middle of the user base: runs the core flows the way they would every day, " +
			"expecting them to work the same way twice and to pick up where they left off.",
		lens: "the happy path done repeatedly, state persistence, whether routine work stays routine",
	},
	{
		archetype: "skeptic",
		description:
			"Trusts nothing the app claims. Verifies that saves saved and deletes deleted, forces errors " +
			"to see how they are reported, and checks what the app does when the world misbehaves.",
		lens: "error handling, data integrity, recovery, whether feedback tells the truth",
	},
];

/**
 * First names of scientists, philosophers, and historical figures — as many
 * as MAX_TESTERS, so even a full-size run never repeats a name.
 */
const NAMES = [
	"Ada",
	"Alan",
	"Albert",
	"Aristotle",
	"Blaise",
	"Charles",
	"Cleopatra",
	"Emmy",
	"Galileo",
	"Grace",
	"Hannah",
	"Hypatia",
	"Immanuel",
	"Isaac",
	"Johannes",
	"Katherine",
	"Leonardo",
	"Marie",
	"Niels",
	"Nikola",
	"Plato",
	"René",
	"Rosalind",
	"Simone",
	"Socrates",
];

/**
 * Viewports are dealt in a fixed cycle rather than rolled: any run of two or
 * more testers includes a phone-sized screen, and any run of four or more a
 * tablet. A real user base is mostly-desktop-with-phones-in-it; a random roll
 * could miss the phones entirely, and mobile is where layouts break.
 */
const VIEWPORT_CYCLE: readonly Viewport[] = ["desktop", "mobile", "desktop", "tablet"];

const PATIENCE: PersonaTraits["patience"][] = ["low", "medium", "high"];
const EXPERTISE: PersonaTraits["expertise"][] = ["novice", "comfortable", "expert"];
const TEMPERAMENT: PersonaTraits["temperament"][] = ["forgiving", "blunt", "exacting"];
const THOROUGHNESS: PersonaTraits["thoroughness"][] = ["skims", "balanced", "exhaustive"];

export type Rng = () => number;

function pick<T>(pool: readonly T[], rng: Rng): T {
	return pool[Math.floor(rng() * pool.length) % pool.length]!;
}

function shuffled<T>(pool: readonly T[], rng: Rng): T[] {
	const copy = [...pool];
	for (let index = copy.length - 1; index > 0; index--) {
		const swap = Math.floor(rng() * (index + 1));
		[copy[index], copy[swap]] = [copy[swap]!, copy[index]!];
	}
	return copy;
}

function slugify(text: string): string {
	return (
		text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "tester"
	);
}

/**
 * Deal a team of testers.
 *
 * Coverage first, then chaos: archetypes are dealt without replacement so the
 * first `ARCHETYPES.length` testers are all different angles; only a bigger
 * team than that repeats an archetype, and a repeat still gets its own name
 * and its own trait rolls. `rng` is injectable so tests can be deterministic
 * while real runs never are.
 */
export function generatePersonas(count: number, rng: Rng = Math.random): Persona[] {
	const names = shuffled(NAMES, rng);
	const deck = shuffled(ARCHETYPES, rng);
	const personas: Persona[] = [];
	for (let index = 0; index < count; index++) {
		const archetype = deck[index % deck.length]!;
		const name = names[index % names.length]!;
		personas.push({
			slug: slugify(`${name}-${archetype.archetype}`),
			name,
			archetype: archetype.archetype,
			description: archetype.description,
			lens: archetype.lens,
			viewport: VIEWPORT_CYCLE[index % VIEWPORT_CYCLE.length]!,
			traits: {
				patience: pick(PATIENCE, rng),
				expertise: pick(EXPERTISE, rng),
				temperament: pick(TEMPERAMENT, rng),
				thoroughness: pick(THOROUGHNESS, rng),
			},
		});
	}
	return personas;
}

/** The one-tester team's angle: everything, breadth first, no specialism. */
const GENERALIST: Archetype = {
	archetype: "generalist",
	description:
		"Covers the whole app end to end the way one thorough user would: every screen, every core flow, " +
		"breadth before depth, judging everything passed through — bugs, friction, speed, wording alike.",
	lens: "the complete surface: bugs, UX friction, performance, wording, consistency, accessibility",
};

/**
 * A team picked by the supervising agent rather than dealt from the deck: one
 * balanced generalist who goes over everything, plus up to two specialists
 * aimed at whatever the agent judged this project most needs scrutinised.
 * Names, remaining traits, and viewports still roll the usual way.
 */
export function generateTeam(specialists: string[], rng: Rng = Math.random): Persona[] {
	const names = shuffled(NAMES, rng);
	const build = (archetype: Archetype, index: number): Persona => {
		const name = names[index % names.length]!;
		return {
			slug: slugify(`${name}-${archetype.archetype}`),
			name,
			archetype: archetype.archetype,
			description: archetype.description,
			lens: archetype.lens,
			viewport: VIEWPORT_CYCLE[index % VIEWPORT_CYCLE.length]!,
			traits: {
				patience: pick(PATIENCE, rng),
				expertise: pick(EXPERTISE, rng),
				temperament: pick(TEMPERAMENT, rng),
				// The generalist is the balanced backbone of the team by definition.
				thoroughness: index === 0 ? "balanced" : pick(THOROUGHNESS, rng),
			},
		};
	};
	const team = [build(GENERALIST, 0)];
	specialists.slice(0, 2).forEach((focus, index) => {
		team.push(
			build(
				{
					archetype: "specialist",
					description:
						`Concentrates on what the supervising agent flagged for this project: ${focus}. ` +
						"Works that angle the way a domain reviewer would, deeper there than any generalist can go.",
					lens: focus,
				},
				index + 1,
			),
		);
	});
	return team;
}

/** One line per tester, for the kickoff message and the run listing. */
export function describePersona(persona: Persona): string {
	const traits = persona.traits;
	return (
		`${persona.name} the ${persona.archetype} — ${traits.patience} patience, ${traits.expertise} with ` +
		`software, ${traits.temperament}, ${traits.thoroughness === "skims" ? "skims" : `${traits.thoroughness} coverage`}, ` +
		`on a ${persona.viewport}-sized screen. Watches for: ${persona.lens}.`
	);
}
