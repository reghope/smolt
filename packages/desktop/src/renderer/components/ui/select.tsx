import { Select as SelectPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "../../lib/cn.ts";
import { Icon } from "./icon.tsx";

/**
 * shadcn's select on Radix primitives. The native <select> renders its option
 * popup with Chromium's own colors, which in a dark themed window came out
 * grey-on-grey and read as a wall of disabled entries — this one draws every
 * part with the app's tokens.
 */

const Select = SelectPrimitive.Root;
const SelectValue = SelectPrimitive.Value;

function SelectTrigger({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Trigger>) {
	return (
		<SelectPrimitive.Trigger
			data-slot="select-trigger"
			className={cn(
				"flex h-9 w-full items-center justify-between gap-2 rounded-lg border bg-transparent px-3 text-left text-sm outline-none focus-visible:border-border-strong data-[placeholder]:text-faint",
				className,
			)}
			{...props}
		>
			{children}
			<SelectPrimitive.Icon asChild>
				<span className="flex rotate-90 text-faint">
					<Icon name="chevron" />
				</span>
			</SelectPrimitive.Icon>
		</SelectPrimitive.Trigger>
	);
}

function SelectContent({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Content>) {
	return (
		<SelectPrimitive.Portal>
			<SelectPrimitive.Content
				data-slot="select-content"
				position="popper"
				sideOffset={4}
				className={cn(
					"z-[60] max-h-72 w-[var(--radix-select-trigger-width)] overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg",
					"data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
					className,
				)}
				{...props}
			>
				<SelectPrimitive.Viewport>{children}</SelectPrimitive.Viewport>
			</SelectPrimitive.Content>
		</SelectPrimitive.Portal>
	);
}

function SelectItem({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Item>) {
	return (
		<SelectPrimitive.Item
			data-slot="select-item"
			className={cn(
				"flex h-8 cursor-pointer select-none items-center gap-2 rounded-md px-2.5 text-sm outline-none data-[highlighted]:bg-accent data-[disabled]:opacity-50",
				className,
			)}
			{...props}
		>
			<SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
			<SelectPrimitive.ItemIndicator className="ml-auto flex text-salmon-text">
				<Icon name="check" />
			</SelectPrimitive.ItemIndicator>
		</SelectPrimitive.Item>
	);
}

export { Select, SelectContent, SelectItem, SelectTrigger, SelectValue };
