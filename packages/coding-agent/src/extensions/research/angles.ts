/**
 * Who the researchers are.
 *
 * A research run is only as good as the spread of angles it attacks the
 * subject from. One pass by one mindset finds one kind of answer; a source
 * diver, a network sleuth and a historian working the same question find
 * three different halves of the truth, and the report is where they meet.
 *
 * Angles are dealt without replacement so a run of N researchers covers N
 * distinct approaches, and the traits layered on top — tenacity, rigor,
 * scope — are rolled per researcher. Two runs of the same size never field
 * quite the same team, which is deliberate: it is how a second run on the
 * same subject finds what the first missed.
 */

export interface ResearcherTraits {
	/** How far they push when the obvious route is blocked. */
	tenacity: "dogged" | "relentless" | "obsessive";
	/** How much proof they need before they call something a finding. */
	rigor: "accepting" | "careful" | "forensic";
	/** How much of the subject they try to cover before going deep. */
	scope: "narrow" | "balanced" | "wide";
}

export interface Researcher {
	slug: string;
	/** A human name, so notes read like a person wrote them. */
	name: string;
	angle: string;
	/** How this angle approaches a subject. */
	description: string;
	/** What this angle finds that the others walk past. */
	lens: string;
	traits: ResearcherTraits;
	/** Which dispatch of the run this researcher belongs to; 1 for the first team. */
	wave?: number;
}

interface Angle {
	angle: string;
	description: string;
	lens: string;
}

/**
 * The angles a run deals from, one per researcher before any repeats.
 * Together they cover how a thing works, what it is made of, how it talks
 * to the world, what its makers said, what its users say, how it changed,
 * how its peers do it, and whether any of that survives being checked.
 */
export const ANGLES: readonly Angle[] = [
	{
		angle: "source-diver",
		description:
			"Believes the code, not the copy. Goes straight for what the thing is made of: page source, " +
			"script bundles and their source maps, public repositories, package registries, config files, " +
			"API schemas, anything that shows how it is actually built.",
		lens: "source code, bundles, source maps, repositories, packages, schemas, build artifacts",
	},
	{
		angle: "observer",
		description:
			"Uses the thing the way its real users do and watches closely. Walks the flows in a browser, " +
			"takes the screenshots, reads the rendered page, triggers the behavior under study and " +
			"records exactly what happens, step by step.",
		lens: "observed behavior, rendered pages, flows, what actually happens versus what is claimed",
	},
	{
		angle: "network-sleuth",
		description:
			"Reads the traffic. Watches every request the page makes — endpoints, payloads, headers, " +
			"cookies, third-party calls, timing — and reconstructs the machinery behind the interface " +
			"from what crosses the wire.",
		lens: "requests, endpoints, payloads, headers, cookies, third-party services, timing",
	},
	{
		angle: "documentarian",
		description:
			"Starts with what the makers wrote down: official docs, API references, changelogs, help " +
			"centers, engineering blogs, talks, and legal pages. Knows the official story is a claim, and " +
			"marks it as one until someone else confirms it.",
		lens: "official documentation, references, changelogs, blog posts, terms and policies",
	},
	{
		angle: "historian",
		description:
			"Asks how it got this way. Reads archived versions, release notes, commit history, old " +
			"announcements and deprecations, and turns the timeline into an explanation of the present.",
		lens: "archived pages, version history, release notes, commits, what changed and when",
	},
	{
		angle: "community-listener",
		description:
			"Goes where users and builders talk: issue trackers, forums, Q&A sites, discussions, reviews, " +
			"social threads. Finds the workarounds, the complaints, and the accidental disclosures that " +
			"never make the official docs.",
		lens: "issues, forums, Q&A, discussions, reviews, workarounds, complaints, leaks",
	},
	{
		angle: "comparator",
		description:
			"Looks sideways. Studies how peers, competitors, standards and reference implementations do " +
			"the same thing, so the subject's choices show up as choices — and the common pattern shows " +
			"up as the pattern.",
		lens: "competitors, standards, specifications, reference implementations, common patterns",
	},
	{
		angle: "verifier",
		description:
			"Trusts nothing the team has found yet. Takes the strongest claims and tries to break them: " +
			"reproduces, cross-checks against an independent source, hunts for the contradiction. A " +
			"claim that survives the verifier is a finding; one that does not is a correction.",
		lens: "cross-checking, reproduction, contradictions, the difference between claim and fact",
	},
	{
		angle: "experimenter",
		description:
			"Answers by doing. Builds the minimal reproduction, runs the code, calls the endpoint, " +
			"measures the numbers, and reports what the experiment said rather than what anyone wrote.",
		lens: "reproductions, experiments, measurements, running code, empirical answers",
	},
	{
		angle: "cartographer",
		description:
			"Maps the territory before anyone digs. Decomposes the subject into the sharp sub-questions " +
			"that would settle it, finds the best entry point for each, and keeps the question map " +
			"honest as answers come in — what is settled, what is open, what turned out not to matter.",
		lens: "the question map: decomposition, entry points, what is settled, what is still open",
	},
];

/**
 * First names of scientists, philosophers, explorers and historians — as
 * many as MAX_RESEARCHERS, so even a full-size run never repeats a name.
 */
const NAMES = [
	"Ada",
	"Alan",
	"Albert",
	"Alexander",
	"Blaise",
	"Charles",
	"Darwin",
	"Emmy",
	"Galileo",
	"Grace",
	"Herodotus",
	"Hypatia",
	"Ibn",
	"Isaac",
	"Johannes",
	"Katherine",
	"Leonardo",
	"Marie",
	"Nellie",
	"Niels",
	"Nikola",
	"Rosalind",
	"Sherlock",
	"Thucydides",
	"Zheng",
];

const TENACITY: ResearcherTraits["tenacity"][] = ["dogged", "relentless", "obsessive"];
const RIGOR: ResearcherTraits["rigor"][] = ["accepting", "careful", "forensic"];
const SCOPE: ResearcherTraits["scope"][] = ["narrow", "balanced", "wide"];

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
			.replace(/^-+|-+$/g, "") || "researcher"
	);
}

function build(angle: Angle, name: string, rng: Rng, traits?: Partial<ResearcherTraits>): Researcher {
	return {
		slug: slugify(`${name}-${angle.angle}`),
		name,
		angle: angle.angle,
		description: angle.description,
		lens: angle.lens,
		traits: {
			tenacity: traits?.tenacity ?? pick(TENACITY, rng),
			rigor: traits?.rigor ?? pick(RIGOR, rng),
			scope: traits?.scope ?? pick(SCOPE, rng),
		},
	};
}

/**
 * Deal a team of researchers.
 *
 * Coverage first, then chance: angles are dealt without replacement so the
 * first `ANGLES.length` researchers are all different approaches; only a
 * bigger team than that repeats an angle, and a repeat still gets its own
 * name and its own trait rolls. `rng` is injectable so tests can be
 * deterministic while real runs never are.
 */
export function generateResearchers(count: number, rng: Rng = Math.random): Researcher[] {
	const names = shuffled(NAMES, rng);
	const deck = shuffled(ANGLES, rng);
	const team: Researcher[] = [];
	for (let index = 0; index < count; index++) {
		team.push(build(deck[index % deck.length]!, names[index % names.length]!, rng));
	}
	return team;
}

/** The angle names a supervisor can pick from, in deck order. */
export const ANGLE_NAMES: readonly string[] = ANGLES.map((angle) => angle.angle);

/** One seat on a picked team: an angle from the deck, optionally narrowed to a focus. */
export interface AnglePick {
	angle: string;
	/** What this researcher should aim its angle at, e.g. "the checkout flow". */
	focus?: string;
}

/**
 * Read a pick the way a supervisor writes it: "network-sleuth", "network sleuth",
 * or "network-sleuth: the checkout flow". Unknown angles come back undefined.
 */
export function parseAnglePick(text: string): AnglePick | undefined {
	const [head = "", ...rest] = text.split(":");
	const name = head
		.trim()
		.toLowerCase()
		.replace(/[\s_]+/g, "-");
	const angle = ANGLES.find((candidate) => candidate.angle === name);
	if (!angle) return undefined;
	const focus = rest.join(":").trim();
	return focus === "" ? { angle: angle.angle } : { angle: angle.angle, focus };
}

/**
 * A team picked by the supervising agent rather than dealt from the deck:
 * each seat is a named angle, optionally narrowed to a focus, so a subject
 * about a site's mechanism gets an observer, a network sleuth and a source
 * diver rather than whatever the shuffle turns up. Names and traits still
 * roll the usual way; a focused angle is relentless by default, because it
 * was picked for a reason.
 */
export function generateResearchTeam(picks: AnglePick[], rng: Rng = Math.random): Researcher[] {
	const names = shuffled(NAMES, rng);
	return picks.map((pick, index) => {
		const angle = ANGLES.find((candidate) => candidate.angle === pick.angle);
		if (!angle) throw new Error(`unknown angle '${pick.angle}'; one of: ${ANGLE_NAMES.join(", ")}`);
		const focus = pick.focus?.trim() ?? "";
		const aimed: Angle =
			focus === ""
				? angle
				: {
						angle: angle.angle,
						description: `${angle.description} For this run, aim that at: ${focus}.`,
						lens: `${angle.lens} — especially ${focus}`,
					};
		return build(aimed, names[index % names.length]!, rng, focus === "" ? undefined : { tenacity: "relentless" });
	});
}

/** One line per researcher, for the kickoff message and the run listing. */
export function describeResearcher(researcher: Researcher): string {
	const traits = researcher.traits;
	return (
		`${researcher.name} the ${researcher.angle} — ${traits.tenacity}, ${traits.rigor} about evidence, ` +
		`${traits.scope} scope. Looks for: ${researcher.lens}.`
	);
}
