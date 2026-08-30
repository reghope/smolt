import type * as React from "react";
import { cn } from "../../lib/cn.ts";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
	return (
		<input
			type={type}
			data-slot="input"
			className={cn(
				"flex h-9 w-full min-w-0 rounded-lg border bg-transparent px-3 py-1 text-sm transition-colors placeholder:text-faint focus-visible:border-border-strong focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50",
				className,
			)}
			{...props}
		/>
	);
}

export { Input };
