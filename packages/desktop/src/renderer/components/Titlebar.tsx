import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import {
	app,
	call,
	folderName,
	refreshState,
	requestInput,
	toggleDiffPane,
	toggleSessionSearch,
	toggleSidebar,
	toggleSidePane,
} from "../state/app.ts";
import { useApp } from "../state/useApp.ts";
import { ProjectMenuItems } from "./ProjectMenu.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "./ui/dropdown-menu.tsx";
import { Icon } from "./ui/icon.tsx";
import { Tip } from "./ui/tooltip.tsx";

function TitlebarButton({
	name,
	title,
	onClick,
	children,
}: {
	name: string;
	title: string;
	onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
	children?: React.ReactNode;
}) {
	return (
		// The label is the tooltip and the accessible name both: an icon-only
		// button has no text of its own to name it.
		<Tip label={title}>
			<button
				type="button"
				aria-label={title}
				onClick={onClick}
				className="app-no-drag relative flex size-7 items-center justify-center rounded-lg text-faint transition-colors hover:bg-accent hover:text-foreground"
			>
				<Icon name={name} />
				{children}
			</button>
		</Tip>
	);
}

/** The frameless window's top strip: pane toggles and the session title. */
/**
 * How much of the window the side panes are taking.
 *
 * The title belongs over the conversation, not the window: centring it in the
 * full width puts it off to one side as soon as a pane opens. Measuring beats
 * threading widths through state, since both panes size themselves.
 */
function usePaneInsets(): { left: number; right: number } {
	const [insets, setInsets] = useState({ left: 0, right: 0 });
	useEffect(() => {
		const aside = document.querySelector("aside");
		const rail = document.querySelector("[data-rail]");
		const read = (): void => {
			setInsets({
				left: aside?.getBoundingClientRect().width ?? 0,
				right: rail?.getBoundingClientRect().width ?? 0,
			});
		};
		read();
		const observer = new ResizeObserver(read);
		if (aside) observer.observe(aside);
		if (rail) observer.observe(rail);
		window.addEventListener("resize", read);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", read);
		};
	}, []);
	return insets;
}

export function Titlebar() {
	const insets = usePaneInsets();
	const state = useApp();
	const activeRow = state.sessionRows.find((row) => row.path === state.currentSessionPath);
	const headerTitle = state.sessionName || (state.chat.messages.length > 0 ? (activeRow?.title ?? "") : "");
	// The folder this chat is working in, project or not. A chat started with
	// no project open is given one of its own under the chats root, named after
	// its own first words - and that folder is where its files are going, so it
	// is exactly what is being asked about. Read off the chat rather than the
	// window, because the two disagree until the move that follows a chat to
	// its folder has landed.
	const folder = folderName(activeRow?.cwd || state.appInfo.cwd);
	// The folder bar above the composer answers this for a chat with nothing in
	// it yet, and goes as soon as the chat has turns. So the strip takes the
	// question from exactly there: between them every chat says where it is,
	// and neither says it over the other.
	const hasTurns = state.chat.messages.length > 0;

	return (
		<div
			// One strip across the whole width, the same colour as the
			// window-controls overlay the OS draws on the right. The sidebar's
			// darker ground is continued over it below, so the pane reads as one
			// column running to the top of the window rather than stopping short.
			className="app-drag fixed inset-x-0 top-0 z-10 flex h-9 select-none items-center justify-center bg-background"
			// Centre in the space actually left over, not in the chat pane: the
			// icons on the left and the pane toggles and window controls on the
			// right float over the bar, so the gap between them is what a reader
			// sees as the middle.
			style={{ paddingLeft: Math.max(insets.left, 116), paddingRight: Math.max(insets.right, 248) }}
		>
			{/* The sidebar carried up behind its own buttons: without it the deep
			    column ends at the strip and the pane looks cut off at the top. */}
			{insets.left > 0 && (
				<div
					aria-hidden
					className="pointer-events-none absolute inset-y-0 left-0 border-r bg-background-deep [background:var(--background-deep)]"
					style={{ width: insets.left }}
				/>
			)}
			<div className="app-no-drag absolute top-1 left-2.5 flex gap-0.5">
				{/* A frameless window draws no menu bar, so this is the way in. */}
				<TitlebarButton
					name="menu"
					title="Menu"
					onClick={(event) => {
						const box = event.currentTarget.getBoundingClientRect();
						void api.popupMenu(box.left, box.bottom);
					}}
				/>
				<TitlebarButton
					name="sidebar"
					title="Show or hide the sidebar (Ctrl+B)"
					onClick={toggleSidebar}
				/>
				<TitlebarButton name="search" title="Search sessions (Ctrl+K)" onClick={() => toggleSessionSearch()} />
			</div>
			{state.temporaryChat ? (
				// The ChatGPT-style marker: this chat is not being kept. It must
				// read at a glance, before any turn runs, because its promise is
				// about everything typed here, not just what already is.
				<Tip label="Nothing from this chat is saved, listed, or remembered">
					<span className="app-no-drag rounded-md bg-warn/15 px-1.5 py-0.5 text-[11px] font-medium text-warn">
						Temporary — not saved
					</span>
				</Tip>
			) : (
				hasTurns && (
					<div className="flex min-w-0 max-w-[40vw] items-center gap-2">
				{headerTitle !== "" && (
				<Tip label="Rename this session">
				<button
					type="button"
					aria-label="Rename this session"
					className="app-no-drag min-w-0 overflow-hidden text-ellipsis whitespace-nowrap rounded-lg px-2.5 py-0.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
					onClick={async () => {
						// In-app input, never window.prompt: Electron does not
						// implement it: it throws, so this click used to do nothing.
						const next = await requestInput({ title: "Rename chat", initial: headerTitle });
						if (next === null) return;
						const trimmed = next.trim();
						if (trimmed === "" || trimmed === headerTitle) return;
						await call("setSessionName", trimmed);
						app.sessionName = trimmed;
						await refreshState();
					}}
				>
					{headerTitle}
				</button>
				</Tip>
				)}
				{folder !== "" && (
					// Every chat says where it is working. The folder chip above the
					// composer goes once a chat has turns, so this is the only place
					// left that answers it - and a chat that made its own folder needs
					// the answer most, because that name is the only sign of where its
					// files went. The full path is on hover, which is what tells a
					// project apart from a folder a chat named after itself. It carries
					// the project menu rather than sitting there looking like a button
					// and doing nothing.
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Tip label={activeRow?.cwd || state.appInfo.cwd}>
								<button
									type="button"
									aria-label={`Working folder ${folder}`}
									className="app-no-drag max-w-[10rem] flex-none overflow-hidden text-ellipsis whitespace-nowrap rounded-md bg-card px-1.5 py-0.5 text-[11px] text-faint transition-colors hover:text-foreground data-[state=open]:text-foreground"
								>
									{folder}
								</button>
							</Tip>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="center" className="min-w-56">
							<ProjectMenuItems />
						</DropdownMenuContent>
					</DropdownMenu>
				)}
					</div>
				)
			)}
			<div className="app-no-drag absolute top-1 right-[148px] flex gap-0.5">
				{/* No count badge: at branch scope the number runs to the hundreds,
				    which says nothing useful in a 14px circle and reads as an alert
				    about work that is simply the branch. The composer bar carries the
				    real figures. */}
				<TitlebarButton name="diff" title="Changes (Ctrl+Shift+D)" onClick={() => toggleDiffPane()} />
				<TitlebarButton
					name="side"
					title="Side chat (Ctrl+;)"
					onClick={() => toggleSidePane()}
				/>
			</div>
		</div>
	);
}
