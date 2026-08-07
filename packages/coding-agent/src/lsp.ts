/**
 * Minimal LSP client. Port of oracle `crates/coding-agent/src/lsp.rs` (pie @0a120dfd). v1
 * scope: subprocess transport with Content-Length framing, `initialize` handshake,
 * `textDocument/didOpen`, async collection of `textDocument/publishDiagnostics` notifications.
 * Wired into the agent's after-edit hook by `lsp-supervisor.ts`.
 *
 * Per-language server resolution is config-driven (`~/.pie/lsp.toml` / `<cwd>/.pie/lsp.toml`,
 * see `lsp-supervisor.ts`). v1 supports stdio servers only; SSE/socket transports defer,
 * matching oracle exactly (oracle's own module doc: "SSE/socket transports defer").
 */

import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { AsyncQueue, detach, type SelectCase, Signal, selectN } from "@pie/agent-core";
import { formatDurationDebug } from "./duration-format.ts";
import { spawnProcess } from "./utils/child-process.ts";

/** pie: lsp.rs:41-45 (`struct Position`). LSP wire field names are already camelCase/lower --
 * no rename needed, these match the protocol verbatim. */
export interface Position {
	line: number;
	character: number;
}

/** pie: lsp.rs:35-39 (`struct DiagnosticRange`). */
export interface DiagnosticRange {
	start: Position;
	end: Position;
}

/** pie: lsp.rs:25-33 (`struct Diagnostic`). */
export interface Diagnostic {
	range: DiagnosticRange;
	severity?: number;
	message: string;
	source?: string;
}

interface PublishDiagnosticsParams {
	uri: string;
	diagnostics: Diagnostic[];
}

interface JsonRpcResponseSettlement {
	ok: boolean;
	value: unknown;
}

/**
 * Buffered byte reader over a Node `Readable`, implementing the two primitives Rust's
 * `tokio::io::BufReader` gives `read_framed` for free: read-a-line (headers) and
 * read-exactly-N-bytes (body). No canonical shared util covers LSP's Content-Length HTTP-style
 * framing (distinct from MCP's newline-delimited JSON, `@pie/mcp`'s `StdioTransport`) so this is
 * package-local, mirroring the same hand-buffered approach oracle's own `read_framed` uses.
 */
class FramedReader {
	private buffer: Buffer = Buffer.alloc(0);
	private closed = false;
	/**
	 * The wake-up primitive is the canonical `Signal` (RULEBOOK §2.2 `Notify` row, §4's four
	 * shared concurrency utils) rather than a private waiter list: `coding-agent` sits DOWNSTREAM
	 * of `agent-core` in the one legal dependency direction, so it imports the util instead of
	 * re-implementing it (§4's leaf-package exception covers only packages upstream of
	 * `agent-core` -- `ai`, `mcp` -- which cannot import it at all).
	 *
	 * `notifyAll`, never `notifyOne`: each waiter re-checks its OWN predicate against the shared
	 * buffer (`readLine` wants a `\n`, `readExact` wants N bytes), so waking a single arbitrary
	 * waiter could park a reader whose predicate is already satisfied. `notifyAll` also matches
	 * the previous hand-rolled `wake()` exactly -- it stores no permit, and the pre-wait predicate
	 * check in `waitForData` (no await between the check and the registration) closes the same
	 * missed-wakeup window the old code closed.
	 */
	private readonly dataAvailable = new Signal();

	constructor(stream: Readable) {
		stream.on("data", (chunk: Buffer) => {
			this.buffer = Buffer.concat([this.buffer, chunk]);
			this.dataAvailable.notifyAll();
		});
		const onEnd = () => {
			this.closed = true;
			this.dataAvailable.notifyAll();
		};
		stream.on("end", onEnd);
		stream.on("close", onEnd);
		stream.on("error", onEnd);
	}

	private waitForData(): Promise<void> {
		if (this.buffer.length > 0 || this.closed) return Promise.resolve();
		return this.dataAvailable.wait();
	}

	/** Read up to and including the next `\n` (mirrors `AsyncBufReadExt::read_line`). Returns
	 * `undefined` once closed with nothing left to drain. Trailing bytes present at close with
	 * no `\n` are returned once as a final partial "line", matching Rust's `read_line` returning
	 * `n > 0` for that same trailing chunk before the *next* call returns `n == 0`. */
	async readLine(): Promise<string | undefined> {
		for (;;) {
			const idx = this.buffer.indexOf(0x0a);
			if (idx !== -1) {
				const line = this.buffer.subarray(0, idx).toString("utf8");
				this.buffer = this.buffer.subarray(idx + 1);
				return line;
			}
			if (this.closed) {
				if (this.buffer.length === 0) return undefined;
				const rest = this.buffer.toString("utf8");
				this.buffer = Buffer.alloc(0);
				return rest;
			}
			await this.waitForData();
		}
	}

	/** Read exactly `n` bytes (mirrors `AsyncReadExt::read_exact`). Returns `undefined` if the
	 * stream closes before `n` bytes are available (Rust: `UnexpectedEof`). */
	async readExact(n: number): Promise<Buffer | undefined> {
		while (this.buffer.length < n) {
			if (this.closed) return undefined;
			await this.waitForData();
		}
		const out = Buffer.from(this.buffer.subarray(0, n));
		this.buffer = this.buffer.subarray(n);
		return out;
	}
}

/** pie: lsp.rs:283-308 (`read_framed`). Returns `undefined` on clean/partial EOF (mirrors
 * `Ok(None)`), throws on a frame missing `Content-Length` (mirrors the `anyhow!` error path --
 * both cases stop the pump the same way in oracle: `Err(_) => break`, same as `Ok(None) =>
 * break`). */
async function readFramed(reader: FramedReader): Promise<unknown | undefined> {
	let contentLength: number | undefined;
	for (;;) {
		const line = await reader.readLine();
		if (line === undefined) return undefined;
		const trimmed = line.replace(/[\r\n]+$/, "");
		if (trimmed === "") break;
		// pie: lsp.rs:299-301 -- `if let Some(rest) = trimmed.strip_prefix("Content-Length: ") {
		// content_length = rest.parse().ok(); }`. The assignment happens for EVERY line carrying
		// the prefix, and `.ok()` yields `None` when the value doesn't parse -- so a malformed
		// second `Content-Length:` header RESETS an already-parsed value rather than leaving it
		// standing. Matching that reset is load-bearing: a frame with `Content-Length: 42` followed
		// by `Content-Length: abc` must end in "missing Content-Length" here, exactly as in oracle,
		// rather than silently reading 42 bytes.
		const rest = trimmed.startsWith("Content-Length: ") ? trimmed.slice("Content-Length: ".length) : undefined;
		if (rest !== undefined) {
			contentLength = /^\d+$/.test(rest) ? Number(rest) : undefined;
		}
	}
	if (contentLength === undefined) {
		throw new Error("LSP frame missing Content-Length");
	}
	const buf = await reader.readExact(contentLength);
	if (buf === undefined) return undefined;
	return JSON.parse(buf.toString("utf8"));
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/** The oracle crate's own version, which `env!("CARGO_PKG_VERSION")` bakes into `clientInfo`.
 * See the `initialize` call site for why this is a literal rather than this package's VERSION. */
const ORACLE_CRATE_VERSION = "0.75.0";

/**
 * The timeout branch of `request`'s `selectN` (RULEBOOK §2.2 `tokio::time::timeout`, form (2)).
 * `run` owns the timer and clears it the moment its own `AbortSignal` fires -- which `selectN`
 * does as soon as the response branch wins -- so a settled request never leaves a 15s timer
 * holding the event loop open. Shaped exactly like `oauth.ts`'s `callbackTimeoutCase`.
 */
function requestTimeoutCase(method: string, timeoutMs: number): SelectCase<never> {
	return {
		run: (signal) =>
			new Promise<never>((_resolve, reject) => {
				const timer = setTimeout(() => {
					// pie: lsp.rs:255-257 -- `"LSP request {method} timed out after {:?}"` where the
					// argument is a `Duration`, so `{:?}` renders 15s as `15s`, not `15000ms`.
					reject(new Error(`LSP request ${method} timed out after ${formatDurationDebug(timeoutMs)}`));
				}, timeoutMs);
				signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
			}),
	};
}

/**
 * pie: lsp.rs:53-63 (`struct LspClient`). `#[allow(dead_code)]` at the oracle item level
 * ("public API... so the binary compiles before the after-edit-hook wiring lands") -- this port
 * IS wired, by `lsp-supervisor.ts` (this phase), closing that gap on the TS side.
 */
export class LspClient {
	private readonly stdin: NodeJS.WritableStream;
	private nextId = 1;
	private readonly inflight = new Map<number, (settlement: JsonRpcResponseSettlement) => void>();
	private readonly diagnosticsByUri = new Map<string, Diagnostic[]>();
	private readonly diagQueue = new AsyncQueue<{ uri: string; diagnostics: Diagnostic[] }>();
	private child: ChildProcess | undefined;
	private readonly requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;

	private constructor(child: ChildProcess, stdin: NodeJS.WritableStream) {
		this.child = child;
		this.stdin = stdin;
	}

	/**
	 * pie: lsp.rs:69-160 (`spawn`). Spawn the server, wire stdio, and start the read pump.
	 * Caller must then call {@link initialize} before any other method.
	 */
	static async spawn(cmd: string, args: string[]): Promise<LspClient> {
		const child = spawnProcess(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
		const { stdin, stdout, stderr } = child;
		if (!stdin || !stdout || !stderr) {
			throw new Error(`spawn LSP server ${cmd}: missing stdio pipes`);
		}
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => {
				cleanup();
				reject(new Error(`spawn LSP server ${cmd}: ${error.message}`));
			};
			const onSpawn = () => {
				cleanup();
				resolve();
			};
			const cleanup = () => {
				child.removeListener("error", onError);
				child.removeListener("spawn", onSpawn);
			};
			child.once("error", onError);
			child.once("spawn", onSpawn);
		});

		const client = new LspClient(child, stdin);
		const reader = new FramedReader(stdout);
		// pie: lsp.rs:96-137 (read pump, `tokio::spawn`) -> RULEBOOK §2.2 detached mapping.
		// The pump's own loop swallows every expected failure (framing error, stream close) the
		// same way oracle's task body does (`Err(_) => break`, no propagation) -- `onError`
		// below is a defensive backstop only, unreachable in normal operation.
		detach(
			() => client.runReadPump(reader),
			() => {
				// See comment above: nothing in the pump's control flow reaches this in practice.
			},
		);
		// pie: lsp.rs:139-148 (stderr drain, `tokio::spawn`) -- drained and discarded, matching
		// oracle exactly (no stderr tail buffer on this struct, unlike `@pie/mcp`'s
		// `StdioTransport`; oracle's own stderr handling here is write-only-nothing, just
		// draining the pipe so the child never blocks on a full buffer).
		detach(
			() => drainStderr(stderr),
			() => {
				// Best-effort drain; failures have no oracle-side sink either.
			},
		);

		return client;
	}

	private async runReadPump(reader: FramedReader): Promise<void> {
		for (;;) {
			let value: unknown;
			try {
				value = await readFramed(reader);
			} catch {
				break;
			}
			if (value === undefined) break;
			if (typeof value !== "object" || value === null) continue;
			const record = value as Record<string, unknown>;
			const id = typeof record.id === "number" ? record.id : undefined;
			const method = typeof record.method === "string" ? record.method : undefined;
			if (id !== undefined) {
				// Either a response or a server-initiated request (v1 doesn't handle the latter --
				// ignore). pie: lsp.rs:113 gates this on `value.get("method").is_none()`, i.e. KEY
				// EXISTENCE, not "is a string". A frame like `{"id":1,"method":5}` therefore does
				// NOT settle the in-flight request in oracle (it keeps waiting until the 15s
				// timeout); keying off the string-typed `method` binding here would settle it with
				// `null` instead. `method` above stays string-typed for the notification dispatch
				// below, mirroring oracle's separate `as_str()` binding at lsp.rs:106-109.
				if (!("method" in record)) {
					const resolver = this.inflight.get(id);
					if (resolver) {
						this.inflight.delete(id);
						resolver({ ok: true, value: record });
					}
				}
			} else if (method === "textDocument/publishDiagnostics") {
				const params = record.params;
				if (isPublishDiagnosticsParams(params)) {
					this.diagnosticsByUri.set(params.uri, params.diagnostics);
					this.diagQueue.push({ uri: params.uri, diagnostics: params.diagnostics });
				}
			}
		}
	}

	/** pie: lsp.rs:163-180 (`initialize`). Send the initialize request and the matching
	 * `initialized` notification. */
	async initialize(rootUri: string): Promise<unknown> {
		const params = {
			processId: process.pid,
			rootUri,
			capabilities: {
				textDocument: {
					synchronization: { didSave: true },
					publishDiagnostics: {},
				},
			},
			// pie: lsp.rs:173 -- `env!("CARGO_PKG_VERSION")`, resolving to the ORACLE crate's version
			// (0.75.0 at the pie @0a120dfd snapshot this migration targets).
			// TODO(port): version literal must track oracle Cargo.toml, not this package.json.
			// Deliberately NOT `VERSION` from config.ts: that reads packages/coding-agent/package.json,
			// whose version lineage is pi's (0.75.4) and would put bytes on the `initialize` wire that
			// oracle never emits. Repo-wide convention for every wire-visible version string --
			// ai/utils/headers.ts:12, mcp/client.ts:62, mcp/http.ts:34, tools/web-fetch.ts:35,
			// tools/web-search.ts:30 -- is a hardcoded 0.75.0 with this marker; phase 6 adjudicated
			// exactly this question ("0.75.4 vs 0.75.0", CONFIRMED, migration/reviews/mcp/findings.md).
			clientInfo: { name: "pie", version: ORACLE_CRATE_VERSION },
		};
		const result = await this.request("initialize", params);
		await this.notify("initialized", {});
		return result;
	}

	/** pie: lsp.rs:182-193 (`did_open`). Send a `textDocument/didOpen` notification. */
	async didOpen(uri: string, languageId: string, text: string): Promise<void> {
		await this.notify("textDocument/didOpen", {
			textDocument: { uri, languageId, version: 1, text },
		});
	}

	/** pie: lsp.rs:195-202 (`diagnostics_for`). Return the most recent diagnostics for `uri`
	 * (empty if none received yet). */
	diagnosticsFor(uri: string): Diagnostic[] {
		return this.diagnosticsByUri.get(uri) ?? [];
	}

	/**
	 * pie: lsp.rs:204-212 (`await_diagnostics`). Wait up to `timeoutMs` for the next diagnostics
	 * push (regardless of URI). Returns the uri + diagnostics, or `undefined` on timeout.
	 *
	 * pie: mpsc mapping (RULEBOOK §2.2) note -- oracle guards `diag_rx` with a `tokio::sync::
	 * Mutex` (single in-flight waiter; a second concurrent caller blocks behind the first).
	 * `AsyncQueue.next(signal)` is the canonical shared util for this shape but supports
	 * multiple concurrent waiters (each queued FIFO) rather than serializing them.
	 *
	 * TODO(port): this RELAXES oracle's concurrency semantics -- oracle serializes diagnostics
	 * waiters behind `diag_rx: AsyncMutex<mpsc::UnboundedReceiver<...>>` (lsp.rs:60) via
	 * `self.diag_rx.lock().await` (lsp.rs:207), so a second concurrent caller waits for the first
	 * to return and then reads the NEXT push; here both callers queue on `AsyncQueue` at once and
	 * each is handed a different push (and on timeout, oracle's loser never consumed the mutex
	 * while ours has already left the FIFO). Unobservable only under the CURRENT wiring, where a
	 * single `LspSupervisor` call drives one client at a time -- that is a fact about today's call
	 * graph, not about this class, so it must stay greppable: a future caller that awaits
	 * diagnostics concurrently needs an `AsyncMutex` (RULEBOOK §2.2 `Mutex` row: the critical
	 * section crosses an await) wrapped around this method to restore oracle's behavior.
	 */
	async awaitDiagnostics(timeoutMs: number): Promise<{ uri: string; diagnostics: Diagnostic[] } | undefined> {
		try {
			return await this.diagQueue.next(AbortSignal.timeout(timeoutMs));
		} catch {
			return undefined;
		}
	}

	/** pie: lsp.rs:214-223 (`shutdown`). Best-effort shutdown -- let the server clean up; if it
	 * doesn't respond, kill. */
	async shutdown(): Promise<void> {
		try {
			await this.request("shutdown", null);
		} catch {
			// Best-effort, matches oracle's `let _ = ...`.
		}
		try {
			await this.notify("exit", undefined);
		} catch {
			// Best-effort.
		}
		const child = this.child;
		this.child = undefined;
		if (child) {
			child.kill("SIGKILL");
		}
	}

	/** pie: lsp.rs:225-261 (`request`). */
	private async request(method: string, params: unknown): Promise<unknown> {
		const id = this.nextId++;
		const req = { jsonrpc: "2.0", id, method, params };
		const line = JSON.stringify(req);
		// pie: lsp.rs:238 `let (tx, rx) = oneshot::channel();` -> RULEBOOK §2.2's `oneshot` row
		// (`Promise.withResolvers<T>()`). The resolvers are captured inline instead of calling the
		// native API because that needs TS lib "es2024" while this monorepo's shared
		// `tsconfig.base.json` is on "es2022" -- same workaround and same rationale as
		// `packages/mcp/src/internal/async-utils.ts:30-45` and `oauth.ts`'s `awaitCallback`. Only
		// `resolve` is captured: the read pump is the sole producer and always sends a value
		// (mirroring oracle, whose `oneshot::Sender` is likewise only ever `send`-ed, never dropped
		// early -- its `Ok(Err(_))` "LSP response channel closed" arm at lsp.rs:252 is unreachable
		// there and has no counterpart here).
		let settle!: (settlement: JsonRpcResponseSettlement) => void;
		const settled = new Promise<JsonRpcResponseSettlement>((resolve) => {
			settle = resolve;
		});
		this.inflight.set(id, settle);
		await this.writeFramed(line);

		let settlement: JsonRpcResponseSettlement;
		try {
			// pie: lsp.rs:240 `tokio::time::timeout(self.request_timeout, rx)` -> RULEBOOK §2.2's
			// `tokio::time::timeout` row, form (2): the awaited thing is a plain Promise (not an
			// `AsyncQueue`/`Signal` that could take an `AbortSignal` directly, which is form (1) --
			// see `awaitDiagnostics` above), so the race goes through the canonical `selectN` and
			// the timeout branch owns its timer, clearing it when `selectN` aborts the loser. A
			// hand-rolled `new Promise` + `setTimeout` + `Promise.race` is explicitly forbidden
			// there (it leaks the timer and cancels no loser).
			({ value: settlement } = await selectN<JsonRpcResponseSettlement>([
				{ run: () => settled },
				requestTimeoutCase(method, this.requestTimeoutMs),
			]));
		} catch (error) {
			// pie: lsp.rs:253 -- the timeout arm drops the in-flight entry (`inflight.lock().remove`)
			// before returning the error, so a late response is discarded instead of resolving a
			// caller that already gave up.
			this.inflight.delete(id);
			throw error;
		}
		const value = settlement.value as Record<string, unknown>;
		if ("error" in value) {
			throw new Error(`LSP server error: ${JSON.stringify(value.error)}`);
		}
		return value.result ?? null;
	}

	/**
	 * pie: lsp.rs:263-271 (`notify`). The signature is `params: Option<serde_json::Value>` fed to
	 * `serde_json::json!({... "params": params})`, and `json!` serializes `None` as an explicit
	 * `null` -- it never omits the key. `JSON.stringify` does the opposite: a property whose value
	 * is `undefined` is dropped entirely. So `notify("exit", undefined)` would put
	 * `{"jsonrpc":"2.0","method":"exit"}` on the wire where oracle puts
	 * `{"jsonrpc":"2.0","method":"exit","params":null}` -- different bytes AND a different
	 * Content-Length on every shutdown. Normalizing `undefined` to `null` here restores the
	 * oracle frame; callers passing a real params object are unaffected.
	 */
	private async notify(method: string, params: unknown): Promise<void> {
		const req = { jsonrpc: "2.0", method, params: params ?? null };
		await this.writeFramed(JSON.stringify(req));
	}

	/**
	 * pie: lsp.rs:273-280 (`write_framed`). Oracle guards this with `stdin: AsyncMutex<
	 * ChildStdin>` because the header write and the payload write are two separate awaited
	 * writes that could interleave with a concurrent caller's if not serialized (RULEBOOK §2.2:
	 * critical section crosses an await -> AsyncMutex). Here the header + payload are
	 * concatenated into a single `Buffer` and written with ONE `.write()` call -- Node's stream
	 * write queue appends a synchronous `.write()` call atomically, so two full frames from
	 * concurrent callers can only interleave *between* frames (harmless -- each frame is
	 * self-delimited by its own Content-Length), never *within* one. No `AsyncMutex` needed.
	 */
	private writeFramed(payload: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const payloadBytes = Buffer.from(payload, "utf8");
			const header = Buffer.from(`Content-Length: ${payloadBytes.length}\r\n\r\n`, "utf8");
			const frame = Buffer.concat([header, payloadBytes]);
			this.stdin.write(frame, (error) => (error ? reject(error) : resolve()));
		});
	}
}

// pie: lsp.rs:41-45 / 25-33 -- the integer bounds `serde_json` enforces for `Position`'s `u32`
// fields and `Diagnostic`'s `Option<u8>` severity. Out-of-range values are deserialization
// errors, not clamps.
const U32_MAX = 4_294_967_295;
const U8_MAX = 255;

/** A JSON object -- what serde needs to deserialize a Rust struct (an array or `null` is a
 * type error there, so both are rejected here). */
function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** serde_json accepts a JSON number for an unsigned Rust integer only when it is a non-negative
 * integer within the type's range.
 *
 * TODO(port): serde_json also rejects `0.0`/`1e2` for a `u32` (they carry f64 in the parsed
 * `Value`, and `visit_f64` on an integer visitor is an error) whereas `JSON.parse` erases the
 * lexical form -- both arrive here as the integer `100`. Closing that would take a
 * form-preserving JSON parser; no LSP server emits float line numbers, so the port accepts the
 * wider set. */
function isUnsignedInt(value: unknown, max: number): boolean {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;
}

/** pie: lsp.rs:41-45 (`struct Position`). Both fields are required `u32`. */
function isPosition(value: unknown): value is Position {
	if (!isJsonObject(value)) return false;
	return isUnsignedInt(value.line, U32_MAX) && isUnsignedInt(value.character, U32_MAX);
}

/** pie: lsp.rs:35-39 (`struct DiagnosticRange`). Both ends are required. */
function isDiagnosticRange(value: unknown): value is DiagnosticRange {
	if (!isJsonObject(value)) return false;
	return isPosition(value.start) && isPosition(value.end);
}

/** pie: lsp.rs:25-33 (`struct Diagnostic`). `range` and `message` are required; `severity`
 * (`Option<u8>`) and `source` (`Option<String>`) are `#[serde(default)]`, so absent OR explicit
 * `null` both mean `None`. No `deny_unknown_fields`, so extra keys are ignored. */
function isDiagnostic(value: unknown): value is Diagnostic {
	if (!isJsonObject(value)) return false;
	if (!isDiagnosticRange(value.range)) return false;
	if (typeof value.message !== "string") return false;
	if (value.severity !== undefined && value.severity !== null && !isUnsignedInt(value.severity, U8_MAX)) return false;
	if (value.source !== undefined && value.source !== null && typeof value.source !== "string") return false;
	return true;
}

/**
 * pie: lsp.rs:47-51 (`struct PublishDiagnosticsParams`), enforced at lsp.rs:121-123 by
 * `serde_json::from_value::<PublishDiagnosticsParams>(params.clone())`.
 *
 * serde validates the payload DEEPLY: a single malformed element anywhere in `diagnostics` fails
 * the whole `from_value`, and oracle's `if let Ok(p)` then drops the ENTIRE notification -- no
 * cache write, no channel send (lsp.rs:124-127). So per-element validation is load-bearing, not
 * defensive: a diagnostic missing `range` that slipped into the cache would reach
 * `renderDiagnostics` (`lsp-supervisor.ts`) and throw out of the after-tool-call hook, where
 * oracle simply has nothing cached.
 *
 * One residual, deliberately not "fixed" because it is unobservable through this port's read
 * surface (`diagnosticsFor` -> `renderDiagnostics` reads only range/message/severity): oracle's
 * `from_value` also PROJECTS onto the four struct fields, dropping unknown keys and folding
 * `null` into `None`, while this predicate hands the raw object through.
 */
function isPublishDiagnosticsParams(value: unknown): value is PublishDiagnosticsParams {
	if (!isJsonObject(value)) return false;
	if (typeof value.uri !== "string") return false;
	if (!Array.isArray(value.diagnostics)) return false;
	return value.diagnostics.every((entry) => isDiagnostic(entry));
}

async function drainStderr(stderr: Readable): Promise<void> {
	// pie: lsp.rs:139-148 -- read and discard until EOF; never throws for a closed stream.
	for await (const _chunk of stderr) {
		// Discard.
	}
}
