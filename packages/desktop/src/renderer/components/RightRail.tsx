import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn.ts";
import { formatCost, shortTokens } from "../lib/format.ts";
import { storedPreference, storePreference } from "../lib/prefs.ts";
import { PANE_COLLAPSE_ZONE, ResizeHandle } from "./ResizeHandle.tsx";
import {
	app,
	bump,
	refreshDiff,
	resetSideChat,
	sendSideMessage,
	toggleDiffPane,
	toggleSidePane,
} from "../state/app.ts";
import { useApp } from "../state/useApp.ts";
import { renderMarkdown } from "../markdown.ts";
import { Button } from "./ui/button.tsx";
import { Icon } from "./ui/icon.tsx";

function PaneHead({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<div className="flex select-none items-center justify-between border-b py-2 pr-2.5 pl-4">
			<h2 className="text-sm font-semibold text-muted-foreground">{title}</h2>
			<div className="flex gap-0.5">{children}</div>
		</div>
	);
}


/** Working-tree changes beside the conversation. */
function DiffPane() {
	const state = useApp();
	const totals = state.diffFiles.reduce(
		(acc, file) => ({ added: acc.added + file.added, removed: acc.removed + file.removed }),
		{ added: 0, removed: 0 },
	);
	return (
		<aside className="flex min-h-0 flex-1 flex-col overflow-hidden">
			<PaneHead title="Changes">
				<Button variant="ghost" size="icon" className="size-7" title="Refresh" onClick={() => void refreshDiff()}>
					<Icon name="refresh" />
				</Button>
				<Button
					variant="ghost"
					size="icon"
					className="size-7"
					title="Close (Ctrl+Shift+D)"
					onClick={() => toggleDiffPane(false)}
				>
					<Icon name="close" />
				</Button>
			</PaneHead>
			{state.diffFiles.length > 0 && (
				<div className="px-4 pt-1.5 text-xs text-faint">
					{state.diffFiles.length} {state.diffFiles.length === 1 ? "file" : "files"} ·{" "}
					<span className="text-ok">+{totals.added}</span> <span className="text-destructive">−{totals.removed}</span>
				</div>
			)}
			<div className="flex-1 overflow-y-auto pt-1.5 pb-4">
				{state.diffFiles.length === 0 ? (
					<p className="px-4 py-3 text-sm leading-normal text-faint">
						This chat hasn't changed anything yet.
						{state.preexistingChanges > 0 &&
							` ${state.preexistingChanges} file${state.preexistingChanges === 1 ? " was" : "s were"} already modified when it opened.`}
					</p>
				) : (
					state.diffFiles.map((file) => (
						<details key={file.path} open className="group/df border-b">
							<summary className="sticky top-0 z-[1] flex cursor-pointer list-none select-none items-center gap-2 bg-background-deep px-3 py-2 hover:bg-accent/50 [background:var(--background-deep)] [&::-webkit-details-marker]:hidden">
								<span className="flex text-faint transition-transform group-open/df:rotate-90">
									<Icon name="chevron" />
								</span>
								<span
									className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left font-mono text-xs [direction:rtl]"
									title={file.path}
								>
									{file.path}
								</span>
								<span className="flex flex-none gap-1.5 font-mono text-xs">
									<span className="text-ok">+{file.added}</span>
									<span className="text-destructive">−{file.removed}</span>
								</span>
							</summary>
							<div className="overflow-x-auto pb-1.5">
								{file.hunks.trim() === "" ? (
									<div className="px-3.5 py-1 text-xs text-faint">No textual changes</div>
								) : (
									file.hunks
										.split("\n")
										.filter((line) => !line.startsWith("---") && !line.startsWith("+++"))
										.map((line, index) => {
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
														kind === "meta" && "my-1 bg-foreground/[0.03] text-salmon-text",
													)}
												>
													{line || " "}
												</div>
											);
										})
								)}
							</div>
						</details>
					))
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
				<Button
					variant="ghost"
					size="icon"
					className="size-7"
					title="Discard and start over"
					onClick={() => void resetSideChat()}
				>
					<Icon name="trash" />
				</Button>
				<Button variant="ghost" size="icon" className="size-7" title="Close (Ctrl+;)" onClick={() => toggleSidePane(false)}>
					<Icon name="close" />
				</Button>
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
									block.kind === "text" && block.text.trim() !== "" ? (
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
 * border. Dragging to the window's edge closes it; the titlebar toggles or a
 * drag from that edge bring it back at its stored width.
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

	// Closed is width zero, not unmounted: the drag edge stays at the window's
	// side, so hovering there still reveals the grip and a drag reopens it.
	const hidden = !state.diffOpen && !state.sideOpen;

	// Changes and the side chat are separate panes that happen to share this
	// column. Nothing here opens one on the other's behalf: a drag on the closed
	// edge cannot know which was wanted, so opening is left to their own buttons.

	return (
		<div
			ref={railRef}
			data-rail
			className="relative max-w-[65vw] flex-none border-l bg-background-deep [background:var(--background-deep)]"
			style={{ width: live ?? (hidden ? 0 : (width ?? "clamp(300px, 34vw, 420px)")) }}
		>
			{/* Only a rail that is open can be resized; with both panes shut there
			    is nothing to size, and a live edge there would just be a way to
			    open a pane the reader did not pick. */}
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
						// A deliberate close; the stored width survives for the next open.
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
					"flex h-full flex-col overflow-hidden pt-9",
					// At width zero, painted content would peek past the closed edge —
					// so the closed rail does not paint (matching the sidebar).
					hidden && "opacity-0",
				)}
			>
				{state.diffOpen && <DiffPane />}
				{state.diffOpen && state.sideOpen && <div className="h-px flex-none bg-border" />}
				{state.sideOpen && <SidePane />}
			</div>
		</div>
	);
}
