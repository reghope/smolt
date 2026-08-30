import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Full-boot smoke test: launches the real Electron binary with the built
 * app in SMOLT_DESKTOP_SMOKE mode. The main process exits 0 only after the
 * renderer signals ready over IPC (window created, preload bridge working,
 * first paint done); it exits 1 on a 20s timeout.
 */

const PKG = resolve(import.meta.dirname, "..");
const ELECTRON = resolve(
	PKG,
	"..",
	"..",
	"node_modules",
	"electron",
	"dist",
	process.platform === "win32" ? "electron.exe" : "electron",
);
const BUILT = existsSync(resolve(PKG, "dist", "main.cjs"));

describe.skipIf(!existsSync(ELECTRON) || !BUILT)("electron smoke", () => {
	test("the app boots and the renderer signals ready", () => {
		const env = { ...process.env, SMOLT_DESKTOP_SMOKE: "1" };
		delete (env as Record<string, unknown>).ELECTRON_RUN_AS_NODE;
		const result = spawnSync(ELECTRON, ["."], { cwd: PKG, env, encoding: "utf-8", timeout: 60_000 });
		expect(result.stdout + result.stderr).toContain("smoke: renderer ready");
		expect(result.status).toBe(0);
	}, 90_000);
});
