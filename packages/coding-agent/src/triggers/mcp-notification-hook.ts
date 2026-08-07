/**
 * `NotificationHook` adapter that turns server-pushed MCP frames into runtime `Trigger`
 * envelopes.
 *
 * Port of oracle `crates/coding-agent/src/triggers/mcp_notification_hook.rs` (pie @0a120dfd).
 *
 * Sits between `@pie/mcp`'s `McpClient` (RFC 1 §4.2.1 read pump, surfaced via
 * `McpClient.takeNotifications`) and the runtime's `TriggerSink` (`@pie/agent-core`). One
 * instance per configured MCP server. Constructed by `mcp-loader.ts` once that unit's
 * supervisor lands (manifest `coding-agent/mcp_loader`, phase 12, pending — out of this unit's
 * scope); until then this type exists so its own tests pin the per-method dedup /
 * replacement-policy contract from RFC 1 §4.2.3 and the follow-up notes left on PR #35/#56.
 *
 * Mapping rules (RFC 1 §4.2.3 + PR #35 / PR #56 QA notes):
 *
 * | MCP method                            | runtime idempotency key                          | replacement      |
 * |----------------------------------------|--------------------------------------------------|------------------|
 * | `notifications/tools/listChanged`     | `mcp:{server}:tools`                              | `latest_replaces`|
 * | `notifications/resources/listChanged` | `mcp:{server}:resources`                          | `latest_replaces`|
 * | `notifications/resources/updated`     | `mcp:{server}:resources:{safe-uri-or-hash}`       | `latest_replaces`|
 * | `notifications/prompts/listChanged`   | `mcp:{server}:prompts`                            | `latest_replaces`|
 * | custom `notifications/*`              | `mcp:{server}:custom:{safe-key-or-hash}`          | `drop`           |
 *
 * Two layers of namespacing:
 *
 * - **`mcp:{server_name}:` prefix** keeps the same intrinsic key from two MCP servers (e.g. both
 *   `tools/listChanged`) from dedup-cancelling each other in the runtime's global dedup window
 *   (PR #56 QA blocker #1).
 * - **`custom:` segment** keeps user-supplied dedup keys in their own slot within a server, so a
 *   custom notification with `_meta.pie_dedup_key = "tools"` cannot collide with the built-in
 *   `tools/listChanged` row (PR #56 QA blocker #2). Built-in subsystems (`tools` / `resources` /
 *   `prompts`) own the un-prefixed slot; everything user-provided lives under `custom:`.
 *
 * A custom notification that provides neither dedup key form is dropped at the adapter with
 * `dropped_count += 1`; the runtime never sees it. Adapters do NOT dedup themselves — the
 * runtime owns the dedup window. We surface a stable, server-scoped key per source/method so the
 * runtime can do its job.
 *
 * Privacy contract: `payload_visibility = "local"` means the full `params` blob is dropped
 * before persistence; only `payload_summary` survives into the audit. The summary is
 * method-name-only for custom / unknown notifications (PR #56 QA blocker) — a sentinel secret
 * tucked into a custom notification's params must never end up in the persisted trigger audit
 * entry. Adapters that genuinely need human-readable per-event detail can opt in via
 * `_meta.pie_summary: "<text>"`, capped and redacted before persistence. Unsafe resource URIs /
 * custom dedup keys are hashed before they enter persisted trigger audit fields.
 *
 * This unit only maps push frames into triggers and drives a hook loop over a receiver; it does
 * NOT dedup or fire a follow-up push back out through the same MCP server (that would be a
 * tool→push→trigger→tool feedback loop within one server). That is a documented, audited
 * project boundary (per this task's brief) — ported as-is, not "fixed".
 */

import { createHash, randomUUID } from "node:crypto";
import {
	HookError,
	type NotificationHook,
	type NotificationHookStatus,
	notificationHookStatusPending,
	type ReplacementPolicy,
	type Trigger,
	type TriggerAuthority,
	type TriggerSink,
	type TriggerSource,
} from "@pie/agent-core";
import type { McpServerNotification, NotificationReceiver } from "@pie/mcp";

/** Unicode control characters (C0 + C1 ranges) — mirrors Rust `char::is_control()`. */
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * One MCP server's notification stream as a runtime `NotificationHook`.
 *
 * The constructor consumes the `NotificationReceiver` returned by `McpClient.takeNotifications`;
 * the hook owns the receiver for the lifetime of `run`. The supervisor (RFC 1 sub-PR 2, this
 * unit's `mcp-loader.ts` consumer) is expected to call `run` exactly once and to drop the hook on
 * shutdown — there is no re-entrant restart path because each server has its own `McpClient`, and
 * a recovery cycle re-creates the whole stack (client + transport + hook) rather than reusing the
 * inbound receiver.
 */
export class McpNotificationHook implements NotificationHook {
	private readonly labelValue: string;
	private readonly serverName: string;
	/** `undefined` once consumed by `run()` — mirrors oracle's `Mutex<Option<UnboundedReceiver<...>>>.take()`. */
	private rx: NotificationReceiver | undefined;
	private status_: NotificationHookStatus;

	/**
	 * Build a hook for the named MCP server. `serverName` is what the user wrote in `mcp.toml`;
	 * `rx` comes from `McpClient.takeNotifications()`.
	 */
	constructor(serverName: string, rx: NotificationReceiver) {
		this.serverName = serverName;
		this.labelValue = `mcp:${serverName}`;
		this.rx = rx;
		const status = notificationHookStatusPending();
		// The hook's only "subscription" is the server itself — MCP push frames are not per-topic.
		status.subscription_labels = [this.labelValue];
		this.status_ = status;
	}

	label(): string {
		return this.labelValue;
	}

	async run(sink: TriggerSink): Promise<void> {
		const rx = this.rx;
		if (rx === undefined) {
			throw HookError.other(`${this.labelValue} hook already ran; receiver consumed`);
		}
		this.rx = undefined;

		// First successful receiver checkout flips the state to Connected — the read pump ran
		// the JSON-RPC initialize handshake before constructing this hook, so by the time we get
		// here the transport is live.
		this.status_.state = { kind: "connected" };

		for (;;) {
			const notification = await rx.recv();
			if (notification === undefined) break;

			const trigger = mapNotification(this.serverName, notification);
			if (trigger === undefined) {
				// Custom notification without a dedup key — drop and surface count.
				this.status_.dropped_count += 1;
				this.status_.last_error = `dropped custom notification ${JSON.stringify(notification.method)}: missing \`_meta.pie_dedup_key\` or \`_pie_dedup_key\``;
				continue;
			}
			if (!sink.push(trigger)) {
				// Runtime is shutting down; exit cleanly. The supervisor will reap the hook task
				// and mark the hook Disconnected.
				this.status_.state = { kind: "disconnected", reason: "sink closed" };
				throw HookError.sinkClosed();
			}
			// Bookkeeping after successful push so status views show the latest event even if
			// the runtime is still draining the sink.
			this.status_.last_event_at = new Date().toISOString();
			this.status_.last_error = null;
		}

		// Pump exited because the transport closed. Update status and return cleanly so the
		// supervisor records a Disconnected hook rather than a hard failure.
		this.status_.state = { kind: "disconnected", reason: "mcp transport closed" };
	}

	status(): NotificationHookStatus {
		return { ...this.status_ };
	}
}

/**
 * Translate one MCP push frame to a `Trigger`, or `undefined` if the frame should be dropped at
 * the adapter (custom method without `_pie_dedup_key` / `_meta.pie_dedup_key`).
 *
 * Pure function so the test suite can pin every row of the §4.2.3 table without spinning up a
 * real `McpClient`.
 */
export function mapNotification(serverName: string, n: McpServerNotification): Trigger | undefined {
	const idem = idempotencyFor(serverName, n.method, n.params);
	if (idem === undefined) return undefined;
	const [idempotencyKey, replacementPolicy] = idem;
	const payloadSummary = renderSummary(n.method, n.params);
	const source: TriggerSource = { kind: "mcp", server_name: serverName, method: n.method };
	const authority: TriggerAuthority = {
		// Stable principal id per server — the user-visible server name acts as the
		// opaque-stable id since `mcp.toml` enforces uniqueness.
		principal_id: `mcp:${serverName}`,
		principal_label: serverName,
		credential_scope: "User",
		allowed_source_actions: [],
		expires_at: undefined,
	};
	return {
		source,
		source_kind: "mcp",
		source_label: `mcp:${serverName}`,
		event_label: n.method,
		payload_visibility: "local",
		payload_summary: payloadSummary,
		payload: undefined,
		idempotency_key: idempotencyKey,
		replacement_policy: replacementPolicy,
		trace_id: randomUUID(),
		authority,
		received_at: new Date().toISOString(),
	};
}

function getStringField(value: unknown, key: string): string | undefined {
	const field = getField(value, key);
	return typeof field === "string" ? field : undefined;
}

function getField(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null) return undefined;
	return (value as Record<string, unknown>)[key];
}

/**
 * Derive `[idempotencyKey, replacementPolicy]` for a given method + params per RFC 1 §4.2.3 /
 * PR #35 QA follow-up. Returns `undefined` for custom methods that don't supply a dedup key —
 * the caller drops those at the adapter with diagnostics.
 *
 * Every key is namespaced with `mcp:{server_name}:` so two MCP servers that legitimately emit
 * the same intrinsic key (both `tools/listChanged`, both with the same custom
 * `_meta.pie_dedup_key`) do not dedup each other in the runtime. The runtime dedup window is
 * global per harness; namespacing at the adapter is the only place we can prevent cross-server
 * collisions.
 */
function idempotencyFor(serverName: string, method: string, params: unknown): [string, ReplacementPolicy] | undefined {
	const prefix = `mcp:${serverName}:`;
	switch (method) {
		case "notifications/tools/listChanged":
			return [`${prefix}tools`, "latest_replaces"];
		case "notifications/resources/listChanged":
			return [`${prefix}resources`, "latest_replaces"];
		case "notifications/prompts/listChanged":
			return [`${prefix}prompts`, "latest_replaces"];
		case "notifications/resources/updated": {
			// Per-URI keying so multiple updates to different resources don't collapse into one
			// event. If the server omitted `uri` (shouldn't happen per MCP spec but defensive),
			// fall back to the unscoped `"resources"` key.
			const uri = getStringField(params, "uri") ?? "unknown";
			return [`${prefix}resources:${safeIdempotencySegment(uri)}`, "latest_replaces"];
		}
		default: {
			// Custom notification — require an explicit dedup key. Prefer `_meta.pie_dedup_key`
			// (canonical going forward) over `_pie_dedup_key` (legacy, kept for adapters already
			// in the wild). Either form is treated as `drop` semantics: every explicit key
			// represents one logical event, no replacement.
			//
			// The `custom:` segment after the server prefix keeps custom keys in their own
			// namespace within the server so a user supplying `_meta.pie_dedup_key = "tools"`
			// does NOT collide with the built-in `tools/listChanged` row. Built-in subsystems
			// (`tools` / `resources` / `prompts`) own the un-prefixed slot; everything
			// user-provided lives under `custom:`. PR #56 QA re-review blocker.
			const key = extractDedupKey(params);
			return key !== undefined ? [`${prefix}custom:${safeIdempotencySegment(key)}`, "drop"] : undefined;
		}
	}
}

/**
 * Pull a dedup key out of a custom notification's params, preferring the new
 * `_meta.pie_dedup_key` location and falling back to the older top-level `_pie_dedup_key`.
 */
function extractDedupKey(params: unknown): string | undefined {
	const meta = getField(params, "_meta");
	const metaKey = meta !== undefined ? getStringField(meta, "pie_dedup_key") : undefined;
	if (metaKey !== undefined) return metaKey;
	return getStringField(params, "_pie_dedup_key");
}

function safeIdempotencySegment(value: string): string {
	const redacted = redactNotificationText(value);
	const hasSensitiveText = redacted !== value;
	const chars = [...value];
	const isUnbounded = chars.length > 200;
	const hasControlChars = chars.some((ch) => CONTROL_CHAR_RE.test(ch));
	if (hasSensitiveText || isUnbounded || hasControlChars) {
		const digest = createHash("sha256").update(value, "utf8").digest();
		return `hash:${digest.subarray(0, 6).toString("hex")}`;
	}
	return value;
}

/**
 * Render a short human-readable summary for `payload_summary`. Capped well below the runtime
 * 4 KiB persistence cap; the runtime will still re-truncate if a future caller emits more.
 *
 * Privacy contract (RFC 0 §3.2.2 / RFC 1 §4.2.3 + PR #56 QA follow-up): the hook is configured
 * with `payload_visibility = "local"`, which means `payload` is dropped and only
 * `payload_summary` survives into the persisted audit. So this function must not echo arbitrary
 * params content — a sentinel secret in a custom notification's params field would otherwise
 * persist into the trigger audit entry.
 *
 * The contract: only method name plus bounded/redacted display metadata (`uri` for
 * `resources/updated`) appear in the summary. Adapters that need per-event detail must opt in
 * via `_meta.pie_summary: "<human-safe text>"`; we still cap and redact that string because it
 * is MCP-server-controlled input.
 */
function renderSummary(method: string, params: unknown): string {
	// `uri` is part of the MCP resource identity, but an MCP server can still stuff token-like
	// values into it. Keep useful display metadata while applying the same redaction as other
	// user-visible/audit-visible strings.
	if (method === "notifications/resources/updated") {
		const uri = getStringField(params, "uri");
		return uri !== undefined ? `${method} uri=${safeDisplay(uri, 200)}` : method;
	}
	// Standard listChanged events have no per-event detail worth rendering.
	if (
		method === "notifications/tools/listChanged" ||
		method === "notifications/resources/listChanged" ||
		method === "notifications/prompts/listChanged"
	) {
		return method;
	}
	// Custom / unknown methods: NEVER serialize arbitrary params. Allow explicit opt-in via
	// `_meta.pie_summary`; otherwise just the method name. This is what prevents secrets in a
	// server's custom params from leaking into the audit.
	const meta = getField(params, "_meta");
	const summary = meta !== undefined ? getStringField(meta, "pie_summary") : undefined;
	return summary !== undefined ? `${method} ${safeDisplay(summary, 200)}` : method;
}

function safeDisplay(value: string, cap: number): string {
	const redacted = redactNotificationText(value).replace(/\n/g, " ");
	return truncateChars(redacted, cap);
}

// Rust `to_ascii_lowercase()` only lowercases ASCII bytes; JS `toLowerCase()` lowercases full
// Unicode. Immaterial here: every matched prefix/substring below is itself ASCII, so the two
// only diverge on non-ASCII characters that neither would match anyway.
function redactNotificationText(value: string): string {
	const parts = value.split(/\s+/).filter((part) => part.length > 0);
	return parts
		.map((part) => {
			const lower = part.toLowerCase();
			if (
				lower.startsWith("hub_agent_") ||
				lower.startsWith("hub_hs_") ||
				lower.startsWith("hub_ep_") ||
				lower.startsWith("sk-") ||
				lower.includes("bearer") ||
				lower.includes("token")
			) {
				return "[redacted]";
			}
			return part;
		})
		.join(" ");
}

function truncateChars(value: string, cap: number): string {
	const chars = [...value];
	if (chars.length <= cap) return value;
	const takeCount = Math.max(cap - 1, 0);
	return `${chars.slice(0, takeCount).join("")}…`;
}
