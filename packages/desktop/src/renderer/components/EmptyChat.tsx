import { useEffect, useState } from "react";
import { compactNumber, formatHour, relativeTime } from "../lib/format.ts";
import { api } from "../lib/api.ts";
import { applyStarter, projectName, switchToSession, type Starter } from "../state/app.ts";
import { useApp } from "../state/useApp.ts";
import { Tip } from "./ui/tooltip.tsx";
import { WaterField } from "./WaterField.tsx";


/**
 * What a chat shows before it has anything in it: the water, a greeting, and
 * the thing no other agent can put here — what this one has already learned.
 * The memory card quotes a MEMORY.md entry verbatim, receipts-style, because
 * the product claim is that it writes things down; showing the actual ink
 * beats asserting it. It prefers the newest note that names the open project
 * over the newest note of all, which is as often about the machine or a tool
 * quirk and reads as trivia to someone opening this folder. Below that, the way back into recent work, and one
 * quiet line of figures for this project.
 */

function greeting(): string {
	const hour = new Date().getHours();
	if (hour < 5) return "Still going";
	if (hour < 12) return "Morning";
	if (hour < 18) return "Afternoon";
	return "Evening";
}

/**
 * Prompt suggestions written by the user's own default model, grounded in the
 * project's recent sessions, git state and README. Clicking puts the prompt in
 * the composer to edit and send. The card renders LAST in the column: the
 * model call behind it can take a minute and may yield 0-3 rows, so anywhere
 * higher its arrival (or failure) would shove everything below it. At the
 * bottom, nothing sits under it and no case moves existing content. While
 * the model writes, skeleton rows stand where the card will land.
 */
function StartersCard() {
	const state = useApp();
	const starters: Starter[] = state.starters;
	// When the main-process cache is warm, starters land a few frames after
	// mount; painting the skeleton for those frames made it pop in and
	// instantly vanish. Hold the skeleton back briefly: fast loads render the
	// card (or nothing) directly, only a genuinely slow model call shows it.
	const [slow, setSlow] = useState(false);
	useEffect(() => {
		const timer = setTimeout(() => setSlow(true), 400);
		return () => clearTimeout(timer);
	}, []);
	if (!state.startersLoaded && starters.length === 0) {
		if (!slow) return null;
		return (
			<section className="mt-9 w-full overflow-hidden rounded-xl border bg-background-deep" aria-hidden>
				{[0, 1, 2].map((i) => (
					<div
						key={i}
						className="flex items-center gap-2.5 border-b border-border px-4 py-3 text-[13px] last:border-b-0"
					>
						{/* Same arrow glyph and text metrics as the real rows, only the
						    label is a bar, so the swap does not shift the layout. */}
						<span className="flex-none animate-pulse-soft font-mono text-xs text-tint-text/50">&rarr;</span>
						{/* The track is exactly one 13px line box tall (13 × 1.55, the body
						    leading the real label inherits), so a row keeps its height when
						    the bar is replaced by text. */}
						<span className="flex h-[20px] min-w-0 flex-1 items-center">
							{/* Bar height is the label's cap height, not its font size: a full
							    13px slab reads as a heavier object than the text it stands in
							    for. Widths mirror the length of a real starter prompt. */}
							<span
								className="h-[9px] animate-pulse-soft rounded-full bg-muted-foreground/20"
								style={{ width: `${74 - i * 13}%` }}
							/>
						</span>
					</div>
				))}
			</section>
		);
	}
	if (starters.length === 0) return null;
	return (
		<section className="mt-9 w-full overflow-hidden rounded-xl border bg-background-deep text-left">
			{starters.map((starter) => (
				<button
					key={starter.label}
					type="button"
					className="flex w-full items-center gap-2.5 border-b border-border px-4 py-3 text-left text-[13px] text-muted-foreground transition-colors last:border-b-0 hover:bg-accent/60"
					onClick={() => applyStarter(starter.label)}
				>
					<span className="flex-none font-mono text-xs text-tint-text">&rarr;</span>
					<span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{starter.label}</span>
					{starter.meta !== "" && (
						<span className="flex-none font-mono text-[11px] text-faint">{starter.meta}</span>
					)}
				</button>
			))}
		</section>
	);
}

/** A MEMORY.md entry, receipts-style: this project's newest, else the newest. */
function MemoryCard() {
	const state = useApp();
	const folder = projectName();
	const learned = state.stats?.learned;
	if (!learned) return null;

	const hasInk = learned.memoryEntries > 0 || learned.skills.length > 0;
	// Two different memories: the notes the agent curates for itself in
	// MEMORY.md, and every past chat, which is indexed for recall whether or
	// not a note was ever written. Counting only the first read as amnesia.
	const chats = state.stats?.sessions ?? 0;
	return (
		<section className="mt-9 w-full rounded-xl border bg-background-deep p-3.5 text-left">
			{/* Title row holds only the title and the way in. The figures used to
			    ride here too, right-aligned; once the project name joined the
			    heading they had to ellipsize or wrap, and a wrapped right-aligned
			    line reads as a mistake. They belong with the other faint mono line
			    at the foot of the card. */}
			<div className="flex items-baseline gap-2">
				<span className="font-mono text-tint-text">§</span>
				<h2 className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs font-medium tracking-wide text-muted-foreground">
					what it knows{learned.latestIsProject && folder !== "" && ` about ${folder}`}
				</h2>
				{learned.memoryEntries > 0 && (
					<Tip label="Show MEMORY.md in its folder: open, edit, delete">
						<button
							type="button"
							className="flex-none text-xs text-faint underline underline-offset-2 hover:text-foreground"
							onClick={() => void api.reveal(learned.memoryPath)}
						>
							open
						</button>
					</Tip>
				)}
			</div>
			{hasInk ? (
				<>
					{learned.latestMemory !== null && (
						<pre className="mt-2.5 line-clamp-3 whitespace-pre-wrap font-mono text-xs leading-relaxed text-muted-foreground">
							{learned.latestMemory}
						</pre>
					)}
					{learned.skills.length > 0 && (
						<p className="mt-2 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs text-faint">
							skills: {learned.skills.slice(0, 4).join(" · ")}
							{learned.skills.length > 4 && ` · +${learned.skills.length - 4} more`}
						</p>
					)}
					<Tip label="Notes are what the agent wrote down for itself in MEMORY.md. Every past chat is also indexed, so it can recall them whether or not it took a note.">
						<p className="mt-2 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs text-faint">
							{learned.memoryEntries} {learned.memoryEntries === 1 ? "note" : "notes"}
							{chats > 0 && (
								<>
									 {"·"} {chats} {chats === 1 ? "chat" : "chats"} recallable
								</>
							)}
							{learned.skills.length > 0 && (
								<>
									 {"·"} {learned.skills.length} {learned.skills.length === 1 ? "skill" : "skills"}
								</>
							)}
							{learned.memoryUpdatedAt !== null && (
								<>
									 {"·"} {relativeTime(learned.memoryUpdatedAt)}
								</>
							)}
						</p>
					</Tip>
				</>
			) : (
				<p className="mt-2 text-xs text-faint">
					Nothing written down yet. It learns as you work: conventions, quirks, solved problems. It starts the
					next session already knowing them.
				</p>
			)}
		</section>
	);
}

/** The way back into recent work, straight from the session store. */
function RecentWork() {
	const state = useApp();
	const rows = [...state.sessionRows].sort((a, b) => b.lastActive - a.lastActive).slice(0, 3);
	// Titles are cut to 48 characters for the sidebar, which is narrow; here
	// there is twice the room, and "Please look at OpenCodeGo and the page
	// where it…" stops right before the part that tells the rows apart. Where
	// a title was cut, rebuild a longer one from the stored opening message.
	const label = (row: { title: string; preview: string }): string => {
		if (!row.title.endsWith("…") || row.preview === "") return row.title;
		const sentence = (row.preview.split(/(?<=[.!?])\s/)[0] ?? row.preview).replace(/\s+/g, " ").trim();
		if (sentence.length <= 96) return sentence;
		const cut = sentence.slice(0, 96);
		const lastSpace = cut.lastIndexOf(" ");
		return `${(lastSpace > 48 ? cut.slice(0, lastSpace) : cut).replace(/[,;:.]$/, "")}…`;
	};
	if (rows.length === 0) return null;
	return (
		<div className="mt-6 w-full text-left">
			<h2 className="mb-1 px-1 text-xs tracking-wide text-faint">Pick up where you left off</h2>
			<div className="flex gap-2">
			<span className="flex-none select-none pl-1 font-mono text-sm text-faint">⎿</span>
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				{rows.map((row) => (
					<Tip key={row.path} label={row.preview || row.title}>
					<button
						type="button"
						className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent"
						onClick={() => void switchToSession(row.path)}
					>
						<span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-medium">
							{label(row)}
						</span>
						<span className="ml-auto min-w-0 max-w-[55%] flex-none overflow-hidden text-ellipsis whitespace-nowrap text-xs text-faint">
							{relativeTime(row.lastActive)}
						</span>
					</button>
					</Tip>
				))}
			</div>
			</div>
		</div>
	);
}

export function EmptyChat() {
	const state = useApp();
	const folder = projectName();
	const inProject = state.appInfo.hasProject && folder !== "";
	const stats = state.stats;
	// Everything on this screen draws on async loads (app info, sessions,
	// stats) that land milliseconds apart. Rendering each piece as it arrives
	// made the screen assemble in shoves: the no-project greeting and notice
	// flashed before appInfo flipped to the real project, the memory card then
	// pushed recent work down, the footer popped in last. Hold the whole
	// column until the local loads settle and paint it once, final. Only the
	// starters stay async after that, and they render last so their arrival
	// moves nothing.
	const ready = state.statsLoaded && state.sessionsLoaded && state.appInfoLoaded;
	if (!ready) {
		// A skeleton that mirrors the loaded column piece for piece: greeting
		// line, memory card, recent-work list, stats line. Same wrappers, same
		// margins, same paddings and line boxes as the real components, so the
		// swap to content moves nothing and needs no entrance animation.
		return (
			<div className="relative pt-[11vh] @max-[550px]:pt-[6vh]">
				<WaterField className="absolute inset-x-0 top-0 h-[28vh]" />
				<div className="relative mx-auto flex max-w-[580px] flex-col items-center px-3" aria-hidden>
					{/* Greeting: one text-xl line (20px × 1.4 ≈ 28px box), bar at cap height. */}
					<span className="flex h-[28px] items-center">
						<span className="h-[14px] w-[260px] animate-pulse-soft rounded-full bg-muted-foreground/20" />
					</span>
					{/* Memory card: same shell as MemoryCard, header row plus one body line. */}
					<section className="mt-9 w-full rounded-xl border bg-background-deep p-3.5 text-left">
						<div className="flex h-[16px] items-center gap-2">
							<span className="h-[9px] w-[150px] animate-pulse-soft rounded-full bg-muted-foreground/20" />
							<span className="flex-1" />
							<span className="h-[9px] w-[30px] animate-pulse-soft rounded-full bg-muted-foreground/20" />
						</div>
						<div className="mt-2.5 flex h-[20px] items-center">
							<span className="h-[9px] w-[85%] animate-pulse-soft rounded-full bg-muted-foreground/20" />
						</div>
						{/* The two faint mono lines at the card's foot: skills, then figures. */}
						<div className="mt-2 flex h-[16px] items-center">
							<span className="h-[9px] w-[60%] animate-pulse-soft rounded-full bg-muted-foreground/20" />
						</div>
						<div className="mt-2 flex h-[16px] items-center">
							<span className="h-[9px] w-[45%] animate-pulse-soft rounded-full bg-muted-foreground/20" />
						</div>
					</section>
					{/* Recent work: heading line plus three rows with the real row metrics
					    (py-1.5 around a text-sm 20px line box). */}
					<div className="mt-6 w-full text-left">
						<div className="mb-1 flex h-[16px] items-center px-1">
							<span className="h-[9px] w-[140px] animate-pulse-soft rounded-full bg-muted-foreground/20" />
						</div>
						<div className="flex gap-2">
						<span className="flex-none select-none pl-1 font-mono text-sm text-transparent">⎿</span>
						<div className="flex min-w-0 flex-1 flex-col gap-0.5">
							{[0, 1, 2].map((i) => (
								<div key={i} className="flex items-center gap-2 px-2.5 py-1.5">
									<span className="flex h-[20px] min-w-0 flex-1 items-center">
										<span
											className="h-[9px] animate-pulse-soft rounded-full bg-muted-foreground/20"
											style={{ width: `${62 - i * 9}%` }}
										/>
									</span>
									<span className="h-[9px] w-[44px] flex-none animate-pulse-soft rounded-full bg-muted-foreground/20" />
								</div>
							))}
						</div>
						</div>
					</div>
					{/* Stats: one mono text-xs line. */}
					<span className="mt-7 flex h-[16px] items-center">
						<span className="h-[9px] w-[300px] animate-pulse-soft rounded-full bg-muted-foreground/20" />
					</span>
				</div>
			</div>
		);
	}

	return (
		// Padding rather than a margin on the inner column, so the water band
		// anchors to the true top of the panel instead of collapsing down to
		// the greeting.
		<div className="relative pt-[11vh] @max-[550px]:pt-[6vh]">
			<WaterField className="absolute inset-x-0 top-0 h-[28vh]" />
			<div className="relative mx-auto flex max-w-[580px] flex-col items-center px-3 text-center">
				<h1 className="text-balance text-xl font-medium tracking-tight">
					{greeting()}
					{inProject ? `, what's next in ${folder}?` : ", what shall we work on?"}
				</h1>
				{!inProject && (
					// The folder chip by the composer already offers the way in; this
					// only explains the state.
					<p className="mt-3 text-sm leading-relaxed text-faint">
						No project folder is open. Ask anything, or pick a folder from the chip by the composer; otherwise you
						will be asked where new files should go.
					</p>
				)}
				<MemoryCard />
				<RecentWork />
				{stats && stats.sessions > 0 && (
					<p className="mt-7 flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 px-1 font-mono text-xs text-faint">
						<span>
							{stats.sessions} {stats.sessions === 1 ? "session" : "sessions"}
							{inProject && ` in ${folder}`}
						</span>
						<span>{compactNumber(stats.tokens)} tokens</span>
						{stats.currentStreak > 1 && <span>{stats.currentStreak}d streak</span>}
						{stats.peakHour !== null && <span>busiest around {formatHour(stats.peakHour)}</span>}
					</p>
				)}
				<StartersCard />
			</div>
		</div>
	);
}
