import { Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { processImage } from "../../utils/image-process.ts";
import { CaptureUnavailableError, captureScreen } from "./capture.ts";

/**
 * Screen capture: lets the agent look at the desktop.
 *
 * Uses each platform's own tooling (see capture.ts) so there is no native
 * dependency, and hands the PNG back as image content — the same shape the
 * `read` tool uses for images — after running it through the shared resizer
 * so a 4K desktop cannot blow past a provider's inline image limit.
 */

interface ScreenshotDetails {
	/** Command that produced the capture, empty when it failed. */
	via: string;
	/** 0 means the whole desktop. */
	display: number;
}

export default function screenshotExtension(smolt: ExtensionAPI): void {
	smolt.registerTool({
		name: "screenshot",
		label: "Screenshot",
		description:
			"Capture the screen and look at it. Returns the image, so you can read what is on screen: a " +
			"running app, a rendered UI, a dialog, a chart, a terminal window you do not own.\n\n" +
			"WHEN: the user refers to something visible on their screen ('this looks wrong', 'see the " +
			"error?'), or you need to check how something you built actually renders. Prefer reading " +
			"files or running commands when the answer is in the code — a screenshot costs far more " +
			"tokens than text.\n\n" +
			"NOTE: captures whatever is on the display right now, including any window in front. On " +
			"multi-monitor setups, omit 'display' for everything or pass a 1-based index for one screen.",
		parameters: Type.Object({
			display: Type.Optional(
				Type.Number({
					description:
						"1-based monitor index to capture. Omit (or 0) to capture the whole desktop across all monitors.",
				}),
			),
			delay_ms: Type.Optional(
				Type.Number({
					description:
						"Wait this many milliseconds before capturing, to let a window open or an animation settle. Max 10000.",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const { display, delay_ms } = params as { display?: number; delay_ms?: number };
			const failed: ScreenshotDetails = { via: "", display: display ?? 0 };
			try {
				const capture = await captureScreen({ display, delayMs: delay_ms });
				const processed = await processImage(capture.png, "image/png");
				if (!processed.ok) {
					return { content: [{ type: "text" as const, text: processed.message }], details: failed, isError: true };
				}
				const scope = display && display > 0 ? `display ${display}` : "full desktop";
				return {
					content: [
						{ type: "text" as const, text: `Screenshot of the ${scope} (via ${capture.via}).` },
						{ type: "image" as const, data: processed.data, mimeType: processed.mimeType },
					],
					details: { via: capture.via, display: display ?? 0 } satisfies ScreenshotDetails,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [
						{
							type: "text" as const,
							text: error instanceof CaptureUnavailableError ? message : `Screen capture failed: ${message}`,
						},
					],
					details: failed,
					isError: true,
				};
			}
		},
	});
}
