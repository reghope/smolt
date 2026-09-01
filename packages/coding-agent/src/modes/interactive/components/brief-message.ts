import { Box, Markdown, type MarkdownTheme, Text } from "@smolt/tui";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

/**
 * A brief an extension sent on the harness's behalf — the instructions behind
 * `/review`, `/wayfinder`, a battletest kickoff, the taste gate.
 *
 * These are ordinary user messages to the model, but they are not the reader
 * talking, and rendering them in full put a wall of command instructions into
 * the transcript in the reader's own voice — which reads as "my command was
 * sent as a message" rather than "my command ran". Collapsed to one line, with
 * the same treatment skill invocations get, so the transcript shows that a
 * brief went out and stays out of the way.
 */
export class BriefMessageComponent extends Box {
	private expanded = false;
	private readonly text: string;
	private readonly markdownTheme: MarkdownTheme;

	constructor(text: string, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super(1, 1, (t) => theme.bg("customMessageBg", t));
		this.text = text;
		this.markdownTheme = markdownTheme;
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	/** The brief's opening sentence, which names what it asked for. */
	private summary(): string {
		const firstLine =
			this.text
				.split("\n")
				.find((line) => line.trim() !== "")
				?.trim() ?? "";
		const sentence = /^(.{0,96}?[.!?])(\s|$)/.exec(firstLine)?.[1] ?? firstLine;
		return sentence.length > 96 ? `${sentence.slice(0, 93)}...` : sentence;
	}

	private updateDisplay(): void {
		this.clear();
		if (this.expanded) {
			this.addChild(new Text(theme.fg("customMessageLabel", "\x1b[1m[brief]\x1b[22m"), 0, 0));
			this.addChild(
				new Markdown(this.text, 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
			return;
		}
		const line =
			theme.fg("customMessageLabel", "\x1b[1m[brief]\x1b[22m ") +
			theme.fg("customMessageText", this.summary()) +
			theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`);
		this.addChild(new Text(line, 0, 0));
	}
}
