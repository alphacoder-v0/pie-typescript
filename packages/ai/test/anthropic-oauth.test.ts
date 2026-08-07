import { afterEach, describe, expect, it, vi } from "vitest";
import { loginAnthropic, refreshAnthropicToken } from "../src/utils/oauth/anthropic.ts";

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json",
		},
	});
}

function getUrl(input: unknown): string {
	if (typeof input === "string") {
		return input;
	}
	if (input instanceof URL) {
		return input.toString();
	}
	if (input instanceof Request) {
		return input.url;
	}
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

function getJsonBody(init?: RequestInit): Record<string, string> {
	if (typeof init?.body !== "string") {
		throw new Error(`Expected string request body, got ${typeof init?.body}`);
	}
	return JSON.parse(init.body) as Record<string, string>;
}

describe.sequential("Anthropic OAuth", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("keeps the localhost redirect_uri for manual callback login", async () => {
		let authUrl = "";
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			expect(getUrl(input)).toBe("https://platform.claude.com/v1/oauth/token");
			expect(init?.method).toBe("POST");
			const body = getJsonBody(init);
			expect(body.grant_type).toBe("authorization_code");
			expect(body.code).toBe("manual-code");
			expect(body.redirect_uri).toBe("http://localhost:53692/callback");
			return jsonResponse({
				access_token: "access-token",
				refresh_token: "refresh-token",
				expires_in: 3600,
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const credentials = await loginAnthropic({
			onAuth: (info) => {
				authUrl = info.url;
			},
			onPrompt: async () => "",
			onManualCodeInput: async () => {
				const url = new URL(authUrl);
				const state = url.searchParams.get("state");
				const redirectUri = url.searchParams.get("redirect_uri");
				if (!state || !redirectUri) {
					throw new Error("Missing OAuth state or redirect_uri in auth URL");
				}
				return `${redirectUri}?code=manual-code&state=${state}`;
			},
		});

		expect(credentials.access).toBe("access-token");
		expect(credentials.refresh).toBe("refresh-token");
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	// pie: crates/ai/src/utils/oauth/anthropic.rs:148 — oracle generates an independent random CSRF
	// state (Uuid::new_v4()) and never reuses the PKCE verifier for it. Reusing the verifier as state
	// (the pre-2026-08-03 behavior inherited from the pi skeleton) publishes it in the browser-visible
	// authorize URL and the redirect callback, defeating RFC 7636's protection against
	// authorization-code interception.
	it("uses an independent random state, keeping the PKCE verifier out of the browser channel", async () => {
		const authUrls: string[] = [];
		const bodies: Record<string, string>[] = [];
		const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit): Promise<Response> => {
			bodies.push(getJsonBody(init));
			return jsonResponse({ access_token: "a", refresh_token: "r", expires_in: 3600 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const runLogin = async () =>
			loginAnthropic({
				onAuth: (info) => {
					authUrls.push(info.url);
				},
				onPrompt: async () => "",
				onManualCodeInput: async () => {
					const url = new URL(authUrls[authUrls.length - 1]);
					return `${url.searchParams.get("redirect_uri")}?code=c&state=${url.searchParams.get("state")}`;
				},
			});

		await runLogin();
		await runLogin();

		const first = new URL(authUrls[0]);
		const second = new URL(authUrls[1]);
		const state = first.searchParams.get("state");
		const challenge = first.searchParams.get("code_challenge");

		// state is 16 random bytes as hex, regenerated per attempt, and distinct from the PKCE pair.
		expect(state).toMatch(/^[0-9a-f]{32}$/);
		expect(state).not.toBe(second.searchParams.get("state"));
		expect(state).not.toBe(challenge);

		// The verifier never appears in the browser-visible URL — only its S256 challenge does.
		const verifier = bodies[0].code_verifier;
		expect(verifier).toBeTruthy();
		expect(first.toString()).not.toContain(verifier);
		expect(first.searchParams.get("code_verifier")).toBeNull();
		expect(first.searchParams.get("code_challenge_method")).toBe("S256");

		// The verifier does reach the back-channel token exchange, where it belongs.
		expect(bodies[0].grant_type).toBe("authorization_code");
		expect(bodies[0].state).toBe(state);
	});

	// pie: crates/ai/src/utils/oauth/anthropic.rs:34-54 (`build_authorize_url`)。
	// This side previously used `URLSearchParams` and carried an extra `code=true`, three differences
	// in all, every one of them visible in the URL the user sees in their browser: an extra parameter,
	// a different parameter order, and different encoding — form encoding writes a space as `+` and
	// leaves underscores alone, while upstream uses NON_ALPHANUMERIC.
	//
	// The assertions read the **raw query string** rather than `URL.searchParams`, because the latter
	// decodes first, making `+` and `%20`, or `_` and `%5F`, indistinguishable — and the difference
	// invisible.
	it("the authorize URL is byte-for-byte what upstream build_authorize_url produces", async () => {
		let authUrl = "";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ access_token: "a", refresh_token: "r", expires_in: 3600 })),
		);

		await loginAnthropic({
			onAuth: (info) => {
				authUrl = info.url;
			},
			onPrompt: async () => "",
			onManualCodeInput: async () => {
				const url = new URL(authUrl);
				return `${url.searchParams.get("redirect_uri")}?code=c&state=${url.searchParams.get("state")}`;
			},
		});

		const [base, rawQuery] = authUrl.split("?");
		expect(base).toBe("https://claude.ai/oauth/authorize");

		const pairs = rawQuery.split("&").map((p) => p.split("=", 2) as [string, string]);
		// Seven parameters, in upstream's order. `code` is not among them.
		expect(pairs.map(([k]) => k)).toEqual([
			"response_type",
			"client_id",
			"redirect_uri",
			"scope",
			"code_challenge",
			"code_challenge_method",
			"state",
		]);

		const raw = Object.fromEntries(pairs) as Record<string, string>;
		// The fixed values match `utf8_percent_encode(v, NON_ALPHANUMERIC)` byte for byte: hyphens,
		// colons, slashes, underscores and spaces are all encoded.
		expect(raw.response_type).toBe("code");
		expect(raw.client_id).toBe("9d1c250a%2De61b%2D44d9%2D88ed%2D5944d1962f5e");
		expect(raw.redirect_uri).toBe("http%3A%2F%2Flocalhost%3A53692%2Fcallback");
		expect(raw.scope).toBe(
			"org%3Acreate%5Fapi%5Fkey%20user%3Aprofile%20user%3Ainference%20user%3Asessions%3Aclaude%5Fcode%20user%3Amcp%5Fservers%20user%3Afile%5Fupload",
		);
		expect(raw.code_challenge_method).toBe("S256");
		// The random values are checked by shape. Note that the challenge is base64url, whose `-` and `_`
		// **do** get encoded to `%2D` and `%5F` by NON_ALPHANUMERIC — which is exactly where it parts
		// company with form encoding, so the raw form allows only alphanumerics and `%`.
		// (The first version wrote `/^[A-Za-z0-9\-_]+$/`, which passes only when all 43 characters happen
		// to be alphanumeric — about one time in four, an assertion that goes green intermittently.)
		expect(raw.code_challenge).toMatch(/^[A-Za-z0-9%]+$/);
		expect(decodeURIComponent(raw.code_challenge)).toMatch(/^[A-Za-z0-9\-_]{43}$/);
		expect(raw.state).toMatch(/^[0-9a-f]{32}$/);
	});

	// pie: crates/ai/src/utils/oauth/anthropic.rs `parse_callback` / `parse_callback_no_query`
	// Upstream tests `parse_callback_query("/callback?code=..&state=..")` directly. The equivalent
	// logic here lives inside the callback server and is not exported, so this really starts the server
	// and issues one HTTP GET — closer to the real thing than testing an internal function.
	it("a callback carrying code and state lets the login pick that code up", async () => {
		const tokenCalls: Array<Record<string, string>> = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
			tokenCalls.push(JSON.parse(String(init?.body ?? "{}")));
			return new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3600 }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;
		try {
			await loginAnthropic({
				onAuth: (info) => {
					const state = new URL(info.url).searchParams.get("state");
					// This hits the local callback server, taking the very query-parsing path under test.
					void originalFetch(`http://localhost:53692/callback?code=abc123&state=${state}`).catch(() => {});
				},
				onPrompt: async () => "",
			});
		} finally {
			globalThis.fetch = originalFetch;
		}

		expect(tokenCalls).toHaveLength(1);
		expect(tokenCalls[0].code).toBe("abc123");
	}, 30_000);

	// pie: crates/ai/src/utils/oauth/anthropic.rs `parse_callback_no_query`
	// With no query there is neither a code nor a state. The observable consequence is that the
	// callback server **does not settle**, and the login can only proceed through manual entry. So the
	// assertion is that the code exchanged for a token is the manually entered one, not something
	// conjured out of an empty callback.
	//
	// (The first version offered no manual path, so this case simply timed out after 30s. A timeout
	// does show the server did not settle, but that is inferring behavior from a hang rather than
	// asserting it. The form below is decidable.)
	it("a callback with no query is not treated as a successful one", async () => {
		const tokenCalls: Array<Record<string, string>> = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
			tokenCalls.push(JSON.parse(String(init?.body ?? "{}")));
			return new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3600 }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;
		try {
			await loginAnthropic({
				onAuth: (info) => {
					const state = new URL(info.url).searchParams.get("state");
					// Hit the callback once with an **empty** query first: it has to be ignored.
					void originalFetch("http://localhost:53692/callback").catch(() => {});
					void state;
				},
				onPrompt: async () => "",
				onManualCodeInput: async () => "manual-code",
			});
		} finally {
			globalThis.fetch = originalFetch;
		}

		expect(tokenCalls).toHaveLength(1);
		expect(tokenCalls[0].code).toBe("manual-code");
	}, 30_000);

	it("omits scope from refresh token requests", async () => {
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			expect(getUrl(input)).toBe("https://platform.claude.com/v1/oauth/token");
			expect(init?.method).toBe("POST");
			const body = getJsonBody(init);
			expect(body.grant_type).toBe("refresh_token");
			expect(body.client_id).toBeTruthy();
			expect(body.refresh_token).toBe("refresh-token");
			expect(body).not.toHaveProperty("scope");
			return jsonResponse({
				access_token: "new-access-token",
				refresh_token: "new-refresh-token",
				expires_in: 3600,
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const credentials = await refreshAnthropicToken("refresh-token");

		expect(credentials.access).toBe("new-access-token");
		expect(credentials.refresh).toBe("new-refresh-token");
		expect(fetchMock).toHaveBeenCalledOnce();
	});
});
