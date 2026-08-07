// pie: crates/ai/src/vertex_adc.rs — Vertex AI Application Default Credentials (ADC):
// service-account JWT exchange. Closes c4pt0r/pie#14's Vertex ADC gap: `google-vertex.ts`'s
// existing fallback (letting the `@google/genai` SDK resolve credentials on its own) only covers
// gcloud-cached creds / the GCE metadata server; it does nothing extra for a raw service-account
// JSON key file. This module implements just that one path of the full ADC chain — service-account
// JSON -> JWT -> token exchange — not gcloud cached creds or the GCE metadata server (oracle's own
// header scopes it the same way; those are still covered by the SDK fallback in google-vertex.ts).
//
// Flow (pie: vertex_adc.rs:3-15):
// 1. Read `GOOGLE_APPLICATION_CREDENTIALS` env var -> path to a service-account JSON file.
// 2. Parse `{ private_key, client_email, token_uri }`. The private key is a PEM-encoded PKCS#8 RSA
//    key.
// 3. Build a JWT with header `{alg:"RS256", typ:"JWT"}` and a claim set
//    `{iss, scope, aud, iat, exp}` (exp = iat + 3600).
// 4. Sign with RS256 (node:crypto — no `google-auth-library` dependency).
// 5. POST `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<jwt>` to `token_uri`.
//    Response carries `access_token` + `expires_in`.
//
// Caller is responsible for caching the access token until expiry; this module is a one-shot
// exchange (pie: vertex_adc.rs:14-15).
// PERF(port): every call re-exchanges a fresh token (no oracle caller exists to mirror a caching
// policy against — vertex_adc.rs is never wired to a call site in oracle). A per-process cache
// keyed off the credentials file path, refreshed near `expiresAt`, would avoid hitting Google's
// token endpoint on every streamed request.

// Node built-ins are loaded lazily so this module stays resolvable in a browser bundle: the
// ADC path is Node-only by nature (it reads a credentials file off disk and signs a JWT), and it
// only runs when GOOGLE_APPLICATION_CREDENTIALS is set — which cannot happen in a browser.
// The skeleton's other Node-touching util (utils/node-http-proxy.ts) stays bundleable by using
// npm packages instead of built-ins; there is no npm equivalent here, so lazy import it is.
// The specifiers go through a variable so a browser bundler cannot statically resolve them
// (scripts/check-browser-smoke.mjs bundles @pie/ai with esbuild platform:"browser", which fails
// on any statically-visible node: built-in — even inside a dynamic import()).
const NODE_CRYPTO = "node:crypto";
const NODE_FS = "node:fs";
async function nodeCrypto(): Promise<typeof import("node:crypto")> {
	return (await import(/* @vite-ignore */ NODE_CRYPTO)) as typeof import("node:crypto");
}
async function nodeFs(): Promise<typeof import("node:fs")> {
	return (await import(/* @vite-ignore */ NODE_FS)) as typeof import("node:fs");
}

const DEFAULT_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const JWT_LIFETIME_SECONDS = 3600;
const TOKEN_EXCHANGE_TIMEOUT_MS = 15_000;

export type VertexAdcErrorCode = "io" | "parse" | "sign" | "exchange";

/** pie: vertex_adc.rs:27-37 (`AdcError`) — thiserror variant -> Error subclass + `code` field. */
export class VertexAdcError extends Error {
	readonly code: VertexAdcErrorCode;

	constructor(code: VertexAdcErrorCode, message: string) {
		super(message);
		this.name = "VertexAdcError";
		this.code = code;
	}
}

/** pie: vertex_adc.rs:40-48 (`ServiceAccount`) */
export interface VertexServiceAccount {
	clientEmail: string;
	privateKey: string;
	tokenUri: string;
	projectId?: string;
}

/** pie: vertex_adc.rs:54-59 (`AccessToken`) */
export interface VertexAccessToken {
	token: string;
	/** Unix seconds. */
	expiresAt: number;
	scope?: string;
}

function base64url(input: Buffer | string): string {
	const buffer = typeof input === "string" ? Buffer.from(input, "utf-8") : input;
	return buffer.toString("base64url");
}

/**
 * Load the service-account file from `GOOGLE_APPLICATION_CREDENTIALS` (or an explicit path).
 * pie: vertex_adc.rs:79-92 (`load_service_account`)
 */
export async function loadVertexServiceAccount(path?: string): Promise<VertexServiceAccount> {
	const resolvedPath = path ?? process.env.GOOGLE_APPLICATION_CREDENTIALS;
	if (!resolvedPath) {
		throw new VertexAdcError("io", "GOOGLE_APPLICATION_CREDENTIALS not set");
	}

	let text: string;
	try {
		text = (await nodeFs()).readFileSync(resolvedPath, "utf-8");
	} catch (error) {
		throw new VertexAdcError("io", `${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`);
	}

	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new VertexAdcError("parse", error instanceof Error ? error.message : String(error));
	}

	const clientEmail = parsed.client_email;
	const privateKey = parsed.private_key;
	if (typeof clientEmail !== "string" || typeof privateKey !== "string") {
		throw new VertexAdcError("parse", "missing client_email/private_key in service account JSON");
	}

	return {
		clientEmail,
		privateKey,
		tokenUri: typeof parsed.token_uri === "string" ? parsed.token_uri : DEFAULT_TOKEN_URI,
		projectId: typeof parsed.project_id === "string" ? parsed.project_id : undefined,
	};
}

/**
 * Build the JWT assertion for `sa`. `scope` defaults to cloud-platform; supply your own to
 * restrict. pie: vertex_adc.rs:96-114 (`build_jwt`)
 */
export async function buildVertexJwt(sa: VertexServiceAccount, scope: string = DEFAULT_SCOPE): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const header = { alg: "RS256", typ: "JWT" };
	const claims = {
		iss: sa.clientEmail,
		scope,
		aud: sa.tokenUri,
		iat: now,
		exp: now + JWT_LIFETIME_SECONDS,
	};

	const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;

	let signature: Buffer;
	try {
		signature = (await nodeCrypto()).createSign("RSA-SHA256").update(signingInput).sign(sa.privateKey);
	} catch (error) {
		throw new VertexAdcError("sign", `parse private key: ${error instanceof Error ? error.message : String(error)}`);
	}

	return `${signingInput}.${base64url(signature)}`;
}

/**
 * One-shot: load creds -> build JWT -> POST -> return access_token. The caller caches.
 * pie: vertex_adc.rs:117-156 (`fetch_access_token`)
 */
export async function fetchVertexAccessToken(scope?: string): Promise<VertexAccessToken> {
	const sa = await loadVertexServiceAccount();
	const jwt = await buildVertexJwt(sa, scope ?? DEFAULT_SCOPE);

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), TOKEN_EXCHANGE_TIMEOUT_MS);
	let response: Response;
	try {
		response = await fetch(sa.tokenUri, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
				assertion: jwt,
			}),
			signal: controller.signal,
		});
	} catch (error) {
		throw new VertexAdcError("exchange", error instanceof Error ? error.message : String(error));
	} finally {
		clearTimeout(timeout);
	}

	const text = await response.text();
	if (!response.ok) {
		throw new VertexAdcError("exchange", `${response.status}: ${text.slice(0, 500)}`);
	}

	let parsed: { access_token?: string; expires_in?: number; scope?: string };
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new VertexAdcError("exchange", `parse: ${error instanceof Error ? error.message : String(error)}`);
	}

	if (!parsed.access_token) {
		throw new VertexAdcError("exchange", "parse: missing access_token in response");
	}

	const now = Math.floor(Date.now() / 1000);
	return {
		token: parsed.access_token,
		expiresAt: now + (parsed.expires_in ?? JWT_LIFETIME_SECONDS),
		scope: parsed.scope,
	};
}
