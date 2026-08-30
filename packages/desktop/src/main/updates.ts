import { app, type BrowserWindow } from "electron";

/**
 * Checking for a newer build, and installing it when the reader says so.
 *
 * The feed is the same place the installers are published, so an update is
 * whatever was last uploaded to the site — there is no release pipeline to
 * keep in step. An ordinary update waits: the window is told what is
 * available and the reader chooses when to restart.
 *
 * A release marked as a hotfix does not wait. It is fetched and applied on
 * its own, once the app is idle — a build published to correct something
 * broken is worth less the longer it sits behind a button. It still never
 * interrupts a turn in progress; it waits for the work to finish first.
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
	| { status: "ready"; version: string; hotfix?: boolean }
	| { status: "installing"; version: string }
	| { status: "error"; message: string };

let state: UpdateState = { status: "idle" };
let started = false;

/** How often to look, once the app has settled. */
const EVERY_MS = 6 * 60 * 60 * 1000;
/** How often a waiting hotfix asks whether the app is free yet. */
const IDLE_POLL_MS = 5000;

export function updateState(): UpdateState {
	return state;
}

/** How a release says it is a hotfix: the release name the build was given. */
function isHotfix(info: { releaseName?: unknown; releaseNotes?: unknown }): boolean {
	const name = String(info.releaseName ?? "");
	const notes = typeof info.releaseNotes === "string" ? info.releaseNotes : "";
	return /hotfix/i.test(name) || /hotfix/i.test(notes);
}

/**
 * @param isIdle Whether the app can be restarted without losing work.
 */
export async function startUpdates(win: BrowserWindow, isIdle: () => boolean = () => true): Promise<void> {
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
	autoUpdater.on("update-downloaded", (info) => {
		const version = String(info.version);
		if (!isHotfix(info)) {
			announce({ status: "ready", version });
			return;
		}
		announce({ status: "ready", version, hotfix: true });
		// Wait for the work to finish, however long that takes. Restarting
		// through a running turn would throw away the thing being waited on.
		const applyWhenIdle = (): void => {
			if (!isIdle()) {
				setTimeout(applyWhenIdle, IDLE_POLL_MS);
				return;
			}
			announce({ status: "installing", version });
			// A beat, so the window can say what is happening before it goes.
			setTimeout(() => autoUpdater.quitAndInstall(), 1200);
		};
		setTimeout(applyWhenIdle, IDLE_POLL_MS);
	});
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
