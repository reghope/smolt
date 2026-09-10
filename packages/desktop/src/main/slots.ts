/**
 * Which agent should show a chat.
 *
 * A chat belongs to the folder it was started in. An agent's working
 * directory is fixed when the process starts, so honouring that means
 * choosing an agent already rooted in the right place — never moving one that
 * is standing somewhere else. Moving them was how opening a second project
 * used to end every other chat's turn without a word.
 *
 * Kept apart from the window so the rule can be stated once and tested: the
 * live version of this decision lives inside the app's ready handler, where
 * there is a browser window and a pool of subprocesses in the way.
 */

/** As much of an agent slot as the choice depends on. */
export interface SlotView {
	id: number;
	/** The folder this agent is rooted in. */
	cwd: string;
	/** Session file it currently holds; "" when it has none yet. */
	sessionPath: string;
	/** Mid-turn, so it cannot be asked to show anything else. */
	busy: boolean;
}

export type SlotChoice =
	/** An agent already holds this chat — including one still working on it. */
	| { kind: "held"; id: number }
	/** The agent in view is free and already in the right folder. */
	| { kind: "active"; id: number }
	/** An idle agent already rooted in that folder can take it. */
	| { kind: "spare"; id: number }
	/** Nothing suitable is running; start one rooted there. */
	| { kind: "spawn"; cwd: string };

export interface SlotChoiceState {
	slots: SlotView[];
	/** The agent the window is on. */
	activeId: number;
	/** The chat being opened. */
	sessionPath: string;
	/** The folder that chat belongs to. */
	cwd: string;
}

/**
 * The agent to open a chat on, in preference order: the one already holding
 * it, the one in view when it is free and in the right folder, any idle agent
 * in that folder, or a new one started there.
 */
export function chooseSlotForSession(state: SlotChoiceState): SlotChoice {
	const { slots, activeId, sessionPath, cwd } = state;
	// Already open somewhere, busy or not: becoming the view again is how a
	// turn running in the background is picked back up live.
	const held = slots.find((slot) => slot.sessionPath !== "" && slot.sessionPath === sessionPath);
	if (held) return { kind: "held", id: held.id };

	const active = slots.find((slot) => slot.id === activeId);
	if (active && !active.busy && active.cwd === cwd) return { kind: "active", id: active.id };

	const spare = slots.find((slot) => slot.id !== activeId && !slot.busy && slot.cwd === cwd);
	if (spare) return { kind: "spare", id: spare.id };

	return { kind: "spawn", cwd };
}
