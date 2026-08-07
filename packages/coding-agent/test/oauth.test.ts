import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { Flow, parseLoginCommand } from "../src/oauth.ts";

// pie: crates/coding-agent/src/oauth.rs `#[cfg(test)] mod tests` -- ported with equivalent
// coverage (test names mirror oracle's where a direct analog exists), plus the login-argv
// policy pinned separately since it actually lives in oracle's commands.rs (see oauth.ts's
// `parseLoginCommand` doc comment).

/**
 * Reserve a genuinely free port by asking the OS for one, rather than guessing.
 *
 * This used to return `20_000 + random(20_000)` and describe it as "unlikely to collide". Under a
 * full parallel run it does collide: `Flow.awaitCallback` then fails to bind, nothing ever listens,
 * and `fetchWhenListening` below polls a dead port for its whole timeout before reporting
 * "callback server never accepted a connection" — a message that blames the fetch for a bind
 * failure and sends the reader to the wrong half of the test.
 *
 * `Flow` needs the port up front (it goes into the redirect URI before anything listens), so the
 * port cannot simply be `0`. Binding a throwaway listener to port 0 and reading back the assigned
 * port leaves only a narrow TOCTOU window instead of a birthday-collision problem.
 */
async function findRedirectPort(): Promise<number> {
	const probe = createServer();
	await new Promise<void>((resolve, reject) => {
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => resolve());
	});
	const address = probe.address();
	if (address === null || typeof address === "string") throw new Error("expected AddressInfo");
	const port = address.port;
	await new Promise<void>((resolve) => probe.close(() => resolve()));
	return port;
}

function flowWithRedirectPort(port: number): Flow {
	return new Flow({
		authorizeUrl: "https://example.com/auth",
		tokenUrl: "https://example.com/token",
		clientId: "cli",
		scopes: [],
		redirectPort: port,
	});
}

/** Runs `run` against a `Flow` whose token endpoint is a throwaway local server using `respond`. */
async function withTokenEndpoint(
	respond: (req: IncomingMessage, res: ServerResponse) => void,
	run: (flow: Flow) => Promise<void>,
): Promise<void> {
	const server = createServer(respond);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("expected AddressInfo");
	try {
		await run(
			new Flow({
				authorizeUrl: "https://example.com/auth",
				tokenUrl: `http://127.0.0.1:${address.port}/token`,
				clientId: "cli",
				scopes: [],
				redirectPort: 9999,
			}),
		);
	} finally {
		server.close();
	}
}

/** Resolves with the rejection reason of `promise`, or `undefined` if it resolved. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => undefined,
		(error: unknown) => error,
	);
}

/**
 * Fetch a callback URL, retrying while the server has not finished binding.
 *
 * These tests previously slept a flat 50ms between starting `awaitCallback` and fetching. That is
 * a race, not a wait: under parallel vitest workers the listen() had not always completed, so the
 * fetch hit a closed port and the test failed with a bare `fetch failed` — a flake that says
 * nothing about the code under test. Polling makes the precondition explicit and the wait as short
 * as it can be.
 */
async function fetchWhenListening(url: string, timeoutMs = 5_000): Promise<Response> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	for (;;) {
		try {
			return await fetch(url);
		} catch (error) {
			lastError = error;
			if (Date.now() >= deadline) break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	throw new Error(`callback server never accepted a connection at ${url}`, { cause: lastError });
}

describe("Flow", () => {
	it("pkce challenge is sha256 base64url (RFC 7636 reference vector)", () => {
		// pie: oauth.rs `pkce_challenge_is_sha256_base64url`
		const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
		const expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
		const actual = createHash("sha256").update(verifier, "utf8").digest().toString("base64url");
		expect(actual).toBe(expected);
	});

	it("authorize_url includes pkce and state", () => {
		// pie: oauth.rs `authorize_url_includes_pkce_and_state`
		const flow = new Flow({
			authorizeUrl: "https://example.com/auth",
			tokenUrl: "https://example.com/token",
			clientId: "cli-123",
			scopes: ["chat", "user"],
			redirectPort: 9999,
		});
		const auth = flow.buildAuthorization();
		expect(auth.url.startsWith("https://example.com/auth?")).toBe(true);
		expect(auth.url).toContain("code_challenge=");
		expect(auth.url).toContain("code_challenge_method=S256");
		expect(auth.url).toContain("client_id=cli-123");
		expect(auth.url).toContain("scope=chat%20user");
		expect(auth.url).toContain(`state=${auth.state}`);
	});

	it("random verifier/state have the requested length and oracle alphabet", () => {
		// pie: oauth.rs `random_token_has_requested_len_and_alphabet` -- entropy source is
		// deliberately NOT ported (see oauth.ts module doc security note), but the output
		// contract (length + alphabet) is pinned exactly like oracle's own test.
		const flow = new Flow({
			authorizeUrl: "https://example.com/auth",
			tokenUrl: "https://example.com/token",
			clientId: "cli",
			scopes: [],
			redirectPort: 9999,
		});
		const auth = flow.buildAuthorization();
		expect(auth.verifier).toHaveLength(43);
		expect(auth.state).toHaveLength(24);
		expect(auth.verifier).toMatch(/^[A-Za-z0-9\-_]{43}$/);
		expect(auth.state).toMatch(/^[A-Za-z0-9\-_]{24}$/);
	});

	it("verifier and state are drawn independently (not equal, not derivable from each other)", () => {
		const flow = new Flow({
			authorizeUrl: "https://example.com/auth",
			tokenUrl: "https://example.com/token",
			clientId: "cli",
			scopes: [],
			redirectPort: 9999,
		});
		const a = flow.buildAuthorization();
		const b = flow.buildAuthorization();
		expect(a.verifier).not.toBe(a.state);
		expect(a.verifier).not.toBe(b.verifier);
		expect(a.state).not.toBe(b.state);
	});

	it("urlencode round trip via the callback query parser", async () => {
		// pie: oauth.rs `urlencode_round_trip` + `parse_callback_extracts_code_and_state` --
		// urlencode/urldecode/parse_callback_query are module-private in both oracle and this
		// port, so they're exercised end to end through awaitCallback's real HTTP callback path
		// instead of importing private helpers directly.
		const port = await findRedirectPort();
		const flow = new Flow({
			authorizeUrl: "https://example.com/auth",
			tokenUrl: "https://example.com/token",
			clientId: "cli",
			scopes: [],
			redirectPort: port,
		});
		const callbackPromise = flow.awaitCallback(5_000);
		const raw = "scope spaces & special=chars";
		const res = await fetchWhenListening(
			`http://127.0.0.1:${port}/callback?code=abc&state=${encodeURIComponent(raw)}`,
		);
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("pie: login complete");

		const { code, state } = await callbackPromise;
		expect(code).toBe("abc");
		expect(state).toBe(raw);
	});

	it("awaitCallback rejects on timeout when nothing connects", async () => {
		const port = await findRedirectPort();
		const flow = new Flow({
			authorizeUrl: "https://example.com/auth",
			tokenUrl: "https://example.com/token",
			clientId: "cli",
			scopes: [],
			redirectPort: port,
		});
		await expect(flow.awaitCallback(100)).rejects.toThrow(/timed out/);
	});

	it("exchangeCode posts the expected form fields and parses the token response", async () => {
		const { createServer } = await import("node:http");
		let receivedBody = "";
		let receivedContentType: string | undefined;
		const server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			receivedContentType = req.headers["content-type"];
			req.on("data", (c) => chunks.push(c));
			req.on("end", () => {
				receivedBody = Buffer.concat(chunks).toString("utf8");
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ access_token: "tok-123", refresh_token: "rtok-1", expires_in: 3600 }));
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("expected AddressInfo");

		try {
			const flow = new Flow({
				authorizeUrl: "https://example.com/auth",
				tokenUrl: `http://127.0.0.1:${address.port}/token`,
				clientId: "cli-abc",
				scopes: [],
				redirectPort: 9999,
			});
			const result = await flow.exchangeCode("the-code", "the-verifier");
			expect(result).toEqual({ access_token: "tok-123", refresh_token: "rtok-1", expires_in: 3600 });
			expect(receivedContentType).toBe("application/x-www-form-urlencoded");
			const params = new URLSearchParams(receivedBody);
			expect(params.get("grant_type")).toBe("authorization_code");
			expect(params.get("code")).toBe("the-code");
			expect(params.get("code_verifier")).toBe("the-verifier");
			expect(params.get("client_id")).toBe("cli-abc");
			expect(params.get("redirect_uri")).toBe("http://127.0.0.1:9999/callback");
		} finally {
			server.close();
		}
	});

	it("refreshToken posts grant_type=refresh_token", async () => {
		const { createServer } = await import("node:http");
		let receivedBody = "";
		const server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (c) => chunks.push(c));
			req.on("end", () => {
				receivedBody = Buffer.concat(chunks).toString("utf8");
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ access_token: "fresh-tok" }));
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("expected AddressInfo");

		try {
			const flow = new Flow({
				authorizeUrl: "https://example.com/auth",
				tokenUrl: `http://127.0.0.1:${address.port}/token`,
				clientId: "cli-abc",
				scopes: [],
				redirectPort: 9999,
			});
			const result = await flow.refreshToken("old-refresh");
			expect(result.access_token).toBe("fresh-tok");
			const params = new URLSearchParams(receivedBody);
			expect(params.get("grant_type")).toBe("refresh_token");
			expect(params.get("refresh_token")).toBe("old-refresh");
		} finally {
			server.close();
		}
	});

	it("exchangeCode surfaces a truncated error body on non-2xx status", async () => {
		const { createServer } = await import("node:http");
		const longError = "x".repeat(600);
		const server = createServer((_req, res) => {
			res.writeHead(400, { "Content-Type": "text/plain" });
			res.end(longError);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("expected AddressInfo");

		try {
			const flow = new Flow({
				authorizeUrl: "https://example.com/auth",
				tokenUrl: `http://127.0.0.1:${address.port}/token`,
				clientId: "cli",
				scopes: [],
				redirectPort: 9999,
			});
			// `400 Bad Request`, not `400`: oracle interpolates `{status}`, a `reqwest::StatusCode`,
			// whose `Display` is `"{code} {canonical_reason}"` (http-1.5.0/src/status.rs:219-228 --
			// the version in oracle's Cargo.lock). pie: oauth.rs:173-176.
			await expect(flow.exchangeCode("c", "v")).rejects.toThrow(/token endpoint 400 Bad Request:/);
		} finally {
			server.close();
		}
	});

	it("renders the status the way `reqwest::StatusCode`'s Display does", async () => {
		// pie: oauth.rs:148-151 / :173-176 (`{status}`) + http-1.5.0/src/status.rs:219-228:
		// `"{code} {reason}"`, with the literal `<unknown status code>` when the code has no
		// canonical reason. 509 is the interesting case -- Node's `http.STATUS_CODES` has a phrase
		// for it ("Bandwidth Limit Exceeded") but the http crate's table does not contain 509 at
		// all, so oracle prints the fallback.
		for (const [status, expected] of [
			[401, "401 Unauthorized"],
			[429, "429 Too Many Requests"],
			[509, "509 <unknown status code>"],
			[599, "599 <unknown status code>"],
		] as const) {
			await withTokenEndpoint(
				(_req, res) => {
					res.writeHead(status, { "Content-Type": "text/plain" });
					res.end("boom");
				},
				async (flow) => {
					const error = await rejectionOf(flow.exchangeCode("c", "v"));
					expect((error as Error).message).toBe(`token endpoint ${expected}: boom`);
				},
			);
		}
	});

	it("refreshToken's non-2xx error names the refresh endpoint, not the token endpoint", async () => {
		// pie: oauth.rs:148-151 (`anyhow!("refresh endpoint {status}: ...")`) vs oauth.rs:173-176
		// (`"token endpoint {status}: ..."`). The two paths share everything except the form
		// fields and this prefix, and the prefix is how a caller/log tells a failed refresh from a
		// failed first code exchange.
		await withTokenEndpoint(
			(_req, res) => {
				res.writeHead(400, { "Content-Type": "text/plain" });
				res.end("nope");
			},
			async (flow) => {
				const refreshError = await rejectionOf(flow.refreshToken("old-refresh"));
				expect((refreshError as Error).message).toBe("refresh endpoint 400 Bad Request: nope");
				const exchangeError = await rejectionOf(flow.exchangeCode("c", "v"));
				expect((exchangeError as Error).message).toBe("token endpoint 400 Bad Request: nope");
			},
		);
	});

	it("rejects a 200 token response that carries no access_token", async () => {
		// pie: oauth.rs:153/:178 -- `serde_json::from_str::<TokenResponse>(&text)?` over a struct
		// whose `access_token: String` (oauth.rs:46) is required, so an endpoint that answers HTTP
		// 200 with an error envelope is an `Err` in oracle ("missing field `access_token`"), never
		// a TokenResponse whose token is undefined. Both paths parse, so both must reject.
		await withTokenEndpoint(
			(_req, res) => {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "invalid_grant" }));
			},
			async (flow) => {
				await expect(flow.exchangeCode("c", "v")).rejects.toThrow("missing field `access_token`");
				await expect(flow.refreshToken("old-refresh")).rejects.toThrow("missing field `access_token`");
			},
		);
	});

	it("rejects a token response whose access_token is not a string", async () => {
		// pie: oauth.rs:46 -- `access_token: String`; serde reports a type mismatch rather than
		// coercing.
		await withTokenEndpoint(
			(_req, res) => {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ access_token: 123 }));
			},
			async (flow) => {
				const error = await rejectionOf(flow.exchangeCode("c", "v"));
				expect((error as Error).message).toBe("invalid type: integer `123`, expected a string");
			},
		);
	});

	it("rejects a token response that is not a JSON object", async () => {
		// pie: oauth.rs:44-54 -- deserializing into the struct, not into an arbitrary JSON value.
		await withTokenEndpoint(
			(_req, res) => {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify("hello"));
			},
			async (flow) => {
				const error = await rejectionOf(flow.exchangeCode("c", "v"));
				expect((error as Error).message).toBe('invalid type: string "hello", expected struct TokenResponse');
			},
		);
	});

	it("accepts serde's optional shapes: null optionals and unknown wire fields", async () => {
		// pie: oauth.rs:47-53 -- the three optional fields are `#[serde(default)] Option<_>`, so
		// absent and JSON `null` both mean `None`; the struct has no `deny_unknown_fields`, so
		// extra wire fields are ignored (and, being outside the struct, are not carried along).
		await withTokenEndpoint(
			(_req, res) => {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						access_token: "tok",
						refresh_token: null,
						expires_in: null,
						scope: null,
						token_type: "Bearer",
					}),
				);
			},
			async (flow) => {
				const result = await flow.exchangeCode("c", "v");
				expect(result).toEqual({ access_token: "tok" });
				expect(Object.keys(result)).toEqual(["access_token"]);
			},
		);
	});

	it("timeout message renders the duration like Rust's `Duration` Debug", async () => {
		// pie: oauth.rs:123 -- `anyhow!("OAuth callback timed out after {timeout:?}")`. `Duration`'s
		// Debug picks the largest unit >= 1 and drops trailing zeros: `100ms`, `1.2s`, `120s` --
		// never `1200ms` and never a raw millisecond count.
		const shortError = await rejectionOf(flowWithRedirectPort(await findRedirectPort()).awaitCallback(100));
		expect((shortError as Error).message).toBe("OAuth callback timed out after 100ms");
		const longError = await rejectionOf(flowWithRedirectPort(await findRedirectPort()).awaitCallback(1_200));
		expect((longError as Error).message).toBe("OAuth callback timed out after 1.2s");
	});

	it("treats a present-but-empty `?code=` as a value, not as a missing parameter", async () => {
		// pie: oauth.rs:222-226 -- `parse_callback_query` splits on the first `=` and stores the
		// rest, so `?code=&state=x` yields `(Some(""), Some("x"))`. oracle therefore serves the
		// "login complete" page (oauth.rs:107, `if code.is_some()`) and returns `Ok(("", "x"))`
		// (oauth.rs:125-128, `ok_or_else` fires on `None` only).
		const port = await findRedirectPort();
		const callbackPromise = flowWithRedirectPort(port).awaitCallback(5_000);
		const res = await fetchWhenListening(`http://127.0.0.1:${port}/callback?code=&state=x`);
		expect(await res.text()).toContain("pie: login complete");
		await expect(callbackPromise).resolves.toEqual({ code: "", state: "x" });
	});

	it("still rejects when the `code` key is absent altogether", async () => {
		// The other half of oracle's `Option`: no `code` key at all is `None` -> "login failed"
		// page (oauth.rs:110) + `callback missing \`code\`` (oauth.rs:125).
		const port = await findRedirectPort();
		// `rejectionOf` attaches its handler now: the rejection lands while the `fetch` below is
		// still in flight, and an unobserved rejection would be reported as an unhandled error.
		const settled = rejectionOf(flowWithRedirectPort(port).awaitCallback(5_000));
		const res = await fetchWhenListening(`http://127.0.0.1:${port}/callback?state=x`);
		expect(await res.text()).toContain("pie: login failed");
		expect((await settled) as Error).toMatchObject({ message: "callback missing `code`" });
	});

	it("clears the timeout branch's timer once the callback arrives", async () => {
		// RULEBOOK §2.2 `tokio::time::timeout` row: the timeout branch's `run(signal)` must clear
		// its timer when its own signal fires (the losing branch of `selectN`). Without that, a
		// completed login would leave a 30s timer pending on the event loop.
		const port = await findRedirectPort();
		const flow = flowWithRedirectPort(port);
		const setSpy = vi.spyOn(globalThis, "setTimeout");
		const clearSpy = vi.spyOn(globalThis, "clearTimeout");
		try {
			const callbackPromise = flow.awaitCallback(30_000);
			await fetchWhenListening(`http://127.0.0.1:${port}/callback?code=abc&state=xyz`);
			await expect(callbackPromise).resolves.toEqual({ code: "abc", state: "xyz" });

			const index = setSpy.mock.calls.findIndex((args) => args[1] === 30_000);
			expect(index).toBeGreaterThanOrEqual(0);
			const timeoutHandle = setSpy.mock.results[index].value;
			expect(clearSpy.mock.calls.some(([handle]) => handle === timeoutHandle)).toBe(true);
		} finally {
			setSpy.mockRestore();
			clearSpy.mockRestore();
		}
	});

	it("classifies a bind failure as `bind 127.0.0.1:<port>`, not as a callback read failure", async () => {
		// pie: oauth.rs:89-91 -- `TcpListener::bind(...).with_context(|| format!("bind
		// 127.0.0.1:{port}"))?` is its own error class; `OAuth callback read failed: {e}`
		// (oauth.rs:124) covers only what happens *after* a successful bind. RULEBOOK §2.4 maps
		// `anyhow::Context` to `new Error(msg, { cause })`, so the OS error stays on `.cause`.
		const port = await findRedirectPort();
		const blocker = createServer(() => {});
		await new Promise<void>((resolve) => blocker.listen(port, "127.0.0.1", resolve));
		try {
			const error = await rejectionOf(flowWithRedirectPort(port).awaitCallback(5_000));
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toBe(`bind 127.0.0.1:${port}`);
			expect((error as Error).message).not.toContain("OAuth callback read failed");
			expect(((error as Error).cause as NodeJS.ErrnoException).code).toBe("EADDRINUSE");
		} finally {
			blocker.close();
		}
	});
});

describe("parseLoginCommand", () => {
	// pie: crates/coding-agent/src/commands.rs:1981-1993 (`LoginCommand::run`) -- oracle's
	// `/login` slash command rejects everything except exactly one argument (the provider id).
	// There is no accepted form that carries an inline API key on the command line.

	it("accepts exactly one argument as the provider id", () => {
		const result = parseLoginCommand(["anthropic"]);
		expect(result).toEqual({ provider: "anthropic" });
	});

	it("rejects an inline key (`/login <provider> <key>`) with the oracle usage string", () => {
		const result = parseLoginCommand(["anthropic", "sk-ant-inline-secret"]);
		expect(result).toEqual({
			error: "usage: /login <provider>  (pie will prompt for the API key without echoing it)",
		});
		if ("error" in result) {
			expect(result.error).not.toContain("sk-ant-inline-secret");
		}
	});

	it("rejects zero arguments", () => {
		const result = parseLoginCommand([]);
		expect("error" in result).toBe(true);
	});

	it("rejects more than two arguments", () => {
		const result = parseLoginCommand(["anthropic", "sk-key", "extra"]);
		expect("error" in result).toBe(true);
	});
});
