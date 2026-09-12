import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The imagined.so side of the sites extension: the credential a device
 * authorisation leaves behind, the link between a working directory and one
 * hosted project, and a small HTTP client over the routes a signed-in account
 * can call without touching the site builder's own agent or its credits.
 *
 * Everything takes an injectable fetch so the whole extension is testable
 * offline.
 */

export const DEFAULT_BASE_URL = "https://imagined.so";

/** The client id imagined.so's device-authorisation flow knows this program by. */
export const CLIENT_ID = "smolt";

/** What a device authorisation leaves behind: one session token for one account. */
export interface SitesCredentials {
	baseUrl: string;
	token: string;
	user: { id: string; email: string; name: string };
}

/** A working directory's hosted project. Lives in `.smolt/sites.json`; holds no secret. */
export interface SiteLink {
	owner: string;
	repo: string;
	name: string;
	/** The live address, once a publish has reported one. */
	url?: string;
}

export function loadCredentials(path: string): SitesCredentials | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<SitesCredentials>;
		if (typeof raw.token !== "string" || raw.token === "") return undefined;
		const user: Partial<SitesCredentials["user"]> = raw.user ?? {};
		return {
			baseUrl: typeof raw.baseUrl === "string" && raw.baseUrl !== "" ? raw.baseUrl : DEFAULT_BASE_URL,
			token: raw.token,
			user: {
				id: typeof user.id === "string" ? user.id : "",
				email: typeof user.email === "string" ? user.email : "",
				name: typeof user.name === "string" ? user.name : "",
			},
		};
	} catch {
		return undefined;
	}
}

export function saveCredentials(path: string, credentials: SitesCredentials): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
}

export function clearCredentials(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		// already gone
	}
}

export function siteLinkFile(cwd: string): string {
	return join(cwd, ".smolt", "sites.json");
}

export function loadSiteLink(cwd: string): SiteLink | undefined {
	const file = siteLinkFile(cwd);
	if (!existsSync(file)) return undefined;
	try {
		const raw = JSON.parse(readFileSync(file, "utf-8")) as Partial<SiteLink>;
		if (typeof raw.owner !== "string" || typeof raw.repo !== "string" || !raw.owner || !raw.repo) return undefined;
		return {
			owner: raw.owner,
			repo: raw.repo,
			name: typeof raw.name === "string" ? raw.name : raw.repo,
			url: typeof raw.url === "string" && raw.url !== "" ? raw.url : undefined,
		};
	} catch {
		return undefined;
	}
}

export function saveSiteLink(cwd: string, link: SiteLink): void {
	const file = siteLinkFile(cwd);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(link, null, 2)}\n`, "utf-8");
}

/** An answer from imagined.so that was not the one asked for. */
export class ImaginedError extends Error {
	status: number;
	code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = "ImaginedError";
		this.status = status;
		this.code = code;
	}
}

export interface Me {
	user: { id: string; name: string; email: string } | null;
	plan: "free" | "pro";
}

export interface Project {
	id: string;
	name: string;
	owner: string;
	repo: string;
	branch: string;
}

export interface DeviceCode {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	verificationUriComplete: string;
	expiresIn: number;
	interval: number;
}

export type DeviceTokenResult =
	| { status: "pending" }
	| { status: "slow_down" }
	| { status: "ok"; token: string; expiresIn: number }
	| { status: "denied" }
	| { status: "expired" };

export interface PublishStart {
	attemptId: string;
	commitSha: string;
	subdomain: string;
	url: string;
}

export interface PublishStatus {
	state: "building" | "live" | null;
	url: string | null;
	liveUrl: string | null;
	history: { deploy: string; deployedAt: number }[];
}

export interface SupabaseStatus {
	configured: boolean;
	connected: boolean;
	project: { url: string; anonKey: string } | null;
	provisioning: boolean;
}

export type DatabaseState =
	| { state: "ready"; schema: string; url: string; anonKey: string; authEmail: string }
	| { state: "not_connected" }
	| { state: "provisioning" }
	| { state: "unavailable" }
	| { state: "needs_capacity"; message: string; occupied: string[] }
	| { state: "error"; message: string };

export interface StorageBucket {
	name: string;
	access: "public-read" | "authenticated" | "user-private";
	maxFileSize?: number;
	allowedMimeTypes?: string[];
}

export interface StorageResult {
	buckets: { name: string; id: string; access: StorageBucket["access"] }[];
}

/** One file of a built site, ready to upload. */
export interface SiteFile {
	/** Relative, forward slashes, no leading slash: `assets/app-abc123.js`. */
	path: string;
	bytes: Uint8Array;
}

/** Repo files as imagined.so serves them: text keyed by `/path`, images as data URLs. */
export interface ProjectFiles {
	files: Record<string, string>;
	assets: Record<string, string>;
}

const JSON_HEADERS = { "content-type": "application/json" } as const;

export class ImaginedClient {
	readonly baseUrl: string;
	private readonly token: string | undefined;
	private readonly fetchImpl: typeof fetch;

	constructor(baseUrl: string, token: string | undefined, fetchImpl: typeof fetch = fetch) {
		this.baseUrl = baseUrl.replace(/\/+$/, "");
		this.token = token;
		this.fetchImpl = fetchImpl;
	}

	private headers(extra: Record<string, string> = {}): Record<string, string> {
		const headers: Record<string, string> = { accept: "application/json", ...extra };
		if (this.token !== undefined) headers.authorization = `Bearer ${this.token}`;
		return headers;
	}

	/**
	 * One request, one decoded JSON answer. A non-2xx answer becomes an
	 * ImaginedError carrying the server's `error` code and `message`, which is
	 * how every route on the other side explains itself.
	 */
	private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const init: RequestInit = { method, headers: this.headers(body instanceof FormData ? {} : JSON_HEADERS) };
		if (body instanceof FormData) init.body = body;
		else if (body !== undefined) init.body = JSON.stringify(body);
		let response: Response;
		try {
			response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
		} catch (error) {
			throw new ImaginedError(0, "network", `Could not reach ${this.baseUrl}: ${(error as Error).message}`);
		}
		const text = await response.text();
		let payload: unknown = null;
		try {
			payload = text === "" ? null : JSON.parse(text);
		} catch {
			payload = null;
		}
		if (!response.ok) {
			const detail = (payload ?? {}) as { error?: unknown; message?: unknown; error_description?: unknown };
			const code = typeof detail.error === "string" ? detail.error : `http_${response.status}`;
			const message =
				typeof detail.message === "string"
					? detail.message
					: typeof detail.error_description === "string"
						? detail.error_description
						: `${method} ${path} failed (${code})`;
			throw new ImaginedError(response.status, code, message);
		}
		return payload as T;
	}

	// ---- Device authorisation ----

	async deviceCode(): Promise<DeviceCode> {
		const raw = await this.request<{
			device_code: string;
			user_code: string;
			verification_uri: string;
			verification_uri_complete: string;
			expires_in: number;
			interval: number;
		}>("POST", "/api/auth/device/code", { client_id: CLIENT_ID });
		return {
			deviceCode: raw.device_code,
			userCode: raw.user_code,
			verificationUri: raw.verification_uri,
			verificationUriComplete: raw.verification_uri_complete,
			expiresIn: raw.expires_in,
			interval: raw.interval,
		};
	}

	/** One poll of the token endpoint; the caller paces itself by `interval`. */
	async deviceToken(deviceCode: string): Promise<DeviceTokenResult> {
		try {
			const raw = await this.request<{ access_token: string; expires_in: number }>(
				"POST",
				"/api/auth/device/token",
				{
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
					device_code: deviceCode,
					client_id: CLIENT_ID,
				},
			);
			return { status: "ok", token: raw.access_token, expiresIn: raw.expires_in };
		} catch (error) {
			if (!(error instanceof ImaginedError)) throw error;
			switch (error.code) {
				case "authorization_pending":
					return { status: "pending" };
				case "slow_down":
					return { status: "slow_down" };
				case "access_denied":
					return { status: "denied" };
				case "expired_token":
					return { status: "expired" };
				default:
					throw error;
			}
		}
	}

	async signOut(): Promise<void> {
		await this.request("POST", "/api/auth/sign-out", {});
	}

	// ---- Account and projects ----

	async me(): Promise<Me> {
		const raw = await this.request<{ user: Me["user"]; plan?: string }>("GET", "/api/me");
		return { user: raw.user ?? null, plan: raw.plan === "pro" ? "pro" : "free" };
	}

	async listProjects(): Promise<Project[]> {
		const raw = await this.request<{ projects?: Project[] }>("GET", "/api/projects");
		return Array.isArray(raw.projects) ? raw.projects : [];
	}

	/** A new hosted project, seeded with the standard Vite + React scaffold. Free. */
	async createProject(name: string): Promise<Project> {
		const raw = await this.request<{ project: Project }>("POST", "/api/projects/draft", { name });
		return raw.project;
	}

	async projectFiles(owner: string, repo: string): Promise<ProjectFiles> {
		const query = new URLSearchParams({ owner, repo });
		const raw = await this.request<Partial<ProjectFiles>>("GET", `/api/repo/files?${query}`);
		return { files: raw.files ?? {}, assets: raw.assets ?? {} };
	}

	// ---- Publishing ----

	/** Reserve the address and open a publish attempt; the build is ours to supply. */
	async publishStart(owner: string, repo: string): Promise<PublishStart> {
		const raw = await this.request<PublishStart>("POST", "/api/publish", { owner, repo });
		return { attemptId: raw.attemptId, commitSha: raw.commitSha, subdomain: raw.subdomain, url: raw.url };
	}

	/**
	 * Upload the built site and move the live pointer to it.
	 *
	 * The wire shape is the one the site builder's own browser publisher uses:
	 * a `metadata` field naming the attempt and the sorted paths, then one
	 * `file:<index>` part per path in that same order.
	 */
	async publishComplete(start: PublishStart, files: SiteFile[]): Promise<{ url: string }> {
		const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
		const paths = sorted.map((file) => file.path);
		const deploy = crypto.randomUUID().replace(/-/g, "");
		const form = new FormData();
		form.set("metadata", JSON.stringify({ attemptId: start.attemptId, deploy, commitSha: start.commitSha, paths }));
		sorted.forEach((file, index) => {
			form.set(`file:${index}`, new Blob([file.bytes]), file.path);
		});
		const raw = await this.request<{ url: string }>("POST", "/api/publish/complete", form);
		return { url: raw.url };
	}

	async publishAbort(attemptId: string): Promise<void> {
		await this.request("POST", "/api/publish/abort", { attemptId }).catch(() => {});
	}

	async publishStatus(owner: string, repo: string): Promise<PublishStatus> {
		const query = new URLSearchParams({ owner, repo });
		const raw = await this.request<Partial<PublishStatus>>("GET", `/api/publish/status?${query}`);
		return {
			state: raw.state === "building" || raw.state === "live" ? raw.state : null,
			url: raw.url ?? null,
			liveUrl: raw.liveUrl ?? null,
			history: Array.isArray(raw.history) ? raw.history : [],
		};
	}

	async unpublish(owner: string, repo: string): Promise<void> {
		await this.request("DELETE", "/api/publish", { owner, repo });
	}

	// ---- The backend: Supabase, through the account's own connection ----

	async supabaseStatus(): Promise<SupabaseStatus> {
		const raw = await this.request<Partial<SupabaseStatus>>("GET", "/api/supabase/status");
		return {
			configured: raw.configured === true,
			connected: raw.connected === true,
			project: raw.project ?? null,
			provisioning: raw.provisioning === true,
		};
	}

	/**
	 * The Supabase authorisation page for this account, to open in a browser.
	 * The callback lands on imagined.so and needs no session of its own: the
	 * one-use state it carries names the account that started the flow.
	 */
	async supabaseConnectUrl(returnTo: string): Promise<string> {
		const query = new URLSearchParams({ returnTo });
		const raw = await this.request<{ url: string }>("GET", `/api/supabase/connect?${query}`);
		return raw.url;
	}

	/** Forget the account's Supabase connection; its projects and data stay put. */
	async supabaseDisconnect(): Promise<void> {
		await this.request("POST", "/api/supabase/disconnect", {});
	}

	async database(owner: string, repo: string): Promise<DatabaseState> {
		return this.request<DatabaseState>("POST", "/api/supabase/database", { owner, repo });
	}

	async sql(owner: string, repo: string, sql: string): Promise<{ ok: true } | { ok: false; error: string }> {
		try {
			await this.request("POST", "/api/supabase/sql", { owner, repo, sql });
			return { ok: true };
		} catch (error) {
			if (error instanceof ImaginedError && (error.code === "sql_failed" || error.code === "not_connected")) {
				return { ok: false, error: error.message };
			}
			throw error;
		}
	}

	async storage(owner: string, repo: string, buckets: StorageBucket[]): Promise<StorageResult> {
		const raw = await this.request<StorageResult>("POST", "/api/supabase/storage", { owner, repo, buckets });
		return { buckets: Array.isArray(raw.buckets) ? raw.buckets : [] };
	}
}
