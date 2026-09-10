/**
 * Pure UI state reducer: agent RPC events in, view state out.
 *
 * Streaming assistant messages are assembled from `message_update` deltas
 * keyed by contentIndex; `message_end.message` is authoritative and replaces
 * the assembled blocks. Tool results attach to their tool blocks via
 * `tool_execution_end` (matched on toolCallId).
 */

import { estimateTokens } from "./lib/throughput.ts";

export interface TextBlock {
	kind: "text";
	text: string;
}

export interface ThinkingBlock {
	kind: "thinking";
	text: string;
}

export interface ImageBlock {
	kind: "image";
	/** base64 payload, without the data: prefix */
	data: string;
	mimeType: string;
}

export interface ToolBlock {
	kind: "tool";
	id: string;
	name: string;
	args: string;
	output: string;
	isError: boolean;
	running: boolean;
	/** The call was stopped before it finished — by the reader or a dead agent. */
	aborted?: boolean;
	/** Images the tool returned (screenshots, read image files). */
	images?: { data: string; mimeType: string }[];
}

/**
 * A turn that ended badly, drawn where its answer would have been.
 *
 * The reason a turn failed rides on the message rather than in its content,
 * and this window used to read neither field — so a refused request drew an
 * empty bubble and left the reader to guess, which is exactly how a chat
 * that had quietly hit a provider's image ceiling looked like the app
 * stopping for no reason. It is a block rather than a toast because it
 * belongs to the turn above it: it must survive a scroll, and still be
 * there when the chat is reopened tomorrow.
 */
export interface ErrorBlock {
	kind: "error";
	text: string;
}

/**
 * A turn that ended because someone said so, drawn plainly.
 *
 * Stopping a turn is not a failure — the reader asked for it, and the red
 * box an error gets says something went wrong when nothing did. It reads as
 * a quiet aside instead, in the same voice a transcript uses for its own
 * remarks.
 */
export interface NoticeBlock {
	kind: "notice";
	text: string;
}

/**
 * One advisor note, delivered by the advisor extension as a `<advisory>`
 * custom message. Rendered in the tool-row voice — dot, label, monospace
 * body — because it is the machine addressing the machine in the reader's
 * presence, not prose anyone is meant to read as the answer.
 */
export interface AdvisoryBlock {
	kind: "advisory";
	severity: "nit" | "concern" | "blocker";
	/** Roster name, when the note came from a named advisor. */
	advisor?: string;
	text: string;
}

export type Block = TextBlock | ThinkingBlock | ImageBlock | ToolBlock | ErrorBlock | NoticeBlock | AdvisoryBlock;

export interface ChatMessage {
	role: "user" | "assistant" | "system";
	blocks: Block[];
	streaming?: boolean;
	/**
	 * A brief an extension sent on the harness's behalf (the instructions
	 * behind /review, /wayfinder, a battletest kickoff) rather than something
	 * the reader typed. Rendered collapsed.
	 */
	internal?: boolean;
	/** Thinking level the session held when this message streamed. */
	thinkingLevel?: string;
	/** How long the turn took, kept so the footer survives the turn. */
	tookMs?: number;
	/** Tokens the turn cost, likewise. */
	tokens?: number;
	/** When the turn began, for measuring the above. */
	startedAt?: number;
	/** When the message was written, in unix ms: what the hover time reads. */
	at?: number;
	/**
	 * The window's own copy of what was just typed, drawn before the agent has
	 * echoed it back.
	 *
	 * Sending used to put nothing on screen: the message appeared only when the
	 * agent's own user event arrived, which is a round-trip through a
	 * subprocess and, on a busy one, seconds of the composer looking as though
	 * it had swallowed the words. The copy goes up at once and the agent's
	 * version takes its place, which is why it is marked rather than simply
	 * pushed - two copies of the same sentence would be worse than the wait.
	 */
	pendingEcho?: boolean;
	/** A compaction announcement, waiting to become its outcome. */
	compacting?: boolean;
}

export interface UiState {
	messages: ChatMessage[];
	streaming: boolean;
	/**
	 * What THIS TURN has consumed so far, across every LLM request it has
	 * made: completed requests summed in `turnBase`, plus the in-flight
	 * request's latest snapshot. The old display showed only the newest
	 * request, which read as the turn's cost and understated a long agentic
	 * turn by however many calls it had already made.
	 */
	usage: { input: number; output: number; cost: number } | null;
	/** Completed requests' totals for the running turn; the in-flight request rides on top. */
	turnBase: { input: number; output: number; cost: number };
	/**
	 * What the newest request of this turn carried, on its own: fresh input,
	 * cached context and output, from its latest snapshot. This is the
	 * context-window figure while a turn streams. `usage` is not: it sums
	 * every request of the turn, and tool results bank their background
	 * sessions' spend into it, so a research run once showed a 38k-token
	 * chat as 1.5M of a 1M window, red, past the auto-compaction mark.
	 */
	request: { context: number } | null;
	/**
	 * What the model has written this turn, for the footer's live rate.
	 *
	 * `estimated` counts the characters that have streamed in from the
	 * request in flight; `reported` is that request's own output count, which
	 * most providers only send at the end. `banked` holds the finished
	 * requests of the turn. See `turnOutputTokens`.
	 */
	output: { banked: number; estimated: number; reported: number };
	/** When the current turn began, for the footer's elapsed time. */
	turnStartedAt?: number;
	/** The session's thinking level right now, stamped onto streamed messages. */
	currentThinking: string;
}

export function initialState(): UiState {
	return {
		messages: [],
		streaming: false,
		usage: null,
		turnBase: { input: 0, output: 0, cost: 0 },
		request: null,
		output: { banked: 0, estimated: 0, reported: 0 },
		currentThinking: "",
	};
}

/**
 * Output tokens the turn has produced so far, live: finished requests plus
 * the one streaming now, taking the provider's word over the estimate
 * whenever it has given one.
 */
export function turnOutputTokens(state: UiState): number {
	return state.output.banked + Math.max(state.output.estimated, state.output.reported);
}

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

/**
 * Everything one request put through the model: the same sum the agent's
 * compaction check makes, so the ring and the auto-compaction mark agree.
 */
function requestContext(usage: Record<string, unknown>): number {
	const num = (v: unknown): number => (typeof v === "number" ? v : 0);
	const total = num(usage.totalTokens);
	if (total > 0) return total;
	return num(usage.input) + num(usage.output) + num(usage.cacheRead) + num(usage.cacheWrite);
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b): b is Record<string, unknown> => isObj(b) && b.type === "text" && typeof b.text === "string")
		.map((b) => b.text as string)
		.join("\n");
}

/** Image parts of message or tool-result content, as displayable payloads. */
function imagesOf(content: unknown): { data: string; mimeType: string }[] {
	if (!Array.isArray(content)) return [];
	return content
		.filter(
			(b): b is Record<string, unknown> =>
				isObj(b) && b.type === "image" && typeof b.data === "string" && b.data !== "",
		)
		.map((b) => ({ data: b.data as string, mimeType: String(b.mimeType ?? "image/png") }));
}

/**
 * Advisor notes ride in as `<advisory advisor="…" severity="…">` wrappers
 * (one per message, batches allowed). Returns blocks only when the message
 * is entirely advisory wrappers; anything else stays a plain text block,
 * because a malformed or mixed message still deserves to be read as written.
 */
export function advisoriesOf(text: string): AdvisoryBlock[] {
	const out: AdvisoryBlock[] = [];
	const re = /<advisory([^>]*)>\n?([\s\S]*?)<\/advisory>/g;
	let consumed = 0;
	let match = re.exec(text);
	for (; match !== null; match = re.exec(text)) {
		// Whitespace between wrappers is fine; anything else means mixed content.
		if (text.slice(consumed, match.index).trim() !== "") return [];
		consumed = match.index + match[0].length;
		const attrs = match[1] ?? "";
		const note = (match[2] ?? "").trim();
		if (note === "") continue;
		const severity = /severity="([^"]*)"/.exec(attrs)?.[1];
		const advisor = /advisor="([^"]*)"/.exec(attrs)?.[1];
		out.push({
			kind: "advisory",
			severity: severity === "blocker" || severity === "concern" || severity === "nit" ? severity : "nit",
			...(advisor ? { advisor } : {}),
			text: note,
		});
	}
	if (out.length > 0 && text.slice(consumed).trim() !== "") return [];
	return out;
}

/** Map an authoritative AgentMessage to display blocks. */
export function fromAgentMessage(message: Record<string, unknown>): ChatMessage | null {
	const role = message.role;
	if (role === "user") {
		const blocks: Block[] = [{ kind: "text", text: textOf(message.content) }];
		for (const image of imagesOf(message.content)) blocks.push({ kind: "image", ...image });
		return {
			role: "user",
			blocks,
			...(typeof message.timestamp === "number" ? { at: message.timestamp } : { at: Date.now() }),
			...(message.internal === true ? { internal: true } : {}),
		};
	}
	if (role === "custom") {
		// Extension-authored messages (e.g. the /hindsight report). Only ones
		// marked for display; the rest are context-only nudges.
		if (message.display !== true) return null;
		const text = typeof message.content === "string" ? message.content : textOf(message.content);
		if (text.trim() === "") return null;
		const advisories = advisoriesOf(text);
		if (advisories.length > 0)
			return {
				role: "system",
				blocks: advisories,
				at: typeof message.timestamp === "number" ? message.timestamp : Date.now(),
			};
		return {
			role: "system",
			blocks: [{ kind: "text", text }],
			at: typeof message.timestamp === "number" ? message.timestamp : Date.now(),
		};
	}
	if (role !== "assistant") return null;
	const blocks: Block[] = [];
	const content = Array.isArray(message.content) ? message.content : [];
	for (const raw of content) {
		if (!isObj(raw)) continue;
		if (raw.type === "text" && typeof raw.text === "string" && raw.text.trim() !== "") {
			blocks.push({ kind: "text", text: raw.text });
		} else if (raw.type === "image" && typeof raw.data === "string" && raw.data !== "") {
			blocks.push({ kind: "image", data: raw.data, mimeType: String(raw.mimeType ?? "image/png") });
		} else if (raw.type === "thinking" && typeof raw.thinking === "string" && raw.thinking.trim() !== "") {
			blocks.push({ kind: "thinking", text: raw.thinking });
		} else if (raw.type === "toolCall") {
			blocks.push({
				kind: "tool",
				id: String(raw.id ?? ""),
				name: String(raw.name ?? "tool"),
				args: typeof raw.arguments === "string" ? raw.arguments : JSON.stringify(raw.arguments ?? {}),
				output: "",
				isError: false,
				running: true,
			});
		}
	}
	// A cancelled response that wrote nothing has nothing to say: the harness
	// aborts a turn to compact when the context fills, and a lone "Stopped."
	// above the compaction notice reads as though something went wrong.
	const failure = message.stopReason === "aborted" && blocks.length === 0 ? null : failureText(message);
	if (failure !== null) blocks.push(failure);
	return {
		role: "assistant",
		blocks,
		at: typeof message.timestamp === "number" ? message.timestamp : Date.now(),
	};
}

/**
 * The human sentence inside a provider's error, if it has one.
 *
 * Providers answer with a JSON envelope, often nested — one service quoting
 * another quoting a third — and printing it raw drops a wall of punctuation
 * into the chat where one sentence would do. The status code in front of it
 * is worth keeping; the braces are not. Anything that does not parse is
 * shown exactly as it arrived, because a mangled error is worse than an
 * ugly one.
 */
function readableError(raw: string): string {
	if (raw === "") return "Unknown error";
	const start = raw.indexOf("{");
	if (start === -1) return raw;
	try {
		const parsed: unknown = JSON.parse(raw.slice(start));
		const inner = isObj(parsed) && typeof parsed.message === "string" ? parsed.message.trim() : "";
		if (inner === "") return raw;
		const status = raw.slice(0, start).trim().replace(/:$/, "");
		return status === "" ? inner : `${status} ${inner}`;
	} catch {
		return raw;
	}
}

/** How a turn ended, as the block the transcript should show. */
function failureText(message: Record<string, unknown>): Block | null {
	const raw = typeof message.errorMessage === "string" ? message.errorMessage.trim() : "";
	switch (message.stopReason) {
		case "length":
			return { kind: "error", text: "Response was truncated before completion." };
		case "aborted":
			// Stopping is not a failure, so it is never drawn as one. The
			// agent's own wording for a plain stop says nothing the reader
			// does not already know, having just pressed the button.
			return { kind: "notice", text: raw !== "" && raw !== "Request was aborted" ? raw : "Stopped." };
		case "error":
			return { kind: "error", text: `API Error: ${readableError(raw)}` };
		default:
			return null;
	}
}

/** The bash tool's marker for a call the reader stopped mid-run. */
const ABORTED_SUFFIX = /(^|\n)Command aborted\s*$/;

/** Attach a stored toolResult message to its tool block when loading history. */
export function attachToolResult(messages: ChatMessage[], raw: Record<string, unknown>): void {
	const toolCallId = String(raw.toolCallId ?? "");
	if (toolCallId === "") return;
	for (let i = messages.length - 1; i >= 0; i--) {
		for (const block of messages[i]!.blocks) {
			if (block.kind === "tool" && block.id === toolCallId) {
				block.running = false;
				block.isError = raw.isError === true;
				block.output = textOf(raw.content).slice(0, 20_000);
				if (ABORTED_SUFFIX.test(block.output)) block.aborted = true;
				const images = imagesOf(raw.content);
				if (images.length > 0) block.images = images;
				return;
			}
		}
	}
}

/**
 * The message deltas belong to: the last one still live, wherever it sits.
 *
 * Not just the tail. A user message queued mid-turn lands behind the message
 * being written, and taking only the tail started a second live message for
 * the rest of that turn — two working lines, and the answer split in two.
 */
function currentAssistant(state: UiState): ChatMessage | null {
	for (let i = state.messages.length - 1; i >= 0; i--) {
		const message = state.messages[i]!;
		if (message.role === "assistant" && message.streaming) return message;
	}
	return null;
}

function findToolBlock(state: UiState, toolCallId: string): ToolBlock | null {
	for (let i = state.messages.length - 1; i >= 0; i--) {
		for (const block of state.messages[i]!.blocks) {
			if (block.kind === "tool" && block.id === toolCallId) return block;
		}
	}
	return null;
}

/** Reduce one agent event into the state (mutates and returns the state). */
export function reduce(state: UiState, event: unknown): UiState {
	if (!isObj(event)) return state;
	const type = event.type;

	switch (type) {
		case "agent_start": {
			state.streaming = true;
			state.turnStartedAt = Date.now();
			// A fresh turn counts from zero: the footer's number is this turn's
			// spend, not a leftover from the last one.
			state.turnBase = { input: 0, output: 0, cost: 0 };
			state.usage = null;
			state.request = null;
			state.output = { banked: 0, estimated: 0, reported: 0 };
			break;
		}
		case "agent_settled": {
			state.streaming = false;
			// A turn can emit several assistant messages; close every one of them,
			// or the earlier ones keep a live footer for the rest of the session.
			for (const message of state.messages) {
				if (!message.streaming) continue;
				message.streaming = false;
				message.tookMs = message.startedAt ? Date.now() - message.startedAt : undefined;
			}
			// Only the final message of a turn carries the turn's cost.
			const last = state.messages[state.messages.length - 1];
			if (last && last.role === "assistant") {
				last.tokens = state.usage ? state.usage.input + state.usage.output : undefined;
				// Measured from the start of the turn, not of its last message.
				if (state.turnStartedAt) last.tookMs = Date.now() - state.turnStartedAt;
			}
			// A turn can settle mid-tool when it is aborted or errors. Without
			// this the call keeps its running dot for the life of the session.
			for (const message of state.messages) {
				for (const block of message.blocks) {
					if (block.kind === "tool" && block.running) {
						block.running = false;
						block.aborted = true;
						if (block.output === "") block.output = "Interrupted.";
					}
				}
			}
			break;
		}
		case "message_start": {
			const message = isObj(event.message) ? event.message : {};
			if (message.role === "user") {
				const mapped = fromAgentMessage(message);
				if (mapped && textOf(message.content).trim() !== "") {
					// The agent's own copy of a message the window already drew.
					// It is the authoritative one - it carries the timestamp the
					// transcript was written with - so it replaces the stand-in
					// rather than following it. A brief an extension sent is not a
					// reply to anything the reader typed, so it never matches.
					const waiting =
						message.internal === true
							? -1
							: state.messages.findIndex(
									(entry) =>
										entry.pendingEcho === true &&
										entry.blocks.some(
											(block) => block.kind === "text" && block.text === textOf(message.content),
										),
								);
					if (waiting >= 0) state.messages[waiting] = mapped;
					else state.messages.push(mapped);
				}
			} else if (message.role === "custom") {
				// Displayable extension messages arrive complete at message_start
				// (message_end repeats them, so only one of the two may append).
				const mapped = fromAgentMessage(message);
				if (mapped) state.messages.push(mapped);
			} else if (message.role === "assistant") {
				// Close every message still marked live, not just the one before this.
				// A steered message lands between two assistant turns, so the one that
				// was streaming is no longer the last entry — and it would keep a
				// second working line running underneath the real one.
				for (const earlier of state.messages) {
					if (!earlier.streaming) continue;
					earlier.streaming = false;
					earlier.tookMs = earlier.startedAt ? Date.now() - earlier.startedAt : undefined;
				}
				state.messages.push({
					role: "assistant",
					blocks: [],
					streaming: true,
					startedAt: Date.now(),
					at: Date.now(),
					thinkingLevel: state.currentThinking || undefined,
				});
				// A new request starts its own count; the last one is already banked.
				state.output.estimated = 0;
				state.output.reported = 0;
			}
			break;
		}
		case "message_update": {
			const delta = isObj(event.assistantMessageEvent) ? event.assistantMessageEvent : null;
			if (!delta) break;
			let msg = currentAssistant(state);
			if (!msg) {
				msg = { role: "assistant", blocks: [], streaming: true };
				state.messages.push(msg);
			}
			applyDelta(msg, delta);
			if (typeof delta.delta === "string") state.output.estimated += estimateTokens(delta.delta.length);
			const usage = isObj(event.usage) ? event.usage : null;
			if (usage && typeof usage.output === "number" && usage.output > state.output.reported) {
				state.output.reported = usage.output;
			}
			if (usage && typeof usage.input === "number") {
				const cost = isObj(usage.cost) && typeof usage.cost.total === "number" ? usage.cost.total : 0;
				// The turn so far: every finished request (turnBase) plus this
				// in-flight request's latest snapshot. Snapshots grow and then
				// reset per request, so they are never summed directly.
				state.usage = {
					input: state.turnBase.input + (usage.input as number),
					output: state.turnBase.output + ((usage.output as number) ?? 0),
					cost: state.turnBase.cost + cost,
				};
				state.request = { context: requestContext(usage) };
			}
			break;
		}
		case "message_end": {
			const message = isObj(event.message) ? event.message : {};
			if (message.role === "assistant") {
				// This request is finished; bank its final usage so the next
				// request's snapshots stack on top instead of replacing it.
				const done = isObj(message.usage) ? message.usage : null;
				if (done && typeof done.input === "number") {
					const cost = isObj(done.cost) && typeof done.cost.total === "number" ? done.cost.total : 0;
					state.turnBase = {
						input: state.turnBase.input + (done.input as number),
						output: state.turnBase.output + ((done.output as number) ?? 0),
						cost: state.turnBase.cost + cost,
					};
					state.usage = { ...state.turnBase };
					state.request = { context: requestContext(done) };
				}
				// Settle this request's output at the provider's final word, or the
				// estimate when it gave none, so the rate carries across requests.
				const reported = done && typeof done.output === "number" ? done.output : 0;
				state.output.banked += Math.max(state.output.estimated, state.output.reported, reported);
				state.output.estimated = 0;
				state.output.reported = 0;
				const mapped = fromAgentMessage(message);
				const existing = currentAssistant(state);
				if (mapped) {
					// Preserve tool outputs already attached to assembled blocks.
					if (existing) {
						for (const block of mapped.blocks) {
							if (block.kind !== "tool") continue;
							const prior = existing.blocks.find((b): b is ToolBlock => b.kind === "tool" && b.id === block.id);
							if (prior) {
								block.output = prior.output;
								block.isError = prior.isError;
								block.running = prior.running;
								if (prior.images) block.images = prior.images;
							}
						}
						existing.blocks = mapped.blocks;
					} else {
						state.messages.push({ ...mapped, streaming: false });
					}
				}
			}
			break;
		}
		case "tool_execution_start": {
			const block = findToolBlock(state, String(event.toolCallId ?? ""));
			if (block) block.running = true;
			break;
		}
		case "tool_execution_end": {
			// A tool can carry its own spend — battletest's wait reports the
			// background testers' tokens this way. Bank it into the turn, so
			// the counter is the whole run's cost, not just the parent's.
			const toolUsage =
				isObj(event.result) && isObj((event.result as Record<string, unknown>).usage)
					? ((event.result as Record<string, unknown>).usage as {
							input?: number;
							output?: number;
							cost?: { total?: number };
						})
					: null;
			if (toolUsage && ((toolUsage.input ?? 0) > 0 || (toolUsage.output ?? 0) > 0)) {
				state.turnBase = {
					input: state.turnBase.input + (toolUsage.input ?? 0),
					output: state.turnBase.output + (toolUsage.output ?? 0),
					cost: state.turnBase.cost + (toolUsage.cost?.total ?? 0),
				};
				state.usage = { ...state.turnBase };
			}
			const block = findToolBlock(state, String(event.toolCallId ?? ""));
			if (block) {
				block.running = false;
				const result = isObj(event.result) ? event.result : {};
				block.isError = result.isError === true;
				block.output = textOf(result.content).slice(0, 20_000);
				if (ABORTED_SUFFIX.test(block.output)) block.aborted = true;
				const images = imagesOf(result.content);
				if (images.length > 0) block.images = images;
			}
			break;
		}
		case "compaction_start": {
			// On a local model this is minutes of prompt processing with nothing
			// else on screen moving; without a line here /compact read as dead.
			const reason = String((event as { reason?: unknown }).reason ?? "");
			const why =
				reason === "manual"
					? ""
					: reason === "overflow"
						? " (the context overflowed)"
						: " (the context is nearly full)";
			state.messages.push({
				role: "system",
				blocks: [
					{ kind: "text", text: `Compacting the conversation${why}… this can take a while on a local model.` },
				],
				compacting: true,
			});
			break;
		}
		case "compaction_end": {
			const error = (event as { errorMessage?: unknown }).errorMessage;
			const text = typeof error === "string" && error !== "" ? `Compaction failed: ${error}` : "Context compacted.";
			// The line that announced the compaction becomes its outcome.
			let announced: ChatMessage | undefined;
			for (let index = state.messages.length - 1; index >= 0; index--) {
				if (state.messages[index]?.compacting === true) {
					announced = state.messages[index];
					break;
				}
			}
			if (announced) {
				announced.compacting = false;
				announced.blocks = [{ kind: "text", text }];
			} else {
				state.messages.push({ role: "system", blocks: [{ kind: "text", text }] });
			}
			break;
		}
		case "thinking_level_changed": {
			// Stamped onto each assistant message as it starts, so reasoning can
			// say which level produced it even after auto-thinking moves on.
			state.currentThinking = String((event as { level?: unknown }).level ?? "");
			break;
		}
		default:
			break;
	}
	return state;
}

function applyDelta(msg: ChatMessage, delta: Record<string, unknown>): void {
	const index = typeof delta.contentIndex === "number" ? delta.contentIndex : msg.blocks.length;
	const type = delta.type;

	const ensure = (make: () => Block): Block => {
		while (msg.blocks.length <= index) msg.blocks.push({ kind: "text", text: "" });
		let block = msg.blocks[index]!;
		const wantKind = make().kind;
		if (block.kind !== wantKind) {
			block = make();
			msg.blocks[index] = block;
		}
		return block;
	};

	if (type === "text_start" || type === "text_delta" || type === "text_end") {
		const block = ensure(() => ({ kind: "text", text: "" })) as TextBlock;
		if (type === "text_delta" && typeof delta.delta === "string") block.text += delta.delta;
		if (type === "text_end" && typeof delta.content === "string") block.text = delta.content;
	} else if (type === "thinking_start" || type === "thinking_delta" || type === "thinking_end") {
		const block = ensure(() => ({ kind: "thinking", text: "" })) as ThinkingBlock;
		if (type === "thinking_delta" && typeof delta.delta === "string") block.text += delta.delta;
		if (type === "thinking_end" && typeof delta.content === "string") block.text = delta.content;
	} else if (type === "toolcall_start") {
		const block = ensure(() => ({
			kind: "tool",
			id: "",
			name: "tool",
			args: "",
			output: "",
			isError: false,
			running: true,
		})) as ToolBlock;
		block.id = String(delta.id ?? "");
		block.name = String(delta.toolName ?? "tool");
	} else if (type === "toolcall_delta") {
		const block = msg.blocks[index];
		if (block?.kind === "tool" && typeof delta.delta === "string") block.args += delta.delta;
	} else if (type === "toolcall_end") {
		const block = msg.blocks[index];
		const call = isObj(delta.toolCall) ? delta.toolCall : null;
		if (block?.kind === "tool" && call) {
			block.id = String(call.id ?? block.id);
			block.name = String(call.name ?? block.name);
			block.args = typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {});
		}
	}
}
