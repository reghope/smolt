import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** The shadcn class combiner: conditional classes, Tailwind conflicts resolved. */
export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}
