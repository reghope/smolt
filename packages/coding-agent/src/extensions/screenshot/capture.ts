import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Screen capture across platforms, using what each OS already ships.
 *
 * No native dependency: macOS has `screencapture`, Windows can drive
 * System.Drawing from PowerShell, and Linux has a handful of tools depending
 * on the desktop and display server, so there we try each in turn and report
 * what to install if none are present.
 */

export interface CaptureOptions {
	/** 1-based display index. Omitted or 0 captures everything. */
	display?: number;
	/** Milliseconds to wait before capturing, e.g. to let a window settle. */
	delayMs?: number;
	/** Capture a single window instead of the screen: "active" for the foreground
	 * window, or a case-insensitive title substring. Windows only. */
	window?: string;
}

export interface CaptureResult {
	png: Uint8Array;
	/** Command that produced the capture, for the tool's text output. */
	via: string;
}

export class CaptureUnavailableError extends Error {}

type Runner = (command: string, args: string[], timeoutMs: number) => Promise<{ code: number; stderr: string }>;

const defaultRunner: Runner = (command, args, timeoutMs) =>
	new Promise((resolve) => {
		const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
		let stderr = "";
		const timer = setTimeout(() => child.kill(), timeoutMs);
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ code: -1, stderr: error.message });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code: code ?? -1, stderr });
		});
	});

/** PowerShell capture of the whole virtual desktop, or one monitor. */
function windowsScript(outputPath: string, display?: number): string {
	const bounds =
		display && display > 0
			? `$screens = [System.Windows.Forms.Screen]::AllScreens
if ($screens.Length -lt ${display}) { Write-Error "display ${display} not found (${"$"}($screens.Length) available)"; exit 2 }
$area = $screens[${display - 1}].Bounds`
			: `$area = [System.Windows.Forms.SystemInformation]::VirtualScreen`;
	return `Add-Type -AssemblyName System.Windows.Forms, System.Drawing
${bounds}
$bitmap = New-Object System.Drawing.Bitmap $area.Width, $area.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($area.X, $area.Y, 0, 0, $bitmap.Size)
$bitmap.Save('${outputPath.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()`;
}

/** PowerShell capture of one window: the foreground window, or the first
 * visible main window whose title contains the given text (case-insensitive). */
function windowsWindowScript(outputPath: string, window: string): string {
	const findWindow =
		window === "active"
			? `$hwnd = [Win]::GetForegroundWindow()
if ($hwnd -eq [IntPtr]::Zero) { Write-Error 'no foreground window'; exit 2 }`
			: `$needle = '${window.replace(/'/g, "''").toLowerCase()}'
$proc = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle.ToLower().Contains($needle) } | Select-Object -First 1
if (-not $proc) { Write-Error ("no window title containing: " + $needle); exit 2 }
$hwnd = $proc.MainWindowHandle`;
	return `Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class Win {
	[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
	[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
	[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
	[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
[void][Win]::SetProcessDPIAware()
${findWindow}
$r = New-Object Win+RECT
[void][Win]::GetWindowRect($hwnd, [ref]$r)
$w = $r.Right - $r.Left
$h = $r.Bottom - $r.Top
if ($w -le 0 -or $h -le 0) { Write-Error 'window has no size'; exit 2 }
$bitmap = New-Object System.Drawing.Bitmap $w, $h
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($r.Left, $r.Top, 0, 0, $bitmap.Size)
$bitmap.Save('${outputPath.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()`;
}

/** Candidate commands per platform, tried in order until one succeeds. */
function candidates(
	platform: string,
	outputPath: string,
	display?: number,
	window?: string,
): { command: string; args: string[] }[] {
	if (platform === "darwin") {
		const args = ["-x", "-t", "png"];
		if (display && display > 0) args.push("-D", String(display));
		return [{ command: "screencapture", args: [...args, outputPath] }];
	}
	if (platform === "win32") {
		const script = window ? windowsWindowScript(outputPath, window) : windowsScript(outputPath, display);
		return [{ command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", script] }];
	}
	// Linux and the BSDs: Wayland first, then the common X11 tools.
	return [
		{ command: "grim", args: [outputPath] },
		{ command: "spectacle", args: ["-b", "-n", "-o", outputPath] },
		{ command: "gnome-screenshot", args: ["-f", outputPath] },
		{ command: "scrot", args: ["-o", outputPath] },
		{ command: "import", args: ["-window", "root", outputPath] },
		{ command: "xwd", args: ["-root", "-silent", "-out", outputPath] },
	];
}

export const LINUX_HINT =
	"No screenshot tool found. Install one of: grim (Wayland), gnome-screenshot, spectacle, scrot, or ImageMagick (import).";

/** Capture the screen and return PNG bytes. */
export async function captureScreen(
	options: CaptureOptions = {},
	platform: string = process.platform,
	run: Runner = defaultRunner,
): Promise<CaptureResult> {
	if (options.delayMs && options.delayMs > 0) {
		await new Promise((resolve) => setTimeout(resolve, Math.min(options.delayMs ?? 0, 10_000)));
	}

	if (options.window && platform !== "win32") {
		throw new CaptureUnavailableError("Window capture is currently only supported on Windows.");
	}

	const dir = mkdtempSync(join(tmpdir(), "smolt-shot-"));
	const outputPath = join(dir, "screen.png");
	try {
		const attempts = candidates(platform, outputPath, options.display, options.window);
		const failures: string[] = [];
		for (const attempt of attempts) {
			const { code, stderr } = await run(attempt.command, attempt.args, 20_000);
			if (code === 0) {
				let png: Uint8Array;
				try {
					png = readFileSync(outputPath);
				} catch {
					failures.push(`${attempt.command}: produced no file`);
					continue;
				}
				if (png.byteLength === 0) {
					failures.push(`${attempt.command}: produced an empty file`);
					continue;
				}
				return { png, via: attempt.command };
			}
			failures.push(`${attempt.command}: ${stderr.trim().split("\n")[0] || `exit ${code}`}`);
		}
		const detail = failures.join("; ");
		throw new CaptureUnavailableError(
			platform === "linux" || platform === "freebsd"
				? `${LINUX_HINT} (${detail})`
				: `Screen capture failed: ${detail}`,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
