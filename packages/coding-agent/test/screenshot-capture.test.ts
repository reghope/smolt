import { writeFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { CaptureUnavailableError, captureScreen, LINUX_HINT } from "../src/extensions/screenshot/capture.ts";

/**
 * Platform dispatch for screen capture. The runner and platform are injected
 * so these assert which command each OS reaches for — and that a machine with
 * no capture tool gets an actionable message rather than an empty image.
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A runner that succeeds for the named commands, writing a stub PNG. */
function runnerFor(available: string[], log: { command: string; args: string[] }[] = []) {
	return async (command: string, args: string[]) => {
		log.push({ command, args });
		if (!available.includes(command)) return { code: 127, stderr: `${command}: not found` };
		const target = command === "powershell.exe" ? /'([^']+)'/.exec(args.at(-1) ?? "")?.[1] : args.at(-1);
		if (target) writeFileSync(target, PNG);
		return { code: 0, stderr: "" };
	};
}

describe("captureScreen", () => {
	test("uses screencapture on macOS", async () => {
		const log: { command: string; args: string[] }[] = [];
		const result = await captureScreen({}, "darwin", runnerFor(["screencapture"], log));
		expect(result.via).toBe("screencapture");
		expect(log[0]?.args).toContain("-x");
		expect(Array.from(result.png)).toEqual(Array.from(PNG));
	});

	test("passes a display index through to screencapture", async () => {
		const log: { command: string; args: string[] }[] = [];
		await captureScreen({ display: 2 }, "darwin", runnerFor(["screencapture"], log));
		expect(log[0]?.args).toEqual(expect.arrayContaining(["-D", "2"]));
	});

	test("drives PowerShell on Windows and captures the virtual screen by default", async () => {
		const log: { command: string; args: string[] }[] = [];
		const result = await captureScreen({}, "win32", runnerFor(["powershell.exe"], log));
		expect(result.via).toBe("powershell.exe");
		const script = log[0]?.args.at(-1) ?? "";
		expect(script).toContain("VirtualScreen");
		expect(script).toContain("CopyFromScreen");
	});

	test("selects a single monitor on Windows when asked", async () => {
		const log: { command: string; args: string[] }[] = [];
		await captureScreen({ display: 2 }, "win32", runnerFor(["powershell.exe"], log));
		const script = log[0]?.args.at(-1) ?? "";
		expect(script).toContain("AllScreens");
		expect(script).toContain("$screens[1]");
	});

	test("falls through the Linux tools until one works", async () => {
		const log: { command: string; args: string[] }[] = [];
		// grim and spectacle missing; gnome-screenshot present
		const result = await captureScreen({}, "linux", runnerFor(["gnome-screenshot"], log));
		expect(result.via).toBe("gnome-screenshot");
		expect(log.map((entry) => entry.command)).toEqual(["grim", "spectacle", "gnome-screenshot"]);
	});

	test("explains what to install when Linux has no capture tool", async () => {
		await expect(captureScreen({}, "linux", runnerFor([]))).rejects.toBeInstanceOf(CaptureUnavailableError);
		await expect(captureScreen({}, "linux", runnerFor([]))).rejects.toThrow(LINUX_HINT.slice(0, 30));
	});

	test("reports the failure detail on other platforms", async () => {
		await expect(captureScreen({}, "darwin", runnerFor([]))).rejects.toThrow(/screencapture: not found/);
	});

	test("treats a command that writes nothing as a failure", async () => {
		const emptyRunner = async () => ({ code: 0, stderr: "" });
		await expect(captureScreen({}, "darwin", emptyRunner)).rejects.toThrow(/produced no file/);
	});
});
