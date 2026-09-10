import { useEffect, useRef, useState } from "react";
import { app } from "../state/app.ts";
import { api } from "../lib/api.ts";
import { cn } from "../lib/cn.ts";
import { shortTokens } from "../lib/format.ts";
import { storedPreference, storePreference } from "../lib/prefs.ts";
import { AUTO_THINKING_ENTRY, thinkingLabel } from "../thinking.ts";
import {
	addImageFiles,
	answerApproval,
	applyTheme,
	bump,
	enterSendMode,
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
	approvalsHere,
	flushingHere,
	queuedHere,
	sendQueuedNow,
	compactNow,
	ensureCommands,
	pickProject,
	ensureModels,
	ensureThinkingLevels,
	MODE_ITEMS,
	modeLabel,
	openSettings,
	projectName,
	promptHistory,
	recentModels,
	refreshContextUsage,
	removeAttachment,
	send,
	type SendMode,
	setPermissionMode,
	toast,
	toggleDiffPane,
	diffSignature,
	type ModelOption,
	type ProviderUsageAccount,
	type ProviderUsageSnapshot,
	type ProviderUsageWindow,
	type SlashCommand,
} from "../state/app.ts";
import { useApp, useDraft } from "../state/useApp.ts";
import {
	finishVoice,
	startVoice,
	toggleVoice,
	voiceRunning,
	voiceTranscribing,
	whenVoiceSettled,
} from "../state/voice.ts";
import { Chevron, ContextBar, ContextBreakdown } from "./ContextBreakdown.tsx";
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
import { ProjectMenuItems } from "./ProjectMenu.tsx";
import { Icon } from "./ui/icon.tsx";
import { Tip } from "./ui/tooltip.tsx";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";
import { Input } from "./ui/input.tsx";
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

/**
 * Send, closing dictation first if it is running.
 *
 * Enter while speaking means "that's the message": the microphone stops,
 * the tail of the sentence is committed to the draft, and then the send
 * happens — rather than the message going while the microphone stays open
 * listening for a follow-up nobody is going to give it.
 */
function sendClosingVoice(mode?: SendMode): void {
	void (async () => {
		if (voiceRunning()) await finishVoice(true);
		// A decode already in flight has not written its words yet; sending
		// now would send the message without them.
		await whenVoiceSettled();
		await send(mode ?? enterSendMode());
	})();
}

/** Enter does the configured thing; Ctrl or Cmd with it does the other. */
function modeForEvent(event: { ctrlKey: boolean; metaKey: boolean }): SendMode {
	const plain = enterSendMode();
	if (!event.ctrlKey && !event.metaKey) return plain;
	return plain === "now" ? "queue" : "now";
}

function Chip({
	className,
	active,
	title,
	...props
}: React.ComponentProps<"button"> & { active?: boolean }) {
	return (
		// The label goes through the app's own tooltip rather than the browser's.
		// Props still land on the button, so a Chip works as a menu trigger.
		<Tip label={typeof title === "string" ? title : ""}>
			<button
				type="button"
				className={cn(
					"h-8 max-w-44 overflow-hidden rounded-lg px-3 text-sm whitespace-nowrap text-ellipsis text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent",
					className,
				)}
				{...props}
			/>
		</Tip>
	);
}

/** How many model rows render per page; scrolling near the bottom loads more. */
const MODEL_PAGE = 40;

/**
 * The model menu: a search box on top, last-used first, and the catalogue
 * rendered a page at a time — a 200-model registry must not mount 200 rows
 * the moment the menu opens.
 */
function ModelMenu() {
	const state = useApp();
	const current = state.model;
	const pending = state.pendingModel;
	const [query, setQuery] = useState("");
	const [limit, setLimit] = useState(MODEL_PAGE);

	const setOpen = (open: boolean): void => {
		app.modelMenuOpen = open;
		if (open) {
			void ensureModels();
			setQuery("");
			setLimit(MODEL_PAGE);
		}
		bump();
	};

	const pick = (option: ModelOption): void => {
		setOpen(false);
		void chooseModel(option.provider, option.id);
	};

	const row = (option: ModelOption, key: string): React.ReactNode => {
		const ref = `${option.provider}/${option.id}`;
		const active = ref === current;
		const queued = pending !== null && `${pending.provider}/${pending.id}` === ref;
		// Local model ids are long enough that the ellipsis usually lands
		// mid-name - three quantisations of one model truncate to the same
		// characters - so the full id is worth having on hover. To the side
		// rather than below: under the pointer it would cover the next row.
		return (
			<Tip key={key} label={option.id} side="left">
				<button
					type="button"
					onClick={() => pick(option)}
					className="flex h-8 w-full flex-none items-center gap-2 rounded-lg px-2.5 text-left text-sm transition-colors hover:bg-accent"
				>
					<span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{option.id}</span>
					{option.reasoning && <Badge>Reasoning</Badge>}
					{queued && <span className="flex-none text-xs text-warn">next</span>}
					{active && <Icon name="check" className="text-tint-text" />}
				</button>
			</Tip>
		);
	};

	const heading = (key: string, text: string): React.ReactNode => (
		<div key={key} className="px-2.5 pt-2 pb-0.5 text-xs font-medium uppercase tracking-wide text-faint">
			{text}
		</div>
	);

	const needle = query.trim().toLowerCase();
	const rows: React.ReactNode[] = [];
	// The current model counts as last-used even before anything is stored.
	if (needle === "") {
		const recents = [...new Set([...(current ? [current] : []), ...recentModels()])]
			.map((label) => state.availableModels.find((option) => `${option.provider}/${option.id}` === label))
			.filter((option): option is ModelOption => option !== undefined)
			.slice(0, 5);
		if (recents.length > 0) {
			rows.push(heading("lu", "Last used"));
			for (const option of recents) rows.push(row(option, `r-${option.provider}/${option.id}`));
		}
	}
	const display = state.availableModels
		.map((option, index) => ({ option, index }))
		.filter(({ option }) => needle === "" || `${option.provider}/${option.id}`.toLowerCase().includes(needle))
		.sort((a, b) => a.option.provider.localeCompare(b.option.provider) || a.index - b.index);
	let lastProvider: string | undefined;
	let shown = 0;
	for (const { option } of display) {
		if (shown >= limit) break;
		if (option.provider !== lastProvider) {
			lastProvider = option.provider;
			rows.push(heading(`p-${option.provider}`, option.provider));
		}
		rows.push(row(option, `${option.provider}/${option.id}`));
		shown += 1;
	}
	const remaining = display.length - shown;

	return (
		<Popover open={state.modelMenuOpen} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Chip title="Model (Ctrl+Shift+I)">
					{pending ? `${pending.id} · next` : current ? current.split("/").pop() : "no model"}
				</Chip>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-80 p-1.5">
				{state.availableModels.length === 0 ? (
					<div className="flex flex-col gap-2 px-2.5 py-2.5">
						<p className="text-sm leading-relaxed text-muted-foreground">
							No models yet. Add a provider and smolt will pick its models up.
						</p>
						<Button size="sm" onClick={() => openSettings("providers")}>
							Add a provider
						</Button>
					</div>
				) : (
					<>
						<Input
							autoFocus
							type="search"
							placeholder={`Search ${state.availableModels.length} models…`}
							value={query}
							className="mb-1.5 h-8"
							onChange={(event) => {
								setQuery(event.target.value);
								setLimit(MODEL_PAGE);
							}}
						/>
						<div
							className="flex max-h-72 flex-col overflow-y-auto"
							onScroll={(event) => {
								const el = event.currentTarget;
								if (remaining > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 120) {
									setLimit((value) => value + MODEL_PAGE);
								}
							}}
						>
							{rows}
							{remaining > 0 && (
								<div className="flex-none px-2.5 py-1.5 text-xs text-faint">{remaining} more, scroll to load</div>
							)}
							{display.length === 0 && (
								<div className="px-2.5 py-2 text-sm text-faint">No model matches “{query.trim()}”.</div>
							)}
						</div>
					</>
				)}
			</PopoverContent>
		</Popover>
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
					className={cn(state.permissionMode === "plan" && "bg-primary/10 text-tint-text")}
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
						{item.id === state.permissionMode && <Icon name="check" className="text-tint-text" />}
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
	// Extension entries ("auto") are modes, not points on the faster↔smarter
	// axis: the slider carries only real levels, auto gets its own switch.
	const levels = state.availableThinking.filter((level) => level !== AUTO_THINKING_ENTRY);
	const autoAvailable = state.availableThinking.includes(AUTO_THINKING_ENTRY);
	const autoOn = (preview ?? state.thinking) === AUTO_THINKING_ENTRY;
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
				<Chip title="Effort (Ctrl+Shift+E)" className={cn(state.thinking !== AUTO_THINKING_ENTRY && "capitalize")}>
					{thinkingLabel(state.thinking)}
				</Chip>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-64">
				<div className="mb-3 flex items-center justify-between text-sm text-muted-foreground">
					<span>
						Effort{" "}
						<strong className={cn("font-semibold text-foreground", !autoOn && "capitalize")}>
							{thinkingLabel(preview ?? state.thinking)}
						</strong>
					</span>
					<Tip label="Higher effort means more reasoning before each step: slower, and better on hard problems.">
					<span className="flex size-4 cursor-help items-center justify-center rounded-full border text-xs text-faint">
						?
					</span>
					</Tip>
				</div>
				{autoAvailable && (
					<button
						type="button"
						onClick={() => {
							setPreview(null);
							void chooseThinking(AUTO_THINKING_ENTRY);
						}}
						className={cn(
							"mb-2 flex w-full items-baseline justify-between rounded-lg border px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent",
							autoOn && "border-tint/50 bg-primary/10",
						)}
					>
						<span className={cn(autoOn && "font-medium")}>Auto thinking</span>
						<span className="text-xs text-faint">picks the effort per task</span>
					</button>
				)}
				<div className={cn(autoOn && "pointer-events-auto opacity-40")}>
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
							// A concrete pick stands auto down — manual always wins.
							const level = levels[value ?? 0];
							if (level) void chooseThinking(level);
						}}
					/>
				</div>
			</PopoverContent>
		</Popover>
	);
}

/** Tokens the agent holds back before auto-compaction kicks in, capped at a quarter of the window. */
const COMPACT_RESERVE_TOKENS = 16_384;
const compactReserveFor = (window: number): number => Math.min(COMPACT_RESERVE_TOKENS, Math.floor(window / 4));
/** How often an open context popover re-reads its figures. */
const CONTEXT_POLL_MS = 3000;

/**
 * A quiet ring showing context-window fill: muted at rest, warming to amber
 * and then red only once context is genuinely filling up. Its popover holds
 * the breakdown and the provider allowance; auto-compaction, auto-retry and
 * the manual compact live in Settings.
 */
function ContextRing() {
	const state = useApp();
	// The agent's own accounting first, the same figure the TUI footer shows
	// and auto-compaction acts on. While a turn streams, the newest request's
	// own context is fresher, so the larger of the two wins. Never the turn's
	// running spend: that sums every request, plus whatever background
	// sessions a tool reported, and reads as a full window on a chat that
	// is nowhere near one.
	const window_ = (() => {
		if (state.contextUsage && state.contextUsage.contextWindow > 0) return state.contextUsage.contextWindow;
		const slash = state.model.indexOf("/");
		if (slash <= 0) return 0;
		const [provider, id] = [state.model.slice(0, slash), state.model.slice(slash + 1)];
		return state.availableModels.find((entry) => entry.provider === provider && entry.id === id)?.contextWindow ?? 0;
	})();
	const liveUsed = state.chat.streaming && state.chat.request ? state.chat.request.context : 0;
	const used = Math.max(state.contextUsage?.tokens ?? 0, liveUsed);
	const hasFigures = window_ > 0;
	const pct = hasFigures ? Math.min(100, Math.round((used / window_) * 100)) : 0;
	const color = pct >= 90 ? "var(--destructive)" : pct >= 70 ? "var(--warn)" : "currentColor";
	const radius = 6.5;
	const circumference = 2 * Math.PI * radius;
	const markAt = hasFigures ? Math.min(100, ((window_ - COMPACT_RESERVE_TOKENS) / window_) * 100) : 100;
	// Images are the one thing a context accumulates without anyone deciding
	// to: they arrive as a side effect of reading a screenshot and then ride
	// in every request afterwards. Nothing else in the window says so.
	const images = state.contextUsage?.images;
	const trimmed = images !== undefined && images.sent < images.held;
	const [expanded, setExpanded] = useState(() => storedPreference("context-breakdown", "open") === "open");
	const toggleExpanded = () => {
		setExpanded((open) => {
			storePreference("context-breakdown", open ? "closed" : "open");
			return !open;
		});
	};
	const parts = state.contextUsage?.breakdown?.parts ?? [];
	// While the popover is open, keep its figures current: a reviewer files
	// its spend seconds after the turn settles, and a turn in progress moves
	// the context with every request. Off the moment it closes.
	const [open, setOpen] = useState(false);
	useEffect(() => {
		if (!open) return;
		const timer = setInterval(() => void refreshContextUsage(), CONTEXT_POLL_MS);
		return () => clearInterval(timer);
	}, [open]);
	const compactMark =
		state.autoCompaction && hasFigures
			? { at: markAt, title: `Auto-compacts at ~${shortTokens(window_ - compactReserveFor(window_))}` }
			: undefined;
	return (
		<Popover
			onOpenChange={(opened) => {
				// A fresh snapshot the moment it is looked at, then one every few seconds.
				if (opened) void refreshContextUsage();
				setOpen(opened);
			}}
		>
			<Tip
				label={[
					hasFigures ? `Context ${shortTokens(used)} / ${shortTokens(window_)} (${pct}%)` : "Context window",
					...(images && images.held > 0 ? [`${images.sent} of ${images.held} images sent per request`] : []),
				].join(" · ")}
			>
			<PopoverTrigger asChild>
				<button
					type="button"
					aria-label="Context window"
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
			</Tip>
			<PopoverContent align="end" className="w-[23rem] p-0">
				{/* Context: the figure, the bar, and what rides in it. Click to fold the part-by-part breakdown away. */}
				<section className="px-4 pt-4 pb-3">
					<button
						type="button"
						aria-expanded={expanded}
						onClick={toggleExpanded}
						className="flex w-full cursor-pointer items-baseline justify-between gap-3 text-left"
					>
						<span className="text-sm font-medium">Context window</span>
						<span className="flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground">
							{hasFigures ? (
								<>
									{shortTokens(used)} / {shortTokens(window_)}{" "}
									<strong className="font-semibold text-foreground">({pct}%)</strong>
								</>
							) : (
								<span className="text-faint">fills as the session runs</span>
							)}
							<Chevron open={expanded} variant="header" />
						</span>
					</button>
					{expanded && hasFigures && parts.length > 0 ? (
						<ContextBreakdown
							parts={parts}
							used={used}
							window={window_}
							background={state.backgroundSpend}
							onOpen={(path) => void api.reveal(path)}
							mark={compactMark}
						/>
					) : (
						<>
							{/* Folded, the bar keeps the breakdown's colours, one segment per part; the
							    green fill is only for a chat whose agent reports no parts. */}
							{hasFigures && parts.length > 0 ? (
								<ContextBar parts={parts} window={window_} mark={compactMark} className="mt-2" />
							) : (
								<Bar percent={pct} className="mt-2" mark={compactMark} />
							)}
							{expanded && hasFigures && parts.length === 0 && (
								<p className="mt-2 text-[11px] text-faint">
									No breakdown from the agent behind this chat: it predates the feature. Restart smolt to get one.
								</p>
							)}
						</>
					)}
					{images !== undefined && images.held > 0 && (
						<div className="mt-2.5 text-xs text-muted-foreground">
							<div className="flex items-center justify-between gap-3">
								<span>Images carried in every request</span>
								<span className="tabular-nums text-foreground">
									{trimmed ? `${images.sent} of ${images.held}` : images.held}
								</span>
							</div>
							{trimmed && (
								<p className="mt-0.5 text-faint">Only the most recent are sent; older ones are replaced with a note.</p>
							)}
						</div>
					)}
				</section>

				{state.providerUsage && <SubscriptionUsage usage={state.providerUsage} />}
			</PopoverContent>
		</Popover>
	);
}

/**
 * The colour a fill takes as it nears its limit: green through the ordinary
 * range, warming to amber past the halfway mark and reaching salmon at the
 * top. Continuous rather than stepped, so a bar at 80% already looks more
 * urgent than one at 60%. A limited window is simply full.
 */
function fillColor(percent: number, limited = false): string {
	if (limited) return "var(--salmon)";
	const p = Math.min(100, Math.max(0, percent));
	if (p <= 50) return "var(--ok)";
	if (p <= 75) return `color-mix(in oklab, var(--warn) ${Math.round(((p - 50) / 25) * 100)}%, var(--ok))`;
	return `color-mix(in oklab, var(--salmon) ${Math.round(((p - 75) / 25) * 100)}%, var(--warn))`;
}

/**
 * A thin fill bar: the one visual the popover repeats, so the context window
 * and every allowance window read the same way. The optional mark is a tick
 * at a threshold (where auto-compaction kicks in, say) rather than a second fill.
 */
function Bar({
	percent,
	limited = false,
	mark,
	className,
}: {
	percent: number;
	limited?: boolean;
	mark?: { at: number; title: string };
	className?: string;
}) {
	return (
		<div className={cn("relative h-1.5 rounded-full bg-input/50", className)}>
			<span
				className="absolute inset-y-0 left-0 rounded-full transition-all"
				style={{
					width: `${limited ? 100 : Math.min(100, Math.max(0, percent))}%`,
					background: fillColor(percent, limited),
				}}
			/>
			{mark && (
				<Tip label={mark.title}>
					<span
						className="absolute -top-1 -bottom-1 w-0.5 -translate-x-px rounded-full bg-faint"
						style={{ left: `${mark.at}%` }}
					/>
				</Tip>
			)}
		</div>
	);
}

/** Whole-number percent for display; the pooled mean can carry a long tail. */
function wholePercent(percent: number): number {
	return Math.min(100, Math.max(0, Math.round(percent)));
}

/** Humanize a duration given in hours: "45m", "3h 20m", "2d 4h". */
function formatRemaining(hours: number): string {
	const minutes = Math.max(0, Math.round(hours * 60));
	if (minutes < 60) return `${minutes}m`;
	const h = Math.floor(minutes / 60);
	if (h < 24) {
		const m = minutes % 60;
		return m > 0 ? `${h}h ${m}m` : `${h}h`;
	}
	const d = Math.floor(h / 24);
	const restH = h % 24;
	return restH > 0 ? `${d}d ${restH}h` : `${d}d`;
}

/** Time until an ISO reset instant, humanized; undefined when past or unknown. */
function resetsIn(iso: string | undefined): string | undefined {
	if (!iso) return undefined;
	const at = Date.parse(iso);
	if (Number.isNaN(at)) return undefined;
	const ms = at - Date.now();
	if (ms <= 0) return undefined;
	return formatRemaining(ms / 3_600_000);
}

/**
 * Subscription usage under the upkeep controls, as its own section.
 *
 * Only shown when the active provider actually reports usage: the agent
 * polls live, keeps its own history, and the headline projects when the
 * allowance runs out at the observed drain pace. No data, no section.
 *
 * One row per window in the provider's own order (shortest first): the
 * window's name, when it resets, how much is gone, and a bar saying the
 * same at a glance. Per-account detail is folded away: the pool fails over
 * on its own, so it only matters when someone wonders why the headline
 * looks the way it does.
 */
function SubscriptionUsage({ usage: snapshot }: { usage: ProviderUsageSnapshot }) {
	const state = useApp();
	const activeProvider = state.model.slice(0, Math.max(0, state.model.indexOf("/")));
	const [showAccounts, setShowAccounts] = useState(false);
	// Only the provider the chat is on right now. The agent reports every
	// configured provider's allowances, but the others are not what this
	// chat is drawing on, and a stack of them made the popover a page long.
	const usage =
		[snapshot, ...(snapshot.others ?? [])].find((candidate) => candidate.providerId === activeProvider) ?? snapshot;
	const accounts = usage.accounts ?? [];
	const limitedAccounts = accounts.filter((account) =>
		account.windows.some((window_) => window_.status === "rate-limited"),
	).length;
	return (
		<section className="border-t px-4 pt-3 pb-4">
			<div className="flex items-baseline justify-between gap-3 text-xs text-faint">
				<span className="min-w-0 truncate">
					Usage limits · {usage.providerName}
					{usage.stale && ` · last reading ${formatRemaining((Date.now() - usage.fetchedAt) / 3_600_000)} ago`}
				</span>
				{usage.hoursLeft !== undefined && (
					<span className="shrink-0">~{formatRemaining(usage.hoursLeft)} left</span>
				)}
			</div>
			<div className="mt-2 flex flex-col gap-2.5">
				{usage.windows.map((window_) => (
					<UsageRow key={window_.key} label={window_.label} window_={window_} />
				))}
			</div>
			{accounts.length > 1 && (
				<div className="mt-3">
					<button
						type="button"
						onClick={() => setShowAccounts((open) => !open)}
						className="flex w-full items-center justify-between gap-3 text-xs text-faint transition-colors hover:text-foreground"
					>
						<span>
							Pooled across {accounts.length} accounts
							{limitedAccounts > 0 && ` · ${limitedAccounts} limited`}
						</span>
						<span>{showAccounts ? "Hide" : "Show"}</span>
					</button>
					{showAccounts && (
						<div className="mt-2.5 flex flex-col gap-2.5">
							{accounts.map((account) => {
								const worst = account.windows.reduce<ProviderUsageWindow | undefined>(
									(top, window_) => (top === undefined || window_.percent > top.percent ? window_ : top),
									undefined,
								);
								return (
									<UsageRow
										key={account.label}
										label={worst ? `${account.label} · ${worst.label}` : account.label}
										window_={worst}
									/>
								);
							})}
						</div>
					)}
				</div>
			)}
		</section>
	);
}

/**
 * One allowance window: its name in the lead, the reset time and the share
 * consumed on the right, and a bar underneath. A rate-limited window says
 * "limited" over a full bar rather than a number to interpret.
 */
function UsageRow({ label, window_ }: { label: string; window_: ProviderUsageWindow | undefined }) {
	const limited = window_?.status === "rate-limited";
	const percent = window_ ? wholePercent(window_.percent) : 0;
	const reset = resetsIn(window_?.resetsAt);
	return (
		<div>
			<div className="flex items-baseline justify-between gap-3 text-xs">
				<span className="min-w-0 truncate font-medium text-foreground">{label}</span>
				<span className="flex shrink-0 items-baseline gap-2.5 text-faint">
					{window_ ? (
						<>
							{window_.detail && <span>{window_.detail}</span>}
							{reset && !window_.detail && <span>Resets in {reset}</span>}
							{window_.kind === "balance" && window_.percent === 0 ? null : (
								<span className="font-semibold tabular-nums text-foreground">{percent}%</span>
							)}
							{limited && <span>limited</span>}
						</>
					) : (
						<span>no usage</span>
					)}
				</span>
			</div>
			{/* A balance with no ceiling has nothing to fill a bar against. */}
			{window_?.kind === "balance" && window_.percent === 0 ? null : (
				<Bar percent={percent} limited={limited} className="mt-1 h-1" />
			)}
		</div>
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
				<Button variant="ghost" size="icon" aria-label="Add context and commands">
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

/**
 * The waveform shown in place of the mic icon while recording.
 *
 * Both of its motions are continuous and compositor-side: the track rolls
 * across without end (pure CSS, one pattern drawn twice, sliding by exactly
 * one pattern width), and the bars breathe with the live microphone level
 * (app.voiceLevel) through a --voice-level CSS variable. The variable is
 * written imperatively from a rAF loop, outside React, so the animation
 * never waits on a re-render. The level is also what switches the strip to
 * three still dots when nothing is being heard.
 */
function WaveBars() {
	const track = useRef<SVGGElement>(null);
	useEffect(() => {
		let raf = 0;
		const tick = () => {
			track.current?.style.setProperty("--voice-level", app.voiceLevel.toFixed(3));
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, []);
	const level = useApp().voiceLevel;
	const pattern = [7, 13, 5, 10];
	if (level < 0.05) {
		return (
			<svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
				<g fill="currentColor">
					{[3, 8, 13].map((x) => (
						<circle key={x} cx={x} cy={8} r={1.5} />
					))}
				</g>
			</svg>
		);
	}
	const bars = [...pattern, ...pattern];
	return (
		<svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
			<g ref={track} className="voice-wave-track" fill="currentColor">
				{bars.map((height, index) => (
					<rect key={index} x={index * 4 + 1} y={8 - height / 2} width={2} height={height} rx={1} />
				))}
			</g>
		</svg>
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
				// The device list lives on navigator.mediaDevices, which is absent
				// outside a secure context (plain HTTP from another machine) —
				// reaching for it took the whole window down.
				navigator.mediaDevices
					?.enumerateDevices()
					.then((all) => setDevices(all.filter((device) => device.kind === "audioinput")))
					.catch(() => toast("Could not list microphones. Check the system permission for smolt.", "error"));
			}}
		>
			{/* Menu trigger outside the tooltip. The other way round, the tooltip's
			    own pointer-down and click handlers wrap the menu's toggle, and a
			    control hovered long enough to show its tip opened and shut again in
			    the same click. */}
			<DropdownMenuTrigger asChild>
				<Tip label="Microphone">
					<Button variant="ghost" size="icon" aria-label="Microphone" className="w-4">
						<Icon name="chevron" className="rotate-90" />
					</Button>
				</Tip>
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
							<Icon name="check" className="text-tint-text" />
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
	useApp();
	// Only this chat's own question: a background chat's approval waits there.
	const request = approvalsHere()[0];
	if (!request) return null;
	return (
		<div
			className={cn(
				"mb-2 flex items-center gap-3 rounded-xl border border-tint bg-card px-3 py-2.5",
				request.danger && "border-destructive bg-destructive/5",
			)}
		>
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="font-mono text-sm text-tint-text">
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
	const state = useApp();
	// This chat's queue. Another chat's waiting messages are its own business.
	const queued = queuedHere();
	// A Send now empties the queue at once, but the message only lands at the
	// next tool boundary; the banner stays up for that wait rather than
	// blinking out as though the message had already been read.
	const flushing = flushingHere();
	if (queued.length === 0 && flushing === null) return null;
	const count = flushing?.count ?? queued.length;
	const label = flushing?.label ?? queued[0]?.label ?? "";
	return (
		<div className="mb-1.5 flex items-center gap-2.5 rounded-xl border bg-card py-2 pr-2 pl-3">
			<span className="flex-none text-sm font-semibold">
				{count} message{count === 1 ? "" : "s"} queued
			</span>
			<span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-sm text-faint">
				{label}
			</span>
			{/* Queueing is the safe default; this is the way out of it when the
			    reader can see their message should not wait for the turn. */}
			<Tip label="Send at the next step, without waiting for the turn to finish">
			<Button
				variant="ghost"
				size="sm"
				// Waiting is the same control in a disabled state, not a different
				// coloured one: only the label and the spinner say it is busy.
				className="h-6 flex-none px-2 text-xs text-muted-foreground hover:text-foreground"
				disabled={flushing !== null || state.sendingQueuedNow}
				onClick={() => void sendQueuedNow()}
			>
				{flushing !== null ? (
					<>
						Sending after next tool call
						<Icon name="spinner" className="animate-spin" />
					</>
				) : (
					"Send now"
				)}
			</Button>
			</Tip>
			<Tip label="Discard queued messages">
				<Button
					variant="ghost"
					size="icon"
					className="size-6"
					aria-label="Discard queued messages"
					disabled={flushing !== null || state.sendingQueuedNow}
					onClick={() => void clearQueued()}
				>
					<Icon name="close" />
				</Button>
			</Tip>
		</div>
	);
}

/** Project, branch and change count, with a way into the diff. */
function RepoBar() {
	const state = useApp();
	const changed = state.diffChanged;
	const folder = projectName();
	// The scope is the branch, so the bar follows the branch rather than the
	// conversation: work spread over several chats reads as one piece, which is
	// how it will be reviewed and how it will be merged.
	//
	// A folder git cannot answer for gets no bar at all: there is nothing to
	// compare against, so the bar has nothing useful to say.
	// A new chat has nothing to review yet: the bar belongs to a conversation in
	// progress, not to the empty landing page.
	const newChat = state.chatEmpty && state.chat.messages.length === 0;
	const showing =
		!newChat && changed > 0 && state.diffUnavailable === "" && state.repoBarDismissed === null;
	if (!showing) return null;
	const added = state.diffAdded;
	const removed = state.diffRemoved;
	return (
		<div className="mb-1.5 flex min-w-0 items-center gap-2.5 overflow-hidden rounded-xl border bg-card py-1.5 pr-2 pl-3 text-sm">
			{/* The names give way first when the column is narrow (a side pane
			    open, say); the counts and the buttons keep their room, so the bar
			    never spills past its own edge. */}
			<ProjectName folder={folder} />
			{state.repoBranch !== "" && <BranchName branch={state.repoBranch} />}
			{/* The counts are the way into the diff now that the review button is
			    gone: they already name what there is to look at, so making them the
			    control costs no width and loses no path to the pane. */}
			{/* The app's own tooltip, not a native title on the bar: the native one
			    is a square system box that showed up beside the styled ones. */}
			<Tip
				label={
					`${changed} file${changed === 1 ? "" : "s"} changed on ${state.repoBranch || "this branch"} in ${folder}` +
					`${state.repoBaseBranch ? `, measured against ${state.repoBaseBranch}` : ", against the last commit"}.`
				}
			>
				<button
					type="button"
					onClick={() => toggleDiffPane(true)}
					aria-label="View diff"
					className="ml-auto flex flex-none cursor-pointer gap-1.5 rounded-lg bg-ok/10 px-2 py-0.5 font-mono text-xs tabular-nums transition-colors hover:bg-ok/20"
				>
					<span className="text-ok">+{added.toLocaleString()}</span>
					<span className="text-destructive">−{removed.toLocaleString()}</span>
				</button>
			</Tip>
			<CreatePrButton />
			<Button
				variant="ghost"
				size="icon"
				className="size-6 flex-none"
				aria-label="Hide the changes bar"
				onClick={() => {
					// Remember what was dismissed, so only a further change brings it back.
					app.repoBarDismissed = diffSignature();
					bump();
				}}
			>
				<Icon name="close" />
			</Button>
		</div>
	);
}

/** The three ways this bar will open a pull request. */
type PrMode = "pr" | "draft" | "manual";

const PR_MODE_LABEL: Record<PrMode, string> = {
	pr: "Create PR",
	draft: "Create draft PR",
	manual: "Manually create PR",
};

/**
 * Open a pull request for the branch, in whichever of the three ways.
 *
 * A split control: the button does the chosen thing, the chevron changes
 * which thing that is. The choice sticks, because someone who works in
 * drafts works in drafts every time, and re-picking it daily is a tax.
 */
function CreatePrButton() {
	const state = useApp();
	const [mode, setMode] = useState<PrMode>(() => {
		const stored = storedPreference("smolt.prMode", "pr");
		return stored === "draft" || stored === "manual" ? stored : "pr";
	});
	const [busy, setBusy] = useState(false);

	// Nothing to merge means no pull request: on the default branch, or on a
	// branch whose work is still uncommitted, the button would only ever fail.
	if (state.repoBaseBranch === "" || !state.repoHasCommits) return null;

	const run = (which: PrMode): void => {
		if (which === "manual") {
			void api.prReadiness().then((result) => {
				const url = (result.value as { compareUrl?: string } | undefined)?.compareUrl;
				if (!url) {
					toast("No GitHub remote to open a pull request against.", "error");
					return;
				}
				// Main routes window.open to the real browser; a compare page is
				// something to finish in GitHub, not inside the app.
				window.open(url, "_blank", "noopener");
			});
			return;
		}
		setBusy(true);
		void api
			.prCreate(which === "draft")
			.then((result) => {
				if (!result.ok) {
					toast(result.error ?? "Could not create the pull request.", "error");
					return;
				}
				toast(which === "draft" ? "Draft pull request created." : "Pull request created.");
			})
			.finally(() => setBusy(false));
	};

	return (
		<span className="flex flex-none items-stretch">
			<Tip
				label={`${PR_MODE_LABEL[mode]} for ${state.repoBranch} into ${state.repoBaseBranch.replace(/^origin\//, "")}`}
			>
				<Button
					variant="outline"
					size="sm"
					disabled={busy}
					className="whitespace-nowrap rounded-r-none border-r-0"
					onClick={() => run(mode)}
				>
					{busy ? <Icon name="spinner" className="animate-spin" /> : null}
					{PR_MODE_LABEL[mode]}
				</Button>
			</Tip>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						variant="outline"
						size="sm"
						disabled={busy}
						aria-label="Pull request options"
						className="rounded-l-none px-1.5"
					>
						<Icon name="chevron" className="rotate-90" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="min-w-52">
					{(Object.keys(PR_MODE_LABEL) as PrMode[]).map((option) => (
						<DropdownMenuItem
							key={option}
							onSelect={() => {
								setMode(option);
								storePreference("smolt.prMode", option);
								run(option);
							}}
						>
							<Icon name="branch" className="text-faint" />
							{PR_MODE_LABEL[option]}
							{option === mode && <Icon name="check" className="ml-auto text-tint-text" />}
						</DropdownMenuItem>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
		</span>
	);
}

/**
 * The working directory in the repo bar, carrying the project menu.
 *
 * The name gives way first when the column is narrow, so it truncates and
 * keeps the whole path in the tooltip; the menu is the same one the titlebar
 * pill and the folder chip open, because a reader who learns it once should
 * not have to learn where each copy stops short.
 */
function ProjectName({ folder }: { folder: string }) {
	const state = useApp();
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Tip label={state.appInfo.cwd}>
					<button
						type="button"
						aria-label={`Project folder ${folder}`}
						className="flex min-w-0 max-w-[40%] flex-none cursor-pointer items-center truncate rounded-md px-1 py-0.5 transition-colors hover:bg-accent data-[state=open]:bg-accent"
					>
						<span className="min-w-0 truncate">{folder}</span>
					</button>
				</Tip>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="min-w-56">
				<ProjectMenuItems />
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/**
 * The branch this chat is working on, and the two things a reader wants from
 * it: the name to paste, and a shell in the same place.
 *
 * It used to copy on click, which is the more common of the two but left the
 * other with nowhere to live, and gave a reader no way to find out what the
 * click would do before making it. A menu says both out loud.
 */
function BranchName({ branch }: { branch: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Tip label={copied ? "Copied" : branch}>
					<button
						type="button"
						aria-label={`Branch ${branch}`}
						// Only as wide as the name: stretching to fill the bar made the
						// hover highlight look like it belonged to the whole row.
						className="flex min-w-0 max-w-full shrink cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 font-mono text-xs text-faint transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
					>
						<Icon name={copied ? "check" : "branch"} className={copied ? "text-ok" : undefined} />
						<span className="min-w-0 truncate">{branch}</span>
					</button>
				</Tip>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="min-w-48">
				<DropdownMenuItem
					onSelect={() => {
						void api.copyText(branch).then((result) => {
							if (!result.ok) {
								toast(result.error ?? "Could not copy that.", "error");
								return;
							}
							setCopied(true);
							setTimeout(() => setCopied(false), 1200);
						});
					}}
				>
					Copy branch name
				</DropdownMenuItem>
				<DropdownMenuItem
					onSelect={() => {
						void api.reveal(app.appInfo.cwd, "terminal").then((result) => {
							if (!result.ok) toast(result.error ?? "No terminal could be opened here.", "error");
						});
					}}
				>
					Open in terminal
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
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
	hidden,
	children,
}: {
	items: PaletteItem[];
	selected: number;
	/** Set when the reader dismissed the palette for the current query. */
	hidden: boolean;
	children: React.ReactNode;
}) {
	const listRef = useRef<HTMLDivElement>(null);
	// Arrow keys move the selection; the list follows it.
	useEffect(() => {
		listRef.current?.querySelector("[data-selected=true]")?.scrollIntoView({ block: "nearest" });
	}, [selected]);
	return (
		<Popover open={items.length > 0 && !hidden}>
			<PopoverAnchor asChild>{children}</PopoverAnchor>
			<PopoverContent
				ref={listRef}
				side="top"
				align="start"
				className="max-h-72 w-[28rem] max-w-[90vw] overflow-x-hidden overflow-y-auto p-1.5"
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
						{/* The title shrinks and ellipsifies before the description, so a
						    long command name can never push the row into a horizontal
						    scroll: the palette is read, not panned. */}
						<span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-medium">
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
	const mirrorRef = useRef<HTMLDivElement>(null);
	const [dropping, setDropping] = useState(false);
	const [paletteIndex, setPaletteIndex] = useState(0);
	/**
	 * Whether the reader dismissed the palette for the current query.
	 *
	 * The palette's open state is derived from the draft: a "/" in it is
	 * what summons the list, so Escape and an outside click need somewhere
	 * to record "dismissed" until the draft changes again, or the list would
	 * ignore them entirely.
	 */
	const [paletteHidden, setPaletteHidden] = useState(false);
	const historyIndexRef = useRef(-1);
	const historyDraftRef = useRef("");
	/** 1-based position shown in the badge; null when not recalling. */
	const [historyPos, setHistoryPos] = useState<number | null>(null);
	/**
	 * Move the history cursor. The ref is what the key handler reads (two fast
	 * presses must not both see the same stale value); the state is what the
	 * badge renders. Both move here so they cannot disagree.
	 */
	const setHistoryIndex = (index: number): void => {
		historyIndexRef.current = index;
		setHistoryPos(index === -1 ? null : index + 1);
	};

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

	// Where the caret is, so an "@" typed in the middle of a sentence offers
	// files too. Read off the textarea rather than guessed from the draft.
	const [caret, setCaret] = useState(0);
	const readCaret = (): void => setCaret(inputRef.current?.selectionStart ?? 0);

	// "@" mentions a file. The token runs from an "@" at the start of the draft
	// or after a space, up to the caret: "@src/mai" is a query, an email address
	// in the middle of a word is not.
	const mentionMatch = /(?:^|\s)@([^\s]*)$/.exec(state.draft.slice(0, caret));
	const mentionQuery = mentionMatch ? (mentionMatch[1] ?? "") : null;
	const [mentionFiles, setMentionFiles] = useState<string[]>([]);
	useEffect(() => {
		if (mentionQuery === null) {
			setMentionFiles([]);
			return;
		}
		let live = true;
		void api.projectFiles(mentionQuery).then((files) => {
			if (live) setMentionFiles(files);
		});
		return () => {
			live = false;
		};
	}, [mentionQuery]);

	/** Put a chosen path in the draft in place of the "@…" being typed. */
	const insertMention = (path: string): void => {
		const before = state.draft.slice(0, caret);
		const start = before.lastIndexOf("@");
		if (start === -1) return;
		const replaced = `${before.slice(0, start)}@${path} `;
		app.draft = replaced + state.draft.slice(caret);
		bump();
		const input = inputRef.current;
		input?.focus();
		requestAnimationFrame(() => {
			input?.setSelectionRange(replaced.length, replaced.length);
			setCaret(replaced.length);
		});
	};

	// A leading "/" opens the palette; "/resume …" keeps it open across spaces
	// so past conversations can be searched and continued from right here.
	const paletteMatch = /^\/(\S*)$/.exec(state.draft) ?? /^\/(resume\s+.*)$/i.exec(state.draft);
	const paletteQuery = paletteMatch ? (paletteMatch[1] ?? "") : null;
	useEffect(() => {
		if (paletteQuery !== null) void ensureCommands();
		// A new query means a new list; selection starts back at the top and
		// any dismissal is forgotten.
		setPaletteIndex(0);
		setPaletteHidden(false);
	}, [paletteQuery, mentionQuery]);

	// An outside click dismisses the palette: it is a suggestion popup, not
	// a panel that holds its ground against the rest of the app. Clicking
	// back into the composer brings it back, since the "/" is still there.
	useEffect(() => {
		if (paletteQuery === null || paletteHidden) return;
		const onPointerDown = (event: PointerEvent): void => {
			const target = event.target as HTMLElement | null;
			if (target?.closest('[data-slot="popover-content"]')) return;
			if (target?.closest("textarea")) return;
			setPaletteHidden(true);
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [paletteQuery, paletteHidden]);

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
			if (result) {
				void api.reveal(result.path, "reveal");
				toast(`Session exported to ${result.path}`);
			}
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

	// Files first: an "@" being typed is a file question, whatever else the
	// draft holds. Each row inserts its path and leaves the draft to be sent.
	const mentionItems: PaletteItem[] = mentionFiles.map((path) => ({
		title: path.slice(path.lastIndexOf("/") + 1),
		plain: true,
		description: path,
		kind: "insert" as const,
		run: () => insertMention(path),
	}));

	const paletteItems: PaletteItem[] = mentionQuery !== null ? mentionItems : counted((() => {
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
	// Recording or decoding: the send button stays live and its click stops
	// dictation, waits out the decode, then sends.
	const dictating = state.voiceActive || state.voiceFinishing || voiceTranscribing();

	return (
		<div className="relative mx-auto w-full max-w-[804px] px-8 pb-3.5 @container">
			{state.agentLost && (
				<div className="mb-1.5 flex items-center gap-2.5 rounded-xl border border-warn bg-warn/5 py-2 pr-2 pl-3 text-sm">
					<span className="min-w-0 flex-1 text-muted-foreground">
						The agent stopped unexpectedly and was restarted. If a reply was cut off, send it again.
					</span>
				</div>
			)}
			<ApprovalCard />
			<QueuedBanner />
			{state.chat.messages.length === 0 && <FolderBar />}
			<RepoBar />
			<div
				className={cn(
					"flex flex-col gap-2 rounded-xl border bg-card p-3.5 pb-2.5 shadow-lg transition-colors focus-within:border-border-strong",
					dropping && "border-tint bg-primary/5",
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
							<Tip key={index} label={item.name}>
							<div className="group/att relative size-14 overflow-hidden rounded-lg border bg-background-deep">
								<img src={item.url} alt={item.name} className="block h-full w-full object-cover" />
								<button
									type="button"
									aria-label={`Remove ${item.name}`}
									className="absolute top-1 right-1 flex size-4.5 items-center justify-center rounded-full bg-black/70 text-white opacity-0 transition-opacity hover:bg-destructive group-hover/att:opacity-100"
									onClick={() => removeAttachment(index)}
								>
									<Icon name="close" className="[&>svg]:size-3" />
								</button>
							</div>
							</Tip>
						))}
					</div>
				)}
				{historyPos !== null && (
					<div className="px-0.5 text-[11px] leading-none text-faint">
						History {historyPos}/{promptHistory.length}
					</div>
				)}
				<CommandPalette
					items={paletteItems}
					selected={Math.min(paletteIndex, Math.max(0, paletteItems.length - 1))}
					hidden={paletteHidden}
				>
					<div className="relative">
					<textarea
						ref={inputRef}
						rows={1}
						value={state.draft}
						placeholder={
							state.chat.streaming
								? state.enterSendsQueued
									? "Queue a message for when it finishes…"
									: "Send a message to the running turn…"
								: "Type / for commands, @ for files"
						}
						className={cn(
							"relative max-h-60 min-h-[26px] w-full resize-none bg-transparent px-0.5 pb-1 text-sm leading-relaxed [scrollbar-gutter:stable] outline-none placeholder:text-faint",
						)}
						// Clicking back into the composer with the "/" still in it brings
						// the palette back up after a dismissal. This listens for the click
						// rather than for focus, because clicking empty space to dismiss the
						// palette also refocuses the composer (App focuses it terminal-style)
						// — on focus, every dismissal would undo itself a tick later.
						onPointerDown={() => {
							setPaletteHidden(false);
							requestAnimationFrame(readCaret);
						}}
						// Every caret move can start or end an "@" token, so the file
						// list follows the cursor as well as the text.
						onSelect={readCaret}
						onChange={(event) => {
							app.draft = event.target.value;
							setCaret(event.target.selectionStart ?? event.target.value.length);
							setHistoryIndex(-1);
							// Editing the draft is what the palette listens to; a change
							// also revokes a dismissal, since the query moved on.
							setPaletteHidden(false);
							// Only the composer reads the draft; waking the transcript to add
							// one character is what made typing feel behind the keyboard.
							bumpDraft();
						}}
						onKeyDown={(event) => {
							const input = event.currentTarget;
							// With the palette open, a bare digit picks that entry.
							// Not while a file is being named: a digit there belongs to the
							// path being typed.
							if (
								paletteItems.length > 0 &&
								mentionQuery === null &&
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
								const sendMode = modeForEvent(event);
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
								setHistoryIndex(-1);
								sendClosingVoice(sendMode);
								return;
							}
							if (event.key === "Escape") {
								// The palette yields to Escape before anything else: with a
								// list up, Esc means "put that away", not "stop the turn".
								if (paletteItems.length > 0 && !paletteHidden) {
									event.preventDefault();
									setPaletteHidden(true);
									return;
								}
								if (state.chat.streaming) void call("abort");
								return;
							}
							// Up/Down recall previous prompts, but only from the edges of
							// the text so multi-line editing still works normally.
							if (event.key === "ArrowUp" && input.selectionStart === 0 && promptHistory.length > 0) {
								if (historyIndexRef.current === -1) historyDraftRef.current = state.draft;
								setHistoryIndex(
									historyIndexRef.current === -1
										? promptHistory.length - 1
										: Math.max(0, historyIndexRef.current - 1),
								);
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
									setHistoryIndex(-1);
									app.draft = historyDraftRef.current;
								} else {
									setHistoryIndex(historyIndexRef.current + 1);
									app.draft = promptHistory[historyIndexRef.current] ?? "";
								}
								bump();
							}
						}}
					/>
					</div>
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
												? "Microphone unavailable. Open the setting"
												: state.voiceError !== ""
													? state.voiceError
													: state.voiceSilent !== ""
														? `No sound reached ${state.voiceSilent}. Choose another microphone in the menu beside this button.`
														: "Dictate (Ctrl+M)"
								}
								className={cn(
									"relative",
									state.voiceActive && "bg-tint/10 text-tint hover:bg-tint/10 hover:text-tint",
									state.voiceSilent !== "" && !state.voiceActive && "text-destructive",
									state.voiceError !== "" && !state.voiceActive && "text-destructive",
								)}
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
							<Icon
								name={state.voicePreparing || state.voiceFinishing ? "spinner" : "mic"}
								className={cn(
									state.voiceActive ? "hidden" : undefined,
									(state.voicePreparing || state.voiceFinishing) && "text-primary",
									// Preparing and transcribing show the spinner arc in motion:
									// a static arc reads as a broken glyph, not as work in flight.
									(state.voicePreparing || state.voiceFinishing) && "animate-spin",
								)}
							/>
							{/* While recording, the icon gives way to a waveform strip that
							    rolls across without end: the words are not decoded until
							    the stop, so the strip is the honest thing to show. Dots while the mic
						    hears nothing, a rolling track that breathes with the voice
						    once it does. */}
							{state.voiceActive && <WaveBars />}
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
						    none. While dictating or transcribing, send wins even during a
						    turn: the words are about to land, and send waits for them
						    before sending. Esc still stops at any time. */}
						{(() => {
							const showStop = state.chat.streaming && !canSend && !dictating;
							const stopping = showStop && state.aborting;
							const sendLabel = stopping
								? "Stopping…"
								: showStop
									? "Stop (Esc)"
									: state.chat.streaming
										? enterSendMode() === "queue"
											? "Send to queue (Ctrl+Enter sends now)"
											: "Send now (Ctrl+Enter queues)"
										: dictating
											? "Stop and send"
											: "Send";
							return (
								<Tip label={sendLabel} side="top">
								<Button
									size="icon"
									variant="ghost"
									aria-label={sendLabel}
									disabled={stopping || (!state.chat.streaming && !canSend && !dictating)}
									// Send and stop are one quiet control in two states: a bare glyph
									// in the text colour, a faint hover, no disc and no accent. The
									// message is the loud part.
									className="rounded-full text-foreground hover:bg-accent active:scale-95 disabled:text-faint"
									onClick={(event) => {
										if (showStop) {
											void abortTurn();
											return;
										}
										setHistoryIndex(-1);
										sendClosingVoice(modeForEvent(event));
									}}
								>
									<Icon name={stopping ? "spinner" : showStop ? "stop" : "send"} className={cn(stopping && "animate-spin")} />
								</Button>
								</Tip>
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
