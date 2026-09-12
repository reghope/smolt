import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { collectSite, detectLayout } from "../src/extensions/sites/build.ts";
import { loadCredentials, loadSiteLink, saveCredentials, saveSiteLink } from "../src/extensions/sites/client.ts";
import { createSitesExtension, type SitesHandle, suggestSiteName, upsertEnv } from "../src/extensions/sites/index.ts";
import { resolveRequest, startPreview } from "../src/extensions/sites/preview.ts";
import { SITES_GUIDANCE } from "../src/extensions/sites/prompt.ts";

/**
 * The sites extension against a fake imagined.so: the device login, creating
 * and linking a project, publishing a build as the host's multipart upload,
 * the backend preflight that writes `.env`, and the guidance that enters the
 * prompt only in a linked directory. The preview server is exercised for real
 * on a loopback port.
 */

interface RegisteredTool {
	name: string;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: unknown,
		onUpdate?: unknown,
		ctx?: unknown,
	): Promise<{ content: { type: string; text: string }[] }>;
}

interface RegisteredCommand {
	handler: (args: string, ctx: unknown) => Promise<void>;
}

class FakeSmolt {
	handlers = new Map<string, ((event: Record<string, unknown>, ctx?: unknown) => Promise<unknown>)[]>();
	tools = new Map<string, RegisteredTool>();
	commands = new Map<string, RegisteredCommand>();
	reports: string[] = [];
	sentUserMessages: string[] = [];

	sendUserMessage(content: string): void {
		this.sentUserMessages.push(content);
	}

	on(event: string, handler: (event: Record<string, unknown>, ctx?: unknown) => Promise<unknown>): void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
	}

	registerTool(tool: RegisteredTool): void {
		this.tools.set(tool.name, tool);
	}

	registerCommand(name: string, options: RegisteredCommand): void {
		this.commands.set(name, options);
	}

	sendMessage(message: { content: string }): void {
		this.reports.push(message.content);
	}

	async fire(event: string, payload: Record<string, unknown>, ctx: unknown): Promise<unknown> {
		let result: unknown;
		for (const handler of this.handlers.get(event) ?? []) result = await handler({ type: event, ...payload }, ctx);
		return result;
	}

	async command(args: string, ctx: unknown): Promise<void> {
		await this.commands.get("sites")!.handler(args, ctx);
	}

	async tool(params: Record<string, unknown>, ctx: unknown): Promise<string> {
		const result = await this.tools.get("sites")!.execute("call-1", params, undefined, undefined, ctx);
		return result.content[0]!.text;
	}
}

/** What the fake imagined.so saw and how it should answer. */
class FakeImagined {
	requests: { method: string; path: string; auth: string | null; body: unknown }[] = [];
	tokenAnswers: ("pending" | "ok" | "denied")[] = ["pending", "ok"];
	databaseAnswer: Record<string, unknown> = {
		state: "ready",
		schema: "app_proj_1",
		url: "https://abc.supabase.co",
		anonKey: "anon-key",
		authEmail: "ready",
	};
	completeFails = false;
	/** Per service: whether the account has it connected, and how many status polls until it reads so. */
	connections: Record<string, { connected: boolean; connectAfterPolls: number; polls: number }> = {
		supabase: { connected: false, connectAfterPolls: 1, polls: 0 },
		resend: { connected: false, connectAfterPolls: 1, polls: 0 },
		stripe: { connected: false, connectAfterPolls: 1, polls: 0 },
	};
	emailAnswer: Record<string, unknown> = { state: "ready", function: "send-form", notifyEmail: "rob@example.com" };
	paymentAnswer: Record<string, unknown> = {
		state: "ready",
		id: "plink_1",
		url: "https://buy.stripe.com/test_1",
		livemode: false,
	};
	checkoutAnswer: Record<string, unknown> = {
		state: "ready",
		function: "create-checkout",
		items: [{ sku: "tee" }],
		livemode: true,
		deployment: "deployed",
	};

	connect(service: "supabase" | "resend" | "stripe", connected = true): void {
		this.connections[service] = { connected, connectAfterPolls: connected ? 0 : 1, polls: 0 };
	}
	lastUpload:
		| { metadata: Record<string, unknown>; files: { field: string; name: string; text: string }[] }
		| undefined;

	fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		const method = init?.method ?? "GET";
		const headers = new Headers(init?.headers);
		const auth = headers.get("authorization");
		let body: unknown;
		if (init?.body instanceof FormData) {
			const metadata = JSON.parse(String(init.body.get("metadata"))) as Record<string, unknown>;
			const files: { field: string; name: string; text: string }[] = [];
			for (const [field, value] of init.body.entries()) {
				if (field === "metadata") continue;
				const file = value as File;
				files.push({ field, name: file.name, text: await file.text() });
			}
			this.lastUpload = { metadata, files };
			body = metadata;
		} else if (typeof init?.body === "string") {
			body = JSON.parse(init.body);
		}
		this.requests.push({ method, path: url.pathname, auth, body });
		return this.route(method, url, auth, body);
	};

	private route(method: string, url: URL, auth: string | null, body: unknown): Response {
		const json = (value: unknown, status = 200) => Response.json(value, { status });
		const path = url.pathname;
		if (path === "/api/auth/device/code") {
			return json({
				device_code: "dev-code",
				user_code: "ABCD2345",
				verification_uri: "https://imagined.test/device",
				verification_uri_complete: "https://imagined.test/device?user_code=ABCD2345",
				expires_in: 900,
				interval: 5,
			});
		}
		if (path === "/api/auth/device/token") {
			const answer = this.tokenAnswers.shift() ?? "pending";
			if (answer === "ok") return json({ access_token: "session-token", token_type: "Bearer", expires_in: 3600 });
			if (answer === "denied") return json({ error: "access_denied", error_description: "denied" }, 400);
			return json({ error: "authorization_pending", error_description: "pending" }, 400);
		}
		if (auth !== "Bearer session-token") return json({ error: "not_authenticated" }, 401);
		if (path === "/api/me") return json({ user: { id: "u1", name: "Rob", email: "rob@example.com" }, plan: "free" });
		if (path === "/api/projects" && method === "GET") {
			return json({
				projects: [{ id: "proj-1", name: "Old Site", owner: "~managed", repo: "proj-1", branch: "main" }],
			});
		}
		if (path === "/api/projects/draft") {
			const name = (body as { name: string }).name;
			return json({ project: { id: "proj-2", name, owner: "~managed", repo: "proj-2", branch: "main" } });
		}
		if (path === "/api/repo/files") {
			return json({
				files: { "/index.html": "<html>scaffold</html>", "/src/App.tsx": "export default function App() {}" },
				assets: { "/public/logo.png": `data:image/png;base64,${Buffer.from("PNG").toString("base64")}` },
			});
		}
		if (path === "/api/publish" && method === "POST") {
			return json({
				ok: true,
				attemptId: "attempt-1",
				commitSha: "sha-1",
				subdomain: "old-site",
				url: "https://old-site.imagined.sh",
			});
		}
		if (path === "/api/publish/complete") {
			if (this.completeFails) return json({ error: "stale_publish_attempt" }, 409);
			return json({ ok: true, url: "https://old-site.imagined.sh" });
		}
		if (path === "/api/publish/abort") return json({ ok: true });
		if (path === "/api/publish/status")
			return json({
				state: "live",
				url: "https://old-site.imagined.sh",
				liveUrl: "https://old-site.imagined.sh",
				history: [],
			});
		const service = /^\/api\/(supabase|resend|stripe-connect)\/(status|connect|disconnect)$/.exec(path);
		if (service) {
			const key = service[1] === "stripe-connect" ? "stripe" : service[1]!;
			const record = this.connections[key]!;
			if (service[2] === "status") {
				record.polls++;
				const connected =
					record.connected || (record.connectAfterPolls > 0 && record.polls > record.connectAfterPolls);
				if (connected) record.connected = true;
				if (key === "supabase") {
					return json({
						configured: true,
						connected,
						project: connected ? { url: "https://abc.supabase.co", anonKey: "k" } : null,
						provisioning: false,
					});
				}
				if (key === "resend")
					return json({
						configured: true,
						connected,
						notifyEmail: connected ? "rob@example.com" : null,
						fromDomain: null,
					});
				return json({
					configured: true,
					connected,
					accountId: connected ? "acct_1" : null,
					livemode: connected ? false : null,
				});
			}
			if (service[2] === "connect") {
				return json({
					url: `https://auth.${key}.example/authorize?state=s1&redirect=${encodeURIComponent(url.searchParams.get("returnTo") ?? "")}`,
				});
			}
			record.connected = false;
			record.polls = 0;
			return json({ ok: true });
		}
		if (path === "/api/resend/form-email") return json(this.emailAnswer);
		if (path === "/api/stripe-connect/payment-link") return json(this.paymentAnswer);
		if (path === "/api/stripe-connect/dynamic-checkout") return json(this.checkoutAnswer);
		if (path === "/api/supabase/database") return json(this.databaseAnswer);
		if (path === "/api/supabase/sql") {
			const sql = (body as { sql: string }).sql;
			if (/drop/i.test(sql))
				return json({ error: "sql_failed", message: "App SQL cannot use destructive schema changes" }, 400);
			return json({ ok: true });
		}
		if (path === "/api/supabase/storage")
			return json({
				ok: true,
				buckets: [{ name: "avatars", id: "app_proj_1_avatars_abc", access: "user-private" }],
			});
		return json({ error: "Not found" }, 404);
	}
}

let agentDir: string;
let cwd: string;
let smolt: FakeSmolt;
let imagined: FakeImagined;
let handle: SitesHandle;
let opened: string[];
let commands: { command: string; args: string[] }[];

function credentialsPath(): string {
	return join(agentDir, "sites.json");
}

function context(overrides: Record<string, unknown> = {}) {
	return {
		cwd,
		hasUI: true,
		ui: {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			select: async (_title: string, options: string[]) => options[0],
			confirm: async () => true,
			input: async (_title: string, placeholder?: string) => placeholder,
		},
		...overrides,
	};
}

function signedIn(): void {
	saveCredentials(credentialsPath(), {
		baseUrl: "https://imagined.test",
		token: "session-token",
		user: { id: "u1", email: "rob@example.com", name: "Rob" },
	});
}

function build(): void {
	smolt = new FakeSmolt();
	handle = createSitesExtension(
		smolt as unknown as ExtensionAPI,
		{ credentialsPath: credentialsPath() },
		{
			fetchImpl: imagined.fetch as typeof fetch,
			open: (url) => opened.push(url),
			sleep: async () => {},
			run: async (command, args, dir) => {
				commands.push({ command, args });
				// A pretend `vite build`: dist/ gets the front page and one asset.
				if (args[0] === "run") {
					mkdirSync(join(dir, "dist", "assets"), { recursive: true });
					writeFileSync(join(dir, "dist", "index.html"), "<html>built</html>");
					writeFileSync(join(dir, "dist", "assets", "app-1.js"), "console.log(1)");
				}
				return { code: 0, output: "built" };
			},
			serve: async (dir) => ({ url: "http://localhost:7345", port: 7345, dir, close: async () => {} }),
		},
	);
}

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "smolt-sites-agent-"));
	cwd = mkdtempSync(join(tmpdir(), "smolt-sites-cwd-"));
	imagined = new FakeImagined();
	opened = [];
	commands = [];
	process.env.SMOLT_SITES_URL = "https://imagined.test";
	build();
});

afterEach(() => {
	delete process.env.SMOLT_SITES_URL;
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

describe("signing in", () => {
	test("the device flow opens the approval page, polls, and keeps the session", async () => {
		await smolt.command("login", context());
		expect(opened).toEqual(["https://imagined.test/device?user_code=ABCD2345"]);
		// The code and the link are in the transcript before the wait, so the
		// reader can compare it with the page and approve from another device.
		expect(smolt.reports[0]).toContain("**ABCD-2345**");
		expect(smolt.reports[0]).toContain("https://imagined.test/device?user_code=ABCD2345");
		expect(smolt.reports[0]).toMatch(/nothing to type into smolt/);
		expect(smolt.reports.at(-1)).toBe("Signed in to imagined.so as rob@example.com.");
		expect(loadCredentials(credentialsPath())?.token).toBe("session-token");
		expect(handle.getCredentials()?.user.email).toBe("rob@example.com");
		const tokenPolls = imagined.requests.filter((request) => request.path === "/api/auth/device/token");
		expect(tokenPolls).toHaveLength(2);
		expect(tokenPolls[0]?.body).toMatchObject({ client_id: "smolt", device_code: "dev-code" });
	});

	test("an older server is named as the reason a login cannot start", async () => {
		imagined.fetch = async () => Response.json({ error: "Not found" }, { status: 404 });
		build();
		await smolt.command("login", context());
		expect(smolt.reports.at(-1)).toBe(
			"POST /api/auth/device/code failed. That address does not offer this yet: the imagined.so server is older than this extension, or the base URL is wrong.",
		);
	});

	test("a denied approval leaves nothing behind", async () => {
		imagined.tokenAnswers = ["denied"];
		await smolt.command("login", context());
		expect(smolt.reports.at(-1)).toMatch(/denied/);
		expect(existsSync(credentialsPath())).toBe(false);
	});

	test("logout forgets the session on this machine", async () => {
		signedIn();
		build();
		await smolt.command("logout", context());
		expect(existsSync(credentialsPath())).toBe(false);
		expect(imagined.requests.some((request) => request.path === "/api/auth/sign-out")).toBe(true);
	});
});

describe("a request in one line", () => {
	test("signs in, creates the site, and hands the request to the agent", async () => {
		await smolt.command(
			"create a site inspired by https://topballer.co/ using info from https://www.futsaluk.co.uk/",
			context(),
		);
		expect(opened[0]).toBe("https://imagined.test/device?user_code=ABCD2345");
		expect(loadCredentials(credentialsPath())?.token).toBe("session-token");
		expect(imagined.requests.find((request) => request.path === "/api/projects/draft")?.body).toEqual({
			name: "Futsaluk",
		});
		expect(loadSiteLink(cwd)?.name).toBe("Futsaluk");
		expect(existsSync(join(cwd, "src", "App.tsx"))).toBe(true);
		expect(smolt.sentUserMessages).toHaveLength(1);
		expect(smolt.sentUserMessages[0]).toMatch(/^create a site inspired by https:\/\/topballer.co\//);
		expect(smolt.sentUserMessages[0]).toContain('the site "Futsaluk"');
		expect(smolt.sentUserMessages[0]).toContain("do not publish unless asked");
	});

	test("a directory already linked goes straight to the agent", async () => {
		signedIn();
		build();
		saveSiteLink(cwd, { owner: "~managed", repo: "proj-1", name: "Old Site" });
		await smolt.command("add a pricing page", context());
		expect(imagined.requests.some((request) => request.path === "/api/projects/draft")).toBe(false);
		expect(smolt.sentUserMessages[0]).toMatch(/^add a pricing page/);
	});

	test("a denied login sends nothing to the agent", async () => {
		imagined.tokenAnswers = ["denied"];
		await smolt.command("build me a blog", context());
		expect(smolt.sentUserMessages).toEqual([]);
		expect(loadSiteLink(cwd)).toBeUndefined();
	});

	test("cancelling the name question starts nothing", async () => {
		signedIn();
		build();
		await smolt.command("build me a blog", context({ ui: { ...context().ui, input: async () => undefined } }));
		expect(smolt.sentUserMessages).toEqual([]);
		expect(smolt.reports.at(-1)).toBe("Nothing started.");
	});

	test("the suggested name comes from the last link, else the first real words", () => {
		expect(suggestSiteName("inspired by https://topballer.co/ using https://www.futsaluk.co.uk/ info")).toBe(
			"Futsaluk",
		);
		expect(suggestSiteName("build me a landing page for Acme Dental please")).toBe("Landing Acme Dental");
		expect(suggestSiteName("make a site")).toBe("My Site");
	});
});

describe("projects", () => {
	test("new creates the hosted project and lays its starter files here", async () => {
		signedIn();
		build();
		writeFileSync(join(cwd, "index.html"), "<html>mine</html>");
		await smolt.command("new My Shop", context());
		expect(imagined.requests.find((request) => request.path === "/api/projects/draft")?.body).toEqual({
			name: "My Shop",
		});
		expect(loadSiteLink(cwd)).toEqual({ owner: "~managed", repo: "proj-2", name: "My Shop", url: undefined });
		expect(readFileSync(join(cwd, "src", "App.tsx"), "utf-8")).toContain("function App");
		expect(readFileSync(join(cwd, "public", "logo.png"), "utf-8")).toBe("PNG");
		// A file already here is the reader's; the starter never overwrites it.
		expect(readFileSync(join(cwd, "index.html"), "utf-8")).toBe("<html>mine</html>");
		expect(readFileSync(join(cwd, ".gitignore"), "utf-8")).toContain("node_modules");
		expect(smolt.reports.at(-1)).toMatch(/Left as they were: index.html/);
	});

	test("link ties the directory to a chosen existing project", async () => {
		signedIn();
		build();
		await smolt.command("link", context());
		expect(loadSiteLink(cwd)).toMatchObject({ repo: "proj-1", name: "Old Site" });
	});

	test("the guidance enters the prompt only in a linked directory", async () => {
		const before = await smolt.fire("before_agent_start", { systemPrompt: "base" }, context());
		expect(before).toBeUndefined();
		saveSiteLink(cwd, { owner: "~managed", repo: "proj-1", name: "Old Site" });
		const after = (await smolt.fire("before_agent_start", { systemPrompt: "base" }, context())) as {
			systemPrompt: string;
		};
		expect(after.systemPrompt.startsWith("base\n\n")).toBe(true);
		expect(after.systemPrompt).toContain(SITES_GUIDANCE);
		expect(SITES_GUIDANCE).toMatch(/NEVER create a Cloudflare Worker/);
		expect(SITES_GUIDANCE).toMatch(/ROW LEVEL SECURITY/);
	});
});

describe("publishing", () => {
	beforeEach(() => {
		signedIn();
		build();
		saveSiteLink(cwd, { owner: "~managed", repo: "proj-1", name: "Old Site" });
	});

	test("a static directory is uploaded as the host's multipart publish", async () => {
		writeFileSync(join(cwd, "index.html"), "<html>static</html>");
		mkdirSync(join(cwd, "css"));
		writeFileSync(join(cwd, "css", "site.css"), "body{}");
		writeFileSync(join(cwd, ".env"), "SECRET=1");
		const result = JSON.parse(await smolt.tool({ action: "publish" }, context())) as Record<string, unknown>;
		expect(result).toEqual({ ok: true, url: "https://old-site.imagined.sh", files: 2 });
		expect(commands).toEqual([]);
		expect(imagined.requests.find((request) => request.path === "/api/publish")?.body).toEqual({
			owner: "~managed",
			repo: "proj-1",
		});
		const upload = imagined.lastUpload!;
		expect(upload.metadata).toMatchObject({
			attemptId: "attempt-1",
			commitSha: "sha-1",
			paths: ["css/site.css", "index.html"],
		});
		expect(String(upload.metadata.deploy)).toMatch(/^[0-9a-f]{32}$/);
		expect(upload.files.map((file) => [file.field, file.name, file.text])).toEqual([
			["file:0", "css/site.css", "body{}"],
			["file:1", "index.html", "<html>static</html>"],
		]);
		expect(loadSiteLink(cwd)?.url).toBe("https://old-site.imagined.sh");
		expect(smolt.reports.at(-1)).toMatch(/Live at https:\/\/old-site.imagined.sh/);
	});

	test("a project is built first and dist/ is what goes up", async () => {
		writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { build: "vite build" } }));
		mkdirSync(join(cwd, "node_modules"));
		await smolt.command("publish", context());
		expect(commands).toEqual([{ command: "npm", args: ["run", "build"] }]);
		expect(imagined.lastUpload?.metadata.paths).toEqual(["assets/app-1.js", "index.html"]);
	});

	test("missing dependencies are installed before the build", async () => {
		writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { build: "vite build" } }));
		await smolt.command("publish", context());
		expect(commands.map((entry) => entry.args[0])).toEqual(["install", "run"]);
	});

	test("a refused upload releases the attempt", async () => {
		imagined.completeFails = true;
		writeFileSync(join(cwd, "index.html"), "<html></html>");
		const result = JSON.parse(await smolt.tool({ action: "publish" }, context())) as Record<string, unknown>;
		expect(result.ok).toBe(false);
		expect(String(result.error)).toContain("stale_publish_attempt");
		expect(imagined.requests.find((request) => request.path === "/api/publish/abort")?.body).toEqual({
			attemptId: "attempt-1",
		});
		expect(loadSiteLink(cwd)?.url).toBeUndefined();
	});

	test("nothing to publish is said before anything is sent", async () => {
		const result = JSON.parse(await smolt.tool({ action: "publish" }, context())) as Record<string, unknown>;
		expect(String(result.error)).toMatch(/Nothing to publish/);
		expect(imagined.requests.some((request) => request.path === "/api/publish")).toBe(false);
	});

	test("preview builds and serves the bundle", async () => {
		writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { build: "vite build" } }));
		mkdirSync(join(cwd, "node_modules"));
		const result = JSON.parse(await smolt.tool({ action: "preview" }, context())) as Record<string, unknown>;
		expect(result).toMatchObject({ ok: true, url: "http://localhost:7345" });
		expect(handle.getPreview()?.dir).toBe(join(cwd, "dist"));
		expect(await smolt.tool({ action: "preview_stop" }, context())).toMatch(/Stopped/);
		expect(handle.getPreview()).toBeUndefined();
	});
});

describe("the backend", () => {
	beforeEach(() => {
		signedIn();
		build();
		saveSiteLink(cwd, { owner: "~managed", repo: "proj-1", name: "Old Site" });
	});

	test("database writes the credentials into .env and names the schema", async () => {
		writeFileSync(join(cwd, ".env"), "VITE_APP_TITLE=Shop\nVITE_SUPABASE_URL=old\n");
		const result = JSON.parse(await smolt.tool({ action: "database" }, context())) as Record<string, unknown>;
		expect(result.state).toBe("ready");
		expect(String(result.message)).toContain("{ db: { schema: 'app_proj_1' } }");
		expect(readFileSync(join(cwd, ".env"), "utf-8")).toBe(
			"VITE_APP_TITLE=Shop\nVITE_SUPABASE_URL=https://abc.supabase.co\nVITE_SUPABASE_ANON_KEY=anon-key\n",
		);
	});

	test("not connected points at the connection page and writes nothing", async () => {
		imagined.databaseAnswer = { state: "not_connected" };
		const result = JSON.parse(await smolt.tool({ action: "database" }, context())) as Record<string, unknown>;
		expect(String(result.message)).toMatch(/Run \/sites supabase to connect it once/);
		expect(existsSync(join(cwd, ".env"))).toBe(false);
	});

	test("sql runs inside the project and reports a refusal verbatim", async () => {
		const ok = JSON.parse(
			await smolt.tool({ action: "sql", sql: "create table if not exists t (id int)" }, context()),
		);
		expect(ok).toEqual({ ok: true });
		expect(imagined.requests.at(-1)?.body).toMatchObject({ owner: "~managed", repo: "proj-1" });
		const refused = JSON.parse(await smolt.tool({ action: "sql", sql: "drop table t" }, context())) as Record<
			string,
			unknown
		>;
		expect(refused).toEqual({ ok: false, error: "App SQL cannot use destructive schema changes" });
	});

	test("storage returns the physical bucket ids", async () => {
		const result = JSON.parse(
			await smolt.tool({ action: "storage", buckets: [{ name: "avatars", access: "user-private" }] }, context()),
		) as { buckets: { id: string }[] };
		expect(result.buckets[0]?.id).toBe("app_proj_1_avatars_abc");
	});

	test("an unlinked directory is told so instead of calling out", async () => {
		rmSync(join(cwd, ".smolt"), { recursive: true, force: true });
		const result = JSON.parse(await smolt.tool({ action: "sql", sql: "select 1" }, context())) as Record<
			string,
			unknown
		>;
		expect(String(result.error)).toMatch(/not linked/);
		expect(imagined.requests.some((request) => request.path === "/api/supabase/sql")).toBe(false);
	});
});

describe("account connections", () => {
	beforeEach(() => {
		signedIn();
		build();
	});

	test("with nothing connected, the authorisation page opens and the wait ends on connected", async () => {
		await smolt.command("supabase", context());
		expect(opened[0]).toMatch(/^https:\/\/auth.supabase.example\/authorize\?state=s1/);
		expect(opened[0]).toContain(encodeURIComponent("/settings/connections"));
		expect(smolt.reports[0]).toMatch(/Connect Supabase/);
		expect(smolt.reports.at(-1)).toBe(
			"Supabase is connected, project https://abc.supabase.co. /sites database gives a linked site its schema and .env.",
		);
	});

	test("resend and stripe connect the same way, each through its own routes", async () => {
		await smolt.command("resend", context());
		expect(opened[0]).toMatch(/^https:\/\/auth.resend.example\//);
		expect(smolt.reports.at(-1)).toMatch(/^Resend is connected \(rob@example.com\)\. Forms can now email you/);
		await smolt.command("stripe", context());
		expect(opened[1]).toMatch(/^https:\/\/auth.stripe.example\//);
		expect(smolt.reports.at(-1)).toMatch(/^Stripe is connected \(acct_1\)\. Payments can now be taken/);
		const paths = imagined.requests.map((request) => request.path);
		expect(paths).toContain("/api/resend/connect");
		expect(paths).toContain("/api/stripe-connect/connect");
	});

	test("already connected, it reports and does not open anything", async () => {
		imagined.connect("supabase");
		await smolt.command("supabase", context());
		expect(opened).toEqual([]);
		expect(smolt.reports.at(-1)).toMatch(/^Supabase: connected, project .*switch connects a different account/);
	});

	test("switch disconnects first, then authorises again", async () => {
		imagined.connect("stripe");
		imagined.connections.stripe!.connectAfterPolls = 1;
		await smolt.command("stripe switch", context());
		const paths = imagined.requests.map((request) => request.path);
		expect(paths.indexOf("/api/stripe-connect/disconnect")).toBeGreaterThan(-1);
		expect(paths.indexOf("/api/stripe-connect/disconnect")).toBeLessThan(
			paths.indexOf("/api/stripe-connect/connect"),
		);
		expect(opened).toHaveLength(1);
		expect(smolt.reports.at(-1)).toMatch(/^Stripe is connected/);
	});

	test("a declined switch keeps the connection", async () => {
		imagined.connect("supabase");
		await smolt.command("supabase switch", context({ ui: { ...context().ui, confirm: async () => false } }));
		expect(imagined.requests.some((request) => request.path === "/api/supabase/disconnect")).toBe(false);
		expect(smolt.reports.at(-1)).toBe("Kept the current Supabase connection.");
	});

	test("disconnect forgets the connection", async () => {
		imagined.connect("resend");
		await smolt.command("resend disconnect", context());
		expect(imagined.requests.some((request) => request.path === "/api/resend/disconnect")).toBe(true);
		expect(smolt.reports.at(-1)).toMatch(/^Disconnected Resend/);
	});

	test("status lists every connection", async () => {
		imagined.connect("supabase");
		imagined.connect("stripe");
		await smolt.command("", context());
		const report = smolt.reports.at(-1) ?? "";
		expect(report).toContain("Supabase: connected, project https://abc.supabase.co.");
		expect(report).toContain("Resend: not connected.");
		expect(report).toContain("Stripe: connected (acct_1).");
	});
});

describe("email and payments", () => {
	beforeEach(() => {
		signedIn();
		build();
		saveSiteLink(cwd, { owner: "~managed", repo: "proj-1", name: "Old Site" });
	});

	test("email reports the function to invoke and where mail lands", async () => {
		const result = JSON.parse(await smolt.tool({ action: "email" }, context())) as Record<string, unknown>;
		expect(result.state).toBe("ready");
		expect(String(result.message)).toContain("supabase.functions.invoke('send-form'");
		expect(String(result.message)).toContain("emailed to rob@example.com");
		expect(imagined.requests.at(-1)?.body).toEqual({ owner: "~managed", repo: "proj-1" });
	});

	test("email not connected says to run /sites resend and to wire the form anyway", async () => {
		imagined.emailAnswer = { state: "needs_resend" };
		const result = JSON.parse(await smolt.tool({ action: "email" }, context())) as Record<string, unknown>;
		expect(String(result.message)).toMatch(/run \/sites resend/);
		expect(String(result.message)).toMatch(/WIRE THE FORM ANYWAY/);
	});

	test("payment_link sends the item and returns the hosted checkout", async () => {
		const result = JSON.parse(
			await smolt.tool(
				{ action: "payment_link", name: "Pro plan", unit_amount: 2900, currency: "gbp", interval: "month" },
				context(),
			),
		) as Record<string, unknown>;
		expect(result.state).toBe("ready");
		expect(String(result.message)).toContain("https://buy.stripe.com/test_1");
		expect(String(result.message)).toContain("(test mode)");
		expect(imagined.requests.at(-1)?.body).toEqual({
			owner: "~managed",
			repo: "proj-1",
			name: "Pro plan",
			unit_amount: 2900,
			currency: "gbp",
			interval: "month",
		});
	});

	test("payment_link without the required fields is refused before any call", async () => {
		const before = imagined.requests.length;
		const result = JSON.parse(await smolt.tool({ action: "payment_link", name: "Pro plan" }, context())) as Record<
			string,
			unknown
		>;
		expect(String(result.message)).toMatch(/name, unit_amount and currency are required/);
		expect(imagined.requests.length).toBe(before);
	});

	test("checkout provisions the function and names it", async () => {
		const result = JSON.parse(
			await smolt.tool(
				{
					action: "checkout",
					items: [{ sku: "tee", name: "Tee", unit_amount: 1500, currency: "gbp" }],
					success_path: "/thanks",
				},
				context(),
			),
		) as Record<string, unknown>;
		expect(result.state).toBe("ready");
		expect(String(result.message)).toContain('"create-checkout" is ACTIVE');
		expect(String(result.message)).toContain("deployed now");
		expect(imagined.requests.at(-1)?.body).toMatchObject({
			owner: "~managed",
			repo: "proj-1",
			success_path: "/thanks",
		});
	});

	test("checkout with Stripe missing says which connection and keeps the UI honest", async () => {
		imagined.checkoutAnswer = { state: "needs_stripe" };
		const result = JSON.parse(
			await smolt.tool(
				{ action: "checkout", items: [{ sku: "tee", name: "Tee", unit_amount: 1500, currency: "gbp" }] },
				context(),
			),
		) as Record<string, unknown>;
		expect(String(result.message)).toMatch(/run \/sites stripe/);
		expect(String(result.message)).toMatch(/Payments not enabled/);
	});
});

describe("collecting a site", () => {
	test("needs a front page, skips secrets, and keeps forward slashes", () => {
		expect(collectSite(cwd)).toEqual({ error: `No index.html in ${cwd}; a site needs a front page.` });
		writeFileSync(join(cwd, "index.html"), "x");
		mkdirSync(join(cwd, "assets", "deep"), { recursive: true });
		writeFileSync(join(cwd, "assets", "deep", "a.js"), "y");
		writeFileSync(join(cwd, ".env.local"), "z");
		mkdirSync(join(cwd, "node_modules"));
		writeFileSync(join(cwd, "node_modules", "dep.js"), "w");
		const result = collectSite(cwd);
		expect("files" in result && result.files.map((file) => file.path)).toEqual(["assets/deep/a.js", "index.html"]);
	});

	test("the layout is read from what is in the directory", () => {
		expect(detectLayout(cwd)).toEqual({ kind: "none" });
		writeFileSync(join(cwd, "index.html"), "x");
		expect(detectLayout(cwd)).toEqual({ kind: "static", dir: cwd });
		writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { build: "vite build" } }));
		expect(detectLayout(cwd)).toEqual({ kind: "vite", outDir: join(cwd, "dist") });
	});

	test("upsertEnv replaces what it knows and appends the rest", () => {
		const file = join(cwd, ".env");
		upsertEnv(file, { A: "1" });
		expect(readFileSync(file, "utf-8")).toBe("A=1\n");
		writeFileSync(file, "# note\nA=old\nB=2\n\n");
		upsertEnv(file, { A: "new", C: "3" });
		expect(readFileSync(file, "utf-8")).toBe("# note\nA=new\nB=2\nC=3\n");
	});
});

describe("the preview server", () => {
	test("serves files, falls back to the front page for routes, and stays inside the root", async () => {
		writeFileSync(join(cwd, "index.html"), "<html>front</html>");
		mkdirSync(join(cwd, "assets"));
		writeFileSync(join(cwd, "assets", "app.js"), "js");
		const preview = await startPreview(cwd, 0);
		try {
			expect(await (await fetch(`${preview.url}/`)).text()).toBe("<html>front</html>");
			const asset = await fetch(`${preview.url}/assets/app.js`);
			expect(asset.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
			expect(await asset.text()).toBe("js");
			expect(await (await fetch(`${preview.url}/about/team`)).text()).toBe("<html>front</html>");
			expect((await fetch(`${preview.url}/assets/missing.js`)).status).toBe(404);
			const climb = await fetch(`${preview.url}/..%2f..%2fetc%2fpasswd`);
			expect([200, 404]).toContain(climb.status);
			expect(await climb.text()).not.toMatch(/root:/);
		} finally {
			await preview.close();
		}
		expect(resolveRequest(cwd, "/../outside.txt")).toBeUndefined();
		expect(resolveRequest(cwd, "/assets/app.js")).toBe(join(cwd, "assets", "app.js"));
	});
});
