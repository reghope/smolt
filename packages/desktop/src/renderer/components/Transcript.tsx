import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { icon } from "../icons.ts";
import { api } from "../lib/api.ts";
import { cn } from "../lib/cn.ts";
import { EmptyChat } from "./EmptyChat.tsx";
import { formatElapsed, formatTokens } from "../lib/format.ts";
import { renderMarkdown } from "../markdown.ts";
import { app, loadEarlier, rewindToUserMessage, toast } from "../state/app.ts";
import { useApp } from "../state/useApp.ts";
import type { ChatMessage, ToolBlock } from "../store.ts";
import { thinkingSummary } from "../thinking.ts";
import { Button } from "./ui/button.tsx";
import { Icon } from "./ui/icon.tsx";
import { ImageCard, LinkPreviewCard, standaloneLinks } from "./MediaCards.tsx";

/**
 * The transcript: prose flush left, user turns as cards on the right, tool
 * runs folded into one summary line. Reasoning never renders here — it is
 * condensed into the working line's live stage phrase instead.
 */

/** The human sentence a tool call was made under, when it carries one. */
function toolDescription(block: ToolBlock): string {
	try {
		const parsed = JSON.parse(block.args || "{}") as Record<string, unknown>;
		const described = parsed.description ?? parsed.title;
		if (typeof described === "string" && described.trim() !== "") return described.trim();
	} catch {
		// fall through to the generic label
	}
	return "";
}

function summarizeArgs(raw: string): string {
	try {
		const parsed = JSON.parse(raw || "{}");
		const value =
			parsed.command ?? parsed.file_path ?? parsed.path ?? parsed.query ?? parsed.message ?? parsed.pattern ?? "";
		return String(value).slice(0, 80);
	} catch {
		return raw.slice(0, 80);
	}
}

/** "Ran 4 commands, edited 2 files", or the sentence a lone call carries. */
function toolGroupLabel(blocks: ToolBlock[]): string {
	if (blocks.length === 1) {
		const only = blocks[0]!;
		const described = toolDescription(only);
		if (described) return described;
		const args = summarizeArgs(only.args);
		return args ? `${only.name}(${args})` : `Used ${only.name}`;
	}
	const commands = blocks.filter((block) => block.name.toLowerCase().includes("bash")).length;
	const edits = blocks.filter((block) => /^(write|edit|multiedit)$/i.test(block.name)).length;
	const rest = blocks.length - commands - edits;
	const parts: string[] = [];
	if (commands > 0) parts.push(`Ran ${commands === 1 ? "a command" : `${commands} commands`}`);
	if (edits > 0) parts.push(`edited ${edits === 1 ? "a file" : `${edits} files`}`);
	if (rest > 0) parts.push(`used ${rest} ${rest === 1 ? "tool" : "tools"}`);
	const label = parts.join(", ");
	return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * Which disclosures the reader has opened, by stable key. The transcript
 * re-renders on every streaming delta; without this a tool group opened
 * mid-turn would slam shut exactly when someone is reading it.
 */
export const openDisclosures = new Set<string>();

function Disclosure({
	dkey,
	className,
	children,
}: {
	dkey: string;
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<details
			className={className}
			open={openDisclosures.has(dkey)}
			data-key={dkey}
			onToggle={(event) => {
				const details = event.currentTarget;
				if (details.open) openDisclosures.add(dkey);
				else openDisclosures.delete(dkey);
			}}
		>
			{children}
		</details>
	);
}

function ToolRow({ block, dkey }: { block: ToolBlock; dkey: string }) {
	const state = block.running ? "running" : block.isError ? "error" : "done";
	return (
		<Disclosure dkey={dkey} className="group/tool mb-2 font-mono">
			<summary className="flex cursor-pointer list-none select-none items-baseline rounded-lg py-px pr-1 text-sm text-muted-foreground [&::-webkit-details-marker]:hidden">
				<span
					className={cn(
						"mr-2 flex-none text-xs",
						state === "running" && "animate-pulse-soft text-salmon-text",
						state === "error" && "text-destructive",
						state === "done" && "text-ok",
					)}
				>
					⏺
				</span>
				<span className={cn("text-sm text-foreground", state === "error" && "text-destructive")}>{block.name}</span>
				<span className="overflow-hidden text-ellipsis whitespace-nowrap text-sm text-muted-foreground before:content-['('] after:content-[')']">
					{summarizeArgs(block.args)}
				</span>
				<span className="ml-1.5 flex items-center text-faint opacity-0 transition-opacity group-hover/tool:opacity-100 group-open/tool:opacity-100 group-open/tool:rotate-90">
					<Icon name="chevron" />
				</span>
			</summary>
			{block.output ? (
				<div className="mt-1 ml-1 flex gap-2">
					<span className={cn("flex-none select-none text-sm text-faint", block.isError && "text-destructive/70")}>
						⎿
					</span>
					<pre
						className={cn(
							"min-w-0 flex-1 max-h-56 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-faint",
							block.isError && "text-destructive",
						)}
					>
						{block.output}
					</pre>
				</div>
			) : null}
			{block.images?.map((image, i) => (
				<div key={i} className="ml-5 font-sans">
					<ImageCard data={image.data} mimeType={image.mimeType} />
				</div>
			))}
		</Disclosure>
	);
}

function ToolGroup({ blocks, scope, index }: { blocks: ToolBlock[]; scope: string; index: number }) {
	const running = blocks.some((block) => block.running);
	const failed = blocks.some((block) => block.isError);
	// One call that has no sentence of its own would give a group whose label
	// simply repeats the row beneath it, so it stands alone.
	if (blocks.length === 1 && toolDescription(blocks[0]!) === "") {
		return <ToolRow block={blocks[0]!} dkey={`${scope}:tool-${blocks[0]!.id || blocks[0]!.name}`} />;
	}
	const dkey = `${scope}:group-${blocks[0]?.id ?? index}`;
	return (
		<Disclosure dkey={dkey} className="group/tg mb-2.5">
			<summary
				className={cn(
					"flex cursor-pointer list-none select-none items-center gap-1.5 rounded-lg py-1 text-sm text-muted-foreground transition-colors hover:text-foreground group-open/tg:mb-1 group-open/tg:text-foreground [&::-webkit-details-marker]:hidden",
					running && "text-salmon-text",
					failed && "text-destructive",
				)}
			>
				<span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{toolGroupLabel(blocks)}</span>
				<span className="flex text-faint transition-transform group-open/tg:rotate-90">
					<Icon name="chevron" />
				</span>
			</summary>
			<div className="ml-0.5 border-l pl-3">
				{blocks.map((block, i) => (
					<ToolRow key={block.id || i} block={block} dkey={`${scope}:tool-${block.id || `${index}-${i}`}`} />
				))}
			</div>
		</Disclosure>
	);
}

const CODE_COPY_CLASS =
	"absolute top-1.5 right-1.5 flex size-7 items-center justify-center rounded-md border bg-card text-faint opacity-0 transition-opacity hover:text-foreground [pre:hover_&]:opacity-100 focus-visible:opacity-100 [&>svg]:size-4";

function Markdown({ text, className }: { text: string; className?: string }) {
	const ref = useRef<HTMLDivElement>(null);

	// Each code block gets its own copy button, added after the markdown lands
	// (React never reconciles inside this container, so the DOM edit is safe).
	useEffect(() => {
		const root = ref.current;
		if (!root) return;
		for (const pre of root.querySelectorAll("pre")) {
			if (pre.querySelector("[data-copy]")) continue;
			const button = document.createElement("button");
			button.type = "button";
			button.title = "Copy code";
			button.dataset.copy = "";
			button.className = CODE_COPY_CLASS;
			button.innerHTML = icon("copy");
			pre.appendChild(button);
		}
	});

	return (
		<div
			ref={ref}
			className={cn("md prose-response text-sm leading-[1.7]", className)}
			onClick={(event) => {
				const button = (event.target as HTMLElement).closest<HTMLElement>("[data-copy]");
				if (!button) return;
				const code = button.closest("pre")?.querySelector("code");
				const source = (code?.innerText ?? "").trim();
				if (source === "") return;
				void copy(source).then((ok) => {
					if (!ok) return;
					button.innerHTML = icon("check");
					button.classList.add("text-ok");
					setTimeout(() => {
						button.innerHTML = icon("copy");
						button.classList.remove("text-ok");
					}, 1200);
				});
			}}
			// Rendered by the in-house markdown renderer, which escapes HTML.
			dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
		/>
	);
}

function MessageBlocks({ message, scope }: { message: ChatMessage; scope: string }) {
	const parts: React.ReactNode[] = [];
	let run: ToolBlock[] = [];
	let key = 0;
	const flush = (): void => {
		if (run.length > 0) parts.push(<ToolGroup key={`g${key++}`} blocks={run} scope={scope} index={key} />);
		run = [];
	};
	for (const block of message.blocks) {
		if (block.kind === "tool") {
			run.push(block);
			continue;
		}
		// Reasoning never enters the transcript; the working line carries its
		// condensed stage phrase instead. Empty text blocks are stream padding.
		if (block.kind === "thinking") continue;
		if (block.kind === "image") {
			flush();
			parts.push(<ImageCard key={`i${key++}`} data={block.data} mimeType={block.mimeType} />);
			continue;
		}
		if (block.text.trim() === "") continue;
		flush();
		parts.push(<Markdown key={`m${key++}`} text={block.text} />);
	}
	flush();
	return <>{parts}</>;
}

/**
 * The live stage phrase condensed from the model's reasoning stream —
 * ephemeral by design: replaced at most about once a second, and never
 * outliving the stretch of reasoning that produced it.
 */
let stagePhrase = "";
let stagePhraseAt = 0;
let thinkingSince = 0;
/**
 * How long a reasoning phrase holds before another may replace it.
 *
 * The model moves through thoughts far faster than anyone can read one, so
 * this is deliberately slow: a line that changes every second reads as noise
 * rather than progress.
 */
const STAGE_PHRASE_THROTTLE_MS = 4500;
/**
 * After this long in one stretch of reasoning, stop naming thoughts.
 *
 * Nothing here can know how close the model is to done — it is a stand-in for
 * a long think, and saying so beats cycling phrases for another minute.
 */
const THINKING_LONG_MS = 30_000;

export function resetStagePhrase(): void {
	stagePhrase = "";
	stagePhraseAt = 0;
	thinkingSince = 0;
}

function currentActivity(message: ChatMessage | undefined): string {
	const blocks = message?.blocks ?? [];
	const last = blocks.at(-1);
	let hasTool = false;
	let runningTool = false;
	for (const block of blocks) {
		if (block.kind === "tool") {
			hasTool = true;
			if (block.running) runningTool = true;
		}
	}
	// A running tool renders its own live row just above this line — don't
	// parrot it. The line's value here is the elapsed time and token count.
	if (runningTool) {
		stagePhrase = "";
		thinkingSince = 0;
		return "Working…";
	}
	if (last?.kind === "thinking") {
		const now = Date.now();
		if (thinkingSince === 0) thinkingSince = now;
		if (now - thinkingSince >= THINKING_LONG_MS) return "Almost finished thinking…";
		if (stagePhrase === "" || now - stagePhraseAt >= STAGE_PHRASE_THROTTLE_MS) {
			const phrase = thinkingSummary(last.text);
			if (phrase !== "" && phrase !== stagePhrase) {
				stagePhrase = phrase;
				stagePhraseAt = now;
			}
		}
		return `${stagePhrase || "Thinking"}…`;
	}
	// Real output has started — the reasoning phrase has served its purpose.
	stagePhrase = "";
	thinkingSince = 0;
	if (last?.kind === "text" && last.text.trim() !== "") {
		return hasTool ? "Almost done…" : "Responding…";
	}
	return "Working…";
}

/**
 * Footer under a turn: elapsed · tokens · what it is doing. It stays once the
 * turn finishes, minus the activity, so the cost of an answer is still
 * readable after the fact.
 */
function WorkingLine({ message, running }: { message: ChatMessage | undefined; running: boolean }) {
	const [, setTick] = useState(0);
	useEffect(() => {
		if (!running) return;
		const timer = setInterval(() => setTick((n) => n + 1), 1000);
		return () => clearInterval(timer);
	}, [running]);
	// Only while it is working. A finished turn has nothing to report: the
	// answer is the answer, and its cost is on the home screen either way.
	if (!running) return null;
	const seconds = app.runStartedAt > 0 ? Math.floor((Date.now() - app.runStartedAt) / 1000) : 0;
	const tokens = app.chat.usage ? app.chat.usage.input + app.chat.usage.output : 0;
	const parts = [
		formatElapsed(seconds),
		...(tokens > 0 ? [formatTokens(tokens)] : []),
		currentActivity(message),
	];
	return (
		<div className="mt-2.5 flex items-center gap-2 font-mono text-sm text-faint">
			<TurnSpinner />
			<span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{parts.join(" · ")}</span>
		</div>
	);
}

/**
 * The live-turn marker: the arc-over-track spinner from the imagined web app,
 * sized to the context meter's ring so a turn in flight and the context it is
 * spending read as one family rather than two unrelated ornaments.
 */
function TurnSpinner({ size = 16 }: { size?: number }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 18 18"
			className="flex-none animate-spin text-salmon [animation-duration:0.7s]"
			aria-hidden="true"
		>
			<circle cx="9" cy="9" r="6.5" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
			<path d="M9 2.5a6.5 6.5 0 0 1 6.5 6.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
		</svg>
	);
}

/**
 * The action row under a message, styled as the imagined web agent draws it:

 * 26px borderless buttons with 14px thin-stroke glyphs, revealed when the
 * message is hovered, right-aligned under user turns.
 */
function ActionButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
	return (
		<button
			type="button"
			title={title}
			aria-label={title}
			onClick={onClick}
			className="inline-flex size-[26px] items-center justify-center rounded-md text-faint transition-colors hover:bg-accent hover:text-foreground"
		>
			{children}
		</button>
	);
}

function CopyGlyph({ copied }: { copied: boolean }) {
	return copied ? (
		<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
			<path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	) : (
		<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
			<rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
			<path
				d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.3"
			/>
		</svg>
	);
}

function EditGlyph() {
	return (
		<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
			<path
				d="M11 2.5l2.5 2.5M3 13l.7-2.8 6.4-6.4 2.1 2.1-6.4 6.4L3 13Z"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.3"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

/**
 * Copy through the main process, which owns the real clipboard.
 *
 * The page's own clipboard API is permission-gated on file:// origins, so it
 * can be switched off by an unrelated change; this route cannot.
 */
async function copy(text: string): Promise<boolean> {
	const result = await api.copyText(text);
	if (!result.ok) toast(result.error ?? "Could not copy that.", "error");
	return result.ok;
}

function CopyAction({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<ActionButton
			title="Copy"
			onClick={() => {
				void copy(text).then((ok) => {
					if (!ok) return;
					setCopied(true);
					setTimeout(() => setCopied(false), 1200);
				});
			}}
		>
			<CopyGlyph copied={copied} />
		</ActionButton>
	);
}

function ActionRow({ end, children }: { end?: boolean; children: React.ReactNode }) {
	return (
		<div
			className={cn(
				"mt-1 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 focus-within:opacity-100",
				end && "justify-end",
			)}
		>
			{children}
		</div>
	);
}

function messageProse(message: ChatMessage): string {
	return message.blocks
		.filter((block) => block.kind === "text")
		.map((block) => ("text" in block ? block.text : ""))
		.join("\n\n")
		.trim();
}

/**
 * The transcript flattened for display, with tool runs grouped ACROSS agent
 * steps: each step is its own assistant message, so grouping inside one
 * message never fires on a real run — a research sweep would read as thirty
 * bare rows. Consecutive tool calls fold into one summary until prose (or a
 * new user turn) interrupts, the way the reference app reads.
 */
type Segment =
	| { kind: "user"; message: ChatMessage; index: number; userIndex: number }
	| { kind: "system"; message: ChatMessage; index: number }
	| { kind: "prose"; text: string; streaming: boolean }
	| { kind: "picture"; data: string; mimeType: string }
	| { kind: "tools"; blocks: ToolBlock[]; scope: string }
	| { kind: "footer"; message: ChatMessage | undefined };

/**
 * The transcript as rows to draw.
 *
 * `running` is the turn's own state rather than any message's: a chat
 * switched into mid-turn is drawn from its file, which cannot hold a
 * message still being written, and the working line belongs to the turn.
 */
function buildSegments(messages: ChatMessage[], running: boolean): Segment[] {
	const segments: Segment[] = [];
	let run: ToolBlock[] = [];
	let runScope = "";
	const flushTools = (): void => {
		if (run.length > 0) segments.push({ kind: "tools", blocks: run, scope: runScope });
		run = [];
	};
	let userIndex = -1;
	messages.forEach((message, index) => {
		if (message.role === "user") {
			flushTools();
			userIndex += 1;
			segments.push({ kind: "user", message, index, userIndex });
			return;
		}
		if (message.role === "system") {
			flushTools();
			segments.push({ kind: "system", message, index });
			return;
		}
		for (const block of message.blocks) {
			if (block.kind === "tool") {
				if (run.length === 0) runScope = `main-${index}`;
				run.push(block);
				continue;
			}
			// Reasoning never enters the transcript; empty text is stream padding.
			if (block.kind === "thinking") continue;
			if (block.kind === "image") {
				flushTools();
				segments.push({ kind: "picture", data: block.data, mimeType: block.mimeType });
				continue;
			}
			if (block.text.trim() === "") continue;
			flushTools();
			segments.push({ kind: "prose", text: block.text, streaming: message.streaming === true });
		}
		// Only a turn in flight gets a footer; a finished one says nothing.
		if (message.streaming === true) {
			flushTools();
			segments.push({ kind: "footer", message });
		}
	});
	flushTools();
	if (running && !segments.some((segment) => segment.kind === "footer")) {
		segments.push({ kind: "footer", message: undefined });
	}
	return segments;
}

export function Transcript() {
	const state = useApp();
	const scroller = useRef<HTMLDivElement>(null);
	const [awayFromEnd, setAwayFromEnd] = useState(false);
	const stickRef = useRef(true);
	/** Where we last parked the view, to tell our own jumps from the reader's. */
	const parkedTop = useRef(0);
	/** Distance from the bottom banked before an earlier page is prepended. */
	const anchor = useRef<number | null>(null);
	const heldCount = useRef(0);

	// A chat opens at its newest message, whatever the last one was left at.
	useEffect(() => {
		stickRef.current = true;
		anchor.current = null;
	}, [state.currentSessionPath]);

	/**
	 * Keep the reader still when the page above arrives.
	 *
	 * Messages added at the top push everything down by their own height, so
	 * the view is put back the same distance from the bottom it was banked at.
	 * It waits for the count to change: the render that only marks the fetch
	 * as running has not moved anything yet.
	 */
	useLayoutEffect(() => {
		const node = scroller.current;
		const count = state.chat.messages.length;
		if (node && anchor.current !== null && count !== heldCount.current) {
			node.scrollTop = node.scrollHeight - anchor.current;
			anchor.current = null;
		}
		heldCount.current = count;
	});

	// Stick to the bottom while streaming, unless the reader scrolled away.
	useEffect(() => {
		const node = scroller.current;
		if (!node || !stickRef.current) return;
		node.scrollTop = node.scrollHeight;
		parkedTop.current = node.scrollTop;
	});

	/**
	 * A wheel gesture has to unstick us here rather than in onScroll.
	 *
	 * Streaming re-renders every few hundred milliseconds, and the effect above
	 * runs on each one. Scroll events are dispatched after the fact, so a delta
	 * landing in that gap would pin the reader back to the bottom before their
	 * scroll was ever read. Wheel fires first, so acting on it wins the race.
	 */
	const onWheel = (event: React.WheelEvent<HTMLDivElement>): void => {
		if (event.deltaY < 0) stickRef.current = false;
	};

	const onScroll = (): void => {
		const node = scroller.current;
		if (!node) return;
		// Dragging the scrollbar produces no wheel event, so also treat any move
		// above where we parked as intent; growing content only ever pushes down.
		const movedUp = node.scrollTop < parkedTop.current - 2;
		if (movedUp) stickRef.current = false;
		const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
		// Re-stick only at the very bottom. A generous threshold here undoes the
		// reader's own scroll: a short nudge upward still leaves them "near" the
		// end, so the next streamed delta drags them straight back down.
		if (!movedUp && distance <= 8) stickRef.current = true;
		parkedTop.current = node.scrollTop;
		setAwayFromEnd(distance >= 120);
		// Near the top with more above it: fetch the page before this one.
		if (node.scrollTop < 240 && app.historyStart > 0 && !app.historyLoading) {
			anchor.current = node.scrollHeight - node.scrollTop;
			void loadEarlier();
		}
	};

	return (
		<div className="relative min-h-0 flex-1">
			<div ref={scroller} onScroll={onScroll} onWheel={onWheel} className="h-full overflow-y-auto">
				<div className="mx-auto max-w-[740px] px-8 pt-6 pb-10">
					{/* A chat being read in says so with the same spinner a turn uses,
					    rather than flashing the empty state on its way to a transcript. */}
					{state.chatLoading && (
						<div className="flex h-[60vh] items-center justify-center">
							<TurnSpinner size={22} />
						</div>
					)}
					{!state.chatLoading && state.chat.messages.length === 0 && <EmptyChat />}
					{state.historyLoading && (
						<div className="mb-6 flex justify-center">
							<TurnSpinner />
						</div>
					)}
					{buildSegments(state.chat.messages, state.chat.streaming && !state.chatLoading).map(
						(segment, position) => {
						if (segment.kind === "user") {
							const prose = messageProse(segment.message);
							return (
								<div key={`u${segment.index}`} className="group/row mt-7 mb-6 first:mt-0">
									<div className="flex justify-end">
										<div className="max-w-[85%] rounded-xl bg-card px-4 py-3 text-sm leading-relaxed">
											<MessageBlocks message={segment.message} scope={`main-${segment.index}`} />
										</div>
									</div>
									<ActionRow end>
										<ActionButton
											title="Edit and resend from here"
											onClick={() => void rewindToUserMessage(segment.userIndex, prose)}
										>
											<EditGlyph />
										</ActionButton>
										{prose !== "" && <CopyAction text={prose} />}
									</ActionRow>
								</div>
							);
						}
						if (segment.kind === "system") {
							return (
								<div key={`s${segment.index}`} className="mb-4 font-mono text-sm text-faint">
									<MessageBlocks message={segment.message} scope={`main-${segment.index}`} />
								</div>
							);
						}
						if (segment.kind === "tools") {
							return <ToolGroup key={`t${segment.scope}-${position}`} blocks={segment.blocks} scope={segment.scope} index={position} />;
						}
						if (segment.kind === "footer") {
							return <WorkingLine key={`f${position}`} message={segment.message} running />;
						}
						if (segment.kind === "picture") {
							return <ImageCard key={`pic${position}`} data={segment.data} mimeType={segment.mimeType} />;
						}
						return (
							<div key={`p${position}`} className="group/row mb-4">
								<Markdown text={segment.text} />
								{!segment.streaming &&
									standaloneLinks(segment.text).map((url) => <LinkPreviewCard key={url} url={url} />)}
								{!segment.streaming && (
									<ActionRow>
										<CopyAction text={segment.text} />
									</ActionRow>
								)}
							</div>
						);
					})}
				</div>
			</div>
			{awayFromEnd && (
				<Button
					variant="outline"
					size="icon"
					title="Jump to latest"
					className="absolute bottom-3 left-1/2 z-20 -translate-x-1/2 rounded-full bg-card shadow-lg"
					onClick={() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" })}
				>
					<Icon name="scrollDown" />
				</Button>
			)}
		</div>
	);
}

/** Expand every tool disclosure in the transcript, or collapse them all. */
export function toggleAllToolOutput(): void {
	const groups = [...document.querySelectorAll<HTMLDetailsElement>("details[data-key]")];
	const anyClosed = groups.some((group) => !group.open);
	for (const group of groups) {
		group.open = anyClosed;
		const key = group.dataset.key;
		if (!key) continue;
		if (anyClosed) openDisclosures.add(key);
		else openDisclosures.delete(key);
	}
}
