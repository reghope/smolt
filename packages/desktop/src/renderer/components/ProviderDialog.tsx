import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { app, bump, call, refreshState } from "../state/app.ts";
import { useApp } from "../state/useApp.ts";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog.tsx";
import { Input } from "./ui/input.tsx";

/**
 * Adding a model provider, without sending anyone to the terminal.
 *
 * The desktop ships the same agent the CLI runs and shares its credential
 * file, so a key pasted here is the same key `/login` would have written. The
 * sign-in flows it cannot do (the OAuth ones) hand over to the CLI rather
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
						<select
							className="h-9 rounded-lg border bg-transparent px-3 text-sm outline-none focus-visible:border-border-strong"
							value={provider}
							onChange={(event) => setProvider(event.target.value)}
						>
							{PROVIDERS.map((option) => (
								<option key={option.id} value={option.id}>
									{option.label}
									{configured.includes(option.id) ? " (already set up)" : ""}
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

					{!poolMode && (
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
							disabled={busy || chosen === "" || (!poolMode && key.trim() === "")}
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
