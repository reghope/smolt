import { app, bump } from "../state/app.ts";
import { useApp } from "../state/useApp.ts";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog.tsx";

const SHORTCUTS: [string, string][] = [
	["Enter", "Send message"],
	["Shift + Enter", "New line"],
	["↑ / ↓", "Previous or next prompt"],
	["Esc", "Stop the response, or close a panel"],
	["Ctrl + N", "New session"],
	["Ctrl + B", "Show or hide the sidebar"],
	["Ctrl + K", "Search sessions"],
	["Ctrl + Tab", "Next session"],
	["Ctrl + Shift + Tab", "Previous session"],
	["Ctrl + Shift + I", "Model menu"],
	["Ctrl + Shift + E", "Effort menu"],
	["1 – 9", "Select an item in an open menu"],
	["Ctrl + Shift + M", "Permission mode menu"],
	["Ctrl + Shift + D", "Toggle the changes pane"],
	["Ctrl + `", "Toggle the terminal"],
	["Ctrl + ;", "Toggle the side chat"],
	["Ctrl + O", "Expand or collapse all tool output"],
	["Ctrl + M", "Dictate"],
	["Escape", "Stop the current turn"],
	["Ctrl + U", "Attach files or photos"],
	["Ctrl + V", "Paste an image into the composer"],
	["Ctrl + ,", "Settings"],
	["Ctrl + /", "This list"],
];

export function ShortcutsDialog() {
	const state = useApp();
	return (
		<Dialog
			open={state.shortcutsOpen}
			onOpenChange={(open) => {
				app.shortcutsOpen = open;
				bump();
			}}
		>
			<DialogContent className="max-h-[85vh] w-96 overflow-y-auto">
				<DialogHeader>
					<DialogTitle>Keyboard shortcuts</DialogTitle>
				</DialogHeader>
				<dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2 text-sm">
					{SHORTCUTS.map(([keys, what]) => (
						<div key={keys} className="contents">
							<dt className="justify-self-start whitespace-nowrap rounded-md border bg-background-deep px-1.5 py-0.5 font-mono text-xs text-muted-foreground [background:var(--background-deep)]">
								{keys}
							</dt>
							<dd className="text-muted-foreground">{what}</dd>
						</div>
					))}
				</dl>
			</DialogContent>
		</Dialog>
	);
}
