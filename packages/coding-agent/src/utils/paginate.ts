/** Split items into pages of at most `size`, for pickers that scroll. */
export function paginate<T>(items: T[], size: number): T[][] {
	const pages: T[][] = [];
	for (let index = 0; index < items.length; index += size) {
		pages.push(items.slice(index, index + size - 1));
	}
	return pages;
}

/** The page a given item falls on, 1-indexed. */
export function pageOf(itemIndex: number, size: number): number {
	return Math.floor(itemIndex / size) + 1;
}
