import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { app, bump, call, refreshModels, refreshState, toast } from "../state/app.ts";
import { useApp } from "../state/useApp.ts";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog.tsx";
import { Input } from "./ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx";

/**
 * Adding an instance of a model provider, without sending anyone to the
 * terminal.
 *
 * A provider can have as many instances as there are keys for it. The first
 * credential becomes the provider's primary, the same one `/login` would
 * have written; every key after that joins its pool, and the agent fails
 * over to the next when one hits a usage limit. The dialog tells them apart
 * on its own: pick a provider that is already set up and the key you paste
 * is a new instance.
 *
 * Providers with a subscription sign in through the browser. That flow runs
 * inside the agent, exactly as `/login` does in the TUI: the browser opens
 * from here, and any question the flow has (a code to paste, a choice to
 * make) arrives as an ordinary dialog in the chat.
 */

/** Key-shape placeholders for the providers whose format is well known. */
const KEY_HINTS: Record<string, string> = {
	anthropic: "sk-ant-…",
	openai: "sk-…",
	google: "AIza…",
	openrouter: "sk-or-…",
	groq: "gsk_…",
	deepseek: "sk-…",
	cerebras: "csk-…",
	xai: "xai-…",
};

/** The common picks, surfaced ahead of the full alphabetical catalog. */
const FAVOURITE_ORDER = ["anthropic", "openai", "google", "openrouter", "groq", "deepseek", "mistral", "cerebras"];

interface KnownProvider {
	id: string;
	name: string;
	apiKey: boolean;
	oauth: boolean;
}

type Method = "api_key" | "oauth";

/** Favourites in their fixed order, then everything else alphabetically. */
function orderProviders(known: KnownProvider[]): KnownProvider[] {
	const byId = new Map(known.map((entry) => [entry.id, entry]));
	const favourites = FAVOURITE_ORDER.map((id) => byId.get(id)).filter(
		(entry): entry is KnownProvider => entry !== undefined,
	);
	const rest = known
		.filter((entry) => !FAVOURITE_ORDER.includes(entry.id))
		.sort((a, b) => a.name.localeCompare(b.name));
	return [...favourites, ...rest];
}

/** Stand-in when the catalog cannot be read, so the dialog still works. */
const FALLBACK_PROVIDERS: KnownProvider[] = FAVOURITE_ORDER.map((id) => ({
	id,
	name: id.charAt(0).toUpperCase() + id.slice(1),
	apiKey: true,
	oauth: false,
}));

export function ProviderDialog() {
	const state = useApp();
	const [provider, setProvider] = useState(FAVOURITE_ORDER[0]!);
	const [custom, setCustom] = useState("");
	const [method, setMethod] = useState<Method>("api_key");
	const [key, setKey] = useState("");
	const [label, setLabel] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [configured, setConfigured] = useState<string[]>([]);
	const [known, setKnown] = useState<KnownProvider[]>(FALLBACK_PROVIDERS);

	useEffect(() => {
		if (!state.providerDialogOpen) return;
		setError(null);
		setKey("");
		setLabel("");
		// Opened from a provider's own row: start there.
		if (app.providerDialogPreset !== null) {
			setProvider(app.providerDialogPreset);
			app.providerDialogPreset = null;
		}
		void api
			.authList()
			.then(setConfigured)
			.catch(() => setConfigured([]));
		// The full catalog from the agent's own provider list, not a curated few.
		void api
			.knownProviders?.()
			.then((list) => {
				if (Array.isArray(list) && list.length > 0) setKnown(orderProviders(list));
			})
			.catch(() => undefined);
	}, [state.providerDialogOpen]);

	const chosen = provider === "other" ? custom.trim() : provider;
	const selected = known.find((entry) => entry.id === provider);
	const chosenName = selected?.name ?? chosen;
	const hint = KEY_HINTS[provider] ?? "";
	const offersKey = selected === undefined || selected.apiKey;
	const offersOAuth = selected?.oauth === true;
	// The method the provider actually supports wins over a stale pick.
	const effectiveMethod: Method = offersOAuth && !offersKey ? "oauth" : !offersOAuth ? "api_key" : method;
	// A provider that already has its primary credential gets an instance;
	// one that does not gets the primary. Subscriptions are one per provider.
	const addingInstance = chosen !== "" && configured.includes(chosen);

	const close = (): void => {
		app.providerDialogOpen = false;
		bump();
	};

	const finish = (): void => {
		close();
		// The agent restarts (or resyncs) with the new credential; its models
		// arrive a moment later.
		window.setTimeout(() => {
			void refreshState();
			void refreshModels();
		}, 2500);
	};

	const saveKey = async (): Promise<void> => {
		setBusy(true);
		setError(null);
		const name = label.trim();
		const result = addingInstance ? await api.poolAddKey(chosen, key, name) : await api.authSet(chosen, key);
		if (result.ok && !addingInstance && name !== "") {
			// The primary's name lives in the pool file beside the others.
			await api.poolRelabel(chosen, "__primary__", name);
		}
		setBusy(false);
		if (!result.ok) {
			setError(result.error ?? "Could not save that key.");
			return;
		}
		finish();
	};

	const signIn = async (): Promise<void> => {
		setBusy(true);
		setError(null);
		const name = label.trim();
		toast(`Finish signing in to ${chosenName} in your browser.`);
		// Runs inside the agent, so the flow's own questions (a code to paste,
		// say) surface as dialogs in the chat while this waits.
		const result = await call<{ type: string }>("login", chosen, "oauth");
		if (result === null) {
			setBusy(false);
			setError(`Signing in to ${chosenName} did not complete.`);
			return;
		}
		if (name !== "") await api.poolRelabel(chosen, "__primary__", name);
		setBusy(false);
		toast(`Signed in to ${chosenName}.`);
		finish();
	};

	const canSubmit =
		!busy && chosen !== "" && (effectiveMethod === "oauth" ? !addingInstance : key.trim() !== "");
	const submitLabel = busy
		? effectiveMethod === "oauth"
			? "Waiting for the browser…"
			: "Saving…"
		: effectiveMethod === "oauth"
			? "Sign in"
			: addingInstance
				? "Add instance"
				: "Add provider";

	return (
		<Dialog open={state.providerDialogOpen} onOpenChange={(open) => !open && !busy && close()}>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>Add a provider instance</DialogTitle>
					<DialogDescription>
						A provider can have as many instances as you have keys for it. The first credential sets the
						provider up; each key after that is another instance, and when one hits its usage limit the next
						takes over.
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-3">
					<label className="flex flex-col gap-1.5 text-sm">
						Provider
						<Select value={provider} onValueChange={setProvider} disabled={busy}>
							<SelectTrigger>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{known.map((option) => (
									<SelectItem key={option.id} value={option.id}>
										{option.name}
										{configured.includes(option.id) ? " · set up" : ""}
									</SelectItem>
								))}
								<SelectItem value="other">Something else…</SelectItem>
							</SelectContent>
						</Select>
					</label>

					{provider === "other" && (
						<label className="flex flex-col gap-1.5 text-sm">
							Provider name
							<Input
								value={custom}
								placeholder="the id used in auth.json, e.g. together"
								onChange={(event) => setCustom(event.target.value)}
							/>
						</label>
					)}

					{offersOAuth && offersKey && (
						<label className="flex flex-col gap-1.5 text-sm">
							Sign in with
							<Select value={effectiveMethod} onValueChange={(value) => setMethod(value as Method)} disabled={busy}>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="api_key">API key</SelectItem>
									<SelectItem value="oauth">Subscription (sign in through the browser)</SelectItem>
								</SelectContent>
							</Select>
						</label>
					)}

					{effectiveMethod === "api_key" && (
						<label className="flex flex-col gap-1.5 text-sm">
							API key
							<Input
								type="password"
								value={key}
								placeholder={hint || "your key"}
								autoComplete="off"
								spellCheck={false}
								onChange={(event) => setKey(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter" && canSubmit) void saveKey();
								}}
							/>
						</label>
					)}
					<label className="flex flex-col gap-1.5 text-sm">
						Name (optional)
						<Input
							value={label}
							placeholder={addingInstance ? "e.g. work account" : "e.g. key one"}
							onChange={(event) => setLabel(event.target.value)}
						/>
					</label>
					<p className="text-xs leading-relaxed text-faint">
						{effectiveMethod === "oauth"
							? addingInstance
								? `${chosenName} is already set up. A subscription sign-in replaces its primary credential; to add another account, sign in from the CLI with /pool add.`
								: `Your browser opens on ${chosenName}'s sign-in page. The token is stored in your own auth file, readable only by you, and shared with the CLI.`
							: addingInstance
								? `${chosenName} is already set up, so this key becomes another instance of it. Stored in your pool file, readable only by you.`
								: "Stored in your own auth file, readable only by you, and shared with the CLI. It never leaves this machine except in requests to the provider."}
					</p>
					{error !== null && <p className="text-xs text-destructive">{error}</p>}
				</div>

				<div className="mt-1 flex items-center justify-end gap-2">
					<Button variant="secondary" size="sm" onClick={close} disabled={busy}>
						Cancel
					</Button>
					<Button size="sm" disabled={!canSubmit} onClick={() => void (effectiveMethod === "oauth" ? signIn() : saveKey())}>
						{submitLabel}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
