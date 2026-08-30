import type * as React from "react";
import { cn } from "../../lib/cn.ts";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
	return (
		<textarea
			data-slot="textarea"
			className={cn(
				"flex w-full rounded-lg border bg-transparent px-3 py-2 text-sm placeholder:text-faint focus-visible:border-border-strong focus-visible:outline-none disabled:opacity-50",
				className,
			)}
			{...props}
		/>
	);
}

export { Textarea };
