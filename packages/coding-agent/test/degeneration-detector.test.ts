import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { DegenerationWatcher, detectDegeneration } from "../src/extensions/degeneration/detector.ts";
import {
	createDegenerationGuard,
	DEFAULT_DEGENERATION_CONFIG,
	readDegenerationConfig,
} from "../src/extensions/degeneration/index.ts";

/**
 * Degeneration guard tests: the pure repetition detector, config reading,
 * and the extension's trip/retry/give-up policy against a fake API.
 */

const MIN_REPEATS = 10;

/** Distinct filler so length thresholds don't interfere with repeat counts. */
function filler(chars: number): string {
	const lines: string[] = [];
	let length = 0;
	let i = 0;
	while (length < chars) {
		const line = `Setup step ${i} completed with distinct output value ${i * 17}.`;
		lines.push(line);
		length += line.length + 1;
		i += 1;
	}
	return `${lines.join("\n")}\n`;
}

describe("detectDegeneration", () => {
	const sentence = "I need to make sure the system understands this whole plan.";

	test("trips on the loop shape from the real glm session", () => {
		const text = `${filler(200)}${`${sentence}\n\n`.repeat(15)}`;
		const reason = detectDegeneration(text, MIN_REPEATS);
		expect(reason).toContain("repeated");
		expect(reason).toContain("I need to make sure the system understands");
	});

	test("stays quiet below minRepeats", () => {
		const text = `${filler(700)}${`${sentence}\n\n`.repeat(MIN_REPEATS - 1)}`;
		expect(detectDegeneration(text, MIN_REPEATS)).toBeUndefined();
	});

	test("blank lines between repeats do not hide the loop", () => {
		const text = `${filler(200)}${`${sentence}\n\n\n`.repeat(MIN_REPEATS)}`;
		expect(detectDegeneration(text, MIN_REPEATS)).toContain("repeated");
	});

	test("trips on a newline-free periodic tail", () => {
		const unit = "the system must comply with this ";
		const text = `${filler(400)}${unit.repeat(MIN_REPEATS + 1)}`;
		const reason = detectDegeneration(text, MIN_REPEATS);
		expect(reason).toContain("the fragment");
	});

	test("ignores repeated units without letters", () => {
		const text = `${filler(400)}${"----------------------------------------\n".repeat(15)}`;
		expect(detectDegeneration(text, MIN_REPEATS)).toBeUndefined();
	});

	test("ignores short repeated lines", () => {
		const text = `${filler(400)}${"}\n".repeat(30)}`;
		expect(detectDegeneration(text, MIN_REPEATS)).toBeUndefined();
	});

	test("ignores legitimately repetitive but distinct code", () => {
		const lines: string[] = [];
		for (let i = 0; i < 30; i++) lines.push(`\texpect(rows[${i}]!.value).toBe(${i * 3});`);
		expect(detectDegeneration(filler(200) + lines.join("\n"), MIN_REPEATS)).toBeUndefined();
	});

	test("ignores short accumulations entirely", () => {
		expect(detectDegeneration(`${sentence}\n`.repeat(5), MIN_REPEATS)).toBeUndefined();
	});

	test("trips on a template loop with a varying slot", () => {
		// The real glm failure shape: identical stem, one word cycling.
		const topics = Array.from({ length: 40 }, (_, i) => `Topic ${i}`);
		const lines = topics.map((t) => `- The question about whether they think their org should do more ${t} work.`);
		const reason = detectDegeneration(filler(100) + lines.join("\n"), MIN_REPEATS);
		expect(reason).toContain("sharing the stem");
		expect(reason).toContain("The question about whether");
	});

	test("a legitimate list sharing a stem stays under the template bar", () => {
		const lines = Array.from(
			{ length: 20 },
			(_, i) => `- The question about whether option ${i} fits the budget for quarter ${i % 4}.`,
		);
		expect(detectDegeneration(filler(400) + lines.join("\n"), MIN_REPEATS)).toBeUndefined();
	});

	test("many lines with only a short shared stem never count as a template", () => {
		const lines = Array.from({ length: 50 }, (_, i) => `Check item ${i}: verified against source ${i * 7}.`);
		expect(detectDegeneration(filler(200) + lines.join("\n"), MIN_REPEATS)).toBeUndefined();
	});

	test("long alternating pairs trip at the reduced repeat bar", () => {
		// The A/B loop shape: a ~130-char two-sentence unit, repeated 7x —
		// under the full minRepeats bar but far past the long-unit bar.
		const pair =
			"The mp4 video document (native playback) case is handled by content.js. " +
			"The image document case is handled by content.js. Continue: ";
		const text = filler(100) + pair.repeat(7);
		expect(detectDegeneration(text, MIN_REPEATS)).toContain("the fragment");
	});

	test("four copies of a long unit stay under the bar", () => {
		const pair =
			"The mp4 video document (native playback) case is handled by content.js. " +
			"The image document case is handled by content.js. Continue: ";
		expect(detectDegeneration(filler(600) + pair.repeat(4), MIN_REPEATS)).toBeUndefined();
	});

	test("trips on a permutation loop where one sentence keeps recurring", () => {
		// The real glm failure shape: same words reshuffled, one exact
		// sentence resurfacing between the variants.
		const variants = [
			"The text is highlighted by the highlighter.",
			"The user uses the highlighter to highlight the text.",
			"The highlighter is used by the user.",
			"The text is highlighted.",
		];
		const parts: string[] = [];
		for (let i = 0; i < 6; i++) {
			parts.push("The highlighter highlights the text.");
			parts.push(variants[i % variants.length]!);
			parts.push(variants[(i + 1) % variants.length]!);
		}
		expect(detectDegeneration(filler(300) + parts.join(" "), MIN_REPEATS)).toContain("recurred");
	});

	test("prose that repeats a quoted error a few times stays quiet", () => {
		const parts: string[] = [];
		for (let i = 0; i < 4; i++) {
			parts.push(`Attempt ${i} failed with "Cannot find module playwright" so I checked path ${i}.`);
			parts.push("Cannot find module playwright appeared in the output again.");
		}
		expect(detectDegeneration(filler(400) + parts.join(" "), MIN_REPEATS)).toBeUndefined();
	});
});

describe("DegenerationWatcher", () => {
	test("throttles rechecks and remembers nothing across reset", () => {
		const watcher = new DegenerationWatcher(MIN_REPEATS);
		const clean = filler(700);
		expect(watcher.check(clean)).toBeUndefined();
		// Growth below the recheck threshold: no verdict either way.
		expect(watcher.check(`${clean}tiny`)).toBeUndefined();
		watcher.reset();
		const bad = `${filler(200)}${"I need to make sure the system understands this whole plan.\n\n".repeat(15)}`;
		expect(watcher.check(bad)).toContain("repeated");
	});
});

describe("config", () => {
	test("missing, malformed, and out-of-range values yield defaults", () => {
		const dir = mkdtempSync(join(tmpdir(), "degen-"));
		try {
			expect(readDegenerationConfig(join(dir, "absent.json"))).toEqual(DEFAULT_DEGENERATION_CONFIG);
			expect(readDegenerationConfig(undefined)).toEqual(DEFAULT_DEGENERATION_CONFIG);
			const bad = join(dir, "bad.json");
			writeFileSync(bad, "{nope", "utf-8");
			expect(readDegenerationConfig(bad)).toEqual(DEFAULT_DEGENERATION_CONFIG);
			const custom = join(dir, "custom.json");
			writeFileSync(custom, JSON.stringify({ maxRetries: 2, minRepeats: 1 }), "utf-8");
			const config = readDegenerationConfig(custom);
			expect(config.maxRetries).toBe(2);
			expect(config.minRepeats).toBe(DEFAULT_DEGENERATION_CONFIG.minRepeats); // < 3 rejected
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

interface AbortCall {
	reason: string;
	options?: { retry?: boolean; attempt?: number; maxAttempts?: number };
}

class FakeSmolt {
	handlers = new Map<string, ((event: Record<string, unknown>) => Promise<unknown>)[]>();
	aborts: AbortCall[] = [];

	on(event: string, handler: (event: Record<string, unknown>) => Promise<unknown>): void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
	}

	abortResponse(reason: string, options?: AbortCall["options"]): boolean {
		this.aborts.push({ reason, options });
		return true;
	}

	async fire(event: string, payload: Record<string, unknown> = {}): Promise<void> {
		for (const handler of this.handlers.get(event) ?? []) {
			await handler({ type: event, ...payload });
		}
	}
}

const LOOP_TEXT = `${filler(200)}${"I need to make sure the system understands this whole plan.\n\n".repeat(15)}`;

async function streamLoop(smolt: FakeSmolt): Promise<void> {
	await smolt.fire("message_start", { message: { role: "assistant", content: [] } });
	await smolt.fire("message_update", {
		message: { role: "assistant", content: [{ type: "text", text: LOOP_TEXT }] },
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "." },
	});
}

describe("guard policy", () => {
	function wire(maxRetries = 1): FakeSmolt {
		const smolt = new FakeSmolt();
		createDegenerationGuard(smolt as unknown as ExtensionAPI, {
			enabled: true,
			maxRetries,
			minRepeats: MIN_REPEATS,
		});
		return smolt;
	}

	test("first trip asks for a retry, and only once per response", async () => {
		const smolt = wire();
		await smolt.fire("before_agent_start", { systemPrompt: "x" });
		await streamLoop(smolt);
		// More deltas after the trip stay silent.
		await smolt.fire("message_update", {
			message: { role: "assistant", content: [{ type: "text", text: `${LOOP_TEXT}more` }] },
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "." },
		});
		expect(smolt.aborts).toHaveLength(1);
		expect(smolt.aborts[0]!.reason).toContain("Degenerate output detected");
		expect(smolt.aborts[0]!.options).toMatchObject({ retry: true, attempt: 1, maxAttempts: 1 });
	});

	test("a second degenerate response in the turn gives up", async () => {
		const smolt = wire();
		await smolt.fire("before_agent_start", { systemPrompt: "x" });
		await streamLoop(smolt);
		await streamLoop(smolt); // retry degenerates too
		expect(smolt.aborts).toHaveLength(2);
		expect(smolt.aborts[1]!.options).toMatchObject({ retry: false });
		expect(smolt.aborts[1]!.reason).toContain("Retry limit reached");
	});

	test("a new user turn resets the retry budget", async () => {
		const smolt = wire();
		await smolt.fire("before_agent_start", { systemPrompt: "x" });
		await streamLoop(smolt);
		await smolt.fire("before_agent_start", { systemPrompt: "x" });
		await streamLoop(smolt);
		expect(smolt.aborts).toHaveLength(2);
		expect(smolt.aborts[1]!.options).toMatchObject({ retry: true, attempt: 1 });
	});

	test("thinking-block loops trip too", async () => {
		const smolt = wire();
		await smolt.fire("before_agent_start", { systemPrompt: "x" });
		await smolt.fire("message_start", { message: { role: "assistant", content: [] } });
		await smolt.fire("message_update", {
			message: { role: "assistant", content: [{ type: "thinking", thinking: LOOP_TEXT }] },
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "." },
		});
		expect(smolt.aborts).toHaveLength(1);
	});

	test("clean output never trips", async () => {
		const smolt = wire();
		await smolt.fire("before_agent_start", { systemPrompt: "x" });
		await smolt.fire("message_start", { message: { role: "assistant", content: [] } });
		await smolt.fire("message_update", {
			message: { role: "assistant", content: [{ type: "text", text: filler(3000) }] },
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "." },
		});
		expect(smolt.aborts).toHaveLength(0);
	});

	test("enabled:false registers nothing", () => {
		const smolt = new FakeSmolt();
		createDegenerationGuard(smolt as unknown as ExtensionAPI, {
			enabled: false,
			maxRetries: 1,
			minRepeats: MIN_REPEATS,
		});
		expect(smolt.handlers.size).toBe(0);
	});
});
