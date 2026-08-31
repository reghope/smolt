import { compactNumber, formatHour, relativeTime } from "../lib/format.ts";
import { api } from "../lib/api.ts";
import { projectName, switchToSession } from "../state/app.ts";
import { useApp } from "../state/useApp.ts";
import { WaterField } from "./WaterField.tsx";

/**
 * What a chat shows before it has anything in it: the water, a greeting, and
 * the thing no other agent can put here — what this one has already learned.
 * The memory card quotes the newest MEMORY.md entry verbatim, receipts-style,
 * because the product claim is that it writes things down; showing the actual
 * ink beats asserting it. Below that, the way back into recent work, and one
 * quiet line of figures for this project.
 */

function greeting(): string {
	const hour = new Date().getHours();
	if (hour < 5) return "Still going";
	if (hour < 12) return "Morning";
	if (hour < 18) return "Afternoon";
	return "Evening";
}

/** The newest MEMORY.md entry, receipts-style. */
function MemoryCard() {
	const state = useApp();
	const learned = state.stats?.learned;
	if (!learned) return null;

	const hasInk = learned.memoryEntries > 0 || learned.skills.length > 0;
	return (
		<section className="mt-9 w-full rounded-xl border bg-background-deep p-3.5 text-left">
			<div className="flex items-baseline gap-2">
				<span className="font-mono text-salmon-text">§</span>
				<h2 className="text-xs font-medium tracking-wide text-muted-foreground">what it knows</h2>
				<span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-right font-mono text-xs text-faint">
					{learned.memoryEntries} {learned.memoryEntries === 1 ? "memory" : "memories"}
					{learned.skills.length > 0 && <> · {learned.skills.length} {learned.skills.length === 1 ? "skill" : "skills"}</>}
					{learned.memoryUpdatedAt !== null && <> · {relativeTime(learned.memoryUpdatedAt)}</>}
				</span>
				{learned.memoryEntries > 0 && (
					<button
						type="button"
						className="flex-none text-xs text-faint underline underline-offset-2 hover:text-foreground"
						title="Show MEMORY.md in its folder — open, edit, delete"
						onClick={() => void api.reveal(learned.memoryPath)}
					>
						open
					</button>
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
				</>
			) : (
				<p className="mt-2 text-xs text-faint">
					Nothing written down yet. It learns as you work — conventions, quirks, solved problems — and starts the
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
	if (rows.length === 0) return null;
	return (
		<div className="mt-6 w-full text-left">
			<h2 className="mb-1 px-1 text-xs tracking-wide text-faint">Pick up where you left off</h2>
			<div className="flex flex-col gap-0.5">
				{rows.map((row) => (
					<button
						key={row.path}
						type="button"
						title={row.preview || row.title}
						className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/60"
						onClick={() => void switchToSession(row.path)}
					>
						<span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{row.title}</span>
						<span className="flex-none text-xs text-faint">{relativeTime(row.lastActive)}</span>
					</button>
				))}
			</div>
		</div>
	);
}

export function EmptyChat() {
	const state = useApp();
	const folder = projectName();
	const inProject = state.appInfo.hasProject && folder !== "";
	const stats = state.stats;

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
					<p className="mt-7 font-mono text-xs text-faint">
						{stats.sessions} {stats.sessions === 1 ? "session" : "sessions"}
						{inProject && ` in ${folder}`} · {compactNumber(stats.tokens)} tokens
						{stats.currentStreak > 1 && ` · ${stats.currentStreak}d streak`}
						{stats.peakHour !== null && ` · busiest around ${formatHour(stats.peakHour)}`}
					</p>
				)}
			</div>
		</div>
	);
}
