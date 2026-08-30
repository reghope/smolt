import { useEffect, useState } from "react";
import { api, type UpdateState } from "../lib/api.ts";
import { Icon } from "./ui/icon.tsx";

/**
 * The update notice, above the settings row.
 *
 * It only appears when there is something to say. A build that is downloading
 * says so quietly; one that is ready offers the restart and waits to be asked,
 * because a chat mid-turn is a poor moment to close the window.
 *
 * The agent travels inside the app, so this updates the CLI it runs too.
 */
export function UpdateBanner() {
	const [state, setState] = useState<UpdateState>({ status: "idle" });

	useEffect(() => {
		void api
			.updateState()
			.then(setState)
			.catch(() => undefined);
		api.onUpdateState?.(setState);
	}, []);

	if (state.status === "idle" || state.status === "checking" || state.status === "error") return null;

	if (state.status === "downloading") {
		return (
			<div className="mx-1 mb-1 flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-faint">
				<Icon name="spinner" className="animate-spin" />
				<span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
					Downloading update{state.percent > 0 ? ` — ${state.percent}%` : "…"}
				</span>
			</div>
		);
	}

	const ready = state.status === "ready";
	return (
		<button
			type="button"
			title={ready ? "Restart to finish updating" : "An update is available"}
			className="mx-1 mb-1 flex items-center gap-2.5 rounded-lg border bg-card px-2.5 py-2 text-left transition-colors hover:border-border-strong"
			onClick={() => {
				if (ready) void api.updateInstall();
				else void api.updateCheck();
			}}
		>
			<Icon name="update" className="flex-none text-salmon" />
			<span className="min-w-0 flex-1">
				<span className="block text-sm leading-tight">{ready ? "Relaunch to update" : "Update available"}</span>
				<span className="block text-[11px] text-faint">v{state.version}</span>
			</span>
			<Icon name="chevron" className="flex-none text-faint" />
		</button>
	);
}
