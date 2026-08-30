import { useEffect, useRef, useState } from "react";
import { api, type SessionRow } from "../lib/api.ts";
import { cn } from "../lib/cn.ts";
import { storedPreference, storePreference } from "../lib/prefs.ts";
import {
	app,
	archiveSession,
	bump,
	deleteSession,
	forkSession,
	newSession,
	renameSession,
	switchToSession,
	toggleGroupCollapsed,
	selectSessions,
	togglePinned,
	toggleSessionSearch,
	toggleSidebar,
} from "../state/app.ts";
import { PANE_COLLAPSE_ZONE, ResizeHandle } from "./ResizeHandle.tsx";
import { useApp } from "../state/useApp.ts";
import { Button } from "./ui/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { Icon } from "./ui/icon.tsx";
import { Input } from "./ui/input.tsx";
import { MoreMenu } from "./MoreMenu.tsx";
import { UpdateBanner } from "./UpdateBanner.tsx";

/** Bucket a session by how long ago it was last touched. */
function sessionBucket(lastActive: number): string {
	const day = 24 * 60 * 60 * 1000;
	const startOfToday = new Date().setHours(0, 0, 0, 0);
	if (lastActive >= startOfToday) return "Today";
	if (lastActive >= startOfToday - day) return "Yesterday";
	if (lastActive >= startOfToday - 7 * day) return "Previous 7 days";
	if (lastActive >= startOfToday - 30 * day) return "Previous 30 days";
	return "Older";
}

/**
 * Chats whose titles collide, because a skill opens each one the same way.
 *
 * The title falls back to the first message, so two runs of the same command
 * read as one chat repeated. Naming the time is what tells them apart.
 */
function ambiguousTitles(rows: SessionRow[]): Set<string> {
	const seen = new Map<string, number>();
	for (const row of rows) seen.set(row.title, (seen.get(row.title) ?? 0) + 1);
	return new Set([...seen].filter(([, count]) => count > 1).map(([title]) => title));
}

function SessionEntry({ row, active, ambiguous }: { row: SessionRow; active: boolean; ambiguous?: boolean }) {
	const pinned = app.pinned.has(row.path);
	return (
		<DropdownMenu>
			<div
				className={cn(
					"group/session flex items-center rounded-lg transition-colors hover:bg-accent/60",
					active && "bg-primary/10",
					app.selectedSessions.has(row.path) && "bg-primary/20",
				)}
				onContextMenu={(event) => {
					// Radix opens on the trigger; route a right-click to the same menu.
					event.preventDefault();
					(event.currentTarget.querySelector("[data-session-menu]") as HTMLButtonElement | null)?.click();
				}}
			>
				<button
					type="button"
					className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg px-3 text-left text-sm text-muted-foreground"
					title={row.preview || row.title}
					onClick={() => void switchToSession(row.path)}
				>
					{/* The dot sits in an icon-sized slot so chat titles start on the
					    same column as the New button's label above them. */}
					<span className="flex size-4 flex-none items-center justify-center">
						<span
							className={cn(
								"size-1.5 rounded-full border border-faint",
								active && "bg-faint",
								app.busySessions.has(row.path) && "animate-pulse-soft border-salmon bg-salmon",
							)}
						/>
					</span>
					<span
						className={cn(
							"block min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap",
							active && "font-medium text-foreground",
						)}
					>
						{row.title}
					</span>
					{ambiguous && (
						<span className="flex-none text-[11px] text-faint tabular-nums">
							{new Date(row.lastActive).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
						</span>
					)}
				</button>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						data-session-menu
						title="More"
						className="mr-1 size-6 flex-none rounded-md text-sm leading-none text-faint opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/session:opacity-100 data-[state=open]:opacity-100"
					>
						⋮
					</button>
				</DropdownMenuTrigger>
			</div>
			<DropdownMenuContent align="start" className="min-w-44">
				<DropdownMenuItem onSelect={() => void api.reveal(row.path, "reveal")}>
					Open in
					<DropdownMenuShortcut>▸</DropdownMenuShortcut>
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={() => togglePinned(row.path)}>
					{pinned ? "Unpin" : "Pin"}
					<DropdownMenuShortcut>P</DropdownMenuShortcut>
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={() => void renameSession(row)}>
					Rename
					<DropdownMenuShortcut>R</DropdownMenuShortcut>
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={() => void forkSession(row)}>
					Fork
					<DropdownMenuShortcut>F</DropdownMenuShortcut>
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={() => archiveSession(row)}>
					Archive
					<DropdownMenuShortcut>A</DropdownMenuShortcut>
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem variant="destructive" onSelect={() => void deleteSession(row)}>
					Delete
					<DropdownMenuShortcut>D</DropdownMenuShortcut>
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function Group({ label, rows, ambiguous }: { label: string; rows: SessionRow[]; ambiguous: Set<string> }) {
	const collapsed = app.collapsedGroups.has(label);
	const [menuOpen, setMenuOpen] = useState(false);
	if (rows.length === 0) return null;
	return (
		<>
			{/* Right-click offers the bulk action rather than performing it: taking
			    a whole day's chats in one gesture should be asked for, not assumed. */}
			<DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						className="flex cursor-pointer select-none items-center gap-2 rounded-lg px-3 pt-3.5 pb-1 text-xs tracking-wide text-faint transition-colors hover:text-muted-foreground"
						onClick={() => toggleGroupCollapsed(label)}
						onContextMenu={(event) => {
							event.preventDefault();
							setMenuOpen(true);
						}}
					>
						<span className={cn("flex text-faint transition-transform", !collapsed && "rotate-90")}>
							<Icon name="chevron" />
						</span>
						{label}
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" className="min-w-40">
					<DropdownMenuItem onSelect={() => selectSessions(rows.map((row) => row.path))}>
						Select all
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			{!collapsed &&
				rows.map((row) => (
					<SessionEntry
						key={row.path}
						row={row}
						active={row.path === app.currentSessionPath}
						ambiguous={ambiguous.has(row.title)}
					/>
				))}
		</>
	);
}

const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_DEFAULT_WIDTH = 240;

export function Sidebar() {
	const state = useApp();
	const searchRef = useRef<HTMLInputElement>(null);
	const asideRef = useRef<HTMLElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	/**
	 * The width a drag is currently painting; React's own value rather than an
	 * inline style, because every re-render re-applies the style prop and would
	 * stomp an imperative write mid-drag.
	 */
	const [live, setLive] = useState<number | null>(null);
	const [width, setWidth] = useState(() => {
		const stored = Number(storedPreference("smolt.sidebarWidth", ""));
		return stored >= SIDEBAR_MIN_WIDTH ? stored : SIDEBAR_DEFAULT_WIDTH;
	});

	useEffect(() => {
		if (state.sessionSearchOpen) searchRef.current?.focus();
	}, [state.sessionSearchOpen]);

	// Closed is width zero, not unmounted: the drag edge stays at the window's
	// side, so hovering there still reveals the grip and a drag reopens it.
	const hidden = state.sidebarHidden;

	// Search matches the title and the first message, so a half-remembered
	// phrase from the conversation finds it as well as its name.
	const needle = state.sessionQuery.trim().toLowerCase();
	const visible = needle
		? state.sessionRows.filter(
				(row) => row.title.toLowerCase().includes(needle) || row.preview.toLowerCase().includes(needle),
			)
		: state.sessionRows;
	const shown = visible.filter((row) => !state.archived.has(row.path));
	const pinned = shown.filter((row) => state.pinned.has(row.path));
	const ambiguous = ambiguousTitles(shown);
	const rest = shown.filter((row) => !state.pinned.has(row.path));

	const groups: { label: string; rows: SessionRow[] }[] = [];
	let bucket = "";
	let batch: SessionRow[] = [];
	for (const row of rest) {
		const rowBucket = sessionBucket(row.lastActive);
		if (rowBucket !== bucket) {
			if (batch.length > 0) groups.push({ label: bucket, rows: batch });
			bucket = rowBucket;
			batch = [];
		}
		batch.push(row);
	}
	if (batch.length > 0) groups.push({ label: bucket, rows: batch });

	return (
		<aside
			ref={asideRef}
			style={{ width: live ?? (hidden ? 0 : width) }}
			className="relative max-w-[40vw] flex-none select-none border-r bg-background-deep [background:var(--background-deep)]"
		>
			<ResizeHandle
				side="right"
				flush={hidden}
				label={hidden ? "Drag to open the sidebar" : "Resize the sidebar"}
				minWidth={SIDEBAR_MIN_WIDTH}
				measure={(clientX) => Math.min(Math.max(clientX, 0), Math.round(window.innerWidth * 0.4))}
				onWidth={(next) => {
					setLive(next);
					if (contentRef.current) contentRef.current.style.opacity = next === 0 ? "0" : "1";
				}}
				onRelease={(next) => {
					setLive(null);
					if (contentRef.current) contentRef.current.style.opacity = "";
					if (next <= PANE_COLLAPSE_ZONE) {
						// A deliberate close, not a stranded sliver: the drag edge or
						// the titlebar toggle (Ctrl+B) brings it back at its old width.
						app.sidebarHidden = true;
						bump();
						return;
					}
					const settled = Math.max(next, SIDEBAR_MIN_WIDTH);
					setWidth(settled);
					storePreference("smolt.sidebarWidth", String(Math.round(settled)));
					app.sidebarHidden = false;
					bump();
				}}
			/>
			{/* The scroll (and the closed state's clipping and inertness) lives
			    one level in, so the handle on the aside's edge stays live. */}
			<div
				ref={contentRef}
				inert={hidden || undefined}
				className={cn(
					"flex h-full flex-col gap-1 overflow-hidden px-2 pt-10 pb-2",
					// At width zero the wrapper's own padding still paints 16px wide
					// (border-box cannot shrink below it), letting child borders peek
					// past the closed edge — so the closed content does not paint.
					hidden && "opacity-0",
				)}
			>
			{/* First thing under the window's own controls, so starting a chat
			    never means hunting for the button. */}
			<Button variant="ghost" className="justify-start gap-2 px-3 font-normal" onClick={() => void newSession()}>
				<Icon name="plus" className="text-faint" />
				New
			</Button>
			{state.sessionSearchOpen && (
				<Input
					ref={searchRef}
					type="search"
					placeholder="Search sessions…"
					className="my-1"
					value={state.sessionQuery}
					onChange={(event) => {
						app.sessionQuery = event.target.value;
						bump();
					}}
					onKeyDown={(event) => {
						if (event.key === "Escape") toggleSessionSearch(false);
					}}
				/>
			)}
			<div className="flex min-h-0 flex-1 flex-col gap-px overflow-x-hidden overflow-y-auto">
				{state.sessionRows.length === 0 ? (
					<p className="px-2 py-2.5 text-sm leading-normal text-faint">No chats yet.</p>
				) : shown.length === 0 ? (
					<p className="px-2 py-2.5 text-sm leading-normal text-faint">
						{needle ? `No chats match "${state.sessionQuery.trim()}".` : "Every chat here is archived."}
					</p>
				) : (
					<>
						{pinned.length > 0 && <Group label="Pinned" rows={pinned} ambiguous={ambiguous} />}
						{groups.map((group) => (
							<Group key={group.label} label={group.label} rows={group.rows} ambiguous={ambiguous} />
						))}
					</>
				)}
			</div>
			{/* A rule marks the footer off from the list it sits under. */}
			<div className="-mx-2 mt-1 border-t px-2 pt-2">
				<UpdateBanner />
				<MoreMenu />
			</div>
			</div>
		</aside>
	);
}
