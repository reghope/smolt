import { randomBytes } from "node:crypto";

/**
 * Supabase, held by smolt itself.
 *
 * A site's backend is the account's own Supabase project: one project for
 * all of a person's sites, one Postgres schema per site, queried straight
 * from the browser with the anon key and protected by row level security
 * alone. imagined.so provisions the same thing for its own agent, but only
 * through an OAuth app whose secret lives on its server. smolt is an open
 * client and can hold no secret, so it uses a personal access token the
 * person creates in their own Supabase dashboard and hands to smolt once
 * (Supabase's own CLI accepts the same token). From then on the Management
 * API does the rest, with no server of anyone's in between.
 *
 * The SQL guard rails are the site builder's, carried over: the schema name
 * is an allowlist, app SQL cannot reach project-level objects or other
 * schemas, and a batch that leaves a table without RLS and a policy is
 * rolled back.
 */

const API = "https://api.supabase.com";

/** The one project every site shares; also how it is recognised again after a disconnect. */
export const PROJECT_NAME = "imagined";

/** What a dashboard login leaves behind, plus what has been learned about the project since. */
export interface SupabaseCredentials {
	token: string;
	orgId?: string;
	projectRef?: string;
	projectUrl?: string;
	anonKey?: string;
}

// ---- Signing in ----

/** Where a person mints the token smolt asks for. */
export const TOKENS_PAGE = "https://supabase.com/dashboard/account/tokens";

/** The environment variable Supabase's own CLI reads, honoured here too. */
export const TOKEN_ENV = "SUPABASE_ACCESS_TOKEN";

/**
 * Whether a pasted value could be a Supabase personal access token. They
 * begin with `sbp_`; anything else is more likely a project key or a stray
 * paste, and is refused before it is sent anywhere.
 */
export function looksLikeAccessToken(value: string): boolean {
	return /^sbp_[A-Za-z0-9_-]{8,}$/.test(value.trim());
}

// ---- The Management API ----

/** A failed Management API call, carrying the body: the only place Supabase explains itself. */
export class SupabaseApiError extends Error {
	status: number;
	body: string;

	constructor(path: string, status: number, body: string) {
		super(`supabase ${path} ${status}: ${body.slice(0, 300)}`);
		this.name = "SupabaseApiError";
		this.status = status;
		this.body = body;
	}

	/** A 4xx other than bad credentials: this org will not take a project; another might. */
	get blocksCreate(): boolean {
		return this.status >= 400 && this.status < 500 && this.status !== 401;
	}
}

export class SupabaseManagement {
	private readonly token: string;
	private readonly fetchImpl: typeof fetch;

	constructor(token: string, fetchImpl: typeof fetch = fetch) {
		this.token = token;
		this.fetchImpl = fetchImpl;
	}

	private async api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
		const response = await this.fetchImpl(`${API}${path}`, {
			method: init?.method ?? "GET",
			headers: {
				authorization: `Bearer ${this.token}`,
				"content-type": "application/json",
				accept: "application/json",
			},
			body: init?.body === undefined ? undefined : JSON.stringify(init.body),
		});
		const text = await response.text().catch(() => "");
		if (!response.ok) throw new SupabaseApiError(path, response.status, text);
		try {
			return JSON.parse(text) as T;
		} catch {
			return null as T;
		}
	}

	organizations(): Promise<{ id: string; name: string }[]> {
		return this.api("/v1/organizations");
	}

	projects(): Promise<{ id: string; name: string; organization_id: string }[]> {
		return this.api("/v1/projects");
	}

	createProject(orgId: string, name: string, region: string, dbPass: string): Promise<{ id: string }> {
		return this.api("/v1/projects", {
			method: "POST",
			body: { organization_id: orgId, name, db_pass: dbPass, region },
		});
	}

	async healthy(ref: string): Promise<boolean> {
		try {
			const health = await this.api<{ name: string; status: string }[]>(`/v1/projects/${ref}/health?services=db`);
			return health.some((service) => service.status === "ACTIVE_HEALTHY");
		} catch {
			return false;
		}
	}

	async anonKey(ref: string): Promise<string | undefined> {
		const keys = await this.api<{ name: string; api_key: string }[]>(`/v1/projects/${ref}/api-keys`);
		return keys.find((key) => key.name === "anon" || key.name === "publishable")?.api_key;
	}

	/**
	 * Run SQL. The response body is the answer either way: on failure it is
	 * the Postgres error, which is what lets the agent repair its statement.
	 */
	async query(ref: string, sql: string): Promise<unknown> {
		const response = await this.fetchImpl(`${API}/v1/projects/${ref}/database/query`, {
			method: "POST",
			headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
			body: JSON.stringify({ query: sql, read_only: false }),
		});
		const text = await response.text().catch(() => "");
		if (!response.ok) {
			let detail = text.slice(0, 500);
			try {
				const parsed = JSON.parse(text) as { message?: string; error?: string };
				detail = parsed.message || parsed.error || detail;
			} catch {
				// Not JSON; the raw text is still the best there is.
			}
			throw new Error(detail || `supabase query ${response.status}`);
		}
		try {
			return JSON.parse(text);
		} catch {
			return null;
		}
	}

	postgrestSchemas(ref: string): Promise<{ db_schema: string }> {
		return this.api(`/v1/projects/${ref}/postgrest`);
	}

	setPostgrestSchemas(ref: string, schemas: string): Promise<unknown> {
		return this.api(`/v1/projects/${ref}/postgrest`, { method: "PATCH", body: { db_schema: schemas } });
	}

	authConfig(ref: string): Promise<{ uri_allow_list?: string | string[] }> {
		return this.api(`/v1/projects/${ref}/config/auth`);
	}

	setAuthAllowList(ref: string, list: string): Promise<unknown> {
		return this.api(`/v1/projects/${ref}/config/auth`, { method: "PATCH", body: { uri_allow_list: list } });
	}
}

// ---- Naming ----

/**
 * The Postgres schema a site's tables live in, keyed by the hosted project
 * id so it matches what imagined.so's own agent would use for the same site.
 * Interpolated into SQL, so it is an allowlist: anything else is refused.
 */
export function schemaName(app: string): string | undefined {
	const schema = `app_${app.toLowerCase().replace(/-/g, "_")}`;
	return /^app_[a-z0-9_]{1,40}$/.test(schema) ? schema : undefined;
}

function shortHash(value: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(36).padStart(7, "0").slice(0, 7);
}

/** Roughly where the person is, for a project that has to live somewhere. */
export function pickRegion(timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): string {
	if (timeZone.startsWith("Europe/London") || timeZone.startsWith("Europe/Dublin")) return "eu-west-2";
	if (timeZone.startsWith("Europe/")) return "eu-central-1";
	if (timeZone.startsWith("Australia/")) return "ap-southeast-2";
	if (timeZone.startsWith("Asia/Singapore") || timeZone.startsWith("Asia/Kuala")) return "ap-southeast-1";
	if (timeZone.startsWith("Asia/Tokyo")) return "ap-northeast-1";
	if (timeZone.startsWith("Asia/Kolkata")) return "ap-south-1";
	if (timeZone.startsWith("America/Sao_Paulo")) return "sa-east-1";
	if (timeZone.startsWith("America/Toronto") || timeZone.startsWith("America/Montreal")) return "ca-central-1";
	if (timeZone.startsWith("America/New_York") || timeZone.startsWith("America/Chicago")) return "us-east-1";
	return "us-west-2";
}

// ---- Guard rails on app SQL ----

/**
 * App SQL creates a site's tables and must never become a project-admin
 * escape hatch. Quoted values and comments are removed before inspection so
 * harmless copy cannot look like a command.
 */
export function validateAppSql(sql: string): string | undefined {
	if (!sql.trim() || sql.length > 100_000) return "SQL must be between 1 and 100000 characters";
	if (/\$([a-z_][a-z0-9_]*)?\$/i.test(sql)) return "App SQL cannot contain executable dollar-quoted blocks";
	const code = sql
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.replace(/--[^\r\n]*/g, " ")
		.replace(/'(?:''|[^'])*'/g, "''")
		.replace(/"(?:""|[^"])*"/g, "quoted_identifier")
		.toLowerCase();
	const forbidden: [RegExp, string][] = [
		[/\b(?:set|reset)\s+(?:local\s+)?(?:search_path|role|session_authorization)\b/, "session settings"],
		[
			/\b(?:create|alter|drop)\s+(?:role|user|database|schema|extension|function|procedure)\b/,
			"project-level objects",
		],
		[/\b(?:create|alter|drop)\s+(?:trigger|event\s+trigger|rule)\b/, "executable database hooks"],
		[
			/\b(?:grant|revoke|copy|vacuum|analyze|cluster|reindex|do|call|listen|notify|set_config)\b/,
			"project-level commands",
		],
		[/\b(?:drop|truncate)\s+(?:table\s+)?/, "destructive schema changes"],
		[/\b(?:begin|start\s+transaction|commit|rollback|savepoint)\b/, "transaction control"],
		[/\b(?:public|storage|vault|extensions|graphql_public|app_[a-z0-9_]+)\s*\./, "schema-qualified objects"],
		[/\bpg_(?:catalog|read_file|read_binary_file|ls_dir|stat_file)\b/, "server internals"],
	];
	for (const [pattern, label] of forbidden) {
		if (pattern.test(code)) return `App SQL cannot use ${label}`;
	}
	if (
		/\b(?:from|join|update|into|table|references|sequence)\s+(?:if\s+(?:not\s+)?exists\s+)?[a-z_][a-z0-9_]*\s*\./.test(
			code,
		)
	) {
		return "App SQL cannot reference another schema";
	}
	if (/\b(?:policy|index)\b[\s\S]{0,500}\bon\s+[a-z_][a-z0-9_]*\s*\./.test(code))
		return "App SQL cannot reference another schema";
	const functionSchemas = [...code.matchAll(/\b([a-z_][a-z0-9_]*)\s*\.\s*[a-z_][a-z0-9_]*\s*\(/g)];
	if (functionSchemas.some((match) => match[1] !== "auth")) return "App SQL cannot call another schema";
	if (/\bauth\s*\.\s*(?!uid\s*\(|jwt\s*\(|role\s*\()/i.test(code))
		return "Only auth.uid(), auth.jwt(), and auth.role() are allowed";
	return undefined;
}

const sqlString = (value: string): string => `'${value.replace(/'/g, "''")}'`;
const sqlIdentifier = (value: string): string => `"${value.replace(/"/g, '""')}"`;

/** The check run after every app batch: a table without RLS and a policy fails the whole batch. */
export function appSqlAudit(schema: string): string {
	return `do $smolt_rls$
declare missing text;
begin
  select string_agg(c.relname, ', ' order by c.relname)
    into missing
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = ${sqlString(schema)}
     and c.relkind in ('r', 'p')
     and (
       not c.relrowsecurity
       or not exists (
         select 1 from pg_catalog.pg_policies p
          where p.schemaname = n.nspname
            and p.tablename = c.relname
       )
     );
  if missing is not null then
    raise exception 'Every app table needs RLS and at least one policy: %', missing;
  end if;
end
$smolt_rls$;`;
}

/** The SQL that gives a site its schema, with the grants Supabase gives `public`. */
export function schemaSql(schema: string): string {
	return `create schema if not exists ${schema};
grant usage on schema ${schema} to anon, authenticated;
grant all on all tables in schema ${schema} to anon, authenticated;
grant all on all sequences in schema ${schema} to anon, authenticated;
alter default privileges in schema ${schema} grant all on tables to anon, authenticated;
alter default privileges in schema ${schema} grant all on sequences to anon, authenticated;`;
}

/** App SQL as it is actually run: inside the site's schema, audited, atomic. */
export function appSqlBatch(schema: string, sql: string): string {
	return `begin;
set local search_path to ${schema}, public;
${sql}
${appSqlAudit(schema)}
commit;`;
}

export function withSchema(current: string, schema: string): string {
	const seen = current
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	return seen.includes(schema) ? seen.join(", ") : [...seen, schema].join(", ");
}

// ---- Storage ----

export interface StorageBucket {
	name: string;
	access: "public-read" | "authenticated" | "user-private";
	maxFileSize?: number;
	allowedMimeTypes?: string[];
}

export interface StorageBucketResult {
	name: string;
	id: string;
	public: boolean;
	access: StorageBucket["access"];
}

export function storageBucketId(app: string, name: string): string | undefined {
	const slug = app
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	const logical = name.toLowerCase();
	if (!slug || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(logical)) return undefined;
	const suffix = `${shortHash(app)}-${logical}`;
	return `smolt-${slug.slice(0, Math.max(1, 63 - 7 - suffix.length))}-${suffix}`.slice(0, 63);
}

/**
 * Storage is global to the shared project, so every bucket id and policy is
 * derived here from the site's identity; the agent supplies only the logical
 * contract and cannot write policies against another site's bucket.
 */
export function storageProvisionSql(
	app: string,
	buckets: StorageBucket[],
): { sql: string; buckets: StorageBucketResult[] } | undefined {
	if (!schemaName(app) || buckets.length === 0 || buckets.length > 10) return undefined;
	const seen = new Set<string>();
	const results: StorageBucketResult[] = [];
	const statements: string[] = [];
	for (const bucket of buckets) {
		const logical = bucket.name.trim().toLowerCase();
		const id = storageBucketId(app, logical);
		if (
			!id ||
			seen.has(logical) ||
			!["public-read", "authenticated", "user-private"].includes(bucket.access) ||
			(bucket.maxFileSize !== undefined &&
				(!Number.isInteger(bucket.maxFileSize) || bucket.maxFileSize < 1 || bucket.maxFileSize > 100_000_000)) ||
			(bucket.allowedMimeTypes !== undefined &&
				(bucket.allowedMimeTypes.length > 20 ||
					bucket.allowedMimeTypes.some((mime) => !/^[a-z0-9.+*-]+\/[a-z0-9.+*-]+$/i.test(mime))))
		) {
			return undefined;
		}
		seen.add(logical);
		const isPublic = bucket.access === "public-read";
		const max = bucket.maxFileSize === undefined ? "null" : String(bucket.maxFileSize);
		const mime = bucket.allowedMimeTypes?.length
			? `array[${bucket.allowedMimeTypes.map(sqlString).join(", ")}]::text[]`
			: "null";
		statements.push(
			`insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (${sqlString(id)}, ${sqlString(id)}, ${isPublic}, ${max}, ${mime})
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;`,
		);
		const prefix = `smolt_${shortHash(`${app}:${logical}`)}`;
		const policy = (operation: string) => sqlIdentifier(`${prefix}_${operation}`);
		const inBucket = `bucket_id = ${sqlString(id)}`;
		const ownsObject = "owner_id = (select auth.uid()::text)";
		const ownsFolder = "(storage.foldername(name))[1] = (select auth.uid()::text)";
		const scoped = bucket.access === "user-private" ? `${inBucket} and ${ownsFolder}` : inBucket;
		const updateCheck =
			bucket.access === "user-private"
				? `${inBucket} and ${ownsFolder} and ${ownsObject}`
				: `${inBucket} and ${ownsObject}`;
		statements.push(
			`drop policy if exists ${policy("select")} on storage.objects;
create policy ${policy("select")} on storage.objects
  for select to ${isPublic ? "anon, authenticated" : "authenticated"}
  using (${scoped});
drop policy if exists ${policy("insert")} on storage.objects;
create policy ${policy("insert")} on storage.objects
  for insert to authenticated
  with check (${scoped});
drop policy if exists ${policy("update")} on storage.objects;
create policy ${policy("update")} on storage.objects
  for update to authenticated
  using (${updateCheck})
  with check (${scoped});
drop policy if exists ${policy("delete")} on storage.objects;
create policy ${policy("delete")} on storage.objects
  for delete to authenticated
  using (${updateCheck});`,
		);
		results.push({ name: logical, id, public: isPublic, access: bucket.access });
	}
	return { sql: statements.join("\n"), buckets: results };
}

// ---- Provisioning, end to end ----

export type DatabaseState =
	| { state: "ready"; schema: string; url: string; anonKey: string }
	| { state: "provisioning" }
	| { state: "needs_capacity"; occupied: string[] }
	| { state: "error"; message: string };

/**
 * A site's backend, ready or not.
 *
 * Adopts the account's existing shared project by name first, which is what
 * makes a reconnect land on the same data instead of a second project the
 * free plan would refuse. Otherwise every organisation is tried in turn,
 * since the free plan counts projects per person across all of them.
 * Creation is not instant, so this reports `provisioning` and the caller
 * asks again. The credentials are updated in place as they are learned.
 */
export async function ensureDatabase(
	api: SupabaseManagement,
	credentials: SupabaseCredentials,
	app: string,
	options: { region?: string; dbPass?: string } = {},
): Promise<DatabaseState> {
	const schema = schemaName(app);
	if (!schema) return { state: "error", message: `"${app}" cannot name a schema.` };
	try {
		if (!credentials.projectRef) {
			const existing = await api.projects();
			const mine = existing.find((project) => project.name === PROJECT_NAME);
			if (mine) {
				credentials.projectRef = mine.id;
				credentials.orgId = mine.organization_id;
			} else {
				const orgs = await api.organizations();
				if (orgs.length === 0)
					return { state: "error", message: "This Supabase account has no organisation to create a project in." };
				let refused = false;
				for (const org of orgs) {
					try {
						const created = await api.createProject(
							org.id,
							PROJECT_NAME,
							options.region ?? pickRegion(),
							options.dbPass ?? randomBytes(18).toString("base64url"),
						);
						credentials.projectRef = created.id;
						credentials.orgId = org.id;
						return { state: "provisioning" };
					} catch (error) {
						if (error instanceof SupabaseApiError && error.blocksCreate) {
							refused = true;
							continue;
						}
						throw error;
					}
				}
				if (refused && existing.length > 0) {
					return { state: "needs_capacity", occupied: existing.map((project) => project.name).slice(0, 10) };
				}
				return { state: "error", message: "No Supabase organisation would accept a new project." };
			}
		}
		const ref = credentials.projectRef;
		if (!credentials.anonKey || !credentials.projectUrl) {
			if (!(await api.healthy(ref))) return { state: "provisioning" };
			const anonKey = await api.anonKey(ref);
			if (!anonKey) return { state: "provisioning" };
			credentials.anonKey = anonKey;
			credentials.projectUrl = `https://${ref}.supabase.co`;
		}
		await api.query(ref, schemaSql(schema));
		// Exposing a schema restarts PostgREST, so it is skipped when already listed.
		const config = await api.postgrestSchemas(ref);
		const next = withSchema(config.db_schema ?? "public", schema);
		if (next !== config.db_schema) await api.setPostgrestSchemas(ref, next);
		return { state: "ready", schema, url: credentials.projectUrl, anonKey: credentials.anonKey };
	} catch (error) {
		if (error instanceof SupabaseApiError && error.status === 401) {
			return {
				state: "error",
				message: "Supabase no longer accepts smolt's token. Run /sites supabase to sign in again.",
			};
		}
		return { state: "error", message: error instanceof Error ? error.message : String(error) };
	}
}

/** Run app SQL inside the site's schema, audited and atomic. */
export async function runAppSql(
	api: SupabaseManagement,
	ref: string,
	app: string,
	sql: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const schema = schemaName(app);
	if (!schema) return { ok: false, error: `"${app}" cannot name a schema.` };
	const invalid = validateAppSql(sql);
	if (invalid) return { ok: false, error: invalid };
	try {
		await api.query(ref, appSqlBatch(schema, sql));
		return { ok: true };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/** Create the site's buckets and policies; the ids returned are the ones the app uses. */
export async function ensureStorage(
	api: SupabaseManagement,
	ref: string,
	app: string,
	buckets: StorageBucket[],
): Promise<{ ok: true; buckets: StorageBucketResult[] } | { ok: false; error: string }> {
	const plan = storageProvisionSql(app, buckets);
	if (!plan) return { ok: false, error: "invalid storage configuration" };
	try {
		await api.query(ref, plan.sql);
		return { ok: true, buckets: plan.buckets };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Put a site's origin on Auth's redirect allowlist so confirmation and reset
 * links land back on the site. Other entries are left alone; the shared
 * project's default site URL is not touched.
 */
export async function ensureAuthRedirect(api: SupabaseManagement, ref: string, origin: string): Promise<void> {
	const safe = new URL(origin);
	if (safe.username || safe.password || safe.pathname !== "/" || safe.search || safe.hash) {
		throw new Error("invalid auth redirect origin");
	}
	const config = await api.authConfig(ref);
	const redirect = `${safe.origin}/**`;
	const existing = (
		Array.isArray(config.uri_allow_list) ? config.uri_allow_list : String(config.uri_allow_list ?? "").split(",")
	)
		.map((value) => value.trim())
		.filter(Boolean);
	if (existing.includes(redirect)) return;
	await api.setAuthAllowList(ref, [...existing, redirect].join(","));
}
