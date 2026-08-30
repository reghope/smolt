import { addFolder, app, bump, closeProject, openProject, pickProject } from "../state/app.ts";
import { useApp } from "../state/useApp.ts";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { Icon } from "./ui/icon.tsx";

/**
 * The folders a new chat will work in, offered before it starts.
 *
 * The first chip is the working directory and carries the switcher; the rest
 * are folders the agent has merely been told about. It shows only on an empty
 * chat because that is the moment the choice still matters — once a turn has
 * run, moving the ground under it would be worse than leaving it be.
 */

/** Last path segment, which is how a folder is recognised at a glance. */
function folderName(path: string): string {
	const parts = path.split(/[\\/]/).filter(Boolean);
	return parts.at(-1) ?? path;
}

const CHIP =
	"flex h-7 items-center gap-1.5 rounded-lg border bg-card px-2.5 text-xs text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground";

export function FolderBar() {
	const state = useApp();
	const [primary, ...extra] = state.folders;

	return (
		<div className="mb-2 flex flex-wrap items-center gap-1.5">
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<button type="button" className={CHIP} title={primary ?? "Choose a folder to work in"}>
						<Icon name="folder" className="text-faint" />
						{primary ? folderName(primary) : "No project folder"}
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" className="min-w-56">
					<DropdownMenuLabel>Recent</DropdownMenuLabel>
					{state.recentProjects.map((path) => (
						<DropdownMenuItem
							key={path}
							title={path}
							onSelect={() => {
								if (path !== primary) void openProject(path);
							}}
						>
							<span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
								{folderName(path)}
							</span>
							{path === primary && <Icon name="check" className="text-salmon-text" />}
						</DropdownMenuItem>
					))}
					{/* Always listed, ticked when it is the state: an option that
					    vanishes once chosen leaves nothing to show it was chosen. */}
					<DropdownMenuItem
						onSelect={() => {
							if (primary !== undefined) void closeProject();
						}}
					>
						<span className="min-w-0 flex-1">No project folder</span>
						{primary === undefined && <Icon name="check" className="text-salmon-text" />}
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem onSelect={() => void pickProject()}>Open folder…</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			{extra.map((path) => (
				<span key={path} className={CHIP} title={path}>
					<Icon name="folder" className="text-faint" />
					{folderName(path)}
				</span>
			))}
			<button
				type="button"
				title="Add another project folder"
				className="flex size-7 items-center justify-center rounded-lg border bg-card text-faint transition-colors hover:border-border-strong hover:text-foreground"
				onClick={() => {
					void addFolder();
					bump();
				}}
			>
				<Icon name="folderAdd" />
			</button>
		</div>
	);
}
