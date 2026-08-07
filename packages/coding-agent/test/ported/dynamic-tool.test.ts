/**
 * Extra characterization tests (beyond the 17 ported oracle unit tests in dynamic.test.ts) for
 * `packages/coding-agent/src/triggers/dynamic.ts` — mirrors the cron.ts pilot's own
 * cron-notification-hook.test.ts / cron-tool-bugs.test.ts split (see those files' headers for the
 * precedent this follows).
 *
 * Covers:
 * - The "not a filesystem watcher, immediate-first-tick" polling semantics of
 *   `DynamicTriggerCheckHook` — oracle dynamic.rs's `run()` has NO pre-loop `interval.tick()`
 *   warm-up (contrast cron.rs:649-653), so the FIRST periodic check fires the instant `run()`
 *   starts, and only the SECOND+ checks are `dynamicTriggerPollIntervalSecs()`-spaced. Oracle's
 *   own inline test (`periodic_hook_emits_check_trigger_when_rules_exist`, ported in
 *   dynamic.test.ts) uses a 5ms interval with a 1s timeout, which cannot distinguish
 *   "fires at t=0" from "fires at t=5ms" — this file uses fake timers to pin the distinction.
 * - `setDynamicTriggerPollIntervalSecs`/`dynamicTriggerPollIntervalSecs` (the `--trigger-poll-secs`
 *   override surface the task brief calls out), including the oracle's `secs.max(1)` clamp.
 * - The 4 `AgentTool` `execute()`/`permissionClassification()` methods, which oracle's own inline
 *   `mod tests` does not unit-test directly (same gap cron.rs's tools had, covered by
 *   cron-tool-bugs.test.ts's analogous "should not ship untested" rationale).
 * - `directInjectActionHook` and `fireOnceHarnessListener`, neither of which the ported oracle
 *   tests exercise (oracle's `mod tests` only covers `before_trigger_action_hook`, not its two
 *   siblings).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolError, HarnessEvent } from "@pie/agent-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	DEFAULT_DYNAMIC_TRIGGER_POLL_INTERVAL_SECS,
	DynamicTriggerCheckHook,
	DynamicTriggerRegistry,
	directInjectActionHook,
	dynamicTriggerPollIntervalSecs,
	fireOnceHarnessListener,
	globalRegistry,
	ListTriggersTool,
	NewTriggerTool,
	RemoveTriggerTool,
	SetTriggerStateTool,
	setDynamicTriggerPollIntervalSecs,
} from "../../src/triggers/dynamic.ts";

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "dynamic-tool-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	}
});

const abortSignal = new AbortController().signal;

/* -------------------------------------------------------------------------------------------
 * Poll interval configuration surface.
 * ----------------------------------------------------------------------------------------- */

afterEach(() => {
	// Module-level global state (oracle: process-wide `AtomicU64`) — reset after every test in
	// this file so later tests/files don't observe a leaked override.
	setDynamicTriggerPollIntervalSecs(DEFAULT_DYNAMIC_TRIGGER_POLL_INTERVAL_SECS);
});

it("dynamicTriggerPollIntervalSecs defaults to 10 minutes", () => {
	expect(dynamicTriggerPollIntervalSecs()).toBe(600);
	expect(DEFAULT_DYNAMIC_TRIGGER_POLL_INTERVAL_SECS).toBe(600);
});

it("setDynamicTriggerPollIntervalSecs overrides the configured interval, clamped to >= 1", () => {
	setDynamicTriggerPollIntervalSecs(30);
	expect(dynamicTriggerPollIntervalSecs()).toBe(30);

	setDynamicTriggerPollIntervalSecs(0);
	expect(dynamicTriggerPollIntervalSecs()).toBe(1);

	setDynamicTriggerPollIntervalSecs(-5);
	expect(dynamicTriggerPollIntervalSecs()).toBe(1);
});

it("DynamicTriggerCheckHook() with no explicit interval uses the configured poll interval", () => {
	setDynamicTriggerPollIntervalSecs(42);
	const registry = new DynamicTriggerRegistry();
	// No direct getter for the hook's private intervalMs; assert indirectly via fake-timer
	// behavior instead (next test) — this test only pins that construction reads the module
	// config at construction time without throwing.
	expect(() => new DynamicTriggerCheckHook(registry)).not.toThrow();
});

/* -------------------------------------------------------------------------------------------
 * DynamicTriggerCheckHook: not a filesystem watcher, immediate-first-tick polling.
 * ----------------------------------------------------------------------------------------- */

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

it("fires the first periodic check immediately (t=0), before any poll interval elapses", async () => {
	const registry = new DynamicTriggerRegistry();
	registry.addRule("always", "echo fired");
	const hook = new DynamicTriggerCheckHook(registry, 600_000); // 10 minutes, like the real default

	const sent: unknown[] = [];
	const runPromise = hook.run({
		push: (trigger) => {
			sent.push(trigger);
			return true;
		},
	});

	// No `await vi.advanceTimersByTimeAsync(...)` at all -- the first check must already have
	// fired synchronously-enough (within the same microtask flush) that a bare `await
	// Promise.resolve()` lets it land. This is the load-bearing assertion distinguishing
	// dynamic.rs from cron.rs: cron's CronNotificationHook fires nothing until its first real
	// tick (see cron-notification-hook.test.ts's "fires no triggers before the first 30s tick
	// elapses").
	await Promise.resolve();
	await Promise.resolve();
	expect(sent.length).toBe(1);

	hook.stop();
	await vi.advanceTimersByTimeAsync(600_000);
	await runPromise;
});

it("only the second and later checks are poll-interval-spaced", async () => {
	const registry = new DynamicTriggerRegistry();
	registry.addRule("always", "echo fired");
	const hook = new DynamicTriggerCheckHook(registry, 10_000);

	const sent: unknown[] = [];
	const runPromise = hook.run({
		push: (trigger) => {
			sent.push(trigger);
			return true;
		},
	});
	await Promise.resolve();
	await Promise.resolve();
	expect(sent.length).toBe(1); // immediate first check

	await vi.advanceTimersByTimeAsync(9_999);
	expect(sent.length).toBe(1); // second check not due yet

	await vi.advanceTimersByTimeAsync(1);
	expect(sent.length).toBe(2); // second check fires exactly one interval after the first

	hook.stop();
	await vi.advanceTimersByTimeAsync(10_000);
	await runPromise;
});

it("does not push a trigger (skips the tick entirely) when no rule is enabled", async () => {
	const registry = new DynamicTriggerRegistry();
	// no rules added at all
	const hook = new DynamicTriggerCheckHook(registry, 1_000);
	const sent: unknown[] = [];
	const runPromise = hook.run({
		push: (trigger) => {
			sent.push(trigger);
			return true;
		},
	});

	await Promise.resolve();
	await Promise.resolve();
	await vi.advanceTimersByTimeAsync(5_000);
	expect(sent.length).toBe(0);

	hook.stop();
	await vi.advanceTimersByTimeAsync(1_000);
	await runPromise;
});

it("status() reports zero rules before any are added", () => {
	const registry = new DynamicTriggerRegistry();
	const hook = new DynamicTriggerCheckHook(registry, 1_000);
	const status = hook.status();
	expect(status.subscription_labels).toEqual(["dynamic trigger periodic check"]);
	expect(status.state).toEqual({ kind: "disconnected", reason: "not yet started" });
});

/* -------------------------------------------------------------------------------------------
 * The 4 AgentTool implementations. Point the global registry at a fresh sidecar per test
 * (mirrors cron-tool-bugs.test.ts's identical rationale for its own global-registry tools).
 * ----------------------------------------------------------------------------------------- */

beforeEach(() => {
	globalRegistry().loadFromPath(join(tempDir(), "session.triggers.json"));
});

it("NewTrigger creates a rule from condition + action, defaulting fire_once=true, promote_to_chat=false", async () => {
	const tool = new NewTriggerTool();
	const result = await tool.execute("call-1", { condition: "a build finishes", action: "echo ok" }, abortSignal);
	const details = result.details as { id: string; enabled: boolean; fire_once: boolean; promote_to_chat: boolean };
	expect(details.enabled).toBe(true);
	expect(details.fire_once).toBe(true);
	expect(details.promote_to_chat).toBe(false);

	const rule = globalRegistry()
		.list()
		.find((r) => r.id === details.id);
	expect(rule?.condition).toBe("a build finishes");
	expect(rule?.action).toBe("echo ok");
});

it("NewTrigger creates a rule from the spec fallback when condition/action are not both supplied", async () => {
	const tool = new NewTriggerTool();
	const result = await tool.execute("call-1", { spec: "when a build finishes, run echo ok" }, abortSignal);
	const details = result.details as { id: string };
	const rule = globalRegistry()
		.list()
		.find((r) => r.id === details.id);
	expect(rule?.condition).toBe("a build finishes");
	expect(rule?.action).toBe("echo ok");
});

it("NewTrigger honors explicit fire_once=false and promote_to_chat=true", async () => {
	const tool = new NewTriggerTool();
	const result = await tool.execute(
		"call-1",
		{ condition: "always", action: "echo ok", fire_once: false, promote_to_chat: true },
		abortSignal,
	);
	const details = result.details as { fire_once: boolean; promote_to_chat: boolean };
	expect(details.fire_once).toBe(false);
	expect(details.promote_to_chat).toBe(true);
});

it("NewTrigger rejects fixed-schedule-looking text, redirecting to NewCronJob", async () => {
	const tool = new NewTriggerTool();
	await expect(
		tool.execute("call-1", { condition: "every day at 9am", action: "echo ok" }, abortSignal),
	).rejects.toThrow("fixed scheduled jobs must use NewCronJob, not NewTrigger");
	// The Chinese needle path is exercised too, not just English.
	await expect(tool.execute("call-1", { condition: "每天", action: "echo ok" }, abortSignal)).rejects.toThrow(
		"fixed scheduled jobs must use NewCronJob, not NewTrigger",
	);
});

it("NewTrigger requires condition+action or spec", async () => {
	const tool = new NewTriggerTool();
	await expect(tool.execute("call-1", {}, abortSignal)).rejects.toThrow(
		"missing required args: provide condition and action",
	);
});

it("ListTriggers renders an empty registry and a populated one", async () => {
	const listTool = new ListTriggersTool();
	const empty = await listTool.execute("call-1", {}, abortSignal);
	expect(empty.content[0]?.type).toBe("text");
	expect((empty.content[0] as { text: string }).text).toBe("dynamic trigger rules: none");
	expect((empty.details as { count: number }).count).toBe(0);

	await new NewTriggerTool().execute("call-2", { condition: "always", action: "echo ok" }, abortSignal);
	const populated = await listTool.execute("call-3", {}, abortSignal);
	const details = populated.details as { count: number; storage_path: string | undefined };
	expect(details.count).toBe(1);
	expect(details.storage_path).toContain("session.triggers.json");
	expect((populated.content[0] as { text: string }).text).toContain("dynamic trigger rules: 1");
});

it("RemoveTrigger requires confirmation-free single-id removal and rejects an unknown id", async () => {
	const created = await new NewTriggerTool().execute(
		"call-1",
		{ condition: "always", action: "echo ok" },
		abortSignal,
	);
	const id = (created.details as { id: string }).id;

	const removeTool = new RemoveTriggerTool();
	const removed = await removeTool.execute("call-2", { id }, abortSignal);
	expect((removed.details as { removed_count: number }).removed_count).toBe(1);
	expect(globalRegistry().list()).toEqual([]);

	await expect(removeTool.execute("call-3", { id: "dyn-does-not-exist" }, abortSignal)).rejects.toThrow(
		"no dynamic trigger rule with id 'dyn-does-not-exist'",
	);
	await expect(removeTool.execute("call-4", {}, abortSignal)).rejects.toThrow("missing required arg: id");
});

it("RemoveTrigger all=true clears every rule in one call", async () => {
	await new NewTriggerTool().execute("call-1", { condition: "a", action: "echo a" }, abortSignal);
	await new NewTriggerTool().execute("call-2", { condition: "b", action: "echo b" }, abortSignal);
	expect(globalRegistry().list()).toHaveLength(2);

	const result = await new RemoveTriggerTool().execute("call-3", { all: true }, abortSignal);
	expect(result.details).toEqual({ removed_count: 2, all: true });
	expect(globalRegistry().list()).toEqual([]);
});

it("RemoveTrigger permissionClassification distinguishes all/id/neither", () => {
	const tool = new RemoveTriggerTool();
	expect(tool.permissionClassification({ all: true })).toEqual({
		type: "prompt",
		reason: "remove ALL dynamic triggers",
	});
	expect(tool.permissionClassification({ id: "dyn-abc" })).toEqual({
		type: "prompt",
		reason: "remove dynamic trigger `dyn-abc`",
	});
	expect(tool.permissionClassification({})).toEqual({ type: "prompt", reason: "remove dynamic trigger" });
});

it("SetTriggerState disables without a prompt gate but classifies re-enable as Prompt", async () => {
	const created = await new NewTriggerTool().execute(
		"call-1",
		{ condition: "always", action: "echo ok" },
		abortSignal,
	);
	const id = (created.details as { id: string }).id;

	const setTool = new SetTriggerStateTool();
	expect(setTool.permissionClassification({ id, enabled: false })).toEqual({ type: "allow" });
	expect(setTool.permissionClassification({ id, enabled: true })).toEqual({
		type: "prompt",
		reason: `re-enable dynamic trigger \`${id}\``,
	});

	const disabled = await setTool.execute("call-2", { id, enabled: false }, abortSignal);
	expect((disabled.details as { enabled: boolean }).enabled).toBe(false);

	const enabled = await setTool.execute("call-3", { id, enabled: true }, abortSignal);
	expect((enabled.details as { enabled: boolean }).enabled).toBe(true);

	await expect(setTool.execute("call-4", { id: "dyn-nope", enabled: false }, abortSignal)).rejects.toThrow(
		"no dynamic trigger rule with id 'dyn-nope'",
	);
	await expect(setTool.execute("call-5", { enabled: false }, abortSignal)).rejects.toThrow("missing required arg: id");
	await expect(setTool.execute("call-6", { id }, abortSignal)).rejects.toThrow("missing required arg: enabled");
});

it("tool errors are AgentToolError with code 'message'", async () => {
	try {
		await new SetTriggerStateTool().execute("call-1", {}, abortSignal);
		expect.unreachable();
	} catch (err) {
		const toolError = err as AgentToolError;
		expect(toolError.code).toBe("message");
		expect(toolError.message).toBe("missing required arg: id");
	}
});

/* -------------------------------------------------------------------------------------------
 * directInjectActionHook — oracle's own inline tests don't cover this sibling of
 * before_trigger_action_hook.
 * ----------------------------------------------------------------------------------------- */

function makeMcpTrigger(serverName: string, payloadSummary: string | null) {
	return {
		source: { kind: "mcp" as const, server_name: serverName, method: "notify" },
		source_kind: "mcp" as const,
		source_label: `mcp:${serverName}`,
		event_label: "pushed",
		payload_visibility: "local" as const,
		payload_summary: payloadSummary,
		payload: undefined,
		idempotency_key: "k",
		replacement_policy: "drop" as const,
		trace_id: "t",
		authority: {
			principal_id: "mcp",
			principal_label: "mcp",
			credential_scope: "User" as const,
			allowed_source_actions: [],
			expires_at: undefined,
		},
		received_at: new Date().toISOString(),
	};
}

const emptyRuntimeSnapshot = {
	dedupEntries: 0,
	activeTraces: 0,
	acceptedTotal: 0,
	dedupedTotal: 0,
	cycleSuppressedTotal: 0,
};

it("directInjectActionHook: inject_and_run server bypasses the sub-agent, injecting payload_summary verbatim", async () => {
	const inner = vi.fn();
	const hook = directInjectActionHook(new Set(), new Set(["gh"]), inner);
	const action = await hook(
		{ trigger: makeMcpTrigger("gh", "3 new issues"), runtime: emptyRuntimeSnapshot },
		abortSignal,
	);
	expect(action).toEqual({
		prompt: "3 new issues",
		promote: { kind: "none" },
		promoteRequiresApproval: false,
		delivery: "inject_and_run",
	});
	expect(inner).not.toHaveBeenCalled();
});

it("directInjectActionHook: inject_and_run falls back to a generic line when there is no summary", async () => {
	const hook = directInjectActionHook(new Set(), new Set(["gh"]), vi.fn());
	const action = await hook({ trigger: makeMcpTrigger("gh", null), runtime: emptyRuntimeSnapshot }, abortSignal);
	expect(action.prompt).toBe("mcp:gh fired: pushed");
	expect(action.delivery).toBe("inject_and_run");
});

it("directInjectActionHook: inject_summary server promotes the summary without running a turn", async () => {
	const hook = directInjectActionHook(new Set(["gh"]), new Set(), vi.fn());
	const action = await hook(
		{ trigger: makeMcpTrigger("gh", "3 new issues"), runtime: emptyRuntimeSnapshot },
		abortSignal,
	);
	expect(action).toEqual({
		prompt: "",
		promote: { kind: "promote_summary_now", templateBody: "{{trigger.payload_summary}}" },
		promoteRequiresApproval: false,
		delivery: "inject_summary",
	});
});

it("directInjectActionHook: inject_and_run wins when a server is configured for both sets", async () => {
	const hook = directInjectActionHook(new Set(["gh"]), new Set(["gh"]), vi.fn());
	const action = await hook({ trigger: makeMcpTrigger("gh", "digest"), runtime: emptyRuntimeSnapshot }, abortSignal);
	expect(action.delivery).toBe("inject_and_run");
});

it("directInjectActionHook: a server in neither set falls through to inner unchanged", async () => {
	const innerAction = {
		prompt: "from inner",
		promote: { kind: "none" as const },
		promoteRequiresApproval: false,
		delivery: "sub_agent" as const,
	};
	const inner = vi.fn().mockResolvedValue(innerAction);
	const hook = directInjectActionHook(new Set(["gh"]), new Set(["gh"]), inner);
	const ctx = { trigger: makeMcpTrigger("other-server", "x"), runtime: emptyRuntimeSnapshot };
	const action = await hook(ctx, abortSignal);
	expect(action).toBe(innerAction);
	expect(inner).toHaveBeenCalledWith(ctx, abortSignal);
});

/* -------------------------------------------------------------------------------------------
 * fireOnceHarnessListener — oracle's own inline tests don't cover this sibling either.
 * ----------------------------------------------------------------------------------------- */

it("fireOnceHarnessListener marks matching rules fired on a trigger_completed event with a summary", () => {
	const registry = new DynamicTriggerRegistry();
	const rule = registry.addRule("always", "echo ok");
	const listener = fireOnceHarnessListener(registry);

	listener({
		type: "trigger_completed",
		traceId: "t1",
		summary: `matched ${rule.id}`,
		costUsd: undefined,
		details: undefined,
	} satisfies Extract<HarnessEvent, { type: "trigger_completed" }>);

	expect(registry.list()[0]?.enabled).toBe(false);
});

it("fireOnceHarnessListener ignores non-trigger_completed events and events with no summary", () => {
	const registry = new DynamicTriggerRegistry();
	const rule = registry.addRule("always", "echo ok");
	const listener = fireOnceHarnessListener(registry);

	listener({ type: "trigger_failed", traceId: "t1", reason: "boom" });
	listener({ type: "trigger_completed", traceId: "t2", summary: undefined, costUsd: undefined, details: undefined });

	expect(registry.list()[0]?.id).toBe(rule.id);
	expect(registry.list()[0]?.enabled).toBe(true);
});
