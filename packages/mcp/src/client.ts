/**
 * MCP client. Dispatches requests over a `Transport`, routes responses back to the caller via
 * a per-id one-shot resolver, owns the initialize handshake, and exposes `tools/list` +
 * `tools/call`.
 *
 * pie: crates/mcp/src/client.rs.
 *
 * Concurrency mapping (RULEBOOK §2.2), all single-threaded-JS simplifications applied per the
 * "crosses an await → the AsyncMutex util; does not cross an await → direct field access" rule: every `parking_lot::Mutex<T>` in
 * the oracle (`inflight`, `initialized`, `catalog`, `notify_rx`) guards state that's only ever
 * touched synchronously between awaits in this single-threaded runtime, so each becomes a plain
 * class field — no lock wrapper needed. `oneshot::channel()` -> `Promise.withResolvers()`.
 * `tokio::select! { biased; ... }` (client.rs:296-307) -> `raceCancellable` (internal/
 * async-utils.ts), which preserves the "response wins over a same-tick cancel" bias. The
 * detached read pump (`tokio::spawn`, client.rs:95) -> a fire-and-forget async IIFE; this file
 * has no `reportDetachedError`-style sink to route failures to (the oracle crate is
 * `agent-core`-free, so none exists here either) — matching oracle, the pump only ever reports
 * failures by draining `inflight` with a synthesized transport-closed error, never externally.
 */
import { McpError } from "./errors.ts";
import {
	type AsyncChannelReceiver,
	type AsyncChannelSender,
	createChannel,
	createResolvablePromise,
	raceCancellable,
	withDeadline,
} from "./internal/async-utils.ts";
import type {
	CancelledNotificationParams,
	ClientCapabilitiesSpec,
	ClientInfo,
	InitializeParams,
	InitializeResult,
	McpTool,
	McpToolCallResult,
	RpcError,
	ToolsCallParams,
	ToolsListResult,
} from "./protocol.ts";
import {
	makeNotification,
	makeRequest,
	normalizeMcpTool,
	normalizeMcpToolCallResult,
	PROTOCOL_VERSION,
} from "./protocol.ts";
import type { Transport } from "./transport.ts";

/**
 * Best-effort upper bound on how long we'll wait for the outbound `notifications/cancelled`
 * frame to flush before returning `McpError.cancelled()`. pie: client.rs:28
 * (`CANCEL_NOTIFY_SEND_BUDGET`).
 */
const CANCEL_NOTIFY_SEND_BUDGET_MS = 200;

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

// pie: client.rs:29 (Cargo.toml CARGO_PKG_VERSION of the pie-mcp crate). Sent as
// `clientInfo.version` during the initialize handshake — informational only, does not affect
// wire shape/behavior.
const MCP_CLIENT_VERSION = "0.75.0";

type InflightSettlement = { ok: true; value: unknown } | { ok: false; error: RpcError };

/**
 * One server-pushed JSON-RPC notification surfaced by `McpClient.takeNotifications`.
 *
 * pie: client.rs:58-65 (`struct McpServerNotification`).
 */
export interface McpServerNotification {
	/** JSON-RPC `method` field, e.g. `"notifications/tools/listChanged"`. */
	method: string;
	/** JSON-RPC `params` field (typically a JSON object). `null` when the server omitted it. */
	params: unknown;
}

/** Narrow view over the notification channel handed to `takeNotifications` callers. */
export type NotificationReceiver = AsyncChannelReceiver<McpServerNotification>;

/**
 * Caller-facing capabilities advertised to the server. v1 advertises nothing — we're a
 * pure-consumer client (we run their tools, not the other way around).
 *
 * pie: client.rs:69-70 (`struct ClientCapabilities;` — unit struct). biome.json already
 * disables `noEmptyInterface` project-wide, so no suppression comment is needed here.
 */
export interface ClientCapabilities {}

/** `value.get("id").and_then(|v| v.as_u64())` — non-negative integers only; strings/floats/negatives are "absent". */
// TODO(port): JSON.parse collapses 1.0/1 — serde Float-vs-U64 distinction unreachable (ED4)
function asU64(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** `serde_json::from_value::<RpcError>(value)` — requires `code: number` + `message: string`; anything else fails to deserialize. */
function tryParseRpcError(value: unknown): RpcError | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const obj = value as Record<string, unknown>;
	if (typeof obj.code !== "number" || typeof obj.message !== "string") return undefined;
	return { code: obj.code, message: obj.message, data: "data" in obj ? obj.data : undefined };
}

export class McpClient {
	private readonly transport: Transport;
	private nextId = 1;
	private readonly inflight = new Map<number, (settlement: InflightSettlement) => void>();
	private initialized = false;
	private requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
	/** Server tool catalog after `tools/list` succeeds. Cached so consumers don't re-fetch. */
	private catalog: McpTool[] = [];
	private readonly notifySender: AsyncChannelSender<McpServerNotification>;
	private readonly notifyReceiver: AsyncChannelReceiver<McpServerNotification>;
	private notifyTaken = false;

	/** Build a client over an existing transport. Spawns the read pump immediately. */
	constructor(transport: Transport) {
		this.transport = transport;
		const { sender, receiver } = createChannel<McpServerNotification>();
		this.notifySender = sender;
		this.notifyReceiver = receiver;
		void this.runReadPump();
	}

	/**
	 * Take ownership of the server-notification receiver. Returns the receiver on the first
	 * call and `undefined` on every call thereafter. If no consumer ever calls this,
	 * server-pushed notifications buffer inside the channel until the client is dropped —
	 * equivalent to the prior silent-drop behaviour.
	 */
	takeNotifications(): NotificationReceiver | undefined {
		if (this.notifyTaken) return undefined;
		this.notifyTaken = true;
		return this.notifyReceiver;
	}

	withTimeout(ms: number): this {
		this.requestTimeoutMs = ms;
		return this;
	}

	/** Run the initialize handshake. Sends `initialize` then notifies `notifications/initialized`. */
	async initialize(clientName: string): Promise<InitializeResult> {
		const capabilities: ClientCapabilitiesSpec = {};
		const clientInfo: ClientInfo = { name: clientName, version: MCP_CLIENT_VERSION };
		const params: InitializeParams = { protocolVersion: PROTOCOL_VERSION, capabilities, clientInfo };
		const result = await this.request<InitializeParams, InitializeResult>("initialize", params);
		const note = makeNotification<undefined>("notifications/initialized", undefined);
		// pie: client.rs:201-203 (`self.transport.send_line(serde_json::to_string(&note)?).await?;`)
		// — `?` routes a serialize failure through `From<serde_json::Error> for McpError` (protocol
		// code), not a raw error type. `JSON.stringify` has no such mapping by default.
		let line: string;
		try {
			line = JSON.stringify(note);
		} catch (error) {
			throw McpError.fromJsonError(error);
		}
		await this.transport.sendLine(line);
		this.initialized = true;
		return result;
	}

	isInitialized(): boolean {
		return this.initialized;
	}

	/** Fetch the server's tool catalog and cache it. */
	async toolsList(): Promise<McpTool[]> {
		if (!this.isInitialized()) throw McpError.notInitialized();
		const result = await this.request<undefined, ToolsListResult>("tools/list", undefined);
		// pie: protocol.rs:51-52 (`#[serde(default)]` on `inputSchema`) — apply the missing-key
		// default at the parsing boundary; see `normalizeMcpTool`.
		const tools = result.tools.map((tool) => normalizeMcpTool(tool as unknown as Record<string, unknown>));
		this.catalog = [...tools];
		return tools;
	}

	getCatalog(): McpTool[] {
		return [...this.catalog];
	}

	/**
	 * Invoke a server-side tool. If `signal` is provided, the call races the cancel signal —
	 * when it fires before the server responds, the in-flight entry is dropped, a best-effort
	 * `notifications/cancelled` frame is sent so the server can stop work, and the call rejects
	 * with `McpError.cancelled()`. Callers that don't need active cancellation can omit `signal`
	 * and get the prior pure-timeout behaviour.
	 */
	async toolsCall(name: string, args: unknown, signal?: AbortSignal): Promise<McpToolCallResult> {
		if (!this.isInitialized()) throw McpError.notInitialized();
		const params: ToolsCallParams = { name, arguments: args };
		const result = await this.request<ToolsCallParams, McpToolCallResult>("tools/call", params, signal);
		// pie: protocol.rs:87-88 (`#[serde(default)]` on `isError`) — apply the missing-key default
		// at the parsing boundary; see `normalizeMcpToolCallResult`.
		return normalizeMcpToolCallResult(result as unknown as Record<string, unknown>);
	}

	/** Shut down the transport. Subsequent calls fail with NotInitialized / transport error. */
	async close(): Promise<void> {
		await this.transport.close();
		this.initialized = false;
	}

	private async request<P, R>(method: string, params: P | undefined, signal?: AbortSignal): Promise<R> {
		const id = this.nextId++;
		const req = makeRequest(id, method, params);
		// pie: client.rs:264-266 (`let line = serde_json::to_string(&req)?;`) — `?` routes a
		// serialize failure through `From<serde_json::Error> for McpError` (protocol code, not a raw
		// error type). Mirrors that: `id` is consumed either way (matches `next_id.fetch_add`
		// running unconditionally before the fallible serialize), but nothing is registered into
		// `inflight` yet, so no cleanup is needed on this path.
		let line: string;
		try {
			line = JSON.stringify(req);
		} catch (error) {
			throw McpError.fromJsonError(error);
		}

		const { promise, resolve } = createResolvablePromise<InflightSettlement>();
		this.inflight.set(id, resolve);

		try {
			await this.transport.sendLine(line);

			const wait = async (): Promise<R> => {
				let settlement: InflightSettlement;
				try {
					settlement = await withDeadline(promise, this.requestTimeoutMs, () =>
						McpError.timeout(Math.floor(this.requestTimeoutMs / 1000)),
					);
				} catch (error) {
					if (error instanceof McpError) throw error;
					throw McpError.transport("response channel closed");
				}
				if (!settlement.ok) {
					throw McpError.serverError(settlement.error.code, settlement.error.message);
				}
				return settlement.value as R;
			};

			if (signal) {
				return await raceCancellable(wait(), signal, () => this.sendCancelledNotification(id));
			}
			return await wait();
		} finally {
			// pie: client.rs:37-46 (`InflightGuard`, RAII) — removes the inflight entry on every
			// exit path (explicit cancel, timeout, transport error, or success — the pump has
			// usually already removed it by then, making this a harmless double-delete).
			this.inflight.delete(id);
		}
	}

	/**
	 * Best-effort: tell the server we no longer need request `id`. Bounded by
	 * `CANCEL_NOTIFY_SEND_BUDGET_MS` so a stuck transport can't keep the cancel path open.
	 * Failures are swallowed — our side has already dropped the inflight entry, so a late
	 * response will simply be unmatched and discarded by the read pump.
	 */
	private async sendCancelledNotification(id: number): Promise<void> {
		const params: CancelledNotificationParams = { requestId: id, reason: "client cancelled" };
		const note = makeNotification("notifications/cancelled", params);
		let line: string;
		try {
			line = JSON.stringify(note);
		} catch {
			return;
		}
		try {
			await withDeadline(this.transport.sendLine(line), CANCEL_NOTIFY_SEND_BUDGET_MS, () =>
				McpError.timeout(CANCEL_NOTIFY_SEND_BUDGET_MS / 1000),
			);
		} catch {
			// best-effort; swallow (pie: client.rs:328 `let _ = tokio::time::timeout(...).await;`).
		}
	}

	private async runReadPump(): Promise<void> {
		while (true) {
			let line: string | undefined;
			try {
				line = await this.transport.recvLine();
			} catch {
				this.drainInflightOnClose();
				return;
			}
			if (line === undefined) {
				this.drainInflightOnClose();
				return;
			}

			let value: unknown;
			try {
				value = JSON.parse(line);
			} catch {
				continue;
			}
			if (typeof value !== "object" || value === null) continue;
			const obj = value as Record<string, unknown>;

			const id = asU64(obj.id);
			if (id === undefined) {
				const method = typeof obj.method === "string" ? obj.method : undefined;
				if (method === undefined) continue;
				const params = "params" in obj ? (obj.params ?? null) : null;
				this.notifySender.send({ method, params });
				continue;
			}

			const resolve = this.inflight.get(id);
			this.inflight.delete(id);
			if (resolve === undefined) continue;

			if (Object.hasOwn(obj, "error")) {
				const parsed = tryParseRpcError(obj.error);
				resolve({ ok: false, error: parsed ?? { code: -32603, message: "malformed error frame" } });
			} else if (Object.hasOwn(obj, "result")) {
				resolve({ ok: true, value: obj.result });
			} else {
				resolve({ ok: false, error: { code: -32603, message: "response had neither result nor error" } });
			}
		}
	}

	private drainInflightOnClose(): void {
		const resolvers = [...this.inflight.values()];
		this.inflight.clear();
		for (const resolve of resolvers) {
			resolve({ ok: false, error: { code: -32000, message: "transport closed" } });
		}
		this.notifySender.close();
	}
}
