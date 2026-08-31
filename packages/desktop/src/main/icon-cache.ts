import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

/**
 * Nudging Windows' icon cache once after an update.
 *
 * Explorer caches shell icons aggressively, so a build that changes the app
 * icon can keep showing the old one on shortcuts and the taskbar long after
 * the exe changed. `ie4uinit -show` rebuilds that cache per-user without
 * elevation. Running it every launch would make desktop icons flicker for
 * nothing, so it runs only on the first launch of a new version — the one
 * moment the icon could genuinely be stale.
 */
export function refreshIconCacheAfterUpdate(): void {
	if (!app.isPackaged || process.platform !== "win32") return;
	try {
		const stamp = join(app.getPath("userData"), "last-run-version");
		const version = app.getVersion();
		let last = "";
		try {
			last = readFileSync(stamp, "utf-8").trim();
		} catch {
			// First run ever: a fresh install's icon is already right, so just
			// record the version and do nothing.
			writeFileSync(stamp, version);
			return;
		}
		if (last === version) return;
		writeFileSync(stamp, version);
		execFile("ie4uinit.exe", ["-show"], { windowsHide: true }, () => undefined);
	} catch {
		// A stale icon is cosmetic; never let this interfere with startup.
	}
}
