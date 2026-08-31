import type { AgentDefinition } from "./agents.ts";

/**
 * The pool of running subagent threads.
 *
 * The old subagent tool spawned a whole smolt process per task, waited for it,
 * and handed back its output. That is fine for fire-and-forget work and no use
 * for anything else: you cannot look inside a running task, cannot correct it
 * halfway, and cannot start something and get on with your own work.
 *
 * Here a thread is a second agent session in this process. It runs in the
 * background, it can be read while it runs, steered mid-flight, and stopped.
 * Only its summary goes back to the parent — the point of a subagent is that
 * its context stays its own.
 *
 * This module holds the bookkeeping and none of the agent machinery, so the
 * lifecycle can be tested without a provider.
 */

export type ThreadStatus = "starting" | "running" | "waiting" | "completed" | "errored" | "stopped";

/** The statuses that mean the thread will not do anything more. */
export function isFinished(status: ThreadStatus): boolean {
	return status === "completed" || status === "errored" || status === "stopped";
}

/** What a running thread can be driven with, once it exists. */
export interface ThreadDriver {
	/** Queue a message for after the current turn, or cut in immediately. */
	send(text: string, interrupt: boolean): Promise<void>;
	/** Stop the thread where it is. */
	abort(): Promise<void>;
	/** Release everything the thread holds. */
	dispose(): void;
	/** The thread's own transcript, for inspection. */
	transcript(): { role: string; text: string }[];
	/** Timing totals for the thread's actions, for bottleneck hunting. */
	metricsSummary?(): { actions: number; toolMs: number; llmMs: number };
}

export interface Thread {
	id: string;
	/** A short readable name, so a person can talk about it. */
	nickname: string;
	agent: string;
	task: string;
	status: ThreadStatus;
	startedAt: number;
	endedAt: number;
	/** The thread's final answer, once it has one. */
	summary: string;
	/** Why it errored, when it did. */
	error: string;
	/** Messages the parent has not been told about yet. */
	unreported: boolean;
	driver?: ThreadDriver;
}

/** Readable thread names, so `/subagents` reads better than a list of uuids. */
const NICKNAMES = [
	"amber",
	"basalt",
	"cobalt",
	"dune",
	"ember",
	"flint",
	"garnet",
	"hazel",
	"indigo",
	"jasper",
	"kestrel",
	"larch",
	"mica",
	"nickel",
	"onyx",
	"pewter",
];

export interface PoolLimits {
	/** How many threads may be running at once. */
	maxConcurrent: number;
}

export class ThreadPool {
	private readonly threads = new Map<string, Thread>();
	private sequence = 0;
	private limits: PoolLimits;

	constructor(limits: PoolLimits) {
		this.limits = limits;
	}

	setLimits(limits: PoolLimits): void {
		this.limits = limits;
	}

	/** Threads that still occupy a slot: running, or finished but not closed. */
	get open(): Thread[] {
		return [...this.threads.values()];
	}

	get running(): Thread[] {
		return this.open.filter((thread) => !isFinished(thread.status));
	}

	get(id: string): Thread | undefined {
		// Nicknames are how a person refers to a thread; ids are how the model does.
		return this.threads.get(id) ?? this.open.find((thread) => thread.nickname === id);
	}

	/**
	 * Whether another thread may start.
	 *
	 * A finished thread still holds its slot until it is closed, which is
	 * deliberate: it means an unread result cannot be silently displaced by
	 * the next spawn.
	 */
	atCapacity(): boolean {
		return this.threads.size >= this.limits.maxConcurrent;
	}

	/** Register a thread before its agent session exists. */
	register(agent: AgentDefinition, task: string): Thread {
		this.sequence += 1;
		const id = `a${this.sequence}`;
		const thread: Thread = {
			id,
			nickname: NICKNAMES[(this.sequence - 1) % NICKNAMES.length] ?? id,
			agent: agent.name,
			task,
			status: "starting",
			startedAt: Date.now(),
			endedAt: 0,
			summary: "",
			error: "",
			unreported: false,
		};
		this.threads.set(id, thread);
		return thread;
	}

	attach(id: string, driver: ThreadDriver): void {
		const thread = this.threads.get(id);
		if (!thread) return;
		thread.driver = driver;
		if (thread.status === "starting") thread.status = "running";
	}

	/** Record how a thread ended, and that the parent has not heard yet. */
	finish(id: string, status: "completed" | "errored" | "stopped", detail: string): void {
		const thread = this.threads.get(id);
		if (!thread || isFinished(thread.status)) return;
		thread.status = status;
		thread.endedAt = Date.now();
		thread.unreported = true;
		if (status === "errored") thread.error = detail;
		else thread.summary = detail;
	}

	/** Threads that have finished and whose result the parent has not seen. */
	takeUnreported(): Thread[] {
		const done = this.open.filter((thread) => thread.unreported);
		for (const thread of done) thread.unreported = false;
		return done;
	}

	/** Forget a thread, freeing its slot. Stopping it first is the caller's job. */
	close(id: string): boolean {
		const thread = this.get(id);
		if (!thread) return false;
		thread.driver?.dispose();
		return this.threads.delete(thread.id);
	}

	/** Everything, at shutdown. */
	closeAll(): Thread[] {
		const all = this.open;
		for (const thread of all) thread.driver?.dispose();
		this.threads.clear();
		return all;
	}
}

/** How long a thread has been going, for the listing. */
export function elapsed(thread: Thread): string {
	const end = thread.endedAt > 0 ? thread.endedAt : Date.now();
	const seconds = Math.max(0, Math.round((end - thread.startedAt) / 1000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

/** One line per thread, the same shape for the model and for the footer. */
export function describe(thread: Thread): string {
	const timing = thread.driver?.metricsSummary?.();
	const activity = timing
		? ` · ${timing.actions} actions (tool ${Math.round(timing.toolMs / 1000)}s, llm ${Math.round(timing.llmMs / 1000)}s)`
		: "";
	const head = `${thread.id} (${thread.nickname}) ${thread.agent} · ${thread.status} · ${elapsed(thread)}${activity}`;
	const tail = thread.status === "errored" ? thread.error : thread.task;
	return `${head} — ${tail.split("\n")[0]?.slice(0, 90) ?? ""}`;
}
