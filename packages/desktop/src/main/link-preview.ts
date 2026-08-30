/**
 * Link previews for the transcript.
 *
 * Fetched here rather than in the renderer, whose CSP allows no external
 * requests. The page is read capped and with a timeout, only its metadata is
 * parsed, and the one image the card shows travels back as a data URL so the
 * renderer never talks to the network itself.
 */

export interface LinkPreview {
	url: string;
	host: string;
	title: string;
	description: string;
	/** og:image, inlined as a data URL, when the page offers one. */
	image?: string;
}

const PAGE_BYTE_CAP = 262_144;
const IMAGE_BYTE_CAP = 800_000;
const FETCH_TIMEOUT_MS = 8000;

async function fetchCapped(url: string, cap: number): Promise<{ buffer: Buffer; contentType: string } | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const response = await fetch(url, {
			signal: controller.signal,
			redirect: "follow",
			headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) smolt-desktop" },
		});
		if (!response.ok || !response.body) return null;
		const contentType = response.headers.get("content-type") ?? "";
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let total = 0;
		while (total < cap) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			total += value.length;
		}
		void reader.cancel().catch(() => {});
		return { buffer: Buffer.concat(chunks), contentType };
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

function metaContent(html: string, names: string[]): string {
	for (const name of names) {
		// Both attribute orders occur in the wild.
		const patterns = [
			new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']*)["']`, "i"),
			new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${name}["']`, "i"),
		];
		for (const pattern of patterns) {
			const match = pattern.exec(html);
			if (match?.[1]) return decodeEntities(match[1]);
		}
	}
	return "";
}

function decodeEntities(text: string): string {
	return text
		.replaceAll("&amp;", "&")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&#39;", "'")
		.replaceAll("&#x27;", "'");
}

export async function fetchLinkPreview(rawUrl: string): Promise<LinkPreview | null> {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return null;

	const page = await fetchCapped(url.href, PAGE_BYTE_CAP);
	if (!page || !/text\/html/i.test(page.contentType)) return null;
	const html = page.buffer.toString("utf8");

	const title =
		metaContent(html, ["og:title", "twitter:title"]) ||
		decodeEntities(/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? "");
	const description = metaContent(html, ["og:description", "twitter:description", "description"]);
	if (title === "" && description === "") return null;

	let image: string | undefined;
	const imageUrl = metaContent(html, ["og:image", "twitter:image"]);
	if (imageUrl !== "") {
		try {
			const resolved = new URL(imageUrl, url).href;
			const fetched = await fetchCapped(resolved, IMAGE_BYTE_CAP);
			if (fetched && /^image\//i.test(fetched.contentType) && fetched.buffer.length > 0) {
				image = `data:${fetched.contentType.split(";")[0]};base64,${fetched.buffer.toString("base64")}`;
			}
		} catch {
			// A card without a picture is still a card.
		}
	}

	return { url: url.href, host: url.host, title: title.slice(0, 200), description: description.slice(0, 300), image };
}
