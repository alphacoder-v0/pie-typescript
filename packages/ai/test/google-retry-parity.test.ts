/**
 * Locks in that google.ts and google-vertex.ts route every request through the shared
 * `sendWithRetry` (crates/ai/src/utils/retry.rs), the way oracle's google.rs:146 and
 * google_vertex.rs:139 route theirs through `send_with_retry`. Before this wiring both providers
 * issued a single bare `fetch` per turn, so a routine 429/503 — the most common Gemini failure —
 * burnt the turn where oracle would have backed off and succeeded.
 *
 * Everything here runs against a real local HTTP server counting real requests (same harness shape
 * as test/anthropic-retry-parity.test.ts and test/user-agent-parity.test.ts): a test that only
 * inspected a config object would pass just as happily against a client that never retries.
 *
 * pie: crates/ai/src/providers/google.rs:146 + crates/ai/src/providers/google_vertex.rs:139 +
 * crates/ai/src/utils/retry.rs
 */
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";
import { streamGoogle } from "../src/providers/google.ts";
import { streamGoogleVertex } from "../src/providers/google-vertex.ts";
import type { AssistantMessage } from "../src/types.ts";

const context = { messages: [{ role: "user" as const, content: "hi", timestamp: Date.now() }] };

interface Attempt {
	status: number;
	headers?: Record<string, string>;
	body?: string;
}

interface StubServer {
	baseUrl: string;
	requestCount: () => number;
	close: () => Promise<void>;
}

/**
 * Replies with `attempts[i]` to the i-th request and with a minimal one-chunk SSE stream to every
 * request past the end of the list.
 */
async function startStubServer(attempts: readonly Attempt[]): Promise<StubServer> {
	let count = 0;
	const server = http.createServer((_req, res) => {
		const attempt = attempts[count];
		count += 1;
		if (attempt) {
			res.writeHead(attempt.status, { "content-type": "application/json", ...attempt.headers });
			res.end(attempt.body ?? JSON.stringify({ error: { message: "transient" } }));
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] })}\n\n`);
		res.end();
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const { port } = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${port}`,
		requestCount: () => count,
		close: async () => {
			server.close();
			await once(server, "close");
		},
	};
}

async function drainGoogle(baseUrl: string, overrides: Record<string, unknown> = {}): Promise<AssistantMessage> {
	const model = { ...getModel("google", "gemini-2.5-flash"), baseUrl };
	return await streamGoogle(model, context, {
		apiKey: "test-key",
		maxRetryDelayMs: 1000,
		...overrides,
	}).result();
}

async function drainVertex(baseUrl: string, overrides: Record<string, unknown> = {}): Promise<AssistantMessage> {
	const model = { ...getModel("google-vertex", "gemini-2.5-flash"), baseUrl };
	return await streamGoogleVertex(model, context, {
		apiKey: "test-key",
		maxRetryDelayMs: 1000,
		...overrides,
	}).result();
}

describe("google retry parity (pie: providers/google.rs:146 send_with_retry)", () => {
	// The core claim: a 429 followed by a 200 must produce TWO requests and a successful turn.
	// Before the wiring this was one request and `stopReason: "error"`.
	it("retries a 429 and succeeds on the second attempt", async () => {
		const server = await startStubServer([{ status: 429 }]);
		try {
			const result = await drainGoogle(server.baseUrl);
			expect(server.requestCount(), "429 must be retried, not surfaced").toBe(2);
			expect(result.stopReason, result.errorMessage).toBe("stop");
			expect(result.content).toEqual([{ type: "text", text: "ok" }]);
		} finally {
			await server.close();
		}
	});

	// pie: retry.rs:139-144 (`is_retryable_status`) — oracle retries 5xx as a whole range, not the
	// SDK's hand-picked 500/502/503/504 list.
	it("retries a 503", async () => {
		const server = await startStubServer([{ status: 503 }]);
		try {
			const result = await drainGoogle(server.baseUrl);
			expect(server.requestCount()).toBe(2);
			expect(result.stopReason, result.errorMessage).toBe("stop");
		} finally {
			await server.close();
		}
	});

	// pie: retry.rs:141-142 — 409 is in oracle's retryable set (local ds4 servers ask the client to
	// replay the full history) but is absent from @google/genai's own
	// `DEFAULT_RETRY_HTTP_STATUS_CODES`, so this case distinguishes oracle's policy from the SDK's.
	it("retries a 409, which the SDK's own retryOptions would not", async () => {
		const server = await startStubServer([{ status: 409 }]);
		try {
			const result = await drainGoogle(server.baseUrl);
			expect(server.requestCount()).toBe(2);
			expect(result.stopReason, result.errorMessage).toBe("stop");
		} finally {
			await server.close();
		}
	});

	// pie: retry.rs:17 (`DEFAULT_MAX_RETRIES = 2`) — initial attempt + 2 retries, then give up.
	it("stops after the oracle default budget of 2 retries", async () => {
		const server = await startStubServer([{ status: 429 }, { status: 429 }, { status: 429 }, { status: 429 }]);
		try {
			const result = await drainGoogle(server.baseUrl);
			expect(server.requestCount(), "1 initial attempt + 2 retries").toBe(3);
			expect(result.stopReason).toBe("error");
		} finally {
			await server.close();
		}
	});

	it("honors an explicit maxRetries of 0 (single shot)", async () => {
		const server = await startStubServer([{ status: 429 }, { status: 429 }]);
		try {
			const result = await drainGoogle(server.baseUrl, { maxRetries: 0 });
			expect(server.requestCount()).toBe(1);
			expect(result.stopReason).toBe("error");
		} finally {
			await server.close();
		}
	});

	// pie: retry.rs:139-144 — 400/401/403 are NOT retryable, and (retry.rs:9) the final response is
	// returned untouched so the caller still sees the provider's own error body. Enabling
	// @google/genai's `httpOptions.retryOptions` would have replaced this body with the bare string
	// "Non-retryable exception Bad Request sending request"; see providers/google-retry.ts.
	it("does not retry a 400 and keeps the provider's error body", async () => {
		const detail = JSON.stringify({ error: { message: "sentinel-bad-request-detail" } });
		const server = await startStubServer([
			{ status: 400, body: detail },
			{ status: 400, body: detail },
		]);
		try {
			const result = await drainGoogle(server.baseUrl);
			expect(server.requestCount(), "400 is terminal").toBe(1);
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage, result.errorMessage).toContain("sentinel-bad-request-detail");
		} finally {
			await server.close();
		}
	});

	// pie: retry.rs:150-158 (`retry_after_ms`) + :91-96 (`DelayTooLong`) — a `Retry-After` longer
	// than the cap fails fast instead of sleeping. @google/genai's own retry never reads the header
	// at all, so this behavior is only reachable through the wiring under test.
	it("fails fast when Retry-After exceeds the cap", async () => {
		const server = await startStubServer([{ status: 429, headers: { "retry-after": "120" } }]);
		try {
			const result = await drainGoogle(server.baseUrl, { maxRetryDelayMs: 1000 });
			expect(server.requestCount(), "no second attempt — the wait was refused").toBe(1);
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage, result.errorMessage).toContain("exceeds cap");
		} finally {
			await server.close();
		}
	});

	// pie: google_vertex.rs:139 — the Vertex path calls the very same `send_with_retry`.
	it("vertex: retries a 429 and succeeds on the second attempt", async () => {
		const server = await startStubServer([{ status: 429 }]);
		try {
			const result = await drainVertex(server.baseUrl);
			expect(server.requestCount()).toBe(2);
			expect(result.stopReason, result.errorMessage).toBe("stop");
			expect(result.content).toEqual([{ type: "text", text: "ok" }]);
		} finally {
			await server.close();
		}
	});

	// The interception point is a @google/genai internal (`private apiCall`). If an SDK bump moves
	// it, `wireOracleRetry` throws at construction rather than silently reverting to no-retry — the
	// failure mode this whole file exists to prevent. This test is the tripwire.
	it("wireOracleRetry throws when the SDK's request entry point is missing", async () => {
		const { wireOracleRetry } = await import("../src/providers/google-retry.ts");
		const notAClient = { apiClient: {} } as unknown as Parameters<typeof wireOracleRetry>[0];
		expect(() => wireOracleRetry(notAClient)).toThrow(/ApiClient#apiCall is missing/);
	});
});
