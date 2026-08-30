import { useSyncExternalStore } from "react";
import { app, getVersion, subscribe } from "./app.ts";

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
