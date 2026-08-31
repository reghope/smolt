import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { app, bump, call, refreshState } from "../state/app.ts";
import { useApp } from "../state/useApp.ts";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog.tsx";
import { Input } from "./ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx";

/**
 * Adding a model provider, without sending anyone to the terminal.
 *
 * The desktop ships the same agent the CLI runs and shares its credential
 * file, so a key pasted here is the same key `/login` would have written. The
 * sign-in flows it cannot do (the OAuth ones) hand over to the CLI rather
 * than pretending.
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
	const [key, setKey] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [configured, setConfigured] = useState<string[]>([]);
	const [known, setKnown] = useState<KnownProvider[]>(FALLBACK_PROVIDERS);
	const [poolMode, setPoolMode] = useState(false);
	const [poolLabel, setPoolLabel] = useState("");

	useEffect(() => {
		if (!state.providerDialogOpen) return;
		setError(null);
		setKey("");
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
	const hint = KEY_HINTS[provider] ?? "";
	// A provider without API-key auth signs in through a browser; pasting a
	// key at it would store something nothing ever reads.
	const oauthOnly = selected !== undefined && !selected.apiKey && selected.oauth;

	const close = (): void => {
		app.providerDialogOpen = false;
		bump();
	};

	const save = async (): Promise<void> => {
		setBusy(true);
		setError(null);
		if (poolMode) {
			// Failover pool: the desktop is a proxy of the TUI, so the credential is
			// saved by the pool extension's /pool command. The command carries NO
			// key — the extension asks for it in its own dialog, so the secret
			// never enters the transcript or the session title.
			const label = poolLabel.trim();
			const command = `/pool add-key ${chosen}${label !== "" ? ` ${label}` : ""}`;
			const sent = await call("prompt", command, undefined, "steer");
			setBusy(false);
			if (sent === null) {
				setError("Could not reach the agent. Open a chat first, then try again.");
				return;
			}
			close();
			return;
		}
		const result = await api.authSet(chosen, key);
		setBusy(false);
		if (!result.ok) {
			setError(result.error ?? "Could not save that key.");
			return;
		}
		close();
		// The agent restarts with the new credential; its models arrive with it.
		window.setTimeout(() => void refreshState(), 2500);
	};

	return (
		<Dialog open={state.providerDialogOpen} onOpenChange={(open) => !open && close()}>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>Add a model provider</DialogTitle>
					<DialogDescription>
						smolt has no models until a provider is set up. Paste an API key here, or sign in through the CLI for
						providers that use a browser login.
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-3">
					<label className="flex flex-col gap-1.5 text-sm">
						Provider
						<Select value={provider} onValueChange={setProvider}>
							<SelectTrigger>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{known.map((option) => (
									<SelectItem key={option.id} value={option.id}>
										{option.name}
										{configured.includes(option.id) ? " (already set up)" : ""}
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

					{oauthOnly && (
						<p className="text-xs leading-relaxed text-warn">
							{selected?.name} signs in through the browser rather than an API key — use “Sign in through the
							CLI” below.
						</p>
					)}
					{!poolMode && !oauthOnly && (
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
									if (event.key === "Enter" && chosen !== "" && key.trim() !== "") void save();
								}}
							/>
						</label>
					)}
					<p className="text-xs leading-relaxed text-faint">
						{poolMode
							? "A secure prompt opens in the chat to take the key — it is stored in your pool file and never appears in the conversation."
							: "Stored in your own auth file, readable only by you, and shared with the CLI. It never leaves this machine except in requests to the provider."}
					</p>

					<label className="flex items-start gap-2 text-sm">
						<input
							type="checkbox"
							className="mt-0.5"
							checked={poolMode}
							onChange={(event) => setPoolMode(event.target.checked)}
						/>
					<span>
							Additional credential for failover
							<span className="block text-xs text-faint">
								Add to this provider's credential pool instead of replacing its key: when one hits a usage
								limit, the next one is tried. Managed with /pool. The key is collected by a secure prompt
								in the chat, never sent as part of a message.
							</span>
						</span>
					</label>
					{poolMode && (
						<label className="flex flex-col gap-1.5 text-sm">
							Label (optional)
							<Input
								value={poolLabel}
								placeholder="e.g. work account"
								onChange={(event) => setPoolLabel(event.target.value)}
							/>
						</label>
					)}
					{error !== null && <p className="text-xs text-destructive">{error}</p>}
				</div>

				<div className="mt-1 flex items-center justify-between gap-2">
					<Button
						variant="ghost"
						size="sm"
						onClick={() => {
							void api.openCli();
							close();
						}}
					>
						Sign in through the CLI
					</Button>
					<div className="flex gap-2">
						<Button variant="secondary" size="sm" onClick={close}>
							Cancel
						</Button>
						<Button
							size="sm"
							disabled={busy || chosen === "" || oauthOnly || (!poolMode && key.trim() === "")}
							onClick={() => void save()}
						>
							{busy ? "Saving…" : poolMode ? "Continue in chat" : "Save"}
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
