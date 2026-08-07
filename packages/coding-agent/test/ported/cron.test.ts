/**
 * Vitest port of the 15 `#[test]` functions in oracle
 * `crates/coding-agent/src/triggers/cron.rs` (pie @0a120dfd, `mod tests` at line 1362).
 *
 * Test-name / oracle-line mapping (also recorded in the implementer report):
 *  1. cron_parser_supports_steps_ranges_and_sunday_alias        -> oracle :1369
 *  2. cron_parser_rejects_invalid_schedule                      -> oracle :1380
 *  3. next_after_uses_local_time_and_does_not_return_current_minute -> oracle :1387
 *  4. registry_round_trips_storage_and_enable_state             -> oracle :1397
 *  5. tag_extraction_handles_present_absent_truncated_and_caps  -> oracle :1415
 *  6. stateful_prompt_injects_previous_state_and_protocol       -> oracle :1437
 *  7. loop_state_paths_and_write_cap                            -> oracle :1455
 *  8. listener_persists_state_and_inbox_for_stateful_job_completion -> oracle :1470
 *  9. due_jobs_tick_writes_sidecar_only_when_state_changed       -> oracle :1509
 * 10. load_clears_stale_running_state_from_previous_process      -> oracle :1534
 * 11. registry_rejects_oversized_action                          -> oracle :1561
 * 12. trigger_summary_redacts_secret_like_action_text             -> oracle :1570
 * 13. due_jobs_marks_running_and_skips_overlap                    -> oracle :1586
 * 14. listener_clears_running_job_by_trace_id                     -> oracle :1603
 * 15. cron_action_hook_maps_cron_trigger_to_inject_and_run         -> oracle :1629
 *
 * Time-dependent oracle tests use `Utc.with_ymd_and_hms(...)` fixed instants, never real sleeps
 * — the TS port does the same via plain `Date` construction (no fake timers needed here; the
 * 30s-tick notification-hook LOOP itself is covered separately in
 * test/ported/cron-notification-hook.test.ts, which does use vitest fake timers).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { BeforeTriggerActionContext, TriggerRuntimeSnapshot } from "@pie/agent-core";
import { afterEach, expect, it, vi } from "vitest";
import { listNew as inboxListNew } from "../../src/inbox.ts";
import {
	AddCronJobError,
	CronRegistry,
	composeStatefulPrompt,
	cronActionHook,
	cronExpressionNextAfter,
	cronHarnessListener,
	cronTriggerForJob,
	extractTagAll,
	extractTagBlock,
	loopStatePath,
	parseCronExpression,
	readLoopState,
	triggerRecordReceivedFrom,
	writeLoopState,
} from "../../src/triggers/cron.ts";

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "cron-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	}
});

// oracle :1369 cron_parser_supports_steps_ranges_and_sunday_alias
it("cron parser supports steps, ranges, and the sunday alias (0/7)", () => {
	const expr = parseCronExpression("*/15 9-17 * * 1,7");
	expect(expr.minutes.has(0)).toBe(true);
	expect(expr.minutes.has(45)).toBe(true);
	expect(expr.hours.has(9)).toBe(true);
	expect(expr.hours.has(17)).toBe(true);
	expect(expr.daysOfWeek.has(0)).toBe(true);
	expect(expr.daysOfWeek.has(1)).toBe(true);
});

// Oracle `raw.parse::<u32>()` (cron.rs:1049-1054,1089-1103) accepts a leading `+`.
it("cron parser accepts a leading '+' in numbers and steps", () => {
	const expr = parseCronExpression("*/+5 * * * *");
	expect(expr.minutes.has(0)).toBe(true);
	expect(expr.minutes.has(5)).toBe(true);
	expect(expr.minutes.has(10)).toBe(true);
	expect(expr.minutes.has(3)).toBe(false);
});

// oracle :1380 cron_parser_rejects_invalid_schedule
it("cron parser rejects invalid schedules", () => {
	expect(() => parseCronExpression("* * * *")).toThrow();
	expect(() => parseCronExpression("60 * * * *")).toThrow();
	expect(() => parseCronExpression("*/0 * * * *")).toThrow();
});

// oracle :1387 next_after_uses_local_time_and_does_not_return_current_minute
it("next_after uses local time and does not return the current minute", () => {
	const expr = parseCronExpression("5 * * * *");
	const base = new Date(2026, 4, 26, 22, 5, 0); // local time, month is 0-indexed (May)
	const next = cronExpressionNextAfter(expr, base);
	expect(next).toBeDefined();
	if (next === undefined) throw new Error("unreachable");
	expect(next.getMinutes()).toBe(5);
	expect(next.getTime()).toBeGreaterThan(base.getTime());
});

// oracle :1397 registry_round_trips_storage_and_enable_state
it("registry round-trips storage and enable state", () => {
	const dir = tempDir();
	const path = join(dir, "cron.toml");
	const registry = new CronRegistry();
	registry.loadFromPath(path);
	const job = registry.addJob("*/10 * * * *", "say hello");
	registry.setJobEnabled(job.id, false);

	const reloaded = new CronRegistry();
	reloaded.loadFromPath(path);
	const jobs = reloaded.list();
	expect(jobs.length).toBe(1);
	expect(jobs[0].schedule).toBe("*/10 * * * *");
	expect(jobs[0].action).toBe("say hello");
	expect(jobs[0].enabled).toBe(false);
});

// oracle :1415 tag_extraction_handles_present_absent_truncated_and_caps
it("tag extraction handles present/absent/truncated text and caps at max", () => {
	const text =
		"did work\n<inbox>finding one</inbox>\nmore\n<inbox>finding two</inbox>\n<loop-state>seen: a,b</loop-state>";
	expect(extractTagBlock(text, "loop-state")).toBe("seen: a,b");
	expect(extractTagAll(text, "inbox", 16)).toEqual(["finding one", "finding two"]);
	expect(extractTagBlock("no tags here", "loop-state")).toBeUndefined();
	// Truncated open tag (summary cap can cut mid-stream): fail quiet.
	expect(extractTagBlock("x <loop-state>cut off", "loop-state")).toBeUndefined();
	// Cap honored.
	const many = Array.from({ length: 30 }, (_, i) => `<inbox>f${i}</inbox>`).join("");
	expect(extractTagAll(many, "inbox", 16).length).toBe(16);
});

// oracle :1437 stateful_prompt_injects_previous_state_and_protocol
it("stateful prompt injects previous state and the output protocol", () => {
	const prompt = composeStatefulPrompt("check the issues", "baseline: #1 #2");
	expect(prompt).toContain("[loop-state]");
	expect(prompt).toContain("baseline: #1 #2");
	expect(prompt).toContain("check the issues");
	expect(prompt).toContain("<loop-state>");
	expect(prompt).toContain("<inbox>");
	const first = composeStatefulPrompt("check", undefined);
	expect(first).toContain("(first run)");
});

// oracle :1455 loop_state_paths_and_write_cap
it("loop state paths derive from the sidecar name and writes are capped", () => {
	const dir = tempDir();
	const sidecar = join(dir, "019abc.cron.toml");
	const path = loopStatePath(sidecar, "cron-1234567890abcdef");
	// oracle :1461 `path.file_name().unwrap().to_str().unwrap()` — exact basename equality, not a
	// suffix check.
	expect(basename(path)).toBe("019abc.loop-cron-12345678.md");

	writeLoopState(path, "x".repeat(5000));
	const read = readLoopState(path);
	expect(read).toBeDefined();
	if (read === undefined) throw new Error("unreachable");
	expect([...read].length).toBeLessThanOrEqual(2001); // state capped
	expect(readLoopState(join(dir, "missing.md"))).toBeUndefined();
});

// oracle :1470 listener_persists_state_and_inbox_for_stateful_job_completion
it("listener persists loop state and routes inbox findings for a completed stateful job", () => {
	const dir = tempDir();
	const sidecar = join(dir, "sess1.cron.toml");
	const inboxPath = join(dir, "inbox.jsonl");
	const registry = new CronRegistry();
	registry.loadFromPath(sidecar);
	const job = registry.addJobFull("* * * * *", "watch things", true);
	expect(job.stateful).toBe(true);

	// Fire it so a running trace exists (listener resolves trace -> job).
	const since = new Date(2026, 4, 26, 22, 0, 0);
	const now = new Date(2026, 4, 26, 22, 1, 5);
	const due = registry.dueJobs(since, now);
	const traceId = due[0][0].running_trace_id;
	expect(traceId).toBeDefined();
	if (traceId === undefined) throw new Error("unreachable");

	const listener = cronHarnessListener(registry, inboxPath);
	listener({
		type: "trigger_completed",
		traceId,
		summary: "checked. <inbox>issue #9 looks stuck</inbox> done <loop-state>seen: #9</loop-state>",
		costUsd: undefined,
		details: null,
	});

	const statePath = loopStatePath(sidecar, job.id);
	expect(readLoopState(statePath)).toBe("seen: #9");
	const entries = inboxListNew(inboxPath);
	expect(entries.length).toBe(1);
	expect(entries[0].text).toContain("issue #9");
	expect(entries[0].source.startsWith("cron:")).toBe(true);
	expect(entries[0].trace_id).toBe(traceId);
	// Job marked completed (running state cleared).
	expect(registry.list()[0].running_trace_id).toBeUndefined();
});

// oracle :1509 due_jobs_tick_writes_sidecar_only_when_state_changed
it("due_jobs writes the sidecar only when its state actually changed", () => {
	const dir = tempDir();
	const path = join(dir, "cron.toml");
	const registry = new CronRegistry();
	registry.loadFromPath(path);
	const since = new Date(2026, 4, 26, 22, 0, 0);
	const now = new Date(2026, 4, 26, 22, 1, 5);

	// Empty registry: an idle tick must not create the sidecar.
	expect(registry.dueJobs(since, now)).toEqual([]);
	expect(existsSync(path)).toBe(false);

	// Job exists but is not due: tick must not rewrite the file.
	registry.addJob("0 0 1 1 *", "yearly job");
	rmSync(path);
	expect(registry.dueJobs(since, now)).toEqual([]);
	expect(existsSync(path)).toBe(false);

	// A due job is a real state change and must persist.
	registry.addJob("* * * * *", "every minute");
	expect(registry.dueJobs(since, now).length).toBe(1);
	expect(existsSync(path)).toBe(true);
});

// oracle :1534 load_clears_stale_running_state_from_previous_process
it("load clears stale running state left over from a previous process", () => {
	const dir = tempDir();
	const path = join(dir, "cron.toml");
	const registry = new CronRegistry();
	registry.loadFromPath(path);
	const job = registry.addJob("* * * * *", "say hello");
	const since = new Date(2026, 4, 26, 22, 0, 0);
	const now = new Date(2026, 4, 26, 22, 1, 5);
	expect(registry.dueJobs(since, now).length).toBe(1);
	expect(registry.list()[0].running_trace_id).toBeDefined();

	const reloaded = new CronRegistry();
	reloaded.loadFromPath(path);
	const jobs = reloaded.list();
	expect(jobs.length).toBe(1);
	expect(jobs[0].id).toBe(job.id);
	expect(jobs[0].running_trace_id).toBeUndefined();
	expect(jobs[0].last_error).toBe("cleared stale running state on startup");

	const persistedText = readFileSync(path, "utf8");
	expect(persistedText).not.toContain("running_trace_id");
});

// oracle :1561 registry_rejects_oversized_action
it("registry rejects an oversized action", () => {
	const registry = new CronRegistry();
	let error: unknown;
	try {
		registry.addJob("* * * * *", "x".repeat(4096 + 1));
	} catch (err) {
		error = err;
	}
	expect(error).toBeInstanceOf(AddCronJobError);
	expect((error as AddCronJobError).code).toBe("action_too_large");
});

// oracle :1570 trigger_summary_redacts_secret_like_action_text
it("trigger payload summary redacts secret-like action text", () => {
	const registry = new CronRegistry();
	const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
	const bearer = "Bearer abcdefghijklmnopqrstuvwxyz";
	const job = registry.addJob("* * * * *", `use token ${secret} and ${bearer}`);
	const trigger = cronTriggerForJob(job, new Date(), "trace-cron");
	const record = triggerRecordReceivedFrom(trigger);
	expect(record.payload_summary).toBeDefined();
	const summary = record.payload_summary ?? "";
	expect(summary).not.toContain(secret);
	expect(summary).not.toContain(bearer);
	expect(summary).toContain("[REDACTED:");
});

// RFC3339 formatting parity with chrono's `SecondsFormat::AutoSi` (oracle `.to_rfc3339()` call
// sites: cron.rs:707,712,714) — whole seconds omit the fractional part entirely; non-whole
// seconds render exactly 3 millisecond digits (JS Date is ms-bound, unlike chrono's up-to-9-ns
// AutoSi range).
it("cron trigger payload renders RFC3339 timestamps with AutoSi precision", () => {
	const registry = new CronRegistry();
	const job = registry.addJob("* * * * *", "do work");

	const wholeSecond = new Date(2026, 4, 26, 22, 1, 0, 0);
	const wholeSecondTrigger = cronTriggerForJob(job, wholeSecond, "trace-cron-1");
	const wholeSecondPayload = wholeSecondTrigger.payload as { due_at: string };
	expect(wholeSecondPayload.due_at).not.toContain(".");
	expect(wholeSecondPayload.due_at.endsWith("+00:00")).toBe(true);
	expect(wholeSecondTrigger.idempotency_key.endsWith("+00:00")).toBe(true);
	expect(wholeSecondTrigger.payload_summary).not.toContain(".000");

	const withMillis = new Date(2026, 4, 26, 22, 1, 0, 123);
	const withMillisTrigger = cronTriggerForJob(job, withMillis, "trace-cron-2");
	const withMillisPayload = withMillisTrigger.payload as { due_at: string };
	expect(withMillisPayload.due_at.endsWith(".123+00:00")).toBe(true);
});

// Same AutoSi rule applies to the serde-`Z` disk-write path: the CronJob timestamp fields TS
// itself generates (created_at, last_due_at, ...) must persist the same whole-second-omits,
// non-whole-keeps-3-digits shape as the oracle's serde `DateTime<Utc>` Serialize impl.
it("CronJob timestamps persisted to the sidecar use AutoSi precision (serde-Z form)", () => {
	const dir = tempDir();
	const path = join(dir, "cron.toml");
	const registry = new CronRegistry();
	registry.loadFromPath(path);

	vi.useFakeTimers();
	try {
		vi.setSystemTime(new Date(2026, 4, 26, 22, 1, 0, 0));
		registry.addJob("* * * * *", "whole second job");
		vi.setSystemTime(new Date(2026, 4, 26, 22, 1, 0, 456));
		registry.addJob("* * * * *", "fractional job");
	} finally {
		vi.useRealTimers();
	}

	const createdAtLines = readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.startsWith("created_at"));
	expect(createdAtLines.length).toBe(2);
	expect(createdAtLines[0]).not.toContain(".");
	expect(createdAtLines[0].endsWith('Z"')).toBe(true);
	expect(createdAtLines[1]).toContain('.456Z"');
});

// oracle :1586 due_jobs_marks_running_and_skips_overlap
it("due_jobs marks a job running and skips overlapping re-fires", () => {
	const registry = new CronRegistry();
	const job = registry.addJob("* * * * *", "do work");
	const since = new Date(2026, 4, 26, 22, 0, 0);
	const now = new Date(2026, 4, 26, 22, 1, 5);
	const due = registry.dueJobs(since, now);
	expect(due.length).toBe(1);
	expect(due[0][0].id).toBe(job.id);
	expect(registry.list()[0].running_trace_id).toBeDefined();

	const later = new Date(2026, 4, 26, 22, 2, 5);
	const skipped = registry.dueJobs(now, later);
	expect(skipped).toEqual([]);
	expect(registry.list()[0].skipped_overlap_count).toBe(1);
});

// oracle :1603 listener_clears_running_job_by_trace_id
it("listener clears a running job by trace id on TriggerCompleted", () => {
	const registry = new CronRegistry();
	registry.addJob("* * * * *", "do work");
	const since = new Date(2026, 4, 26, 22, 0, 0);
	const now = new Date(2026, 4, 26, 22, 1, 5);
	const traceId = registry.dueJobs(since, now)[0][0].running_trace_id;
	expect(traceId).toBeDefined();
	if (traceId === undefined) throw new Error("unreachable");

	const dir = tempDir();
	const listener = cronHarnessListener(registry, join(dir, "unused-inbox.jsonl"));
	listener({ type: "trigger_completed", traceId, summary: undefined, costUsd: undefined, details: null });

	const job = registry.list()[0];
	expect(job.running_trace_id).toBeUndefined();
	expect(job.last_completed_at).toBeDefined();
});

// oracle :1629 cron_action_hook_maps_cron_trigger_to_inject_and_run
it("cron action hook maps a non-stateful cron trigger to InjectAndRun", async () => {
	const registry = new CronRegistry();
	const job = registry.addJob("* * * * *", "run tests");
	const trigger = cronTriggerForJob(job, new Date(), "trace-cron");
	const inner = async (ctx: BeforeTriggerActionContext) => ({
		prompt: `${ctx.trigger.source_label} fired: ${ctx.trigger.event_label}`,
		promote: { kind: "none" as const },
		promoteRequiresApproval: false,
		delivery: "sub_agent" as const,
	});
	const hook = cronActionHook(registry, inner);
	const runtime: TriggerRuntimeSnapshot = {
		dedupEntries: 0,
		activeTraces: 0,
		acceptedTotal: 0,
		dedupedTotal: 0,
		cycleSuppressedTotal: 0,
	};
	const controller = new AbortController();
	const action = await hook({ trigger, runtime }, controller.signal);
	expect(action.prompt).toBe("run tests");
	expect(action.delivery).toBe("inject_and_run");
});
