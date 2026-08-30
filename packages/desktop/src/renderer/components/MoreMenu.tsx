import {
	app,
	bump,
	call,
	closeProject,
	openProject,
	pickProject,
	projectName,
	toggleDiffPane,
	toggleSessionSearch,
	toggleTerminalPane,
} from "../state/app.ts";
import { useApp } from "../state/useApp.ts";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { Icon } from "./ui/icon.tsx";

/** Last path segment, which is how a folder is recognised at a glance. */
function folderName(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/**
 * The sidebar footer menu: the things that are about the app rather than the
 * conversation, kept out of the session list.
 *
 * The folder list lives here because chats are stored per working directory:
 * opening a folder filters the sidebar down to its own chats, and this is what
 * makes that reversible.
 */
export function MoreMenu() {
	const state = useApp();
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					title="Settings and folders"
					className="flex h-8 w-full items-center gap-2 rounded-lg px-3 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent"
				>
					<Icon name="settings" className="text-faint" />
					<span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">Settings</span>
					<Icon name="chevron" className="-rotate-90 text-faint" />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" side="top" className="min-w-56">
				<DropdownMenuLabel>Folder</DropdownMenuLabel>
				{/* Always listed, ticked when it is the state: an option that
				    vanishes once chosen leaves nothing to show it was chosen. */}
				<DropdownMenuItem
					onSelect={() => {
						if (state.appInfo.hasProject) void closeProject();
					}}
				>
					<span className="min-w-0 flex-1">No project folder</span>
					{!state.appInfo.hasProject && <Icon name="check" className="text-salmon-text" />}
				</DropdownMenuItem>
				{state.recentProjects.map((path) => (
					<DropdownMenuItem
						key={path}
						title={path}
						onSelect={() => {
							if (!state.appInfo.hasProject || path !== state.appInfo.cwd) void openProject(path);
						}}
					>
						<span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
							{folderName(path)}
						</span>
						{state.appInfo.hasProject && path === state.appInfo.cwd && <Icon name="check" className="text-salmon-text" />}
					</DropdownMenuItem>
				))}
				<DropdownMenuItem onSelect={() => void pickProject()}>
					<Icon name="folder" />
					Add folder…
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem
					onSelect={() => {
						app.settingsOpen = true;
						bump();
					}}
				>
					Settings
					<DropdownMenuShortcut>Ctrl+,</DropdownMenuShortcut>
				</DropdownMenuItem>
				<DropdownMenuItem
					onSelect={() => {
						app.shortcutsOpen = true;
						bump();
					}}
				>
					Keyboard shortcuts
					<DropdownMenuShortcut>Ctrl+/</DropdownMenuShortcut>
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={() => toggleSessionSearch(true)}>
					Search sessions
					<DropdownMenuShortcut>Ctrl+K</DropdownMenuShortcut>
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={() => toggleDiffPane()}>
					Changes
					<DropdownMenuShortcut>Ctrl+Shift+D</DropdownMenuShortcut>
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={() => toggleTerminalPane()}>
					Terminal
					<DropdownMenuShortcut>Ctrl+`</DropdownMenuShortcut>
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={() => void call("bash", `start "" "${state.appInfo.cwd}"`)}>
					Open project folder
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<div className="px-2.5 py-1 font-mono text-xs text-faint">smolt {state.appInfo.version}</div>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
