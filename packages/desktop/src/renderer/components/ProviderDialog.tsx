import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { app, bump, refreshState } from "../state/app.ts";
import { useApp } from "../state/useApp.ts";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog.tsx";
import { Input } from "./ui/input.tsx";

/**
 * Adding a model provider, without sending anyone to the terminal.
 *
 * The desktop ships the same agent the CLI runs and shares its credential
 * file, so a key pasted here is the same key `/login` would have written. The
 * sign-in flows it cannot do — the OAuth ones — hand over to the CLI rather
 * than pretending.
 */

const PROVIDERS: { id: string; label: string; hint: string }[] = [
	{ id: "anthropic", label: "Anthropic", hint: "sk-ant-…" },
	{ id: "openai", label: "OpenAI", hint: "sk-…" },
	{ id: "google", label: "Google", hint: "AIza…" },
	{ id: "openrouter", label: "OpenRouter", hint: "sk-or-…" },
	{ id: "groq", label: "Groq", hint: "gsk_…" },
	{ id: "deepseek", label: "DeepSeek", hint: "sk-…" },
	{ id: "mistral", label: "Mistral", hint: "…" },
	{ id: "cerebras", label: "Cerebras", hint: "csk-…" },
];

export function ProviderDialog() {
	const state = useApp();
	const [provider, setProvider] = useState(PROVIDERS[0]!.id);
	const [custom, setCustom] = useState("");
	const [key, setKey] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [configured, setConfigured] = useState<string[]>([]);

	useEffect(() => {
		if (!state.providerDialogOpen) return;
		setError(null);
		setKey("");
		void api
			.authList()
			.then(setConfigured)
			.catch(() => setConfigured([]));
	}, [state.providerDialogOpen]);

	const chosen = provider === "other" ? custom.trim() : provider;
	const hint = PROVIDERS.find((p) => p.id === provider)?.hint ?? "";

	const close = (): void => {
		app.providerDialogOpen = false;
		bump();
	};

	const save = async (): Promise<void> => {
		setBusy(true);
		setError(null);
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
						<select
							className="h-9 rounded-lg border bg-transparent px-3 text-sm outline-none focus-visible:border-border-strong"
							value={provider}
							onChange={(event) => setProvider(event.target.value)}
						>
							{PROVIDERS.map((option) => (
								<option key={option.id} value={option.id}>
									{option.label}
									{configured.includes(option.id) ? " — already set up" : ""}
								</option>
							))}
							<option value="other">Something else…</option>
						</select>
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
					<p className="text-xs leading-relaxed text-faint">
						Stored in your own auth file, readable only by you, and shared with the CLI. It never leaves this
						machine except in requests to the provider.
					</p>
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
						<Button size="sm" disabled={busy || chosen === "" || key.trim() === ""} onClick={() => void save()}>
							{busy ? "Saving…" : "Save"}
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
