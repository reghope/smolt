import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
	// Every `gh api` call fails, which is what a revoked admin right or an
	// expired login looks like from here: ghJson swallows it and returns
	// undefined, so no stale hook is found and none is deleted.
	execFileSync: () => {
		throw new Error("gh unavailable");
	},
	spawn: () => {
		const child = new EventEmitter() as EventEmitter & {
			stdout: EventEmitter;
			stderr: EventEmitter;
			kill: () => void;
		};
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = () => {};
		// A forwarder that dies the moment it starts: the shape of a `gh webhook
		// forward` that cannot authenticate. Emitted as a microtask so the exit
		// listener registered just after the spawn call is there to hear it.
		queueMicrotask(() => child.emit("exit"));
		return child;
	},
}));

const { watchClaimFile } = await import("../src/extensions/review/config.ts");
const { watchAll } = await import("../src/extensions/review/watch.ts");

/**
 * The claim file gives a repo's webhook one owner, because GitHub allows one
 * forwarder hook per repository and installing a second silently destroys the
 * first. Every other session stands down behind the claim, so a claim that
 * outlives the watcher holding it locks the repo out of all of them.
 */
describe("review watcher claim", () => {
	let agentDir: string;
	let previousAgentDir: string | undefined;
	let stop: (() => void) | undefined;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "smolt-review-watch-"));
		previousAgentDir = process.env.SMOLT_CODING_AGENT_DIR;
		process.env.SMOLT_CODING_AGENT_DIR = agentDir;
		// Only the retry backoff is faked: the forwarder's exit arrives as a real
		// microtask, and Date.now() has to keep moving for the settled-connection
		// check to see these connections as the short-lived ones they are.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	});

	afterEach(() => {
		stop?.();
		stop = undefined;
		vi.useRealTimers();
		if (previousAgentDir === undefined) delete process.env.SMOLT_CODING_AGENT_DIR;
		else process.env.SMOLT_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("gives up the claim when it gives up watching", async () => {
		const notices: string[] = [];
		stop = watchAll(["owner/name"], { review: () => {}, notice: (message) => notices.push(message) });
		expect(existsSync(watchClaimFile("owner/name"))).toBe(true);

		// Long enough for every attempt in the backoff (2s, 4s, 8s, 16s).
		await vi.advanceTimersByTimeAsync(120_000);

		expect(notices.some((notice) => notice.startsWith("Gave up watching owner/name"))).toBe(true);
		// Without this, the claim named a live process that was no longer
		// watching, and no other session could take the repo over until smolt
		// itself was quit.
		expect(existsSync(watchClaimFile("owner/name"))).toBe(false);
	});

	it("keeps the claim while it is still retrying", async () => {
		const notices: string[] = [];
		stop = watchAll(["owner/name"], { review: () => {}, notice: (message) => notices.push(message) });

		await vi.advanceTimersByTimeAsync(5_000);

		expect(notices.some((notice) => notice.startsWith("Gave up watching"))).toBe(false);
		expect(existsSync(watchClaimFile("owner/name"))).toBe(true);
	});

	it("gives up the claim when watching is stopped by hand", async () => {
		const stopWatching = watchAll(["owner/name"], { review: () => {}, notice: () => {} });
		expect(existsSync(watchClaimFile("owner/name"))).toBe(true);
		stopWatching();
		expect(existsSync(watchClaimFile("owner/name"))).toBe(false);
	});
});
