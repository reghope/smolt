import { beforeAll, beforeEach, describe, expect, test } from "vitest";

/**
 * The sidebar's list-selection rules, exercised through the real store.
 *
 * app.ts reads `window.smolt` and localStorage as it loads, so both are stood
 * up before the dynamic import.
 */
let mod: typeof import("../src/renderer/state/app.ts");

const PATHS = ["/pinned", "/a", "/b", "/c", "/d"];

beforeAll(async () => {
	const store = new Map<string, string>();
	const globals = globalThis as unknown as Record<string, unknown>;
	globals.localStorage = {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => {
			store.set(key, value);
		},
		removeItem: (key: string) => {
			store.delete(key);
		},
	};
	globals.window = {
		smolt: {},
		// Read once at module load to pick the starting theme.
		matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
		addEventListener: () => {},
		removeEventListener: () => {},
	};
	globals.document = {
		addEventListener: () => {},
		removeEventListener: () => {},
		documentElement: {
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			style: { setProperty: () => {} },
		},
		body: { classList: { add: () => {}, remove: () => {}, toggle: () => {} } },
		querySelector: () => null,
		querySelectorAll: () => [],
	};
	mod = await import("../src/renderer/state/app.ts");
});

beforeEach(() => {
	mod.setSessionOrder(PATHS);
	mod.clearSessionSelection();
});

function selected(): string[] {
	return [...mod.app.selectedSessions].sort();
}

describe("sidebar selection", () => {
	test("Ctrl+A takes every chat the sidebar is showing", () => {
		mod.selectAllSessions();
		expect(selected()).toEqual([...PATHS].sort());
	});

	test("Ctrl-click adds one and takes it back out, leaving the rest", () => {
		mod.toggleSessionSelected("/a");
		mod.toggleSessionSelected("/c");
		expect(selected()).toEqual(["/a", "/c"]);
		mod.toggleSessionSelected("/a");
		expect(selected()).toEqual(["/c"]);
	});

	test("Shift-click takes everything between the anchor and the row", () => {
		mod.setSelectionAnchor("/a");
		mod.selectSessionRange("/c");
		expect(selected()).toEqual(["/a", "/b", "/c"]);
	});

	test("a range runs the same both ways", () => {
		mod.setSelectionAnchor("/d");
		mod.selectSessionRange("/a");
		expect(selected()).toEqual(["/a", "/b", "/c", "/d"]);
	});

	test("the range follows the sidebar's order, not the store's", () => {
		// "/pinned" is lifted to the top of the list, so it is inside a range
		// that starts there even though it sorts elsewhere.
		mod.setSelectionAnchor("/pinned");
		mod.selectSessionRange("/b");
		expect(selected()).toEqual(["/a", "/b", "/pinned"]);
	});

	test("shift with nothing to anchor to just takes that row", () => {
		mod.setSelectionAnchor("/gone-from-the-list");
		mod.selectSessionRange("/c");
		expect(selected()).toEqual(["/c"]);
	});

	test("selecting a group replaces the selection and re-anchors it", () => {
		mod.toggleSessionSelected("/d");
		mod.selectSessions(["/a", "/b"]);
		expect(selected()).toEqual(["/a", "/b"]);
		// The anchor moved to the end of the group, so a shift-click extends
		// from there rather than from the chat that was ctrl-clicked before.
		mod.selectSessionRange("/c");
		expect(selected()).toEqual(["/b", "/c"]);
	});
});
