import { pickProject, projectName } from "../state/app.ts";
import { useApp } from "../state/useApp.ts";
import { Button } from "./ui/button.tsx";
import { Icon } from "./ui/icon.tsx";

/**
 * What a chat shows before it has anything in it.
 *
 * The greeting names the folder because that is the one thing that changes
 * what the next turn will do. With no folder open it says so and offers the
 * way in, since that is the state the app starts in and a bare screen would
 * leave the reader guessing where any files would land.
 */

function greeting(): string {
	const hour = new Date().getHours();
	if (hour < 5) return "Still going";
	if (hour < 12) return "Morning";
	if (hour < 18) return "Afternoon";
	return "Evening";
}

export function EmptyChat() {
	const state = useApp();
	const folder = projectName();
	const inProject = state.appInfo.hasProject && folder !== "";

	return (
		<div className="mx-auto mt-[16vh] flex max-w-[520px] flex-col items-center px-2 text-center @max-[550px]:mt-[8vh]">
			<h1 className="text-balance text-xl font-medium tracking-tight">
				{greeting()}
				{inProject ? `, what's next in ${folder}?` : ", what shall we work on?"}
			</h1>
			{!inProject && (
				<>
					<p className="mt-3 text-sm leading-relaxed text-faint">
						No project folder is open. Ask anything, or open one to work in; otherwise you will be asked where new
						files should go.
					</p>
					<Button variant="outline" size="sm" className="mt-5 gap-2" onClick={() => void pickProject()}>
						<Icon name="folder" />
						Open a folder
					</Button>
				</>
			)}
		</div>
	);
}
