import { resolveConfirm } from "../state/app.ts";
import { useApp } from "../state/useApp.ts";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "./ui/alert-dialog.tsx";
import { buttonVariants } from "./ui/button.tsx";

/**
 * The app's confirmation dialog — every "are you sure" runs through
 * `requestConfirm`, so nothing ever falls back to the operating system's
 * window.confirm chrome.
 */
export function ConfirmDialog() {
	const state = useApp();
	const request = state.confirm;
	return (
		<AlertDialog open={request !== null} onOpenChange={(open) => !open && resolveConfirm(false)}>
			{request && (
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{request.title}</AlertDialogTitle>
						<AlertDialogDescription>{request.message}</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel
							className={buttonVariants({ variant: "secondary", size: "sm" })}
							onClick={() => resolveConfirm(false)}
						>
							Cancel
						</AlertDialogCancel>
						<AlertDialogAction
							className={buttonVariants({ variant: request.destructive ? "destructive" : "default", size: "sm" })}
							onClick={() => resolveConfirm(true)}
						>
							{request.actionLabel}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			)}
		</AlertDialog>
	);
}
