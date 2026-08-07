/**
 * Port of oracle `crates/agent/src/harness/notification_hook.rs` (pie @0a120dfd).
 *
 * RFC 1 (issue #20) `NotificationHook` trait + status surface.
 *
 * A `NotificationHook` is the runtime's transport-agnostic plug for external sources (MCP server
 * pushes, local cron, file-watch, etc.). Adapters own the transport, normalize the inbound stream
 * into `Trigger` envelopes (./trigger.ts), and push them into a shared `TriggerSink`. The runtime
 * consumes whatever the hooks produce, regardless of source.
 *
 * Status: **types and trait only** (matches oracle's own status note, notification_hook.rs:9-12)
 * — the runtime supervisor that spawns/monitors hooks and the per-source fair scheduler are a
 * follow-up unit.
 *
 * Wire shape is law (RULEBOOK §2.1): `NotificationHookStatus` and `HookState` are both
 * `#[derive(..., Serialize, Deserialize)]` on the oracle side and are named exactly as the
 * oracle's serde output — snake_case fields, `kind` as `HookState`'s tag discriminant (oracle:
 * `#[serde(tag = "kind", rename_all = "snake_case")]`, notification_hook.rs:158). This is the
 * unit the task brief calls out by name as the wire-shape example to check field-by-field.
 */

import type { AsyncQueue } from "./async-queue.ts";
import type { Trigger } from "./trigger.ts";

/**
 * Sink that hooks push triggers into. oracle notification_hook.rs:30
 * (`pub type TriggerSink = mpsc::UnboundedSender<Trigger>`) — RULEBOOK §2.2 maps
 * `mpsc::unbounded` to the canonical `AsyncQueue<T>` (./async-queue.ts); `TriggerSink` is the
 * push-only projection of that queue a hook receives, mirroring the fact that `UnboundedSender`
 * exposes only `send`, never the receive side.
 */
export type TriggerSink = Pick<AsyncQueue<Trigger>, "push">;

/**
 * Long-running source adapter. One instance per configured source. oracle
 * notification_hook.rs:39-53 (`#[async_trait] pub trait NotificationHook`).
 */
export interface NotificationHook {
	/** Stable label used in status views and per-source counters (e.g. `"mcp:filesystem"`, `"cron"`). */
	label(): string;
	/**
	 * Drive the source, pushing triggers into `sink` as they arrive. Resolves on clean
	 * shutdown; throws `HookError` on protocol/auth failure (oracle: `Result<(), HookError>`).
	 */
	run(sink: TriggerSink): Promise<void>;
	/** Snapshot for status views. Called frequently — keep cheap. */
	status(): NotificationHookStatus;
}

/** oracle notification_hook.rs:57 (`Arc<dyn NotificationHook>`) — a plain reference in TS; no refcounting needed. */
export type DynNotificationHook = NotificationHook;

/** oracle notification_hook.rs:66-96 (`thiserror::Error` enum `HookError`). RULEBOOK §2.4: thiserror variant → Error subclass + `code` field. */
export type HookErrorCode =
	| "auth_failed"
	| "protocol_mismatch"
	| "disconnected"
	| "schema_invalid"
	| "sink_closed"
	| "other";

export class HookError extends Error {
	readonly code: HookErrorCode;
	readonly reason?: string;

	private constructor(code: HookErrorCode, message: string, reason?: string) {
		super(message);
		this.name = "HookError";
		this.code = code;
		this.reason = reason;
	}

	/** Source-specific authentication failed. Supervisor marks the hook `AuthFailed`, does not auto-restart. */
	static authFailed(reason: string): HookError {
		return new HookError("auth_failed", `auth failed: ${reason}`, reason);
	}

	/** Source negotiated an incompatible protocol version. Distinct from `authFailed` for UX ("upgrade" vs "re-login"). */
	static protocolMismatch(reason: string): HookError {
		return new HookError("protocol_mismatch", `protocol mismatch: ${reason}`, reason);
	}

	/** Transport closed cleanly or a recoverable network error. Supervisor restarts with backoff. */
	static disconnected(reason: string): HookError {
		return new HookError("disconnected", `disconnected: ${reason}`, reason);
	}

	/** The source produced a frame that did not match the declared schema. */
	static schemaInvalid(reason: string): HookError {
		return new HookError("schema_invalid", `schema invalid: ${reason}`, reason);
	}

	/** Sink was dropped — the runtime is shutting down. Hook should exit promptly. */
	static sinkClosed(): HookError {
		return new HookError("sink_closed", "sink closed");
	}

	/** Catch-all so adapters do not need a custom error type for odd one-off failures. */
	static other(message: string): HookError {
		return new HookError("other", `hook error: ${message}`, message);
	}
}

/**
 * Snapshot of a hook's current state. oracle notification_hook.rs:104-130
 * (`NotificationHookStatus`). Field names match RFC 1 §2.5 verbatim.
 */
export interface NotificationHookStatus {
	state: HookState;
	/**
	 * Wall-clock time the most recent trigger was pushed, if any. ISO-8601. oracle field is
	 * `Option<DateTime<Utc>>` with NO `#[serde(skip_serializing_if)]` (notification_hook.rs:107) —
	 * always present on the wire, `null` when absent (RULEBOOK §2.1 null-vs-omitted judge:
	 * skip_serializing_if present → TS `?:`; absent → TS `| null`). Do not make this `?:`.
	 */
	last_event_at: string | null;
	/**
	 * Wall-clock time the most recent ack was received, if the protocol has explicit acks.
	 * ISO-8601. Same no-skip_serializing_if judgment as `last_event_at` above
	 * (notification_hook.rs:110).
	 */
	last_ack_at: string | null;
	/**
	 * Most recent transport-level error, if any. Cleared on next successful `Connected`
	 * transition. Same no-skip_serializing_if judgment (notification_hook.rs:113).
	 */
	last_error: string | null;
	/** Adapter-side queued depth. */
	queued_count: number;
	/** Count of events the adapter intentionally dropped. */
	dropped_count: number;
	/** Count of events the adapter dedup-suppressed before pushing into the sink (adapter-side, distinct from runtime-side dedup in `TriggerRecord`). */
	deduped_count: number;
	/** User-readable subscription labels, stable across reconnects. */
	subscription_labels: string[];
	/**
	 * Set only when the cause is one the user can act on (panic, protocol violation, auth
	 * failure, sustained backoff > 60s). Same no-skip_serializing_if judgment as `last_event_at`
	 * above (notification_hook.rs:129) — `null`, not omitted, when unset.
	 */
	requires_attention: string | null;
}

/**
 * oracle notification_hook.rs:135-150 (`NotificationHookStatus::pending`). Fresh status for a
 * hook that has not yet started. The four `Option<T>` fields below serialize to `null` (not
 * omitted) on the oracle side — see the field-level doc comments on `NotificationHookStatus`.
 * `JSON.stringify` drops `undefined`-valued keys, so this must set `null`, not `undefined`, or
 * the emitted wire shape silently loses the keys oracle always sends.
 */
export function notificationHookStatusPending(): NotificationHookStatus {
	return {
		state: { kind: "disconnected", reason: "not yet started" },
		last_event_at: null,
		last_ack_at: null,
		last_error: null,
		queued_count: 0,
		dropped_count: 0,
		deduped_count: 0,
		subscription_labels: [],
		requires_attention: null,
	};
}

/**
 * Per-hook lifecycle state. oracle notification_hook.rs:159-173. `AuthFailed` is reserved for
 * credential failures; `Disconnected` covers protocol mismatches too (use
 * `{ kind: "disconnected", reason: "protocol_mismatch" }`, do not collapse into `AuthFailed`);
 * `Disabled` is only entered when explicitly disabled by the user/supervisor.
 */
export type HookState =
	| { kind: "connected" }
	| { kind: "reconnecting" }
	| { kind: "disconnected"; reason: string }
	| { kind: "disabled" }
	| { kind: "auth_failed"; reason: string };
