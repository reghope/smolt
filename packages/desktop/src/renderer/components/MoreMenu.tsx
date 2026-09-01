import { app, bump, toggleDiffPane, toggleSessionSearch } from "../state/app.ts";
import { useApp } from "../state/useApp.ts";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { Icon } from "./ui/icon.tsx";

/**
 * The sidebar footer menu: the things that are about the app rather than the
 * conversation, kept out of the session list.
 *
 * Choosing a folder is not one of them. That belongs to the chat about to
 * start, and the composer offers it there — repeating it down here only made
 * two places to look for the same switch.
 */
export function MoreMenu() {
	const state = useApp();
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					title="Settings"
					className="flex h-8 w-full items-center gap-2 rounded-lg px-3 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent"
				>
					<Icon name="settings" className="text-faint" />
					<span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">Settings</span>
					<Icon name="chevron" className="-rotate-90 text-faint" />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" side="top" className="min-w-56">
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
				<DropdownMenuSeparator />
				<div className="flex items-center gap-1.5 px-2.5 py-1 font-mono text-xs text-faint">
					<span className="font-bold tracking-[-0.08em] text-salmon-text" aria-hidden="true">&gt;&lt;&gt;</span>
					smolt {state.appInfo.version}
				</div>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
