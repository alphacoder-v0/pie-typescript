/**
 * Vitest port of the 19 `#[test]`/`#[tokio::test]` functions in oracle
 * `crates/coding-agent/src/triggers/mcp_notification_hook.rs` (pie @0a120dfd, `mod tests` at
 * line 387).
 *
 * Test-name / oracle-line mapping:
 *  1.  tools_list_changed_maps_to_latest_replaces                    -> oracle :421
 *  2.  resources_updated_keys_per_uri                                -> oracle :449
 *  3.  custom_with_meta_dedup_key_passes_through                     -> oracle :474
 *  4.  legacy_dedup_key_works_and_meta_wins                          -> oracle :492
 *  5.  custom_dedup_key_redacts_secret_like_text_in_idempotency_key  -> oracle :522
 *  6.  custom_without_dedup_key_is_dropped_with_diagnostic           -> oracle :556
 *  7.  resources_updated_without_uri_falls_back_to_resources_key     -> oracle :604
 *  8.  idempotency_keys_are_namespaced_per_server                    -> oracle :620
 *  9.  custom_key_cannot_collide_with_builtin_within_same_server     -> oracle :712
 * 10.  custom_method_summary_does_not_leak_params_content            -> oracle :783
 * 11.  custom_method_pie_summary_opt_in_appears_in_summary           -> oracle :816
 * 12.  custom_method_pie_summary_opt_in_redacts_secret_like_text     -> oracle :847
 * 13.  agent_message_notification_is_generic_custom_mcp_trigger      -> oracle :870
 * 14.  resources_updated_summary_includes_uri                        -> oracle :907
 * 15.  resources_updated_summary_redacts_secret_like_uri             -> oracle :929
 * 16.  sink_closed_returns_sink_closed_err                           -> oracle :964
 * 17.  transport_close_returns_ok_and_marks_disconnected             -> oracle :989
 * 18.  second_run_fails_after_receiver_consumed                      -> oracle :1010
 * 19.  initial_status_is_pending                                     -> oracle :1027
 *
 * Test channel: the oracle fixture wires a real `tokio::mpsc` pair and a spawned task; this port
 * uses a tiny local buffered channel (drain-before-close, matching `AsyncQueue`/oracle mpsc
 * semantics) driven purely by microtasks — no timers or real concurrency are needed because
 * `McpNotificationHook.run()` only ever awaits `receiver.recv()`, which this fake resolves
 * synchronously once the relevant values are buffered/closed.
 */

import type { Trigger, TriggerSink } from "@pie/agent-core";
import type { McpServerNotification, NotificationReceiver } from "@pie/mcp";
import { expect, it } from "vitest";
import { McpNotificationHook, mapNotification } from "../../src/triggers/mcp-notification-hook.ts";

function note(method: string, params: unknown): McpServerNotification {
	return { method, params };
}

/** Minimal buffered channel: `push`/`close` (test-only sender) + `recv()` (the `NotificationReceiver` shape `McpNotificationHook` consumes). Drain-before-close like `AsyncQueue`. */
function testChannel(): {
	push: (n: McpServerNotification) => void;
	close: () => void;
	receiver: NotificationReceiver;
} {
	const buffer: McpServerNotification[] = [];
	let waiter: ((value: McpServerNotification | undefined) => void) | undefined;
	let closed = false;
	return {
		push(value) {
			if (closed) return;
			if (waiter) {
				const resolve = waiter;
				waiter = undefined;
				resolve(value);
				return;
			}
			buffer.push(value);
		},
		close() {
			if (closed) return;
			closed = true;
			if (waiter) {
				const resolve = waiter;
				waiter = undefined;
				resolve(undefined);
			}
		},
		receiver: {
			recv(): Promise<McpServerNotification | undefined> {
				if (buffer.length > 0) return Promise.resolve(buffer.shift());
				if (closed) return Promise.resolve(undefined);
				return new Promise((resolve) => {
					waiter = resolve;
				});
			},
		},
	};
}

/** Collects every trigger pushed through a `TriggerSink`. `push` always succeeds. */
function collectingSink(): { sink: TriggerSink; triggers: Trigger[] } {
	const triggers: Trigger[] = [];
	return {
		sink: {
			push(trigger) {
				triggers.push(trigger);
				return true;
			},
		},
		triggers,
	};
}

/** Build a hook + channel + collecting sink for one server, matching oracle's `fixture()`. */
function fixture(serverName = "filesystem") {
	const chan = testChannel();
	const hook = new McpNotificationHook(serverName, chan.receiver);
	const { sink, triggers } = collectingSink();
	return { chan, hook, sink, triggers };
}

// oracle :421 tools_list_changed_maps_to_latest_replaces
it("tools/listChanged maps to latest_replaces", async () => {
	const { chan, hook, sink, triggers } = fixture();
	chan.push(note("notifications/tools/listChanged", {}));
	chan.close();
	await hook.run(sink);

	expect(triggers.length).toBe(1);
	const trigger = triggers[0];
	expect(trigger.idempotency_key).toBe("mcp:filesystem:tools");
	expect(trigger.replacement_policy).toBe("latest_replaces");
	expect(trigger.source_kind).toBe("mcp");
	expect(trigger.source).toEqual({
		kind: "mcp",
		server_name: "filesystem",
		method: "notifications/tools/listChanged",
	});
	expect(trigger.source_label).toBe("mcp:filesystem");
	expect(trigger.payload).toBeUndefined(); // default payload_visibility=local hides payload
});

// oracle :449 resources_updated_keys_per_uri
it("resources/updated keys per uri", async () => {
	const { chan, hook, sink, triggers } = fixture();
	chan.push(note("notifications/resources/updated", { uri: "file:///a.md" }));
	chan.push(note("notifications/resources/updated", { uri: "file:///b.md" }));
	chan.close();
	await hook.run(sink);

	expect(triggers.length).toBe(2);
	expect(triggers[0].idempotency_key).toBe("mcp:filesystem:resources:file:///a.md");
	expect(triggers[1].idempotency_key).toBe("mcp:filesystem:resources:file:///b.md");
	expect(triggers[0].idempotency_key).not.toBe(triggers[1].idempotency_key);
});

// oracle :474 custom_with_meta_dedup_key_passes_through
it("custom method with _meta.pie_dedup_key passes through with drop policy", async () => {
	const { chan, hook, sink, triggers } = fixture();
	chan.push(note("notifications/custom/event", { _meta: { pie_dedup_key: "build-42" }, detail: "ok" }));
	chan.close();
	await hook.run(sink);

	expect(triggers.length).toBe(1);
	expect(triggers[0].idempotency_key).toBe("mcp:filesystem:custom:build-42");
	expect(triggers[0].replacement_policy).toBe("drop");
});

// oracle :492 legacy_dedup_key_works_and_meta_wins
it("legacy _pie_dedup_key works and _meta.pie_dedup_key wins when both present", async () => {
	const { chan, hook, sink, triggers } = fixture();
	chan.push(note("notifications/custom/event", { _pie_dedup_key: "legacy-key", detail: "ok" }));
	chan.push(
		note("notifications/custom/event", {
			_meta: { pie_dedup_key: "new-key" },
			_pie_dedup_key: "legacy-key",
		}),
	);
	chan.close();
	await hook.run(sink);

	expect(triggers.length).toBe(2);
	expect(triggers[0].idempotency_key).toBe("mcp:filesystem:custom:legacy-key");
	expect(triggers[1].idempotency_key).toBe("mcp:filesystem:custom:new-key");
});

// oracle :522 custom_dedup_key_redacts_secret_like_text_in_idempotency_key
it("custom dedup key redacts secret-like text in the idempotency key", async () => {
	const { chan, hook, sink, triggers } = fixture();
	chan.push(
		note("notifications/custom/payload", {
			_meta: { pie_dedup_key: "hub_agent_secret_should_not_persist" },
		}),
	);
	chan.close();
	await hook.run(sink);

	expect(triggers.length).toBe(1);
	const key = triggers[0].idempotency_key;
	expect(key.startsWith("mcp:filesystem:custom:hash:")).toBe(true);
	expect(key).not.toContain("hub_agent_secret_should_not_persist");
});

// oracle :556 custom_without_dedup_key_is_dropped_with_diagnostic
it("custom method without a dedup key is dropped at the adapter with a diagnostic", async () => {
	const { chan, hook, sink, triggers } = fixture();
	chan.push(note("notifications/custom/event", { detail: "missing key" }));
	chan.close();
	await hook.run(sink);

	expect(triggers.length).toBe(0);
	const status = hook.status();
	expect(status.dropped_count).toBe(1);
	expect(status.last_error).toContain("dropped custom notification");
});

// oracle :604 resources_updated_without_uri_falls_back_to_resources_key
it("resources/updated without a uri falls back to the resources:unknown key", async () => {
	const { chan, hook, sink, triggers } = fixture();
	chan.push(note("notifications/resources/updated", {}));
	chan.close();
	await hook.run(sink);

	expect(triggers.length).toBe(1);
	expect(triggers[0].idempotency_key).toBe("mcp:filesystem:resources:unknown");
});

// oracle :620 idempotency_keys_are_namespaced_per_server
it("idempotency keys are namespaced per server", async () => {
	const a = fixture("server-a");
	const b = fixture("server-b");

	a.chan.push(note("notifications/tools/listChanged", {}));
	b.chan.push(note("notifications/tools/listChanged", {}));
	a.chan.push(note("notifications/resources/updated", { uri: "file:///shared.md" }));
	b.chan.push(note("notifications/resources/updated", { uri: "file:///shared.md" }));
	a.chan.push(note("notifications/custom/event", { _meta: { pie_dedup_key: "shared-build-1" } }));
	b.chan.push(note("notifications/custom/event", { _meta: { pie_dedup_key: "shared-build-1" } }));
	a.chan.close();
	b.chan.close();
	await Promise.all([a.hook.run(a.sink), b.hook.run(b.sink)]);

	expect(a.triggers.length).toBe(3);
	expect(b.triggers.length).toBe(3);
	const aKeys = a.triggers.map((t) => t.idempotency_key);
	const bKeys = b.triggers.map((t) => t.idempotency_key);
	for (const k of aKeys) expect(k.startsWith("mcp:server-a:")).toBe(true);
	for (const k of bKeys) expect(k.startsWith("mcp:server-b:")).toBe(true);
	for (const ka of aKeys) {
		for (const kb of bKeys) {
			expect(ka).not.toBe(kb);
		}
	}
});

// oracle :712 custom_key_cannot_collide_with_builtin_within_same_server
it("a custom key cannot collide with the built-in slots within the same server", async () => {
	const { chan, hook, sink, triggers } = fixture();
	chan.push(note("notifications/tools/listChanged", {}));
	chan.push(note("notifications/custom/payload", { _meta: { pie_dedup_key: "tools" } }));
	chan.push(note("notifications/custom/payload", { _meta: { pie_dedup_key: "resources" } }));
	chan.push(note("notifications/custom/payload", { _meta: { pie_dedup_key: "prompts" } }));
	chan.push(note("notifications/custom/payload", { _meta: { pie_dedup_key: "resources:file:///x.md" } }));
	chan.close();
	await hook.run(sink);

	expect(triggers.length).toBe(5);
	const keys = triggers.map((t) => t.idempotency_key);
	expect(keys[0]).toBe("mcp:filesystem:tools");
	expect(keys[1]).toBe("mcp:filesystem:custom:tools");
	expect(keys[2]).toBe("mcp:filesystem:custom:resources");
	expect(keys[3]).toBe("mcp:filesystem:custom:prompts");
	expect(keys[4]).toBe("mcp:filesystem:custom:resources:file:///x.md");
	for (let i = 0; i < keys.length; i++) {
		for (let j = i + 1; j < keys.length; j++) {
			expect(keys[i]).not.toBe(keys[j]);
		}
	}
});

// oracle :783 custom_method_summary_does_not_leak_params_content
it("a custom method's summary does not leak params content", async () => {
	const { chan, hook, sink, triggers } = fixture();
	const sentinel = "TOKEN_SENTINEL_SHOULD_NOT_APPEAR_IN_AUDIT";
	chan.push(
		note("notifications/custom/secret-bearing", {
			_meta: { pie_dedup_key: "evt-1" },
			secret: sentinel,
			nested: { more_secret: sentinel },
		}),
	);
	chan.close();
	await hook.run(sink);

	expect(triggers.length).toBe(1);
	const summary = triggers[0].payload_summary ?? "";
	expect(summary).not.toContain(sentinel);
	expect(summary).toBe("notifications/custom/secret-bearing");
});

// oracle :816 custom_method_pie_summary_opt_in_appears_in_summary
it("opt-in _meta.pie_summary appears in the summary", async () => {
	const { chan, hook, sink, triggers } = fixture();
	chan.push(
		note("notifications/custom/build-finished", {
			_meta: { pie_dedup_key: "build-99", pie_summary: "build #99 finished: 3 tests failed" },
			internal_token: "should-not-appear",
		}),
	);
	chan.close();
	await hook.run(sink);

	expect(triggers.length).toBe(1);
	const summary = triggers[0].payload_summary ?? "";
	expect(summary).toContain("build #99 finished");
	expect(summary).not.toContain("should-not-appear");
});

// oracle :847 custom_method_pie_summary_opt_in_redacts_secret_like_text
it("opt-in _meta.pie_summary redacts secret-like text", async () => {
	const { chan, hook, sink, triggers } = fixture();
	chan.push(
		note("notifications/custom/build-finished", {
			_meta: {
				pie_dedup_key: "build-100",
				pie_summary: "build leaked hub_agent_secret_should_not_persist token=sk-secret",
			},
		}),
	);
	chan.close();
	await hook.run(sink);

	expect(triggers.length).toBe(1);
	const summary = triggers[0].payload_summary ?? "";
	expect(summary).toContain("notifications/custom/build-finished");
	expect(summary).toContain("[redacted]");
	expect(summary).not.toContain("hub_agent_secret_should_not_persist");
	expect(summary).not.toContain("sk-secret");
});

// oracle :870 agent_message_notification_is_generic_custom_mcp_trigger
it("a generic agent_message custom notification maps via mapNotification directly", () => {
	const trigger = mapNotification(
		"remote-agent",
		note("notifications/agent_message", {
			_meta: {
				pie_dedup_key: "note-1",
				pie_summary: "message ready",
				receiver_agent_id: "11111111-1111-4111-8111-111111111111",
				sender_agent_id: "22222222-2222-4222-8222-222222222222",
			},
			sender: "@alice@example",
			payload: { secret: "hub_agent_secret_should_not_leave_local_payload" },
		}),
	);
	expect(trigger).toBeDefined();
	if (trigger === undefined) throw new Error("unreachable");

	expect(trigger.source_label).toBe("mcp:remote-agent");
	expect(trigger.event_label).toBe("notifications/agent_message");
	expect(trigger.payload_visibility).toBe("local");
	expect(trigger.payload).toBeUndefined(); // must not build a special-case binding payload
	const summary = trigger.payload_summary ?? "";
	expect(summary).toContain("message ready");
	expect(summary).not.toContain("hub_agent_secret_should_not_leave_local_payload");
});

// oracle :907 resources_updated_summary_includes_uri
it("resources/updated keeps the uri in the summary", async () => {
	const { chan, hook, sink, triggers } = fixture();
	chan.push(note("notifications/resources/updated", { uri: "file:///proj/README.md", rev: 5 }));
	chan.close();
	await hook.run(sink);

	expect(triggers.length).toBe(1);
	const summary = triggers[0].payload_summary ?? "";
	expect(summary).toContain("uri=file:///proj/README.md");
	expect(summary).not.toContain("rev"); // non-spec params field must not leak
});

// oracle :929 resources_updated_summary_redacts_secret_like_uri
it("resources/updated redacts a secret-like uri in the summary", async () => {
	const { chan, hook, sink, triggers } = fixture();
	chan.push(
		note("notifications/resources/updated", {
			uri: "file:///proj/README.md?token=hub_agent_secret_should_not_persist",
		}),
	);
	chan.close();
	await hook.run(sink);

	expect(triggers.length).toBe(1);
	const trigger = triggers[0];
	const summary = trigger.payload_summary ?? "";
	expect(summary).toContain("notifications/resources/updated");
	expect(summary).toContain("uri=[redacted]");
	expect(summary).not.toContain("hub_agent_secret_should_not_persist");
	expect(trigger.idempotency_key).not.toContain("hub_agent_secret_should_not_persist");
	expect(trigger.idempotency_key).toContain("resources:hash:");
});

// oracle :964 sink_closed_returns_sink_closed_err
it("a closed sink surfaces HookError sink_closed and marks the hook disconnected", async () => {
	const chan = testChannel();
	const hook = new McpNotificationHook("filesystem", chan.receiver);
	const closedSink: TriggerSink = { push: () => false };

	chan.push(note("notifications/tools/listChanged", {}));
	let caught: unknown;
	try {
		await hook.run(closedSink);
	} catch (err) {
		caught = err;
	}
	expect(caught).toBeInstanceOf(Error);
	expect((caught as Error).message).toBe("sink closed");
	expect(hook.status().state).toEqual({ kind: "disconnected", reason: "sink closed" });
});

// oracle :989 transport_close_returns_ok_and_marks_disconnected
it("a clean transport close resolves and marks the hook disconnected with a transport reason", async () => {
	const chan = testChannel();
	const hook = new McpNotificationHook("filesystem", chan.receiver);
	const { sink } = collectingSink();

	chan.close();
	await hook.run(sink); // must not throw

	const state = hook.status().state;
	expect(state.kind).toBe("disconnected");
	if (state.kind === "disconnected") {
		expect(state.reason).toContain("transport");
	}
});

// oracle :1010 second_run_fails_after_receiver_consumed
it("running the hook a second time fails because the receiver was already consumed", async () => {
	const chan = testChannel();
	const hook = new McpNotificationHook("filesystem", chan.receiver);
	const { sink } = collectingSink();

	chan.close();
	await hook.run(sink);

	const { sink: sink2 } = collectingSink();
	let caught: unknown;
	try {
		await hook.run(sink2);
	} catch (err) {
		caught = err;
	}
	expect(caught).toBeInstanceOf(Error);
	expect((caught as { code?: string }).code).toBe("other");
});

// oracle :1027 initial_status_is_pending
it("status starts as the trait-defined pending snapshot before run is invoked", () => {
	const chan = testChannel();
	const hook = new McpNotificationHook("filesystem", chan.receiver);
	const status = hook.status();
	expect(status.state).toEqual({ kind: "disconnected", reason: "not yet started" });
	expect(status.subscription_labels).toEqual(["mcp:filesystem"]);
	expect(status.dropped_count).toBe(0);
});
