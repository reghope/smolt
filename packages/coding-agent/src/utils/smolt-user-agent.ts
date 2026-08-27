export function getSmoltUserAgent(version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `smolt/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}
