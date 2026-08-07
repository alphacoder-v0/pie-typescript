import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_BASE_DIR, getAgentDir } from "../../src/config.ts";
import { automationCountsBadge } from "../../src/core/session-manager.ts";
import { type GoalState, type GoalStatus, isGoalActive } from "../../src/goal.ts";
import { createEmptySkillsState, setSkillState } from "../../src/skills-state.ts";
import { createSetSkillStateToolDefinition } from "../../src/tools/set-skill-state.ts";
import { CronRegistry } from "../../src/triggers/cron.ts";
import { DynamicTriggerRegistry } from "../../src/triggers/dynamic.ts";

/**
 * phase 22 calibration batch (phase 3) — the `new-test` verdicts on the coding-agent side.
 *
 * These functions are listed in `migration/reviews/phase22/roster.tsv`: `check:surface-coverage`
 * finds a counterpart of the same name on the TS side, but **no assertion has ever touched the
 * behavior**. Each test states the upstream basis first (the `oracle:` section), then asserts the
 * equivalent behavior here.
 *
 * It is called a calibration because phase 3's job was to measure how many of 282 functions could
 * point at an existing assertion and how many needed a new one. These are the latter.
 */
describe("phase 22 calibration batch — coding-agent", () => {
	// ── coding-agent/src/triggers/dynamic.rs::clear_rules@197 ──────────────────
	//
	// oracle:
	//   pub fn clear_rules(&self) -> Result<usize, DynamicTriggerStorageError> {
	//       let count = state.rules.len();
	//       if count == 0 { return Ok(0); }
	//       if let Some(path) = &state.storage_path { write_rules_file(path, &[])?; }
	//       state.rules.clear();
	//       Ok(count)
	//   }
	//
	// Two observable behaviors: it returns the count **before** the clear — not 0, not what is left —
	// and it short-circuits to 0 on an empty table without touching storage.
	describe("DynamicTriggerRegistry.clearRules", () => {
		it("returns the number of rules removed, not the remaining count", () => {
			const registry = new DynamicTriggerRegistry();
			registry.addRule("cond-a", "action-a");
			registry.addRule("cond-b", "action-b");

			expect(registry.clearRules()).toBe(2);
		});

		it("leaves the registry empty afterwards", () => {
			const registry = new DynamicTriggerRegistry();
			registry.addRule("cond-a", "action-a");
			registry.clearRules();

			expect(registry.list()).toEqual([]);
		});

		it("short-circuits to 0 on an already-empty registry", () => {
			// Upstream's `if count == 0 { return Ok(0) }` — an empty table writes nothing and raises nothing.
			const registry = new DynamicTriggerRegistry();

			expect(registry.clearRules()).toBe(0);
		});
	});

	// ── coding-agent/src/triggers/cron.rs::mark_completed@254 ──────────────────
	//
	// oracle:
	//   pub fn mark_completed(&self, trace_id: &str, error: Option<String>) {
	//       let Some(pos) = state.jobs.iter().position(|job|
	//           job.running_trace_id.as_deref() == Some(trace_id)) else { return; };
	//       next[pos].running_trace_id = None;
	//       next[pos].last_completed_at = Some(Utc::now());
	//   }
	//
	// The point is that it looks up **by trace_id**: a trace_id that matches nothing has to be a no-op,
	// not "clear the first running job" — the latter lets two concurrent jobs step on each other.
	describe("CronRegistry.markCompleted", () => {
		it("clears running_trace_id and stamps last_completed_at for the matching job", () => {
			const registry = new CronRegistry();
			const job = registry.addJob("* * * * *", "do the thing");
			// Drive it into running. Upstream does the same: `due_jobs` marks it running and generates the
			// trace_id (cron.rs:641 onwards); the registry has no separate markRunning entry point.
			const due = registry.dueJobs(new Date(2026, 4, 26, 22, 0, 0), new Date(2026, 4, 26, 22, 1, 5));
			const traceId = due[0]?.[0].running_trace_id;
			expect(traceId).toBeDefined();
			if (traceId === undefined) throw new Error("unreachable");

			registry.markCompleted(traceId, undefined);

			const after = registry.list().find((j) => j.id === job.id);
			expect(after?.running_trace_id).toBeUndefined();
			expect(after?.last_completed_at).toBeTruthy();
		});

		it("records the error string when the run failed", () => {
			const registry = new CronRegistry();
			const job = registry.addJob("* * * * *", "do the thing");
			const due = registry.dueJobs(new Date(2026, 4, 26, 22, 0, 0), new Date(2026, 4, 26, 22, 1, 5));
			const traceId = due[0]?.[0].running_trace_id;
			expect(traceId).toBeDefined();
			if (traceId === undefined) throw new Error("unreachable");

			registry.markCompleted(traceId, "boom");

			expect(registry.list().find((j) => j.id === job.id)?.last_error).toBe("boom");
		});

		it("is a no-op for an unknown trace id — does not touch a different running job", () => {
			// This holds the line on "look up by trace_id" rather than "clear the first running one".
			const registry = new CronRegistry();
			const job = registry.addJob("* * * * *", "do the thing");
			const due = registry.dueJobs(new Date(2026, 4, 26, 22, 0, 0), new Date(2026, 4, 26, 22, 1, 5));
			const traceId = due[0]?.[0].running_trace_id;
			expect(traceId).toBeDefined();

			registry.markCompleted("no-such-trace", undefined);

			expect(registry.list().find((j) => j.id === job.id)?.running_trace_id).toBe(traceId);
		});
	});

	// ── coding-agent/src/skills_state.rs::set@54 ───────────────────────────────
	//
	// oracle:
	//   pub fn set(&mut self, name: &str, source: SkillSource, enabled: bool) {
	//       if let Some(e) = self.overrides.iter_mut()
	//           .find(|e| e.name == name && e.source == source) { e.enabled = enabled; }
	//       else { self.overrides.push(SkillStateEntry { name, source, enabled }); }
	//   }
	//
	// The key is the **{name, source} pair**: two entries with the same name but different sources have
	// to coexist, or the user's own `foo` inherits the on/off state of the built-in `foo`.
	describe("setSkillState", () => {
		it("appends a new override when {name, source} is not present", () => {
			const next = setSkillState(createEmptySkillsState(), "alpha", "user", false);

			expect(next.overrides).toEqual([{ name: "alpha", source: "user", enabled: false }]);
		});

		it("updates in place when {name, source} already exists — no duplicate row", () => {
			const once = setSkillState(createEmptySkillsState(), "alpha", "user", false);
			const twice = setSkillState(once, "alpha", "user", true);

			expect(twice.overrides).toEqual([{ name: "alpha", source: "user", enabled: true }]);
		});

		it("keys on {name, source} together — same name from a different source coexists", () => {
			const withUser = setSkillState(createEmptySkillsState(), "alpha", "user", false);
			const withBuiltin = setSkillState(withUser, "alpha", "builtin", true);

			expect(withBuiltin.overrides).toEqual([
				{ name: "alpha", source: "user", enabled: false },
				{ name: "alpha", source: "builtin", enabled: true },
			]);
		});
	});

	// ── coding-agent/src/config.rs::base_dir@10 ────────────────────────────────
	//
	// oracle:
	//   pub fn base_dir() -> PathBuf {
	//       if let Ok(p) = std::env::var("PIE_DIR") { return PathBuf::from(p); }
	//       directories::BaseDirs::new().map(|d| d.home_dir().join(".pie"))...
	//   }
	//
	// `PIE_DIR` wins over home, and is taken **verbatim with no tilde expansion** (upstream uses
	// `PathBuf::from(p)`). This is not academic: while making the tests hermetic in phase 2, that very
	// precedence let `test.sh`'s `PIE_DIR` override the `PI_CODING_AGENT_DIR` the tests set themselves.
	describe("getAgentDir (oracle base_dir)", () => {
		let previous: string | undefined;

		beforeEach(() => {
			previous = process.env[ENV_BASE_DIR];
		});

		afterEach(() => {
			if (previous === undefined) delete process.env[ENV_BASE_DIR];
			else process.env[ENV_BASE_DIR] = previous;
		});

		it("takes PIE_DIR verbatim when set", () => {
			const dir = mkdtempSync(join(tmpdir(), "pie-basedir-"));
			try {
				process.env[ENV_BASE_DIR] = dir;

				expect(getAgentDir()).toBe(dir);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("does not tilde-expand PIE_DIR — oracle is PathBuf::from(p)", () => {
			process.env[ENV_BASE_DIR] = "~/literal-not-expanded";

			expect(getAgentDir()).toBe("~/literal-not-expanded");
		});

		it("falls back to a .pie directory when PIE_DIR is unset", () => {
			delete process.env[ENV_BASE_DIR];
			const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
			delete process.env.PI_CODING_AGENT_DIR;
			try {
				expect(getAgentDir().endsWith(".pie")).toBe(true);
			} finally {
				if (previousAgentDir !== undefined) process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			}
		});
	});

	// ── coding-agent/src/session/mod.rs::badge@255 ─────────────────────────────
	//
	// Upstream this is the badge fragment of "automation is session-scoped: session <id> has <badge>
	// enabled" in the session list. All three branches need cover: both kinds, one kind, neither.
	describe("automationCountsBadge", () => {
		it("joins both counts with a comma when cron and trigger are both enabled", () => {
			expect(automationCountsBadge({ cronEnabled: 2, triggerEnabled: 1, cronTotal: 2, triggerTotal: 1 })).toBe(
				"2 cron, 1 trigger",
			);
		});

		it("emits only the non-zero half", () => {
			expect(automationCountsBadge({ cronEnabled: 3, triggerEnabled: 0, cronTotal: 3, triggerTotal: 0 })).toBe(
				"3 cron",
			);
		});

		it("returns undefined when there is nothing to report", () => {
			// An empty count returns undefined rather than an empty string — the caller uses that to decide
			// whether to print the sentence at all.
			expect(
				automationCountsBadge({ cronEnabled: 0, triggerEnabled: 0, cronTotal: 0, triggerTotal: 0 }),
			).toBeUndefined();
		});
	});

	// ── coding-agent/src/goal.rs::as_str@32 ───────────────────────────────────
	//
	// oracle:
	//   pub fn as_str(&self) -> &'static str {
	//       match self { Self::Pursuing => "pursuing", Self::Paused => "paused",
	//                    Self::Achieved => "achieved", Self::BudgetLimited => "budget_limited",
	//                    Self::Cleared => "cleared" }
	//   }
	//
	// Upstream this is an enum mapped to its **wire strings**; here it is the literal union `GoalStatus`
	// plus the `GOAL_STATUSES` array used for runtime validation. The observable behavior is the same
	// question: which strings `parseGoalState` accepts. Get one wrong — `budgetLimited` instead of
	// `budget_limited` — and a session file written upstream no longer reads here, silently losing the
	// goal state.
	describe("the GoalStatus wire format (upstream as_str)", () => {
		const goalWith = (status: GoalStatus): GoalState => ({
			condition: "c",
			status,
			iterations: 0,
			updated_at: "2026-01-01T00:00:00Z",
		});

		it("treats exactly the three upstream active states as active — pursuing / paused / budget_limited", () => {
			// oracle: goal.rs:54-61 `GoalState::active` —— Pursuing | Paused | BudgetLimited。
			// The literals `as_str` produces are consumed right here, so this holds both sides at once.
			const activeOnes = (["pursuing", "paused", "budget_limited"] as const).map((status) =>
				isGoalActive(goalWith(status)),
			);

			expect(activeOnes, "pursuing, paused and budget_limited all have to be active").toEqual([true, true, true]);
		});

		it("treats achieved / cleared as inactive", () => {
			const inactiveOnes = (["achieved", "cleared"] as const).map((status) => isGoalActive(goalWith(status)));

			expect(inactiveOnes, "achieved and cleared both have to be inactive").toEqual([false, false]);
		});

		it("uses oracle's snake_case wire spelling — a camelCase variant is not active", () => {
			// `budgetLimited` in camelCase is the likeliest slip; upstream's as_str writes `budget_limited`.
			// A misspelling does not raise: a session file written upstream simply loses its goal state here.
			// This feeds a misspelled value past the type system to confirm the runtime does not treat it as
			// active.
			expect(
				isGoalActive({
					condition: "c",
					status: "budgetLimited" as GoalStatus,
					iterations: 0,
					updated_at: "2026-01-01T00:00:00Z",
				}),
			).toBe(false);
		});
	});

	// ── coding-agent/src/tools/mod.rs::set_skill_state_tool@108 ───────────────
	//
	// Upstream registers `SetSkillStateTool` in the tool table in `tools/mod.rs`. Here that is
	// `createSetSkillStateToolDefinition(cwd, options)`. What is asserted is the **tool definition
	// itself** — its name and parameter schema — because that is the contract the model sees. Change
	// the name or a required parameter and the model can no longer call the tool, which shows up at
	// runtime as the model saying it did something while nothing happened.
	describe("createSetSkillStateToolDefinition", () => {
		it("exposes the oracle tool name and requires name/source/enabled", () => {
			const dir = mkdtempSync(join(tmpdir(), "pie-skillstate-tool-"));
			try {
				const def = createSetSkillStateToolDefinition(dir, { agentDir: dir });

				expect(def.name).toBe("SetSkillState");
				expect(Object.keys(def.parameters.properties ?? {}).sort()).toEqual([
					"confirm",
					"enabled",
					"name",
					"source",
				]);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});
});
