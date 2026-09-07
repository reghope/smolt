import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../lib/cn.ts";
import { formatCost, parentHint, shortTokens } from "../lib/format.ts";
import { storedPreference, storePreference } from "../lib/prefs.ts";
import { PANE_COLLAPSE_ZONE, ResizeHandle } from "./ResizeHandle.tsx";
import {
	app,
	bump,
	refreshDiff,
	refreshDiffPaneSoon,
	resetSideChat,
	sendSideMessage,
	toggleDiffPane,
	toggleSidePane,
} from "../state/app.ts";
import { useApp } from "../state/useApp.ts";
import { renderMarkdown } from "../markdown.ts";
import type { DiffFile } from "../state/app.ts";
import { Button } from "./ui/button.tsx";
import { Icon } from "./ui/icon.tsx";
import { Tip } from "./ui/tooltip.tsx";

function PaneHead({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<div className="flex select-none items-center justify-between border-b py-2 pr-2.5 pl-4">
			<h2 className="text-sm font-semibold text-muted-foreground">{title}</h2>
			<div className="flex gap-0.5">{children}</div>
		</div>
	);
}

/**
 * Past this many lines of hunk body the pane opens as a list rather than a
 * wall of diff, whatever the file count: a handful of generated files can
 * carry more lines than a hundred real ones, and painting them all is what
 * the pane was stuttering on.
 */
const LARGE_DIFF_LINES = 1500;

/** One memoized file row: the summary, and the hunks only while open. */
const DiffRow = memo(function DiffRow({
	file,
	open,
	onToggle,
}: {
	file: DiffFile;
	open: boolean;
	onToggle: (path: string) => void;
}) {
	// Split once per file body, not once per render of the pane: the app
	// re-renders on every stream bump, and re-splitting every file's hunks
	// each time was most of the pane's cost.
	const lines = useMemo(() => {
		if (file.hunks.trim() === "") return null;
		return file.hunks
			.split("\n")
			.filter((line) => !line.startsWith("---") && !line.startsWith("+++"));
	}, [file.hunks]);
	return (
		<details
			open={open}
			className="group/df border-b"
			onToggle={(event) => {
				if (event.currentTarget.open !== open) onToggle(file.path);
			}}
		>
			<summary className="sticky top-0 z-[1] flex cursor-pointer list-none select-none items-center gap-2 bg-background-deep px-3 py-1.5 hover:bg-accent/50 [background:var(--background-deep)] [&::-webkit-details-marker]:hidden">
				<span className="flex flex-none text-faint transition-transform group-open/df:rotate-90">
					<Icon name="chevron" />
				</span>
				<Icon name="diff" className="flex-none text-faint" />
				{/* The name carries the meaning and the directory only
				    disambiguates, so the name keeps the room and the
				    directory gives way first. */}
				<Tip label={file.path} side="left">
					<span className="min-w-0 flex-1 truncate text-left font-mono text-xs">
						{file.path.split("/").pop()}
					</span>
				</Tip>
				{parentHint(file.path) !== "" && (
					<span className="hidden flex-none truncate font-mono text-[11px] text-faint sm:inline max-w-[38%]">
						{parentHint(file.path)}
					</span>
				)}
				<span className="flex flex-none gap-1.5 font-mono text-xs tabular-nums">
					<span className="text-ok">+{file.added}</span>
					<span className="text-destructive">−{file.removed}</span>
				</span>
			</summary>
			{/* Closed rows paint nothing: a collapsed file costs one summary row,
			    not its whole body in the DOM. */}
			{open && (
				<div className="overflow-x-auto pb-1.5">
					{lines === null ? (
						<div className="px-3.5 py-1 text-xs text-faint">No textual changes</div>
					) : (
						lines.map((line, index) => {
							const kind = line.startsWith("@@")
								? "meta"
								: line.startsWith("+")
									? "add"
									: line.startsWith("-")
										? "del"
										: "ctx";
							return (
								<div
									key={index}
									className={cn(
										"whitespace-pre border-l-2 border-transparent py-0 pr-3 pl-3.5 font-mono text-xs leading-normal",
										kind === "ctx" && "text-faint",
										kind === "add" && "border-ok/50 bg-ok/10 text-ok",
										kind === "del" && "border-destructive/50 bg-destructive/10 text-destructive",
										kind === "meta" && "my-1 bg-foreground/[0.03] text-tint-text",
									)}
								>
									{line || " "}
								</div>
							);
						})
					)}
				</div>
			)}
		</details>
	);
});


/**
 * Past this many files the pane opens as a list rather than a wall of diff.
 *
 * A branch-scoped diff routinely runs to hundreds of files. Rendering every
 * hunk of that on open costs seconds and buries the one file being looked
 * for; the list is the useful view at that size, and a file opens on demand.
 */
const LARGE_DIFF_FILES = 12;

/**
 * How many file rows the pane paints at a time.
 *
 * A branch diff of several hundred files built the whole list on open, which
 * cost a visible pause before anything appeared. A page is comfortably more
 * than fits the tallest window, so the reader reaches the end of it only by
 * scrolling, and the next page is in place by the time they arrive.
 */
const DIFF_PAGE = 30;

/**
 * Grow a count as a sentinel at the end of the list comes into view.
 *
 * An observer rather than a scroll handler: it fires only when the end is
 * actually near, and costs nothing on the frames in between.
 */
function usePaged(
	total: number,
	page: number,
	/** What counts as a different list: paging starts over when this changes. */
	reset: string,
): {
	shown: number;
	scrollRef: (node: HTMLDivElement | null) => void;
	endRef: (node: HTMLDivElement | null) => void;
} {
	const [shown, setShown] = useState(page);
	const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
	const [end, setEnd] = useState<HTMLDivElement | null>(null);
	// A different branch is a different list. A refresh of the same one is not:
	// resetting on every total would throw the reader back to the top whenever
	// a turn touched one more file.
	useEffect(() => {
		setShown(page);
	}, [reset, page]);
	useEffect(() => {
		if (end === null || shown >= total) return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) setShown((count) => Math.min(count + page, total));
			},
			// A screen of slack inside the pane's own scroller, so the next page is
			// in place before the end of this one arrives.
			{ root: scroller, rootMargin: "600px" },
		);
		observer.observe(end);
		return () => observer.disconnect();
	}, [end, scroller, shown, total, page]);
	return { shown: Math.min(shown, total), scrollRef: setScroller, endRef: setEnd };
}

/** Everything the branch changed, beside the conversation. */
function DiffPane() {
	const state = useApp();
	// The figures are the main process's totals over everything, not a sum of
	// the rows: a tree with more untracked files than the list will hold still
	// reports all of them, and the bar and the pane say the same thing.
	const totals = { added: state.diffAdded, removed: state.diffRemoved };
	// A line-heavy diff is a large diff whatever the file count: painting
	// thousands of hunk rows in one go is the stutter, so it gets the paged,
	// collapsed list like a many-file one.
	const totalLines = useMemo(
		() => state.diffFiles.reduce((sum, file) => sum + file.added + file.removed, 0),
		[state.diffFiles],
	);
	const large = state.diffFiles.length > LARGE_DIFF_FILES || totalLines > LARGE_DIFF_LINES;
	// Which files are open, held for the list rather than per row, so expand-all
	// and collapse-all can speak for the lot.
	const [opened, setOpened] = useState<Set<string>>(new Set());
	const allOpen = state.diffFiles.length > 0 && opened.size === state.diffFiles.length;
	const { shown, scrollRef, endRef } = usePaged(state.diffFiles.length, DIFF_PAGE, state.repoBranch);
	const toggleFile = useCallback((path: string): void => {
		setOpened((prev) => {
			const next = new Set(prev);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});
	}, []);
	return (
		<aside className="flex min-h-0 flex-1 flex-col overflow-hidden">
			{/* The branch pair is the title: it says exactly what this list is a
			    diff of, which "Changes" never did. */}
			<div className="flex select-none items-center gap-2 border-b py-2 pr-2.5 pl-3">
				<Icon name="folder" className="flex-none text-faint" />
				<div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
					{state.repoBaseBranch !== "" && (
						<>
							<span className="flex-none truncate text-muted-foreground">
								{state.repoBaseBranch.replace(/^origin\//, "")}
							</span>
							<span className="flex-none text-faint">→</span>
						</>
					)}
					<Tip label={state.repoBranch}>
						<span className="min-w-0 truncate font-medium">{state.repoBranch || "Working tree"}</span>
					</Tip>
				</div>
				<div className="flex flex-none gap-0.5">
					{large && (
						<Tip label={allOpen ? "Collapse all files" : "Expand all files"}>
							<Button
								variant="ghost"
								size="icon"
								className="size-7"
								aria-label={allOpen ? "Collapse all files" : "Expand all files"}
								onClick={() => setOpened(allOpen ? new Set() : new Set(state.diffFiles.map((file) => file.path)))}
							>
								<Icon name="chevron" className={allOpen ? "-rotate-90" : "rotate-90"} />
							</Button>
						</Tip>
					)}
					<Tip label="Refresh">
						<Button variant="ghost" size="icon" className="size-7" aria-label="Refresh" onClick={() => void refreshDiff()}>
							<Icon name="refresh" />
						</Button>
					</Tip>
					<Tip label="Close (Ctrl+Shift+D)">
						<Button
							variant="ghost"
							size="icon"
							className="size-7"
							aria-label="Close changes pane"
							onClick={() => toggleDiffPane(false)}
						>
							<Icon name="close" />
						</Button>
					</Tip>
				</div>
			</div>
			{state.diffFiles.length > 0 && (
				<div className="px-3 pt-1.5 text-xs text-faint">
					{large ? (
						"Files are collapsed for large diffs. Select a file to expand it."
					) : (
						<>
							{state.diffChanged} {state.diffChanged === 1 ? "file" : "files"} ·{" "}
							<span className="text-ok">+{totals.added.toLocaleString()}</span>{" "}
							<span className="text-destructive">−{totals.removed.toLocaleString()}</span>
							{state.diffUnlisted > 0 && ` · ${state.diffUnlisted.toLocaleString()} untracked not listed`}
						</>
					)}
				</div>
			)}
			<div ref={scrollRef} className="flex-1 overflow-y-auto pt-1.5 pb-4">
				{state.diffFiles.length === 0 ? (
					<p className="px-4 py-3 text-sm leading-normal text-faint">
						{state.diffUnavailable !== ""
							? state.diffUnavailable
							: state.repoBaseBranch !== ""
								? `Nothing on ${state.repoBranch} that ${state.repoBaseBranch.replace(/^origin\//, "")} does not already have.`
								: "Nothing changed since the last commit."}
					</p>
				) : (
					state.diffFiles.slice(0, shown).map((file) => (
						<DiffRow
							key={file.path}
							file={file}
							open={large ? opened.has(file.path) : true}
							onToggle={toggleFile}
						/>
					))
				)}
				{/* The end of what is painted: seeing it is what asks for more. It
				    says where the reader is rather than sitting blank, because a list
				    that stops short with no word for it reads as the whole diff. */}
				{shown < state.diffFiles.length && (
					<div ref={endRef} className="px-3 py-2 text-xs text-faint">
						{shown} of {state.diffFiles.length} files
					</div>
				)}
			</div>
		</aside>
	);
}

/** A second agent, kept out of the main transcript. */
function SidePane() {
	const state = useApp();
	const [draft, setDraft] = useState("");
	const logRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		const node = logRef.current;
		if (node) node.scrollTop = node.scrollHeight;
	});
	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	return (
		<aside className="flex min-h-0 flex-1 flex-col overflow-hidden">
			<PaneHead title="Side chat">
				<Tip label="Discard and start over">
					<Button
						variant="ghost"
						size="icon"
						className="size-7"
						aria-label="Discard and start over"
						onClick={() => void resetSideChat()}
					>
						<Icon name="trash" />
					</Button>
				</Tip>
				<Tip label="Close (Ctrl+;)">
					<Button
						variant="ghost"
						size="icon"
						className="size-7"
						aria-label="Close side chat"
						onClick={() => toggleSidePane(false)}
					>
						<Icon name="close" />
					</Button>
				</Tip>
			</PaneHead>
			<div ref={logRef} className="flex-1 overflow-y-auto px-4 py-3.5">
				{state.sideError ? (
					<p className="text-sm leading-normal text-destructive">{state.sideError}</p>
				) : state.side.messages.length === 0 ? (
					<p className="text-sm leading-normal text-faint">
						A separate thread that can see this conversation. Nothing here is added to the main transcript.
					</p>
				) : (
					state.side.messages.map((message, index) => (
						<div key={index} className={cn("mb-3.5", message.role === "user" && "flex justify-end")}>
							{message.role === "user" ? (
								<div className="max-w-full rounded-xl bg-card px-3 py-2 text-sm leading-relaxed">
									{message.blocks.map((block, i) =>
										block.kind === "text" ? (
											<div key={i} className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(block.text) }} />
										) : null,
									)}
								</div>
							) : (
								message.blocks.map((block, i) =>
									// A side thread that fails says so where it failed. Without
									// this the row simply stops, which is the same silence the
									// main transcript used to give a refused request.
									block.kind === "error" ? (
										<div
											key={i}
											className="rounded-lg border border-destructive/30 bg-destructive/5 px-2.5 py-1.5 text-sm leading-relaxed break-words whitespace-pre-wrap text-destructive"
										>
											{block.text}
										</div>
									) : block.kind === "text" && block.text.trim() !== "" ? (
										<div
											key={i}
											className="md text-sm leading-relaxed"
											dangerouslySetInnerHTML={{ __html: renderMarkdown(block.text) }}
										/>
									) : null,
								)
							)}
						</div>
					))
				)}
			</div>
			<div className="border-t p-3">
				<textarea
					ref={inputRef}
					rows={1}
					value={draft}
					placeholder="Ask without touching the main thread…"
					className="block max-h-36 w-full resize-none rounded-lg border bg-card px-3 py-2 text-[13.5px] leading-normal outline-none placeholder:text-faint focus:border-border-strong"
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							const text = draft.trim();
							if (text === "") return;
							setDraft("");
							void sendSideMessage(text);
						} else if (event.key === "Escape") {
							toggleSidePane(false);
						}
					}}
				/>
			</div>
		</aside>
	);
}

const RAIL_MIN_WIDTH = 280;

/**
 * The right rail: Changes and the side chat stacked, resizable by its left
 * border while it is open. Open it is a rounded card inset from the window
 * edges.
 *
 * Closed, the window's right edge is just an edge. It used to be a drag
 * handle that pulled the rail out, which meant any drag that started near
 * the right of the window opened a pane nobody asked for. The Changes button
 * is how the pane opens.
 */
export function RightRail() {
	const state = useApp();
	const railRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	/**
	 * The width a drag is currently painting.
	 *
	 * It has to be React's own value rather than an inline style written on the
	 * node: the app re-renders constantly while the agent streams, and every
	 * render re-applies the style prop, which would stomp an imperative write
	 * mid-drag and snap the pane back.
	 */
	const [live, setLive] = useState<number | null>(null);
	const [width, setWidth] = useState<number | null>(() => {
		const stored = Number(storedPreference("smolt.railWidth", ""));
		return stored >= RAIL_MIN_WIDTH ? stored : null;
	});

	// Closed is width zero rather than unmounted, so the open pane keeps its
	// scroll position and its loaded diff between openings.
	const hidden = !state.diffOpen && !state.sideOpen;
	const showDiff = state.diffOpen;
	const showSide = state.sideOpen;

	// Becoming visible is the cue to re-read: the pane holds whatever the last
	// open left behind, so opening (or dragging open) freshens it — throttled
	// to one git read per interval, so it costs nothing while closed.
	useEffect(() => {
		if (showDiff) refreshDiffPaneSoon();
	}, [showDiff, state.repoBranch]);

	return (
		<div
			ref={railRef}
			data-rail
			// Open (or being dragged out), the rail is a card set in from the
			// window edge, below the titlebar. Fully closed it collapses to the
			// bare edge so the drag grip stays at the window side.
			className={cn(
				"relative max-w-[65vw] flex-none bg-background-deep [background:var(--background-deep)]",
				hidden ? "border-l" : "mt-12 mr-2 mb-2 ml-2 rounded-xl border",
			)}
			style={{ width: live ?? (hidden ? 0 : (width ?? "clamp(300px, 34vw, 420px)")) }}
		>
			{/* Only while it is open: the closed edge is not a way in. */}
			{!hidden && (
				<ResizeHandle
					side="left"
					label="Resize the side panes"
					minWidth={RAIL_MIN_WIDTH}
					measure={(clientX) =>
						Math.min(Math.max(window.innerWidth - clientX, 0), Math.round(window.innerWidth * 0.6))
					}
					onWidth={(next) => {
						setLive(next);
						if (contentRef.current) contentRef.current.style.opacity = next === 0 ? "0" : "1";
					}}
					onRelease={(next) => {
						setLive(null);
						if (contentRef.current) contentRef.current.style.opacity = "";
						if (next <= PANE_COLLAPSE_ZONE) {
							// Dragged shut; the stored width survives for the next open.
							app.diffOpen = false;
							app.sideOpen = false;
							bump();
							return;
						}
						const settled = Math.max(next, RAIL_MIN_WIDTH);
						setWidth(settled);
						storePreference("smolt.railWidth", String(Math.round(settled)));
						bump();
					}}
				/>
			)}
			{/* The scroll (and the closed state's clipping and inertness) lives
			    one level in, so the handle on the rail's edge stays live. */}
			<div
				ref={contentRef}
				inert={hidden || undefined}
				className={cn(
					// pt clears the titlebar strip overlaying the column's top, the
					// way the sidebar's content clears it.
					"flex h-full flex-col overflow-hidden",
					// At width zero, painted content would peek past the closed edge,
					// so the closed rail does not paint (matching the sidebar).
					hidden && "opacity-0",
				)}
			>
				{showDiff && <DiffPane />}
				{showDiff && showSide && <div className="h-px flex-none bg-border" />}
				{showSide && <SidePane />}
			</div>
		</div>
	);
}
