import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import { cn } from "../lib/cn.ts";
import { shortTokens } from "../lib/format.ts";
import {
	addImageFiles,
	answerApproval,
	app,
	applyTheme,
	bump,
	bumpDraft,
	call,
	forkSession,
	newSession,
	noteCommandUse,
	renameSession,
	switchToSession,
	toggleSidePane,
	chooseModel,
	chooseThinking,
	abortTurn,
	clearQueued,
	queuedHere,
	sendQueuedNow,
	compactNow,
	ensureCommands,
	pickProject,
	ensureModels,
	ensureThinkingLevels,
	MODE_ITEMS,
	modeLabel,
	projectName,
	promptHistory,
	recentModels,
	removeAttachment,
	send,
	setPermissionMode,
	toast,
	chatDidToolWork,
	toggleDiffPane,
	type ModelOption,
	type SlashCommand,
} from "../state/app.ts";
import { useApp, useDraft } from "../state/useApp.ts";
import { finishVoice, startVoice, toggleVoice } from "../state/voice.ts";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { FolderBar } from "./FolderBar.tsx";
import { Icon } from "./ui/icon.tsx";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";
import { Slider } from "./ui/slider.tsx";
import { Switch } from "./ui/switch.tsx";
/** Number keys pick an entry from an open menu, as in the reference app. */
function pickByNumber(event: React.KeyboardEvent<HTMLElement>): void {
	if (!/^[1-9]$/.test(event.key) || event.ctrlKey || event.metaKey || event.altKey) return;
	const items = event.currentTarget.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-item"]');
	const target = items[Number(event.key) - 1];
	if (target) {
		event.preventDefault();
		target.click();
	}
}

function Chip({
	className,
	active,
	...props
}: React.ComponentProps<"button"> & { active?: boolean }) {
	return (
		<button
			type="button"
			className={cn(
				"h-8 max-w-44 overflow-hidden rounded-lg px-3 text-sm whitespace-nowrap text-ellipsis text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent",
				className,
			)}
			{...props}
		/>
	);
}

/** The model menu: last-used first, then one section per provider. */
function ModelMenu() {
	const state = useApp();
	const current = state.model;

	const rows: React.ReactNode[] = [];
	let position = 0;
	const item = (option: ModelOption, key: string): React.ReactNode => {
		const active = `${option.provider}/${option.id}` === current;
		const hint = position < 9 ? String(position + 1) : "";
		position += 1;
		return (
			<DropdownMenuItem key={key} onSelect={() => void chooseModel(option.provider, option.id)}>
				<span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{option.id}</span>
				{option.reasoning && <Badge>Reasoning</Badge>}
				{active && <Icon name="check" className="text-salmon-text" />}
				{hint && <span className="w-4 text-center font-mono text-xs text-faint">{hint}</span>}
			</DropdownMenuItem>
		);
	};

	// The current model counts as last-used even before anything is stored.
	const recents = [...new Set([...(current ? [current] : []), ...recentModels()])]
		.map((label) => state.availableModels.find((option) => `${option.provider}/${option.id}` === label))
		.filter((option): option is ModelOption => option !== undefined)
		.slice(0, 5);
	if (recents.length > 0) {
		rows.push(<DropdownMenuLabel key="lu">Last used</DropdownMenuLabel>);
		for (const option of recents) rows.push(item(option, `r-${option.provider}/${option.id}`));
	}

	const display = state.availableModels
		.map((option, index) => ({ option, index }))
		.sort((a, b) => a.option.provider.localeCompare(b.option.provider) || a.index - b.index);
	let lastProvider: string | undefined;
	for (const { option } of display) {
		if (option.provider !== lastProvider) {
			lastProvider = option.provider;
			rows.push(<DropdownMenuLabel key={`p-${option.provider}`}>{option.provider}</DropdownMenuLabel>);
		}
		rows.push(item(option, `${option.provider}/${option.id}`));
	}

	return (
		<DropdownMenu
			open={state.modelMenuOpen}
			onOpenChange={(open) => {
				app.modelMenuOpen = open;
				if (open) void ensureModels();
				bump();
			}}
		>
			<DropdownMenuTrigger asChild>
				<Chip title="Model (Ctrl+Shift+I)">{current ? current.split("/").pop() : "no model"}</Chip>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="max-h-80 w-80" onKeyDown={pickByNumber}>
				{state.availableModels.length === 0 ? (
					<div className="flex flex-col gap-2 px-2.5 py-2.5">
						<p className="text-sm leading-relaxed text-muted-foreground">
							No models yet. Add a provider and smolt will pick its models up.
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
				) : (
					rows
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function ModeMenu() {
	const state = useApp();
	return (
		<DropdownMenu
			open={state.modeMenuOpen}
			onOpenChange={(open) => {
				app.modeMenuOpen = open;
				bump();
			}}
		>
			<DropdownMenuTrigger asChild>
				<Chip
					title={
						state.permissionMode === "plan"
							? "Plan mode: writes, edits, and shell commands are blocked (Ctrl+Shift+M)"
							: "Edit mode: the agent can change files (Ctrl+Shift+M)"
					}
					className={cn(state.permissionMode === "plan" && "bg-primary/10 text-salmon-text")}
				>
					{modeLabel(state.permissionMode)}
				</Chip>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-80" onKeyDown={pickByNumber}>
				<DropdownMenuLabel>Mode</DropdownMenuLabel>
				{MODE_ITEMS.map((item, index) => (
					<DropdownMenuItem key={item.id} onSelect={() => void setPermissionMode(item.id)}>
						<div className="min-w-0 flex-1">
							<div>{item.label}</div>
							<div className="overflow-hidden text-ellipsis whitespace-nowrap text-xs text-faint">{item.hint}</div>
						</div>
						{item.badge && <Badge>{item.badge}</Badge>}
						{item.id === state.permissionMode && <Icon name="check" className="text-salmon-text" />}
						<span className="w-4 text-center font-mono text-xs text-faint">{index + 1}</span>
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** Effort picker: a Faster↔Smarter slider over the model's thinking levels. */
function EffortPopover() {
	const state = useApp();
	const [preview, setPreview] = useState<string | null>(null);
	const levels = state.availableThinking;
	const index = Math.max(0, levels.indexOf(preview ?? state.thinking));
	if (state.thinking === "") return null;
	return (
		<Popover
			open={state.effortOpen}
			onOpenChange={(open) => {
				app.effortOpen = open;
				if (open) void ensureThinkingLevels();
				setPreview(null);
				bump();
			}}
		>
			<PopoverTrigger asChild>
				<Chip title="Effort (Ctrl+Shift+E)" className="capitalize">
					{state.thinking}
				</Chip>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-64">
				<div className="mb-3 flex items-center justify-between text-sm text-muted-foreground">
					<span>
						Effort <strong className="font-semibold capitalize text-foreground">{preview ?? state.thinking}</strong>
					</span>
					<span
						title="Higher effort means more reasoning before each step: slower, and better on hard problems."
						className="flex size-4 cursor-help items-center justify-center rounded-full border text-xs text-faint"
					>
						?
					</span>
				</div>
				<div className="mb-1 flex justify-between text-xs text-faint">
					<span>Faster</span>
					<span>Smarter</span>
				</div>
				<Slider
					min={0}
					max={Math.max(0, levels.length - 1)}
					step={1}
					value={[index]}
					onValueChange={([value]) => setPreview(levels[value ?? 0] ?? null)}
					onValueCommit={([value]) => {
						const level = levels[value ?? 0];
						if (level) void chooseThinking(level);
					}}
				/>
			</PopoverContent>
		</Popover>
	);
}

/** Tokens the agent holds back before auto-compaction kicks in. */
const COMPACT_RESERVE_TOKENS = 16_384;

/**
 * A quiet ring showing context-window fill — muted at rest, warming to amber
 * and then red only once context is genuinely filling up. Always present:
 * its popover is also where upkeep (auto-compaction and auto-retry) lives.
 */
function ContextRing() {
	const state = useApp();
	// The agent's own accounting first — the same figure the TUI footer shows
	// and auto-compaction acts on. While a turn streams, the live usage of the
	// current request is fresher, so the larger of the two wins.
	const window_ = (() => {
		if (state.contextUsage && state.contextUsage.contextWindow > 0) return state.contextUsage.contextWindow;
		const slash = state.model.indexOf("/");
		if (slash <= 0) return 0;
		const [provider, id] = [state.model.slice(0, slash), state.model.slice(slash + 1)];
		return state.availableModels.find((entry) => entry.provider === provider && entry.id === id)?.contextWindow ?? 0;
	})();
	const liveUsed = state.chat.streaming && state.chat.usage ? state.chat.usage.input + state.chat.usage.output : 0;
	const used = Math.max(state.contextUsage?.tokens ?? 0, liveUsed);
	const hasFigures = window_ > 0;
	const pct = hasFigures ? Math.min(100, Math.round((used / window_) * 100)) : 0;
	const color = pct >= 90 ? "var(--destructive)" : pct >= 70 ? "var(--warn)" : "currentColor";
	const radius = 6.5;
	const circumference = 2 * Math.PI * radius;
	const markAt = hasFigures ? Math.min(100, ((window_ - COMPACT_RESERVE_TOKENS) / window_) * 100) : 100;
	return (
		<Popover>
			<PopoverTrigger asChild>
				<button
					type="button"
					title={
						hasFigures ? `Context ${shortTokens(used)} / ${shortTokens(window_)} (${pct}%)` : "Context window"
					}
					className="flex size-8 items-center justify-center rounded-lg text-faint transition-colors hover:bg-accent hover:text-foreground"
				>
					<svg width="16" height="16" viewBox="0 0 18 18" style={{ transform: "rotate(-90deg)" }} aria-hidden="true">
						<circle cx="9" cy="9" r={radius} fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth="2" />
						<circle
							cx="9"
							cy="9"
							r={radius}
							fill="none"
							stroke={color}
							strokeWidth="2"
							strokeLinecap="round"
							strokeDasharray={`${(pct / 100) * circumference} ${circumference}`}
						/>
					</svg>
				</button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-72">
				<div className="mb-2 flex items-center justify-between gap-3 text-sm text-muted-foreground">
					<span>Context window</span>
					{hasFigures ? (
						<strong className="font-medium tabular-nums text-foreground">
							{shortTokens(used)} / {shortTokens(window_)} ({pct}%)
						</strong>
					) : (
						<span className="text-xs text-faint">fills as the session runs</span>
					)}
				</div>
				<div className="relative mb-3 h-1.5 rounded-full bg-input/50">
					<span
						className="absolute inset-y-0 left-0 rounded-full transition-all"
						style={{
							width: `${pct}%`,
							background: pct >= 90 ? "var(--destructive)" : pct >= 70 ? "var(--warn)" : "var(--salmon)",
						}}
					/>
					{state.autoCompaction && hasFigures && (
						<span
							title={`Auto-compacts at ~${shortTokens(window_ - COMPACT_RESERVE_TOKENS)}`}
							className="absolute -top-1 -bottom-1 w-0.5 -translate-x-px rounded-full bg-faint"
							style={{ left: `${markAt}%` }}
						/>
					)}
				</div>
				<div className="mb-3 flex flex-col gap-2.5 border-t pt-3">
					<label className="flex cursor-pointer items-center justify-between gap-3 text-sm">
						<span className="flex flex-col">
							Auto-compaction
							<em className="text-xs not-italic text-faint">Compact context automatically as it fills</em>
						</span>
						<Switch
							checked={state.autoCompaction}
							onCheckedChange={async (next) => {
								app.autoCompaction = next === true;
								bump();
								await call("setAutoCompaction", app.autoCompaction);
							}}
						/>
					</label>
					<label className="flex cursor-pointer items-center justify-between gap-3 text-sm">
						<span className="flex flex-col">
							Auto-retry
							<em className="text-xs not-italic text-faint">Retry transient provider errors without asking</em>
						</span>
						<Switch
							checked={state.autoRetry}
							onCheckedChange={async (next) => {
								app.autoRetry = next === true;
								bump();
								await call("setAutoRetry", app.autoRetry);
							}}
						/>
					</label>
				</div>
				<Button variant="outline" size="sm" className="w-full" onClick={() => void compactNow()}>
					Compact now
				</Button>
			</PopoverContent>
		</Popover>
	);
}

/**
 * The composer's + menu: the three ways to bring something into a turn.
 *
 * Commands are one row that opens the palette rather than a list inlined here,
 * so the menu stays a short set of verbs however many skills are installed.
 */
function PlusMenu({ onCommands }: { onCommands: () => void }) {
	return (
		<DropdownMenu
			onOpenChange={(open) => {
				if (open) void ensureCommands();
			}}
		>
			<DropdownMenuTrigger asChild>
				<Button variant="ghost" size="icon" title="Add context and commands">
					<Icon name="plus" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-64">
				<DropdownMenuItem
					onSelect={() => (document.getElementById("file-input") as HTMLInputElement | null)?.click()}
				>
					<Icon name="attach" />
					Add files or photos
					<DropdownMenuShortcut>Ctrl U</DropdownMenuShortcut>
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={() => void pickProject()}>
					<Icon name="folder" />
					Add folder
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={() => onCommands()}>
					<Icon name="command" />
					Slash commands
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function MicMenu() {
	const state = useApp();
	const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
	return (
		<DropdownMenu
			onOpenChange={(open) => {
				if (!open) return;
				// No key check: dictation runs a local model, so the only thing that
				// can stop it is the microphone itself.
				navigator.mediaDevices
					.enumerateDevices()
					.then((all) => setDevices(all.filter((device) => device.kind === "audioinput")))
					.catch(() => toast("Could not list microphones — check the system permission for smolt.", "error"));
			}}
		>
			<DropdownMenuTrigger asChild>
				<Button variant="ghost" size="icon" title="Microphone" className="w-4">
					<Icon name="chevron" className="rotate-90" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-72">
				<DropdownMenuLabel>Microphone</DropdownMenuLabel>
				{devices.map((device, index) => (
					<DropdownMenuItem
						key={device.deviceId || index}
						onSelect={() => {
							app.micDeviceId = device.deviceId;
							app.voiceDenied = false;
						}}
					>
						<span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
							{device.label.trim() || `Microphone ${index + 1}`}
						</span>
						{(device.deviceId === state.micDeviceId ||
							(state.micDeviceId === "" && device.deviceId === "default")) && (
							<Icon name="check" className="text-salmon-text" />
						)}
					</DropdownMenuItem>
				))}
				<DropdownMenuSeparator />
				<div className="flex items-center justify-between gap-3 px-2.5 py-1.5 text-sm">
					<span>Hold to record</span>
					<Switch
						checked={state.holdToRecord}
						onCheckedChange={(checked) => {
							app.holdToRecord = checked === true;
							bump();
						}}
					/>
				</div>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** A tool call waiting on a decision: a louder card when it cannot be undone. */
function ApprovalCard() {
	const state = useApp();
	const request = state.pendingApprovals[0];
	if (!request) return null;
	return (
		<div
			className={cn(
				"mb-2 flex items-center gap-3 rounded-xl border border-salmon bg-card px-3 py-2.5",
				request.danger && "border-destructive bg-destructive/5",
			)}
		>
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="font-mono text-sm text-salmon-text">
					{request.tool}
					{request.danger && <span className="ml-2 font-sans text-xs text-destructive">{request.danger}</span>}
				</span>
				<span className="overflow-hidden text-ellipsis whitespace-nowrap font-mono text-sm text-muted-foreground">
					{request.summary}
				</span>
			</div>
			<div className="flex flex-none gap-1.5">
				<Button variant="outline" size="sm" onClick={() => void answerApproval("deny")}>
					Deny
				</Button>
				{!request.danger && (
					<Button variant="outline" size="sm" onClick={() => void answerApproval("always")}>
						Always allow {request.tool}
					</Button>
				)}
				<Button size="sm" onClick={() => void answerApproval("allow")}>
					Allow
				</Button>
			</div>
		</div>
	);
}

function QueuedBanner() {
	useApp();
	// This chat's queue. Another chat's waiting messages are its own business.
	const queued = queuedHere();
	if (queued.length === 0) return null;
	const count = queued.length;
	return (
		<div className="mb-1.5 flex items-center gap-2.5 rounded-xl border bg-card py-2 pr-2 pl-3">
			<span className="flex-none text-sm font-semibold">
				{count} message{count === 1 ? "" : "s"} queued
			</span>
			<span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-sm text-faint">
				{queued[0]?.label ?? ""}
			</span>
			{/* Queueing is the safe default; this is the way out of it when the
			    reader can see their message should not wait for the turn. */}
			<Button
				variant="ghost"
				size="sm"
				className="h-6 flex-none px-2 text-xs text-muted-foreground hover:text-foreground"
				title="Deliver now, interrupting the current turn"
				onClick={() => void sendQueuedNow()}
			>
				Send now
			</Button>
			<Button variant="ghost" size="icon" className="size-6" title="Discard queued messages" onClick={() => void clearQueued()}>
				<Icon name="close" />
			</Button>
		</div>
	);
}

/** Project, branch and change count, with a way into the diff. */
function RepoBar() {
	const state = useApp();
	const changed = state.diffFiles.length;
	const folder = projectName();
	// The folder and branch are always worth showing: they say where the next
	// turn will run. The review half is what waits for evidence — builds and
	// other sessions also move the working tree, and a conversation that never
	// touched a file should never be told it changed one.
	const reviewable = changed > 0 && !state.repoBarDismissed && chatDidToolWork();
	// The folder lives in the titlebar now, so this bar is only ever a review
	// prompt: it stays out of the way until this chat has actually moved files.
	if (!reviewable) return null;
	const added = state.diffFiles.reduce((sum, file) => sum + file.added, 0);
	const removed = state.diffFiles.reduce((sum, file) => sum + file.removed, 0);
	return (
		<div
			className="mb-1.5 flex items-center gap-2.5 rounded-xl border bg-card py-1.5 pr-2 pl-3 text-sm"
			title={
				`What this chat changed in ${projectName()}${state.repoBranch ? ` on ${state.repoBranch}` : ""}` +
				`${state.preexistingChanges > 0 ? `, excluding ${state.preexistingChanges} already modified when it opened` : ""}.`
			}
		>
			<span className="whitespace-nowrap">{folder}</span>
			{state.repoBranch !== "" && (
				<span className="flex items-center gap-1 whitespace-nowrap font-mono text-xs text-faint">
					<Icon name="branch" />
					{state.repoBranch}
				</span>
			)}
			{reviewable && (
			<>
			<span className="ml-auto flex gap-1.5 rounded-lg bg-ok/10 px-2 py-0.5 font-mono text-xs tabular-nums">
				<span className="text-ok">+{added.toLocaleString()}</span>
				<span className="text-destructive">−{removed.toLocaleString()}</span>
			</span>
			<Button variant="outline" size="sm" className="whitespace-nowrap" onClick={() => toggleDiffPane(true)}>
				Review {changed} file{changed === 1 ? "" : "s"}
			</Button>
			<Button
				variant="ghost"
				size="icon"
				className="size-6"
				title="Hide"
				onClick={() => {
					// Remember what was dismissed, so only a further change brings it back.
					app.repoBarDismissed = new Map(app.diffFiles.map((file) => [file.path, file.hunks]));
					bump();
				}}
			>
				<Icon name="close" />
			</Button>
			</>
			)}
		</div>
	);
}

/** One row the command palette can offer. */
interface PaletteItem {
	/** Shown with a leading slash unless `plain` (session titles). */
	title: string;
	plain?: boolean;
	description: string;
	/** Actions run in the app; inserts put the command in the draft for the agent. */
	kind: "action" | "insert";
	run: () => void;
}

/** Command palette: opens as "/" leads the draft, narrowing as it is typed. */
function CommandPalette({
	items,
	selected,
	children,
}: {
	items: PaletteItem[];
	selected: number;
	children: React.ReactNode;
}) {
	const listRef = useRef<HTMLDivElement>(null);
	// Arrow keys move the selection; the list follows it.
	useEffect(() => {
		listRef.current?.querySelector("[data-selected=true]")?.scrollIntoView({ block: "nearest" });
	}, [selected]);
	return (
		<Popover open={items.length > 0}>
			<PopoverAnchor asChild>{children}</PopoverAnchor>
			<PopoverContent
				ref={listRef}
				side="top"
				align="start"
				className="max-h-72 w-[28rem] max-w-[90vw] overflow-y-auto p-1.5"
				onOpenAutoFocus={(event) => event.preventDefault()}
			>
				{items.map((item, index) => (
					<button
						type="button"
						key={`${item.title}-${index}`}
						data-selected={index === selected}
						className={cn(
							"flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent",
							index === selected && "bg-accent/60",
						)}
						onMouseDown={(event) => {
							event.preventDefault();
							item.run();
						}}
					>
						{index < 9 && <span className="w-4 flex-none text-center font-mono text-xs text-faint">{index + 1}</span>}
						<span className={cn("font-medium", item.plain ? "min-w-0 overflow-hidden text-ellipsis" : "flex-none")}>
							{item.plain ? item.title : `/${item.title}`}
						</span>
						<span className="ml-auto min-w-0 flex-none overflow-hidden text-ellipsis whitespace-nowrap text-xs text-faint max-w-[55%]">
							{item.description.slice(0, 64)}
						</span>
					</button>
				))}
			</PopoverContent>
		</Popover>
	);
}

export function Composer() {
	const state = useApp();
	// The composer alone follows the draft, so typing wakes nothing else.
	useDraft();
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const [dropping, setDropping] = useState(false);
	const [paletteIndex, setPaletteIndex] = useState(0);
	const historyIndexRef = useRef(-1);
	const historyDraftRef = useRef("");

	// Keep the textarea sized to its content.
	// biome-ignore lint/correctness/useExhaustiveDependencies: height tracks the draft
	useEffect(() => {
		const input = inputRef.current;
		if (!input) return;
		input.style.height = "auto";
		input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
	}, [state.draft]);

	const insertCommand = (name: string): void => {
		app.draft = `/${name} `;
		bump();
		inputRef.current?.focus();
	};

	/** A lone slash is what opens the palette, so this is the same gesture. */
	const openCommands = (): void => {
		app.draft = "/";
		bump();
		inputRef.current?.focus();
	};

	// A leading "/" opens the palette; "/resume …" keeps it open across spaces
	// so past conversations can be searched and continued from right here.
	const paletteMatch = /^\/(\S*)$/.exec(state.draft) ?? /^\/(resume\s+.*)$/i.exec(state.draft);
	const paletteQuery = paletteMatch ? (paletteMatch[1] ?? "") : null;
	useEffect(() => {
		if (paletteQuery !== null) void ensureCommands();
		// A new query means a new list; selection starts back at the top.
		setPaletteIndex(0);
	}, [paletteQuery]);

	const finishAction = (): void => {
		app.draft = "";
		bump();
		inputRef.current?.focus();
	};
	const act = (run: () => void): PaletteItem["run"] => {
		return () => {
			finishAction();
			run();
		};
	};

	// Everything the app itself can do, addressable the way the TUI does it.
	const builtins: PaletteItem[] = [
		{ title: "resume", description: "Continue a previous conversation", kind: "action", run: () => {
			app.draft = "/resume ";
			bump();
		} },
		{ title: "new", description: "Start a new session", kind: "action", run: act(() => void newSession()) },
		{ title: "fork", description: "Duplicate this chat into a new session", kind: "action", run: act(() => {
			const row = app.sessionRows.find((entry) => entry.path === app.currentSessionPath);
			if (row) void forkSession(row);
		}) },
		{ title: "rename", description: "Rename this session", kind: "action", run: act(() => {
			const row = app.sessionRows.find((entry) => entry.path === app.currentSessionPath);
			if (row) void renameSession(row);
		}) },
		{ title: "compact", description: "Compact the conversation context", kind: "action", run: act(() => void compactNow()) },
		{ title: "export", description: "Export this session as HTML", kind: "action", run: act(async () => {
			const result = await call<{ path: string }>("exportHtml");
			// Showing the file beats announcing it: no popup, and it can be found.
			if (result) void api.reveal(result.path, "reveal");
		}) },
		{ title: "model", description: "Choose the model", kind: "action", run: act(() => {
			app.modelMenuOpen = true;
			bump();
		}) },
		{ title: "effort", description: "Choose the reasoning effort", kind: "action", run: act(() => {
			app.effortOpen = true;
			bump();
		}) },
		{ title: "mode", description: "Choose the permission mode", kind: "action", run: act(() => {
			app.modeMenuOpen = true;
			bump();
		}) },
		{ title: "theme", description: "System, light, or dark", kind: "action", run: () => {
			app.draft = "/theme ";
			bump();
		} },
		{ title: "settings", description: "Open settings", kind: "action", run: act(() => {
			app.settingsOpen = true;
			bump();
		}) },
		{ title: "changes", description: "Toggle the changes pane", kind: "action", run: act(() => toggleDiffPane()) },
		{ title: "side", description: "Toggle the side chat", kind: "action", run: act(() => toggleSidePane()) },
		{ title: "shortcuts", description: "Keyboard shortcuts", kind: "action", run: act(() => {
			app.shortcutsOpen = true;
			bump();
		}) },
	];

	// Counted here rather than at each call site: the palette is run from a
	// click, a number key and the arrow keys, and all three go through this.
	const counted = (items: PaletteItem[]): PaletteItem[] =>
		items.map((item) => ({
			...item,
			run: () => {
				noteCommandUse(item.title);
				item.run();
			},
		}));

	const paletteItems: PaletteItem[] = counted((() => {
		if (paletteQuery === null) return [];
		const query = paletteQuery.toLowerCase();
		// "/resume …" turns the palette into the chat history, ready to continue.
		const resumeArg = /^resume(?:\s+(.*))?$/.exec(query);
		if (resumeArg && (resumeArg[1] !== undefined || query === "resume")) {
			const needle = (resumeArg[1] ?? "").trim();
			return state.sessionRows
				.filter((row) => row.path !== state.currentSessionPath)
				.filter(
					(row) =>
						needle === "" ||
						row.title.toLowerCase().includes(needle) ||
						row.preview.toLowerCase().includes(needle),
				)
				.slice(0, 20)
				.map((row) => ({
					title: row.title || "Untitled",
					plain: true,
					description: new Date(row.lastActive).toLocaleString(),
					kind: "action" as const,
					run: act(() => void switchToSession(row.path)),
				}));
		}
		const themeArg = /^theme(?:\s+(.*))?$/.exec(query);
		if (themeArg && (themeArg[1] !== undefined || query === "theme")) {
			return (["system", "light", "dark"] as const).map((choice) => ({
				title: `theme ${choice}`,
				description: choice === "system" ? "Follow the operating system" : `Always ${choice}`,
				kind: "action" as const,
				run: act(() => applyTheme(choice)),
			}));
		}
		// Substring match: most agent commands live under a "skill:" prefix, so
		// asking for the exact start would make "/co" find nothing. Prefix hits
		// and app commands rank first.
		const fromApp = builtins.filter((item) => item.title.toLowerCase().includes(query));
		const fromAgent = state.slashCommands
			.filter((command) => command.name.toLowerCase().includes(query))
			.sort((a, b) => Number(b.name.toLowerCase().startsWith(query)) - Number(a.name.toLowerCase().startsWith(query)))
			.map(
				(command): PaletteItem => ({
					title: command.name,
					description: command.description ?? "",
					kind: "insert",
					run: () => insertCommand(command.name),
				}),
			);
		// Most used first, then alphabetical. With a query typed, what the reader
		// has started spelling still outranks habit, so prefix hits keep their
		// group and the tally only orders within it.
		const byUse = (a: PaletteItem, b: PaletteItem): number => {
			const used = (state.commandUse[b.title] ?? 0) - (state.commandUse[a.title] ?? 0);
			return used !== 0 ? used : a.title.localeCompare(b.title);
		};
		if (query === "") return [...fromApp, ...fromAgent].sort(byUse).slice(0, 40);
		return [
			...fromApp.filter((item) => item.title.toLowerCase().startsWith(query)).sort(byUse),
			...fromAgent,
			...fromApp.filter((item) => !item.title.toLowerCase().startsWith(query)).sort(byUse),
		].slice(0, 40);
	})());

	const canSend = state.draft.trim() !== "" || state.attachments.length > 0;

	return (
		<div className="relative mx-auto w-full max-w-[804px] px-8 pb-3.5 @container">
			<ApprovalCard />
			<QueuedBanner />
			{state.chat.messages.length === 0 && <FolderBar />}
			<RepoBar />
			<div
				className={cn(
					"flex flex-col gap-2 rounded-xl border bg-card p-3.5 pb-2.5 shadow-lg transition-colors focus-within:border-border-strong",
					dropping && "border-salmon bg-primary/5",
				)}
				onDragOver={(event) => {
					event.preventDefault();
					setDropping(true);
				}}
				onDragLeave={() => setDropping(false)}
				onDrop={(event) => {
					event.preventDefault();
					setDropping(false);
					const files = event.dataTransfer?.files;
					if (files?.length) void addImageFiles(files);
				}}
			>
				{state.attachments.length > 0 && (
					<div className="flex flex-wrap gap-2 pt-0.5 pb-1">
						{state.attachments.map((item, index) => (
							<div key={index} className="group/att relative size-14 overflow-hidden rounded-lg border bg-background-deep" title={item.name}>
								<img src={item.url} alt={item.name} className="block h-full w-full object-cover" />
								<button
									type="button"
									title="Remove"
									className="absolute top-1 right-1 flex size-4.5 items-center justify-center rounded-full bg-black/70 text-white opacity-0 transition-opacity hover:bg-destructive group-hover/att:opacity-100"
									onClick={() => removeAttachment(index)}
								>
									<Icon name="close" className="[&>svg]:size-3" />
								</button>
							</div>
						))}
					</div>
				)}
				<CommandPalette items={paletteItems} selected={Math.min(paletteIndex, Math.max(0, paletteItems.length - 1))}>
					<textarea
						ref={inputRef}
						rows={1}
						value={state.draft}
						placeholder={state.chat.streaming ? "Queue a message for when it finishes…" : "Type / for commands"}
						className="max-h-60 min-h-[26px] w-full resize-none bg-transparent px-0.5 pb-1 text-sm leading-relaxed outline-none placeholder:text-faint"
						onChange={(event) => {
							app.draft = event.target.value;
							historyIndexRef.current = -1;
							// Only the composer reads the draft; waking the transcript to add
							// one character is what made typing feel behind the keyboard.
							bumpDraft();
						}}
						onKeyDown={(event) => {
							const input = event.currentTarget;
							// With the palette open, a bare digit picks that entry.
							if (
								paletteItems.length > 0 &&
								/^[1-9]$/.test(event.key) &&
								!event.ctrlKey &&
								!event.metaKey &&
								!event.altKey
							) {
								const item = paletteItems[Number(event.key) - 1];
								if (item) {
									event.preventDefault();
									item.run();
									return;
								}
							}
							// With the palette open, the arrows walk the list, not history.
							if (paletteItems.length > 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
								event.preventDefault();
								const count = paletteItems.length;
								setPaletteIndex((current) => {
									const at = Math.min(current, count - 1);
									return event.key === "ArrowDown" ? (at + 1) % count : (at - 1 + count) % count;
								});
								return;
							}
							if (event.key === "Enter" && !event.shiftKey) {
								event.preventDefault();
								const chosen = paletteItems[Math.min(paletteIndex, Math.max(0, paletteItems.length - 1))];
								if (chosen) {
									// An app command runs here.
									if (chosen.kind === "action") {
										chosen.run();
										return;
									}
									// An agent command completes into the composer first, so
									// Enter never fires a half-typed command; once the draft
									// carries the full command, Enter sends it as a prompt.
									if (state.draft.trim() !== `/${chosen.title}`) {
										chosen.run();
										return;
									}
								}
								void send();
								return;
							}
							if (event.key === "Escape") {
								if (state.chat.streaming) void call("abort");
								return;
							}
							// Up/Down recall previous prompts, but only from the edges of
							// the text so multi-line editing still works normally.
							if (event.key === "ArrowUp" && input.selectionStart === 0 && promptHistory.length > 0) {
								if (historyIndexRef.current === -1) historyDraftRef.current = state.draft;
								historyIndexRef.current =
									historyIndexRef.current === -1
										? promptHistory.length - 1
										: Math.max(0, historyIndexRef.current - 1);
								event.preventDefault();
								app.draft = promptHistory[historyIndexRef.current] ?? "";
								bump();
								requestAnimationFrame(() => input.setSelectionRange(0, 0));
								return;
							}
							if (
								event.key === "ArrowDown" &&
								historyIndexRef.current !== -1 &&
								input.selectionStart === input.value.length
							) {
								event.preventDefault();
								if (historyIndexRef.current >= promptHistory.length - 1) {
									historyIndexRef.current = -1;
									app.draft = historyDraftRef.current;
								} else {
									historyIndexRef.current += 1;
									app.draft = promptHistory[historyIndexRef.current] ?? "";
								}
								bump();
							}
						}}
					/>
				</CommandPalette>
				<div className="flex items-center justify-between gap-2">
					<div className="flex min-w-0 items-center gap-1">
						<ModeMenu />
						<PlusMenu onCommands={openCommands} />
						<Button
							variant="ghost"
							size="icon"
							title={
								state.voicePreparing
									? "Fetching the speech model…"
									: state.voiceFinishing
										? "Transcribing…"
										: state.voiceActive
											? "Stop and insert"
											: state.voiceDenied
												? "Microphone unavailable — open the setting"
												: state.voiceSilent !== ""
													? `No sound reached ${state.voiceSilent}. Choose another microphone in the menu beside this button.`
													: "Dictate (Ctrl+M)"
							}
							className={cn(
								"relative",
								state.voiceActive && "bg-destructive/10 text-destructive",
								state.voiceSilent !== "" && !state.voiceActive && "text-destructive",
								(state.voicePreparing || state.voiceFinishing) && "text-salmon-text [&_svg]:animate-spin",
							)}

							disabled={state.voicePreparing || state.voiceFinishing}
							onClick={() => {
								// With no status line left to click, a refused microphone makes
								// this button the way to the setting that fixes it.
								if (state.voiceDenied) void api.openMicSettings();
								else toggleVoice();
							}}
							onPointerDown={() => {
								if (state.holdToRecord && !state.voiceActive) void startVoice();
							}}
							onPointerUp={() => {
								if (state.holdToRecord && state.voiceActive) void finishVoice(true);
							}}
							onContextMenu={(event) => event.preventDefault()}
						>
							<Icon name={state.voicePreparing || state.voiceFinishing ? "spinner" : "mic"} />
							{/* A live level, so a microphone that hears nothing shows it while
							    speaking rather than only once the clip comes back empty. */}
							{state.voiceActive && (
								<span className="pointer-events-none absolute inset-x-1 bottom-0.5 h-0.5 overflow-hidden rounded-full bg-destructive/20">
									<span
										className="block h-full rounded-full bg-destructive transition-[width] duration-100"
										style={{ width: `${Math.round(state.voiceLevel * 100)}%` }}
									/>
								</span>
							)}
						</Button>
						<MicMenu />
					</div>
					<div className="flex min-w-0 items-center gap-2">
						<ContextRing />
						<ModelMenu />
						<span className="@max-[480px]:hidden">
							<EffortPopover />
						</span>
						{/* One button, one place: send when idle, send-to-queue while a
						    turn runs and there is text, stop while it runs and there is
						    none. Esc still stops at any time. */}
						{(() => {
							const showStop = state.chat.streaming && !canSend;
							const stopping = showStop && state.aborting;
							return (
								<Button
									size="icon"
									title={stopping ? "Stopping…" : showStop ? "Stop (Esc)" : state.chat.streaming ? "Send to queue" : "Send"}
									disabled={stopping || (!state.chat.streaming && !canSend)}
									className={cn(
										"rounded-full active:scale-95",
										showStop
											? "bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:bg-destructive/40"
											: "disabled:bg-input disabled:text-faint",
									)}
									onClick={() => (showStop ? void abortTurn() : void send())}
								>
									<Icon name={stopping ? "spinner" : showStop ? "stop" : "send"} className={cn(stopping && "animate-spin")} />
								</Button>
							);
						})()}
					</div>
				</div>
			</div>
			<input
				id="file-input"
				type="file"
				accept="image/*"
				multiple
				hidden
				onChange={(event) => {
					const picker = event.target;
					if (picker.files) void addImageFiles(picker.files);
					picker.value = "";
				}}
			/>
		</div>
	);
}
