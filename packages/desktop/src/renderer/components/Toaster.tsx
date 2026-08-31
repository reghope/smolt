import { dismissToast } from "../state/app.ts";
import { useApp } from "../state/useApp.ts";
import { Toast, ToastClose, ToastDescription, ToastProvider, ToastViewport } from "./ui/toast.tsx";

/**
 * Floating transient cards, bottom-right, newest at the bottom — real shadcn
 * toasts on Radix primitives, so hovering pauses the timer and a swipe right
 * dismisses. They live above everything, never in the chat column: the notice
 * strip above the composer is for standing state; a toast is for a moment
 * ("Showing thoughts", a filed ticket, an agent error) and leaves on its own.
 * Radix owns each toast's lifetime; closing (timer, swipe, or the ×) reports
 * back through onOpenChange and the entry leaves the store.
 */
export function Toaster() {
	const state = useApp();
	return (
		<ToastProvider swipeDirection="right">
			{state.toasts.map((entry) => (
				<Toast
					key={entry.id}
					variant={entry.tone === "error" ? "destructive" : "default"}
					duration={entry.tone === "error" ? 6000 : 4000}
					onOpenChange={(open) => {
						if (!open) dismissToast(entry.id);
					}}
				>
					<ToastDescription>{entry.message}</ToastDescription>
					<ToastClose />
				</Toast>
			))}
			<ToastViewport />
		</ToastProvider>
	);
}
