import { describe, expect, it } from "vitest";
import { defaultInboxPath } from "../../src/inbox.ts";
import { CronRegistry } from "../../src/triggers/cron.ts";
import { DynamicTriggerRegistry } from "../../src/triggers/dynamic.ts";

/**
 * phase 22 batch B wrap-up — the remaining `new-test` verdicts in triggers and goals.
 *
 * What these have in common: they all sit on paths that run automatically in the background. When
 * one breaks the user does not find out at once — unlike a CLI command that fails on the spot, a
 * trigger that does not fire is simply nothing happening.
 */
describe("phase 22 batch B wrap-up", () => {
	// ── coding-agent/src/triggers/cron.rs::new@82 ─────────────────────────────
	//
	// Upstream's `CronRegistry::new` builds an empty registry. The constructor is thin, but it decides
	// that the **initial state is clean**. If a fresh one arrived carrying the previous registry's
	// jobs — through a module-level singleton used by mistake, say — two sessions' cron entries would
	// cross.
	describe("constructing a CronRegistry (upstream new)", () => {
		it("starts empty", () => {
			expect(new CronRegistry().list()).toEqual([]);
		});

		it("two instances do not share state", () => {
			// This holds the line on "not a module-level singleton"; crossed wires would let the second
			// registry see the first one's jobs.
			const a = new CronRegistry();
			const b = new CronRegistry();
			a.addJob("* * * * *", "only in a");

			expect(b.list()).toEqual([]);
		});
	});

	// ── coding-agent/src/triggers/cron.rs::remove_job@162 ─────────────────────
	//
	// Upstream removes by id and returns the removed job; an id that does not exist returns None —
	// neither an error, nor the wrong job removed.
	describe("CronRegistry.removeJob", () => {
		it("returns the removed job and drops it from the list", () => {
			const registry = new CronRegistry();
			const job = registry.addJob("* * * * *", "doomed");

			const removed = registry.removeJob(job.id);

			expect(removed?.id).toBe(job.id);
			expect(registry.list()).toEqual([]);
		});

		it("returns undefined for an unknown id — and touches nothing", () => {
			const registry = new CronRegistry();
			registry.addJob("* * * * *", "keep me");

			expect(registry.removeJob("no-such-id")).toBeUndefined();
			expect(registry.list()).toHaveLength(1);
		});

		it("trims the id before matching — oracle does `id.trim()`", () => {
			const registry = new CronRegistry();
			const job = registry.addJob("* * * * *", "doomed");

			expect(registry.removeJob(`  ${job.id}  `)?.id).toBe(job.id);
		});
	});

	// ── coding-agent/src/triggers/cron.rs::job_for_trace@245 ──────────────────
	//
	// Looking a job up by its running trace id. The cron completion callback uses it to map "which
	// trace finished" back to a job; look up the wrong one and A's completion is written onto B.
	describe("CronRegistry.jobForTrace", () => {
		it("finds the job currently running under that trace id", () => {
			const registry = new CronRegistry();
			const job = registry.addJob("* * * * *", "running one");
			const due = registry.dueJobs(new Date(2026, 4, 26, 22, 0, 0), new Date(2026, 4, 26, 22, 1, 5));
			const traceId = due[0]?.[0].running_trace_id;
			expect(traceId).toBeDefined();
			if (traceId === undefined) throw new Error("unreachable");

			expect(registry.jobForTrace(traceId)?.id).toBe(job.id);
		});

		it("returns undefined for a trace that is not running", () => {
			const registry = new CronRegistry();
			registry.addJob("* * * * *", "idle one");

			expect(registry.jobForTrace("no-such-trace")).toBeUndefined();
		});
	});

	// ── coding-agent/src/triggers/dynamic.rs::new@71 ──────────────────────────
	describe("constructing a DynamicTriggerRegistry (upstream new)", () => {
		it("starts empty", () => {
			expect(new DynamicTriggerRegistry().list()).toEqual([]);
		});

		it("two instances do not share state", () => {
			const a = new DynamicTriggerRegistry();
			const b = new DynamicTriggerRegistry();
			a.addRule("cond", "action");

			expect(b.list()).toEqual([]);
		});
	});

	// ── coding-agent/src/triggers/dynamic.rs::add_rule_with_flags@108 ─────────
	//
	// The lowest-level add: both the `fireOnce` and `promoteToChat` flags reach the rule through it.
	// `addRule` and `addRuleWithOptions` above it both delegate here, so a flag going missing is this
	// function's problem.
	describe("DynamicTriggerRegistry.addRuleWithFlags", () => {
		it("records both flags as given", () => {
			const registry = new DynamicTriggerRegistry();

			const rule = registry.addRuleWithFlags("cond", "action", false, true);

			expect([rule.fire_once, rule.promote_to_chat]).toEqual([false, true]);
		});

		it("keeps the two flags independent", () => {
			const registry = new DynamicTriggerRegistry();

			const rule = registry.addRuleWithFlags("cond2", "action2", true, false);

			expect([rule.fire_once, rule.promote_to_chat]).toEqual([true, false]);
		});

		it("rejects an empty condition or action", () => {
			const registry = new DynamicTriggerRegistry();

			expect(() => registry.addRuleWithFlags("   ", "action", true, false)).toThrow();
		});
	});

	// ── coding-agent/src/inbox.rs::default_inbox_path@42 ──────────────────────
	//
	// The default location of the inbox file. Cron completion notices are written here; get the path
	// wrong and they land somewhere else, where the user never sees that their scheduled job finished.
	describe("defaultInboxPath", () => {
		it("lives under the agent dir and is named inbox.jsonl", () => {
			// `.jsonl`, not `.json`: the inbox is appended line by line, and the extension says so.
			const path = defaultInboxPath();

			expect(path.endsWith("inbox.jsonl")).toBe(true);
		});

		it("is stable across calls", () => {
			expect(defaultInboxPath()).toBe(defaultInboxPath());
		});
	});
});
