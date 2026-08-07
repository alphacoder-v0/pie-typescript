/**
 * Wires the shared `sendWithRetry` (pie: crates/ai/src/utils/retry.rs) into a `@google/genai`
 * client, so the two Gemini-family providers retry exactly like oracle's `send_with_retry` —
 * which `google.rs:146` and `google_vertex.rs:139` route **every** request through.
 *
 * Why not `httpOptions.retryOptions` (present in the pinned @google/genai 1.52.0): it expresses
 * `attempts` and nothing else (`HttpRetryOptions` has exactly one field), and turning it on is a
 * net regression here. `ApiClient#apiCall` (dist/node/index.mjs:13304-13324 in 1.52.0)
 * short-circuits to `pRetry` and:
 *   1. retries only 408/429/500/502/503/504 (`DEFAULT_RETRY_HTTP_STATUS_CODES`) — oracle retries
 *      408/409/425/429 **and all** 5xx (retry.rs:139-144); 409 in particular is load-bearing (local
 *      ds4 servers ask for a full-history replay, which a plain resend is),
 *   2. backs off on p-retry's own curve (1s base, factor 2, no jitter, no cap) instead of oracle's
 *      `500ms << attempt` + 1..100ms jitter capped at `max_retry_delay_ms` (retry.rs:160-168),
 *   3. never reads `Retry-After`, so oracle's server-delay honoring and its `DelayTooLong`
 *      fail-fast (retry.rs:91-96) are both unreachable,
 *   4. **throws instead of returning the response** — on a retryable status it raises
 *      `Retryable HTTP Error: <statusText>`, on any other non-2xx an `AbortError`, and both escape
 *      *before* the SDK's `throwErrorIfNotOK` can build the `ApiError` carrying the provider's error
 *      body. Oracle deliberately returns the final response untouched ("On non-retryable status
 *      (e.g. 400/401/403) we return the response untouched", retry.rs:9) so the caller can print
 *      `HTTP {status}: {body}` (google.rs:155-166). Enabling `retryOptions` would replace every
 *      Gemini error message a user sees with a bare status text.
 *
 * So instead of the SDK's retry we install oracle's, at the SDK's own single request egress point.
 * Every other provider in this package reaches that place through a public hook (the OpenAI /
 * Anthropic / Mistral SDKs all accept a custom `fetch`); `@google/genai` exposes none, and
 * `ApiClient#apiCall` is the one function both `request` and `requestStream` funnel through,
 * taking a plain `(url, RequestInit)` and returning the raw `Response` — the exact shape
 * `sendWithRetry` wants, at the exact granularity of oracle's `send_with_retry(&options, req)`.
 * Request bodies on this path are always JSON strings, so replaying a `RequestInit` is safe
 * (oracle leans on the same property via `try_clone`, retry.rs:51-56).
 *
 * That entry point is SDK-internal (`private apiCall` on a non-exported class), so the reach is
 * feature-detected and **fails loudly** rather than silently reverting to no-retry: a renamed or
 * removed `apiCall` throws at client construction and is caught by
 * test/google-retry-parity.test.ts, instead of being discovered in production as a burnt turn on a
 * routine 429.
 */
import type { GoogleGenAI } from "@google/genai";
import { type RetrySendOptions, sendWithRetry } from "../utils/retry.ts";

/** The `@google/genai` internal we intercept. See this file's header for why this one. */
const INTERCEPT_METHOD = "apiCall";

type ApiCall = (url: string, requestInit: RequestInit) => Promise<Response>;

/**
 * Replace the client's internal request egress with an oracle-faithful retrying one. Returns the
 * same client for call-site brevity.
 *
 * @throws if `@google/genai`'s internal request entry point moved — see this file's header.
 */
export function wireOracleRetry(client: GoogleGenAI, options: RetrySendOptions = {}): GoogleGenAI {
	const apiClient = (client as unknown as { apiClient?: Record<string, unknown> }).apiClient;
	const original = apiClient?.[INTERCEPT_METHOD];
	if (!apiClient || typeof original !== "function") {
		throw new Error(
			`@google/genai retry wiring failed: ApiClient#${INTERCEPT_METHOD} is missing, so ` +
				"providers/google-retry.ts cannot install pie's send_with_retry (crates/ai/src/utils/retry.rs). " +
				"The SDK's internal request entry point moved; re-point wireOracleRetry before shipping it.",
		);
	}
	const send = (original as ApiCall).bind(apiClient);
	// An own property shadows the prototype method on this client instance only, so every `models.*`
	// call made through it — unary and streaming alike — goes through the retrying send.
	apiClient[INTERCEPT_METHOD] = (url: string, requestInit: RequestInit): Promise<Response> =>
		sendWithRetry(() => send(url, requestInit), options);
	return client;
}
