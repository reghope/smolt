import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { readPipedStdin } from "../src/main.ts";

/**
 * Print mode merges piped stdin into the prompt. A wrapper that spawns
 * `smolt -p "..."` with a pipe it never writes to or closes used to hang
 * the process forever with nothing printed; with a prompt given, silence
 * on stdin now means there is nothing to merge.
 */

type FakeStdin = PassThrough & { isTTY?: boolean };

describe("readPipedStdin", () => {
	test("a TTY is never read", async () => {
		const stdin = new PassThrough() as FakeStdin;
		stdin.isTTY = true;
		expect(await readPipedStdin({ hasPrompt: false, stdin })).toBeUndefined();
	});

	test("with a prompt, a silent pipe yields nothing instead of waiting forever", async () => {
		const stdin = new PassThrough() as FakeStdin;
		const started = Date.now();
		expect(await readPipedStdin({ hasPrompt: true, stdin, firstByteMs: 50 })).toBeUndefined();
		expect(Date.now() - started).toBeLessThan(2000);
	});

	test("with a prompt, a pipe that delivers is read to the end", async () => {
		const stdin = new PassThrough() as FakeStdin;
		const pending = readPipedStdin({ hasPrompt: true, stdin, firstByteMs: 50 });
		stdin.write("first half, ");
		// Past the first-byte window: once data has arrived, the window no longer applies.
		await new Promise((resolve) => setTimeout(resolve, 120));
		stdin.write("second half");
		stdin.end();
		expect(await pending).toBe("first half, second half");
	});

	test("without a prompt, stdin is the prompt and is read to the end", async () => {
		const stdin = new PassThrough() as FakeStdin;
		const pending = readPipedStdin({ hasPrompt: false, stdin, firstByteMs: 50 });
		await new Promise((resolve) => setTimeout(resolve, 120));
		stdin.write("  the whole prompt  ");
		stdin.end();
		expect(await pending).toBe("the whole prompt");
	});

	test("an empty pipe that closes yields nothing", async () => {
		const stdin = new PassThrough() as FakeStdin;
		const pending = readPipedStdin({ hasPrompt: false, stdin });
		stdin.end();
		expect(await pending).toBeUndefined();
	});
});
