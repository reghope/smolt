import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";

/**
 * Wayfinder: plan a chunk of work too big for one session as a shared map of
 * decision tickets, stored as markdown files under the project's
 * `.smolt/wayfinder/` directory so the map travels with the repo.
 *
 * The store is the tracker. Everything the original wayfinder practice left
 * to convention is enforced here in code:
 *
 * - The frontier (open, unblocked, unclaimed tickets) is computed, never
 *   hand-maintained.
 * - Claims are session-scoped with a freshness window, so concurrent
 *   sessions skip each other's work and crashed sessions release naturally.
 * - Blocking edges are validated (existing tickets only, no cycles).
 * - The decisions index is derived from closed tickets, so it can never
 *   drift from the tickets that hold the detail.
 * - Resolving a ticket reports which tickets it just unblocked.
 *
 * Every operation reads from disk, so multiple sessions (or a git pull) are
 * picked up immediately. Writes are atomic (temp file + rename).
 */

export type TicketType = "research" | "prototype" | "grilling" | "task";
export type WayfinderResult = Record<string, unknown>;

export const TICKET_TYPES: readonly TicketType[] = ["research", "prototype", "grilling", "task"];

/** A claim older than this is treated as abandoned and the ticket rejoins the frontier. */
export const CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

export interface WayfinderTicket {
	slug: string;
	title: string;
	type: TicketType;
	status: "open" | "closed";
	blockedBy: string[];
	claimedBy?: string;
	claimedAt?: string;
	created: string;
	closed?: string;
	outcome?: "resolved" | "out-of-scope";
	gist?: string;
	question: string;
	resolution?: string;
}

export interface WayfinderMap {
	slug: string;
	title: string;
	status: "active" | "complete";
	created: string;
	updated: string;
	destination: string;
	notes: string;
	fog: string[];
	outOfScope: string[];
}

interface MapFrontmatter {
	title?: string;
	status?: string;
	created?: string;
	updated?: string;
	fog?: unknown;
	outOfScope?: unknown;
}

interface TicketFrontmatter {
	title?: string;
	type?: string;
	status?: string;
	blockedBy?: unknown;
	claimedBy?: string;
	claimedAt?: string;
	created?: string;
	closed?: string;
	outcome?: string;
	gist?: string;
}

type TicketLookup = { ok: true; ticket: WayfinderTicket } | { ok: false; message: string };

function err(error: string): WayfinderResult {
	return { success: false, error };
}

function slugify(text: string): string {
	const slug = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64)
		.replace(/-+$/g, "");
	return slug || "item";
}

function atomicWrite(path: string, content: string): void {
	const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(temp, content, "utf-8");
	renameSync(temp, path);
}

function stringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

function splitFrontmatter(content: string): { yaml: string | null; body: string } {
	const normalized = content.replace(/\r\n/g, "\n").replace(/^﻿/, "");
	if (!normalized.startsWith("---")) return { yaml: null, body: normalized };
	const end = normalized.indexOf("\n---", 3);
	if (end === -1) return { yaml: null, body: normalized };
	return { yaml: normalized.slice(4, end), body: normalized.slice(end + 4).trim() };
}

/** Split a markdown body into its `## Heading` sections. */
function parseSections(body: string): Record<string, string> {
	const sections: Record<string, string> = {};
	let current: string | undefined;
	let buffer: string[] = [];
	const flush = () => {
		if (current !== undefined) sections[current] = buffer.join("\n").trim();
		buffer = [];
	};
	for (const line of body.split("\n")) {
		const heading = /^## (.+)$/.exec(line);
		if (heading) {
			flush();
			current = heading[1]!.trim();
		} else if (current !== undefined) {
			buffer.push(line);
		}
	}
	flush();
	return sections;
}

function firstLine(text: string): string {
	const line = text.split("\n")[0] ?? "";
	return line.length > 140 ? `${line.slice(0, 137)}...` : line;
}

export class WayfinderStore {
	readonly root: string;

	constructor(root: string) {
		this.root = root;
	}

	// ------------------------------------------------------------------
	// Disk layout: <root>/<map-slug>/map.md, <root>/<map-slug>/tickets/<slug>.md
	// ------------------------------------------------------------------

	private mapDir(mapSlug: string): string {
		return join(this.root, mapSlug);
	}

	private ticketsDir(mapSlug: string): string {
		return join(this.mapDir(mapSlug), "tickets");
	}

	private readMap(mapSlug: string): WayfinderMap | undefined {
		const path = join(this.mapDir(mapSlug), "map.md");
		if (!existsSync(path)) return undefined;
		const { yaml, body } = splitFrontmatter(readFileSync(path, "utf-8"));
		const fm = (yaml ? (parse(yaml) as MapFrontmatter) : {}) ?? {};
		const sections = parseSections(body);
		return {
			slug: mapSlug,
			title: fm.title ?? mapSlug,
			status: fm.status === "complete" ? "complete" : "active",
			created: fm.created ?? "",
			updated: fm.updated ?? "",
			destination: sections.Destination ?? "",
			notes: sections.Notes ?? "",
			fog: stringList(fm.fog),
			outOfScope: stringList(fm.outOfScope),
		};
	}

	private writeMap(map: WayfinderMap): void {
		mkdirSync(this.mapDir(map.slug), { recursive: true });
		const frontmatter = stringify({
			title: map.title,
			status: map.status,
			created: map.created,
			updated: map.updated,
			fog: map.fog,
			outOfScope: map.outOfScope,
		});
		const body = `## Destination\n\n${map.destination}\n\n## Notes\n\n${map.notes}\n`;
		atomicWrite(join(this.mapDir(map.slug), "map.md"), `---\n${frontmatter}---\n\n${body}`);
	}

	private readTicket(mapSlug: string, ticketSlug: string): WayfinderTicket | undefined {
		const path = join(this.ticketsDir(mapSlug), `${ticketSlug}.md`);
		if (!existsSync(path)) return undefined;
		const { yaml, body } = splitFrontmatter(readFileSync(path, "utf-8"));
		const fm = (yaml ? (parse(yaml) as TicketFrontmatter) : {}) ?? {};
		const sections = parseSections(body);
		const type = TICKET_TYPES.includes(fm.type as TicketType) ? (fm.type as TicketType) : "grilling";
		const ticket: WayfinderTicket = {
			slug: ticketSlug,
			title: fm.title ?? ticketSlug,
			type,
			status: fm.status === "closed" ? "closed" : "open",
			blockedBy: stringList(fm.blockedBy),
			created: fm.created ?? "",
			question: sections.Question ?? "",
		};
		if (fm.claimedBy) ticket.claimedBy = fm.claimedBy;
		if (fm.claimedAt) ticket.claimedAt = fm.claimedAt;
		if (fm.closed) ticket.closed = fm.closed;
		if (fm.outcome === "resolved" || fm.outcome === "out-of-scope") ticket.outcome = fm.outcome;
		if (fm.gist) ticket.gist = fm.gist;
		if (sections.Resolution) ticket.resolution = sections.Resolution;
		return ticket;
	}

	private writeTicket(mapSlug: string, ticket: WayfinderTicket): void {
		mkdirSync(this.ticketsDir(mapSlug), { recursive: true });
		const fm: Record<string, unknown> = {
			title: ticket.title,
			type: ticket.type,
			status: ticket.status,
			blockedBy: ticket.blockedBy,
			created: ticket.created,
		};
		if (ticket.claimedBy) fm.claimedBy = ticket.claimedBy;
		if (ticket.claimedAt) fm.claimedAt = ticket.claimedAt;
		if (ticket.closed) fm.closed = ticket.closed;
		if (ticket.outcome) fm.outcome = ticket.outcome;
		if (ticket.gist) fm.gist = ticket.gist;
		let body = `## Question\n\n${ticket.question}\n`;
		if (ticket.resolution) body += `\n## Resolution\n\n${ticket.resolution}\n`;
		atomicWrite(join(this.ticketsDir(mapSlug), `${ticket.slug}.md`), `---\n${stringify(fm)}---\n\n${body}`);
	}

	listMapSlugs(): string[] {
		if (!existsSync(this.root)) return [];
		return readdirSync(this.root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && existsSync(join(this.root, entry.name, "map.md")))
			.map((entry) => entry.name)
			.sort();
	}

	listMaps(): WayfinderMap[] {
		return this.listMapSlugs()
			.map((slug) => this.readMap(slug))
			.filter((map): map is WayfinderMap => map !== undefined);
	}

	listTickets(mapSlug: string): WayfinderTicket[] {
		const dir = this.ticketsDir(mapSlug);
		if (!existsSync(dir)) return [];
		return readdirSync(dir)
			.filter((name) => name.endsWith(".md"))
			.sort()
			.map((name) => this.readTicket(mapSlug, name.slice(0, -3)))
			.filter((ticket): ticket is WayfinderTicket => ticket !== undefined);
	}

	// ------------------------------------------------------------------
	// Lookup: accept a slug or a title, case-insensitively.
	// ------------------------------------------------------------------

	/**
	 * The map a reference names, or undefined. Unlike findMapSlug this never
	 * produces an error result: callers use it to ask "is this word a map?"
	 * without treating a plain English word as a failed lookup.
	 */
	resolveMap(ref: string): WayfinderMap | undefined {
		const needle = ref.trim().toLowerCase();
		if (needle === "") return undefined;
		const slug = this.listMapSlugs().find((candidate) => candidate === needle || candidate === slugify(ref));
		if (slug) return this.readMap(slug);
		const byTitle = this.listMaps().filter((map) => map.title.toLowerCase() === needle);
		return byTitle.length === 1 ? byTitle[0] : undefined;
	}

	private findMapSlug(ref: string): string | WayfinderResult {
		const slugs = this.listMapSlugs();
		const needle = ref.trim().toLowerCase();
		const exact = slugs.find((slug) => slug === needle || slug === slugify(ref));
		if (exact) return exact;
		const byTitle = slugs.filter((slug) => (this.readMap(slug)?.title ?? "").toLowerCase() === needle);
		if (byTitle.length === 1) return byTitle[0]!;
		if (slugs.length === 0) return err("No wayfinder maps exist yet. Chart one with action 'chart'.");
		return err(`Unknown map '${ref}'. Existing maps: ${slugs.join(", ")}`);
	}

	private findTicket(mapSlug: string, ref: string): TicketLookup {
		const needle = ref.trim().toLowerCase();
		const direct = this.readTicket(mapSlug, needle) ?? this.readTicket(mapSlug, slugify(ref));
		if (direct) return { ok: true, ticket: direct };
		const tickets = this.listTickets(mapSlug);
		const byTitle = tickets.filter((ticket) => ticket.title.toLowerCase() === needle);
		if (byTitle.length === 1) return { ok: true, ticket: byTitle[0]! };
		return {
			ok: false,
			message: `Unknown ticket '${ref}' on map '${mapSlug}'. Tickets: ${tickets.map((t) => t.slug).join(", ") || "(none)"}`,
		};
	}

	// ------------------------------------------------------------------
	// Frontier and blocking
	// ------------------------------------------------------------------

	private claimIsFresh(ticket: WayfinderTicket, now: number): boolean {
		if (!ticket.claimedBy || !ticket.claimedAt) return false;
		const at = Date.parse(ticket.claimedAt);
		return Number.isFinite(at) && now - at < CLAIM_TTL_MS;
	}

	private isUnblocked(ticket: WayfinderTicket, bySlug: Map<string, WayfinderTicket>): boolean {
		return ticket.blockedBy.every((slug) => bySlug.get(slug)?.status === "closed");
	}

	/** Open tickets whose blockers are all closed and whose claim is absent or stale. */
	frontier(mapSlug: string, now = Date.now()): WayfinderTicket[] {
		const tickets = this.listTickets(mapSlug);
		const bySlug = new Map(tickets.map((ticket) => [ticket.slug, ticket]));
		return tickets.filter(
			(ticket) => ticket.status === "open" && this.isUnblocked(ticket, bySlug) && !this.claimIsFresh(ticket, now),
		);
	}

	/** Reject a blockedBy edit that would make ticket depend on itself, directly or transitively. */
	private detectCycle(mapSlug: string, ticketSlug: string, blockedBy: string[]): string | undefined {
		const bySlug = new Map(this.listTickets(mapSlug).map((ticket) => [ticket.slug, ticket.blockedBy]));
		bySlug.set(ticketSlug, blockedBy);
		const visiting = new Set<string>();
		const done = new Set<string>();
		const visit = (slug: string): boolean => {
			if (done.has(slug)) return false;
			if (visiting.has(slug)) return true;
			visiting.add(slug);
			for (const dep of bySlug.get(slug) ?? []) if (visit(dep)) return true;
			visiting.delete(slug);
			done.add(slug);
			return false;
		};
		return visit(ticketSlug) ? `blocking cycle detected through '${ticketSlug}'` : undefined;
	}

	private touch(map: WayfinderMap): void {
		map.updated = new Date().toISOString();
		this.writeMap(map);
	}

	// ------------------------------------------------------------------
	// Operations
	// ------------------------------------------------------------------

	chart(params: { title: string; destination: string; notes?: string; fog?: string[] }): WayfinderResult {
		const slug = slugify(params.title);
		if (this.readMap(slug)) return err(`A map named '${slug}' already exists. View it or pick another title.`);
		const now = new Date().toISOString();
		const map: WayfinderMap = {
			slug,
			title: params.title,
			status: "active",
			created: now,
			updated: now,
			destination: params.destination.trim(),
			notes: (params.notes ?? "").trim(),
			fog: (params.fog ?? []).map((item) => item.trim()).filter((item) => item !== ""),
			outOfScope: [],
		};
		this.writeMap(map);
		return {
			success: true,
			map: slug,
			path: join(this.mapDir(slug), "map.md"),
			next: "Add the tickets you can state precisely now with add_ticket, then wire blocking edges with update_ticket.",
		};
	}

	addTicket(
		mapRef: string,
		params: { title: string; type: TicketType; question: string; blocked_by?: string[] },
	): WayfinderResult {
		const mapSlug = this.findMapSlug(mapRef);
		if (typeof mapSlug !== "string") return mapSlug;
		const map = this.readMap(mapSlug)!;
		if (map.status === "complete")
			return err(`Map '${mapSlug}' is complete. Reopen it with update_map status 'active' first.`);
		const existing = new Set(this.listTickets(mapSlug).map((ticket) => ticket.slug));
		let slug = slugify(params.title);
		for (let n = 2; existing.has(slug); n++) slug = `${slugify(params.title)}-${n}`;
		const blockedBy: string[] = [];
		for (const ref of params.blocked_by ?? []) {
			const blocker = this.findTicket(mapSlug, ref);
			if (!blocker.ok) return err(`blocked_by: ${blocker.message}`);
			blockedBy.push(blocker.ticket.slug);
		}
		this.writeTicket(mapSlug, {
			slug,
			title: params.title,
			type: params.type,
			status: "open",
			blockedBy,
			created: new Date().toISOString(),
			question: params.question.trim(),
		});
		this.touch(map);
		return { success: true, map: mapSlug, ticket: slug, blocked: blockedBy.length > 0 };
	}

	updateTicket(
		mapRef: string,
		ticketRef: string,
		params: { question?: string; blocked_by?: string[] },
	): WayfinderResult {
		const mapSlug = this.findMapSlug(mapRef);
		if (typeof mapSlug !== "string") return mapSlug;
		const found = this.findTicket(mapSlug, ticketRef);
		if (!found.ok) return err(found.message);
		const ticket = found.ticket;
		if (params.blocked_by !== undefined) {
			const blockedBy: string[] = [];
			for (const ref of params.blocked_by) {
				const blocker = this.findTicket(mapSlug, ref);
				if (!blocker.ok) return err(`blocked_by: ${blocker.message}`);
				const slug = blocker.ticket.slug;
				if (slug === ticket.slug) return err("a ticket cannot block itself");
				blockedBy.push(slug);
			}
			const cycle = this.detectCycle(mapSlug, ticket.slug, blockedBy);
			if (cycle) return err(cycle);
			ticket.blockedBy = blockedBy;
		}
		if (params.question !== undefined) ticket.question = params.question.trim();
		this.writeTicket(mapSlug, ticket);
		this.touch(this.readMap(mapSlug)!);
		return { success: true, map: mapSlug, ticket: ticket.slug, blocked_by: ticket.blockedBy };
	}

	claim(mapRef: string, ticketRef: string, sessionId: string, force = false): WayfinderResult {
		const mapSlug = this.findMapSlug(mapRef);
		if (typeof mapSlug !== "string") return mapSlug;
		const found = this.findTicket(mapSlug, ticketRef);
		if (!found.ok) return err(found.message);
		const ticket = found.ticket;
		if (ticket.status === "closed") return err(`'${ticket.slug}' is already closed`);
		const now = Date.now();
		if (!force && this.claimIsFresh(ticket, now) && ticket.claimedBy !== sessionId) {
			return err(
				`'${ticket.slug}' is claimed by another session (${ticket.claimedBy} at ${ticket.claimedAt}). ` +
					"Pick a different frontier ticket, or pass force:true only if the user says that claim is dead.",
			);
		}
		const bySlug = new Map(this.listTickets(mapSlug).map((t) => [t.slug, t]));
		const openBlockers = ticket.blockedBy.filter((slug) => bySlug.get(slug)?.status !== "closed");
		if (openBlockers.length > 0 && !force) {
			return err(`'${ticket.slug}' is blocked by open tickets: ${openBlockers.join(", ")}. Resolve those first.`);
		}
		ticket.claimedBy = sessionId;
		ticket.claimedAt = new Date().toISOString();
		this.writeTicket(mapSlug, ticket);
		return { success: true, map: mapSlug, ticket: ticket.slug, claimed_by: sessionId, question: ticket.question };
	}

	release(mapRef: string, ticketRef: string): WayfinderResult {
		const mapSlug = this.findMapSlug(mapRef);
		if (typeof mapSlug !== "string") return mapSlug;
		const found = this.findTicket(mapSlug, ticketRef);
		if (!found.ok) return err(found.message);
		const ticket = found.ticket;
		delete ticket.claimedBy;
		delete ticket.claimedAt;
		this.writeTicket(mapSlug, ticket);
		return { success: true, map: mapSlug, ticket: ticket.slug, released: true };
	}

	resolve(
		mapRef: string,
		ticketRef: string,
		sessionId: string,
		params: { resolution: string; gist?: string },
	): WayfinderResult {
		const mapSlug = this.findMapSlug(mapRef);
		if (typeof mapSlug !== "string") return mapSlug;
		const found = this.findTicket(mapSlug, ticketRef);
		if (!found.ok) return err(found.message);
		const ticket = found.ticket;
		if (ticket.status === "closed") return err(`'${ticket.slug}' is already closed`);
		if (ticket.claimedBy !== sessionId) {
			return err(`Claim '${ticket.slug}' before resolving it (action 'claim'), so concurrent sessions skip it.`);
		}
		const before = new Set(this.frontier(mapSlug).map((t) => t.slug));
		ticket.status = "closed";
		ticket.closed = new Date().toISOString();
		ticket.outcome = "resolved";
		ticket.resolution = params.resolution.trim();
		ticket.gist = (params.gist ?? firstLine(params.resolution)).trim();
		this.writeTicket(mapSlug, ticket);
		this.touch(this.readMap(mapSlug)!);
		const newlyUnblocked = this.frontier(mapSlug)
			.map((t) => t.slug)
			.filter((slug) => !before.has(slug) && slug !== ticket.slug);
		const openCount = this.listTickets(mapSlug).filter((t) => t.status === "open").length;
		const map = this.readMap(mapSlug)!;
		const researchTakeable = this.frontier(mapSlug)
			.filter((t) => t.type === "research")
			.map((t) => t.slug);
		let next: string;
		if (openCount === 0 && map.fog.length === 0) {
			next =
				"No open tickets and no fog remain. If the way to the destination is clear, mark the map complete (update_map status 'complete').";
		} else {
			next =
				"Graduate any fog this answer has made specifiable into tickets, and update or scope out tickets this decision invalidates.";
			if (researchTakeable.length > 0) {
				next += ` Takeable research tickets: ${researchTakeable.join(", ")} (exempt from the one-decision limit). If this turn's instructions don't already cover working them, tend the map and end your turn — the harness continues research automatically.`;
			}
		}
		return {
			success: true,
			map: mapSlug,
			ticket: ticket.slug,
			gist: ticket.gist,
			newly_unblocked: newlyUnblocked,
			open_tickets: openCount,
			research_takeable: researchTakeable,
			fog: map.fog,
			next,
		};
	}

	scopeOut(mapRef: string, params: { ticket?: string; gist?: string; reason: string }): WayfinderResult {
		const mapSlug = this.findMapSlug(mapRef);
		if (typeof mapSlug !== "string") return mapSlug;
		const map = this.readMap(mapSlug)!;
		let entry: string;
		if (params.ticket !== undefined) {
			const found = this.findTicket(mapSlug, params.ticket);
			if (!found.ok) return err(found.message);
			const ticket = found.ticket;
			if (ticket.status === "closed" && ticket.outcome === "resolved") {
				return err(`'${ticket.slug}' was already resolved; it is part of the route, not out of scope.`);
			}
			ticket.status = "closed";
			ticket.closed = new Date().toISOString();
			ticket.outcome = "out-of-scope";
			ticket.resolution = `Out of scope: ${params.reason.trim()}`;
			this.writeTicket(mapSlug, ticket);
			entry = `${params.gist ?? ticket.title} — ${params.reason.trim()} (ticket: ${ticket.slug})`;
		} else {
			if (!params.gist) return err("scope_out needs a 'ticket' to close or a 'gist' describing the ruled-out work");
			entry = `${params.gist} — ${params.reason.trim()}`;
		}
		map.outOfScope.push(entry);
		this.touch(map);
		return { success: true, map: mapSlug, out_of_scope: entry };
	}

	updateMap(
		mapRef: string,
		params: {
			destination?: string;
			notes?: string;
			add_fog?: string[];
			remove_fog?: string[];
			status?: "active" | "complete";
		},
	): WayfinderResult {
		const mapSlug = this.findMapSlug(mapRef);
		if (typeof mapSlug !== "string") return mapSlug;
		const map = this.readMap(mapSlug)!;
		if (params.destination !== undefined) map.destination = params.destination.trim();
		if (params.notes !== undefined) map.notes = params.notes.trim();
		for (const item of params.remove_fog ?? []) {
			const needle = item.trim();
			const matches = map.fog.filter((fog) => fog === needle || fog.includes(needle));
			if (matches.length === 0) return err(`remove_fog: no fog entry matches '${needle}'`);
			if (matches.length > 1)
				return err(`remove_fog: '${needle}' matches ${matches.length} fog entries; be more specific`);
			map.fog = map.fog.filter((fog) => fog !== matches[0]);
		}
		for (const item of params.add_fog ?? []) {
			const trimmed = item.trim();
			if (trimmed !== "" && !map.fog.includes(trimmed)) map.fog.push(trimmed);
		}
		if (params.status !== undefined) {
			if (params.status === "complete") {
				const open = this.listTickets(mapSlug).filter((ticket) => ticket.status === "open");
				if (open.length > 0) {
					return err(
						`Cannot complete '${mapSlug}': open tickets remain (${open.map((t) => t.slug).join(", ")}). ` +
							"Resolve them or rule them out of scope first.",
					);
				}
				if (map.fog.length > 0) {
					return err(
						`Cannot complete '${mapSlug}': fog remains in 'Not yet specified' (${map.fog.length} entries). ` +
							"Graduate each into a ticket, or remove it if the destination no longer needs it.",
					);
				}
			}
			map.status = params.status;
		}
		this.touch(map);
		return { success: true, map: mapSlug, status: map.status, fog: map.fog };
	}

	/** The low-resolution view a session orients on: everything but open-ticket bodies. */
	viewMap(mapRef: string): WayfinderResult {
		const mapSlug = this.findMapSlug(mapRef);
		if (typeof mapSlug !== "string") return mapSlug;
		const map = this.readMap(mapSlug)!;
		const tickets = this.listTickets(mapSlug);
		const bySlug = new Map(tickets.map((ticket) => [ticket.slug, ticket]));
		const now = Date.now();
		const open = tickets.filter((ticket) => ticket.status === "open");
		const decisions = tickets
			.filter((ticket) => ticket.outcome === "resolved")
			.sort((a, b) => (a.closed ?? "").localeCompare(b.closed ?? ""))
			.map((ticket) => ({ ticket: ticket.slug, title: ticket.title, gist: ticket.gist ?? "" }));
		return {
			success: true,
			map: mapSlug,
			title: map.title,
			status: map.status,
			destination: map.destination,
			notes: map.notes,
			decisions_so_far: decisions,
			frontier: open
				.filter((ticket) => this.isUnblocked(ticket, bySlug) && !this.claimIsFresh(ticket, now))
				.map((ticket) => ({
					ticket: ticket.slug,
					title: ticket.title,
					type: ticket.type,
					question: firstLine(ticket.question),
				})),
			claimed: open
				.filter((ticket) => this.claimIsFresh(ticket, now))
				.map((ticket) => ({
					ticket: ticket.slug,
					title: ticket.title,
					by: ticket.claimedBy,
					at: ticket.claimedAt,
				})),
			blocked: open
				.filter((ticket) => !this.isUnblocked(ticket, bySlug))
				.map((ticket) => ({
					ticket: ticket.slug,
					title: ticket.title,
					waiting_on: ticket.blockedBy.filter((slug) => bySlug.get(slug)?.status !== "closed"),
				})),
			not_yet_specified: map.fog,
			out_of_scope: map.outOfScope,
		};
	}

	viewTicket(mapRef: string, ticketRef: string): WayfinderResult {
		const mapSlug = this.findMapSlug(mapRef);
		if (typeof mapSlug !== "string") return mapSlug;
		const found = this.findTicket(mapSlug, ticketRef);
		if (!found.ok) return err(found.message);
		return { success: true, map: mapSlug, ...found.ticket };
	}
}

/** Per-session state the extension owns; enforces the one-decision-per-session doctrine. */
export interface WayfinderSession {
	id: string;
	nonResearchResolutions: number;
}

export interface WayfinderToolParams {
	action?: string;
	map?: string | null;
	ticket?: string | null;
	title?: string | null;
	destination?: string | null;
	notes?: string | null;
	type?: string | null;
	question?: string | null;
	blocked_by?: string[] | null;
	resolution?: string | null;
	gist?: string | null;
	reason?: string | null;
	fog?: string[] | null;
	add_fog?: string[] | null;
	remove_fog?: string[] | null;
	status?: string | null;
	force?: boolean | null;
	override_session_limit?: boolean | null;
}

export function wayfinderTool(
	store: WayfinderStore,
	session: WayfinderSession,
	params: WayfinderToolParams,
): WayfinderResult {
	const action = params.action ?? "";
	const need = (name: keyof WayfinderToolParams): string | undefined => {
		const value = params[name];
		return typeof value === "string" && value.trim() !== "" ? value : undefined;
	};

	switch (action) {
		case "list": {
			const maps = store.listMaps().map((map) => ({
				map: map.slug,
				title: map.title,
				status: map.status,
				destination: firstLine(map.destination),
				frontier: store.frontier(map.slug).length,
				open: store.listTickets(map.slug).filter((ticket) => ticket.status === "open").length,
				fog: map.fog.length,
			}));
			return { success: true, maps };
		}
		case "chart": {
			const title = need("title");
			const destination = need("destination");
			if (!title || !destination) return err("chart requires 'title' and 'destination'");
			return store.chart({
				title,
				destination,
				notes: need("notes"),
				fog: params.fog ?? undefined,
			});
		}
		case "view": {
			const map = need("map");
			if (!map) return err("view requires 'map'");
			return store.viewMap(map);
		}
		case "view_ticket": {
			const map = need("map");
			const ticket = need("ticket");
			if (!map || !ticket) return err("view_ticket requires 'map' and 'ticket'");
			return store.viewTicket(map, ticket);
		}
		case "add_ticket": {
			const map = need("map");
			const title = need("title");
			const question = need("question");
			const type = need("type");
			if (!map || !title || !question || !type)
				return err("add_ticket requires 'map', 'title', 'type', and 'question'");
			if (!TICKET_TYPES.includes(type as TicketType)) {
				return err(`invalid type '${type}'; one of: ${TICKET_TYPES.join(", ")}`);
			}
			return store.addTicket(map, {
				title,
				type: type as TicketType,
				question,
				blocked_by: params.blocked_by ?? undefined,
			});
		}
		case "update_ticket": {
			const map = need("map");
			const ticket = need("ticket");
			if (!map || !ticket) return err("update_ticket requires 'map' and 'ticket'");
			return store.updateTicket(map, ticket, {
				question: need("question"),
				blocked_by: params.blocked_by ?? undefined,
			});
		}
		case "claim": {
			const map = need("map");
			const ticket = need("ticket");
			if (!map || !ticket) return err("claim requires 'map' and 'ticket'");
			return store.claim(map, ticket, session.id, params.force ?? false);
		}
		case "release": {
			const map = need("map");
			const ticket = need("ticket");
			if (!map || !ticket) return err("release requires 'map' and 'ticket'");
			return store.release(map, ticket);
		}
		case "resolve": {
			const map = need("map");
			const ticket = need("ticket");
			const resolution = need("resolution");
			if (!map || !ticket || !resolution) return err("resolve requires 'map', 'ticket', and 'resolution'");
			const target = store.viewTicket(map, ticket);
			if (target.success !== true) return target;
			const isResearch = target.type === "research";
			if (!isResearch && session.nonResearchResolutions >= 1 && params.override_session_limit !== true) {
				return err(
					"One non-research decision per session: this session already resolved one. Each decision deserves a " +
						"fresh context; stop here and let the next session take the frontier. Pass " +
						"override_session_limit:true only if the user explicitly asks to continue in this session.",
				);
			}
			const result = store.resolve(map, ticket, session.id, { resolution, gist: need("gist") });
			if (result.success === true && !isResearch) session.nonResearchResolutions += 1;
			return result;
		}
		case "scope_out": {
			const map = need("map");
			const reason = need("reason");
			if (!map || !reason) return err("scope_out requires 'map' and 'reason'");
			return store.scopeOut(map, { ticket: need("ticket"), gist: need("gist"), reason });
		}
		case "update_map": {
			const map = need("map");
			if (!map) return err("update_map requires 'map'");
			const status = need("status");
			if (status !== undefined && status !== "active" && status !== "complete") {
				return err("status must be 'active' or 'complete'");
			}
			return store.updateMap(map, {
				destination: need("destination"),
				notes: need("notes"),
				add_fog: params.add_fog ?? undefined,
				remove_fog: params.remove_fog ?? undefined,
				status: status as "active" | "complete" | undefined,
			});
		}
		default:
			return err(
				`unknown action '${action}'; one of: list, chart, view, view_ticket, add_ticket, update_ticket, claim, release, resolve, scope_out, update_map`,
			);
	}
}
