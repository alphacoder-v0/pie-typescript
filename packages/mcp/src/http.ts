/**
 * Streamable HTTP transport for MCP.
 *
 * pie: crates/mcp/src/http.rs.
 *
 * This adapts MCP's HTTP POST + SSE shape to the existing line-oriented `Transport` interface.
 * Each outbound JSON-RPC frame is sent as one POST. JSON POST responses and SSE data frames
 * from either POST or the long-lived GET stream are enqueued as raw JSON lines for `McpClient`,
 * which already routes responses vs. notifications by JSON-RPC `id` presence.
 *
 * RULEBOOK §1: HTTP client is global `fetch` (undici) + AbortSignal, no axios/got. `reqwest`'s
 * `Client`-build step (which can fail on bad TLS config) has no TS analog — fetch is a global
 * function, so that fallible step is simply absent here.
 */
import { McpError } from "./errors.ts";
import {
	type AsyncChannelReceiver,
	type AsyncChannelSender,
	createChannel,
	decodeUtf8Strict,
	errorMessage,
	sleepOrAbort,
	utf8ByteLength,
	withDeadline,
} from "./internal/async-utils.ts";
import type { Transport } from "./transport.ts";

const DEFAULT_BODY_CAP_BYTES = 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SSE_IDLE_TIMEOUT_MS = 60_000;
// pie: http.rs:27-31 (`CARGO_PKG_VERSION` — the pie-mcp crate's own Cargo.toml version, 0.75.0
// at the time of porting). Kept as a literal here rather than reading package.json at runtime;
// this only affects the outbound User-Agent string, not wire shape/correctness.
const MCP_PACKAGE_VERSION = "0.75.0";
const DEFAULT_USER_AGENT = `pie-mcp/${MCP_PACKAGE_VERSION} (mcp-streamable-http/2025-03-26)`;

export interface ReconnectPolicy {
	initialDelayMs: number;
	maxDelayMs: number;
	/** `undefined` means retry indefinitely until `Transport.close` is called. */
	maxAttempts?: number;
}

const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = {
	initialDelayMs: 500,
	maxDelayMs: 30_000,
	maxAttempts: undefined,
};

/** pie: http.rs:51-58 (`enum HttpMcpAuth`) — no `Serialize`/`Deserialize` derive on the Rust side; internal-only, not a wire type. */
export type HttpMcpAuth = { kind: "none" } | { kind: "bearer"; token: string };

/** pie: http.rs:60-67 (`impl std::fmt::Debug for HttpMcpAuth`) — redacts the bearer token. */
export function debugHttpMcpAuth(auth: HttpMcpAuth): string {
	switch (auth.kind) {
		case "none":
			return "None";
		case "bearer":
			return "Bearer { token: <redacted> }";
	}
}

export interface HttpMcpTransportOptions {
	endpointUrl: string;
	auth: HttpMcpAuth;
	reconnectPolicy: ReconnectPolicy;
	bodyCapBytes: number;
	requestTimeoutMs: number;
	sseIdleTimeoutMs: number;
	userAgent: string;
}

/** pie: http.rs:80-91 (`HttpMcpTransportOptions::new`). */
export function createHttpMcpTransportOptions(endpointUrl: string): HttpMcpTransportOptions {
	return {
		endpointUrl,
		auth: { kind: "none" },
		reconnectPolicy: { ...DEFAULT_RECONNECT_POLICY },
		bodyCapBytes: DEFAULT_BODY_CAP_BYTES,
		requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
		sseIdleTimeoutMs: DEFAULT_SSE_IDLE_TIMEOUT_MS,
		userAgent: DEFAULT_USER_AGENT,
	};
}

/**
 * pie: http.rs:93-98 (`HttpMcpTransportOptions::bearer`). Rust's `fn bearer(mut self, ...) ->
 * Self` consumes-and-returns-Self (move semantics) — already a purely functional update, ported
 * directly as an immutable-copy function per the house coding-style rule.
 */
export function withBearerAuth(options: HttpMcpTransportOptions, token: string): HttpMcpTransportOptions {
	return { ...options, auth: { kind: "bearer", token } };
}

type LineEntry = { ok: true; line: string } | { ok: false; error: McpError };

function isTimeoutAbort(error: unknown): boolean {
	return error instanceof Error && error.name === "TimeoutError";
}

/**
 * `onTimeout` picks the error variant an elapsed `timeoutMs` maps to, per call site:
 *  - `sendLine`'s POST (http.rs:184-186, `.send().await.map_err(|e| McpError::Transport(...))`) —
 *    reqwest's own per-request `.timeout()` elapsing is just another `send()` failure, folded into
 *    the same uniform `McpError::Transport` as every other cause. Pass `"transport"`.
 *  - `runSseLoop`'s GET connect (http.rs:242,255-257, `tokio::time::timeout(sse_idle_timeout,
 *    request.send())` with an explicit `Err(_) => Err(McpError::Timeout { .. })` arm) — elapsing
 *    here is deliberately distinguished from other send failures. Pass `"timeout"`.
 * `closeSignal` is optional: `sendLine`'s POST has no oracle close_token equivalent (finding #5a
 * below) and must not be interrupted by `close()`, so it passes `undefined` here.
 */
async function fetchGuarded(
	url: string | URL,
	init: RequestInit,
	timeoutMs: number,
	closeSignal: AbortSignal | undefined,
	onTimeout: "timeout" | "transport",
): Promise<Response> {
	const signal = closeSignal
		? AbortSignal.any([closeSignal, AbortSignal.timeout(timeoutMs)])
		: AbortSignal.timeout(timeoutMs);
	try {
		return await fetch(url, { ...init, signal });
	} catch (error) {
		if (closeSignal?.aborted) throw McpError.transport("MCP HTTP request aborted by close()");
		if (isTimeoutAbort(error)) {
			if (onTimeout === "timeout") throw McpError.timeout(Math.floor(timeoutMs / 1000));
			throw McpError.transport(errorMessage(error));
		}
		throw McpError.transport(errorMessage(error));
	}
}

/** pie: http.rs's `StatusCode` Display impl prints `"<code> <reason phrase>"`; Node's `http.STATUS_CODES` gives the same canonical phrases. */
async function formatStatusLine(response: Response): Promise<string> {
	const { STATUS_CODES } = await import("node:http");
	const reason = response.statusText || STATUS_CODES[response.status] || "";
	return reason ? `${response.status} ${reason}` : `${response.status}`;
}

function buildAuthHeaders(auth: HttpMcpAuth): Record<string, string> {
	return auth.kind === "bearer" ? { authorization: `Bearer ${auth.token}` } : {};
}

async function cappedText(response: Response, capBytes: number): Promise<string> {
	const body = response.body;
	if (!body) return "";
	const reader = body.getReader();
	let total = 0;
	const chunks: Uint8Array[] = [];
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value === undefined) continue;
			total += value.byteLength;
			if (total > capBytes) throw McpError.protocol("MCP HTTP response body exceeded cap");
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return decodeUtf8Strict(merged);
}

interface SseEvent {
	id?: string;
	data?: string;
}

/** pie: http.rs:446-466 (`fn parse_sse_event`). */
function parseSseEvent(raw: string): SseEvent | undefined {
	let id: string | undefined;
	const dataLines: string[] = [];
	for (const rawLine of raw.split("\n")) {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (line === "" || line.startsWith(":")) continue;
		if (line.startsWith("id:")) {
			id = line.slice("id:".length).trimStart();
		} else if (line.startsWith("data:")) {
			dataLines.push(line.slice("data:".length).trimStart());
		}
	}
	if (id === undefined && dataLines.length === 0) return undefined;
	return { id, data: dataLines.length > 0 ? dataLines.join("\n") : undefined };
}

/** pie: http.rs:408-439 (`struct SseParser`). Byte-accurate cap tracking (JS string `.length` is UTF-16 code units, not bytes). */
export class SseParser {
	private readonly capBytes: number;
	private buffer = "";
	private bufferBytes = 0;

	constructor(capBytes: number) {
		this.capBytes = capBytes;
	}

	push(chunk: Uint8Array): SseEvent[] {
		if (this.bufferBytes + chunk.byteLength > this.capBytes) {
			throw McpError.protocol("MCP HTTP SSE frame exceeded cap");
		}
		const text = decodeUtf8Strict(chunk);
		this.buffer += text;
		this.bufferBytes += chunk.byteLength;
		const out: SseEvent[] = [];
		let idx = this.buffer.indexOf("\n\n");
		while (idx !== -1) {
			const raw = this.buffer.slice(0, idx);
			const consumed = this.buffer.slice(0, idx + 2);
			this.buffer = this.buffer.slice(idx + 2);
			this.bufferBytes -= utf8ByteLength(consumed);
			const event = parseSseEvent(raw);
			if (event) out.push(event);
			idx = this.buffer.indexOf("\n\n");
		}
		return out;
	}
}

async function readNextSseChunk(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	idleTimeoutMs: number | undefined,
	closeSignal: AbortSignal,
): Promise<Uint8Array | undefined> {
	const next = async (): Promise<Uint8Array | undefined> => {
		if (closeSignal.aborted) return undefined;
		const winner = await Promise.race([
			reader
				.read()
				.then((result) => ({ kind: "read" as const, result }))
				.catch((error) => {
					throw McpError.transport(errorMessage(error));
				}),
			new Promise<{ kind: "closed" }>((resolve) => {
				if (closeSignal.aborted) resolve({ kind: "closed" });
				else closeSignal.addEventListener("abort", () => resolve({ kind: "closed" }), { once: true });
			}),
		]);
		if (winner.kind === "closed") return undefined;
		return winner.result.done ? undefined : winner.result.value;
	};

	if (idleTimeoutMs === undefined) return next();
	return withDeadline(next(), idleTimeoutMs, () => McpError.timeout(Math.floor(idleTimeoutMs / 1000)));
}

async function readSseResponse(
	response: Response,
	bodyCapBytes: number,
	idleTimeoutMs: number | undefined,
	sender: AsyncChannelSender<LineEntry>,
	closeSignal: AbortSignal,
	onLastEventId: ((id: string) => void) | undefined,
): Promise<void> {
	if (!response.ok) {
		throw McpError.transport(`MCP HTTP SSE status ${await formatStatusLine(response)}`);
	}
	const parser = new SseParser(bodyCapBytes);
	const body = response.body;
	if (!body) return;
	const reader = body.getReader();
	try {
		while (true) {
			const chunk = await readNextSseChunk(reader, idleTimeoutMs, closeSignal);
			if (chunk === undefined) return;
			for (const event of parser.push(chunk)) {
				if (event.id !== undefined) onLastEventId?.(event.id);
				if (event.data !== undefined) {
					sender.send({ ok: true, line: event.data });
				}
			}
		}
	} finally {
		// pie: close()'s `handle.abort()` (http.rs:205-210) unconditionally tears down the whole SSE
		// task, dropping the in-flight `reqwest::Response` body stream — and dropping a reqwest body
		// stream cancels the underlying HTTP request/connection. `reader.releaseLock()` alone only
		// releases the JS-level lock; it leaves the underlying stream (and the server's connection)
		// running. `reader.cancel()` is what actually severs it, matching that Drop-triggered
		// cancellation on every exit path (clean EOF, read error, or close()-triggered abort).
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

async function enqueueResponseBody(
	response: Response,
	bodyCapBytes: number,
	sender: AsyncChannelSender<LineEntry>,
	closeSignal: AbortSignal,
): Promise<void> {
	if (!response.ok) {
		// pie: http.rs:295-297 — status included, body deliberately NOT included ("response body redacted").
		throw McpError.transport(`MCP HTTP status ${await formatStatusLine(response)}; response body redacted`);
	}
	const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
	if (contentType.startsWith("text/event-stream")) {
		// pie: http.rs:305-310 — detached `tokio::spawn`; the task's `Result` is discarded
		// (`let _ = read_sse_response(...).await;`), never routed back through `tx`/the shared
		// channel. A body-read failure on this inline POST-triggered SSE stream must not masquerade
		// as a fatal transport error on the shared line channel — `recvLine()` would throw it, and
		// `McpClient.runReadPump` (client.ts) treats any `recvLine()` throw as transport-closed and
		// drains every other in-flight request. Silently drop instead, matching oracle exactly.
		void readSseResponse(response, bodyCapBytes, undefined, sender, closeSignal, undefined).catch(() => {
			// Deliberately swallowed — see comment above.
		});
		return;
	}
	const text = await cappedText(response, bodyCapBytes);
	const trimmed = text.trim();
	if (trimmed.length > 0) {
		sender.send({ ok: true, line: trimmed });
	}
}

export class HttpMcpTransport implements Transport {
	private readonly endpoint: URL;
	private auth: HttpMcpAuth;
	private readonly bodyCapBytes: number;
	private readonly requestTimeoutMs: number;
	private readonly sseIdleTimeoutMs: number;
	private readonly reconnectPolicy: ReconnectPolicy;
	private readonly userAgent: string;
	private readonly sender: AsyncChannelSender<LineEntry>;
	private readonly receiver: AsyncChannelReceiver<LineEntry>;
	private readonly closeController = new AbortController();

	private constructor(options: HttpMcpTransportOptions, endpoint: URL) {
		this.endpoint = endpoint;
		this.auth = options.auth;
		this.bodyCapBytes = options.bodyCapBytes;
		this.requestTimeoutMs = options.requestTimeoutMs;
		this.sseIdleTimeoutMs = options.sseIdleTimeoutMs;
		this.reconnectPolicy = options.reconnectPolicy;
		this.userAgent = options.userAgent;
		const { sender, receiver } = createChannel<LineEntry>();
		this.sender = sender;
		this.receiver = receiver;
	}

	static connect(options: HttpMcpTransportOptions): HttpMcpTransport {
		let endpoint: URL;
		try {
			endpoint = new URL(options.endpointUrl);
		} catch (error) {
			throw McpError.transport(`invalid MCP HTTP endpoint: ${errorMessage(error)}`);
		}
		if (endpoint.protocol !== "https:" && endpoint.hostname !== "127.0.0.1") {
			throw McpError.transport("streamable_http endpoint must be https, except 127.0.0.1 test fixtures");
		}
		try {
			new Headers({ "user-agent": options.userAgent });
		} catch {
			throw McpError.transport("invalid streamable_http user agent");
		}

		const transport = new HttpMcpTransport(options, endpoint);
		// pie: http.rs:111,153 (`sse_task: AsyncMutex<Option<JoinHandle<()>>>`) — oracle retains the
		// task handle solely to call `handle.abort()` from `close()`. Here cancellation is achieved
		// by threading `closeController.signal` through every await point in `runSseLoop`/
		// `readSseResponse`/`readNextSseChunk` instead, so no handle needs to be retained; the loop
		// is fire-and-forget, matching `tokio::spawn`'s detached semantics (RULEBOOK §2.2 detach()).
		void transport.runSseLoop();
		return transport;
	}

	setAuth(auth: HttpMcpAuth): void {
		this.auth = auth;
	}

	async sendLine(line: string): Promise<void> {
		if (utf8ByteLength(line) > this.bodyCapBytes) {
			throw McpError.protocol("MCP HTTP request exceeded body cap");
		}
		const response = await fetchGuarded(
			this.endpoint,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
					"user-agent": this.userAgent,
					...buildAuthHeaders(this.auth),
				},
				body: line,
			},
			this.requestTimeoutMs,
			// pie: http.rs's `send_line` (168-194) has no `close_token` parameter at all — an in-flight
			// POST is never interrupted by `close()`, only bounded by its own request timeout. No
			// `closeSignal` here (finding #5a).
			undefined,
			// pie: http.rs:184-186 — `.send().await.map_err(|e| McpError::Transport(e.to_string()))?`
			// folds every send failure, including the per-request timeout elapsing, into
			// `McpError::Transport` uniformly (finding #2).
			"transport",
		);
		await enqueueResponseBody(response, this.bodyCapBytes, this.sender, this.closeController.signal);
	}

	async recvLine(): Promise<string | undefined> {
		const entry = await this.receiver.recv();
		if (entry === undefined) return undefined;
		if (!entry.ok) throw entry.error;
		return entry.line;
	}

	async close(): Promise<void> {
		// pie: http.rs:205-210 — cancel + best-effort abort, does not await task completion.
		this.closeController.abort();
	}

	private async runSseLoop(): Promise<void> {
		let lastEventId: string | undefined;
		let delayMs = this.reconnectPolicy.initialDelayMs;
		let attempts = 0;

		while (true) {
			if (this.closeController.signal.aborted) return;

			const headers: Record<string, string> = {
				accept: "text/event-stream",
				"user-agent": this.userAgent,
				...buildAuthHeaders(this.auth),
			};
			if (lastEventId !== undefined) {
				try {
					new Headers({ "last-event-id": lastEventId });
					headers["last-event-id"] = lastEventId;
				} catch {
					// pie: http.rs:236-238 (`if let Ok(v) = HeaderValue::from_str(&id)`) — silently skip invalid values.
				}
			}

			let ok: boolean;
			try {
				const response = await fetchGuarded(
					this.endpoint,
					{ method: "GET", headers },
					this.sseIdleTimeoutMs,
					this.closeController.signal,
					// pie: http.rs:242,255-257 — `tokio::time::timeout(sse_idle_timeout,
					// request.send())` explicitly maps an elapsed connect to `McpError::Timeout`,
					// distinct from `send_line`'s POST (finding #2).
					"timeout",
				);
				await readSseResponse(
					response,
					this.bodyCapBytes,
					this.sseIdleTimeoutMs,
					this.sender,
					this.closeController.signal,
					(id) => {
						lastEventId = id;
					},
				);
				ok = true;
			} catch {
				ok = false;
			}

			if (this.closeController.signal.aborted) return;

			if (ok) {
				delayMs = this.reconnectPolicy.initialDelayMs;
				attempts = 0;
			} else {
				attempts += 1;
				if (this.reconnectPolicy.maxAttempts !== undefined && attempts >= this.reconnectPolicy.maxAttempts) {
					this.sender.send({ ok: false, error: McpError.transport("MCP HTTP SSE reconnect attempts exhausted") });
					return;
				}
			}

			const outcome = await sleepOrAbort(delayMs, this.closeController.signal);
			if (outcome === "aborted") return;
			delayMs = Math.min(delayMs * 2, this.reconnectPolicy.maxDelayMs);
		}
	}
}
