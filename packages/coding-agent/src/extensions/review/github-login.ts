import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Smolt's GitHub OAuth app. Public by design: a device flow has no client
 * secret, and the client id identifies the app rather than authorising
 * anything on its own.
 */
const CLIENT_ID = "Ov23liM2o3kxVmC6o7fJ";

/**
 * `repo` covers reading a private repo's diff and writing a comment;
 * `admin:repo_hook` is what lets watching add the webhook it needs. GitHub
 * grants scopes at authorisation time, so asking for both here is the only
 * chance to get them without sending the reader back through the flow.
 */
const SCOPES = "repo admin:repo_hook";

/**
 * Where a reader grants or revokes what smolt may reach: this app's page under
 * their GitHub account settings, listing every organisation and the access it
 * has. A repo missing from setup is fixed here, not in smolt — nothing in the
 * device flow can widen access after the fact.
 */
export const ACCESS_URL = `https://github.com/settings/connections/applications/${CLIENT_ID}`;

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";

interface DeviceCodeResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	expires_in: number;
	interval: number;
}

/** What the reader must do to finish logging in, and what polling needs to follow it. */
export interface DeviceLoginPrompt {
	userCode: string;
	verificationUri: string;
	deviceCode: string;
	intervalSeconds: number;
	expiresInSeconds: number;
}

function credentialFile(): string {
	const envDir = process.env.SMOLT_CODING_AGENT_DIR;
	const dir = envDir
		? envDir.startsWith("~")
			? path.join(os.homedir(), envDir.slice(1))
			: envDir
		: path.join(os.homedir(), ".smolt", "agent");
	return path.join(dir, "github.json");
}

/** The stored GitHub token, when the reader has connected an account. */
export function storedToken(): string | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(credentialFile(), "utf-8")) as { token?: unknown };
		return typeof parsed.token === "string" && parsed.token !== "" ? parsed.token : undefined;
	} catch {
		return undefined;
	}
}

function storeToken(token: string, scope: string): void {
	const file = credentialFile();
	// Owner-only, like every other credential smolt stores (see core/auth-storage.ts):
	// this token can read private repos, comment as the reader, and add webhooks.
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	fs.writeFileSync(file, `${JSON.stringify({ token, scope, createdAt: Date.now() }, null, "\t")}\n`, {
		encoding: "utf-8",
		mode: 0o600,
	});
}

/** Forget the stored account. */
export function clearToken(): void {
	try {
		fs.rmSync(credentialFile());
	} catch {
		// nothing stored: already in the state the caller wanted
	}
}

/** Who the stored token belongs to, or undefined when it is missing or dead. */
export async function connectedAccount(): Promise<string | undefined> {
	const token = storedToken();
	if (token === undefined) return undefined;
	try {
		const response = await fetch("https://api.github.com/user", {
			headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
		});
		if (!response.ok) return undefined;
		const user = (await response.json()) as { login?: unknown };
		return typeof user.login === "string" ? user.login : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Ask GitHub for a code to show the reader.
 *
 * Split from the polling deliberately: polling blocks for as long as it takes
 * someone to finish in a browser, and a caller that awaits the whole login
 * before drawing anything leaves them staring at a page asking for a code
 * that was never displayed.
 */
export async function requestDeviceCode(): Promise<DeviceLoginPrompt> {
	const started = await fetch(DEVICE_CODE_URL, {
		method: "POST",
		headers: { accept: "application/json", "content-type": "application/json" },
		body: JSON.stringify({ client_id: CLIENT_ID, scope: SCOPES }),
	});
	if (!started.ok) throw new Error(`GitHub refused the login request (${started.status}).`);
	const device = (await started.json()) as Partial<DeviceCodeResponse> & { error_description?: string };
	if (typeof device.device_code !== "string" || typeof device.user_code !== "string") {
		throw new Error(device.error_description ?? "GitHub did not return a device code.");
	}
	return {
		userCode: device.user_code,
		verificationUri: device.verification_uri ?? "https://github.com/login/device",
		deviceCode: device.device_code,
		intervalSeconds: device.interval ?? 5,
		expiresInSeconds: device.expires_in ?? 900,
	};
}

/** Poll until the reader approves the code, then store the token and say who they are. */
export async function awaitApproval(prompt: DeviceLoginPrompt, signal: AbortSignal): Promise<string> {
	// RFC 8628 polling, kept here rather than imported: the shared helper in
	// packages/ai is not exported from the package, and this is the whole of it.
	const deadline = Date.now() + prompt.expiresInSeconds * 1000;
	let intervalMs = Math.max(1000, prompt.intervalSeconds * 1000);
	let token: { token: string; scope: string } | undefined;
	while (token === undefined) {
		if (signal.aborted) throw new Error("Login cancelled");
		if (Date.now() >= deadline) throw new Error("The login code expired before it was approved.");
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
		const outcome = await (async () => {
			const response = await fetch(TOKEN_URL, {
				method: "POST",
				headers: { accept: "application/json", "content-type": "application/json" },
				body: JSON.stringify({
					client_id: CLIENT_ID,
					device_code: prompt.deviceCode,
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				}),
			});
			const body = (await response.json()) as {
				access_token?: string;
				scope?: string;
				error?: string;
				interval?: number;
				error_description?: string;
			};
			if (typeof body.access_token === "string") {
				return { done: { token: body.access_token, scope: body.scope ?? SCOPES } };
			}
			// The reader has not finished in the browser yet; keep waiting.
			if (body.error === "authorization_pending") return {};
			// GitHub reports the new required minimum in `interval`.
			if (body.error === "slow_down") return { slowerBy: Math.max(1000, (body.interval ?? 5) * 1000) };
			throw new Error(body.error_description ?? body.error ?? "GitHub rejected the login.");
		})();
		if (outcome.done) token = outcome.done;
		else if (outcome.slowerBy) intervalMs = outcome.slowerBy;
	}

	storeToken(token.token, token.scope);
	const login = await connectedAccount();
	if (login === undefined) throw new Error("Logged in, but GitHub would not say who the token belongs to.");
	return login;
}
