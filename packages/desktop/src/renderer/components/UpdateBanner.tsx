import { useEffect, useState } from "react";
import { api, type UpdateState } from "../lib/api.ts";
import { Icon } from "./ui/icon.tsx";

/**
 * The update notice, above the settings row.
 *
 * It only appears when there is something to say. A new build is fetched in
 * the background and then waits: nothing installs on its own, and nothing
 * restarts until this is clicked, because a chat mid-turn is a poor moment
 * to close the window.
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

	// A hotfix applies itself; the row reports rather than asks.
	if (state.status === "installing") {
		return (
			<div className="mb-1 flex w-full items-center gap-2 rounded-lg border bg-card px-3 py-2 text-xs">
				<Icon name="spinner" className="flex-none animate-spin text-salmon" />
				<span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
					Updating to v{state.version} — restarting
				</span>
			</div>
		);
	}
	if (state.status === "ready" && state.hotfix) {
		return (
			<div className="mb-1 flex w-full items-center gap-2 rounded-lg border bg-card px-3 py-2 text-xs">
				<Icon name="update" className="flex-none text-salmon" />
				<span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
					v{state.version} installs when this chat is done
				</span>
			</div>
		);
	}

	if (state.status === "downloading") {
		return (
			<div className="mb-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-faint">
				<Icon name="spinner" className="animate-spin" />
				<span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
					Fetching update{state.percent > 0 ? ` — ${state.percent}%` : "…"}
				</span>
			</div>
		);
	}

	const ready = state.status === "ready";
	return (
		<button
			type="button"
			title={ready ? "Restart to finish updating" : "An update is available"}
			className="mb-1 flex w-full items-center gap-2.5 rounded-lg border bg-card px-3 py-2 text-left transition-colors hover:border-border-strong"
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
