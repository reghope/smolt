/**
 * Inline SVG icon set.
 *
 * Buttons in index.html carry `data-icon="name"`; `hydrateIcons` fills them on
 * boot, so markup and dynamically rendered rows share one source of truth.
 * Icons inherit `currentColor` and size from `--icon-size`, which keeps hover
 * and disabled states in CSS where the rest of the theming lives.
 */

const STROKE = `fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"`;

const PATHS: Record<string, string> = {
	// composer
	attach: `<path ${STROKE} d="M12.5 6.5 7.2 11.8a1.9 1.9 0 0 0 2.7 2.7l5.4-5.4a3.5 3.5 0 0 0-5-5L4.9 9.6a5.1 5.1 0 0 0 7.2 7.2l5-5"/>`,
	mic: `<rect ${STROKE} x="8" y="2.5" width="5" height="9.5" rx="2.5"/><path ${STROKE} d="M4.75 9.5a5.25 5.25 0 0 0 10.5 0M10 15v3"/>`,
	send: `<path ${STROKE} d="M10 15.5v-11M5 9.5l5-5 5 5"/>`,
	stop: `<rect ${STROKE} x="5.5" y="5.5" width="9" height="9" rx="1.75"/>`,
	// chrome
	plus: `<path ${STROKE} d="M3.5 10h13M10 3.5v13"/>`,
	folderAdd: `<path ${STROKE} d="M3 6.5A1.5 1.5 0 0 1 4.5 5h3l1.5 2h6.5A1.5 1.5 0 0 1 17 8.5v6A1.5 1.5 0 0 1 15.5 16h-11A1.5 1.5 0 0 1 3 14.5z"/><path ${STROKE} d="M10 9.5v4M8 11.5h4"/>`,
	folder: `<path ${STROKE} d="M3 6.5A1.5 1.5 0 0 1 4.5 5h3l1.5 2h6.5A1.5 1.5 0 0 1 17 8.5v6A1.5 1.5 0 0 1 15.5 16h-11A1.5 1.5 0 0 1 3 14.5z"/>`,
	command: `<path ${STROKE} d="M12.5 4 7.5 16"/><path ${STROKE} d="m5 7-3 3 3 3M15 7l3 3-3 3"/>`,
	newChat: `<path ${STROKE} d="M3.5 10h13M10 3.5v13"/>`,
	settings: `<path ${STROKE} d="M4 6h12M4 10h12M4 14h12"/><circle ${STROKE} cx="7.5" cy="6" r="1.75"/><circle ${STROKE} cx="12.5" cy="10" r="1.75"/><circle ${STROKE} cx="7.5" cy="14" r="1.75"/>`,
	close: `<path ${STROKE} d="m5.5 5.5 9 9M14.5 5.5l-9 9"/>`,
	copy: `<rect ${STROKE} x="7" y="7" width="8.5" height="8.5" rx="2"/><path ${STROKE} d="M12.5 4.5h-8a1 1 0 0 0-1 1v8"/>`,
	check: `<path ${STROKE} d="m4.5 10.5 3.5 3.5 7.5-7.5"/>`,
	scrollDown: `<path ${STROKE} d="M10 4.5v11M5 10.5l5 5 5-5"/>`,
	chevron: `<path ${STROKE} d="m7.5 5 5 5-5 5"/>`,
	trash: `<path ${STROKE} d="M4.5 6h11M8 6V4.5h4V6M6 6l.6 9.5h6.8L14 6"/>`,
	diff: `<path ${STROKE} d="M6 3.5v6M3 6.5h6M3 15.5h6M11 6.5h6M14 12.5v6M11 15.5h6"/>`,
	branch: `<circle ${STROKE} cx="6" cy="5" r="2"/><circle ${STROKE} cx="6" cy="15" r="2"/><circle ${STROKE} cx="14" cy="8" r="2"/><path ${STROKE} d="M6 7v6M8 8h2a2 2 0 0 1 2 2v0a2 2 0 0 1-2 2H8"/>`,
	terminal: `<rect ${STROKE} x="3" y="4" width="14" height="12" rx="2.5"/><path ${STROKE} d="m6.5 8.5 2 2-2 2M11 13h3"/>`,
	side: `<rect ${STROKE} x="3" y="4" width="14" height="12" rx="2.5"/><path ${STROKE} d="M12.5 4v12"/>`,
	sidebar: `<rect ${STROKE} x="3" y="4" width="14" height="12" rx="2.5"/><path ${STROKE} d="M8 4v12"/>`,
	menu: `<path ${STROKE} d="M3.5 6h13M3.5 10h13M3.5 14h13"/>`,
	search: `<circle ${STROKE} cx="9" cy="9" r="5"/><path ${STROKE} d="m12.8 12.8 3.7 3.7"/>`,
	refresh: `<path ${STROKE} d="M15.5 8.5a5.75 5.75 0 1 0 .3 3.2M15.5 4v4.5H11"/>`,
	edit: `<path ${STROKE} d="M13.5 4.5 15.5 6.5 8 14l-2.8.8.8-2.8Z"/><path ${STROKE} d="M4 16.5h12"/>`,
	spinner: `<circle ${STROKE} cx="10" cy="10" r="6.5" stroke-opacity="0.25"/><path ${STROKE} d="M10 3.5a6.5 6.5 0 0 1 6.5 6.5"/>`,
};

export function icon(name: string): string {
	const body = PATHS[name];
	if (!body) return "";
	return `<svg class="icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">${body}</svg>`;
}

/**
 * Put every `[data-icon]` element's SVG in front of its other children.
 *
 * The icon is prepended rather than written over the element's contents:
 * some hosts keep working children beside the glyph (the titlebar's Changes
 * button carries its `#diff-count` badge), and replacing innerHTML would
 * silently destroy them. Re-running is safe; a previous glyph is swapped out.
 */
export function hydrateIcons(root: ParentNode = document): void {
	for (const element of root.querySelectorAll<HTMLElement>("[data-icon]")) {
		const name = element.dataset.icon;
		if (!name) continue;
		element.querySelector(":scope > svg.icon")?.remove();
		element.insertAdjacentHTML("afterbegin", icon(name));
	}
}
