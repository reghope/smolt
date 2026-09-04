import { useEffect, useState } from "react";
import { answerUiRequest, app } from "../state/app.ts";
import { useApp } from "../state/useApp.ts";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog.tsx";
import { Input } from "./ui/input.tsx";

/**
 * Modal surface for extension dialogs (extension_ui_request over RPC):
 * select, confirm, and input. Requests queue; the head renders until it is
 * answered, and closing the dialog counts as cancelling it — the same
 * semantics the TUI's native dialogs have.
 */
export function ExtensionDialog() {
	useApp();
	const request = app.uiRequests[0];
	const [value, setValue] = useState("");
	const [copied, setCopied] = useState(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset the draft per request, not per keystroke
	useEffect(() => {
		setValue("");
		setCopied(false);
	}, [request?.id]);
	// The device-login code an extension puts in the title, e.g. "GitHub code: A4B0-B874".
	const deviceCode = /\bcode: ([A-Z0-9]{4,}-[A-Z0-9]{4,})$/.exec(request?.title ?? "")?.[1];
	if (!request) return null;
	const cancel = () => answerUiRequest({ id: request.id, cancelled: true });
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) cancel();
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{request.title}</DialogTitle>
					{request.message !== undefined && request.message !== "" && (
						<DialogDescription className="whitespace-pre-wrap">{request.message}</DialogDescription>
					)}
				</DialogHeader>
				{request.method === "select" && (
					// Scroll inside the dialog, never grow past the window: a
					// 40-provider picker once rendered ~1800px tall with the title
					// and Close pushed off-screen.
					<div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto pr-1">
						{(request.options ?? []).map((option) => (
							<Button
								key={option}
								variant="outline"
								className="flex-none justify-start"
								onClick={() => answerUiRequest({ id: request.id, value: option })}
							>
								{option}
							</Button>
						))}
					</div>
				)}
				{request.method === "input" && (
					<form
						className="flex gap-2"
						onSubmit={(event) => {
							event.preventDefault();
							answerUiRequest({ id: request.id, value });
						}}
					>
						<Input
							autoFocus
							value={value}
							placeholder={request.placeholder}
							onChange={(event) => setValue(event.target.value)}
						/>
						<Button type="submit">OK</Button>
					</form>
				)}
				{/* A one-time login code is the whole point of the dialog it appears in:
				    shown as prose it gets lost, and it has to be retyped into a browser.
				    Give it its own line, in monospace, with a button to copy it. */}
				{deviceCode !== undefined && (
					<div className="flex items-center justify-between gap-3 rounded-md border bg-muted/40 px-4 py-3">
						<span className="select-all font-mono text-2xl tracking-[0.2em]">{deviceCode}</span>
						<Button
							variant="outline"
							size="sm"
							onClick={() => {
								void navigator.clipboard.writeText(deviceCode);
								setCopied(true);
							}}
						>
							{copied ? "Copied" : "Copy"}
						</Button>
					</div>
				)}
				{request.method === "confirm" && (
					<div className="flex justify-end gap-2">
						<Button variant="outline" onClick={() => answerUiRequest({ id: request.id, confirmed: false })}>
							Cancel
						</Button>
						<Button autoFocus onClick={() => answerUiRequest({ id: request.id, confirmed: true })}>
							OK
						</Button>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
