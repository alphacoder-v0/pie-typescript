/**
 * Port of oracle `crates/coding-agent/src/ui/relay.rs` (pie @0a120dfd) — remote relay client
 * (`/web-connect`, issue #22).
 *
 * Maintains one outbound WebSocket to the relay worker (default `pie.0xfefe.me`), pushing
 * {@link WebSnapshot} frames and receiving remote prompt frames. The view token in the public URL
 * is a capability: watch + prompt + abort, never control-plane approval (see
 * docs/issues/22-web-relay.md). The agent key authenticates this process as the snapshot source
 * and never appears in the URL.
 *
 * Connection lifecycle: {@link start} spawns a task that connects, sends a `hello` frame, then
 * forwards snapshots (debounced) and prompt frames until {@link RelayHandle.shutdown} or process
 * exit. Drops reconnect with exponential backoff; viewers see an offline banner from the worker
 * side in the meantime.
 *
 * The worker end of this protocol is already TypeScript in this repo (`workers/fefe-hub/src/
 * relay.ts`, reused verbatim from pie) — the wire names below are cross-checked against it.
 *
 * RULEBOOK §2.2 mappings used here (each site also carries an inline note):
 * - `tokio::spawn` (relay.rs:190) → `detach()`.
 * - `mpsc::unbounded_channel` (relay.rs:182 + the four caller-supplied senders) → `AsyncQueue`.
 * - `tokio::select!` (relay.rs:227, 236, 262) → `selectN`.
 * - `tokio::time::sleep`/`interval` (relay.rs:237, 258) → a `SelectCase` that owns its timer and
 *   clears it when its own `signal` fires (the §2.2 `tokio::time::timeout` row, form ②; same
 *   idiom as `oauth.ts`'s `callbackTimeoutCase`).
 * - `parking_lot::Mutex<RelayShared>` (relay.rs:92) → a plain object: no critical section crosses
 *   an await (every `shared.lock()` in the oracle is a single field read/write), so §2.2's `Mutex`
 *   row selects direct field access.
 * - `CancellationToken` (relay.rs:23) → `AbortController`/`AbortSignal` (`cancel()` → `abort()`,
 *   `is_cancelled()` → `signal.aborted`, `cancelled().await` → {@link cancelledCase}).
 */

import { randomUUID } from "node:crypto";
import { AsyncQueue, detach, type SelectCase, selectN } from "@pie/agent-core";
import { emit } from "../logging.ts";
import type { WebSnapshot } from "./web.ts";

/** Tracing target for this module (oracle: `tracing::{warn,debug}!` with the module path). */
const LOG_TARGET = "pie::ui::relay";

/** relay.rs:28. Snapshot frames above this size are dropped (and counted) instead of sent. */
const MAX_SNAPSHOT_BYTES = 1024 * 1024;
/** relay.rs:30. Minimum interval between snapshot frames on the wire. */
const SNAPSHOT_DEBOUNCE_MS = 250;
/** relay.rs:222. First reconnect backoff. */
const INITIAL_BACKOFF_MS = 1000;
/** relay.rs:240. Backoff ceiling. */
const MAX_BACKOFF_MS = 60_000;

/**
 * relay.rs:33-45 (`AgentFrame`). Frames the agent sends to the worker. `#[serde(tag = "type",
 * rename_all = "snake_case")]` — the wire names are the literal strings below (RULEBOOK §2.1:
 * tagged union with the serde tag field, wire names verbatim).
 */
export type AgentFrame =
	/** First frame after connect; pins the agent key on the Durable Object (TOFU). */
	| { type: "hello"; agent_key: string }
	| { type: "snapshot"; data: unknown }
	/** Graceful `/web-disconnect`: the worker purges state and 404s the page. */
	| { type: "shutdown" };

/** relay.rs:48-68 (`WorkerFrame`). Frames the worker sends to the agent. */
export type WorkerFrame =
	| { type: "prompt"; text: string }
	| { type: "abort" }
	/**
	 * Remote approval of a pending control-plane prompt — first-class, identical to a local TUI
	 * confirmation (owner decision 2026-06-11; the capability URL grants it).
	 */
	| { type: "control_plane_resolve"; approve: boolean }
	| { type: "viewers"; count: number }
	/** Remote model switch from the shared web UI — first-class like `control_plane_resolve`. */
	| { type: "set_model"; model: string };

/** relay.rs:70-76 (`RelayState`). Unit-only enum → string literal union (RULEBOOK §2.1); the
 * literals are exactly the labels `status_line` renders (relay.rs:103-108). */
export type RelayState = "connecting" | "connected" | "reconnecting" | "stopped";

/** relay.rs:78-83 (`RelayShared`). Shared between the handle and the relay task. */
interface RelayShared {
	state: RelayState;
	viewers: number;
	droppedSnapshots: number;
}

/**
 * The four `mpsc::UnboundedSender`s `start` takes (relay.rs:170-176), grouped into one object
 * instead of four positional parameters. Each is the push half of the caller's event loop channel;
 * RULEBOOK §2.2 maps `mpsc` to the single shared `AsyncQueue` util, which carries both halves in
 * one object.
 */
export interface RelaySinks {
	/** relay.rs:172 `prompt_tx` — remote prompt text; the caller's event loop injects it through
	 * the same path as local submissions. */
	prompt: AsyncQueue<string>;
	/** relay.rs:173 `abort_tx` — remote abort of the in-flight turn (oracle payload is `()`). */
	abort: AsyncQueue<void>;
	/** relay.rs:174 `resolve_tx` — remote control-plane approve/deny. */
	resolve: AsyncQueue<boolean>;
	/** relay.rs:175 `model_tx` — remote model switch. */
	model: AsyncQueue<string>;
}

/**
 * The WebSocket surface this module uses. The global `WebSocket` (Node ≥22, WHATWG API — no new
 * dependency, RULEBOOK §1) satisfies it structurally; {@link RelayDeps.connect} exists so tests can
 * drive the relay task with an in-process double instead of a real socket.
 */
export interface RelaySocket {
	send(data: string): void;
	close(): void;
	addEventListener(type: string, listener: (event: any) => void, options?: { once?: boolean }): void;
	removeEventListener(type: string, listener: (event: any) => void): void;
}

/** Injection seam for {@link start} (repo convention: `cron-deps.ts`/`goal-deps.ts`). */
export interface RelayDeps {
	/** Opens the agent WebSocket. Defaults to the global `WebSocket`. */
	connect?: (url: string) => RelaySocket;
	/**
	 * Sink for a failure of the detached relay task (RULEBOOK §2.2 `tokio::spawn` row — `detach()`
	 * requires an explicit destination). Oracle's task cannot fail: every fallible step inside
	 * `relay_task` is already handled there, so this only ever fires on a port-level defect.
	 */
	onError?: (error: unknown) => void;
}

/**
 * relay.rs:85-93 (`RelayHandle`). Handle owned by the UI `App`. Dropping it does NOT stop the
 * relay; call {@link RelayHandle.shutdown}.
 */
export class RelayHandle {
	/** Public viewer URL (`https://…/session/<token>`). */
	readonly url: string;
	private readonly snapshotTx: AsyncQueue<WebSnapshot>;
	private readonly cancel: AbortController;
	private readonly shared: RelayShared;

	constructor(url: string, snapshotTx: AsyncQueue<WebSnapshot>, cancel: AbortController, shared: RelayShared) {
		this.url = url;
		this.snapshotTx = snapshotTx;
		this.cancel = cancel;
		this.shared = shared;
	}

	/** relay.rs:96-99 (`push_snapshot`). Queue a snapshot for the relay. Cheap; the task debounces
	 * on the wire. The send result is discarded exactly as oracle's `let _ = …send(snapshot)` does. */
	pushSnapshot(snapshot: WebSnapshot): void {
		this.snapshotTx.push(snapshot);
	}

	/** relay.rs:101-117 (`status_line`). */
	statusLine(): string {
		let line = `relay ${this.shared.state} — ${this.url} (viewers: ${this.shared.viewers})`;
		if (this.shared.droppedSnapshots > 0) {
			line += `, ${this.shared.droppedSnapshots} oversized snapshot(s) dropped`;
		}
		return line;
	}

	/** relay.rs:119-121 (`shutdown`). */
	shutdown(): void {
		this.cancel.abort();
	}
}

/**
 * relay.rs:124-130 (`new_token`). Generate a URL-safe 160-bit random token (40 lowercase hex
 * chars). Sourced from two v4 UUIDs (OS RNG) so no extra dependency is needed — `randomUUID()` is
 * the same construction (`uuid::Uuid::new_v4().simple()` = the 32 hex chars with the dashes
 * dropped), so the version/variant nibbles land in the same positions as oracle's.
 */
export function newToken(): string {
	const a = randomUUID().replaceAll("-", "");
	const b = randomUUID().replaceAll("-", "");
	return `${a}${b}`.slice(0, 40);
}

/**
 * relay.rs:132-143 (`agent_ws_url`). Derive the agent WebSocket URL from the configured https base
 * URL. Oracle's `trim_end_matches('/')` strips *every* trailing slash, and the bail message quotes
 * the untrimmed input — both reproduced.
 */
export function agentWsUrl(baseUrl: string, viewToken: string): string {
	const trimmed = baseUrl.replace(/\/+$/, "");
	let wsBase: string;
	if (trimmed.startsWith("https://")) {
		wsBase = `wss://${trimmed.slice("https://".length)}`;
	} else if (trimmed.startsWith("http://")) {
		wsBase = `ws://${trimmed.slice("http://".length)}`;
	} else {
		// relay.rs:140 `anyhow::bail!` → throw (RULEBOOK §2.4); the caller (`ui/mod.rs:501`)
		// renders it as `web-connect: {e}`.
		throw new Error(`relay base_url must be http(s)://, got ${baseUrl}`);
	}
	return `${wsBase}/relay/agent?token=${viewToken}`;
}

/**
 * relay.rs:145-150 (`viewer_url`). Public viewer URL for a token. Trailing slash is load-bearing:
 * the shared viewer HTML fetches relative paths (`state`, `events`, `prompt`), which must resolve
 * under the token segment.
 */
export function viewerUrl(baseUrl: string, viewToken: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/session/${viewToken}/`;
}

/**
 * relay.rs:152-166 (`qr_lines`). Render the viewer URL as a scannable QR code for the TUI feed.
 * Unicode half-block rendering, inverted so modules read dark-on-light on dark terminal themes
 * (phone cameras accept inverted QR codes).
 *
 * Oracle delegates to the `qrcode` crate; RULEBOOK §1 defaults to "NONE without a rule here" for
 * new dependencies, so the encoder itself is ported below (see the QR ENCODER section).
 *
 * @throws Error `qr encode: <reason>` — oracle's `map_err(|e| anyhow!("qr encode: {e}"))`
 * (relay.rs:158); `ui/mod.rs:524` renders it as `qr render skipped: {e}` and keeps going.
 */
export function qrLines(url: string): string[] {
	return renderDense1x2Inverted(qrEncodeByteMode(url));
}

/**
 * relay.rs:168-208 (`start`). Start the relay task. `sinks.prompt` receives remote prompt text;
 * the caller's event loop injects it through the same path as local submissions.
 *
 * @throws Error when `baseUrl` is not http(s):// (propagated from {@link agentWsUrl}).
 */
export function start(baseUrl: string, sinks: RelaySinks, deps: RelayDeps = {}): RelayHandle {
	const viewToken = newToken();
	const agentKey = newToken();
	const wsUrl = agentWsUrl(baseUrl, viewToken);
	const url = viewerUrl(baseUrl, viewToken);

	// relay.rs:182-188.
	const snapshotTx = new AsyncQueue<WebSnapshot>();
	const cancel = new AbortController();
	const shared: RelayShared = { state: "connecting", viewers: 0, droppedSnapshots: 0 };

	// relay.rs:190-200 `tokio::spawn(relay_task(...))` → RULEBOOK §2.2 `detach()`.
	const connect = deps.connect ?? connectWebSocket;
	const onError =
		deps.onError ??
		((error: unknown) => {
			emit("error", LOG_TARGET, `relay task failed: ${errorMessage(error)}`);
		});
	detach(() => relayTask({ wsUrl, agentKey, snapshotTx, sinks, cancel, shared, connect }), onError);

	// relay.rs:202-207.
	return new RelayHandle(url, snapshotTx, cancel, shared);
}

/** Default {@link RelayDeps.connect}: the global WHATWG `WebSocket` (RULEBOOK §1 — no new dep). */
function connectWebSocket(url: string): RelaySocket {
	return new WebSocket(url);
}

interface RelayTaskArgs {
	wsUrl: string;
	agentKey: string;
	snapshotTx: AsyncQueue<WebSnapshot>;
	sinks: RelaySinks;
	cancel: AbortController;
	shared: RelayShared;
	connect: (url: string) => RelaySocket;
}

/** What one socket delivered. Oracle reads these off `ws.next()` (relay.rs:295-325); the WHATWG
 * WebSocket API delivers them as events, so a per-connection `AsyncQueue` adapts events back into
 * the awaitable stream the `select!` branch needs. Non-text messages are dropped at the listener
 * (oracle: `Some(Ok(_)) => {}`, relay.rs:320 — ping/pong/binary ignored). */
type SocketEvent = { kind: "text"; text: string } | { kind: "closed" } | { kind: "error"; error: unknown };

/** Winner of the inner `select!` (relay.rs:262-327), tagged instead of index-matched. */
type LoopEvent =
	| { kind: "cancelled" }
	| { kind: "snapshot"; snapshot: WebSnapshot | undefined }
	| { kind: "tick" }
	| { kind: "incoming"; event: SocketEvent | undefined };

/** `cancel.cancelled()` as a `selectN` branch. Resolves once the token is cancelled; the losing
 * copy detaches its listener when its own `signal` fires. */
function cancelledCase<T>(cancel: AbortController, value: T): SelectCase<T> {
	return {
		run: (signal) =>
			new Promise<T>((resolve) => {
				if (cancel.signal.aborted) {
					resolve(value);
					return;
				}
				const onCancel = (): void => {
					signal.removeEventListener("abort", onLose);
					resolve(value);
				};
				const onLose = (): void => cancel.signal.removeEventListener("abort", onCancel);
				cancel.signal.addEventListener("abort", onCancel, { once: true });
				signal.addEventListener("abort", onLose, { once: true });
			}),
	};
}

/**
 * `tokio::time::sleep(d)` / `interval.tick()` as a `selectN` branch (RULEBOOK §2.2
 * `tokio::time::timeout` row, form ②): this branch owns its timer and clears it when its own
 * `signal` fires, i.e. when another branch won and `selectN` aborted this loser. A hand-rolled
 * `Promise.race` + `setTimeout` is forbidden there precisely because it leaks the timer.
 */
function sleepCase<T>(delayMs: number, value: T): SelectCase<T> {
	return {
		run: (signal) =>
			new Promise<T>((resolve) => {
				const timer = setTimeout(() => resolve(value), delayMs);
				signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
			}),
	};
}

/** relay.rs:227-230 — `connect_async` as a `selectN` branch. Rejects on a failed handshake
 * (oracle's `Err(err)` arm); closes the socket if it loses the race to cancellation. */
function connectCase(connect: (url: string) => RelaySocket, wsUrl: string): SelectCase<LoopEvent | RelaySocket> {
	return {
		run: (signal) =>
			new Promise<RelaySocket>((resolve, reject) => {
				let socket: RelaySocket;
				try {
					socket = connect(wsUrl);
				} catch (error) {
					reject(error instanceof Error ? error : new Error(String(error)));
					return;
				}
				const cleanup = (): void => {
					socket.removeEventListener("open", onOpen);
					socket.removeEventListener("error", onFail);
					socket.removeEventListener("close", onFail);
				};
				const onOpen = (): void => {
					cleanup();
					resolve(socket);
				};
				const onFail = (): void => {
					cleanup();
					reject(new Error("relay handshake failed"));
				};
				socket.addEventListener("open", onOpen, { once: true });
				socket.addEventListener("error", onFail, { once: true });
				socket.addEventListener("close", onFail, { once: true });
				signal.addEventListener(
					"abort",
					() => {
						cleanup();
						socket.close();
					},
					{ once: true },
				);
			}),
	};
}

/** relay.rs:210-332 (`relay_task`). */
async function relayTask(args: RelayTaskArgs): Promise<void> {
	const { wsUrl, agentKey, snapshotTx, sinks, cancel, shared, connect } = args;
	let backoffMs = INITIAL_BACKOFF_MS; // relay.rs:222

	// relay.rs:223 `loop {`
	for (;;) {
		if (cancel.signal.aborted) break; // relay.rs:224-226

		// relay.rs:227-243 — connect, racing cancellation.
		let socket: RelaySocket;
		try {
			const connected = await selectN<LoopEvent | RelaySocket>([
				connectCase(connect, wsUrl),
				cancelledCase<LoopEvent>(cancel, { kind: "cancelled" }),
			]);
			if (isLoopEvent(connected.value)) break; // relay.rs:229 `_ = cancel.cancelled() => break`
			socket = connected.value;
		} catch (error) {
			// relay.rs:233-242.
			emit("warn", LOG_TARGET, "relay connect failed; retrying", { error: errorMessage(error) });
			shared.state = "reconnecting";
			const slept = await selectN<"slept" | "cancelled">([
				sleepCase(backoffMs, "slept" as const),
				cancelledCase(cancel, "cancelled" as const),
			]);
			if (slept.value === "cancelled") break;
			backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
			continue;
		}
		backoffMs = INITIAL_BACKOFF_MS; // relay.rs:244

		const inbox = new AsyncQueue<SocketEvent>();
		const onMessage = (event: { data?: unknown }): void => {
			// relay.rs:297 `Some(Ok(Message::Text(text)))`; every other frame kind is ignored
			// (relay.rs:320), so it never enters the queue at all.
			if (typeof event.data === "string") inbox.push({ kind: "text", text: event.data });
		};
		const onClose = (): void => {
			inbox.push({ kind: "closed" }); // relay.rs:319
		};
		const onSocketError = (event: unknown): void => {
			inbox.push({ kind: "error", error: event }); // relay.rs:321
		};
		socket.addEventListener("message", onMessage);
		socket.addEventListener("close", onClose);
		socket.addEventListener("error", onSocketError);
		const releaseSocket = (): void => {
			socket.removeEventListener("message", onMessage);
			socket.removeEventListener("close", onClose);
			socket.removeEventListener("error", onSocketError);
			inbox.close();
			socket.close();
		};

		// relay.rs:246-253 — hello. `ws.send(...).is_err()` → a throwing `send` (socket already
		// closing) takes the same reconnect path.
		const hello = JSON.stringify({ type: "hello", agent_key: agentKey } satisfies AgentFrame);
		try {
			socket.send(hello);
		} catch {
			shared.state = "reconnecting";
			releaseSocket();
			continue;
		}
		shared.state = "connected"; // relay.rs:254

		// relay.rs:256-259. `Instant` → `performance.now()` (RULEBOOK §2.3). `nextTick` starts now
		// because `tokio::time::interval` fires its first tick immediately;
		// `MissedTickBehavior::Skip` is the `while (nextTick <= now)` advance below.
		let lastSent = performance.now() - SNAPSHOT_DEBOUNCE_MS;
		let pending: WebSnapshot | undefined;
		let nextTick = performance.now();

		// relay.rs:261-328 inner `loop { tokio::select! { … } }`. Branch order matches the oracle's
		// declaration order; `selectN` breaks same-tick ties by that order.
		for (;;) {
			const cases: SelectCase<LoopEvent>[] = [
				cancelledCase<LoopEvent>(cancel, { kind: "cancelled" }),
				{
					run: async (signal): Promise<LoopEvent> => ({
						kind: "snapshot",
						snapshot: await snapshotTx.next(signal),
					}),
				},
			];
			// relay.rs:280 `_ = flush.tick(), if pending.is_some()` — a disabled branch is not
			// polled at all, so it is simply absent from the case list when `pending` is empty.
			if (pending !== undefined) {
				cases.push(sleepCase<LoopEvent>(Math.max(0, nextTick - performance.now()), { kind: "tick" }));
			}
			cases.push({
				run: async (signal): Promise<LoopEvent> => ({ kind: "incoming", event: await inbox.next(signal) }),
			});

			const { value } = await selectN<LoopEvent>(cases);

			if (value.kind === "cancelled") {
				// relay.rs:263-270.
				const bye = JSON.stringify({ type: "shutdown" } satisfies AgentFrame);
				try {
					socket.send(bye);
				} catch {
					// `let _ = ws.send(...)` — oracle discards the result.
				}
				releaseSocket();
				shared.state = "stopped";
				return;
			}

			if (value.kind === "snapshot") {
				// relay.rs:271-279.
				if (value.snapshot !== undefined) {
					pending = value.snapshot;
				} else {
					// App dropped the sender — treat as shutdown.
					cancel.abort();
				}
				continue;
			}

			if (value.kind === "tick") {
				// relay.rs:280-294.
				const now = performance.now();
				while (nextTick <= now) nextTick += SNAPSHOT_DEBOUNCE_MS; // MissedTickBehavior::Skip
				if (now - lastSent >= SNAPSHOT_DEBOUNCE_MS && pending !== undefined) {
					const snapshot = pending;
					pending = undefined; // `pending.take()`
					const frame = snapshotFrame(snapshot);
					if (frame !== undefined) {
						try {
							socket.send(frame);
						} catch {
							break; // relay.rs:287 `if ws.send(...).is_err() { break; }`
						}
						lastSent = performance.now();
					} else {
						shared.droppedSnapshots += 1; // relay.rs:291
					}
				}
				continue;
			}

			// relay.rs:295-326 — `incoming = ws.next()`.
			const event = value.event;
			if (event === undefined || event.kind === "closed") {
				break; // relay.rs:319 `Some(Ok(Message::Close(_))) | None => break`
			}
			if (event.kind === "error") {
				// relay.rs:321-324.
				emit("warn", LOG_TARGET, "relay socket error", { error: errorMessage(event.error) });
				break;
			}
			const frame = parseWorkerFrame(event.text);
			if (frame === undefined) {
				// relay.rs:314-316 — serde rejected the frame.
				emit("debug", LOG_TARGET, "unrecognized relay frame");
				continue;
			}
			switch (frame.type) {
				case "prompt":
					sinks.prompt.push(frame.text); // relay.rs:299-301
					break;
				case "abort":
					sinks.abort.push(undefined); // relay.rs:302-304
					break;
				case "control_plane_resolve":
					sinks.resolve.push(frame.approve); // relay.rs:305-307
					break;
				case "viewers":
					shared.viewers = frame.count; // relay.rs:308-310
					break;
				case "set_model":
					sinks.model.push(frame.model); // relay.rs:311-313
					break;
			}
		}

		releaseSocket();
		// relay.rs:329 — every inner-loop exit other than cancellation (which `return`s above) falls
		// back to the outer loop, whose first statement re-checks the cancellation token.
		shared.state = "reconnecting";
	}
	shared.state = "stopped"; // relay.rs:331
}

function isLoopEvent(value: LoopEvent | RelaySocket): value is LoopEvent {
	return typeof (value as LoopEvent).kind === "string";
}

/**
 * relay.rs:334-339 (`snapshot_frame`). Serialize a snapshot frame, or `undefined` when it exceeds
 * {@link MAX_SNAPSHOT_BYTES}.
 *
 * The size gate is on *bytes*: Rust's `String::len()` is the UTF-8 byte length, so a snapshot full
 * of multi-byte text must be measured with `Buffer.byteLength`, not `String.length` (UTF-16 code
 * units) — otherwise a snapshot the oracle drops would go out on the wire (and be rejected by the
 * worker's own `MAX_AGENT_FRAME_BYTES`).
 */
export function snapshotFrame(snapshot: WebSnapshot): string | undefined {
	let frame: string;
	try {
		// Oracle's two fallible steps (`to_value` then `to_string`) collapse to one here; both map
		// to `None` on failure, which is what a `JSON.stringify` throw (cycle) produces.
		frame = JSON.stringify({ type: "snapshot", data: snapshot } satisfies AgentFrame);
	} catch {
		return undefined;
	}
	return Buffer.byteLength(frame, "utf8") <= MAX_SNAPSHOT_BYTES ? frame : undefined;
}

/**
 * relay.rs:298 `serde_json::from_str::<WorkerFrame>(&text)` — returns `undefined` where serde
 * returns `Err` (unknown/absent tag, missing field, wrong type). Unknown *extra* fields are
 * accepted, matching serde's default. `count` is `u64` on the oracle, so a negative or fractional
 * viewer count is a decode error, not a silently truncated number.
 */
export function parseWorkerFrame(text: string): WorkerFrame | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const frame = value as Record<string, unknown>;
	switch (frame.type) {
		case "prompt":
			return typeof frame.text === "string" ? { type: "prompt", text: frame.text } : undefined;
		case "abort":
			return { type: "abort" };
		case "control_plane_resolve":
			return typeof frame.approve === "boolean"
				? { type: "control_plane_resolve", approve: frame.approve }
				: undefined;
		case "viewers":
			return typeof frame.count === "number" && Number.isInteger(frame.count) && frame.count >= 0
				? { type: "viewers", count: frame.count }
				: undefined;
		case "set_model":
			return typeof frame.model === "string" ? { type: "set_model", model: frame.model } : undefined;
		default:
			return undefined;
	}
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "object" && error !== null && "type" in error) return String((error as { type: unknown }).type);
	return String(error);
}

// ── QR ENCODER ────────────────────────────────────────────────────────────────────────────────
//
// Port of the `qrcode` crate surface oracle uses at relay.rs:155-165: `QrCode::new(bytes)` (byte
// mode, error-correction level M, smallest fitting version) rendered through
// `render::unicode::Dense1x2` with the dark/light colors swapped and a quiet zone.
//
// RULEBOOK §1 forbids adding a dependency without a rulebook row, so the encoder is ported rather
// than swapped for an npm QR package. It implements ISO/IEC 18004 for the single configuration the
// call site needs.
//
// TODO(port): three details that cannot be diffed byte-for-byte against the crate in this repo
// (cargo is denied here):
//   1. Versions are capped at 10 (213 bytes at level M) instead of the crate's 40. Every URL this
//      call site produces is `<base>/session/<40 hex>/` — 71 bytes for both the default
//      `https://pie.0xfefe.me` base and a `http://127.0.0.1:8787` dev base, i.e. version 5. A base
//      URL longer than ~190 chars throws `qr encode: data too long` where the crate would emit a
//      larger symbol; the caller (`ui/mod.rs:524`) degrades to `qr render skipped: {e}`.
//   2. The crate's `QrCode::new` runs a mode-optimizing segmenter (numeric/alphanumeric/byte);
//      this encoder always uses one byte segment. For the URLs above the optimizer picks the same
//      thing (lowercase hex + lowercase host are outside the alphanumeric charset, so no segment
//      switch pays for itself), but a hypothetical all-uppercase base URL could encode into a
//      smaller symbol on the oracle side.
//   3. The half-block renderer assumes a 4-module quiet zone on every side and treats the row past
//      the bottom edge of an odd-height grid as light (background). Both match the standard and the
//      crate's documented behavior; neither is asserted byte-for-byte here.
// None of this is parity-observable: `/web-connect` needs the network and no parity scenario runs
// it. The oracle's own test asserts the same structural properties this port's test does.

/** Data codewords + EC structure for error-correction level M, versions 1..10 (ISO/IEC 18004
 * Table 9). `groups` is `[blockCount, dataCodewordsPerBlock]` pairs. */
const QR_VERSIONS_M: ReadonlyArray<{ ecPerBlock: number; groups: ReadonlyArray<readonly [number, number]> }> = [
	{ ecPerBlock: 10, groups: [[1, 16]] }, // v1
	{ ecPerBlock: 16, groups: [[1, 28]] }, // v2
	{ ecPerBlock: 26, groups: [[1, 44]] }, // v3
	{ ecPerBlock: 18, groups: [[2, 32]] }, // v4
	{ ecPerBlock: 24, groups: [[2, 43]] }, // v5
	{ ecPerBlock: 16, groups: [[4, 27]] }, // v6
	{ ecPerBlock: 18, groups: [[4, 31]] }, // v7
	{
		ecPerBlock: 22,
		groups: [
			[2, 38],
			[2, 39],
		],
	}, // v8
	{
		ecPerBlock: 22,
		groups: [
			[3, 36],
			[2, 37],
		],
	}, // v9
	{
		ecPerBlock: 26,
		groups: [
			[4, 43],
			[1, 44],
		],
	}, // v10
];

/** Alignment-pattern centre coordinates per version (ISO/IEC 18004 Table E.1), versions 1..10. */
const QR_ALIGNMENT_POSITIONS: ReadonlyArray<readonly number[]> = [
	[],
	[6, 18],
	[6, 22],
	[6, 26],
	[6, 30],
	[6, 34],
	[6, 22, 38],
	[6, 24, 42],
	[6, 26, 46],
	[6, 28, 50],
];

/** Remainder bits appended after the interleaved codewords (ISO/IEC 18004 Table 1), versions 1..10. */
const QR_REMAINDER_BITS: readonly number[] = [0, 7, 7, 7, 7, 7, 0, 0, 0, 0];

/** Format-information bits for error-correction level M (ISO/IEC 18004 Table 12). */
const QR_EC_LEVEL_M_BITS = 0b00;

/** A finished symbol: `modules[row][col]` is 1 for a dark module. */
export interface QrMatrix {
	size: number;
	modules: Uint8Array[];
}

/** GF(256) exp/log tables for the QR primitive polynomial x⁸+x⁴+x³+x²+1 (0x11d). */
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
	let x = 1;
	for (let i = 0; i < 255; i++) {
		GF_EXP[i] = x;
		GF_LOG[x] = i;
		x <<= 1;
		if (x & 0x100) x ^= 0x11d;
	}
	for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}

function gfMul(a: number, b: number): number {
	if (a === 0 || b === 0) return 0;
	return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** Reed–Solomon generator polynomial of `degree` = ∏(x − α^i), coefficients high-order first. */
export function qrGeneratorPolynomial(degree: number): Uint8Array {
	let poly = Uint8Array.of(1);
	for (let i = 0; i < degree; i++) {
		const next = new Uint8Array(poly.length + 1);
		for (let j = 0; j < poly.length; j++) {
			next[j] ^= poly[j];
			next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
		}
		poly = next;
	}
	return poly;
}

/** Reed–Solomon error-correction codewords for one block. */
function qrEcCodewords(data: Uint8Array, ecLength: number): Uint8Array {
	const generator = qrGeneratorPolynomial(ecLength);
	const remainder = new Uint8Array(ecLength);
	for (const byte of data) {
		const factor = byte ^ remainder[0];
		remainder.copyWithin(0, 1);
		remainder[ecLength - 1] = 0;
		for (let i = 0; i < ecLength; i++) remainder[i] ^= gfMul(generator[i + 1], factor);
	}
	return remainder;
}

/** BCH remainder used by both the format (generator 0x537, 10 check bits) and version (0x1f25,
 * 12 check bits) information. */
function bchRemainder(data: number, generator: number, checkBits: number): number {
	let rest = data;
	for (let i = 14 + checkBits; i >= checkBits; i--) {
		if (rest & (1 << i)) rest ^= generator << (i - checkBits);
	}
	return rest;
}

/** 15-bit format information for EC level `ecLevelBits` and `mask` (ISO/IEC 18004 §8.9). */
export function qrFormatInfo(ecLevelBits: number, mask: number): number {
	const data = ((ecLevelBits << 3) | mask) << 10;
	return ((data | bchRemainder(data, 0b10100110111, 10)) ^ 0b101010000010010) & 0x7fff;
}

/** 18-bit version information for versions ≥ 7 (ISO/IEC 18004 §8.10). */
export function qrVersionInfo(version: number): number {
	const data = version << 12;
	return (data | bchRemainder(data, 0b1111100100101, 12)) & 0x3ffff;
}

/**
 * Encode `text` (UTF-8 bytes, byte mode, EC level M, smallest fitting version 1..10) into a QR
 * matrix — the `QrCode::new(url.as_bytes())` half of relay.rs:157-158.
 */
export function qrEncodeByteMode(text: string): QrMatrix {
	const data = new TextEncoder().encode(text);
	const version = qrPickVersion(data.length);
	const spec = QR_VERSIONS_M[version - 1];
	const dataCodewords = qrDataCodewords(version);

	// ── Data codewords: mode indicator, character count, payload, terminator, padding.
	const bits: number[] = [];
	const pushBits = (value: number, count: number): void => {
		for (let i = count - 1; i >= 0; i--) bits.push((value >> i) & 1);
	};
	pushBits(0b0100, 4);
	pushBits(data.length, qrCountBits(version));
	for (const byte of data) pushBits(byte, 8);
	const capacityBits = dataCodewords * 8;
	for (let i = 0; i < 4 && bits.length < capacityBits; i++) bits.push(0);
	while (bits.length % 8 !== 0) bits.push(0);
	const codewords = new Uint8Array(dataCodewords);
	const encodedBytes = bits.length / 8;
	for (let i = 0; i < encodedBytes; i++) {
		let byte = 0;
		for (let b = 0; b < 8; b++) byte = (byte << 1) | bits[i * 8 + b];
		codewords[i] = byte;
	}
	for (let i = encodedBytes, pad = 0; i < dataCodewords; i++, pad++) {
		codewords[i] = pad % 2 === 0 ? 0xec : 0x11;
	}

	// ── Split into blocks, compute EC, interleave (ISO/IEC 18004 §8.6).
	const dataBlocks: Uint8Array[] = [];
	const ecBlocks: Uint8Array[] = [];
	let offset = 0;
	for (const [blocks, perBlock] of spec.groups) {
		for (let b = 0; b < blocks; b++) {
			const block = codewords.subarray(offset, offset + perBlock);
			offset += perBlock;
			dataBlocks.push(block);
			ecBlocks.push(qrEcCodewords(block, spec.ecPerBlock));
		}
	}
	const interleaved: number[] = [];
	const maxData = Math.max(...dataBlocks.map((block) => block.length));
	for (let i = 0; i < maxData; i++) {
		for (const block of dataBlocks) if (i < block.length) interleaved.push(block[i]);
	}
	for (let i = 0; i < spec.ecPerBlock; i++) {
		for (const block of ecBlocks) interleaved.push(block[i]);
	}

	// ── Lay out the symbol.
	const size = version * 4 + 17;
	const modules = Array.from({ length: size }, () => new Uint8Array(size));
	const reserved = Array.from({ length: size }, () => new Uint8Array(size));
	qrDrawFunctionPatterns(modules, reserved, size, version);
	qrPlaceData(modules, reserved, size, interleaved, QR_REMAINDER_BITS[version - 1]);

	// ── Mask selection: apply each mask, score, keep the best (ISO/IEC 18004 §8.8).
	let bestPenalty = Number.POSITIVE_INFINITY;
	let bestModules = modules;
	for (let mask = 0; mask < 8; mask++) {
		const candidate = modules.map((row) => Uint8Array.from(row));
		for (let r = 0; r < size; r++) {
			for (let c = 0; c < size; c++) {
				if (!reserved[r][c] && qrMaskBit(mask, r, c)) candidate[r][c] ^= 1;
			}
		}
		qrDrawFormatInfo(candidate, size, mask);
		if (version >= 7) qrDrawVersionInfo(candidate, size, version);
		const penalty = qrPenalty(candidate, size);
		if (penalty < bestPenalty) {
			bestPenalty = penalty;
			bestModules = candidate;
		}
	}
	return { size, modules: bestModules };
}

/** Level-M data codewords for `version`. */
function qrDataCodewords(version: number): number {
	return QR_VERSIONS_M[version - 1].groups.reduce((sum, [blocks, perBlock]) => sum + blocks * perBlock, 0);
}

/** Smallest version 1..10 whose level-M data capacity holds `byteLength` bytes in byte mode. */
function qrPickVersion(byteLength: number): number {
	for (let version = 1; version <= QR_VERSIONS_M.length; version++) {
		if (4 + qrCountBits(version) + byteLength * 8 <= qrDataCodewords(version) * 8) return version;
	}
	// Oracle surfaces the crate's `QrError::DataTooLong` through `anyhow!("qr encode: {e}")`.
	throw new Error("qr encode: data too long");
}

/** Character-count field width for byte mode (8 bits for versions 1..9, 16 for 10..26). */
function qrCountBits(version: number): number {
	return version <= 9 ? 8 : 16;
}

function qrDrawFunctionPatterns(modules: Uint8Array[], reserved: Uint8Array[], size: number, version: number): void {
	const set = (r: number, c: number, dark: number): void => {
		if (r < 0 || c < 0 || r >= size || c >= size) return;
		modules[r][c] = dark;
		reserved[r][c] = 1;
	};
	// Finder patterns + separators.
	for (const [r0, c0] of [
		[0, 0],
		[0, size - 7],
		[size - 7, 0],
	]) {
		for (let dr = -1; dr <= 7; dr++) {
			for (let dc = -1; dc <= 7; dc++) {
				const inner = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
				const ring = dr === 0 || dr === 6 || dc === 0 || dc === 6;
				const core = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
				set(r0 + dr, c0 + dc, inner && (ring || core) ? 1 : 0);
			}
		}
	}
	// Timing patterns.
	for (let i = 8; i < size - 8; i++) {
		const dark = i % 2 === 0 ? 1 : 0;
		set(6, i, dark);
		set(i, 6, dark);
	}
	// Alignment patterns (skipped where they would collide with a finder).
	const positions = QR_ALIGNMENT_POSITIONS[version - 1];
	const last = positions.length > 0 ? positions[positions.length - 1] : 0;
	for (const r of positions) {
		for (const c of positions) {
			if ((r === 6 && c === 6) || (r === 6 && c === last) || (r === last && c === 6)) continue;
			for (let dr = -2; dr <= 2; dr++) {
				for (let dc = -2; dc <= 2; dc++) {
					set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) === 1 ? 0 : 1);
				}
			}
		}
	}
	// Dark module + reserved format/version areas (drawn light here; filled in per mask later).
	set(size - 8, 8, 1);
	for (let i = 0; i <= 8; i++) {
		if (!reserved[8][i]) set(8, i, 0);
		if (!reserved[i][8]) set(i, 8, 0);
	}
	for (let i = 0; i < 8; i++) {
		if (!reserved[8][size - 1 - i]) set(8, size - 1 - i, 0);
		if (!reserved[size - 1 - i][8]) set(size - 1 - i, 8, 0);
	}
	if (version >= 7) {
		for (let i = 0; i < 18; i++) {
			const a = size - 11 + (i % 3);
			const b = Math.floor(i / 3);
			set(b, a, 0);
			set(a, b, 0);
		}
	}
}

/** Zig-zag data placement, two columns at a time from the bottom-right, skipping column 6. */
function qrPlaceData(
	modules: Uint8Array[],
	reserved: Uint8Array[],
	size: number,
	codewords: readonly number[],
	remainderBits: number,
): void {
	const totalBits = codewords.length * 8 + remainderBits;
	const bitAt = (index: number): number => {
		if (index >= codewords.length * 8) return 0; // remainder bits are zero
		return (codewords[index >> 3] >> (7 - (index & 7))) & 1;
	};
	let index = 0;
	let upward = true;
	for (let right = size - 1; right >= 1; right -= 2) {
		if (right === 6) right = 5;
		for (let step = 0; step < size; step++) {
			const row = upward ? size - 1 - step : step;
			for (let c = 0; c < 2; c++) {
				const col = right - c;
				if (reserved[row][col]) continue;
				modules[row][col] = index < totalBits ? bitAt(index) : 0;
				index += 1;
			}
		}
		upward = !upward;
	}
}

function qrMaskBit(mask: number, r: number, c: number): boolean {
	switch (mask) {
		case 0:
			return (r + c) % 2 === 0;
		case 1:
			return r % 2 === 0;
		case 2:
			return c % 3 === 0;
		case 3:
			return (r + c) % 3 === 0;
		case 4:
			return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
		case 5:
			return ((r * c) % 2) + ((r * c) % 3) === 0;
		case 6:
			return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
		default:
			return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
	}
}

function qrDrawFormatInfo(modules: Uint8Array[], size: number, mask: number): void {
	const bits = qrFormatInfo(QR_EC_LEVEL_M_BITS, mask);
	const bit = (i: number): number => (bits >> i) & 1;
	for (let i = 0; i <= 5; i++) modules[i][8] = bit(i);
	modules[7][8] = bit(6);
	modules[8][8] = bit(7);
	modules[8][7] = bit(8);
	for (let i = 9; i < 15; i++) modules[8][14 - i] = bit(i);
	for (let i = 0; i < 8; i++) modules[8][size - 1 - i] = bit(i);
	for (let i = 8; i < 15; i++) modules[size - 15 + i][8] = bit(i);
	modules[size - 8][8] = 1;
}

function qrDrawVersionInfo(modules: Uint8Array[], size: number, version: number): void {
	const bits = qrVersionInfo(version);
	for (let i = 0; i < 18; i++) {
		const value = (bits >> i) & 1;
		const a = size - 11 + (i % 3);
		const b = Math.floor(i / 3);
		modules[b][a] = value;
		modules[a][b] = value;
	}
}

/** ISO/IEC 18004 §8.8.2 mask penalty (rules N1..N4 with weights 3/3/40/10). */
function qrPenalty(modules: readonly Uint8Array[], size: number): number {
	let penalty = 0;
	const finder = [1, 0, 1, 1, 1, 0, 1];
	for (let i = 0; i < size; i++) {
		for (const horizontal of [true, false]) {
			let runColor = -1;
			let runLength = 0;
			const line: number[] = [];
			for (let j = 0; j < size; j++) {
				const value = horizontal ? modules[i][j] : modules[j][i];
				line.push(value);
				if (value === runColor) {
					runLength += 1;
					if (runLength === 5) penalty += 3;
					else if (runLength > 5) penalty += 1;
				} else {
					runColor = value;
					runLength = 1;
				}
			}
			// N3: finder-like 1:1:3:1:1 pattern with four light modules on either side.
			for (let j = 0; j + 6 < size; j++) {
				if (!finder.every((bit, k) => line[j + k] === bit)) continue;
				const before = line.slice(Math.max(0, j - 4), j);
				const after = line.slice(j + 7, j + 11);
				if (before.length === 4 && before.every((b) => b === 0)) penalty += 40;
				if (after.length === 4 && after.every((b) => b === 0)) penalty += 40;
			}
		}
	}
	// N2: 2×2 blocks of one color.
	for (let r = 0; r + 1 < size; r++) {
		for (let c = 0; c + 1 < size; c++) {
			const value = modules[r][c];
			if (modules[r][c + 1] === value && modules[r + 1][c] === value && modules[r + 1][c + 1] === value) {
				penalty += 3;
			}
		}
	}
	// N4: deviation of the dark-module ratio from 50%.
	let dark = 0;
	for (let r = 0; r < size; r++) {
		for (let c = 0; c < size; c++) dark += modules[r][c];
	}
	const total = size * size;
	const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
	return penalty + Math.max(0, k) * 10;
}

/**
 * The `render::<unicode::Dense1x2>().dark_color(Light).light_color(Dark).quiet_zone(true)` half of
 * relay.rs:159-165: two vertical modules per character, with dark and light swapped so the symbol
 * reads dark-on-light on a dark terminal (a light module prints ink, a dark module prints a gap).
 */
export function renderDense1x2Inverted(matrix: QrMatrix): string[] {
	const QUIET_ZONE = 4;
	const dim = matrix.size + QUIET_ZONE * 2;
	const isLight = (r: number, c: number): boolean => {
		const row = r - QUIET_ZONE;
		const col = c - QUIET_ZONE;
		if (row < 0 || col < 0 || row >= matrix.size || col >= matrix.size) return true; // quiet zone
		return matrix.modules[row][col] === 0;
	};
	const lines: string[] = [];
	for (let r = 0; r < dim; r += 2) {
		let line = "";
		for (let c = 0; c < dim; c++) {
			const top = isLight(r, c);
			// A grid with an odd number of rows leaves the bottom half of the last line outside the
			// symbol; that is background, i.e. light.
			const bottom = r + 1 < dim ? isLight(r + 1, c) : true;
			line += top ? (bottom ? "█" : "▀") : bottom ? "▄" : " ";
		}
		lines.push(line);
	}
	return lines;
}
