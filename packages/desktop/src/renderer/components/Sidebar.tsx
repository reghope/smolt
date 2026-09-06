import { type ComponentType, memo, type PropsWithChildren, useEffect, useRef, useState } from "react";
import { api, type SessionRow } from "../lib/api.ts";
import { cn } from "../lib/cn.ts";
import { storedPreference, storePreference } from "../lib/prefs.ts";
import {
	app,
	archiveSession,

	bump,
	archiveSelectedSessions,
	clearSessionSelection,
	deleteSelectedSessions,
	deleteSession,
	forkSession,
	newSession,
	pinSelectedSessions,
	renameSession,
	selectSessionRange,
	setSelectionAnchor,
	setSessionOrder,
	switchToSession,
	toggleGroupCollapsed,
	selectSessions,
	togglePinned,
	toggleSessionSearch,
	toggleSessionSelected,
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
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuShortcut,
	ContextMenuTrigger,
} from "./ui/context-menu.tsx";
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

/**
 * Memoized, with every read state passed in as a prop: the transcript
 * repaints on a timer while the agent streams, and re-rendering fifty radix
 * dropdown rows per paint was measurable engine churn for rows that had not
 * changed at all.
 */
/**
 * The one menu a chat row answers with, whichever way it is summoned: the
 * ⋮ button anchors it to the button, a right-click anchors it at the cursor.
 * Radix keeps dropdown and context menus as separate component families, so
 * the caller passes in whichever family's Item/Separator/Shortcut it uses.
 */
function SessionMenuItems({
	parts,
	row,
	pinned,
	selected,
	selectedCount,
}: {
	parts: {
		Item: ComponentType<PropsWithChildren<{ onSelect?: (event: Event) => void; variant?: "default" | "destructive" }>>;
		Separator: ComponentType;
		Shortcut: ComponentType<PropsWithChildren>;
	};
	row: SessionRow;
	pinned: boolean;
	selected: boolean;
	selectedCount: number;
}) {
	const { Item, Separator, Shortcut } = parts;
	// Inside a multi-selection the menu speaks for the lot: per-chat actions
	// (rename, fork, open) step aside for the bulk ones.
	if (selected && selectedCount > 1) {
		return (
			<>
				<Item onSelect={() => pinSelectedSessions()}>Pin {selectedCount} chats</Item>
				<Item onSelect={() => archiveSelectedSessions()}>Archive {selectedCount} chats</Item>
				<Separator />
				<Item variant="destructive" onSelect={() => void deleteSelectedSessions()}>
					Delete {selectedCount} chats
					<Shortcut>D</Shortcut>
				</Item>
			</>
		);
	}
	return (
		<>
			<Item onSelect={() => void api.reveal(row.path, "reveal")}>
				Open in
				<Shortcut>▸</Shortcut>
			</Item>
			<Item onSelect={() => togglePinned(row.path)}>
				{pinned ? "Unpin" : "Pin"}
				<Shortcut>P</Shortcut>
			</Item>
			<Item onSelect={() => void renameSession(row)}>
				Rename
				<Shortcut>R</Shortcut>
			</Item>
			<Item onSelect={() => void forkSession(row)}>
				Fork
				<Shortcut>F</Shortcut>
			</Item>
			<Item onSelect={() => archiveSession(row)}>
				Archive
				<Shortcut>A</Shortcut>
			</Item>
			<Separator />
			<Item variant="destructive" onSelect={() => void deleteSession(row)}>
				Delete
				<Shortcut>D</Shortcut>
			</Item>
		</>
	);
}

const SessionEntry = memo(function SessionEntry({
	row,
	active,
	ambiguous,
	pinned,
	selected,
	selectedCount,
	busy,
	waiting,
	done,
	dots,
}: {
	row: SessionRow;
	active: boolean;
	ambiguous?: boolean;
	pinned: boolean;
	selected: boolean;
	/** How many chats are selected in total, so the menu can act on the lot. */
	selectedCount: number;
	busy: boolean;
	/** Render the row marker as a dot bullet instead of an asterisk. */
	dots: boolean;
	/** This chat's agent is waiting on an approval; the dot turns amber. */
	waiting: boolean;
	/** The chat finished a turn the reader has not opened yet; steady green. */
	done: boolean;
}) {
	const body = (
			<div
				data-session-row
				className={cn(
					"group/session flex items-center rounded-lg transition-colors",
					// Active or selected rows are already told apart; hover must not repaint them.
					!selected && !active && "hover:bg-accent/60",
					active && "bg-primary/10",
					selected && "bg-primary/20",
				)}
						// Right-clicking outside the selection is a fresh start on this
						// row, the way every file list behaves — the menu must never act
						// on chats the reader has stopped pointing at. Radix's own
						// trigger opens the menu at the cursor.
						onContextMenu={() => {
							if (!selected) clearSessionSelection();
						}}
					>
				<button
					type="button"
					className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg px-3 text-left text-sm text-muted-foreground"
					onClick={(event) => {
						// Standard list selection: shift extends, ctrl/cmd picks one out,
						// a plain click drops the selection and opens the chat.
						if (event.shiftKey) {
							selectSessionRange(row.path);
							return;
						}
						if (event.ctrlKey || event.metaKey) {
							toggleSessionSelected(row.path);
							return;
						}
						// Clicking the chat already on screen goes nowhere, so it keeps
						// the selection too; only an actual move drops it.
						if (!active) clearSessionSelection();
						setSelectionAnchor(row.path);
						void switchToSession(row.path);
					}}
				>
					{/* The marker sits in an icon-sized slot so chat titles start on
					    the same column as the New button's label above it. Bold when
					    the chat is working or selected: at rest it is a quiet mark. */}
					<span className="flex size-4 flex-none items-center justify-center">
						{dots ? (
							<span
								className={cn(
									"size-1.5 rounded-full border border-faint",
									active && "bg-faint",
									(busy || waiting) && "animate-pulse-soft border-tint bg-tint",
									waiting && "border-warn bg-warn",
									done && !active && "border-ok bg-ok",
								)}
							/>
						) : (
							<span
								className={cn(
									"font-mono text-[13px] leading-none",
								active && !dots && "text-[16px]",
									(busy || waiting) && "animate-pulse-soft font-bold",
									!busy && !waiting && active && "font-bold",
									waiting ? "text-warn" : busy ? "text-tint" : active ? "text-foreground" : done ? "text-ok" : "text-faint",
								)}
							>
								*
							</span>
						)}
					</span>
					<span
						className={cn(
							"block min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap",
							active && "font-bold text-foreground",
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
						aria-label="Session menu"
						className="mr-1 size-6 flex-none rounded-md text-sm leading-none text-faint opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/session:opacity-100 data-[state=open]:opacity-100"
					>
						⋮
					</button>
				</DropdownMenuTrigger>
					</div>
	);
	return (
		<ContextMenu>
			<DropdownMenu>
				<ContextMenuTrigger asChild>{body}</ContextMenuTrigger>
				<DropdownMenuContent align="start" className="min-w-44">
					<SessionMenuItems
						parts={{ Item: DropdownMenuItem, Separator: DropdownMenuSeparator, Shortcut: DropdownMenuShortcut }}
						row={row}
						pinned={pinned}
						selected={selected}
						selectedCount={selectedCount}
					/>
				</DropdownMenuContent>
			</DropdownMenu>
			<ContextMenuContent className="min-w-44">
				<SessionMenuItems
					parts={{ Item: ContextMenuItem, Separator: ContextMenuSeparator, Shortcut: ContextMenuShortcut }}
					row={row}
					pinned={pinned}
					selected={selected}
					selectedCount={selectedCount}
				/>
			</ContextMenuContent>
		</ContextMenu>
	);
});

/** How many chats a day's group shows before the rest fold behind a chevron. */
const GROUP_PREVIEW_ROWS = 5;

/**
 * The pre-load stand-in for the session list, shaped exactly like the loaded
 * list: a day label and rows with the real row metrics (h-8, px-3, dot slot),
 * so the swap to content moves nothing and needs no entrance animation. Held
 * back briefly because the list usually lands within a few frames; painting
 * a skeleton for those frames made it pop in and instantly vanish.
 */
function SessionListSkeleton() {
	const [slow, setSlow] = useState(false);
	useEffect(() => {
		const timer = setTimeout(() => setSlow(true), 400);
		return () => clearTimeout(timer);
	}, []);
	if (!slow) return null;
	return (
		<div aria-hidden>
			{/* Group label: same padding and 16px text-xs line as the day heading. */}
			<div className="flex items-center gap-2 px-3 pt-7 pb-1">
				<span className="flex size-4 flex-none items-center justify-center">
					<span className="size-1.5 animate-pulse-soft rounded-full bg-muted-foreground/20" />
				</span>
				<span className="flex h-[16px] items-center">
					<span className="h-[8px] w-[44px] animate-pulse-soft rounded-full bg-muted-foreground/20" />
				</span>
			</div>
			{[0, 1, 2, 3, 4].map((i) => (
				<div key={i} className="flex h-8 items-center gap-2 px-3">
					{/* The marker slot, same as a real row's: a round placeholder rather
					    than a glyph, so the list loads as shapes and not as text. */}
					<span className="flex size-4 flex-none items-center justify-center">
						<span className="size-1.5 animate-pulse-soft rounded-full bg-muted-foreground/20" />
					</span>
					<span className="flex h-[20px] min-w-0 flex-1 items-center">
						<span className="h-[9px] w-[72%] animate-pulse-soft rounded-full bg-muted-foreground/20" />
					</span>
				</div>
			))}
		</div>
	);
}

function Group({ label, rows, ambiguous }: { label: string; rows: SessionRow[]; ambiguous: Set<string> }) {
	const collapsed = app.collapsedGroups.has(label);
	const [menuOpen, setMenuOpen] = useState(false);
	// A busy day buries every other day: only the latest few show, the rest
	// wait behind "N more". The preference shows everything by default instead.
	const [expanded, setExpanded] = useState(false);
	const showAll = app.sidebarShowAll || expanded;
	const shown = showAll ? rows : rows.slice(0, GROUP_PREVIEW_ROWS);
	const hiddenCount = showAll ? 0 : rows.length - shown.length;
	if (rows.length === 0) return null;
	return (
		<>
			{/* Right-click offers the bulk action rather than performing it: taking
			    a whole day's chats in one gesture should be asked for, not assumed. */}
			<DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						className="flex cursor-pointer select-none items-center gap-2 rounded-lg px-3 pt-7 pb-1 text-xs tracking-wide text-faint transition-colors hover:text-muted-foreground"
						// Radix opens the menu on pointerdown; swallowing it keeps
						// left-click as collapse/expand, with the menu on right-click only.
						onPointerDown={(event) => {
							if (event.button === 0) event.preventDefault();
						}}
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
				shown.map((row) => (
					<SessionEntry
						key={row.path}
						row={row}
						active={row.path === app.currentSessionPath}
						ambiguous={ambiguous.has(row.title)}
						pinned={app.pinned.has(row.path)}
						selected={app.selectedSessions.has(row.path)}
						selectedCount={app.selectedSessions.size}
						busy={
							app.busySessions.has(row.path) ||
							// The chat on screen is visibly streaming even before the main
							// process has learned its freshly minted path.
							(row.path === app.currentSessionPath && app.chat.streaming)
						}
						waiting={app.pendingApprovals.some((request) => request.session === row.path)}
						done={app.finishedUnseen.has(row.path)}
						dots={app.sidebarDots}
					/>
				))}
			{!collapsed && hiddenCount > 0 && (
				<button
					type="button"
					onClick={() => setExpanded(true)}
					className="flex h-7 items-center gap-2 rounded-lg px-3 text-left text-xs text-faint transition-colors hover:bg-accent/60 hover:text-muted-foreground"
				>
					<span className="flex rotate-90 text-faint">
						<Icon name="chevron" />
					</span>
					{hiddenCount} more
				</button>
			)}
			{!collapsed && expanded && !app.sidebarShowAll && rows.length > GROUP_PREVIEW_ROWS && (
				<button
					type="button"
					onClick={() => setExpanded(false)}
					className="flex h-7 items-center gap-2 rounded-lg px-3 text-left text-xs text-faint transition-colors hover:bg-accent/60 hover:text-muted-foreground"
				>
					<span className="flex -rotate-90 text-faint">
						<Icon name="chevron" />
					</span>
					Show fewer
				</button>
			)}
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

	// Search reaches the stored transcripts, not just the titles: the main
	// process scans recent session files for the phrase, so a half-remembered
	// word from a reply finds the chat even when no title mentions it. The
	// local filter stands in until the answer lands, so typing stays instant.
	const needle = state.sessionQuery.trim().toLowerCase();
	const [contentRows, setContentRows] = useState<SessionRow[] | null>(null);
	useEffect(() => {
		if (needle === "") {
			setContentRows(null);
			return;
		}
		let live = true;
		void api.sessions(needle).then((rows) => {
			if (live) setContentRows(rows ?? []);
		});
		return () => {
			live = false;
		};
	}, [needle]);
	const rows = needle
		? (contentRows ??
			state.sessionRows.filter(
				(row) => row.title.toLowerCase().includes(needle) || row.preview.toLowerCase().includes(needle),
			))
		: state.sessionRows;
	const visible = rows;
	const shown = visible.filter((row) => !state.archived.has(row.path));
	const pinned = shown.filter((row) => state.pinned.has(row.path));
	const ambiguous = ambiguousTitles(shown);
	// The Telegram chat is where messages from the phone land. It is one
	// standing conversation rather than one of today's, so it gets its own
	// heading above the days instead of sinking down them as they pass.
	const telegram = shown.filter((row) => row.telegram === true && !state.pinned.has(row.path));
	const rest = shown.filter((row) => !state.pinned.has(row.path) && row.telegram !== true);

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

	// Shift-click ranges run over what the sidebar shows, in the order it shows
	// it: pinned first, then each day. Published here because only this render
	// knows that order.
	const orderedPaths = [...pinned, ...telegram, ...groups.flatMap((group) => group.rows)]
		.map((row) => row.path);
	const orderKey = orderedPaths.join("|");
	// biome-ignore lint/correctness/useExhaustiveDependencies: the joined key is the list
	useEffect(() => {
		setSessionOrder(orderedPaths);
	}, [orderKey]);

	return (
		<aside
			data-sidebar
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
				// A selection lives until the reader points somewhere else: any press
				// that is not on a chat row (headers, blank space, the New button)
				// drops it, the way every file list behaves.
				onPointerDownCapture={(event) => {
					if (app.selectedSessions.size === 0) return;
					if ((event.target as HTMLElement).closest("[data-session-row]")) return;
					clearSessionSelection();
				}}
				className={cn(
					"flex h-full flex-col gap-1 overflow-hidden px-2 pt-13 pb-2",
					// At width zero the wrapper's own padding still paints 16px wide
					// (border-box cannot shrink below it), letting child borders peek
					// past the closed edge, so the closed content does not paint.
					hidden && "opacity-0",
				)}
			>
			{/* First thing under the window's own controls, so starting a chat
			    never means hunting for the button. */}
			{/* A temporary chat is only ever asked for: Ctrl+click here, or the
			    right-click menu. A plain click, Ctrl+N, and /new all save. */}
			<ContextMenu>
				<ContextMenuTrigger asChild>
					<Button
						variant="ghost"
						title="New chat — Ctrl+click (Cmd+click on macOS) or right-click for a temporary chat: nothing is saved"
						className="justify-start gap-2 px-3 font-normal"
						onClick={(event) => void newSession(event.ctrlKey || event.metaKey ? { temporary: true } : {})}
					>
						<Icon name="plus" className="text-faint" />
						New
					</Button>
				</ContextMenuTrigger>
				<ContextMenuContent className="min-w-44">
					<ContextMenuItem onSelect={() => void newSession()}>New chat</ContextMenuItem>
					<ContextMenuItem onSelect={() => void newSession({ temporary: true })}>
						New temporary chat
						<ContextMenuShortcut>Ctrl+click</ContextMenuShortcut>
					</ContextMenuItem>
				</ContextMenuContent>
			</ContextMenu>
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
				{!state.sessionsLoaded ? (
					<SessionListSkeleton />
				) : state.sessionRows.length === 0 && !state.scratchChat ? (
					<p className="px-2 py-2.5 text-sm leading-normal text-faint">No chats yet.</p>
				) : shown.length === 0 ? (
					<p className="px-2 py-2.5 text-sm leading-normal text-faint">
						{needle ? `No chats match "${state.sessionQuery.trim()}".` : "Every chat here is archived."}
					</p>
				) : (
					<>
						{pinned.length > 0 && <Group label="Pinned" rows={pinned} ambiguous={ambiguous} />}
						{telegram.length > 0 && <Group label="Telegram" rows={telegram} ambiguous={ambiguous} />}
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
