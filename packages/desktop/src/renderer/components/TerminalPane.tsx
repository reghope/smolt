import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn.ts";
import { app, bump, call, runTerminalCommand, terminalHistory, toggleTerminalPane } from "../state/app.ts";
import { useApp } from "../state/useApp.ts";
import { Button } from "./ui/button.tsx";
import { Icon } from "./ui/icon.tsx";

/** Commands run through the agent's own shell, sharing its working directory. */
export function TerminalPane() {
	const state = useApp();
	const [draft, setDraft] = useState("");
	const historyIndexRef = useRef(-1);
	const logRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		const node = logRef.current;
		if (node) node.scrollTop = node.scrollHeight;
	});
	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	if (!state.terminalOpen) return null;

	return (
		<section className="flex h-[34%] min-h-40 flex-none flex-col border-t border-border-strong bg-background-deep [background:var(--background-deep)]">
			<div className="flex select-none items-center justify-between border-b py-1 pr-2 pl-3.5">
				<h2 className="text-sm font-semibold text-muted-foreground">Terminal</h2>
				<div className="flex gap-0.5">
					<Button
						variant="ghost"
						size="icon"
						className="size-7"
						title="Clear"
						onClick={() => {
							app.terminalLog = [];
							bump();
						}}
					>
						<Icon name="trash" />
					</Button>
					<Button variant="ghost" size="icon" className="size-7" title="Close (Ctrl+`)" onClick={() => toggleTerminalPane(false)}>
						<Icon name="close" />
					</Button>
				</div>
			</div>
			<div ref={logRef} className="flex-1 overflow-y-auto px-3.5 py-2 font-mono text-xs leading-normal">
				{state.terminalLog.map((entry, index) =>
					entry.kind === "cmd" ? (
						<div key={index} className="pt-1 pb-0.5">
							<span className="mr-2 select-none text-salmon-text">$</span>
							{entry.text}
						</div>
					) : entry.kind === "out" ? (
						<pre key={index} className="mb-1 ml-4 whitespace-pre-wrap break-words text-muted-foreground">
							{entry.text}
						</pre>
					) : (
						<div
							key={index}
							className={cn(
								"mb-1.5 ml-4",
								entry.tone === "fail" && "text-destructive",
								entry.tone !== "fail" && "text-faint",
							)}
						>
							{entry.text}
						</div>
					),
				)}
			</div>
			<div className="flex items-center border-t py-2 pr-2.5 pl-3.5">
				<span className="mr-2 select-none font-mono text-xs text-salmon-text">$</span>
				<input
					ref={inputRef}
					type="text"
					value={draft}
					spellCheck={false}
					placeholder="Run a command in the session's directory…"
					className="min-w-0 flex-1 bg-transparent font-mono text-xs outline-none placeholder:font-sans placeholder:text-faint"
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							const command = draft.trim();
							if (command === "") return;
							setDraft("");
							historyIndexRef.current = -1;
							void runTerminalCommand(command);
							return;
						}
						if (event.key === "ArrowUp" && terminalHistory.length > 0) {
							event.preventDefault();
							historyIndexRef.current =
								historyIndexRef.current === -1 ? terminalHistory.length - 1 : Math.max(0, historyIndexRef.current - 1);
							setDraft(terminalHistory[historyIndexRef.current] ?? "");
						} else if (event.key === "ArrowDown" && historyIndexRef.current !== -1) {
							event.preventDefault();
							if (historyIndexRef.current >= terminalHistory.length - 1) {
								historyIndexRef.current = -1;
								setDraft("");
							} else {
								historyIndexRef.current += 1;
								setDraft(terminalHistory[historyIndexRef.current] ?? "");
							}
						} else if (event.key === "Escape") {
							toggleTerminalPane(false);
						}
					}}
				/>
				{state.terminalBusy && (
					<Button
						variant="ghost"
						size="icon"
						className="size-7 hover:bg-destructive/10 hover:text-destructive"
						title="Stop"
						onClick={() => void call("abortBash")}
					>
						<Icon name="stop" />
					</Button>
				)}
			</div>
		</section>
	);
}
