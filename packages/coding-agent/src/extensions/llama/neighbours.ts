export interface GpuNeighbour {
	model: string;
	runtime: string;
}

export interface FreeGpuNeighboursOptions {
	ollamaUrl: string;
	report?: (neighbour: GpuNeighbour) => void;
}

/**
 * Normalize OLLAMA_HOST into a base URL. Accepts full URLs, host:port and
 * bare host forms; falls back to Ollama's default address.
 */
export function normalizeOllamaUrl(value: string | undefined): string {
	const raw = value?.trim();
	if (raw === undefined || raw === "") return "http://127.0.0.1:11434";
	const withScheme = /^https?:\/\//.test(raw) ? raw : `http://${raw}`;
	return withScheme.replace(/\/+$/, "");
}

/**
 * Stop models another runtime (Ollama) holds on the same GPU. llama.cpp
 * loads beside resident models rather than refusing, putting most of the
 * layers on the CPU, so anything resident has to go before the load.
 * Failures are ignored: a neighbour that will not stop is not a reason to
 * skip the load.
 */
export async function freeGpuNeighbours(options: FreeGpuNeighboursOptions): Promise<GpuNeighbour[]> {
	const base = normalizeOllamaUrl(options.ollamaUrl);
	const stopped: GpuNeighbour[] = [];
	let loaded: Array<{ Name?: string; name?: string }>;
	try {
		const response = await fetch(`${base}/api/ps`, { signal: AbortSignal.timeout(5_000) });
		if (!response.ok) return stopped;
		const body = (await response.json()) as { models?: Array<{ Name?: string; name?: string }> };
		loaded = body.models ?? [];
	} catch {
		return stopped;
	}
	for (const entry of loaded) {
		const name = entry.Name ?? entry.name;
		if (name === undefined || name === "") continue;
		const neighbour: GpuNeighbour = { model: name, runtime: "ollama" };
		try {
			await fetch(`${base}/api/generate`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: name, keep_alive: 0 }),
				signal: AbortSignal.timeout(30_000),
			});
		} catch {
			continue;
		}
		options.report?.(neighbour);
		stopped.push(neighbour);
	}
	return stopped;
}
