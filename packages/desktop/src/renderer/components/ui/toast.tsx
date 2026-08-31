import { cva, type VariantProps } from "class-variance-authority";
import { Toast as ToastPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "../../lib/cn.ts";
import { Icon } from "./icon.tsx";

/**
 * shadcn's toast, on Radix Toast primitives: hover pauses the timer, a swipe
 * to the right dismisses, and screen readers are told politely. Styled with
 * this app's tokens rather than shadcn's stock palette.
 */

const ToastProvider = ToastPrimitive.Provider;

function ToastViewport({ className, ...props }: React.ComponentProps<typeof ToastPrimitive.Viewport>) {
	return (
		<ToastPrimitive.Viewport
			data-slot="toast-viewport"
			className={cn("fixed right-0 bottom-0 z-[100] flex max-h-screen w-full flex-col gap-2 p-4 sm:max-w-sm", className)}
			{...props}
		/>
	);
}

const toastVariants = cva(
	"group pointer-events-auto relative flex w-full items-start gap-2 overflow-hidden rounded-lg border bg-card px-4 py-3 text-sm shadow-lg transition-all " +
		"data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[swipe=move]:transition-none data-[swipe=cancel]:translate-x-0 " +
		"data-[swipe=end]:translate-x-[var(--radix-toast-swipe-end-x)] data-[swipe=end]:animate-out data-[swipe=end]:fade-out-80 " +
		"data-[state=open]:animate-in data-[state=open]:fade-in data-[state=open]:slide-in-from-bottom-2 " +
		"data-[state=closed]:animate-out data-[state=closed]:fade-out-80",
	{
		variants: {
			variant: {
				default: "text-foreground",
				destructive: "border-destructive/50 text-destructive",
			},
		},
		defaultVariants: { variant: "default" },
	},
);

function Toast({
	className,
	variant,
	...props
}: React.ComponentProps<typeof ToastPrimitive.Root> & VariantProps<typeof toastVariants>) {
	return <ToastPrimitive.Root data-slot="toast" className={cn(toastVariants({ variant }), className)} {...props} />;
}

function ToastDescription({ className, ...props }: React.ComponentProps<typeof ToastPrimitive.Description>) {
	return (
		<ToastPrimitive.Description
			data-slot="toast-description"
			className={cn("min-w-0 flex-1 leading-snug break-words", className)}
			{...props}
		/>
	);
}

function ToastClose({ className, ...props }: React.ComponentProps<typeof ToastPrimitive.Close>) {
	return (
		<ToastPrimitive.Close
			data-slot="toast-close"
			aria-label="Dismiss"
			className={cn(
				"mt-0.5 flex-none rounded-md text-faint opacity-70 transition-opacity hover:opacity-100 focus-visible:opacity-100",
				className,
			)}
			{...props}
		>
			<Icon name="close" />
		</ToastPrimitive.Close>
	);
}

export { Toast, ToastClose, ToastDescription, ToastProvider, ToastViewport };
