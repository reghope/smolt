/**
 * Pure UI state reducer: agent RPC events in, view state out.
 *
 * Streaming assistant messages are assembled from `message_update` deltas
 * keyed by contentIndex; `message_end.message` is authoritative and replaces
 * the assembled blocks. Tool results attach to their tool blocks via
 * `tool_execution_end` (matched on toolCallId).
 */

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

export type Block = TextBlock | ThinkingBlock | ImageBlock | ToolBlock;

export interface ChatMessage {
	role: "user" | "assistant" | "system";
	blocks: Block[];
	streaming?: boolean;
	/** Thinking level the session held when this message streamed. */
	thinkingLevel?: string;
	/** How long the turn took, kept so the footer survives the turn. */
	tookMs?: number;
	/** Tokens the turn cost, likewise. */
	tokens?: number;
	/** When the turn began, for measuring the above. */
	startedAt?: number;
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
		currentThinking: "",
	};
}

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
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

/** Map an authoritative AgentMessage to display blocks. */
export function fromAgentMessage(message: Record<string, unknown>): ChatMessage | null {
	const role = message.role;
	if (role === "user") {
		const blocks: Block[] = [{ kind: "text", text: textOf(message.content) }];
		for (const image of imagesOf(message.content)) blocks.push({ kind: "image", ...image });
		return { role: "user", blocks };
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
	return { role: "assistant", blocks };
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

function currentAssistant(state: UiState): ChatMessage | null {
	const last = state.messages[state.messages.length - 1];
	return last && last.role === "assistant" && last.streaming ? last : null;
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
				if (mapped && textOf(message.content).trim() !== "") state.messages.push(mapped);
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
					thinkingLevel: state.currentThinking || undefined,
				});
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
			const usage = isObj(event.usage) ? event.usage : null;
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
				}
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
		case "compaction_end": {
			state.messages.push({ role: "system", blocks: [{ kind: "text", text: "Context compacted." }] });
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
