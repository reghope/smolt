import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, sep } from "node:path";

/**
 * A local preview of the exact files a publish would upload.
 *
 * It serves a directory the way the site host serves a published site: files
 * by path, and the front page for any extension-less path so a single-page
 * app's own routes work on refresh. Previewing the build rather than a dev
 * server means what is seen is what goes live, environment values included.
 */

/** The first port tried; the next free one is taken when it is busy. */
export const PREFERRED_PORT = 7345;

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".ico": "image/x-icon",
	".txt": "text/plain; charset=utf-8",
	".xml": "application/xml; charset=utf-8",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".otf": "font/otf",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mp3": "audio/mpeg",
	".wasm": "application/wasm",
	".map": "application/json; charset=utf-8",
	".webmanifest": "application/manifest+json",
	".pdf": "application/pdf",
};

export function contentTypeFor(path: string): string {
	return TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/**
 * The file a request path names inside `root`, or undefined when it names
 * nothing there. Anything that would climb out of the root is nothing.
 */
export function resolveRequest(root: string, urlPath: string): string | undefined {
	let decoded: string;
	try {
		decoded = decodeURIComponent(urlPath.split("?")[0] ?? "/");
	} catch {
		return undefined;
	}
	if (decoded.includes("\0")) return undefined;
	const wanted = decoded.endsWith("/") ? `${decoded}index.html` : decoded;
	const full = normalize(join(root, wanted));
	const base = normalize(root).replace(/[\\/]+$/, "");
	if (full !== base && !full.startsWith(base + sep)) return undefined;
	if (!existsSync(full)) return undefined;
	const stat = statSync(full);
	if (stat.isDirectory()) {
		const index = join(full, "index.html");
		return existsSync(index) ? index : undefined;
	}
	return stat.isFile() ? full : undefined;
}

/** Whether a miss should get the front page: navigations do, asset requests do not. */
function wantsShell(urlPath: string): boolean {
	const path = urlPath.split("?")[0] ?? "/";
	return extname(path) === "";
}

function handle(root: string, request: IncomingMessage, response: ServerResponse): void {
	const urlPath = request.url ?? "/";
	let file = resolveRequest(root, urlPath);
	if (file === undefined && wantsShell(urlPath)) file = resolveRequest(root, "/index.html");
	if (file === undefined) {
		response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
		response.end("Not found");
		return;
	}
	response.writeHead(200, {
		"content-type": contentTypeFor(file),
		"cache-control": "no-cache",
		"x-content-type-options": "nosniff",
	});
	createReadStream(file).pipe(response);
}

export interface Preview {
	url: string;
	port: number;
	dir: string;
	close(): Promise<void>;
}

function listen(server: Server, port: number): Promise<number> {
	return new Promise((resolve, reject) => {
		const onError = (error: NodeJS.ErrnoException) => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve((server.address() as AddressInfo).port);
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port, "127.0.0.1");
	});
}

/** Serve `dir` on localhost, on the preferred port or the next free one. */
export async function startPreview(dir: string, preferredPort = PREFERRED_PORT): Promise<Preview> {
	const server = createServer((request, response) => handle(dir, request, response));
	let port: number;
	try {
		port = await listen(server, preferredPort);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
		port = await listen(server, 0);
	}
	return {
		url: `http://localhost:${port}`,
		port,
		dir,
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}
