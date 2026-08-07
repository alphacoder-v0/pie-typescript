/**
 * Provider-level HTTP retry. pie: crates/ai/src/utils/retry.rs — mirrors the per-provider SDK
 * retry behaviour that pi otherwise gets for free from the OpenAI / Anthropic SDKs (default
 * `maxRetries: 2`), but with pie's own retryable-status set and backoff/cap semantics.
 *
 * Strategy: exponential backoff with jitter on
 *   - 408 (request timeout), 409 (conflict — see isRetryableStatus), 425 (too early)
 *   - 429 (rate limit)
 *   - 5xx (server errors)
 *   - network-level fetch failures (connection reset, DNS, etc.)
 * `Retry-After` is honored when present (seconds only — HTTP-date form is intentionally
 * unsupported, matching oracle), capped by `maxRetryDelayMs`.
 *
 * On a non-retryable status (e.g. 400/401/403) the response is returned untouched so the caller
 * can surface the real error body.
 */

// pie: crates/ai/src/utils/retry.rs:17-19
// Exported so callers that can't wire `sendWithRetry` in directly (e.g. amazon-bedrock.ts, whose
// AWS SDK v3 HTTP handlers expose no fetch/fetcher injection hook) can still align their own
// transport-level retry budget to oracle's default instead of drifting from it independently.
export const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

export interface RetrySendOptions {
	/** Maximum retry attempts after the first send. Oracle default: 2 (retry.rs:17). */
	maxRetries?: number;
	/**
	 * Cap in ms for any single retry delay, server-provided or computed. Oracle default: 60_000
	 * (retry.rs:19). If the server's `Retry-After` requests a longer wait than this, the request
	 * fails immediately with `RetryDelayTooLongError` instead of waiting (retry.rs:91-96).
	 */
	maxRetryDelayMs?: number;
	/** Abort signal — checked before each send attempt and each backoff sleep. */
	signal?: AbortSignal;
}

/** pie: crates/ai/src/utils/retry.rs:29-30 (`RetrySendError::DelayTooLong`) */
export class RetryDelayTooLongError extends Error {
	readonly requestedMs: number;
	readonly capMs: number;

	constructor(requestedMs: number, capMs: number) {
		super(`server requested ${requestedMs}ms wait, exceeds cap ${capMs}ms`);
		this.name = "RetryDelayTooLongError";
		this.requestedMs = requestedMs;
		this.capMs = capMs;
	}
}

/**
 * pie: crates/ai/src/utils/retry.rs:139-144 (`is_retryable_status`)
 * 409: local inference servers (ds4) ask the client to replay the full history; this provider
 * always sends the full history, so a plain retry is that replay.
 */
export function isRetryableStatus(status: number): boolean {
	return status === 408 || status === 409 || status === 425 || status === 429 || (status >= 500 && status < 600);
}

/**
 * pie: crates/ai/src/utils/retry.rs:146-148 (`is_retryable_reqwest_error`). reqwest's error
 * taxonomy (timeout/connect/request/body/decode) has no exact fetch() equivalent; fetch() surfaces
 * network-level failures as `TypeError` (Node/undici: "fetch failed") and never as an abort.
 * TODO(port): reqwest 5-way error taxonomy approximated by TypeError check (broader); revisit if
 * false-positive retries observed.
 */
export function isRetryableTransportError(error: unknown): boolean {
	if (isAbortError(error)) return false;
	if (error instanceof TypeError) return true;
	return error instanceof Error && error.name === "TimeoutError";
}

function isAbortError(error: unknown): boolean {
	return (
		(typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError") ||
		(error instanceof Error && error.name === "AbortError")
	);
}

/**
 * pie: crates/ai/src/utils/retry.rs:150-158 (`retry_after_ms`). Seconds-only; HTTP-date form is
 * uncommon for LLM providers and intentionally unsupported, matching oracle.
 */
export function retryAfterMs(response: Response): number | undefined {
	const header = response.headers.get("retry-after");
	if (!header) return undefined;
	const trimmed = header.trim();
	if (!/^\d+$/.test(trimmed)) return undefined;
	return Number(trimmed) * 1000;
}

/** pie: crates/ai/src/utils/retry.rs:160-168 (`backoff_delay`) */
export function backoffDelayMs(attempt: number, serverDelayMs: number, capMs: number): number {
	if (serverDelayMs > 0) {
		return Math.min(serverDelayMs, Math.max(capMs, 1));
	}
	const base = DEFAULT_BASE_DELAY_MS * 2 ** Math.min(attempt, 6);
	const jitter = Math.floor(Math.random() * 100) + 1;
	return Math.min(base + jitter, Math.max(capMs, 1));
}

function sleepOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DOMException("Request was aborted", "AbortError"));
			return;
		}
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timeout);
			reject(new DOMException("Request was aborted", "AbortError"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Send a request with retries, mirroring oracle's `send_with_retry` (retry.rs:42-130). `doSend`
 * performs a single attempt; the caller is responsible for producing a fresh, replayable request
 * on every call (for JSON request bodies — the only body shape this provider family sends — this
 * is always safe to repeat, so unlike oracle there is no separate "streaming body can't be
 * cloned, degrade to single-shot" branch: `crate::utils::retry::send_with_retry`'s `try_clone`
 * fallback (retry.rs:51-56) has no TS counterpart needed here).
 */
export async function sendWithRetry(
	doSend: () => Promise<Response>,
	options: RetrySendOptions = {},
): Promise<Response> {
	const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
	const capMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;

	let attempt = 0;
	for (;;) {
		if (options.signal?.aborted) {
			throw new DOMException("Request was aborted", "AbortError");
		}

		let response: Response;
		try {
			response = await doSend();
		} catch (error) {
			if (options.signal?.aborted || isAbortError(error)) {
				throw error;
			}
			if (attempt >= maxRetries || !isRetryableTransportError(error)) {
				throw error;
			}
			await sleepOrAbort(backoffDelayMs(attempt, 0, capMs), options.signal);
			attempt += 1;
			continue;
		}

		if (!isRetryableStatus(response.status)) {
			return response;
		}
		if (attempt >= maxRetries) {
			return response;
		}

		const serverDelayMs = retryAfterMs(response) ?? 0;
		if (serverDelayMs > capMs && capMs > 0) {
			throw new RetryDelayTooLongError(serverDelayMs, capMs);
		}
		const delay = backoffDelayMs(attempt, serverDelayMs, capMs);
		// Drain the body so the connection can be pooled (pie: retry.rs:97-100).
		await response.body?.cancel().catch(() => {});
		await sleepOrAbort(delay, options.signal);
		attempt += 1;
	}
}
