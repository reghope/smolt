/** Cosmetic preferences survive in localStorage; losing one is never fatal. */

export function storedPreference(key: string, fallback: string): string {
	try {
		return localStorage.getItem(key) ?? fallback;
	} catch {
		// Private windows and blocked site data both throw here.
		return fallback;
	}
}

export function storePreference(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		// Losing a cosmetic preference is not worth breaking the render over.
	}
}

export function forgetPreference(key: string): void {
	try {
		localStorage.removeItem(key);
	} catch {
		// Same throwing cases as the two above; nothing to recover.
	}
}
