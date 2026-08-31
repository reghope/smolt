import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

/**
 * Putting `smolt` on the reader's PATH, pointed at the CLI bundled inside
 * the app.
 *
 * The shim is rewritten on every launch, so updating the app silently
 * updates the terminal command too — one install, both surfaces, always the
 * same version. A CLI the reader installed themselves (npm i -g @smolt/cli)
 * lives elsewhere on PATH and resolves by their ordering; this only appends
 * its own directory, never reorders anyone else's.
 *
 * Windows-only for now, matching the only packaged platform.
 */

const BIN_DIRNAME = join(".smolt", "bin");

export function ensureCliShim(): void {
	if (!app.isPackaged || process.platform !== "win32") return;
	try {
		const cli = join(process.resourcesPath, "agent", "dist", "bundle", "cli.js");
		if (!existsSync(cli)) return;
		const binDir = join(app.getPath("home"), BIN_DIRNAME);
		mkdirSync(binDir, { recursive: true });

		// Electron's own binary doubles as Node, so the shim needs no runtime
		// beyond the app it shipped with.
		const shim = join(binDir, "smolt.cmd");
		const body = ["@echo off", "set ELECTRON_RUN_AS_NODE=1", `"${process.execPath}" "${cli}" %*`, ""].join("\r\n");
		let current = "";
		try {
			current = readFileSync(shim, "utf-8");
		} catch {
			// First run: no shim yet.
		}
		if (current !== body) writeFileSync(shim, body);

		void addToUserPath(binDir);
	} catch {
		// A machine where this fails still has a working app; the terminal
		// command is a convenience, not a dependency.
	}
}

/** Append the bin directory to HKCU\Environment Path if it is not there. */
async function addToUserPath(binDir: string): Promise<void> {
	const query = await run("reg", ["query", "HKCU\\Environment", "/v", "Path"]).catch(() => "");
	// "    Path    REG_EXPAND_SZ    C:\...;C:\..." — value may be absent entirely.
	const match = query.match(/\bPath\s+(REG_SZ|REG_EXPAND_SZ)\s+(.*)/i);
	const type = match?.[1] ?? "REG_EXPAND_SZ";
	const value = match?.[2]?.trim() ?? "";
	const entries = value.split(";").map((entry) => entry.trim().toLowerCase());
	if (entries.includes(binDir.toLowerCase())) return;

	const next = value ? `${value.replace(/;\s*$/, "")};${binDir}` : binDir;
	await run("reg", ["add", "HKCU\\Environment", "/v", "Path", "/t", type, "/d", next, "/f"]);
	// Tell running shells' parents the environment changed, the way setx does,
	// so new terminals see the command without a re-login.
	await run("powershell", [
		"-NoProfile",
		"-Command",
		`$s = Add-Type -MemberDefinition '[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);' -Name NativeMethods -PassThru; [UIntPtr]$r = [UIntPtr]::Zero; $null = $s::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r)`,
	]).catch(() => undefined);
}

function run(command: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(command, args, { windowsHide: true }, (error, stdout) => {
			if (error) reject(error);
			else resolve(stdout ?? "");
		});
	});
}
