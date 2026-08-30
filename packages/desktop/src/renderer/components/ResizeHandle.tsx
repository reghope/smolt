import { useState } from "react";
import { cn } from "../lib/cn.ts";

/**
 * The pane divider: an invisible 11px grab zone on a panel's edge whose
 * hairline and centre grip reveal in the accent on hover or drag, fading out
 * toward the ends — the treatment ported from the imagined web agent.
 *
 * The drag itself is deliberate about its endpoints: the panel follows the
 * pointer all the way, and releasing inside the collapse zone closes the
 * panel rather than stranding a sliver too thin to grab again — reopening is
 * the toggle button's job.
 */
export function ResizeHandle({
	side,
	label,
	minWidth,
	flush = false,
	onWidth,
	onRelease,
	measure,
}: {
	/** Which edge of its panel the handle sits on. */
	side: "left" | "right";
	label: string;
	/**
	 * A collapsed panel's handle sits flush inside the window instead of
	 * straddling the border, so the whole 0–10px strip at the edge is
	 * hoverable and grabbable.
	 */
	flush?: boolean;
	/** Narrower than this, the panel snaps to the minimum — or shut. */
	minWidth: number;
	/** Paint a live width while dragging; already snapped (0, or ≥ minWidth). */
	onWidth: (width: number) => void;
	/** The drag ended at this raw width; settle or collapse. */
	onRelease: (width: number) => void;
	/** Pointer x → candidate panel width. */
	measure: (clientX: number) => number;
}) {
	const [dragging, setDragging] = useState(false);

	// The panel snaps while dragging rather than trailing the pointer into
	// unusable widths: inside the collapse zone it shuts completely, so what
	// a release would do is visible before the button comes up; between the
	// zone and the minimum it holds at the minimum instead of crushing.
	const snap = (raw: number): number => (raw <= PANE_COLLAPSE_ZONE ? 0 : Math.max(raw, minWidth));

	const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
		event.preventDefault();
		// The move and release listeners go on the window, not the handle.
		// Binding them to the handle makes the drag depend on pointer capture
		// holding, and when it does not the pane stops tracking the pointer and
		// only catches up on release.
		setDragging(true);
		document.body.classList.add("select-none");
		let width = measure(event.clientX);
		let painted = -1;
		let frame: number | null = null;
		const paint = (): void => {
			frame = null;
			const snapped = snap(width);
			if (snapped !== painted) {
				painted = snapped;
				onWidth(snapped);
			}
		};
		const onMove = (move: PointerEvent): void => {
			width = measure(move.clientX);
			if (frame === null) frame = requestAnimationFrame(paint);
		};
		const onUp = (): void => {
			if (frame !== null) cancelAnimationFrame(frame);
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onUp);
			setDragging(false);
			document.body.classList.remove("select-none");
			onRelease(width);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onUp);
	};

	return (
		<div
			role="separator"
			aria-orientation="vertical"
			aria-label={label}
			title="Drag to resize; drag to the edge to close"
			className={cn(
				"group/handle absolute inset-y-0 z-30 cursor-col-resize touch-none",
				flush ? "w-2.5" : "w-[11px]",
				flush ? (side === "left" ? "right-0" : "left-0") : side === "left" ? "-left-1.5" : "-right-1.5",
			)}
			onPointerDown={startResize}
		>
			<span
				className={cn(
					"absolute inset-y-2 left-[5px] w-px bg-transparent transition-colors [mask-image:linear-gradient(to_bottom,transparent,#000_24%,#000_76%,transparent)] group-hover/handle:bg-salmon",
					dragging && "bg-salmon",
				)}
			/>
			<span
				className={cn(
					"pointer-events-none absolute inset-y-2 left-1 z-[1] w-0.5 rounded-full bg-transparent transition-colors [mask-image:linear-gradient(to_bottom,transparent,#000_30%,#000_70%,transparent)] group-hover/handle:bg-salmon",
					dragging && "bg-salmon",
				)}
			/>
		</div>
	);
}

/** Below this remaining width, releasing the drag closes the panel instead. */
export const PANE_COLLAPSE_ZONE = 72;
