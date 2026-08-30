import { useEffect } from "react";
import {
	addImageFiles,
	app,
	bump,
	call,
	clearSessionSelection,
	deleteSelectedSessions,
	cycleSession,
	newSession,
	toggleDiffPane,
	toggleSessionSearch,
	toggleSidebar,
	toggleSidePane,
	toggleTerminalPane,
} from "./state/app.ts";
import { useApp } from "./state/useApp.ts";
import { toggleVoice } from "./state/voice.ts";
import { Composer } from "./components/Composer.tsx";
import { ConfirmDialog } from "./components/ConfirmDialog.tsx";
import { ProviderDialog } from "./components/ProviderDialog.tsx";
import { ExtensionDialog } from "./components/ExtensionDialog.tsx";
import { RightRail } from "./components/RightRail.tsx";
import { SettingsDialog } from "./components/SettingsDialog.tsx";
import { ShortcutsDialog } from "./components/ShortcutsDialog.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { TerminalPane } from "./components/TerminalPane.tsx";
import { Titlebar } from "./components/Titlebar.tsx";
import { toggleAllToolOutput, Transcript } from "./components/Transcript.tsx";
import { TooltipProvider } from "./components/ui/tooltip.tsx";

export function App() {
	useApp();

	// Global keyboard shortcuts, as in the reference app.
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent): void => {
			if (!(e.ctrlKey || e.metaKey)) {
				// A selection made from the sidebar answers to Delete, but never while
				// the reader is typing: the composer owns the key then.
				const typing = document.activeElement instanceof HTMLElement && document.activeElement.isContentEditable;
				const inField =
					document.activeElement instanceof HTMLInputElement ||
					document.activeElement instanceof HTMLTextAreaElement;
				if ((e.key === "Delete" || e.key === "Backspace") && !typing && !inField && app.selectedSessions.size > 0) {
					e.preventDefault();
					void deleteSelectedSessions();
					return;
				}
				if (e.key === "Escape") {
					if (app.selectedSessions.size > 0) {
						clearSessionSelection();
						return;
					}
					if (app.shortcutsOpen) {
						app.shortcutsOpen = false;
						bump();
					} else if (app.chat.streaming) {
						// Escape is the universal "stop that". Nothing else owns it
						// once the dialogs are shut, and a turn in flight is the one
						// thing a reader most often wants out of.
						e.preventDefault();
						void call("abort");
					}
				}
				return;
			}
			const key = e.key.toLowerCase();
			if (e.key === "`") {
				e.preventDefault();
				toggleTerminalPane();
			} else if (e.key === ";") {
				e.preventDefault();
				toggleSidePane();
			} else if (e.key === "Tab") {
				e.preventDefault();
				void cycleSession(e.shiftKey ? -1 : 1);
			} else if (key === "n") {
				e.preventDefault();
				void newSession();
			} else if (key === ",") {
				e.preventDefault();
				app.settingsOpen = true;
				bump();
			} else if (key === "/") {
				e.preventDefault();
				app.shortcutsOpen = !app.shortcutsOpen;
				bump();
			} else if (key === "m" && !e.shiftKey) {
				e.preventDefault();
				toggleVoice();
			} else if (key === "b" && !e.shiftKey) {
				e.preventDefault();
				toggleSidebar();
			} else if (key === "k" && !e.shiftKey) {
				e.preventDefault();
				toggleSessionSearch(true);
			} else if (key === "u" && !e.shiftKey) {
				e.preventDefault();
				(document.getElementById("file-input") as HTMLInputElement | null)?.click();
			} else if (key === "o" && !e.shiftKey) {
				e.preventDefault();
				toggleAllToolOutput();
			} else if (e.shiftKey && key === "m") {
				e.preventDefault();
				app.modeMenuOpen = true;
				bump();
			} else if (e.shiftKey && key === "d") {
				e.preventDefault();
				toggleDiffPane();
			} else if (e.shiftKey && key === "i") {
				e.preventDefault();
				app.modelMenuOpen = true;
				bump();
			} else if (e.shiftKey && key === "e") {
				e.preventDefault();
				app.effortOpen = true;
				bump();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, []);

	// Typing anywhere focuses the composer, as in a terminal.
	useEffect(() => {
		const onMouseDown = (e: MouseEvent): void => {
			const target = e.target as HTMLElement;
			// Prose and code are selection surfaces: stealing focus mid-drag
			// would tear the selection out of the reader's hands.
			if (target.closest("button, input, textarea, a, details, [role=dialog], [role=menu], [data-slot], .md, pre")) {
				return;
			}
			if (window.getSelection()?.toString()) return;
			setTimeout(() => document.querySelector<HTMLTextAreaElement>("textarea")?.focus(), 0);
		};
		document.addEventListener("mousedown", onMouseDown);
		return () => document.removeEventListener("mousedown", onMouseDown);
	}, []);

	// Pasted images land in the composer from anywhere in the window.
	useEffect(() => {
		const onPaste = (event: ClipboardEvent): void => {
			const files = [...(event.clipboardData?.items ?? [])]
				.filter((item) => item.kind === "file" && item.type.startsWith("image/"))
				.map((item) => item.getAsFile())
				.filter((file): file is File => file !== null);
			if (files.length === 0) return;
			event.preventDefault();
			void addImageFiles(files);
		};
		document.addEventListener("paste", onPaste);
		return () => document.removeEventListener("paste", onPaste);
	}, []);

	return (
		<TooltipProvider delayDuration={300}>
			<Titlebar />
			<div className="flex h-screen">
				<Sidebar />
				<main className="flex min-w-0 flex-1 flex-col pt-9 @container">
					<Transcript />
					<Composer />
					<TerminalPane />
				</main>
				<RightRail />
			</div>
			<SettingsDialog />
			<ShortcutsDialog />
			<ExtensionDialog />
			<ConfirmDialog />
			<ProviderDialog />
		</TooltipProvider>
	);
}
