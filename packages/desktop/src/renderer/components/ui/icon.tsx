import { icon } from "../../icons.ts";
import { cn } from "../../lib/cn.ts";

/**
 * The app's own line-icon set (site-matched), in place of shadcn's lucide.
 * Sized like shadcn draws icons inside controls: 16px, currentColor.
 */
export function Icon({ name, className }: { name: string; className?: string }) {
	return (
		<span
			className={cn("[&>svg]:size-4 inline-flex shrink-0 [&>svg]:shrink-0", className)}
			aria-hidden="true"
			// The markup is our own static SVG table, never remote content.
			dangerouslySetInnerHTML={{ __html: icon(name) }}
		/>
	);
}
