import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { closeProject, openProject, pickProject, toast } from "../state/app.ts";
import { useApp } from "../state/useApp.ts";
import {
	DropdownMenuCheckboxItem,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
} from "./ui/dropdown-menu.tsx";

/**
 * What the working directory offers: the few things a reader wants to do with
 * the folder they are in, and the ways out of it.
 *
 * Only the folder in hand: no list of recent folders, which turned a short
 * menu into a scrolling one whose useful items moved every time a different
 * project was opened, and no "No project folder" row, since leaving the folder
 * behind is not something a reader reaches for from here.
 *
 * One list, shown from both places the project is named (the chip above an
 * empty composer and the pill in the titlebar), so the answer to "can I change
 * this?" is the same wherever the reader asks it.
 */

/** Last path segment, which is how a folder is recognised at a glance. */
export function folderName(path: string): string {
	const parts = path.split(/[\\/]/).filter(Boolean);
	return parts.at(-1) ?? path;
}

/** The file manager's name, since "Show in Explorer" is wrong on a Mac. */
const REVEAL_LABEL = navigator.userAgent.includes("Mac OS X")
	? "Show in Finder"
	: navigator.userAgent.includes("Windows")
		? "Show in Explorer"
		: "Show in file manager";

/** The host a remote URL points at, or undefined when it is not a URL. */
function hostOf(url: string | undefined): string | undefined {
	if (url === undefined) return undefined;
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return undefined;
	}
}

async function reveal(target: string, how: string, failure: string): Promise<void> {
	const result = await api.reveal(target, how);
	if (!result.ok) toast(result.error ?? failure, "error");
}

/**
 * The folder switcher: leave the folder, pick a recent one, or browse.
 *
 * Shown from the chip above an empty composer, where the question a reader is
 * asking is "which project is this chat in?" rather than "what can I do with
 * this folder?" — that second list is `ProjectMenuItems` above.
 */
export function RecentProjectsMenuItems(): React.ReactElement {
	const state = useApp();
	const current = state.appInfo.hasProject ? state.appInfo.cwd : undefined;
	// Ten at most: past that the menu scrolls and stops being scannable.
	const recent = state.recentProjects.slice(0, 10);

	return (
		<>
			<DropdownMenuItem disabled={current === undefined} onSelect={() => void closeProject()}>
				No folder
			</DropdownMenuItem>
			{recent.length > 0 && (
				<>
					<DropdownMenuSeparator />
					<DropdownMenuLabel>Recent</DropdownMenuLabel>
					{recent.map((path) => (
						<DropdownMenuCheckboxItem
							key={path}
							checked={path === current}
							title={path}
							onSelect={() => {
								if (path !== current) void openProject(path);
							}}
						>
							<span className="truncate">{folderName(path)}</span>
						</DropdownMenuCheckboxItem>
					))}
				</>
			)}
			<DropdownMenuSeparator />
			<DropdownMenuItem onSelect={() => void pickProject()}>Open folder...</DropdownMenuItem>
		</>
	);
}

export function ProjectMenuItems(): React.ReactElement {
	const state = useApp();
	const current = state.appInfo.hasProject ? state.appInfo.cwd : undefined;
	// Asked for while the menu is opening rather than held in app state: the
	// remote changes about once in a folder's life, and a menu that names the
	// host it will open beats one offering a repository that is not there.
	const [repo, setRepo] = useState<string | undefined>(undefined);
	useEffect(() => {
		if (current === undefined) return;
		let live = true;
		void api.repoUrl(current).then((url) => {
			if (live) setRepo(url);
		});
		return () => {
			live = false;
		};
	}, [current]);
	const repoHost = hostOf(repo);

	return (
		<>
			{current !== undefined && (
				<>
					<DropdownMenuItem
						onSelect={() => void reveal(current, "folder", "That folder could not be opened.")}
					>
						{REVEAL_LABEL}
					</DropdownMenuItem>
					<DropdownMenuItem
						onSelect={() => {
							void api.copyText(current).then((result) => {
								if (result.ok) toast("Path copied.");
								else toast(result.error ?? "Could not copy that.", "error");
							});
						}}
					>
						Copy path
					</DropdownMenuItem>
				</>
			)}
			<DropdownMenuItem onSelect={() => void pickProject()}>Change directory</DropdownMenuItem>
			{current !== undefined && (
				<>
					{repoHost !== undefined && (
						<DropdownMenuItem
							onSelect={() => void reveal(current, "repo", "That repository could not be opened.")}
						>
							Open repository on {repoHost === "github.com" ? "GitHub" : repoHost}
						</DropdownMenuItem>
					)}
					<DropdownMenuSeparator />
					<DropdownMenuItem
						onSelect={() => void reveal(current, "terminal", "No terminal could be opened here.")}
					>
						Open in terminal
					</DropdownMenuItem>
				</>
			)}
		</>
	);
}
