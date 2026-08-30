import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../../lib/cn.ts";

const badgeVariants = cva(
	"inline-flex items-center rounded-md border px-1.5 py-0 text-xs font-normal whitespace-nowrap w-fit shrink-0",
	{
		variants: {
			variant: {
				default: "border-transparent bg-primary text-primary-foreground",
				secondary: "border-transparent bg-secondary text-secondary-foreground",
				outline: "text-faint",
				destructive: "border-transparent bg-destructive text-destructive-foreground",
			},
		},
		defaultVariants: { variant: "outline" },
	},
);

function Badge({ className, variant, ...props }: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
	return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
