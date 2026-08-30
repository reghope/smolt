import { Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { api } from "./lib/api.ts";
import { boot } from "./state/app.ts";

/**
 * A render crash must read as a crash, never as a silent black window: the
 * boundary names the error and offers a reload.
 */
class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
	constructor(props: { children: ReactNode }) {
		super(props);
		this.state = { error: null };
	}

	static getDerivedStateFromError(error: Error): { error: Error } {
		return { error };
	}

	override render(): ReactNode {
		if (!this.state.error) return this.props.children;
		return (
			<div className="flex h-screen flex-col items-center justify-center gap-3 p-8 text-center">
				<div className="text-sm font-semibold">Something broke in the interface.</div>
				<pre className="max-h-48 max-w-xl overflow-auto rounded-lg border bg-card p-3 text-left font-mono text-xs text-destructive">
					{String(this.state.error.stack ?? this.state.error)}
				</pre>
				<button
					type="button"
					className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
					onClick={() => location.reload()}
				>
					Reload
				</button>
			</div>
		);
	}
}

boot();

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<Boundary>
			<App />
		</Boundary>,
	);
	// The main process holds the window until the renderer is standing.
	api.ready();
}
