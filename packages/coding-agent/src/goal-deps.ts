/**
 * Local stand-in for the harness surface `packages/coding-agent/src/goal.ts` (port of oracle
 * `crates/coding-agent/src/goal.rs`) needs but that `@pie/agent-core`'s real `AgentHarness` class
 * does not expose publicly.
 *
 * `getModel`/`runEvaluator` below ARE the real `@pie/agent-core` `AgentHarness` public methods
 * (`packages/agent/src/harness/agent-harness.ts` — `runEvaluator` landed alongside this unit per
 * `migration/reviews/agent/gap-continuation.md`'s phase-11 hand-off) — a real `AgentHarness`
 * instance already satisfies those two structurally. Only the session-append/read surface is
 * still missing: `AgentHarness` holds its `Session` in a *private* field and exposes no public
 * accessor. This is the EXACT gap `triggers/cron-deps.ts`'s `AgentHarnessSession`/`HarnessCell`
 * stub already documents and works around (see that file's header comment for the full
 * rationale) — `GoalHarnessSession` below mirrors it for goal.ts's own two needs: reading every
 * entry (`current()` scans in reverse for the latest `goal_state` custom entry, oracle
 * `Session::entries()` — the UNFILTERED full entry list, not `Session::branch()`) and appending
 * one (`set`/`pause`/`resume`/`clear`, and the stop hook's own persisted decisions).
 *
 * TODO(port): once a real public `session()` accessor lands on `AgentHarness` (tracked by
 * cron-deps.ts's identical TODO), delete this file and repoint goal.ts's import at the real type.
 */

import type { EvaluatorOutput, ThinkingLevel } from "@pie/agent-core";
import type { Model } from "@pie/ai";

/** Wire-identical subset of `@pie/agent-core`'s `SessionTreeEntry` (`type: "custom"` variant)
 * that goal.ts's own entry scan needs. A real `Session`/`AgentHarness.session()` entry already
 * satisfies this structurally — no separate stub type per entry kind. */
export interface GoalSessionEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

/** pie: `Session::entries()` (session.rs:394, `self.storage.get_entries().await`) +
 * `Session::append_custom()`. A real `@pie/agent-core` `Session` instance already satisfies this
 * structurally (`getEntries()`/`appendCustomEntry()` are its real public method names). */
export interface GoalHarnessSession {
	getEntries(): Promise<GoalSessionEntry[]>;
	appendCustomEntry(customType: string, data?: unknown): Promise<string>;
}

/** pie: the `harness: &Arc<AgentHarness>` parameter every exported goal.rs function takes, plus
 * the two members `evaluate_stop_hook` reads off it (`harness.session()`, `harness.agent().state
 * ().model`/`run_evaluator`). `getModel`/`runEvaluator` are real `AgentHarness` methods; `session`
 * is the local stand-in documented above. */
export interface GoalHarness {
	session(): GoalHarnessSession;
	getModel(): Model<any>;
	runEvaluator(
		systemPrompt: string,
		userPrompt: string,
		model: Model<any>,
		thinkingLevel: ThinkingLevel,
		signal: AbortSignal,
	): Promise<EvaluatorOutput>;
}

/**
 * Rust: `type HarnessCell = Arc<OnceLock<Arc<AgentHarness>>>` (agent_harness.rs's own doc on
 * `goal::stop_hook`'s parameter) — a lazily-settable cell so `stopHook(cell)` can be constructed
 * and registered as the harness's `onTurnEnd` option BEFORE the harness it will eventually run
 * under exists (the harness constructor needs the hook; the hook needs the harness). `get()`
 * returns `undefined` until the cell is filled, matching `stopHook`'s "goal hook was not
 * initialized" pause path. Mirrors `triggers/cron-deps.ts`'s identical `HarnessCell` shape.
 */
export interface GoalHarnessCell {
	get(): GoalHarness | undefined;
}
