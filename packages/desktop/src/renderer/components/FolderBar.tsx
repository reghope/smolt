import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { cn } from "../lib/cn.ts";
import { addFolder, afterWorktreeChange, bump, refreshRecentProjects, toast } from "../state/app.ts";
import { useApp } from "../state/useApp.ts";
import { folderName, RecentProjectsMenuItems } from "./ProjectMenu.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "./ui/dropdown-menu.tsx";
import { Icon } from "./ui/icon.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";
import { Tip } from "./ui/tooltip.tsx";

/**
 * The folders a new chat will work in, offered before it starts.
 *
 * The first chip is the working directory and carries the switcher; the rest
 * are folders the agent has merely been told about. It shows only on an empty
 * chat because that is the moment the choice still matters — once a turn has
 * run, moving the ground under it would be worse than leaving it be.
 */

const CHIP =
	"flex h-7 items-center gap-1.5 rounded-lg border bg-card px-2.5 text-xs text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground";

/**
 * The branch a new chat will work on. The chip names the checked-out branch;
 * the panel lists every local branch with a search field, and picking one
 * checks it out before the first message is written. Not a repo, nothing
 * shows and the chat simply runs in the folder as it is.
 */
/**
 * Last fetched branch list per folder, so the chip renders on the first paint
 * instead of popping in after the IPC round-trip. Refreshed in the background
 * on every mount, and only a confirmed non-repo hides the chip.
 */
const cache: { folder: string | undefined; current: string; branches: string[] } = {
	folder: undefined,
	current: "",
	branches: [],
};

function BranchPicker() {
	const state = useApp();
	const folder = state.folders[0];
	const [current, setCurrent] = useState(cache.folder === folder ? cache.current : "");
	const [branches, setBranches] = useState<string[]>(cache.folder === folder ? cache.branches : []);
	const [loaded, setLoaded] = useState(cache.folder === folder);
	const [query, setQuery] = useState("");
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);

	const reload = async (): Promise<void> => {
		const result = await api.branches();
		const value = (result.value ?? null) as { current: string; branches: string[] } | null;
		if (value) {
			cache.folder = folder;
			cache.current = value.current;
			cache.branches = value.branches;
			setCurrent(value.current);
			setBranches(value.branches);
		}
		setLoaded(true);
	};
	useEffect(() => {
		void reload();
	}, [folder]);

	if (!loaded || branches.length === 0) return null;
	const shown = branches.filter((branch) => branch.toLowerCase().includes(query.toLowerCase()));
	const pick = async (branch: string): Promise<void> => {
		if (busy || branch === current) {
			setOpen(false);
			return;
		}
		setBusy(true);
		const result = await api.branchCheckout(branch);
		setBusy(false);
		if (!result.ok) {
			toast(result.error ?? `Could not check out ${branch}`, "error");
			return;
		}
		setOpen(false);
		setQuery("");
		// The agent restarts on the new branch, so the chat around it reloads.
		await afterWorktreeChange();
		await reload();
	};

	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) setQuery("");
			}}
		>
			<PopoverTrigger asChild>
				<button
					type="button"
					aria-label="Choose branch for new chats"
					className={cn(CHIP, "max-w-[220px] font-mono")}
				>
					<Icon name="branch" className="flex-none text-faint" />
					<span className="min-w-0 truncate">{current || "detached"}</span>
				</button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-64 p-1.5">
				<div className="max-h-60 overflow-y-auto">
					{shown.map((branch) => (
						<button
							key={branch}
							type="button"
							disabled={busy}
							className={cn(
								"flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
								busy && "opacity-50",
							)}
							onClick={() => void pick(branch)}
						>
							<span className="min-w-0 flex-1 truncate">{branch}</span>
							{branch === current && <Icon name="check" className="flex-none text-tint-text" />}
						</button>
					))}
					{shown.length === 0 && <p className="px-2.5 py-2 text-xs text-faint">No branch matches.</p>}
				</div>
				<div className="mt-1.5 flex items-center gap-1.5 rounded-lg border px-2 py-1.5">
					<span className="flex-none font-mono text-xs text-faint">/</span>
					<input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="Search branches…"
						aria-label="Search branches"
						className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-faint"
					/>
				</div>
			</PopoverContent>
		</Popover>
	);
}

export function FolderBar() {
	const state = useApp();
	const [primary, ...extra] = state.folders;

	return (
		<div className="mb-2 flex flex-wrap items-center gap-1.5">
			<DropdownMenu
				onOpenChange={(open) => {
					if (open) void refreshRecentProjects();
				}}
			>
				<DropdownMenuTrigger asChild>
					<Tip label={primary ?? "Choose a folder to work in"}>
						<button type="button" className={CHIP}>
							<Icon name="folder" className="text-faint" />
							{primary ? folderName(primary) : "No project folder"}
						</button>
					</Tip>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" className="min-w-56">
					<RecentProjectsMenuItems />
				</DropdownMenuContent>
			</DropdownMenu>
			<BranchPicker />
			{extra.map((path) => (
				<Tip key={path} label={path}>
					<span className={CHIP}>
						<Icon name="folder" className="text-faint" />
						{folderName(path)}
					</span>
				</Tip>
			))}
			<Tip label="Add another project folder">
				<button
					type="button"
					aria-label="Add another project folder"
					className="flex size-7 items-center justify-center rounded-lg border bg-card text-faint transition-colors hover:border-border-strong hover:text-foreground"
					onClick={() => {
						void addFolder();
						bump();
					}}
				>
					<Icon name="folderAdd" />
				</button>
			</Tip>
		</div>
	);
}
