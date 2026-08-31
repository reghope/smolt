import { useEffect, useState } from "react";
import { resolveInput } from "../state/app.ts";
import { useApp } from "../state/useApp.ts";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog.tsx";
import { Input } from "./ui/input.tsx";

/**
 * The app's single-line prompt (renaming a chat, naming a worktree): every
 * flow that would otherwise reach for window.prompt, which Electron does not
 * implement: it throws, and the flow silently does nothing. Runs through
 * `requestInput` in state, mirroring `requestConfirm`.
 */
export function PromptDialog() {
	const state = useApp();
	const request = state.inputRequest;
	const [value, setValue] = useState("");

	// Each request starts from its own initial text, not the last one's.
	useEffect(() => {
		setValue(request?.initial ?? "");
	}, [request]);

	return (
		<Dialog open={request !== null} onOpenChange={(open) => !open && resolveInput(null)}>
			{request && (
				<DialogContent className="w-[26rem] max-w-[92vw]">
					<DialogTitle>{request.title}</DialogTitle>
					<form
						onSubmit={(event) => {
							event.preventDefault();
							resolveInput(value);
						}}
						className="flex flex-col gap-4"
					>
						{request.message && <p className="text-sm leading-relaxed text-muted-foreground">{request.message}</p>}
						<Input
							autoFocus
							value={value}
							placeholder={request.placeholder}
							onChange={(event) => setValue(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Escape") resolveInput(null);
							}}
						/>
						<div className="flex justify-end gap-2">
							<Button type="button" variant="secondary" size="sm" onClick={() => resolveInput(null)}>
								Cancel
							</Button>
							<Button type="submit" size="sm">
								OK
							</Button>
						</div>
					</form>
				</DialogContent>
			)}
		</Dialog>
	);
}
