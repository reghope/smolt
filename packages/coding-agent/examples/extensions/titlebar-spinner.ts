/**
 * Titlebar Spinner Extension
 *
 * Shows a braille spinner animation in the terminal title while the agent is working.
 * Uses `ctx.ui.setTitle()` to update the terminal title via the extension API.
 *
 * Usage:
 *   smolt --extension examples/extensions/titlebar-spinner.ts
 */

import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "smolt";

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function getBaseTitle(smolt: ExtensionAPI): string {
	const cwd = path.basename(process.cwd());
	const session = smolt.getSessionName();
	return session ? `smolt - ${session} - ${cwd}` : `smolt - ${cwd}`;
}

export default function (smolt: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | null = null;
	let frameIndex = 0;

	function stopAnimation(ctx: ExtensionContext) {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		frameIndex = 0;
		ctx.ui.setTitle(getBaseTitle(smolt));
	}

	function startAnimation(ctx: ExtensionContext) {
		stopAnimation(ctx);
		timer = setInterval(() => {
			const frame = BRAILLE_FRAMES[frameIndex % BRAILLE_FRAMES.length];
			const cwd = path.basename(process.cwd());
			const session = smolt.getSessionName();
			const title = session ? `${frame} smolt - ${session} - ${cwd}` : `${frame} smolt - ${cwd}`;
			ctx.ui.setTitle(title);
			frameIndex++;
		}, 80);
	}

	smolt.on("agent_start", async (_event, ctx) => {
		startAnimation(ctx);
	});

	smolt.on("agent_settled", async (_event, ctx) => {
		stopAnimation(ctx);
	});

	smolt.on("session_shutdown", async (_event, ctx) => {
		stopAnimation(ctx);
	});
}
