import { join } from "node:path";
import { Type } from "typebox";
// Type-only import: a standalone install of this module outside the smolt
// tree switches this single line to `from "smolt"`.
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { TICKET_TYPES, type WayfinderSession, WayfinderStore, wayfinderTool } from "./store.ts";

/**
 * Wayfinder: chart work too big for one session as a shared map of decision
 * tickets, then resolve them one session at a time until the way to the
 * destination is clear.
 *
 * This is the code-backed evolution of the wayfinder *skill*. A skill can
 * only instruct; this module enforces. The store computes the frontier,
 * validates blocking edges, arbitrates claims between concurrent sessions,
 * and holds the one-decision-per-session line — while the /wayfinder command
 * loads the full working doctrine only when it is actually needed, and a
 * compact status block keeps every session oriented for the cost of a few
 * lines of prompt.
 *
 * The map lives in `<project>/.smolt/wayfinder/`, so it is shared the same
 * way the code is: through the repo.
 */

function wayfinderRoot(): string {
	return join(process.cwd(), ".smolt", "wayfinder");
}

const DOCTRINE = `## Wayfinder

This project has an active wayfinder map: a shared plan of decision tickets for work too big for one session. Doctrine:
- Plan, don't do: tickets resolve decisions, not deliverables, unless the map's Notes say otherwise.
- One non-research decision per session (enforced by the tool); each decision deserves fresh context.
- Claim before work; refer to maps and tickets by their names, not bare slugs.
- Orient with wayfinder action 'view' before touching a map. /wayfinder starts a full working session.`;

function chartPrompt(idea: string): string {
	const seed = idea === "" ? "" : `\n\nThe idea, as given: ${idea}`;
	return `Chart a wayfinder map. A loose idea has arrived that is too big for one session; your job this session is to chart the way, not to walk it.${seed}

1. Name the destination. Interview me to pin down what this map is finding its way to: a spec, a locked decision, or a change made in place. Ask focused questions ONE at a time, and let my answers steer the next question. The destination fixes the scope, so settle it first.
2. Map the frontier, breadth-first. Fan out across the whole space rather than deep on any one thread: surface the open decisions, the investigations they wait on, and the first steps takeable now. If this surfaces no fog at all (the whole journey fits one session), say so and stop — no map needed.
3. Create the map with the wayfinder tool (action 'chart'): title, destination, notes (domain context, standing preferences), and the fog — decisions you can sense coming but cannot yet phrase sharply — as 'Not yet specified' entries.
4. Create the tickets you can state precisely NOW (action 'add_ticket'). Each ticket is one question sized to one session, typed research (fact-finding you do alone), prototype (a cheap artifact to react to), grilling (a decision made by interviewing me), or task (prerequisite work that unblocks a decision). Wire blocking edges with 'update_ticket' in a second pass. The test for ticket vs fog: can you state the question precisely now? Blocked-but-sharp is a ticket; vague is fog.
5. Stop. Charting is one session's work: resolve nothing yourself today. Close by showing me the map (action 'view') and naming the frontier tickets a next session can take. Any research tickets you created are picked up automatically after your turn ends — you don't need to start them.`;
}

function workPrompt(mapRef: string, ticketRef: string | undefined): string {
	const choose = ticketRef ? `Work the ticket '${ticketRef}'.` : "Pick the first frontier ticket unless I name one.";
	return `Work through the wayfinder map '${mapRef}'. ${choose}

1. Orient: wayfinder action 'view' for the low-resolution map. Read the destination and decisions so far; zoom into related closed tickets with 'view_ticket' only as needed.
2. Claim the ticket (action 'claim') BEFORE any work on it, so concurrent sessions skip it.
3. Resolve it by its type. grilling: interview me, one focused question at a time — never answer your own questions. When the choice draws on earlier research, put the substance in front of me: names, markdown links, prices, the deciding facts — I must be able to judge the options from your message alone, never by opening the map or a ticket. research: investigate alone (docs, code, the web) and bring back the fact the decision waits on. prototype: build a cheap, rough, concrete artifact and get my reaction; link it, don't paste it. task: do the prerequisite work, or hand me a precise checklist for the parts only I can do.
4. Record it: action 'resolve' with the full resolution and a one-line gist. Resolutions that name external things carry their URLs. The gist becomes the map's decisions index; the detail lives only on the ticket.
5. Tend the map: graduate fog the answer has made specifiable into new tickets ('add_ticket', then remove the fog entry via update_map remove_fog), rule newly-out-of-scope work out with 'scope_out', and update tickets the decision invalidated.

Plan, don't do — tickets produce decisions, not deliverables, unless the map's Notes say otherwise. One non-research decision per session: once it is made and the map is tended, end your turn with a summary of where the frontier stands. Do not start research tickets yourself in this turn and do not resolve a second decision — if research is takeable, the harness compacts the session and hands it to you in a fresh turn automatically.`;
}

/** /wayfinder given a request in the user's own words while maps are already active. */
function requestPrompt(request: string, active: { slug: string; title: string; destination: string }[]): string {
	const lines = active
		.map((map) => `- ${map.title} (map: ${map.slug}): ${map.destination.split("\n")[0] ?? ""}`)
		.join("\n");
	return `I invoked /wayfinder with a request in my own words, not a map name:

${request}

Maps already active:
${lines}

Work out which this is, and say which you chose in one line before acting:
- A NEW effort, too big for one session and not covered by the maps above: chart it. Interview me to name the destination (one question at a time), map the frontier breadth-first, then create the map with the wayfinder tool (action 'chart') plus the tickets you can state precisely now, and stop without resolving any. If the whole job fits one session, say so and just do it instead — no map needed.
- Work on one of the maps above: orient with wayfinder action 'view', then take the frontier ticket my request points at (claim it before any work), resolve it by its type, record it with 'resolve', and tend the map. One non-research decision per session.
- Genuinely ambiguous between the two: ask me one short question rather than guessing.`;
}

/**
 * Below this share of the context window, the auto-continuation skips
 * compaction: a short session is already fresh, and summarizing it would
 * cost an LLM call to save nothing.
 */
const COMPACT_MIN_PERCENT = 25;

const COMPACT_INSTRUCTIONS =
	"This session is continuing onto wayfinder research tickets. Preserve: the map slug, the destination, " +
	"every decision gist, and any facts the user stated that are not yet recorded on the map. The " +
	"interview back-and-forth can be dropped — full detail lives on the map's tickets on disk.";

function researchPrompt(jobs: { map: string; tickets: string[] }[]): string {
	const lines = jobs.map((job) => `- map '${job.map}': ${job.tickets.join(", ")}`).join("\n");
	return `Wayfinder auto-continuation: the decision work of this session is recorded on the map; the takeable research frontier is now yours:
${lines}

Re-orient with wayfinder action 'view' first — the map on disk holds everything you need. Then for EACH listed ticket: claim it, investigate alone (code, docs, the web), and resolve it with the full answer plus a one-line gist. Findings that name external things (products, services, places, pages) must carry their URLs in the resolution. Research tickets are exempt from the one-decision limit, so work through all of them, including any that further resolutions unblock. Do NOT resolve grilling, prototype, or task tickets — those wait for the user. When no research remains takeable, tend the map (graduate fog, wire new tickets) and close by SHOWING the user what you found: the actual results — names as markdown links, prices, the facts that matter — plus where the frontier now stands. "Recorded on the map" is not a summary; the user must see the findings without opening anything. This turn runs unattended, so if the telegram tool is available and linked, also send the user a short completion message there — the headline findings with links, and what's now takeable.`;
}

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
}

export interface WayfinderPaths {
	root: string;
}

export default function wayfinderExtension(smolt: ExtensionAPI): void {
	createWayfinderExtension(smolt, { root: wayfinderRoot() });
}

export function createWayfinderExtension(smolt: ExtensionAPI, paths: WayfinderPaths): WayfinderStore {
	const store = new WayfinderStore(paths.root);
	const session: WayfinderSession = { id: "", nonResearchResolutions: 0 };

	let frozen: string | undefined;
	// Maps touched this turn in a way that can leave research takeable
	// (a resolution, or a research ticket created). Checked at agent_settled.
	const armedMaps = new Set<string>();

	smolt.on("session_start", async () => {
		frozen = undefined;
		session.nonResearchResolutions = 0;
		armedMaps.clear();
	});

	/** The run now settling was aborted by the user; Stop means stop. */
	let lastRunAborted = false;
	smolt.on("agent_end", async (event) => {
		const last = [...event.messages].reverse().find((message) => message.role === "assistant");
		lastRunAborted = (last as { stopReason?: string } | undefined)?.stopReason === "aborted";
	});

	smolt.on("agent_settled", async (_event, ctx) => {
		if (lastRunAborted) return;
		if (armedMaps.size === 0) return;
		const targets = [...armedMaps];
		armedMaps.clear();
		// Auto-continuation only where a conversation surface exists, and never
		// over a message the user already queued.
		if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
		if (ctx.hasPendingMessages()) return;
		const jobs: { map: string; tickets: string[] }[] = [];
		for (const slug of targets) {
			const research = store
				.frontier(slug)
				.filter((ticket) => ticket.type === "research")
				.map((ticket) => ticket.slug);
			if (research.length > 0) jobs.push({ map: slug, tickets: research });
		}
		if (jobs.length === 0) return;
		const send = () => smolt.sendUserMessage(researchPrompt(jobs));
		const percent = ctx.getContextUsage()?.percent;
		if (percent !== null && percent !== undefined && percent >= COMPACT_MIN_PERCENT) {
			ctx.compact({ customInstructions: COMPACT_INSTRUCTIONS, onComplete: send, onError: send });
		} else {
			send();
		}
	});

	smolt.on("before_agent_start", async (event) => {
		if (frozen === undefined) {
			const active = store.listMaps().filter((map) => map.status === "active");
			if (active.length === 0) {
				frozen = "";
			} else {
				const lines = active.map((map) => {
					const open = store.listTickets(map.slug).filter((ticket) => ticket.status === "open").length;
					const frontier = store.frontier(map.slug).length;
					const destination = map.destination.split("\n")[0] ?? "";
					return `- ${map.title} (map: ${map.slug}): ${destination} — ${frontier} takeable of ${open} open tickets, ${map.fog.length} fog entries`;
				});
				frozen = `${DOCTRINE}\n\nActive maps:\n${lines.join("\n")}`;
			}
		}
		if (frozen === "") return;
		return { systemPrompt: `${event.systemPrompt}\n\n${frozen}` };
	});

	smolt.registerTool({
		name: "wayfinder",
		label: "Wayfinder",
		description:
			"Chart and work shared wayfinder maps: plans for work too big for one session, stored in the " +
			"project's .smolt/wayfinder/ directory so they travel with the repo. A map holds a destination " +
			"plus decision tickets (questions, not build slices); sessions resolve them one at a time until " +
			"the way is clear.\n\n" +
			"ACTIONS: 'list' all maps; 'chart' a new map (title, destination, notes?, fog?); 'view' a map's " +
			"low-res state (destination, decisions so far, frontier, blocked, claimed, fog, out of scope); " +
			"'view_ticket' for one ticket's full body; 'add_ticket' (map, title, type, question, " +
			"blocked_by?); 'update_ticket' to rewire blocked_by or refine the question; 'claim' / 'release' " +
			"a ticket for this session; 'resolve' (map, ticket, resolution, gist?) to record a decision and " +
			"close the ticket; 'scope_out' (map, reason, ticket? or gist?) to rule work beyond the " +
			"destination; 'update_map' (destination?, notes?, add_fog?, remove_fog?, status?).\n\n" +
			`RULES the tool enforces: ticket types are ${TICKET_TYPES.join("/")}; blocking edges must exist ` +
			"and stay acyclic; claim before resolve; a fresh claim by another session blocks yours; one " +
			"non-research resolution per session; a map completes only when no open tickets or fog remain. " +
			"The frontier (open, unblocked, unclaimed) is computed for you — never track it by hand.\n\n" +
			"WHEN: the user invokes /wayfinder, asks to plan something plainly bigger than one session, or " +
			"a decision made mid-session belongs on an active map. Refer to maps and tickets by their " +
			"names in prose; slugs are for tool calls.",
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("list"),
					Type.Literal("chart"),
					Type.Literal("view"),
					Type.Literal("view_ticket"),
					Type.Literal("add_ticket"),
					Type.Literal("update_ticket"),
					Type.Literal("claim"),
					Type.Literal("release"),
					Type.Literal("resolve"),
					Type.Literal("scope_out"),
					Type.Literal("update_map"),
				],
				{ description: "Operation to perform" },
			),
			map: Type.Optional(Type.String({ description: "Map slug or title (all actions except list/chart)" })),
			ticket: Type.Optional(Type.String({ description: "Ticket slug or title" })),
			title: Type.Optional(Type.String({ description: "Human-readable name for a new map or ticket" })),
			destination: Type.Optional(
				Type.String({
					description:
						"What reaching the end of the map looks like: the spec, decision, or change this effort is finding its way to. One or two lines.",
				}),
			),
			notes: Type.Optional(
				Type.String({ description: "Map notes: domain context and standing preferences for the effort" }),
			),
			type: Type.Optional(
				Type.Union(
					[Type.Literal("research"), Type.Literal("prototype"), Type.Literal("grilling"), Type.Literal("task")],
					{
						description:
							"Ticket type: research = fact-finding done alone; prototype = cheap artifact for the user to react to; grilling = decision made by interviewing the user; task = prerequisite work that unblocks a decision.",
					},
				),
			),
			question: Type.Optional(
				Type.String({ description: "The decision or investigation a ticket resolves, sized to one session" }),
			),
			blocked_by: Type.Optional(
				Type.Array(Type.String(), {
					description: "Ticket slugs that must close before this ticket is takeable (validated, acyclic)",
				}),
			),
			resolution: Type.Optional(
				Type.String({ description: "The full answer recorded on the ticket when resolving it" }),
			),
			gist: Type.Optional(
				Type.String({
					description:
						"One-line summary of the resolution for the map's decisions index (defaults to the resolution's first line)",
				}),
			),
			reason: Type.Optional(Type.String({ description: "Why the work is out of scope (scope_out)" })),
			fog: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Initial 'Not yet specified' entries when charting: decisions you can sense coming but cannot yet phrase sharply",
				}),
			),
			add_fog: Type.Optional(Type.Array(Type.String(), { description: "Fog entries to add (update_map)" })),
			remove_fog: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Fog entries to remove, e.g. after graduating them into tickets (update_map; matched by unique substring)",
				}),
			),
			status: Type.Optional(
				Type.Union([Type.Literal("active"), Type.Literal("complete")], {
					description: "Map status (update_map). 'complete' requires no open tickets and no fog.",
				}),
			),
			force: Type.Optional(
				Type.Boolean({
					description: "Override a foreign claim or open blockers when claiming. Only when the user says to.",
				}),
			),
			override_session_limit: Type.Optional(
				Type.Boolean({
					description:
						"Resolve a second non-research ticket in this session. Only when the user explicitly asks to continue.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			session.id = ctx.sessionManager.getSessionId();
			const result = wayfinderTool(store, session, params);
			if (result.success === true && typeof result.map === "string") {
				const armsContinuation =
					params.action === "resolve" || (params.action === "add_ticket" && params.type === "research");
				if (armsContinuation) armedMaps.add(result.map);
			}
			return textResult(JSON.stringify(result));
		},
	});

	smolt.registerCommand("wayfinder", {
		description: "Chart or work a wayfinder map: plan big work as decision tickets",
		getArgumentCompletions: (argumentPrefix) => {
			const items = [
				{ value: "chart", label: "chart", description: "Chart a new map from a loose idea" },
				...store.listMaps().map((map) => ({
					value: map.slug,
					label: map.slug,
					description: `${map.status === "complete" ? "[complete] " : ""}${map.title}: ${store.frontier(map.slug).length} takeable`,
				})),
			];
			const prefix = argumentPrefix.trim().toLowerCase();
			return items.filter((item) => item.value.startsWith(prefix));
		},
		handler: async (args, _ctx) => {
			const trimmed = args.trim();
			if (trimmed === "chart" || trimmed.startsWith("chart ")) {
				smolt.sendUserMessage(chartPrompt(trimmed.slice("chart".length).trim()));
				return;
			}
			const active = store.listMaps().filter((map) => map.status === "active");
			if (trimmed !== "") {
				// The first word is a map only when it actually names one. Anything
				// else is a loose idea in the user's own words — never a slug, or
				// "/wayfinder What should we build" charts a map called 'What'.
				const [first, ...rest] = trimmed.split(/\s+/);
				const named = store.resolveMap(first ?? "");
				if (named) {
					smolt.sendUserMessage(workPrompt(named.slug, rest.join(" ") || undefined));
					return;
				}
				if (active.length === 0) {
					smolt.sendUserMessage(chartPrompt(trimmed));
					return;
				}
				smolt.sendUserMessage(requestPrompt(trimmed, active));
				return;
			}
			if (active.length === 0) {
				smolt.sendUserMessage(chartPrompt(""));
				return;
			}
			if (active.length === 1) {
				smolt.sendUserMessage(workPrompt(active[0]!.slug, undefined));
				return;
			}
			smolt.sendUserMessage(
				"I invoked /wayfinder and several maps are active. List them with the wayfinder tool (action 'list'), show me each map's destination and takeable frontier, and ask which one to work.",
			);
		},
	});

	return store;
}
