/**
 * Generic OAuth 2.0 PKCE helper. Port of oracle `crates/coding-agent/src/oauth.rs` (pie
 * @0a120dfd) -- foundation for c4pt0r/pie#13's browser-based login flows. Provider-specific
 * wiring (Anthropic Pro/Max, Codex, Copilot, Google) plugs into this generic flow by supplying
 * its authorization/token endpoints + client id.
 *
 * Flow:
 *   1. Build a `Flow` with provider endpoints + scopes + a redirect port.
 *   2. `flow.buildAuthorization()` returns the URL to open in the user's browser, plus the
 *      `state` and PKCE `verifier` kept on the side.
 *   3. `flow.awaitCallback(timeoutMs)` binds 127.0.0.1:redirectPort, waits for the OAuth
 *      provider's redirect, and extracts `code` + `state`. The caller checks `state` against
 *      what was generated to defend against CSRF.
 *   4. `flow.exchangeCode(code, verifier)` POSTs to the token endpoint and returns
 *      `{ access_token, refresh_token, expires_in }` ready to drop into the auth store.
 *
 * oracle's module is itself dead code in the audited snapshot (`#![allow(dead_code)]`, zero
 * `use crate::oauth` sites anywhere in the crate -- confirmed by repo-wide grep) -- foundation
 * laid for a browser-open + copy-paste fallback that was never wired in. Ported faithfully
 * per the manifest (`coding-agent/oauth`, port unit) since bug-for-bug parity covers unwired
 * code too (RULEBOOK §4 "what this port does not do": oracle's own extensions.rs is similarly unwired and ported
 * as-is).
 *
 * Security note -- deliberate NON-bug-for-bug deviation: oracle's `random_token` (oauth.rs:183-
 * 205) seeds a hand-rolled linear-congruential generator from wall-clock time + pid, by its own
 * admission "not cryptographic-grade... sufficient for CSRF state in a localhost-only flow".
 * RULEBOOK's phase-7 fix to `packages/ai/src/utils/oauth/anthropic.ts` established that this
 * codebase's OAuth CSRF state/PKCE material must come from a real CSRF-safe source (that file's
 * `state = randomBytes(16).toString("hex")`, cited inline there as fixing an oracle-adjacent PKCE
 * weakness) -- replicating oracle's weaker generator here would be exactly the kind of regression
 * that fix forbids. `randomToken` below keeps oracle's exact output shape (requested length, same
 * alphabet) so `authorize_url_includes_pkce_and_state`-equivalent assertions still hold, but draws
 * entropy from `node:crypto.randomBytes` via rejection sampling instead.
 */

import { createHash, randomBytes } from "node:crypto";
import { type Server, STATUS_CODES } from "node:http";
import { type SelectCase, selectN } from "@pie/agent-core";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { formatDurationDebug } from "./duration-format.ts";

/** pie: oauth.rs:26-32 (`struct Flow`). */
export interface FlowOptions {
	authorizeUrl: string;
	tokenUrl: string;
	clientId: string;
	scopes: string[];
	redirectPort: number;
}

/** pie: oauth.rs:34-42 (`struct Authorization`). */
export interface Authorization {
	/** URL the user must open in a browser to start the flow. */
	url: string;
	/** PKCE verifier -- keep this private until the token exchange. */
	verifier: string;
	/** CSRF state token -- assert it matches when the callback arrives. */
	state: string;
}

/** pie: oauth.rs:44-54 (`struct TokenResponse`). Wire shape parsed directly from the token
 * endpoint's JSON response -- field names are the literal wire names, not camelCased. */
export interface TokenResponse {
	access_token: string;
	refresh_token?: string;
	/** Lifetime in seconds from now. */
	expires_in?: number;
	scope?: string;
}

/**
 * Runtime shape of the token endpoint's JSON body, mirroring oracle's `#[derive(Deserialize)]
 * struct TokenResponse` (pie: oauth.rs:44-54) field for field. oracle parses with
 * `serde_json::from_str::<TokenResponse>(&text)?` (oauth.rs:153 for refresh, :178 for exchange),
 * which is a *checked* conversion, not a type assertion: `access_token: String` is a required
 * field, so a provider that answers HTTP 200 with `{"error":"invalid_grant"}` is an `Err` in
 * oracle, never a `TokenResponse` whose `access_token` is missing. A plain
 * `JSON.parse(text) as TokenResponse` erases that check at runtime and lets `undefined` flow into
 * the auth store, so the validation is reproduced here (RULEBOOK §1: typebox for schema checks --
 * same `Type`/`Compile` usage as `mcp-loader.ts`).
 *
 * Details taken from the serde attributes: the three `#[serde(default)] Option<_>` fields accept
 * absent *or* JSON `null` (both -> `None`); unknown fields are ignored (no `deny_unknown_fields`);
 * `expires_in` is an `i64`, so a fractional number is rejected.
 */
const TokenResponseSchema = Type.Object({
	access_token: Type.String(),
	refresh_token: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	expires_in: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
	scope: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const validateTokenResponse = Compile(TokenResponseSchema);

/** Per-field expectations, kept in lockstep with `TokenResponseSchema` so a rejected body can be
 * reported with serde's own wording. `expected` strings are serde's (`a string` for `String`,
 * `i64` for the integer). */
const TOKEN_RESPONSE_FIELDS: ReadonlyArray<{
	readonly name: "access_token" | "refresh_token" | "expires_in" | "scope";
	readonly expected: string;
	readonly accepts: (value: unknown) => boolean;
}> = [
	{ name: "access_token", expected: "a string", accepts: (v) => typeof v === "string" },
	{ name: "refresh_token", expected: "a string", accepts: (v) => typeof v === "string" || v === null },
	{ name: "expires_in", expected: "i64", accepts: (v) => Number.isInteger(v) || v === null },
	{ name: "scope", expected: "a string", accepts: (v) => typeof v === "string" || v === null },
];

/** serde's rendering of an unexpected JSON value (``integer `5` ``, `string "x"`, `null`, `map`,
 * `sequence`), used to build `invalid type: ...` messages of serde's shape. */
function serdeValueLabel(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "sequence";
	switch (typeof value) {
		case "string":
			return `string ${JSON.stringify(value)}`;
		case "number":
			return Number.isInteger(value) ? `integer \`${value}\`` : `floating point \`${value}\``;
		case "boolean":
			return `boolean \`${value}\``;
		default:
			return "map";
	}
}

/**
 * The error oracle's `serde_json::from_str::<TokenResponse>` would produce for `value` -- notably
 * ``missing field `access_token` `` for a body that carries no token at all (pie: oauth.rs:46,
 * :153, :178). serde_json additionally appends ` at line L column C`, which has no analog here
 * (this parses an already-decoded value, not the raw byte stream), so the position suffix is the
 * one part of the message deliberately not reproduced.
 */
function tokenResponseError(value: unknown): Error {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return new Error(`invalid type: ${serdeValueLabel(value)}, expected struct TokenResponse`);
	}
	const record = value as Record<string, unknown>;
	for (const field of TOKEN_RESPONSE_FIELDS) {
		const fieldValue = record[field.name];
		if (fieldValue === undefined) {
			// Only `access_token` is required; the other three are `#[serde(default)]`.
			if (field.name === "access_token") return new Error("missing field `access_token`");
			continue;
		}
		if (!field.accepts(fieldValue)) {
			return new Error(`invalid type: ${serdeValueLabel(fieldValue)}, expected ${field.expected}`);
		}
	}
	// Unreachable while the table above stays in lockstep with `TokenResponseSchema`; kept so a
	// future schema field that has no table entry still fails loudly instead of parsing through.
	return new Error("invalid token endpoint response: does not match struct TokenResponse");
}

/**
 * pie: oauth.rs:153 / :178 (`let parsed: TokenResponse = serde_json::from_str(&text)?`). Throws
 * (rather than returning an under-typed object) whenever oracle's deserialize would `Err`. The
 * returned object carries exactly the struct's four fields: unknown wire fields are dropped and
 * JSON `null` collapses to absent, both matching serde's treatment of `TokenResponse`.
 *
 * Body text that isn't JSON at all fails one step earlier, as `JSON.parse`'s own `SyntaxError`
 * (oracle's equivalent is serde_json's `expected value at line L column C`) -- same "the exchange
 * failed" outcome, different message wording, since the raw-byte position is the platform's to
 * report here.
 */
function parseTokenResponse(text: string): TokenResponse {
	const parsed: unknown = JSON.parse(text);
	if (!validateTokenResponse.Check(parsed)) {
		throw tokenResponseError(parsed);
	}
	const body = parsed as Static<typeof TokenResponseSchema>;
	return {
		access_token: body.access_token,
		...(typeof body.refresh_token === "string" ? { refresh_token: body.refresh_token } : {}),
		...(typeof body.expires_in === "number" ? { expires_in: body.expires_in } : {}),
		...(typeof body.scope === "string" ? { scope: body.scope } : {}),
	};
}

const TOKEN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * pie: oauth.rs:183-205 (`random_token`), entropy source swapped -- see module doc security
 * note. Same output contract as oracle: `len` characters drawn from `TOKEN_ALPHABET`.
 * Rejection sampling (rather than `byte % alphabet.length`) avoids modulo bias.
 */
function randomToken(len: number): string {
	const alphabetLen = TOKEN_ALPHABET.length;
	const limit = Math.floor(256 / alphabetLen) * alphabetLen;
	let out = "";
	while (out.length < len) {
		const bytes = randomBytes(len);
		for (const byte of bytes) {
			if (out.length >= len) break;
			if (byte < limit) {
				out += TOKEN_ALPHABET[byte % alphabetLen];
			}
		}
	}
	return out;
}

/** pie: oauth.rs:207-212 (`sha256_base64url`). */
function sha256Base64Url(s: string): string {
	return createHash("sha256").update(s, "utf8").digest().toString("base64url");
}

/** pie: oauth.rs:234-244 (`urlencode`). Percent-encodes everything outside RFC 3986 unreserved
 * (`A-Za-z0-9-_.~`) -- deliberately narrower than `encodeURIComponent`, which additionally
 * leaves `!*'()` unescaped. */
function urlencode(s: string): string {
	let out = "";
	for (const byte of Buffer.from(s, "utf8")) {
		const ch = String.fromCharCode(byte);
		if (/[A-Za-z0-9\-_.~]/.test(ch)) {
			out += ch;
		} else {
			out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
		}
	}
	return out;
}

/** pie: oauth.rs:246-266 (`urldecode`). */
function urldecode(s: string): string {
	const out: number[] = [];
	let i = 0;
	while (i < s.length) {
		if (s[i] === "%" && i + 2 < s.length) {
			const hex = s.slice(i + 1, i + 3);
			if (/^[0-9a-fA-F]{2}$/.test(hex)) {
				out.push(Number.parseInt(hex, 16));
				i += 3;
				continue;
			}
		}
		if (s[i] === "+") {
			out.push(0x20);
		} else {
			out.push(s.charCodeAt(i));
		}
		i += 1;
	}
	return Buffer.from(out).toString("utf8");
}

/** The two query parameters oracle pulls out of the redirect (`oauth.rs:214-232` returns
 * `(Option<String>, Option<String>)`); either may be absent on a failed/garbled callback. */
interface CallbackQuery {
	code?: string;
	state?: string;
}

/** pie: oauth.rs:214-232 (`parse_callback_query`). */
function parseCallbackQuery(path: string): CallbackQuery {
	const qpos = path.indexOf("?");
	if (qpos === -1) return {};
	let code: string | undefined;
	let state: string | undefined;
	for (const pair of path.slice(qpos + 1).split("&")) {
		const eq = pair.indexOf("=");
		if (eq === -1) continue;
		const k = pair.slice(0, eq);
		const v = urldecode(pair.slice(eq + 1));
		if (k === "code") code = v;
		else if (k === "state") state = v;
	}
	return { code, state };
}

/**
 * `reqwest::StatusCode`'s `Display`, which oracle interpolates as `{status}` into both non-2xx
 * messages (pie: oauth.rs:145-151 for refresh, :170-176 for exchange). `reqwest::StatusCode` is a
 * re-export of `http::StatusCode`, and http 1.5.0 -- the version pinned in oracle's `Cargo.lock`
 * -- formats it as `"{code} {reason}"`, falling back to the literal `<unknown status code>` when
 * the code has no canonical reason phrase (`http-1.5.0/src/status.rs:219-228`). So oracle's line
 * reads `token endpoint 400 Bad Request: ...`, never `token endpoint 400: ...`.
 *
 * Node's `http.STATUS_CODES` is the same table as the crate's `canonical_reason` for 60 of its 62
 * entries, so it is used directly rather than hand-copying the table; the three mechanically
 * diffed exceptions are pinned below. 203/418 are spelled differently by the crate, and 509 is a
 * code Node knows (`Bandwidth Limit Exceeded`) but the crate does not have at all -- oracle prints
 * `<unknown status code>` for it, so it must not pick up Node's phrase.
 */
const STATUS_REASON_OVERRIDES: ReadonlyMap<number, string> = new Map([
	[203, "Non Authoritative Information"],
	[418, "I'm a teapot"],
]);
const STATUS_WITHOUT_CANONICAL_REASON: ReadonlySet<number> = new Set([509]);

function formatStatusCode(status: number): string {
	const reason =
		STATUS_REASON_OVERRIDES.get(status) ??
		(STATUS_WITHOUT_CANONICAL_REASON.has(status) ? undefined : STATUS_CODES[status]);
	return `${status} ${reason ?? "<unknown status code>"}`;
}

/**
 * Rust's `Duration` `Debug` rendering, which oracle interpolates into the callback timeout message
 * (`oauth.rs:123`: `"OAuth callback timed out after {timeout:?}"`). `Debug` picks the largest unit
 * that yields a value >= 1 -- `120s`, `1.5s`, `100ms`, `250µs`, `7ns` -- prints the fractional part
 * without trailing zeros, and renders a zero duration as `0ns`. The TS side carries the timeout as
 * a plain millisecond number, so the formatting happens here instead of in the type.
 */
// Implementation moved to `./duration-format.ts` and imported above: `lsp.rs:256` needs the same
// `Duration`-Debug rendering, and two copies of a user-visible string format drift silently.

/**
 * pie: oauth.rs:89-91 -- `TcpListener::bind(("127.0.0.1", port)).await.with_context(|| format!(
 * "bind 127.0.0.1:{port}"))?`. Bind failures (EADDRINUSE when the redirect port is already taken,
 * EACCES on a privileged port) are their own error class in oracle: they carry the
 * `bind 127.0.0.1:{port}` context and are NOT the `OAuth callback read failed: {e}` wrapper, which
 * oracle applies only to the post-bind accept/read block (oauth.rs:124). RULEBOOK §2.4 maps
 * `anyhow::Context` to `new Error(msg, { cause })`, so the OS-level detail stays reachable on
 * `.cause` exactly as anyhow keeps it as the error's source.
 */
function bindCallbackServer(server: Server, port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error): void => {
			reject(new Error(`bind 127.0.0.1:${port}`, { cause: error }));
		};
		server.once("error", onError);
		server.listen(port, "127.0.0.1", () => {
			server.removeListener("error", onError);
			resolve();
		});
	});
}

/**
 * pie: oauth.rs:121-123 -- the `tokio::time::timeout(timeout, accept)` half of `await_callback`,
 * as a `selectN` branch. RULEBOOK §2.2's `tokio::time::timeout` row, form ② (the awaited thing is
 * a plain Promise, so the race goes through the canonical `selectN` helper): this branch owns a
 * timer and clears it when its own `signal` fires -- i.e. when the callback branch won and
 * `selectN` aborted this loser. A hand-rolled `Promise.race` + `setTimeout` is forbidden there
 * precisely because it leaks the timer and never cancels the loser.
 */
function callbackTimeoutCase(timeoutMs: number): SelectCase<never> {
	return {
		run: (signal) =>
			new Promise<never>((_resolve, reject) => {
				const timer = setTimeout(() => {
					reject(new Error(`OAuth callback timed out after ${formatDurationDebug(timeoutMs)}`));
				}, timeoutMs);
				signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
			}),
	};
}

/** Generic OAuth 2.0 authorization-code + PKCE flow, provider-agnostic. */
export class Flow {
	readonly authorizeUrl: string;
	readonly tokenUrl: string;
	readonly clientId: string;
	readonly scopes: string[];
	readonly redirectPort: number;

	constructor(options: FlowOptions) {
		this.authorizeUrl = options.authorizeUrl;
		this.tokenUrl = options.tokenUrl;
		this.clientId = options.clientId;
		this.scopes = options.scopes;
		this.redirectPort = options.redirectPort;
	}

	/** pie: oauth.rs:57-59 (`redirect_uri`). */
	redirectUri(): string {
		return `http://127.0.0.1:${this.redirectPort}/callback`;
	}

	/**
	 * pie: oauth.rs:62-81 (`authorize_url`). Renamed from oracle's `authorize_url` (a method
	 * name matching the struct's own `authorize_url: String` field, legal in Rust's separate
	 * field/method namespaces but a hard collision for a TS class) to `buildAuthorization`.
	 */
	buildAuthorization(): Authorization {
		const verifier = randomToken(43);
		const challenge = sha256Base64Url(verifier);
		const state = randomToken(24);
		const scope = this.scopes.join(" ");
		const url =
			`${this.authorizeUrl}?response_type=code&client_id=${urlencode(this.clientId)}` +
			`&redirect_uri=${urlencode(this.redirectUri())}&scope=${urlencode(scope)}` +
			`&state=${urlencode(state)}&code_challenge=${urlencode(challenge)}&code_challenge_method=S256`;
		return { url, verifier, state };
	}

	/**
	 * pie: oauth.rs:83-130 (`await_callback`). Binds 127.0.0.1:redirectPort and waits for the
	 * OAuth provider to redirect here, returning the parsed `code` + `state` from the callback's
	 * query string. The browser sees a tiny HTML page confirming success/failure.
	 *
	 * Pragmatic simplification: oracle hand-parses a raw TCP request line via `tokio::net::
	 * TcpListener`. No oracle test exercises `await_callback`'s wire framing (the test module
	 * covers `parse_callback_query`, `urlencode`, `random_token`, `authorize_url` directly, never
	 * a live socket) and this module is unwired dead code in oracle itself -- `node:http` is used
	 * here instead of hand-rolled TCP/HTTP parsing for robustness, with the exact same observable
	 * contract (bind, one GET request, parse `code`/`state`, respond with the literal oracle HTML
	 * strings, close).
	 */
	async awaitCallback(timeoutMs: number): Promise<{ code: string; state: string }> {
		const http = await import("node:http");
		// oracle's `oneshot`-shaped handoff from the request handler to the awaiting caller
		// (RULEBOOK §2.2 maps `oneshot` to `Promise.withResolvers`; the native API needs TS lib
		// "es2024" while this monorepo is on "es2022", so the resolvers are captured inline --
		// same workaround, and same rationale, as `packages/mcp/src/internal/async-utils.ts:30-45`).
		let resolveCallback!: (query: CallbackQuery) => void;
		let rejectCallback!: (error: Error) => void;
		const callbackArrived = new Promise<CallbackQuery>((resolve, reject) => {
			resolveCallback = resolve;
			rejectCallback = reject;
		});
		const server = http.createServer((req, res) => {
			const { code, state } = parseCallbackQuery(req.url ?? "");
			// pie: oauth.rs:107 -- `if code.is_some()`, i.e. the `code` *key* being present decides
			// the page, not the value being non-empty. oracle's `parse_callback_query`
			// (oauth.rs:222-226) splits on the first `=` and stores whatever follows, so `?code=`
			// is `Some("")` -- present, and empty. `code !== undefined` is that same test; a
			// truthiness check would misreport an empty value as a failed login.
			const body =
				code !== undefined
					? "<html><body><h2>pie: login complete</h2><p>You can close this tab.</p></body></html>"
					: "<html><body><h2>pie: login failed</h2></body></html>";
			res.writeHead(200, {
				"Content-Length": String(Buffer.byteLength(body, "utf8")),
				"Content-Type": "text/html",
				Connection: "close",
			});
			res.end(body);
			resolveCallback({ code, state });
		});

		// pie: oauth.rs:89-91 -- bind first, and let a bind failure surface as its own error class
		// (see `bindCallbackServer`). oracle's timeout starts only after the listener exists.
		await bindCallbackServer(server, this.redirectPort);
		try {
			// pie: oauth.rs:124 -- everything that goes wrong *after* the bind, while accepting or
			// reading the callback connection, is `OAuth callback read failed: {e}`.
			server.on("error", (error) => {
				rejectCallback(new Error(`OAuth callback read failed: ${error.message}`));
			});

			// pie: oauth.rs:121-123 -- accept-or-time-out (see `callbackTimeoutCase`).
			const callbackCase: SelectCase<CallbackQuery> = { run: () => callbackArrived };
			const { value } = await selectN<CallbackQuery>([callbackCase, callbackTimeoutCase(timeoutMs)]);
			// pie: oauth.rs:125-128 -- `result.0.ok_or_else(|| anyhow!("callback missing `code`"))?`.
			// `ok_or_else` fires on `None` only, so a present-but-empty `?code=` (`Some("")`) is
			// accepted and returned as `""`; `undefined` here is that same `None`.
			if (value.code === undefined) {
				throw new Error("callback missing `code`");
			}
			if (value.state === undefined) {
				throw new Error("callback missing `state`");
			}
			return { code: value.code, state: value.state };
		} finally {
			server.close();
		}
	}

	/**
	 * pie: oauth.rs:132-155 (`refresh_token`). Exchange a refresh_token for a fresh access
	 * token. Provider-agnostic -- uses `grant_type=refresh_token`.
	 */
	async refreshToken(refreshToken: string): Promise<TokenResponse> {
		return this.postForm(
			{
				grant_type: "refresh_token",
				refresh_token: refreshToken,
				client_id: this.clientId,
			},
			// pie: oauth.rs:148-151 -- the refresh path's own prefix. oracle uses `refresh
			// endpoint {status}` here and `token endpoint {status}` only in `exchange_code`
			// (:173), so a caller/log can tell a failed refresh from a failed first exchange.
			"refresh endpoint",
		);
	}

	/** pie: oauth.rs:157-180 (`exchange_code`). Exchange the auth code + PKCE verifier for an
	 * access token. */
	async exchangeCode(code: string, verifier: string): Promise<TokenResponse> {
		return this.postForm(
			{
				grant_type: "authorization_code",
				code,
				redirect_uri: this.redirectUri(),
				client_id: this.clientId,
				code_verifier: verifier,
			},
			// pie: oauth.rs:173-176.
			"token endpoint",
		);
	}

	/**
	 * Shared body of oracle's `refresh_token`/`exchange_code` (oauth.rs:135-155 / :158-180), which
	 * are line-for-line identical apart from the form fields and the non-2xx message prefix --
	 * hence `endpointLabel`, which must stay per-path (see the call sites' `pie:` notes).
	 */
	private async postForm(
		fields: Record<string, string>,
		endpointLabel: "refresh endpoint" | "token endpoint",
	): Promise<TokenResponse> {
		const response = await fetch(this.tokenUrl, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(fields),
			signal: AbortSignal.timeout(15_000),
		});
		const text = await response.text();
		if (!response.ok) {
			throw new Error(`${endpointLabel} ${formatStatusCode(response.status)}: ${[...text].slice(0, 500).join("")}`);
		}
		return parseTokenResponse(text);
	}
}

/** pie: commands.rs:1968-1994 (`LoginCommand::run`). Result of parsing `/login` argv. */
export type ParsedLoginCommand = { provider: string } | { error: string };

/** pie: commands.rs:1981-1993 -- exact usage/error text, preserved verbatim (including the
 * double space before "(pie"). */
export const LOGIN_USAGE_ERROR = "usage: /login <provider>  (pie will prompt for the API key without echoing it)";

/**
 * Parse `/login` command argv per oracle's `LoginCommand::run` (commands.rs, NOT oauth.rs --
 * login-flow orchestration is split across the two oracle files; this manifest unit's
 * description ("login flow orchestration (rejects inline key) -- pie behavior") calls out this
 * exact policy as the behavior to port/test alongside the PKCE `Flow` helper above). Ported here
 * as a standalone, pure helper -- NOT wired into `core/slash-commands.ts` or
 * `modes/interactive/interactive-mode.ts` (both out of this unit's scope; the existing pi
 * `/login` UI at `interactive-mode.ts:2541-2542` already only recognizes the bare `/login`
 * literal followed by an OAuth-provider *selector* dialog, so it independently already refuses
 * an inline-key argument too -- this helper exists so oracle's underlying policy has its own
 * pinned test rather than relying on that unrelated file's UI flow for coverage).
 *
 * `argv` must be exactly one element (the provider id); anything else -- zero args, or a
 * provider *and* an inline key (`/login anthropic sk-...`) -- is rejected with the oracle usage
 * string. There is no code path that accepts a literal API key on the `/login` command line.
 */
export function parseLoginCommand(argv: string[]): ParsedLoginCommand {
	if (argv.length !== 1) {
		return { error: LOGIN_USAGE_ERROR };
	}
	return { provider: argv[0] };
}
