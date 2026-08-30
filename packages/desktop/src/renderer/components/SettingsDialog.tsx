import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { cn } from "../lib/cn.ts";
import {
	afterWorktreeChange,
	app,
	applySerif,
	applyTheme,
	bump,
	call,
	chooseModel,
	chooseThinking,
	compactNow,
	ensureModels,
	ensureThinkingLevels,
	refreshState,
	requestConfirm,
	toast,
	type ThemeChoice,
	type WorktreeInfo,
} from "../state/app.ts";
import { useApp } from "../state/useApp.ts";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog.tsx";
import { Icon } from "./ui/icon.tsx";
import { Input } from "./ui/input.tsx";
import { Switch } from "./ui/switch.tsx";

const SECTIONS = [
	{ id: "general", label: "General", group: "Session" },
	{ id: "model", label: "Model", group: "Session" },
	{ id: "appearance", label: "Appearance", group: "App" },
	{ id: "about", label: "About", group: "App" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

function FieldLabel({ children }: { children: React.ReactNode }) {
	return <span className="text-xs font-medium tracking-wide text-faint uppercase">{children}</span>;
}

function ToggleRow({
	label,
	hint,
	checked,
	onChange,
}: {
	label: string;
	hint: string;
	checked: boolean;
	onChange: (next: boolean) => void;
}) {
	return (
		<label className="flex cursor-pointer items-start justify-between gap-3">
			<span className="flex flex-col gap-0.5 text-sm">
			{label}
				<em className="text-xs not-italic text-faint">{hint}</em>
			</span>
			<Switch checked={checked} onCheckedChange={onChange} />
		</label>
	);
}

/** Search matches a row's label text plus hidden keywords, as before. */
function matches(query: string, haystack: string): boolean {
	return query === "" || haystack.toLowerCase().includes(query.toLowerCase());
}

function WorktreeSection() {
	const state = useApp();
	const [info, setInfo] = useState<WorktreeInfo | null>(null);
	const reload = async (): Promise<void> => {
		const result = await api.worktrees();
		setInfo(result.ok ? ((result.value ?? null) as WorktreeInfo | null) : null);
	};
	useEffect(() => {
		void reload();
	}, []);

	if (!info?.isRepo) {
		return (
			<div className="flex flex-col gap-2">
				<FieldLabel>Worktrees</FieldLabel>
				<div className="text-xs leading-normal text-faint">
					This folder is not a git repository, so sessions cannot be isolated.
				</div>
			</div>
		);
	}
	return (
		<div className="flex flex-col gap-2">
			<FieldLabel>Worktrees</FieldLabel>
			<div className="text-xs leading-normal text-faint">
				{info.isolated
					? "This session is running in its own worktree; the repository is untouched."
					: "The agent is working directly in the repository."}
			</div>
			{(info.worktrees ?? []).map((worktree) => (
				<div key={worktree.path} className="flex items-center gap-1">
					<button
						type="button"
						className={cn(
							"flex h-8 min-w-0 flex-1 items-center justify-between gap-2 rounded-lg px-3 text-sm transition-colors hover:bg-accent",
							worktree.path === info.activeCwd && "bg-primary/10",
						)}
						onClick={async () => {
							const result = await api.worktreeEnter(worktree.path);
							if (!result.ok) {
								toast(result.error ?? "Could not switch worktree", "error");
								return;
							}
							await afterWorktreeChange();
							await reload();
						}}
					>
						<span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{worktree.name}</span>
						<em className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-xs not-italic text-faint">
							{worktree.branch}
						</em>
					</button>
					<Button
						variant="ghost"
						size="icon"
						className="size-7"
						title="Remove this worktree"
						onClick={async () => {
							const sure = await requestConfirm({
								title: "Remove worktree?",
								message: `The worktree at ${worktree.path} will be removed. Its branch is kept.`,
								actionLabel: "Remove",
								destructive: true,
							});
							if (!sure) return;
							let result = await api.worktreeRemove(worktree.path);
							if (!result.ok && /uncommitted/i.test(result.error ?? "")) {
								const discard = await requestConfirm({
									title: "Discard changes?",
									message: `${result.error} Discard those changes and remove it anyway?`,
									actionLabel: "Discard and remove",
									destructive: true,
								});
								if (!discard) return;
								result = await api.worktreeRemove(worktree.path, true);
							}
							if (!result.ok) toast(result.error ?? "Could not remove the worktree", "error");
							await afterWorktreeChange();
							await reload();
						}}
					>
						<Icon name="trash" />
					</Button>
				</div>
			))}
			<div className="flex gap-2">
				<Button
					variant="outline"
					onClick={async () => {
						const label = window.prompt("Name for the isolated worktree and its branch", app.sessionName || "session");
						if (label === null) return;
						const result = await api.worktreeCreate(label);
						if (!result.ok) {
							toast(result.error ?? "Could not create the worktree", "error");
							return;
						}
						const worktree = result.value as { branch: string };
						await afterWorktreeChange();
						await reload();
					}}
				>
					Isolate in a new worktree
				</Button>
				{info.isolated && (
					<Button
						variant="outline"
						onClick={async () => {
							const result = await api.worktreeEnter("");
							if (!result.ok) {
								toast(result.error ?? "Could not return to the repository", "error");
								return;
							}
							await afterWorktreeChange();
							await reload();
						}}
					>
						Return to the repository
					</Button>
				)}
			</div>
		</div>
	);
}

export function SettingsDialog() {
	const state = useApp();
	const [section, setSection] = useState<SectionId>("general");
	const [query, setQuery] = useState("");
	const [modelFilter, setModelFilter] = useState("");
	const [name, setName] = useState(state.sessionName);

	useEffect(() => {
		if (!state.settingsOpen) return;
		setName(app.sessionName);
		setQuery("");
		void ensureModels();
		void ensureThinkingLevels();
	}, [state.settingsOpen]);

	const searching = query.trim() !== "";
	const show = (id: SectionId): boolean => searching || section === id;

	const filteredModels = state.availableModels.filter(
		(option) =>
			modelFilter.trim() === "" ||
			option.id.toLowerCase().includes(modelFilter.trim().toLowerCase()) ||
			option.provider.toLowerCase().includes(modelFilter.trim().toLowerCase()),
	);

	return (
		<Dialog
			open={state.settingsOpen}
			onOpenChange={(open) => {
				app.settingsOpen = open;
				bump();
			}}
		>
			<DialogContent className="flex h-[565px] max-h-[85vh] w-[750px] max-w-[92vw] flex-row gap-0 overflow-hidden p-0">
				<div className="flex w-48 min-w-48 flex-col gap-2.5 overflow-y-auto border-r bg-background-deep p-3.5 [background:var(--background-deep)]">
					<Input
						type="search"
						placeholder="Search settings…"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
					/>
					{!searching && (
						<nav className="flex flex-col gap-px">
							{SECTIONS.map((entry, index) => (
								<div key={entry.id} className="contents">
									{(index === 0 || SECTIONS[index - 1]!.group !== entry.group) && (
										<span className="px-2 pt-3 pb-1 text-xs tracking-wide text-faint uppercase first:pt-0.5">
											{entry.group}
										</span>
									)}
									<button
										type="button"
										className={cn(
											"h-8 rounded-lg px-3 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
											section === entry.id && "bg-primary/10 text-foreground",
										)}
										onClick={() => setSection(entry.id)}
									>
										{entry.label}
									</button>
								</div>
							))}
						</nav>
					)}
				</div>
				<div className="flex min-w-0 flex-1 flex-col">
					<div className="flex items-center justify-between border-b px-4.5 py-4">
						<DialogTitle>{searching ? "Search" : (SECTIONS.find((s) => s.id === section)?.label ?? "Settings")}</DialogTitle>
					</div>
					<div className="flex flex-1 flex-col gap-4.5 overflow-y-auto px-4.5 py-4">
						{show("general") && (
							<>
								{matches(query, "session name title") && (
									<label className="flex flex-col gap-1.5">
										<FieldLabel>Session name</FieldLabel>
										<Input
											value={name}
											placeholder="Untitled session"
											onChange={(event) => setName(event.target.value)}
											onBlur={async () => {
												const value = name.trim();
												if (value === "" || value === app.sessionName) return;
												await call("setSessionName", value);
												app.sessionName = value;
												await refreshState();
											}}
										/>
									</label>
								)}
								{matches(query, "auto-compaction context compact") && (
									<ToggleRow
										label="Auto-compaction"
										hint="Compact context automatically as it fills"
										checked={state.autoCompaction}
										onChange={async (next) => {
											app.autoCompaction = next;
											bump();
											await call("setAutoCompaction", next);
										}}
									/>
								)}
								{matches(query, "auto-retry errors provider") && (
									<ToggleRow
										label="Auto-retry"
										hint="Retry transient provider errors without asking"
										checked={state.autoRetry}
										onChange={async (next) => {
											app.autoRetry = next;
											bump();
											await call("setAutoRetry", next);
										}}
									/>
								)}
								{matches(query, "queued messages steering delivery") && (
									<ToggleRow
										label="Deliver all queued messages"
										hint="Otherwise messages are delivered one at a time"
										checked={state.deliverAllQueued}
										onChange={async (next) => {
											app.deliverAllQueued = next;
											bump();
											const mode = next ? "all" : "one-at-a-time";
											await call("setSteeringMode", mode);
											await call("setFollowUpMode", mode);
										}}
									/>
								)}
								{matches(query, "worktree isolation git branch") && <WorktreeSection />}
								{matches(query, "compact export html session") && (
									<div className="flex flex-col gap-1.5">
										<FieldLabel>This session</FieldLabel>
										<div className="flex gap-2">
											<Button
												variant="outline"
												onClick={() => {
													app.settingsOpen = false;
													bump();
													void compactNow();
												}}
											>
												Compact now
											</Button>
											<Button
												variant="outline"
												onClick={async () => {
													const result = await call<{ path: string }>("exportHtml");
													if (result) void api.reveal(result.path, "reveal");
												}}
											>
												Export HTML
											</Button>
										</div>
									</div>
								)}
							</>
						)}
						{show("model") && (
							<>
								{matches(query, "model provider") && (
									<div className="flex flex-col gap-1.5">
										<FieldLabel>Model</FieldLabel>
										<Input
											type="search"
											placeholder="Filter models…"
											value={modelFilter}
											onChange={(event) => setModelFilter(event.target.value)}
										/>
										<div className="flex max-h-56 flex-col gap-px overflow-y-auto">
											{filteredModels.length === 0 ? (
												<p className="px-2 py-2 text-sm text-faint">No model matches “{modelFilter.trim()}”.</p>
											) : (
												filteredModels.map((option) => (
													<button
														type="button"
														key={`${option.provider}/${option.id}`}
														className={cn(
															"flex h-8 flex-none items-baseline justify-between gap-2.5 rounded-lg px-3 text-left text-sm transition-colors hover:bg-accent",
															`${option.provider}/${option.id}` === state.model && "bg-primary/10",
														)}
														onClick={() => void chooseModel(option.provider, option.id)}
													>
														<span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{option.id}</span>
														<em className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-right text-xs not-italic text-faint">
															{option.provider}
														</em>
													</button>
												))
											)}
										</div>
									</div>
								)}
								{matches(query, "effort thinking reasoning") && (
									<div className="flex flex-col gap-1.5">
										<FieldLabel>Effort</FieldLabel>
										<div className="flex flex-wrap gap-1.5">
											{state.availableThinking.map((level) => (
												<Button
													key={level}
													variant="outline"
													size="sm"
													className={cn("capitalize", level === state.thinking && "bg-primary/10 text-foreground")}
													onClick={() => void chooseThinking(level)}
												>
													{level}
												</Button>
											))}
										</div>
									</div>
								)}
							</>
						)}
						{show("appearance") && (
							<>
								{matches(query, "theme appearance light dark") && (
									<div className="flex flex-col gap-1.5">
										<FieldLabel>Theme</FieldLabel>
										<div className="flex gap-0.5 rounded-lg bg-background-deep p-0.5 [background:var(--background-deep)]">
											{(["system", "light", "dark"] as ThemeChoice[]).map((choice) => (
												<Button
													key={choice}
													variant="ghost"
													size="sm"
													className={cn("flex-1 capitalize", state.themeChoice === choice && "bg-card text-foreground")}
													onClick={() => applyTheme(choice)}
												>
													{choice}
												</Button>
											))}
										</div>
										<div className="text-xs leading-normal text-faint">
											System follows what your operating system reports.
										</div>
									</div>
								)}
								{matches(query, "serif prose font reading") && (
									<ToggleRow
										label="Serif responses"
										hint="Set smolt's prose in a serif face"
										checked={state.serif}
										onChange={(next) => applySerif(next)}
									/>
								)}
							</>
						)}
						{show("about") && (
							<>
								{matches(query, "version directory about") && (
									<div className="flex flex-col gap-1.5">
										<FieldLabel>About</FieldLabel>
										<div className="flex flex-col gap-1 font-mono text-xs text-faint">
											<span
												className="overflow-hidden text-ellipsis whitespace-nowrap text-left [direction:rtl]"
												title={state.appInfo.cwd}
											>
												{state.appInfo.cwd}
											</span>
											<span>
												smolt {state.appInfo.version}
												{state.canTranscribe
													? " · dictation ready"
													: " · dictation needs OPENAI_API_KEY or GROQ_API_KEY"}
											</span>
										</div>
									</div>
								)}
								{matches(query, "shortcuts keyboard help") && (
									<div className="flex flex-col gap-1.5">
										<FieldLabel>Help</FieldLabel>
										<div className="flex gap-2">
											<Button
												variant="outline"
												onClick={() => {
													app.settingsOpen = false;
													app.shortcutsOpen = true;
													bump();
												}}
											>
												Keyboard shortcuts
											</Button>
										</div>
									</div>
								)}
							</>
						)}
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
