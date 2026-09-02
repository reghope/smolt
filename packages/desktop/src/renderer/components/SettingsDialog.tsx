import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import { cn } from "../lib/cn.ts";
import {
	afterWorktreeChange,
	app,
	applySerif,
	applyTheme,
	bump,
	call,
	checkForUpdate,
	chooseModel,
	clearLocalAppData,
	compactNow,
	ensureModels,
	ensureThinkingLevels,
	installUpdate,
	refreshState,
	setSidebarShowAll,
	requestConfirm,
	requestInput,
	setDefaultThinking,
	toast,
	type ThemeChoice,
	type WorktreeInfo,
} from "../state/app.ts";
import { AUTO_THINKING_ENTRY, thinkingLabel } from "../thinking.ts";
import { useApp } from "../state/useApp.ts";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog.tsx";
import { Icon } from "./ui/icon.tsx";
import { Input } from "./ui/input.tsx";
import { Switch } from "./ui/switch.tsx";

const SECTIONS = [
	{ id: "general", label: "General", group: "Session", icon: "settings" },
	{ id: "model", label: "Model", group: "Session", icon: "model" },
	{ id: "extensions", label: "Extensions", group: "App", icon: "extension" },
	{ id: "appearance", label: "Appearance", group: "App", icon: "appearance" },
	{ id: "about", label: "About", group: "App", icon: "info" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

/**
 * One setting: what it is on the left, the control that changes it on the
 * right, a rule underneath. Every row in this dialog is this shape, which is
 * what makes a long list of unrelated switches read as one page.
 */
function Row({
	label,
	hint,
	children,
}: {
	label: string;
	hint?: string;
	/** A row with no control is a plain statement, so children are optional. */
	children?: React.ReactNode;
}) {
	return (
		<div className="flex items-center justify-between gap-8 border-b border-border/50 py-4 last:border-b-0">
			<div className="flex min-w-0 flex-col gap-1">
				<span className="text-sm leading-snug">{label}</span>
				{hint !== undefined && <span className="text-xs leading-relaxed text-faint">{hint}</span>}
			</div>
			<div className="flex flex-none items-center justify-end gap-1.5">{children}</div>
		</div>
	);
}

/** A row whose control is too wide to sit beside its label, so it sits under it. */
function Block({
	label,
	hint,
	children,
}: {
	label: string;
	hint?: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex flex-col gap-3 border-b border-border/50 py-4 last:border-b-0">
			<div className="flex min-w-0 flex-col gap-1">
				<span className="text-sm leading-snug">{label}</span>
				{hint !== undefined && <span className="text-xs leading-relaxed text-faint">{hint}</span>}
			</div>
			{children}
		</div>
	);
}

/**
 * Updates, and a way to ask for one now.
 *
 * The app looks on its own every few hours, which is right for something
 * nobody wants to think about, but leaves no answer for the moment
 * somebody does. This says where things stand and checks on request.
 */
function UpdateSection() {
	const state = useApp();
	const update = state.update;
	const version = "version" in update ? update.version : "";
	// Every feed version says "release", so the two version numbers on this
	// screen can never be mistaken for each other: one is what this app is,
	// the other is what npm is serving.
	const status =
		state.updateChecking || update.status === "checking"
			? "Checking…"
			: update.status === "downloading"
				? `Fetching release v${version}${update.percent > 0 ? ` (${update.percent}%)` : "…"}`
				: update.status === "ready"
					? `Release v${version} is ready`
					: update.status === "installing"
						? `Updating to release v${version}, restarting`
						: update.status === "available"
							? `Release v${version} is available`
							: update.status === "error"
								? update.message
								: !state.appInfo.packaged
									? `Workspace build v${state.appInfo.version} (updates apply to the installed app)`
									: state.updateChecked
										? `You are on the latest release (v${state.appInfo.version})`
										: `This app is release v${state.appInfo.version}`;
	return (
		<Row label="Updates" hint={status}>
			{update.status === "ready" ? (
				<Button size="sm" onClick={() => void installUpdate()}>
					Relaunch to update
				</Button>
			) : (
				<Button
					variant="outline"
					size="sm"
					disabled={
						!state.appInfo.packaged ||
						state.updateChecking ||
						update.status === "downloading" ||
						update.status === "installing"
					}
					onClick={() => void checkForUpdate()}
				>
					Check for updates
				</Button>
			)}
		</Row>
	);
}

interface ExtensionInfo {
	id: string;
	/** "built-in", the path it loaded from, or empty when it never loaded. */
	source: string;
	/** One line saying what it does; empty when the extension supplies none. */
	description?: string;
	builtIn: boolean;
	enabled: boolean;
}

/**
 * What an extension is, in the space of one line. What it does beats where it
 * came from: "Built in" tells the reader nothing they cannot already see.
 */
function extensionHint(extension: ExtensionInfo): string {
	if (extension.description !== undefined && extension.description !== "") return extension.description;
	if (extension.builtIn) return "Built in";
	if (extension.source === "") return "Switched off, so it never loaded";
	return extension.source;
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
		return <Row label="Worktrees" hint="This folder is not a git repository, so sessions cannot be isolated." />;
	}
	return (
		<Block
			label="Worktrees"
			hint={
				info.isolated
					? "This session is running in its own worktree; the repository is untouched."
					: "The agent is working directly in the repository."
			}
		>
			{(info.worktrees ?? []).length > 0 && (
				<div className="flex flex-col gap-0.5">
					{(info.worktrees ?? []).map((worktree) => (
						<div key={worktree.path} className="flex items-center gap-1">
							<button
								type="button"
								className={cn(
									"flex h-8 min-w-0 flex-1 items-center justify-between gap-2 rounded-lg px-3 text-sm transition-colors hover:bg-accent",
									worktree.path === info.activeCwd && "bg-accent",
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
				</div>
			)}
			<div className="flex flex-wrap gap-2">
				<Button
					variant="outline"
					size="sm"
					onClick={async () => {
						const label = await requestInput({
							title: "Isolate in a new worktree",
							message: "Name for the isolated worktree and its branch",
							initial: app.sessionName || "session",
						});
						if (label === null) return;
						const result = await api.worktreeCreate(label);
						if (!result.ok) {
							toast(result.error ?? "Could not create the worktree", "error");
							return;
						}
						await afterWorktreeChange();
						await reload();
					}}
				>
					Isolate in a new worktree
				</Button>
				{info.isolated && (
					<Button
						variant="outline"
						size="sm"
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
		</Block>
	);
}

export function SettingsDialog() {
	const state = useApp();
	const [section, setSection] = useState<SectionId>("general");
	const [query, setQuery] = useState("");
	const [modelFilter, setModelFilter] = useState("");
	const [extensions, setExtensions] = useState<ExtensionInfo[]>([]);
	const [name, setName] = useState(state.sessionName);
	const activeModelRef = useRef<HTMLButtonElement | null>(null);

	useEffect(() => {
		if (!state.settingsOpen) return;
		setName(app.sessionName);
		setQuery("");
		void ensureModels();
		void ensureThinkingLevels();
		void call<{ extensions: ExtensionInfo[] }>("listExtensions").then((result) => {
			if (result) setExtensions(result.extensions);
		});
	}, [state.settingsOpen]);

	// The list opens where the reader can see their answer: the running model
	// scrolls into view instead of sitting off-screen below the fold.
	useEffect(() => {
		if (!state.settingsOpen || section !== "model") return;
		activeModelRef.current?.scrollIntoView({ block: "nearest" });
	}, [state.settingsOpen, section, state.availableModels.length]);

	const searching = query.trim() !== "";
	const show = (id: SectionId): boolean => searching || section === id;

	const filteredModels = state.availableModels.filter(
		(option) =>
			modelFilter.trim() === "" ||
			option.id.toLowerCase().includes(modelFilter.trim().toLowerCase()) ||
			option.provider.toLowerCase().includes(modelFilter.trim().toLowerCase()),
	);

	const modelKey = (option: { provider: string; id: string }): string => `${option.provider}/${option.id}`;
	// The ten most-picked models lead the list. With a filter typed the reader
	// is looking for something specific, so the search beats habit and the list
	// goes back to being one flat set of matches.
	const frequentModels =
		modelFilter.trim() === ""
			? [...state.availableModels]
					.filter((option) => (state.modelUse[modelKey(option)] ?? 0) > 0)
					.sort((a, b) => (state.modelUse[modelKey(b)] ?? 0) - (state.modelUse[modelKey(a)] ?? 0))
					.slice(0, 10)
			: [];
	const frequentKeys = new Set(frequentModels.map(modelKey));
	const otherModels = filteredModels.filter((option) => !frequentKeys.has(modelKey(option)));

	const renderModel = (option: (typeof state.availableModels)[number]) => (
		<button
			type="button"
			key={modelKey(option)}
			ref={modelKey(option) === state.model ? activeModelRef : undefined}
			className={cn(
				"flex h-9 flex-none items-baseline justify-between gap-2.5 rounded-lg px-3 text-left text-sm transition-colors hover:bg-accent",
				modelKey(option) === state.model && "bg-accent font-medium",
			)}
			onClick={() => void chooseModel(option.provider, option.id)}
		>
			<span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{option.id}</span>
			<em className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-right text-xs not-italic text-faint">
				{option.provider}
			</em>
		</button>
	);

	return (
		<Dialog
			open={state.settingsOpen}
			onOpenChange={(open) => {
				app.settingsOpen = open;
				bump();
			}}
		>
			<DialogContent className="flex h-[680px] max-h-[88vh] w-[960px] max-w-[94vw] flex-row gap-0 overflow-hidden rounded-2xl p-0">
				<div className="flex w-[236px] min-w-[236px] flex-col gap-1 overflow-y-auto border-r bg-background-deep p-3 [background:var(--background-deep)]">
					<div className="relative mb-1">
						<Icon name="search" className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint" />
						<Input
							type="search"
							className="pl-8"
							placeholder="Search"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
						/>
					</div>
					{!searching && (
						<nav className="flex flex-col gap-px">
							{SECTIONS.map((entry, index) => (
								<div key={entry.id} className="contents">
									{(index === 0 || SECTIONS[index - 1]!.group !== entry.group) && (
										<span className="px-2.5 pt-4 pb-1.5 text-xs font-medium text-faint first:pt-1">{entry.group}</span>
									)}
									<button
										type="button"
										className={cn(
											"flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
											section === entry.id && "bg-accent font-medium text-foreground",
										)}
										onClick={() => setSection(entry.id)}
									>
										<Icon name={entry.icon} className="text-faint" />
										{entry.label}
									</button>
								</div>
							))}
						</nav>
					)}
				</div>
				<div className="flex min-w-0 flex-1 flex-col overflow-y-auto px-8 py-7">
					<DialogTitle className="mb-2 text-lg leading-none font-semibold">
						{searching ? "Search" : (SECTIONS.find((s) => s.id === section)?.label ?? "Settings")}
					</DialogTitle>
					<div className="flex flex-col">
						{show("general") && (
							<>
								{matches(query, "session name title") && (
									<Row label="Session name" hint="What this chat is called in the sidebar">
										<Input
											className="w-64"
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
									</Row>
								)}
								{matches(query, "auto-compaction context compact") && (
									<Row label="Auto-compaction" hint="Compact context automatically as it fills">
										<Switch
											checked={state.autoCompaction}
											onCheckedChange={async (next) => {
												app.autoCompaction = next;
												bump();
												await call("setAutoCompaction", next);
											}}
										/>
									</Row>
								)}
								{matches(query, "auto-retry errors provider") && (
									<Row label="Auto-retry" hint="Retry transient provider errors without asking">
										<Switch
											checked={state.autoRetry}
											onCheckedChange={async (next) => {
												app.autoRetry = next;
												bump();
												await call("setAutoRetry", next);
											}}
										/>
									</Row>
								)}
								{matches(query, "queued messages steering delivery") && (
									<Row label="Deliver all queued messages" hint="Otherwise messages are delivered one at a time">
										<Switch
											checked={state.deliverAllQueued}
											onCheckedChange={async (next) => {
												app.deliverAllQueued = next;
												bump();
												const mode = next ? "all" : "one-at-a-time";
												await call("setSteeringMode", mode);
												await call("setFollowUpMode", mode);
											}}
										/>
									</Row>
								)}
								{matches(query, "worktree isolation git branch") && <WorktreeSection />}
								{matches(query, "compact export html session") && (
									<Row label="This session" hint="Shrink the context now, or save a copy of the transcript">
										<Button
											variant="outline"
											size="sm"
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
											size="sm"
											onClick={async () => {
												const result = await call<{ path: string }>("exportHtml");
												if (result) {
													void api.reveal(result.path, "reveal");
													toast(`Session exported to ${result.path}`);
												}
											}}
										>
											Export HTML
										</Button>
									</Row>
								)}
								{matches(query, "wipe erase delete reset local data privacy history") && (
									<Row
										label="Delete all local data"
										hint="Every chat, the memory and skills the agent wrote, your cues, and the tool telemetry. Credentials and preferences are kept."
									>
										<Button
											variant="destructive"
											size="sm"
											onClick={async () => {
												const sure = await requestConfirm({
													title: "Delete all local data?",
													message:
														"Every chat, the memory the agent curates, the skills it wrote, your cues, and the " +
														"session index and tool telemetry will be permanently deleted from this machine. " +
														"Provider credentials and your preferences are kept. This can't be undone.",
													actionLabel: "Delete everything",
													destructive: true,
												});
												if (!sure) return;
												const result = await api.wipeLocalData();
												if (!result.ok) {
													toast(result.error ?? "Could not delete everything", "error");
													return;
												}
												// The window's own memory of what you did is the last of it.
												clearLocalAppData();
												app.settingsOpen = false;
												bump();
												toast("Local data deleted.");
												await refreshState();
											}}
										>
											Delete everything…
										</Button>
									</Row>
								)}
							</>
						)}
						{show("model") && (
							<>
								{matches(query, "model provider") && (
									<Block label="Available models" hint="What answers in this chat">
										<Input
											type="search"
											placeholder="Filter models…"
											value={modelFilter}
											onChange={(event) => setModelFilter(event.target.value)}
										/>
										<div className="flex max-h-72 flex-col gap-px overflow-y-auto">
											{state.availableModels.length === 0 ? (
												<div className="flex flex-col items-start gap-2 py-2">
													<p className="text-sm leading-relaxed text-muted-foreground">
														No models yet. Add a provider's API key and smolt will pick its models up.
													</p>
													<Button
														size="sm"
														onClick={() => {
															app.providerDialogOpen = true;
															bump();
														}}
													>
														Add a provider
													</Button>
												</div>
											) : filteredModels.length === 0 ? (
												<p className="px-2 py-2 text-sm text-faint">No model matches “{modelFilter.trim()}”.</p>
											) : (
												<>
													{frequentModels.length > 0 && (
														<>
															<span className="px-3 pt-1 pb-1.5 text-xs text-faint">Frequently used</span>
															{frequentModels.map(renderModel)}
															{otherModels.length > 0 && (
																<span className="px-3 pt-3 pb-1.5 text-xs text-faint">All models</span>
															)}
														</>
													)}
													{otherModels.map(renderModel)}
												</>
											)}
										</div>
										{/* The provider flow must stay reachable after the first key
										    exists — pool credentials and new providers are added here. */}
										{state.availableModels.length > 0 && (
											<Button
												variant="outline"
												size="sm"
												className="self-start"
												onClick={() => {
													app.providerDialogOpen = true;
													bump();
												}}
											>
												Add provider
											</Button>
										)}
									</Block>
								)}
								{matches(query, "effort thinking reasoning") && (
									<Row label="Default effort" hint="Where new chats start. The composer changes this chat only.">
										{state.availableThinking.map((level) => (
											<Button
												key={level}
												variant="outline"
												size="sm"
												className={cn(
													level !== AUTO_THINKING_ENTRY && "capitalize",
													level === state.defaultThinking && "bg-accent font-medium text-foreground",
												)}
												onClick={() => setDefaultThinking(level)}
											>
												{thinkingLabel(level)}
											</Button>
										))}
									</Row>
								)}
							</>
						)}
						{show("extensions") && (
							<>
								{matches(query, "extensions enable disable turn off plugins") && (
									<>
										{extensions.length === 0 ? (
											<Row label="No extensions found" hint="Nothing is installed for this agent yet." />
										) : (
											extensions.map((extension) => (
												<Row key={extension.id} label={extension.id} hint={extensionHint(extension)}>
													<Switch
														checked={extension.enabled}
														onCheckedChange={async (next) => {
															setExtensions((current) =>
																current.map((entry) => (entry.id === extension.id ? { ...entry, enabled: next } : entry)),
															);
															await call("setExtensionEnabled", extension.id, next);
														}}
													/>
												</Row>
											))
										)}
										<p className="pt-4 text-xs leading-relaxed text-faint">
											Extensions load when a chat starts, so switching one takes effect in your next chat.
										</p>
									</>
								)}
							</>
						)}
						{show("appearance") && (
							<>
								{matches(query, "theme appearance light dark") && (
									<Row label="Theme" hint="System follows what your operating system reports.">
										<div className="flex gap-0.5 rounded-lg bg-background-deep p-0.5 [background:var(--background-deep)]">
											{(["system", "light", "dark"] as ThemeChoice[]).map((choice) => (
												<Button
													key={choice}
													variant="ghost"
													size="sm"
													className={cn("capitalize", state.themeChoice === choice && "bg-card text-foreground")}
													onClick={() => applyTheme(choice)}
												>
													{choice}
												</Button>
											))}
										</div>
									</Row>
								)}
								{matches(query, "serif prose font reading") && (
									<Row label="Serif responses" hint="Set smolt's prose in a serif face">
										<Switch checked={state.serif} onCheckedChange={(next) => applySerif(next)} />
									</Row>
								)}
								{matches(query, "sidebar chats history day collapse") && (
									<Row label="Show every chat per day" hint="Sidebar days list all their chats instead of the latest 5">
										<Switch checked={state.sidebarShowAll} onCheckedChange={(next) => setSidebarShowAll(next)} />
									</Row>
								)}
							</>
						)}
						{show("about") && (
							<>
								{matches(query, "version directory about") && (
									<>
										<Row label="Version">
											<span className="font-mono text-xs text-faint">
												smolt {state.appInfo.version}
												{!state.appInfo.packaged && " (workspace build)"}
											</span>
										</Row>
										<Row label="Working directory">
											<span
												className="max-w-80 overflow-hidden text-ellipsis whitespace-nowrap text-left font-mono text-xs text-faint [direction:rtl]"
												title={state.appInfo.cwd}
											>
												{state.appInfo.cwd}
											</span>
										</Row>
									</>
								)}
								{matches(query, "update version check upgrade release") && <UpdateSection />}
								{matches(query, "shortcuts keyboard help") && (
									<Row label="Keyboard shortcuts" hint="Every key this app listens for">
										<Button
											variant="outline"
											size="sm"
											onClick={() => {
												app.settingsOpen = false;
												app.shortcutsOpen = true;
												bump();
											}}
										>
											View shortcuts
										</Button>
									</Row>
								)}
							</>
						)}
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
