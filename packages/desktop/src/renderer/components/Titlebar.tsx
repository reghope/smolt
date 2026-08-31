import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import {
	app,
	call,
	chatDidToolWork,
	projectName,
	refreshState,
	requestInput,
	toggleDiffPane,
	toggleSessionSearch,
	toggleSidebar,
	toggleSidePane,
} from "../state/app.ts";
import { useApp } from "../state/useApp.ts";
import { Icon } from "./ui/icon.tsx";

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
		<button
			type="button"
			title={title}
			aria-label={title}
			onClick={onClick}
			className="app-no-drag relative flex size-7 items-center justify-center rounded-lg text-faint transition-colors hover:bg-accent hover:text-foreground"
		>
			<Icon name={name} />
			{children}
		</button>
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
	const folder = projectName();

	return (
		<div
			className="app-drag fixed inset-x-0 top-0 z-10 flex h-9 select-none items-center justify-center"
			// Centre in the space actually left over, not in the chat pane: the
			// icons on the left and the pane toggles and window controls on the
			// right float over the bar, so the gap between them is what a reader
			// sees as the middle.
			style={{ paddingLeft: Math.max(insets.left, 116), paddingRight: Math.max(insets.right, 248) }}
		>
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
			{headerTitle !== "" && (
				<div className="flex min-w-0 max-w-[40vw] items-center gap-2">
				<button
					type="button"
					title="Rename this session"
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
				{state.appInfo.hasProject && folder !== "" && (
					<span
						className="max-w-[10rem] flex-none overflow-hidden text-ellipsis whitespace-nowrap rounded-md bg-card px-1.5 py-0.5 text-[11px] text-faint"
						title={state.appInfo.cwd}
					>
						{folder}
					</span>
				)}
				</div>
			)}
			<div className="app-no-drag absolute top-1 right-[148px] flex gap-0.5">
				<TitlebarButton
					name="diff"
					title="Changes (Ctrl+Shift+D)"
					onClick={() => toggleDiffPane()}
				>
					{state.diffFiles.length > 0 && chatDidToolWork() && (
						<span className="absolute top-0 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-salmon px-1 text-center font-mono text-[10px] leading-none text-primary-foreground">
							{state.diffFiles.length}
						</span>
					)}
				</TitlebarButton>
				<TitlebarButton
					name="side"
					title="Side chat (Ctrl+;)"
					onClick={() => toggleSidePane()}
				/>
			</div>
		</div>
	);
}
