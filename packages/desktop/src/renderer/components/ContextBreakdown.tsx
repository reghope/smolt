import { useState } from "react";
import { cn } from "../lib/cn.ts";
import type { BackgroundSpend, ContextPart } from "../state/app.ts";
import { Tip } from "./ui/tooltip.tsx";

/**
 * A disclosure arrow. The header's points down when closed and up when
 * open; a group's points right when closed and down when open.
 */
export function Chevron({ open, variant = "group" }: { open: boolean; variant?: "header" | "group" }) {
	const closed = variant === "header" ? "rotate-0" : "-rotate-90";
	const opened = variant === "header" ? "rotate-180" : "rotate-0";
	return (
		<svg
			aria-hidden="true"
			viewBox="0 0 16 16"
			className={cn("size-3.5 shrink-0 text-faint transition-transform", open ? opened : closed)}
		>
			<path d="M3.5 6 8 10.5 12.5 6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
		</svg>
	);
}

/**
 * One colour per part, fixed rather than themed, so the legend reads the
 * same in both themes and the same as the bar.
 */
const PART_COLORS: Record<string, string> = {
	messages: "#3b82f6",
	systemTools: "#f97316",
	extensionTools: "#14b8a6",
	systemPrompt: "#8b5cf6",
	skills: "#ec4899",
	contextFiles: "#22c55e",
};

const FREE_COLOR = "var(--input)";

/**
 * The window as a bar: one segment per part in the part's colour, the free
 * space behind them, and the optional tick where auto-compaction kicks in.
 * The breakdown draws it above its legend, and the popover draws the same
 * bar when the breakdown is folded away, so the context reads in the same
 * colours whether or not the parts are listed.
 */
export function ContextBar({
	parts,
	window: window_,
	mark,
	className,
}: {
	parts: ContextPart[];
	window: number;
	mark?: { at: number; title: string };
	className?: string;
}) {
	const segments = parts
		.filter((part) => part.tokens > 0)
		.map((part) => ({
			key: part.key,
			color: PART_COLORS[part.key] ?? "var(--faint)",
			percent: window_ > 0 ? (part.tokens / window_) * 100 : 0,
		}));
	return (
		<div
			className={cn("relative flex h-1.5 overflow-hidden rounded-full", className)}
			style={{ background: FREE_COLOR }}
			data-testid="context-bar"
		>
			{segments.map((segment) => (
				<span
					key={segment.key}
					className="h-full shrink-0 transition-all"
					style={{ width: `${Math.min(100, segment.percent)}%`, background: segment.color }}
				/>
			))}
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

/** "CLAUDE.md · OneDrive - Reiver AI": the file, then the folder it sits in, so a row fits where a full path would not. */
export function fileLabel(path: string): string {
	const parts = path.split(/[\\/]/).filter((part) => part !== "");
	const file = parts.pop() ?? path;
	const folder = parts.pop();
	return folder ? `${file} · ${folder}` : file;
}

/** Below this share of the window, the parts get a second bar scaled to what is in use. */
const MAGNIFY_BELOW = 0.5;

/** "201.4k", "26k", "752.6k", "1M", "673" — sized like the numbers in a legend. */
export function tokensLabel(total: number): string {
	const oneDecimal = (value: number) => value.toFixed(1).replace(/\.0$/, "");
	if (total >= 1_000_000) return `${oneDecimal(total / 1_000_000)}M`;
	if (total >= 1000) return `${oneDecimal(total / 1000)}k`;
	return String(Math.round(total));
}

/**
 * The context window part by part: a bar with one segment per part, a row
 * per part with its size and share of the window, then the free space.
 * When what is in use is a sliver of the window, the segments are too thin
 * to tell apart, so a second, magnified bar shows the same parts scaled to
 * what is in use rather than to the whole window. Below that, the parts
 * made of named pieces — the tools, the context files — start folded and
 * open to list them largest first, so the one tool with a novel-length
 * schema is easy to find. Whatever else spends on the session's behalf
 * outside this window — a research team, an advisor reading along — sits
 * in the same list under the free space, with its requests and cost in
 * place of a share.
 */
export function ContextBreakdown({
	parts,
	used,
	window: window_,
	mark,
	background = [],
	onOpen,
}: {
	parts: ContextPart[];
	used: number;
	window: number;
	mark?: { at: number; title: string };
	background?: BackgroundSpend[];
	/** Opens a context file in the editor; each file row becomes a link when given. */
	onOpen?: (path: string) => void;
}) {
	const [opened, setOpened] = useState<Record<string, boolean>>({});
	const share = (tokens: number) => (window_ > 0 ? (tokens / window_) * 100 : 0);
	const shareLabel = (tokens: number) => {
		const value = share(tokens);
		return value === 0 ? "0%" : value < 0.1 ? "<0.1%" : `${value.toFixed(1)}%`;
	};
	const free = Math.max(0, window_ - used);
	const groups = parts.filter((part) => (part.items?.length ?? 0) > 0);
	// Under half the window, the parts are slivers on the window bar; show
	// them magnified to what is in use so their proportions can be read.
	const magnify = used > 0 && window_ > 0 && used / window_ < MAGNIFY_BELOW;
	const magnified = parts
		.filter((part) => part.tokens > 0)
		.map((part) => ({ key: part.key, color: PART_COLORS[part.key] ?? "var(--faint)", percent: (part.tokens / used) * 100 }));
	return (
		<div className="mt-2">
			<ContextBar parts={parts} window={window_} mark={mark} />
			{magnify && (
				<div className="mt-2.5" data-testid="context-magnified">
					<div className="mb-1 flex items-baseline justify-between text-[11px] text-faint">
						<span>In use, magnified</span>
						<span className="tabular-nums">{tokensLabel(used)}</span>
					</div>
					<div className="flex h-3 gap-px overflow-hidden rounded-[3px]">
						{magnified.map((segment) => (
							<span
								key={segment.key}
								className="h-full min-w-px shrink-0 transition-all"
								style={{ width: `calc(${Math.min(100, segment.percent)}% - 1px)`, background: segment.color }}
							/>
						))}
					</div>
				</div>
			)}

			<ul className="mt-3 flex flex-col gap-[3px] text-xs">
				{parts.map((part) => (
					<li key={part.key} className="flex items-center gap-2">
						<span
							className="size-2 shrink-0 rounded-[2px]"
							style={{ background: PART_COLORS[part.key] ?? "var(--faint)" }}
						/>
						<span className="flex-1 truncate font-medium">{part.label}</span>
						<span className="w-14 text-right tabular-nums text-muted-foreground">{tokensLabel(part.tokens)}</span>
						<span className="w-12 text-right font-semibold tabular-nums">{shareLabel(part.tokens)}</span>
					</li>
				))}
				<li className="flex items-center gap-2">
					<span className="size-2 shrink-0 rounded-[2px]" style={{ background: FREE_COLOR }} />
					<span className="flex-1 font-medium">Free space</span>
					<span className="w-14 text-right tabular-nums text-muted-foreground">{tokensLabel(free)}</span>
					<span className="w-12 text-right font-semibold tabular-nums">{shareLabel(free)}</span>
				</li>
				{background.map((spend) => (
					<li key={spend.key} className="flex items-center gap-2" title="Spent on this chat outside its window">
						<span className="size-2 shrink-0 rounded-[2px] border border-faint" />
						<span className="flex-1 truncate font-medium">{spend.label}</span>
						<span className="shrink-0 tabular-nums text-faint">
							{spend.requests} request{spend.requests === 1 ? "" : "s"}
						</span>
						<span className="w-14 text-right tabular-nums text-muted-foreground">{tokensLabel(spend.tokens)}</span>
						<span className="w-12 text-right font-semibold tabular-nums">
							{spend.cost >= 0.005 ? `$${spend.cost.toFixed(2)}` : "—"}
						</span>
					</li>
				))}
			</ul>

			{groups.length > 0 && (
				<div className="mt-2.5 flex flex-col gap-1 border-t pt-2.5 text-xs">
					{groups.map((part) => {
						const items = part.items ?? [];
						const open = opened[part.key] === true;
						return (
							<div key={part.key}>
								<button
									type="button"
									aria-expanded={open}
									onClick={() => setOpened((current) => ({ ...current, [part.key]: !open }))}
									className="flex w-full cursor-pointer items-center gap-1.5 rounded-sm text-left hover:bg-accent/60"
								>
									<Chevron open={open} />
									<span className="flex-1 truncate font-medium">{part.label}</span>
									<span className="w-14 text-right tabular-nums text-muted-foreground">{tokensLabel(part.tokens)}</span>
									<span className="w-8 text-right tabular-nums text-muted-foreground">{items.length}</span>
								</button>
								{open && (
									<ul className="mt-0.5 mb-1 max-h-44 overflow-y-auto pl-5 text-muted-foreground">
										{items.map((item) => (
											<li key={`${item.source ?? ""}/${item.name}`} className="flex items-center gap-2 leading-5">
												{part.key === "contextFiles" && onOpen ? (
													<button
														type="button"
														title={item.name}
														onClick={() => onOpen(item.name)}
														className="flex-1 cursor-pointer truncate text-left hover:text-foreground hover:underline"
													>
														{fileLabel(item.name)}
													</button>
												) : (
													<span className="flex-1 truncate" title={item.name}>
														{item.source && item.source !== item.name ? `${item.source} · ${item.name}` : item.name}
													</span>
												)}
												<span className="w-14 shrink-0 text-right tabular-nums">{tokensLabel(item.tokens)}</span>
												<span className="w-8 shrink-0" />
											</li>
										))}
									</ul>
								)}
							</div>
						);
					})}
				</div>
			)}

		</div>
	);
}
