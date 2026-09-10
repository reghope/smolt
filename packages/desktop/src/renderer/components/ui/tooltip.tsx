import { Slot, Tooltip as TooltipPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "../../lib/cn.ts";

const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

function TooltipContent({
	className,
	sideOffset = 6,
	children,
	...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
	return (
		<TooltipPrimitive.Portal>
			<TooltipPrimitive.Content
				data-slot="tooltip-content"
				sideOffset={sideOffset}
				className={cn(
					"z-50 max-w-72 rounded-md border bg-card px-2.5 py-1 text-xs text-card-foreground shadow-md animate-in fade-in-0 zoom-in-95",
					className,
				)}
				{...props}
			>
				{children}
			</TooltipPrimitive.Content>
		</TooltipPrimitive.Portal>
	);
}

/**
 * A themed tooltip around one control, in place of the browser's own.
 *
 * Native `title` is unstyleable, waits about a second, and paints in the
 * operating system's colours rather than the app's. This keeps the one-line
 * call shape that made `title` easy to reach for, so there is no reason left
 * to reach for it.
 *
 * The child must forward ref and props: every `Button` and `Icon` here does.
 * Passing `label=""` renders the child alone, for the cases where the text is
 * only sometimes worth showing.
 *
 * Anything else passed in is forwarded to the trigger, so `Tip` can itself be
 * the child of another `asChild` trigger. A menu trigger must be the OUTER of
 * the two: with the tooltip outside, its pointer-down and click handlers wrap
 * the menu's toggle, and a chip hovered long enough to show its tip opened and
 * shut again in the same click.
 */
function Tip({
	label,
	side = "bottom",
	children,
	...props
}: {
	label: string;
	side?: "top" | "right" | "bottom" | "left";
	children: React.ReactNode;
} & React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
	// Still the pass-through when there is nothing to say, but a Slot rather
	// than a fragment: an outer trigger's props and ref arrive here, and a
	// fragment would swallow them and leave the control dead.
	if (label === "") return <Slot.Root {...props}>{children}</Slot.Root>;
	return (
		<Tooltip>
			{/* Radix opens a tooltip on any focus, so closing a menu on the control
			    it hangs off restores focus and leaves the tip stuck open under the
			    pointer. Only keyboard focus should show it; mouse focus is silent. */}
			<TooltipTrigger
				asChild
				{...props}
				onFocus={(event) => {
					props.onFocus?.(event);
					if (!event.currentTarget.matches(":focus-visible")) event.preventDefault();
				}}
			>
				{children}
			</TooltipTrigger>
			<TooltipContent side={side}>{label}</TooltipContent>
		</Tooltip>
	);
}

export { Tip, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
