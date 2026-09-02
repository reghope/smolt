import type { ImageContent, TextContent } from "@smolt/ai";

/**
 * The output budget: every tool result is cut to a token budget at the
 * boundary where it enters history, keeping the first half and the last
 * half and dropping the middle behind a marker that says exactly how much
 * went. Tokens are approximated at four bytes each. The default budget is
 * 10,000 tokens.
 */

export const APPROX_BYTES_PER_TOKEN = 4;
export const DEFAULT_OUTPUT_TOKEN_LIMIT = 10_000;

export function approxTokens(text: string): number {
	return Math.ceil(Buffer.byteLength(text, "utf-8") / APPROX_BYTES_PER_TOKEN);
}

/** Step a byte offset off a UTF-8 continuation byte so a cut never splits a character. */
function toCharBoundary(buf: Buffer, index: number, direction: -1 | 1): number {
	let i = index;
	while (i > 0 && i < buf.length && (buf[i] & 0xc0) === 0x80) i += direction;
	return i;
}

export function truncateMiddleByTokens(text: string, maxTokens: number): { text: string; removedTokens: number } {
	const maxBytes = Math.max(0, maxTokens) * APPROX_BYTES_PER_TOKEN;
	const buf = Buffer.from(text, "utf-8");
	if (buf.length <= maxBytes) return { text, removedTokens: 0 };
	const left = Math.floor(maxBytes / 2);
	const right = maxBytes - left;
	const headEnd = toCharBoundary(buf, left, -1);
	const tailStart = toCharBoundary(buf, buf.length - right, 1);
	const removedTokens = Math.ceil((tailStart - headEnd) / APPROX_BYTES_PER_TOKEN);
	const head = buf.subarray(0, headEnd).toString("utf-8");
	const tail = buf.subarray(tailStart).toString("utf-8");
	return { text: `${head}\n…${removedTokens} tokens truncated…\n${tail}`, removedTokens };
}

/**
 * Apply the budget to a tool result's text blocks. Images are not text and
 * pass through; the budget is per block, which in practice is per result.
 * Returns undefined when nothing was over budget so the caller can leave the
 * result untouched.
 */
export function applyOutputBudget(
	content: (TextContent | ImageContent)[],
	maxTokens: number,
): (TextContent | ImageContent)[] | undefined {
	let changed = false;
	const budgeted = content.map((block) => {
		if (block.type !== "text") return block;
		const cut = truncateMiddleByTokens(block.text, maxTokens);
		if (cut.removedTokens === 0) return block;
		changed = true;
		return { ...block, text: cut.text };
	});
	return changed ? budgeted : undefined;
}
