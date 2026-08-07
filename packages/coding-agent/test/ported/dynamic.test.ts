/**
 * Vitest port of the 17 `#[test]`/`#[tokio::test]` functions in oracle
 * `crates/coding-agent/src/triggers/dynamic.rs` (pie @0a120dfd, `mod tests` at line 1199).
 *
 * Test-name / oracle-line mapping:
 *  1. new_trigger_permission_reason_is_value_free                        -> oracle :1207
 *  2. parses_chinese_trigger_rule                                        -> oracle :1244
 *  3. parses_english_trigger_rule                                        -> oracle :1259
 *  4. parses_chinese_if_then_trigger_rule                                -> oracle :1266
 *  5. rejects_missing_action_separator                                   -> oracle :1276
 *  6. persists_rules_when_storage_path_is_configured                     -> oracle :1283
 *  7. storage_paths_keep_session_rules_isolated                          -> oracle :1298
 *  8. removing_rule_updates_storage_file                                 -> oracle :1320
 *  9. fire_once_rules_can_be_marked_fired                                -> oracle :1338
 * 10. repeat_rules_are_not_disabled_when_marked_fired                    -> oracle :1357
 * 11. set_rule_enabled_reactivates_fired_fire_once_rule                  -> oracle :1376
 * 12. extracts_dynamic_rule_ids_from_summary                             -> oracle :1394
 * 13. periodic_hook_emits_check_trigger_when_rules_exist                 -> oracle :1407
 * 14. action_hook_wraps_event_and_rules_for_agent_evaluation             -> oracle :1434
 * 15. local_payload_visibility_does_not_leak_payload_into_sub_agent_prompt   -> oracle :1500
 * 16. shared_payload_visibility_includes_payload_in_sub_agent_prompt         -> oracle :1565
 * 17. redacted_payload_visibility_does_not_leak_payload_into_sub_agent_prompt -> oracle :1620
 *
 * Extra (not in oracle's inline `mod tests`, see the implementer report / RULEBOOK testing
 * requirement that new production code ship with coverage): DynamicTriggerCheckHook's
 * "no fs.watch, immediate-first-tick" polling semantics and the 4 AgentTool `execute()` methods
 * live in test/ported/dynamic-tool.test.ts instead, mirroring cron's own
 * cron-notification-hook.test.ts / cron-tool-bugs.test.ts split.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BeforeTriggerActionContext, Trigger, TriggerRuntimeSnapshot } from "@pie/agent-core";
import { afterEach, expect, it } from "vitest";
import {
	beforeTriggerActionHook,
	DynamicTriggerCheckHook,
	DynamicTriggerRegistry,
	extractDynamicRuleIds,
	NewTriggerTool,
	ParseTriggerRuleError,
	parseTriggerRule,
} from "../../src/triggers/dynamic.ts";

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "dynamic-trigger-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	}
});

const emptyRuntimeSnapshot: TriggerRuntimeSnapshot = {
	dedupEntries: 0,
	activeTraces: 0,
	acceptedTotal: 0,
	dedupedTotal: 0,
	cycleSuppressedTotal: 0,
};

/** oracle dynamic.rs's inline trigger literals, factored into one helper across tests 14-17. */
function makeTestTrigger(overrides: Partial<Trigger> = {}): Trigger {
	return {
		source: { kind: "local", subkind: "test" },
		source_kind: "local",
		source_label: "local:test",
		event_label: "build finished",
		payload_visibility: "local",
		payload_summary: "build finished successfully",
		payload: undefined,
		idempotency_key: "test-key",
		replacement_policy: "drop",
		trace_id: "trace-test",
		authority: {
			principal_id: "test",
			principal_label: "test",
			credential_scope: "User",
			allowed_source_actions: [],
			expires_at: undefined,
		},
		received_at: new Date().toISOString(),
		...overrides,
	};
}

// 1. new_trigger_permission_reason_is_value_free (oracle :1207)
it("NewTrigger permission reason is value-free (does not echo secret-like input)", () => {
	// Provider/Auth gate on PR #139: a tokenized URL or other secret-bearing string smuggled
	// into `condition`/`action`/`spec` must NOT appear in the runtime prompt reason (audit + UI).
	const tokenLike = "https://hub.example/api?token=ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890_super_secret";

	const cases: unknown[] = [
		{ condition: tokenLike, action: "echo ok" },
		{ condition: "always", action: tokenLike },
		{ spec: tokenLike },
		{},
	];

	for (const args of cases) {
		const cls = new NewTriggerTool().permissionClassification(args);
		expect(cls.type).toBe("prompt");
		if (cls.type !== "prompt") continue;
		expect(cls.reason).not.toContain("token=ABCDEFGHIJKLMNOPQRSTUVWXYZ");
		expect(cls.reason).not.toContain("https://hub.example/api");
		expect(cls.reason).not.toContain("super_secret");
	}
});

// 2. parses_chinese_trigger_rule (oracle :1244)
it("parses a Chinese trigger rule", () => {
	const spec = "当在 github 上有新 issue的时候，执行 ./notify.sh";
	const parsed = parseTriggerRule(spec);
	expect(parsed.condition).toBe("在 github 上有新 issue");
	expect(parsed.action).toBe("./notify.sh");
});

// 3. parses_english_trigger_rule (oracle :1259)
it("parses an English trigger rule", () => {
	const parsed = parseTriggerRule("when a build finishes, run cargo test");
	expect(parsed.condition).toBe("a build finishes");
	expect(parsed.action).toBe("cargo test");
});

// 4. parses_chinese_if_then_trigger_rule (oracle :1266)
it("parses a Chinese if/then trigger rule", () => {
	const condition = "现在是 11pm";
	const action = "写一个 tmp 文件";
	const spec = `如果${condition}，则${action}`;
	const parsed = parseTriggerRule(spec);
	expect(parsed.condition).toBe(condition);
	expect(parsed.action).toBe(action);
});

// 5. rejects_missing_action_separator (oracle :1276)
it("rejects a spec with no recognizable action separator", () => {
	// ParseTriggerRuleError's constructor is private (factory-only, mirroring oracle's
	// ParseTriggerRuleError::empty()/missing_action()/empty_part()), so it isn't structurally
	// `Constructable` for toThrowError's type. Assert on the instance instead.
	expect(() => parseTriggerRule("当有新 issue")).toThrow(expect.objectContaining({ name: "ParseTriggerRuleError" }));
	try {
		parseTriggerRule("当有新 issue");
		expect.unreachable();
	} catch (err) {
		expect(err).toBeInstanceOf(ParseTriggerRuleError);
		expect((err as ParseTriggerRuleError).code).toBe("missing_action");
	}
});

// 6. persists_rules_when_storage_path_is_configured (oracle :1283)
it("persists rules when a storage path is configured", () => {
	const filePath = join(tempDir(), "triggers.json");
	const registry = new DynamicTriggerRegistry();
	registry.loadFromPath(filePath);
	const rule = registry.addRule("the event says build finished", "echo fired");

	const reloaded = new DynamicTriggerRegistry();
	reloaded.loadFromPath(filePath);
	expect(reloaded.list()).toEqual([rule]);
});

// 7. storage_paths_keep_session_rules_isolated (oracle :1298)
it("keeps rules isolated across different storage paths", () => {
	const dir = tempDir();
	const pathA = join(dir, "session-a.triggers.json");
	const pathB = join(dir, "session-b.triggers.json");

	const registryA = new DynamicTriggerRegistry();
	registryA.loadFromPath(pathA);
	registryA.addRule("event for session a", "echo a");

	const registryB = new DynamicTriggerRegistry();
	registryB.loadFromPath(pathB);
	expect(registryB.list()).toEqual([]);

	const reloadedA = new DynamicTriggerRegistry();
	reloadedA.loadFromPath(pathA);
	expect(reloadedA.list()).toHaveLength(1);
	expect(reloadedA.list()[0]?.condition).toBe("event for session a");
});

// 8. removing_rule_updates_storage_file (oracle :1320)
it("removing a rule updates the storage file", () => {
	const filePath = join(tempDir(), "triggers.json");
	const registry = new DynamicTriggerRegistry();
	registry.loadFromPath(filePath);
	const rule = registry.addRule("the event says stale", "echo stale");

	const removed = registry.removeRule(rule.id);
	expect(removed).toEqual(rule);

	const reloaded = new DynamicTriggerRegistry();
	reloaded.loadFromPath(filePath);
	expect(reloaded.list()).toEqual([]);
	expect(existsSync(filePath)).toBe(true);
});

// 9. fire_once_rules_can_be_marked_fired (oracle :1338)
it("fire_once rules can be marked fired", () => {
	const registry = new DynamicTriggerRegistry();
	const rule = registry.addRule("event says fire once", "echo once");

	const changed = registry.markRulesFired([rule.id]);
	expect(changed).toHaveLength(1);

	const rules = registry.list();
	expect(rules).toHaveLength(1);
	expect(rules[0]?.enabled).toBe(false);
	expect(rules[0]?.fire_once).toBe(true);
	expect(rules[0]?.fired_at).not.toBeNull();
});

// 10. repeat_rules_are_not_disabled_when_marked_fired (oracle :1357)
it("repeat rules are not disabled when marked fired", () => {
	const registry = new DynamicTriggerRegistry();
	const rule = registry.addRuleWithOptions("event says repeat", "echo repeat", false);

	const changed = registry.markRulesFired([rule.id]);
	expect(changed).toEqual([]);

	const rules = registry.list();
	expect(rules).toHaveLength(1);
	expect(rules[0]?.enabled).toBe(true);
	expect(rules[0]?.fire_once).toBe(false);
	expect(rules[0]?.fired_at).toBeNull();
});

// 11. set_rule_enabled_reactivates_fired_fire_once_rule (oracle :1376)
it("set_rule_enabled reactivates a fired fire_once rule", () => {
	const registry = new DynamicTriggerRegistry();
	const rule = registry.addRule("event says reactivate", "echo again");
	registry.markRulesFired([rule.id]);

	const updated = registry.setRuleEnabled(rule.id, true);
	expect(updated?.enabled).toBe(true);
	expect(updated?.fired_at).toBeNull();
});

// 12. extracts_dynamic_rule_ids_from_summary (oracle :1394)
it("extracts dynamic rule ids from a summary", () => {
	const text = "matched dyn-1234567890abcdef1234567890abcdef and dyn-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
	expect(extractDynamicRuleIds(text)).toEqual([
		"dyn-1234567890abcdef1234567890abcdef",
		"dyn-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	]);
});

// 13. periodic_hook_emits_check_trigger_when_rules_exist (oracle :1407)
it("periodic hook emits a check trigger when rules exist", async () => {
	const registry = new DynamicTriggerRegistry();
	registry.addRule("a periodic check arrives", "echo fired");
	const hook = new DynamicTriggerCheckHook(registry, 5);

	const pushed: Trigger[] = [];
	let resolveFirst: (() => void) | undefined;
	const firstPushed = new Promise<void>((resolve) => {
		resolveFirst = resolve;
	});
	const runPromise = hook.run({
		push: (trigger) => {
			pushed.push(trigger);
			resolveFirst?.();
			return true;
		},
	});

	await Promise.race([
		firstPushed,
		new Promise((_resolve, reject) => setTimeout(() => reject(new Error("hook should emit")), 1000)),
	]);
	hook.stop();
	await runPromise;

	const trigger = pushed[0]!;
	expect(trigger.source_label).toBe("local:dynamic");
	expect(trigger.event_label).toBe("dynamic periodic check");
	expect(trigger.payload_summary ?? "").toContain("1 enabled rule");
});

// 14. action_hook_wraps_event_and_rules_for_agent_evaluation (oracle :1434)
it("action hook wraps the event and rules for agent evaluation", async () => {
	const registry = new DynamicTriggerRegistry();
	const rule = registry.addFromSpec("when the event mentions build finished, run echo done");
	const hook = beforeTriggerActionHook(registry);
	const ctx: BeforeTriggerActionContext = { trigger: makeTestTrigger(), runtime: emptyRuntimeSnapshot };
	const action = await hook(ctx, new AbortController().signal);

	expect(action.prompt).toContain(rule.id);
	expect(action.prompt).toContain("build finished");
	expect(action.prompt).toContain("echo done");
	expect(action.prompt).toContain("with the available tools");
	expect(action.prompt).toContain('"payload"');
	expect(action.prompt).toContain("environment variables");
	expect(action.prompt).toContain("include the requested file contents");
	expect(action.promote).toEqual({ kind: "none" });
});

// 15. local_payload_visibility_does_not_leak_payload_into_sub_agent_prompt (oracle :1500)
it("Local payload_visibility does not leak payload into the sub-agent prompt", async () => {
	const registry = new DynamicTriggerRegistry();
	registry.addFromSpec("when something happens, run echo nothing");
	const hook = beforeTriggerActionHook(registry);
	const sentinel = "SECRET_PAYLOAD_SHOULD_NOT_REACH_MODEL_2K7";
	const ctx: BeforeTriggerActionContext = {
		trigger: makeTestTrigger({
			payload_visibility: "local",
			payload_summary: "safe summary",
			payload: { leaked_field: sentinel, nested: { also_leaked: sentinel } },
		}),
		runtime: emptyRuntimeSnapshot,
	};
	const action = await hook(ctx, new AbortController().signal);

	expect(action.prompt).not.toContain(sentinel);
	expect(action.prompt).toContain("safe summary");
});

// 16. shared_payload_visibility_includes_payload_in_sub_agent_prompt (oracle :1565)
it("Shared payload_visibility includes payload in the sub-agent prompt", async () => {
	const registry = new DynamicTriggerRegistry();
	registry.addFromSpec("when something happens, run echo nothing");
	const hook = beforeTriggerActionHook(registry);
	const marker = "shared-payload-marker-must-appear";
	const ctx: BeforeTriggerActionContext = {
		trigger: makeTestTrigger({
			source: { kind: "mcp", server_name: "test", method: "notification" },
			source_kind: "mcp",
			source_label: "mcp:test",
			event_label: "explicit shared",
			payload_visibility: "shared",
			payload_summary: "shared event",
			payload: { value: marker },
			idempotency_key: "shared-key",
			trace_id: "trace-shared",
			authority: {
				principal_id: "mcp:test",
				principal_label: "mcp:test",
				credential_scope: "User",
				allowed_source_actions: [],
				expires_at: undefined,
			},
		}),
		runtime: emptyRuntimeSnapshot,
	};
	const action = await hook(ctx, new AbortController().signal);

	expect(action.prompt).toContain(marker);
});

// 17. redacted_payload_visibility_does_not_leak_payload_into_sub_agent_prompt (oracle :1620)
it("Redacted payload_visibility does not leak payload into the sub-agent prompt", async () => {
	const registry = new DynamicTriggerRegistry();
	registry.addFromSpec("when something happens, run echo nothing");
	const hook = beforeTriggerActionHook(registry);
	const sentinel = "REDACTED_FIELD_MUST_BE_DROPPED_9X4";
	const ctx: BeforeTriggerActionContext = {
		trigger: makeTestTrigger({
			event_label: "sensitive event",
			payload_visibility: "redacted",
			payload_summary: "redacted summary only",
			payload: { credential: sentinel },
			idempotency_key: "redacted-key",
			trace_id: "trace-redacted",
		}),
		runtime: emptyRuntimeSnapshot,
	};
	const action = await hook(ctx, new AbortController().signal);

	expect(action.prompt).not.toContain(sentinel);
});
