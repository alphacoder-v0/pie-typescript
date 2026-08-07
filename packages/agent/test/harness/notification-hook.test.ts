import { describe, expect, it } from "vitest";
import { AsyncQueue } from "../../src/harness/async-queue.ts";
import {
	HookError,
	type HookState,
	type NotificationHook,
	type NotificationHookStatus,
	notificationHookStatusPending,
	type TriggerSink,
} from "../../src/harness/notification-hook.ts";
import type { Trigger } from "../../src/harness/trigger.ts";

describe("NotificationHookStatus.pending", () => {
	it("serializes with a disconnected state (snake_case kind tag)", () => {
		const pending = notificationHookStatusPending();
		const json = JSON.stringify(pending);
		expect(json).toContain('"kind":"disconnected"');
		expect(json).toContain('"reason":"not yet started"');
	});

	it("serializes the four Option<T> fields as `null`, never omitted (oracle has no skip_serializing_if on any of them, notification_hook.rs:104-130)", () => {
		const pending = notificationHookStatusPending();
		expect(pending.last_event_at).toBeNull();
		expect(pending.last_ack_at).toBeNull();
		expect(pending.last_error).toBeNull();
		expect(pending.requires_attention).toBeNull();
		const parsed = JSON.parse(JSON.stringify(pending)) as Record<string, unknown>;
		for (const key of ["last_event_at", "last_ack_at", "last_error", "requires_attention"]) {
			expect(Object.hasOwn(parsed, key), `expected key \`${key}\` present with value null, got omitted`).toBe(true);
			expect(parsed[key]).toBeNull();
		}
	});
});

describe("HookState", () => {
	const cases: Array<[HookState, string]> = [
		[{ kind: "connected" }, "connected"],
		[{ kind: "reconnecting" }, "reconnecting"],
		[{ kind: "disconnected", reason: "broken pipe" }, "disconnected"],
		[{ kind: "disabled" }, "disabled"],
		[{ kind: "auth_failed", reason: "401 unauthorized" }, "auth_failed"],
	];

	it("round-trips through JSON for every variant", () => {
		for (const [state] of cases) {
			const json = JSON.stringify(state);
			const decoded = JSON.parse(json);
			expect(decoded).toEqual(state);
		}
	});

	it("uses a snake_case `kind` tag for every variant", () => {
		for (const [state, expectedKind] of cases) {
			const json = JSON.stringify(state);
			expect(json, `${JSON.stringify(state)} -> ${json} (expected kind=${expectedKind})`).toContain(
				`"kind":"${expectedKind}"`,
			);
		}
	});
});

describe("HookError", () => {
	it("produces a distinct message per variant (AuthFailed vs ProtocolMismatch UX divergence)", () => {
		expect(HookError.authFailed("401").message).toContain("auth failed");
		expect(HookError.protocolMismatch("v=2 not supported").message).toContain("protocol mismatch");
		expect(HookError.disconnected("closed").message).toContain("disconnected");
		expect(HookError.sinkClosed().message).toContain("sink closed");
	});

	it("carries a stable machine-readable code per variant", () => {
		expect(HookError.authFailed("x").code).toBe("auth_failed");
		expect(HookError.protocolMismatch("x").code).toBe("protocol_mismatch");
		expect(HookError.disconnected("x").code).toBe("disconnected");
		expect(HookError.schemaInvalid("x").code).toBe("schema_invalid");
		expect(HookError.sinkClosed().code).toBe("sink_closed");
		expect(HookError.other("x").code).toBe("other");
	});

	it("is a real Error subclass (instanceof Error)", () => {
		expect(HookError.sinkClosed()).toBeInstanceOf(Error);
	});
});

describe("TriggerSink (AsyncQueue<Trigger> push-only projection)", () => {
	function makeTrigger(idempotencyKey: string): Trigger {
		return {
			source: { kind: "local", subkind: "test" },
			source_kind: "local",
			source_label: "test",
			event_label: "fire",
			payload_visibility: "local",
			payload_summary: null,
			idempotency_key: idempotencyKey,
			replacement_policy: "drop",
			trace_id: "trace-1",
			authority: {
				principal_id: "test:principal",
				principal_label: "test",
				credential_scope: "Project",
				allowed_source_actions: [],
			},
			received_at: new Date().toISOString(),
		};
	}

	it("an AsyncQueue<Trigger> is structurally assignable to TriggerSink (push-only)", async () => {
		const queue = new AsyncQueue<Trigger>();
		const sink: TriggerSink = queue;
		const trigger = makeTrigger("k1");

		// A minimal NotificationHook implementation only ever needs `sink.push(...)`, matching
		// oracle notification_hook.rs's `Result<(), HookError>`-returning `run(&self, sink)`.
		const hook: NotificationHook = {
			label: () => "test-hook",
			run: async (s) => {
				s.push(trigger);
			},
			status: (): NotificationHookStatus => notificationHookStatusPending(),
		};

		await hook.run(sink);
		await expect(queue.next()).resolves.toEqual(trigger);
	});
});
