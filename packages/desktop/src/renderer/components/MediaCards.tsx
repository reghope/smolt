import { useEffect, useState } from "react";
import { api, type LinkPreview } from "../lib/api.ts";
import { cn } from "../lib/cn.ts";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog.tsx";

/** An image in the transcript: a bounded card that opens full size on click. */
export function ImageCard({
	data,
	mimeType,
	className,
}: {
	data: string;
	mimeType: string;
	className?: string;
}) {
	const [open, setOpen] = useState(false);
	const src = `data:${mimeType};base64,${data}`;
	return (
		<>
			<button
				type="button"
				title="View full size"
				className={cn(
					"my-1.5 block w-fit max-w-full cursor-zoom-in overflow-hidden rounded-xl border bg-background-deep transition-colors hover:border-border-strong",
					className,
				)}
				onClick={() => setOpen(true)}
			>
				<img src={src} alt="" className="block max-h-72 max-w-full object-contain" />
			</button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="w-fit max-w-[92vw] p-2" aria-describedby={undefined}>
					<DialogTitle className="sr-only">Image</DialogTitle>
					<img src={src} alt="" className="max-h-[85vh] max-w-full rounded-lg object-contain" />
				</DialogContent>
			</Dialog>
		</>
	);
}

/**
 * URLs that stand alone in the prose — a line that is just a link, bare or
 * markdown-wrapped — get a preview card. Inline references stay plain links.
 */
export function standaloneLinks(text: string): string[] {
	const urls: string[] = [];
	for (const line of text.split("\n")) {
		const bare = /^\s*<?(https?:\/\/[^\s<>]+)>?\s*$/.exec(line);
		const wrapped = /^\s*\[[^\]]*\]\((https?:\/\/[^\s)]+)\)\s*\.?\s*$/.exec(line);
		const url = bare?.[1] ?? wrapped?.[1];
		if (url && !urls.includes(url)) urls.push(url);
	}
	return urls.slice(0, 3);
}

/** null = fetch failed / nothing worth showing; undefined = still loading. */
const previewCache = new Map<string, LinkPreview | null>();
const previewInFlight = new Map<string, Promise<LinkPreview | null>>();

function loadPreview(url: string): Promise<LinkPreview | null> {
	const cached = previewCache.get(url);
	if (cached !== undefined) return Promise.resolve(cached);
	let flight = previewInFlight.get(url);
	if (!flight) {
		flight = api
			.linkPreview(url)
			.then((preview) => {
				previewCache.set(url, preview);
				previewInFlight.delete(url);
				return preview;
			})
			.catch(() => {
				previewCache.set(url, null);
				previewInFlight.delete(url);
				return null;
			});
		previewInFlight.set(url, flight);
	}
	return flight;
}

export function LinkPreviewCard({ url }: { url: string }) {
	const [preview, setPreview] = useState<LinkPreview | null | undefined>(previewCache.get(url));

	useEffect(() => {
		let cancelled = false;
		void loadPreview(url).then((result) => {
			if (!cancelled) setPreview(result);
		});
		return () => {
			cancelled = true;
		};
	}, [url]);

	if (!preview) return null;
	return (
		<a
			href={preview.url}
			target="_blank"
			rel="noreferrer"
			className="my-1.5 flex w-fit max-w-full items-stretch gap-3 overflow-hidden rounded-xl border bg-card no-underline transition-colors hover:border-border-strong"
		>
			<div className="flex min-w-0 max-w-96 flex-col justify-center gap-0.5 px-3.5 py-2.5">
				<span className="overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium text-foreground">
					{preview.title || preview.host}
				</span>
				{preview.description !== "" && (
					<span className="line-clamp-2 text-xs leading-normal text-muted-foreground">{preview.description}</span>
				)}
				<span className="overflow-hidden text-ellipsis whitespace-nowrap text-xs text-faint">{preview.host}</span>
			</div>
			{preview.image && (
				<img src={preview.image} alt="" className="max-h-24 w-32 flex-none self-center object-cover" />
			)}
		</a>
	);
}
