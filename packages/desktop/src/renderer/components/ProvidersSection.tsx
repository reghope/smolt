import { useEffect, useRef, useState } from "react";
import { api, type ConfiguredProvider, type PoolCredentialInfo } from "../lib/api.ts";
import { app, bump, refreshModels, requestConfirm, toast } from "../state/app.ts";
import { useApp } from "../state/useApp.ts";
import { Button } from "./ui/button.tsx";
import { Tip } from "./ui/tooltip.tsx";
import { Icon } from "./ui/icon.tsx";
import { Switch } from "./ui/switch.tsx";

/**
 * The providers page in settings: every provider that is set up, the
 * instances of it (one per key, each named the way the reader wants), and
 * the way to add or remove one. A provider can have as many instances as
 * needed; the first is its primary credential and the rest fail over in
 * turn when one hits a usage limit.
 *
 * Reads the same two files the CLI shares, so what /login and /pool did in
 * a terminal shows up here and what happens here shows up there. The list
 * reloads whenever the dialog opens and after every change, since the
 * agent restarts behind removals and its models arrive a moment later.
 */

/** The pool's own name for a provider's primary credential. */
const PRIMARY_ID = "__primary__";

/** One instance of a provider: the primary key or a pooled one, with its given name. */
interface CredentialRow {
	id: string;
	label: string;
	kind: string;
	primary: boolean;
}

/** A credential's kind, said plainly. */
function credentialKind(type: string | undefined): string {
	if (type === "oauth") return "signed in";
	return "API key";
}

function rowsOf(provider: ConfiguredProvider): CredentialRow[] {
	const rows: CredentialRow[] = [];
	if (provider.type !== undefined) {
		rows.push({
			id: PRIMARY_ID,
			label: provider.primaryLabel ?? "",
			kind: credentialKind(provider.type),
			primary: true,
		});
	}
	for (const entry of provider.pool) {
		rows.push({
			id: entry.id,
			label: entry.label ?? "",
			kind: `${credentialKind(entry.type)}${entry.plan ? ` · ${entry.plan}` : ""}`,
			primary: false,
		});
	}
	return rows;
}

/**
 * "OpenCode Go · key one": the provider, a middle dot, and the name given to
 * this particular key. Click the name to change it; Enter or leaving the
 * field saves, Escape puts it back. An unnamed key shows where its name
 * would go rather than nothing, so the affordance is visible.
 */
function NameField({
	provider,
	value,
	onSave,
}: {
	provider: string;
	value: string;
	onSave: (label: string) => Promise<void>;
}) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(value);
	const inputRef = useRef<HTMLInputElement | null>(null);

	useEffect(() => {
		if (!editing) setDraft(value);
	}, [value, editing]);
	useEffect(() => {
		if (editing) inputRef.current?.select();
	}, [editing]);

	const commit = async (): Promise<void> => {
		setEditing(false);
		if (draft.trim() === value.trim()) return;
		await onSave(draft.trim());
	};

	return (
		<span className="flex min-w-0 items-baseline gap-1.5 text-sm">
			<span className="flex-none">{provider}</span>
			<span className="flex-none text-faint">·</span>
			{editing ? (
				<input
					ref={inputRef}
					className="min-w-0 flex-1 rounded-md border border-border bg-background px-1.5 py-0.5 text-sm outline-none focus:border-ring"
					value={draft}
					placeholder="name this instance"
					spellCheck={false}
					onChange={(event) => setDraft(event.target.value)}
					onBlur={() => void commit()}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							void commit();
						} else if (event.key === "Escape") {
							event.preventDefault();
							setDraft(value);
							setEditing(false);
						}
					}}
				/>
			) : (
				<Tip label="Rename this instance">
				<button
					type="button"
					className="group flex min-w-0 items-baseline gap-1.5 rounded-md text-left transition-colors hover:text-foreground"
					onClick={() => setEditing(true)}
				>
					<span
						className={
							value === ""
								? "overflow-hidden text-ellipsis whitespace-nowrap text-faint"
								: "overflow-hidden text-ellipsis whitespace-nowrap"
						}
					>
						{value === "" ? "name this instance" : value}
					</span>
					<Icon name="edit" className="opacity-0 transition-opacity group-hover:opacity-100 [&>svg]:size-3.5 text-faint" />
				</button>
				</Tip>
			)}
		</span>
	);
}

export function ProvidersSection({ query }: { query: string }) {
	const state = useApp();
	const [providers, setProviders] = useState<ConfiguredProvider[] | null>(null);
	const [names, setNames] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState<string | null>(null);
	const [llama, setLlama] = useState<Awaited<ReturnType<typeof api.llamaStatus>> | null>(null);

	const reload = async (): Promise<void> => {
		const list = await api.providersList().catch(() => []);
		setProviders(list);
	};

	useEffect(() => {
		if (!state.settingsOpen) return;
		void reload();
		void api
			.knownProviders()
			.then((known) => setNames(Object.fromEntries(known.map((entry) => [entry.id, entry.name]))))
			.catch(() => undefined);
		void api.llamaStatus().then((status) => setLlama(status)).catch(() => undefined);
	}, [state.settingsOpen, state.providerDialogOpen]);

	const visible = (providers ?? []).filter((provider) => {
		const needle = query.trim().toLowerCase();
		if (needle === "") return true;
		return (
			provider.id.toLowerCase().includes(needle) ||
			(names[provider.id] ?? "").toLowerCase().includes(needle) ||
			(provider.primaryLabel ?? "").toLowerCase().includes(needle) ||
			provider.pool.some((entry: PoolCredentialInfo) => (entry.label ?? "").toLowerCase().includes(needle))
		);
	});

	const rename = async (provider: ConfiguredProvider, row: CredentialRow, label: string): Promise<void> => {
		const result = await api.poolRelabel(provider.id, row.id, label);
		if (!result.ok) {
			toast(result.error ?? "Could not rename that key", "error");
			return;
		}
		await reload();
	};

	const removeProvider = async (provider: ConfiguredProvider): Promise<void> => {
		const name = names[provider.id] ?? provider.id;
		const sure = await requestConfirm({
			title: `Remove ${name}?`,
			message:
				`The ${name} primary credential is deleted from your auth file and its models disappear from the list. ` +
				`${provider.pool.length > 0 ? "Its other instances are kept until you remove them. " : ""}Nothing is revoked on the provider's side.`,
			actionLabel: "Remove",
			destructive: true,
		});
		if (!sure) return;
		setBusy(provider.id);
		const result = await api.authRemove(provider.id);
		setBusy(null);
		if (!result.ok) {
			toast(result.error ?? `Could not remove ${name}`, "error");
			return;
		}
		toast(`${name} removed. The agent is restarting without it.`);
		await reload();
		window.setTimeout(() => void refreshModels(), 2500);
	};

	const removePoolEntry = async (provider: ConfiguredProvider, row: CredentialRow): Promise<void> => {
		const name = names[provider.id] ?? provider.id;
		const sure = await requestConfirm({
			title: "Remove this instance?",
			message: `${name} · ${row.label || row.id.slice(0, 8)} leaves the pool. Nothing is revoked on the provider's side.`,
			actionLabel: "Remove",
			destructive: true,
		});
		if (!sure) return;
		setBusy(row.id);
		const result = await api.poolRemove(provider.id, row.id);
		setBusy(null);
		if (!result.ok) {
			toast(result.error ?? "Could not remove that instance", "error");
			return;
		}
		await reload();
	};

	const setPooled = async (provider: ConfiguredProvider, pooled: boolean): Promise<void> => {
		// Optimistic: the switch answers at once, the file and the agent follow.
		setProviders((current) =>
			(current ?? []).map((entry) => (entry.id === provider.id ? { ...entry, pooled } : entry)),
		);
		const result = await api.poolSetPooled(provider.id, pooled);
		if (!result.ok) {
			toast(result.error ?? "Could not change the pool", "error");
			await reload();
			return;
		}
		window.setTimeout(() => void refreshModels(), 2500);
	};

	const launchLlama = async (): Promise<void> => {
		setBusy("llama.cpp");
		const result = await api.llamaLaunch();
		setBusy(null);
		if (!result.ok) {
			toast(result.error ?? "Could not start llama-server", "error");
			return;
		}
		toast(result.already ? "llama.cpp server is already running" : "llama.cpp server started");
		void api.llamaStatus().then((status) => setLlama(status)).catch(() => undefined);
		window.setTimeout(() => void refreshModels(), 1500);
	};

	/** The add dialog, started on a given provider when opened from its row. */
	const openAdd = (preset?: string): void => {
		app.providerDialogPreset = preset ?? null;
		app.providerDialogOpen = true;
		bump();
	};

	return (
		<div className="flex flex-col">
			{providers === null ? (
				<p className="py-4 text-sm text-faint">Reading your credentials…</p>
			) : providers.length === 0 ? (
				<div className="flex flex-col items-start gap-3 py-4">
					<p className="text-sm leading-relaxed text-muted-foreground">
						No providers set up yet. Add an API key and smolt picks up that provider's models, or sign in
						through the CLI for providers that use a browser login.
					</p>
					<Button size="sm" onClick={() => openAdd()}>
						Add a provider
					</Button>
				</div>
			) : visible.length === 0 ? (
				<p className="py-4 text-sm text-faint">No provider matches “{query.trim()}”.</p>
			) : (
				visible.map((provider) => {
					const name = names[provider.id] ?? provider.id;
					const rows = rowsOf(provider);
					return (
						<div key={provider.id} className="flex flex-col gap-2 border-b border-border/50 py-4 last:border-b-0">
							<div className="flex items-center justify-between gap-8">
								<div className="flex min-w-0 flex-col gap-1">
									<span className="text-sm leading-snug">{name}</span>
									<span className="text-xs leading-relaxed text-faint">
										{rows.length === 1 ? "1 instance" : `${rows.length} instances`}
										{provider.type === undefined && " · no primary credential"}
										{!provider.pooled
											? " · not in the pool: primary only, not in usage"
											: rows.length > 1
												? " · fails over to the next when one hits its limit"
												: ""}
									</span>
								</div>
								<div className="flex flex-none items-center justify-end gap-3">
									{provider.id === "llama.cpp" && llama !== null && !llama.reachable && llama.binary !== undefined && (
										<Tip
											label={
												llama.modelCount > 0
													? `Start the local llama.cpp server on ${llama.serverUrl ?? "http://127.0.0.1:8080"} with ${llama.modelCount} model${llama.modelCount === 1 ? "" : "s"}`
													: "Start the local llama.cpp server"
											}
										>
											<Button
												variant="outline"
												size="sm"
												disabled={busy === "llama.cpp"}
												onClick={() => void launchLlama()}
											>
												Launch server
											</Button>
										</Tip>
									)}
									<Tip
										label={
											"Include in pool: this provider's allowance shows in the usage view, and its instances " +
											"fail over to each other when one hits a usage limit. Switched off, it runs on its " +
											"primary key alone and stays out of usage."
										}
									>
									<label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
										Include in pool
										<Switch checked={provider.pooled} onCheckedChange={(next) => void setPooled(provider, next)} />
									</label>
									</Tip>
									<Button variant="outline" size="sm" onClick={() => openAdd(provider.id)}>
										Add instance
									</Button>
								</div>
							</div>
							<div className="flex flex-col gap-0.5">
								{rows.map((row) => (
									<div
										key={row.id}
										className="flex h-8 items-center justify-between gap-3 rounded-lg px-3 transition-colors hover:bg-accent"
									>
										<NameField provider={name} value={row.label} onSave={(label) => rename(provider, row, label)} />
										<span className="flex flex-none items-center gap-2">
											<em className="text-xs not-italic text-faint">
												{row.primary ? `primary · ${row.kind}` : row.kind}
											</em>
											<Tip label={row.primary ? `Remove ${name}'s primary credential` : "Remove this instance"}>
												<Button
													variant="ghost"
													size="icon"
													className="size-7"
													aria-label={row.primary ? `Remove ${name}'s primary credential` : "Remove this instance"}
													disabled={busy === (row.primary ? provider.id : row.id)}
													onClick={() => void (row.primary ? removeProvider(provider) : removePoolEntry(provider, row))}
												>
													<Icon name="trash" />
												</Button>
											</Tip>
										</span>
									</div>
								))}
							</div>
						</div>
					);
				})
			)}
			{providers !== null && providers.length > 0 && (
				<div className="flex items-center gap-2 pt-4">
					<Button variant="outline" size="sm" onClick={() => openAdd()}>
						Add provider
					</Button>
					<span className="text-xs text-faint">Keys live in your own auth and pool files, shared with the CLI.</span>
				</div>
			)}
		</div>
	);
}
