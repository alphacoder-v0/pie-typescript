/**
 * Vitest port of the 3 Rust unit tests in `crates/ai/src/utils/retry.rs`'s
 * `#[cfg(test)] mod tests`, plus integration coverage for `sendWithRetry` itself (oracle's
 * `send_with_retry`, retry.rs:42-130) exercised against a local HTTP server rather than mocked
 * fixtures, per RULEBOOK guidance for this test kind.
 *
 * Rust test -> vitest test map:
 *   status_codes_categorize       -> "categorizes standard retryable/non-retryable status codes"
 *   conflict_is_retryable         -> "treats 409 (conflict) as retryable"
 *   backoff_grows_and_caps        -> "backoff grows with attempt and is capped"
 */
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
	backoffDelayMs,
	isRetryableStatus,
	RetryDelayTooLongError,
	retryAfterMs,
	sendWithRetry,
} from "../src/utils/retry.ts";

describe("isRetryableStatus", () => {
	// pie: crates/ai/src/utils/retry.rs:174-185 (status_codes_categorize)
	it("categorizes standard retryable/non-retryable status codes", () => {
		expect(isRetryableStatus(429)).toBe(true);
		expect(isRetryableStatus(500)).toBe(true);
		expect(isRetryableStatus(502)).toBe(true);
		expect(isRetryableStatus(400)).toBe(false);
		expect(isRetryableStatus(401)).toBe(false);
		expect(isRetryableStatus(403)).toBe(false);
		expect(isRetryableStatus(200)).toBe(false);
	});

	// pie: crates/ai/src/utils/retry.rs:187-193 (conflict_is_retryable)
	it("treats 409 (conflict) as retryable", () => {
		// Local inference servers (e.g. ds4) return 409 when live continuation state was evicted;
		// the documented recovery is to replay the full history, which is exactly what resending
		// the same request does.
		expect(isRetryableStatus(409)).toBe(true);
	});

	// pie: crates/ai/src/utils/retry.rs:143 — the one member of the retryable set oracle's own
	// Rust test suite never separately names, but the implementation includes: 425 (Too Early).
	// Notably, the OpenAI SDK's own default `shouldRetry` (node_modules/openai/client.js) already
	// retries 408/409/429/5xx but NOT 425 — this is the one real remaining gap between the SDK's
	// built-in retry and oracle's retry set. (The skeleton has no retry at the provider layer; the
	// whole utility is an addition here — RULEBOOK §1, revised 2026-08-03.)
	it("treats 425 (too early) as retryable", () => {
		expect(isRetryableStatus(425)).toBe(true);
	});

	it("does not retry 404/422/301 (non-retryable) codes, but does retry 408", () => {
		expect(isRetryableStatus(408)).toBe(true);
		expect(isRetryableStatus(404)).toBe(false);
		expect(isRetryableStatus(422)).toBe(false);
		expect(isRetryableStatus(301)).toBe(false);
	});
});

describe("backoffDelayMs", () => {
	// pie: crates/ai/src/utils/retry.rs:196-202 (backoff_grows_and_caps)
	it("backoff grows with attempt and is capped", () => {
		const d0 = backoffDelayMs(0, 0, 60_000);
		const d3 = backoffDelayMs(3, 0, 60_000);
		expect(d0).toBeLessThan(d3);

		const capped = backoffDelayMs(10, 0, 5_000);
		expect(capped).toBeLessThanOrEqual(5_000);
	});

	it("uses the server-provided delay (clamped to the cap) when present", () => {
		expect(backoffDelayMs(0, 2_000, 60_000)).toBe(2_000);
		expect(backoffDelayMs(0, 100_000, 5_000)).toBe(5_000);
	});
});

describe("retryAfterMs", () => {
	it("parses a numeric (seconds) Retry-After header", () => {
		const response = new Response(null, { headers: { "retry-after": "3" } });
		expect(retryAfterMs(response)).toBe(3000);
	});

	it("returns undefined for an HTTP-date Retry-After header (unsupported, matches oracle)", () => {
		// pie: crates/ai/src/utils/retry.rs:156-157 — "HTTP-date form is uncommon for LLM
		// providers; skip."
		const response = new Response(null, { headers: { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" } });
		expect(retryAfterMs(response)).toBeUndefined();
	});

	it("returns undefined when the header is absent", () => {
		expect(retryAfterMs(new Response(null))).toBeUndefined();
	});
});

interface RetryTestServer {
	port: number;
	requestCount: () => number;
	close: () => Promise<void>;
}

async function startServer(
	handler: (req: http.IncomingMessage, res: http.ServerResponse, requestIndex: number) => void,
): Promise<RetryTestServer> {
	let count = 0;
	const server = http.createServer((req, res) => {
		count += 1;
		handler(req, res, count - 1);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const { port } = server.address() as AddressInfo;
	return {
		port,
		requestCount: () => count,
		close: () => new Promise((resolve) => server.close(() => resolve())),
	};
}

describe("sendWithRetry", () => {
	it("retries a 409 once and returns the eventual 200 (ds4 replay-the-full-history scenario)", async () => {
		const server = await startServer((_req, res, i) => {
			if (i === 0) {
				res.writeHead(409, { "content-type": "text/plain" }).end("conflict");
				return;
			}
			res.writeHead(200, { "content-type": "text/plain" }).end("ok");
		});
		try {
			const response = await sendWithRetry(
				() => fetch(`http://127.0.0.1:${server.port}/v1/responses`, { method: "POST", body: "{}" }),
				{ maxRetries: 2, maxRetryDelayMs: 1000 },
			);
			expect(response.status).toBe(200);
			expect(await response.text()).toBe("ok");
			expect(server.requestCount()).toBe(2);
		} finally {
			await server.close();
		}
	});

	it("returns a non-retryable status (e.g. 400) untouched on the first attempt", async () => {
		const server = await startServer((_req, res) => {
			res.writeHead(400, { "content-type": "text/plain" }).end("bad request");
		});
		try {
			const response = await sendWithRetry(() => fetch(`http://127.0.0.1:${server.port}/v1/responses`), {
				maxRetries: 2,
			});
			expect(response.status).toBe(400);
			expect(server.requestCount()).toBe(1);
		} finally {
			await server.close();
		}
	});

	it("gives up and returns the final retryable-status response once maxRetries is exhausted", async () => {
		const server = await startServer((_req, res) => {
			res.writeHead(429, { "content-type": "text/plain" }).end("rate limited");
		});
		try {
			const response = await sendWithRetry(() => fetch(`http://127.0.0.1:${server.port}/v1/responses`), {
				maxRetries: 1,
				maxRetryDelayMs: 200,
			});
			expect(response.status).toBe(429);
			// Initial attempt + 1 retry = 2 requests total, then give up.
			expect(server.requestCount()).toBe(2);
		} finally {
			await server.close();
		}
	});

	// pie: crates/ai/src/utils/retry.rs:91-96 (RetrySendError::DelayTooLong)
	it("throws RetryDelayTooLongError instead of waiting when Retry-After exceeds the cap", async () => {
		const server = await startServer((_req, res) => {
			res.writeHead(429, { "content-type": "text/plain", "retry-after": "120" }).end("rate limited");
		});
		try {
			await expect(
				sendWithRetry(() => fetch(`http://127.0.0.1:${server.port}/v1/responses`), {
					maxRetries: 2,
					maxRetryDelayMs: 1000, // 1s cap, server asked for 120s
				}),
			).rejects.toBeInstanceOf(RetryDelayTooLongError);
			expect(server.requestCount()).toBe(1);
		} finally {
			await server.close();
		}
	});

	it("aborts promptly via AbortSignal instead of completing the retry backoff", async () => {
		const server = await startServer((_req, res) => {
			res.writeHead(429, { "content-type": "text/plain" }).end("rate limited");
		});
		try {
			const controller = new AbortController();
			const promise = sendWithRetry(
				() => fetch(`http://127.0.0.1:${server.port}/v1/responses`, { signal: controller.signal }),
				{ maxRetries: 5, maxRetryDelayMs: 60_000, signal: controller.signal },
			);
			// Let the first (retryable) response land, then abort during the backoff sleep.
			await new Promise((resolve) => setTimeout(resolve, 20));
			controller.abort();
			// pie: crates/ai/src/utils/retry.rs — the rejection must be the abort signal itself (an
			// Abort-class error), not merely "some" error; otherwise a bug that swallowed the abort and
			// rethrew a different failure (e.g. from a stray retry attempt) would still pass a bare
			// `.rejects.toThrow()`.
			await expect(promise).rejects.toMatchObject({
				name: "AbortError",
				message: expect.stringContaining("aborted"),
			});
		} finally {
			await server.close();
		}
	});
});
