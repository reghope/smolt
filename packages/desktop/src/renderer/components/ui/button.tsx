import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../../lib/cn.ts";

const buttonVariants = cva(
	"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 outline-none",
	{
		variants: {
			variant: {
				default: "bg-primary text-primary-foreground hover:bg-primary/90",
				destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
				outline: "border bg-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground",
				secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
				ghost: "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
				link: "text-primary underline-offset-4 hover:underline",
			},
			size: {
				default: "h-9 px-4 py-2",
				sm: "h-8 rounded-lg px-3",
				xs: "h-7 rounded-md px-2 text-xs",
				lg: "h-10 rounded-lg px-8",
				icon: "size-8",
			},
		},
		// Quiet chrome buttons only: a filled icon button keeps its variant's
		// own foreground, so a salmon send arrow stays dark ink, not faint.
		compoundVariants: [
			{ variant: "ghost", size: "icon", class: "text-faint hover:text-foreground" },
			{ variant: "outline", size: "icon", class: "text-faint hover:text-foreground" },
		],
		defaultVariants: { variant: "default", size: "default" },
	},
);

function Button({
	className,
	variant,
	size,
	...props
}: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants>) {
	return <button data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
