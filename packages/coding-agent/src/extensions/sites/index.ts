import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { openBrowser } from "../../utils/open-browser.ts";
import { type BuildRunner, collectSite, detectLayout, formatBytes, prepareSite, runCommand } from "./build.ts";
import {
	type CheckoutInput,
	type CheckoutState,
	type ConnectionStatus,
	clearCredentials,
	type DatabaseState,
	DEFAULT_BASE_URL,
	type EmailState,
	ImaginedClient,
	ImaginedError,
	loadCredentials,
	loadSiteLink,
	type PaymentLinkInput,
	type PaymentLinkState,
	type Project,
	type Service,
	type SiteLink,
	type SitesCredentials,
	type StorageBucket,
	saveCredentials,
	saveSiteLink,
} from "./client.ts";
import { type Preview, startPreview } from "./preview.ts";
import { SITES_GUIDANCE } from "./prompt.ts";

/**
 * Sites: build a site here, host it on imagined.so.
 *
 * imagined.so is a site builder with its own agent, which costs credits per
 * turn. Publishing a static site there is free, and so is the account's
 * Supabase-backed database. This extension takes the free half: it signs a
 * smolt session in as a device the account approves once in a browser, keeps
 * one hosted project per working directory, previews the exact build locally,
 * and publishes it, all without the host's agent ever running.
 *
 * The site builder's working contract comes along too (prompt.ts): a fixed
 * Vite + React stack, a client-side app, Supabase as the one and only backend,
 * row level security on every table. It is what keeps a site publishable and
 * free to host, so it enters the system prompt in every linked directory.
 *
 * - `/sites login` runs the device flow; `/sites new` and `/sites link` tie the
 *   directory to a hosted project; `/sites preview`, `/sites publish`,
 *   `/sites database` do the work from a terminal.
 * - The `sites` tool gives the agent the same operations, so "add a database"
 *   or "publish it" happens in the conversation.
 */

const CONFIG_DIR_NAME = ".smolt";

function agentDir(): string {
	const envDir = process.env.SMOLT_CODING_AGENT_DIR;
	if (envDir) return envDir.startsWith("~") ? join(homedir(), envDir.slice(1)) : envDir;
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

/** A report is for the reader only, never steered into the model's turn. */
const REPORT_DELIVERY = { triggerTurn: false } as const;

/** Waiting longer than this for a device approval is waiting for nobody. */
const MAX_LOGIN_WAIT_MS = 15 * 60 * 1000;

/** How long a Supabase authorisation in the browser is waited for, and how often it is checked. */
const CONNECT_WAIT_MS = 5 * 60 * 1000;
const CONNECT_POLL_MS = 3000;

/**
 * What each account connection is called and what switches it on server-side.
 *
 * Every integration is a switch on the imagined.so server, not on the
 * account: off until the server carries that service's OAuth app credentials.
 * Nothing smolt or the account can do turns one on, so the message names the
 * switch.
 */
const SERVICES: Record<Service, { name: string; vars: string; callback: string; keeps: string }> = {
	supabase: {
		name: "Supabase",
		vars: "SUPABASE_OAUTH_CLIENT_ID and SUPABASE_OAUTH_CLIENT_SECRET",
		callback: "/api/supabase/callback",
		keeps: "The project, its data and its keys stay in your Supabase account, and published sites keep working.",
	},
	resend: {
		name: "Resend",
		vars: "RESEND_OAUTH_CLIENT_ID and RESEND_OAUTH_CLIENT_SECRET",
		callback: "/api/resend/callback",
		keeps: "Your Resend account and its domains stay as they are; forms stop being emailed until it is connected again.",
	},
	stripe: {
		name: "Stripe",
		vars: "STRIPE_CONNECT_CLIENT_ID and STRIPE_CONNECT_SECRET_KEY",
		callback: "/api/stripe-connect/callback",
		keeps: "Your Stripe account, its products and payment links stay as they are.",
	},
};

function serviceOff(service: Service): string {
	const info = SERVICES[service];
	return (
		`The ${info.name} integration is switched off on the imagined.so server: ${info.vars} are not set in its ` +
		`environment. Set them from the ${info.name} OAuth app (callback https://imagined.so${info.callback}), ` +
		`restart the server, then run /sites ${service} again.`
	);
}

const NOT_CONNECTED = (service: Service) =>
	`${SERVICES[service].name} is not connected to this imagined.so account. Run /sites ${service} to connect it once, then ask again.`;

/** Where the browser lands after Supabase hands the account back to imagined.so. */
const CONNECT_RETURN_PATH = "/settings/connections";

/** How long a build may take before it is abandoned as hung. */
const BUILD_TIMEOUT_NOTE = "npm run build";

const USAGE = [
	"/sites <what to build>      sign in and create the site if needed, then build it here",
	"/sites                      where this directory is hosted, and whether you are signed in",
	"/sites login | logout       authorise this machine with your imagined.so account, or forget it",
	"/sites new <name>           create a hosted project and its starter files here",
	"/sites link                 tie this directory to one of your existing projects",
	"/sites preview [off]        build and serve the exact publish bundle locally",
	"/sites publish              build and put the site live",
	"/sites unpublish            take the site down",
	"/sites open                 open the live site in a browser",
	"/sites database             give the site its database and write its .env",
	"/sites supabase             the account's Supabase connection; connects it when there is none",
	"/sites resend | stripe      the same for Resend (form email) and Stripe (payments)",
	"/sites <service> switch     connect a different account of that service",
	"/sites <service> disconnect forget the connection; what lives in the service stays where it is",
].join("\n");

/** Words a request starts with that say nothing about what the site is. */
const FILLER = new Set([
	"a",
	"an",
	"the",
	"me",
	"my",
	"us",
	"our",
	"for",
	"of",
	"to",
	"with",
	"and",
	"please",
	"build",
	"make",
	"create",
	"design",
	"site",
	"website",
	"web",
	"page",
	"app",
	"new",
	"that",
	"this",
	"is",
	"like",
	"inspired",
	"by",
	"using",
	"from",
	"based",
	"on",
	"it",
	"some",
	"into",
	"want",
	"i",
	"need",
]);

/**
 * A name for a site nobody has named yet, read from the request.
 *
 * The last link in a request is usually the subject ("info and images from
 * futsaluk.co.uk"), so its host wins; failing that, the first few words that
 * are not filler. The reader can still change it, but a sensible default is
 * one less question in the way of building.
 */
export function suggestSiteName(prompt: string): string {
	const urls = prompt.match(/https?:\/\/[^\s)"'<>]+/g) ?? [];
	const last = urls[urls.length - 1];
	if (last !== undefined) {
		try {
			const host = new URL(last).hostname.replace(/^www\./, "");
			const label = host.split(".")[0] ?? "";
			if (label !== "") return label.charAt(0).toUpperCase() + label.slice(1);
		} catch {
			// Not a URL after all; fall through to the words.
		}
	}
	const words = prompt
		.replace(/https?:\/\/\S+/g, " ")
		.split(/[^A-Za-z0-9]+/)
		.filter((word) => word !== "" && !FILLER.has(word.toLowerCase()))
		.slice(0, 3);
	const name = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
	return name === "" ? "My Site" : name.slice(0, 30);
}

function formatCode(code: string): string {
	return code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
}

function jsonResult(value: unknown) {
	return textResult(JSON.stringify(value));
}

function describe(error: unknown): string {
	if (error instanceof ImaginedError) {
		switch (error.code) {
			case "not_authenticated":
				return "Not signed in to imagined.so (or the session expired). Run /sites login.";
			case "no_active_project":
				return "imagined.so does not know this project under your account. Run /sites link or /sites new.";
			case "network":
				return error.message;
			default:
				if (error.status === 404) {
					return (
						`${error.message.replace(/ \([^()]*\)$/, "")}. ` +
						"That address does not offer this yet: the imagined.so server is older than this extension, or the base URL is wrong."
					);
				}
				return error.message.endsWith(`(${error.code})`) ? error.message : `${error.message} (${error.code})`;
		}
	}
	return error instanceof Error ? error.message : String(error);
}

/** Add or replace `KEY=value` lines in a dotenv file, keeping everything else. */
export function upsertEnv(file: string, values: Record<string, string>): void {
	const existing = existsSync(file) ? readFileSync(file, "utf-8") : "";
	const lines = existing === "" ? [] : existing.replace(/\r\n/g, "\n").split("\n");
	const pending = new Map(Object.entries(values));
	const next = lines.map((line) => {
		const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
		const key = match?.[1];
		if (key === undefined || !pending.has(key)) return line;
		const value = pending.get(key) ?? "";
		pending.delete(key);
		return `${key}=${value}`;
	});
	while (next.length > 0 && next[next.length - 1] === "") next.pop();
	for (const [key, value] of pending) next.push(`${key}=${value}`);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${next.join("\n")}\n`, "utf-8");
}

/**
 * Lay the starter files a hosted project was seeded with into a directory.
 * Files already there are left alone: the starter is a floor, never a reset.
 */
export function writeScaffold(
	cwd: string,
	files: Record<string, string>,
	assets: Record<string, string>,
): { written: string[]; kept: string[] } {
	const written: string[] = [];
	const kept: string[] = [];
	const place = (key: string, bytes: Uint8Array | string) => {
		const relativePath = key.replace(/^\/+/, "");
		if (relativePath === "" || relativePath.includes("..")) return;
		const target = join(cwd, relativePath);
		if (existsSync(target)) {
			kept.push(relativePath);
			return;
		}
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, bytes);
		written.push(relativePath);
	};
	for (const [key, content] of Object.entries(files)) place(key, content);
	for (const [key, dataUrl] of Object.entries(assets)) {
		const comma = dataUrl.indexOf(",");
		if (!dataUrl.startsWith("data:") || comma < 0) continue;
		place(key, Buffer.from(dataUrl.slice(comma + 1), "base64"));
	}
	if (!existsSync(join(cwd, ".gitignore"))) {
		writeFileSync(join(cwd, ".gitignore"), "node_modules\ndist\n.env\n", "utf-8");
		written.push(".gitignore");
	}
	return { written, kept };
}

export interface SitesPaths {
	credentialsPath: string;
}

export interface SitesExtensionOptions {
	fetchImpl?: typeof fetch;
	/** Runs `npm install` / `npm run build`; replaced in tests. */
	run?: BuildRunner;
	/** Opens a URL in the reader's browser; replaced in tests. */
	open?: (url: string) => void;
	/** Serves a directory locally; replaced in tests. */
	serve?: (dir: string) => Promise<Preview>;
	/** Pauses between device-token polls; replaced in tests. */
	sleep?: (ms: number) => Promise<void>;
}

export interface SitesHandle {
	getCredentials(): SitesCredentials | undefined;
	getPreview(): Preview | undefined;
}

export default function sitesExtension(smolt: ExtensionAPI): void {
	createSitesExtension(smolt, { credentialsPath: join(agentDir(), "sites.json") });
}

export function createSitesExtension(
	smolt: ExtensionAPI,
	paths: SitesPaths,
	options: SitesExtensionOptions = {},
): SitesHandle {
	const fetchImpl = options.fetchImpl ?? fetch;
	const run = options.run ?? runCommand;
	const open = options.open ?? openBrowser;
	const serve = options.serve ?? startPreview;
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

	let credentials = loadCredentials(paths.credentialsPath);
	let preview: Preview | undefined;

	function report(content: string): void {
		smolt.sendMessage({ customType: "sites-report", content, display: true }, REPORT_DELIVERY);
	}

	function client(): ImaginedClient | undefined {
		return credentials ? new ImaginedClient(credentials.baseUrl, credentials.token, fetchImpl) : undefined;
	}

	function baseUrl(): string {
		return credentials?.baseUrl ?? process.env.SMOLT_SITES_URL ?? DEFAULT_BASE_URL;
	}

	/** The signed-in client and this directory's project, or the reason there is none. */
	function linked(cwd: string): { api: ImaginedClient; link: SiteLink } | { error: string } {
		const api = client();
		if (!api) return { error: "Not signed in to imagined.so. Run /sites login." };
		const link = loadSiteLink(cwd);
		if (!link)
			return { error: "This directory is not linked to a hosted project. Run /sites new <name> or /sites link." };
		return { api, link };
	}

	// ---- Signing in ----

	async function login(ctx: ExtensionContext): Promise<string> {
		const anonymous = new ImaginedClient(baseUrl(), undefined, fetchImpl);
		const code = await anonymous.deviceCode();
		const shown = formatCode(code.userCode);
		const minutes = Math.max(1, Math.round(code.expiresIn / 60));
		// The code goes into the transcript, not just a passing notice: the
		// browser page asks the reader to check it against what smolt shows, and
		// the desktop app keeps no notices. The full link is there too, so the
		// approval can happen on a phone or another machine when this one has no
		// browser to open, or opened the wrong one.
		report(
			[
				`Authorise smolt on imagined.so. Your code is **${shown}**.`,
				"",
				`A browser page should have opened. If it did not, open ${code.verificationUriComplete} on any device where you are logged in to imagined.so.`,
				`Check the page shows ${shown}, then click Authorise. There is nothing to type into smolt; this chat continues on its own once the page confirms it.`,
				`The code is good for about ${minutes} minutes.`,
			].join("\n"),
		);
		ctx.ui.notify(`Confirm the code ${shown} at ${code.verificationUri} to authorise smolt.`, "info");
		ctx.ui.setStatus("sites", `waiting for ${shown} to be approved`);
		ctx.ui.setWidget("sites", [`imagined.so: approve code ${shown} at ${code.verificationUri}`]);
		open(code.verificationUriComplete);
		try {
			const deadline = Date.now() + Math.min(code.expiresIn * 1000, MAX_LOGIN_WAIT_MS);
			let interval = Math.max(1, code.interval) * 1000;
			while (Date.now() < deadline) {
				await sleep(interval);
				const result = await anonymous.deviceToken(code.deviceCode);
				switch (result.status) {
					case "pending":
						continue;
					case "slow_down":
						interval += 5000;
						continue;
					case "denied":
						return "The request was denied on imagined.so; nothing was connected.";
					case "expired":
						return `The code ${shown} expired before it was approved. Run /sites login again.`;
					case "ok": {
						const signed = new ImaginedClient(baseUrl(), result.token, fetchImpl);
						const me = await signed.me();
						if (!me.user) return "imagined.so issued a session but reports no user for it; try again.";
						credentials = {
							baseUrl: baseUrl(),
							token: result.token,
							user: { id: me.user.id, email: me.user.email, name: me.user.name },
						};
						saveCredentials(paths.credentialsPath, credentials);
						return `Signed in to imagined.so as ${me.user.email}.`;
					}
				}
			}
			return `Nobody approved ${shown} in time. Run /sites login again.`;
		} finally {
			ctx.ui.setStatus("sites", undefined);
			ctx.ui.setWidget("sites", undefined);
		}
	}

	async function logout(): Promise<string> {
		const api = client();
		if (!api) return "Not signed in.";
		await api.signOut().catch(() => {});
		clearCredentials(paths.credentialsPath);
		credentials = undefined;
		return "Signed out of imagined.so on this machine.";
	}

	// ---- Projects ----

	async function status(cwd: string): Promise<string> {
		const lines: string[] = [];
		if (!credentials) {
			lines.push("imagined.so: not signed in. /sites login authorises this machine.");
		} else {
			lines.push(`imagined.so: signed in as ${credentials.user.email}.`);
		}
		const link = loadSiteLink(cwd);
		if (!link) {
			lines.push(
				"This directory: not linked. /sites new <name> starts a site here; /sites link ties it to an existing one.",
			);
		} else {
			lines.push(`This directory: "${link.name}" (${link.repo}).`);
			const api = client();
			if (api) {
				try {
					const live = await api.publishStatus(link.owner, link.repo);
					if (live.state === "live" && live.liveUrl) lines.push(`Live at ${live.liveUrl}.`);
					else if (live.state === "building") lines.push(`A publish is in progress for ${live.url}.`);
					else lines.push("Not published yet. /sites publish puts it live.");
				} catch (error) {
					lines.push(`Could not read the publish state: ${describe(error)}`);
				}
			} else if (link.url) {
				lines.push(`Last published to ${link.url}.`);
			}
		}
		const layout = detectLayout(cwd);
		lines.push(
			layout.kind === "vite"
				? "Build: npm run build, publishing dist/."
				: layout.kind === "static"
					? "Build: none; index.html and everything beside it is published as is."
					: "Build: nothing to publish here yet.",
		);
		const api = client();
		if (api) {
			for (const service of ["supabase", "resend", "stripe"] as const) {
				try {
					lines.push(
						`${SERVICES[service].name}: ${describeConnection(service, await api.connectionStatus(service))}.`,
					);
				} catch (error) {
					lines.push(`${SERVICES[service].name}: ${describe(error)}`);
				}
			}
		}
		if (preview) lines.push(`Preview: ${preview.url} (serving ${preview.dir}).`);
		return lines.join("\n");
	}

	async function newSite(cwd: string, name: string): Promise<string> {
		const api = client();
		if (!api) return "Not signed in to imagined.so. Run /sites login first.";
		if (loadSiteLink(cwd)) return "This directory is already linked. Use a fresh directory for a new site.";
		if (name.trim() === "") return "Give the site a name: /sites new <name>.";
		const project = await api.createProject(name.trim());
		const files = await api.projectFiles(project.owner, project.repo);
		const laid = writeScaffold(cwd, files.files, files.assets);
		saveSiteLink(cwd, { owner: project.owner, repo: project.repo, name: project.name });
		const lines = [
			`Created "${project.name}" on imagined.so and linked this directory to it.`,
			laid.written.length > 0
				? `Starter files written: ${laid.written.join(", ")}.`
				: "No starter files were needed.",
		];
		if (laid.kept.length > 0) lines.push(`Left as they were: ${laid.kept.join(", ")}.`);
		lines.push("Next: npm install, then build the site here. /sites preview shows it; /sites publish puts it live.");
		return lines.join("\n");
	}

	async function link(cwd: string, ctx: ExtensionContext): Promise<string> {
		const api = client();
		if (!api) return "Not signed in to imagined.so. Run /sites login first.";
		const projects = await api.listProjects();
		if (projects.length === 0) return "No projects on imagined.so yet. /sites new <name> creates one.";
		let chosen: Project | undefined;
		if (ctx.hasUI) {
			const labels = projects.map((project) => `${project.name} (${project.repo})`);
			const picked = await ctx.ui.select("Link this directory to which project?", labels);
			if (picked === undefined) return "Nothing linked.";
			chosen = projects[labels.indexOf(picked)];
		} else {
			chosen = projects[0];
		}
		if (!chosen) return "Nothing linked.";
		saveSiteLink(cwd, { owner: chosen.owner, repo: chosen.repo, name: chosen.name });
		return `Linked this directory to "${chosen.name}" (${chosen.repo}).`;
	}

	// ---- Preview and publish ----

	async function stopPreview(): Promise<string> {
		if (!preview) return "No preview is running.";
		const was = preview;
		preview = undefined;
		await was.close();
		return `Stopped the preview at ${was.url}.`;
	}

	async function startSitePreview(cwd: string): Promise<{ url: string } | { error: string }> {
		const prepared = await prepareSite(cwd, run);
		if ("error" in prepared) return prepared;
		if (preview) await stopPreview();
		preview = await serve(prepared.dir);
		return { url: preview.url };
	}

	async function publish(cwd: string): Promise<{ url: string; files: number; bytes: number } | { error: string }> {
		const target = linked(cwd);
		if ("error" in target) return target;
		const prepared = await prepareSite(cwd, run);
		if ("error" in prepared) return prepared;
		const collected = collectSite(prepared.dir);
		if ("error" in collected) return collected;
		const bytes = collected.files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
		const start = await target.api.publishStart(target.link.owner, target.link.repo);
		try {
			const done = await target.api.publishComplete(start, collected.files);
			saveSiteLink(cwd, { ...target.link, url: done.url });
			return { url: done.url, files: collected.files.length, bytes };
		} catch (error) {
			await target.api.publishAbort(start.attemptId);
			throw error;
		}
	}

	async function unpublish(cwd: string): Promise<string> {
		const target = linked(cwd);
		if ("error" in target) return target.error;
		await target.api.unpublish(target.link.owner, target.link.repo);
		saveSiteLink(cwd, { ...target.link, url: undefined });
		return `Took "${target.link.name}" down. /sites publish puts it back.`;
	}

	// ---- The backend ----

	async function database(cwd: string): Promise<DatabaseState | { state: "error"; message: string }> {
		const target = linked(cwd);
		if ("error" in target) return { state: "error", message: target.error };
		const state = await target.api.database(target.link.owner, target.link.repo);
		if (state.state === "ready") {
			upsertEnv(join(cwd, ".env"), { VITE_SUPABASE_URL: state.url, VITE_SUPABASE_ANON_KEY: state.anonKey });
		}
		return state;
	}

	function databaseMessage(state: DatabaseState | { state: "error"; message: string }): string {
		switch (state.state) {
			case "ready":
				return (
					`The backend is ready. Schema: ${state.schema}. VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are in .env. ` +
					"Create tables with the sql action (idempotent; every table needs RLS enabled with policies in the same call). " +
					`Configure createClient with { db: { schema: '${state.schema}' } } and never query the public schema. ` +
					(state.authEmail === "ready"
						? "Email confirmation and password-reset delivery is configured."
						: "Email confirmation and password-reset delivery is not verified; do not claim sign-up email works.")
				);
			case "not_connected":
				return NOT_CONNECTED("supabase");
			case "provisioning":
				return "The database is still being created; this takes a minute or two on first use. Build the UI now and ask again shortly.";
			case "needs_capacity":
				return `${state.message} Projects in the way: ${state.occupied.join(", ") || "none listed"}.`;
			case "unavailable":
				return serviceOff("supabase");
			case "error":
				return state.message;
		}
	}

	function describeConnection(service: Service, state: ConnectionStatus): string {
		if (!state.configured) return "switched off on the server";
		if (!state.connected) return "not connected";
		if (service === "supabase") {
			return state.detail
				? `connected, project ${state.detail}`
				: state.provisioning
					? "connected, project still being created"
					: "connected, no project yet";
		}
		return state.detail ? `connected (${state.detail})` : "connected";
	}

	/**
	 * Send the reader through a service's authorisation page and wait for
	 * imagined.so to report the account connected. The page is the same one
	 * the site builder's Connect button opens; the round trip ends on
	 * imagined.so, which is why the wait polls rather than listens.
	 */
	async function connectService(api: ImaginedClient, service: Service, ctx: ExtensionContext): Promise<string> {
		const name = SERVICES[service].name;
		const url = await api.connectUrl(service, CONNECT_RETURN_PATH);
		report(
			[
				`Connect ${name}: a browser page should have opened on ${name}'s authorisation screen.`,
				`If it did not, open ${url} on any device. Sign in to the ${name} account you want to use and allow imagined.so.`,
				"This chat continues on its own once the connection is made.",
			].join("\n"),
		);
		ctx.ui.setStatus("sites", `waiting for ${name} to be authorised`);
		ctx.ui.setWidget("sites", [`${name}: authorise imagined.so in the browser page that opened`]);
		open(url);
		try {
			const deadline = Date.now() + CONNECT_WAIT_MS;
			while (Date.now() < deadline) {
				await sleep(CONNECT_POLL_MS);
				const state = await api.connectionStatus(service);
				if (state.connected) {
					const next =
						service === "supabase"
							? " /sites database gives a linked site its schema and .env."
							: service === "resend"
								? " Forms can now email you: the agent's email action wires them."
								: " Payments can now be taken: the agent's payment_link and checkout actions create them.";
					return `${name} is ${describeConnection(service, state)}.${next}`;
				}
			}
			return `${name} was not connected in time. Run /sites ${service} again when you are ready.`;
		} finally {
			ctx.ui.setStatus("sites", undefined);
			ctx.ui.setWidget("sites", undefined);
		}
	}

	async function connection(service: Service, cwd: string, action: string, ctx: ExtensionContext): Promise<string> {
		const api = client();
		if (!api) return "Not signed in to imagined.so. Run /sites login first.";
		const name = SERVICES[service].name;
		const state = await api.connectionStatus(service);
		if (!state.configured) return serviceOff(service);
		switch (action) {
			case "":
			case "status": {
				if (!state.connected) return connectService(api, service, ctx);
				const link = loadSiteLink(cwd);
				return (
					`${name}: ${describeConnection(service, state)}.` +
					(service === "supabase" && link ? " /sites database gives this site its schema and .env." : "") +
					` /sites ${service} switch connects a different account.`
				);
			}
			case "switch":
			case "connect": {
				if (state.connected) {
					if (ctx.hasUI) {
						const sure = await ctx.ui.confirm(
							`Switch ${name} account?`,
							`What is created next goes to the ${name} account you connect now. ${SERVICES[service].keeps}`,
						);
						if (!sure) return `Kept the current ${name} connection.`;
					}
					await api.disconnect(service);
				}
				return connectService(api, service, ctx);
			}
			case "disconnect": {
				if (!state.connected) return `${name} is not connected.`;
				if (ctx.hasUI) {
					const sure = await ctx.ui.confirm(
						`Disconnect ${name}?`,
						`imagined.so forgets the connection. ${SERVICES[service].keeps}`,
					);
					if (!sure) return `Kept the ${name} connection.`;
				}
				await api.disconnect(service);
				return `Disconnected ${name} from imagined.so. /sites ${service} connects one again.`;
			}
			default:
				return `Usage: /sites ${service} [switch | disconnect]`;
		}
	}

	// ---- Email and payments ----

	/** The re-ask discipline every connection-dependent answer carries. */
	const STALE =
		"This answer expires as soon as they connect and they may never say so; ask again next time instead of repeating a stale status.";

	function emailMessage(state: EmailState): string {
		switch (state.state) {
			case "ready":
				return (
					`Email is set up in the user's own backend. Forms that should reach the site owner call ` +
					`supabase.functions.invoke('${state.function}', { body: { app: '<this site>', name, email, subject, message, company: '' } }) ` +
					`with the standard @supabase/supabase-js env client; the submission is emailed to ${state.notifyEmail} AND archived in their database. ` +
					"Include a visually-hidden 'company' honeypot field left empty, show sending/success/error states, and never put an email API key in the app."
				);
			case "no_repo":
				return "This directory is not linked to a hosted project. Run /sites new <name> or /sites link.";
			case "provisioning":
				return "Their backend is still being created (this takes a minute or two on first use). Build the UI now and ask again shortly.";
			case "needs_supabase":
				return `Email runs through the user's own backend, which is not connected AS OF THIS MOMENT. Tell them to run /sites supabase, WIRE THE FORM ANYWAY this turn (it starts working the moment they connect), and keep building. ${STALE}`;
			case "needs_resend":
				return `Resend is not connected AS OF THIS MOMENT. Tell them to run /sites resend, WIRE THE FORM ANYWAY this turn (it starts working the moment they connect), and keep building. ${STALE}`;
			case "error":
				return state.message;
		}
	}

	function paymentLinkMessage(state: PaymentLinkState): string {
		switch (state.state) {
			case "ready":
				return `Stripe hosted checkout is ready at ${state.url}${state.livemode ? "" : " (test mode)"}. Link the buy/subscribe button directly to this URL. Open it in the same tab, clearly label the price and billing interval, and never add a secret key or a fake local checkout form.`;
			case "no_repo":
				return "This directory is not linked to a hosted project. Run /sites new <name> or /sites link.";
			case "needs_stripe":
				return `Stripe is not connected AS OF THIS MOMENT. Tell them to run /sites stripe, keep building, and show a truthful non-interactive "Payments not enabled" state instead of a dead or fake checkout button. ${STALE}`;
			case "error":
				return state.message;
		}
	}

	function checkoutMessage(state: CheckoutState): string {
		switch (state.state) {
			case "ready":
				return (
					`Dynamic checkout is provisioned: "${state.function}" is ACTIVE in the user's Supabase project and its source matches the trusted catalogue ` +
					`(${state.deployment === "deployed" ? "deployed now" : "already current"}${state.livemode ? "" : ", test mode"}). ` +
					"Invoke it with { items: [{ sku, quantity }] }; prices are enforced server-side. This confirms current state only: do not speculate about earlier attempts, and do not add deployment instructions."
				);
			case "no_repo":
				return "This directory is not linked to a hosted project. Run /sites new <name> or /sites link.";
			case "needs_supabase":
			case "needs_stripe":
				return `${state.state === "needs_supabase" ? "Supabase" : "Stripe"} is not connected AS OF THIS MOMENT. Tell them to run /sites ${state.state === "needs_supabase" ? "supabase" : "stripe"}, keep building, and show a truthful non-interactive "Payments not enabled" state. Never ask them for a secret or give manual deployment instructions.`;
			case "provisioning":
				return "The Supabase project is still being prepared. Keep building and ask again next turn.";
			case "error":
				return state.message;
		}
	}

	// ---- A request in one line ----

	/**
	 * `/sites build me a ...`: everything between a bare terminal and a working
	 * session on a hosted site, then the request itself handed to the agent.
	 *
	 * Signing in and creating the project are done here rather than left to the
	 * agent because they are the reader's decisions: a browser approval and a
	 * name that becomes the site's address. Once the directory is linked, the
	 * site contract enters the prompt on its own and the agent takes it from
	 * there.
	 */
	async function buildFromPrompt(cwd: string, prompt: string, ctx: ExtensionContext): Promise<void> {
		if (!credentials) {
			const outcome = await login(ctx);
			report(outcome);
			if (!credentials) return;
		}
		let link = loadSiteLink(cwd);
		if (!link) {
			const suggested = suggestSiteName(prompt);
			let name: string | undefined = suggested;
			if (ctx.hasUI) {
				name = await ctx.ui.input(
					`Name for the site (becomes its address, e.g. ${suggested.toLowerCase().replace(/\s+/g, "-")}.imagined.sh)`,
					suggested,
				);
				if (name === undefined) {
					report("Nothing started.");
					return;
				}
				if (name.trim() === "") name = suggested;
			}
			report(await newSite(cwd, name));
			link = loadSiteLink(cwd);
			if (!link) return;
		}
		const layout = detectLayout(cwd);
		const install =
			layout.kind === "vite" && !existsSync(join(cwd, "node_modules"))
				? " Dependencies are not installed yet: run npm install before building."
				: "";
		smolt.sendUserMessage(
			`${prompt}

[Sent with /sites. This directory is the site "${link.name}", hosted on imagined.so; its starter files are in place.${install} ` +
				"Reference sites named above may be read for their content and design; images and icons the request asks to reuse are downloaded as real files under public/ and wired into the UI. " +
				"Build it here, verify it, and offer a preview; do not publish unless asked.]",
		);
	}

	// ---- Wiring ----

	smolt.on("before_agent_start", async (event, ctx) => {
		if (!loadSiteLink(ctx.cwd)) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${SITES_GUIDANCE}` };
	});

	smolt.on("session_shutdown", async () => {
		if (preview) await stopPreview();
	});

	smolt.registerTool({
		name: "sites",
		label: "Sites",
		description:
			"The site hosted on imagined.so that this directory builds. 'status' says whether the directory is linked, " +
			"signed in, and live. 'preview' builds the site (npm run build) and serves the exact publish bundle on " +
			"localhost, returning the URL; 'preview_stop' stops it. 'publish' builds and puts the site live, returning the " +
			"live URL: use it only when the user explicitly asked to publish. 'database' is the required live preflight " +
			"before any Supabase code: it gives the site its own schema in the account's Supabase project, writes " +
			"VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY into .env, and reports the state; call it again rather than " +
			"trusting an earlier answer. 'sql' runs idempotent app SQL inside that schema (unqualified table names; every " +
			"table must enable row level security and get policies in the same call). 'storage' creates app-scoped " +
			"storage buckets and returns the ids to use with supabase.storage.from(). 'email' provisions form email in " +
			"the user's own backend (a send-form function the app invokes) and reports how the app sends it; call it " +
			"after 'database' is ready. 'payment_link' creates a Stripe-hosted Payment Link in the user's connected Stripe " +
			"for one fixed-price item or plan; 'checkout' provisions the trusted Checkout Session function for a dynamic " +
			"cart with server-held prices. Connection states go stale: ask again rather than repeat an earlier answer. " +
			"Anything that fails explains why.",
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("status"),
					Type.Literal("preview"),
					Type.Literal("preview_stop"),
					Type.Literal("publish"),
					Type.Literal("database"),
					Type.Literal("sql"),
					Type.Literal("storage"),
					Type.Literal("email"),
					Type.Literal("payment_link"),
					Type.Literal("checkout"),
				],
				{ description: "What to do." },
			),
			name: Type.Optional(Type.String({ description: "'payment_link': the product or plan name." })),
			description: Type.Optional(Type.String({ description: "'payment_link': a short description." })),
			unit_amount: Type.Optional(
				Type.Integer({
					description: "'payment_link': price in the currency's smallest unit, e.g. 2900 for £29.00.",
				}),
			),
			currency: Type.Optional(Type.String({ description: "'payment_link': three-letter currency code." })),
			interval: Type.Optional(
				Type.Union([Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year")], {
					description: "'payment_link': billing interval for a plan; omit for a one-time payment.",
				}),
			),
			items: Type.Optional(
				Type.Array(
					Type.Object({
						sku: Type.String(),
						name: Type.String(),
						description: Type.Optional(Type.String()),
						unit_amount: Type.Integer({ description: "Server-owned price in the smallest unit." }),
						currency: Type.String(),
					}),
					{ description: "'checkout': the catalogue, 1 to 50 items." },
				),
			),
			success_path: Type.Optional(
				Type.String({ description: "'checkout': same-site path after payment; default /success." }),
			),
			cancel_path: Type.Optional(
				Type.String({ description: "'checkout': same-site path on cancel; default /cart." }),
			),
			sql: Type.Optional(
				Type.String({ description: "'sql' only: one or more idempotent statements, semicolon-separated." }),
			),
			buckets: Type.Optional(
				Type.Array(
					Type.Object({
						name: Type.String({ description: "Lowercase letters, digits and dashes." }),
						access: Type.Union([
							Type.Literal("public-read"),
							Type.Literal("authenticated"),
							Type.Literal("user-private"),
						]),
						maxFileSize: Type.Optional(Type.Integer({ description: "Bytes." })),
						allowedMimeTypes: Type.Optional(Type.Array(Type.String())),
					}),
					{ description: "'storage' only: the buckets the app needs." },
				),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				switch (params.action) {
					case "status":
						return textResult(await status(ctx.cwd));
					case "preview": {
						const result = await startSitePreview(ctx.cwd);
						return jsonResult(
							"error" in result
								? result
								: { ok: true, url: result.url, note: "A local preview, not the live site." },
						);
					}
					case "preview_stop":
						return textResult(await stopPreview());
					case "publish": {
						const result = await publish(ctx.cwd);
						if ("error" in result) return jsonResult(result);
						report(`Published ${result.files} files (${formatBytes(result.bytes)}). Live at ${result.url}`);
						return jsonResult({ ok: true, url: result.url, files: result.files });
					}
					case "database": {
						const state = await database(ctx.cwd);
						return jsonResult({ ...state, message: databaseMessage(state) });
					}
					case "sql": {
						const target = linked(ctx.cwd);
						if ("error" in target) return jsonResult({ ok: false, error: target.error });
						if (!params.sql || params.sql.trim() === "")
							return jsonResult({ ok: false, error: "sql is required." });
						return jsonResult(await target.api.sql(target.link.owner, target.link.repo, params.sql));
					}
					case "storage": {
						const target = linked(ctx.cwd);
						if ("error" in target) return jsonResult({ ok: false, error: target.error });
						if (!params.buckets || params.buckets.length === 0)
							return jsonResult({ ok: false, error: "buckets is required." });
						const result = await target.api.storage(
							target.link.owner,
							target.link.repo,
							params.buckets as StorageBucket[],
						);
						return jsonResult({ ok: true, buckets: result.buckets });
					}
					case "email": {
						const target = linked(ctx.cwd);
						if ("error" in target) return jsonResult({ state: "error", message: target.error });
						const state = await target.api.formEmail(target.link.owner, target.link.repo);
						return jsonResult({ ...state, message: emailMessage(state) });
					}
					case "payment_link": {
						const target = linked(ctx.cwd);
						if ("error" in target) return jsonResult({ state: "error", message: target.error });
						if (!params.name || params.unit_amount === undefined || !params.currency) {
							return jsonResult({ state: "error", message: "name, unit_amount and currency are required." });
						}
						const input: PaymentLinkInput = {
							name: params.name,
							description: params.description,
							unit_amount: params.unit_amount,
							currency: params.currency,
							interval: params.interval,
						};
						const state = await target.api.paymentLink(target.link.owner, target.link.repo, input);
						return jsonResult({ ...state, message: paymentLinkMessage(state) });
					}
					case "checkout": {
						const target = linked(ctx.cwd);
						if ("error" in target) return jsonResult({ state: "error", message: target.error });
						if (!params.items || params.items.length === 0) {
							return jsonResult({ state: "error", message: "items is required." });
						}
						const input: CheckoutInput = {
							items: params.items,
							success_path: params.success_path,
							cancel_path: params.cancel_path,
						};
						const state = await target.api.dynamicCheckout(target.link.owner, target.link.repo, input);
						return jsonResult({ ...state, message: checkoutMessage(state) });
					}
				}
			} catch (error) {
				return jsonResult({ ok: false, error: describe(error) });
			}
		},
	});

	smolt.registerCommand("sites", {
		description:
			"Build a site here and host it on imagined.so: describe the site, or login, new, link, preview, publish, database",
		handler: async (args, ctx) => {
			const [action = "", ...rest] = args.trim().split(/\s+/);
			const cwd = ctx.cwd;
			try {
				switch (action) {
					case "":
					case "status":
						report(await status(cwd));
						return;
					case "login":
						report(await login(ctx));
						return;
					case "logout":
						report(await logout());
						return;
					case "new":
						report(await newSite(cwd, rest.join(" ")));
						return;
					case "link":
						report(await link(cwd, ctx));
						return;
					case "preview": {
						if (rest[0] === "off" || rest[0] === "stop") {
							report(await stopPreview());
							return;
						}
						ctx.ui.notify(`Building (${BUILD_TIMEOUT_NOTE})...`, "info");
						const result = await startSitePreview(cwd);
						if ("error" in result) {
							report(result.error);
							return;
						}
						open(result.url);
						report(
							`Preview at ${result.url}. This is the exact build a publish would upload. /sites preview off stops it.`,
						);
						return;
					}
					case "publish": {
						ctx.ui.notify("Building and publishing...", "info");
						const result = await publish(cwd);
						report(
							"error" in result
								? result.error
								: `Published ${result.files} files (${formatBytes(result.bytes)}). Live at ${result.url}`,
						);
						return;
					}
					case "unpublish": {
						const target = loadSiteLink(cwd);
						if (target && ctx.hasUI) {
							const sure = await ctx.ui.confirm(
								"Take the site down?",
								`${target.name} will stop answering at its address.`,
							);
							if (!sure) return;
						}
						report(await unpublish(cwd));
						return;
					}
					case "open": {
						const target = linked(cwd);
						if ("error" in target) {
							report(target.error);
							return;
						}
						const live = await target.api.publishStatus(target.link.owner, target.link.repo);
						const url = live.liveUrl ?? target.link.url;
						if (!url) {
							report("The site is not published yet. /sites publish puts it live.");
							return;
						}
						open(url);
						report(`Opened ${url}`);
						return;
					}
					case "database":
						report(databaseMessage(await database(cwd)));
						return;
					case "supabase":
					case "resend":
					case "stripe":
						report(await connection(action, cwd, rest[0] ?? "", ctx));
						return;
					case "help":
						ctx.ui.notify(USAGE, "info");
						return;
					default:
						// Anything that is not a subcommand is the site to build.
						await buildFromPrompt(cwd, args.trim(), ctx);
				}
			} catch (error) {
				report(describe(error));
			}
		},
	});

	return {
		getCredentials: () => credentials,
		getPreview: () => preview,
	};
}
