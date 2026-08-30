import { app, type BrowserWindow } from "electron";

/**
 * Checking for a newer build, and installing it when the reader says so.
 *
 * The feed is the same place the installers are published, so an update is
 * whatever was last uploaded to the site — there is no release pipeline to
 * keep in step. Nothing installs itself: the window is told what is available
 * and the reader chooses when to restart.
 *
 * The bundled agent travels inside the app, so updating the app updates the
 * CLI it runs. A separately installed CLI is the reader's own, and is left
 * alone.
 */

export type UpdateState =
	| { status: "idle" }
	| { status: "checking" }
	| { status: "available"; version: string }
	| { status: "downloading"; version: string; percent: number }
	| { status: "ready"; version: string }
	| { status: "error"; message: string };

let state: UpdateState = { status: "idle" };
let started = false;

/** How often to look, once the app has settled. */
const EVERY_MS = 6 * 60 * 60 * 1000;

export function updateState(): UpdateState {
	return state;
}

export async function startUpdates(win: BrowserWindow): Promise<void> {
	// Only a packaged build has an installer to replace; in the workspace the
	// updater would look for a feed entry that does not describe this tree.
	if (!app.isPackaged || started) return;
	started = true;

	const { autoUpdater } = await import("electron-updater");
	autoUpdater.autoDownload = true;
	autoUpdater.autoInstallOnAppQuit = false;

	const announce = (next: UpdateState): void => {
		state = next;
		if (!win.isDestroyed()) win.webContents.send("update:state", next);
	};

	autoUpdater.on("checking-for-update", () => announce({ status: "checking" }));
	autoUpdater.on("update-available", (info) => announce({ status: "available", version: String(info.version) }));
	autoUpdater.on("update-not-available", () => announce({ status: "idle" }));
	autoUpdater.on("download-progress", (progress) => {
		announce({
			status: "downloading",
			version: state.status === "available" ? state.version : "",
			percent: Math.round(progress.percent),
		});
	});
	autoUpdater.on("update-downloaded", (info) => announce({ status: "ready", version: String(info.version) }));
	autoUpdater.on("error", (error) => {
		// A feed that cannot be reached is not worth interrupting anyone over.
		announce({ status: "error", message: error instanceof Error ? error.message : String(error) });
	});

	const check = (): void => {
		void autoUpdater.checkForUpdates().catch(() => undefined);
	};
	check();
	setInterval(check, EVERY_MS);
}

export async function installUpdate(): Promise<void> {
	if (state.status !== "ready") return;
	const { autoUpdater } = await import("electron-updater");
	autoUpdater.quitAndInstall();
}

export async function checkNow(): Promise<void> {
	if (!app.isPackaged) return;
	const { autoUpdater } = await import("electron-updater");
	await autoUpdater.checkForUpdates().catch(() => undefined);
}
