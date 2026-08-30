import { Slider as SliderPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "../../lib/cn.ts";

function Slider({ className, ...props }: React.ComponentProps<typeof SliderPrimitive.Root>) {
	return (
		<SliderPrimitive.Root
			data-slot="slider"
			className={cn("relative flex w-full touch-none items-center select-none", className)}
			{...props}
		>
			<SliderPrimitive.Track className="relative h-1 w-full grow overflow-hidden rounded-full bg-input">
				<SliderPrimitive.Range className="absolute h-full bg-gradient-to-r from-input to-primary" />
			</SliderPrimitive.Track>
			<SliderPrimitive.Thumb className="block size-4 shrink-0 rounded-full bg-foreground shadow transition-shadow outline-none" />
		</SliderPrimitive.Root>
	);
}

export { Slider };
