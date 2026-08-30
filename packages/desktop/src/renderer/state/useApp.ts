import { useSyncExternalStore } from "react";
import { app, getDraftVersion, getVersion, subscribe, subscribeDraft } from "./app.ts";

/**
 * Subscribe a component to the app store.
 *
 * The store mutates one shared object and bumps a version; components that
 * call this re-render on every bump and read the fresh fields directly from
 * `app`. Renders are cheap at this app's size, so no selector machinery.
 */
export function useApp(): typeof app {
	useSyncExternalStore(subscribe, getVersion);
	return app;
}

/**
 * Subscribe to the composer's text alone.
 *
 * Typing wakes only what this returns to, which keeps a keystroke from
 * re-rendering the transcript. A general bump wakes it too, so a draft set
 * from elsewhere — history, dictation, a slash command — still lands.
 */
export function useDraft(): string {
	useSyncExternalStore(subscribeDraft, getDraftVersion);
	return app.draft;
}
