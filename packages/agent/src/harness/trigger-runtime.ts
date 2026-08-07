/**
 * Port of oracle `crates/agent/src/harness/trigger_runtime.rs` (pie @0a120dfd).
 *
 * RFC 1 (issue #20) dedup window + cycle suppression engine.
 *
 * Pure logic, no IO. Behaviour matches RFC 1 §5:
 * - **Dedup window**: same `idempotency_key` seen twice within `dedupWindowMs` (default 5
 *   minutes) → outcome depends on the *first* trigger's `ReplacementPolicy` (RFC 1 §11 fixed
 *   decision #4 — sources declare per-event; the runtime trusts the first arrival's declaration
 *   to set the window's collapse semantics).
 * - **Cycle suppression**: when the same `trace_id` exceeds `cycleHopLimit` (default 5) →
 *   forced `CycleSuppressed`. Each accepted trigger bumps the per-trace hop counter.
 *
 * Concurrency mapping (RULEBOOK §2.2): oracle wraps its state in `Arc<parking_lot::Mutex<Inner>>`
 * (trigger_runtime.rs:80). §2.2's judgment is mechanical: does the critical section cross an
 * `.await`? `evaluate()` and `recordFollowUpHop()` below are both fully synchronous end-to-end —
 * no `await` anywhere in their bodies — so per the rule this class holds its state directly as
 * private fields rather than behind the shared `AsyncMutex` util (./async-mutex.ts). Node's
 * single-threaded event loop makes every synchronous method body here atomic with respect to any
 * other synchronous caller by construction; see the
 * "evaluate is synchronous end-to-end" test in trigger-runtime.test.ts for the explicit
 * characterization test this judgment call requires (inventory.tsv tags this site
 * "await-in-critical-section test").
 */

import type { ReplacementPolicy, Trigger } from "./trigger.ts";

/** oracle trigger_runtime.rs:40 (`DEFAULT_DEDUP_WINDOW`, `Duration::from_secs(5 * 60)`). */
export const DEFAULT_DEDUP_WINDOW_MS = 5 * 60 * 1000;
/** oracle trigger_runtime.rs:41 (`DEFAULT_CYCLE_HOP_LIMIT`). */
export const DEFAULT_CYCLE_HOP_LIMIT = 5;
/** oracle trigger_runtime.rs:44 (`MAX_DEDUP_WINDOW`, `Duration::from_secs(24 * 60 * 60)`). */
export const MAX_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Tunable knobs for `TriggerRuntime`. oracle trigger_runtime.rs:30-37. */
export interface TriggerRuntimeConfig {
	/** ms. How long after admission the same `idempotency_key` is a duplicate. */
	dedupWindowMs: number;
	/** Max `trace_id` chain depth before the runtime forces `CycleSuppressed`. */
	cycleHopLimit: number;
}

function defaultTriggerRuntimeConfig(): TriggerRuntimeConfig {
	return { dedupWindowMs: DEFAULT_DEDUP_WINDOW_MS, cycleHopLimit: DEFAULT_CYCLE_HOP_LIMIT };
}

/**
 * Result of running a `Trigger` through `TriggerRuntime.evaluate`. oracle
 * trigger_runtime.rs:59-74. Non-wire (the oracle enum has no `Serialize`/`Deserialize` derive),
 * so this uses the codebase's idiomatic `type`-tagged discriminated union rather than the
 * wire-governed `kind` tag `./trigger.ts`'s `TriggerSource` uses.
 */
export type EvaluationOutcome =
	| { type: "accept" }
	| { type: "deduped"; replacementPolicy: ReplacementPolicy; previousTraceId: string }
	| { type: "cycleSuppressed"; hopCount: number };

/** Point-in-time view of dedup/cycle bookkeeping. oracle trigger_runtime.rs:109-122. */
export interface TriggerRuntimeSnapshot {
	dedupEntries: number;
	activeTraces: number;
	acceptedTotal: number;
	dedupedTotal: number;
	cycleSuppressedTotal: number;
}

interface DedupEntry {
	receivedAtMs: number;
	replacementPolicy: ReplacementPolicy;
	traceId: string;
}

interface CycleEntry {
	lastSeenAtMs: number;
	hopCount: number;
}

/**
 * In-memory dedup + cycle registry shared across all `NotificationHook` sources for a single
 * agent/daemon. State is **process-local only**: there is no persistence, so a process restart
 * resets both the dedup map and the cycle counters to empty (this is documented oracle behavior,
 * not a bug — RULEBOOK §5 footer: "dedup and cycle state live in the process only, and reset on restart") — see the
 * "state does not survive a fresh TriggerRuntime instance" test.
 */
export class TriggerRuntime {
	private readonly dedup = new Map<string, DedupEntry>();
	private readonly cycle = new Map<string, CycleEntry>();
	private dedupedTotal = 0;
	private cycleSuppressedTotal = 0;
	private acceptedTotal = 0;
	private readonly runtimeConfig: TriggerRuntimeConfig;

	/**
	 * Replaces the oracle's separate `TriggerRuntime::new()` (no-arg) and
	 * `TriggerRuntime::with_config(config)` constructors — a single constructor covers both
	 * call shapes in idiomatic TS. `dedupWindowMs` is clamped to `MAX_DEDUP_WINDOW_MS`
	 * (oracle trigger_runtime.rs:145-148).
	 */
	constructor(config: Partial<TriggerRuntimeConfig> = {}) {
		const merged = { ...defaultTriggerRuntimeConfig(), ...config };
		this.runtimeConfig = {
			...merged,
			dedupWindowMs: Math.min(merged.dedupWindowMs, MAX_DEDUP_WINDOW_MS),
		};
	}

	/**
	 * oracle trigger_runtime.rs:175-178 (`TriggerRuntime::config`). oracle's `TriggerRuntimeConfig`
	 * is `#[derive(Clone, Copy, ...)]` (trigger_runtime.rs:29), so `self.config` there always
	 * hands the caller a value copy — mutating it can never reach back into the runtime. Returning
	 * `this.runtimeConfig` directly would leak the live reference: a caller doing
	 * `runtime.config.dedupWindowMs = 999` mutates internal state in place, silently bypassing the
	 * `MAX_DEDUP_WINDOW_MS` clamp applied in the constructor. Return a shallow copy instead.
	 */
	get config(): TriggerRuntimeConfig {
		return { ...this.runtimeConfig };
	}

	/** oracle trigger_runtime.rs:161-173 (`TriggerRuntime::snapshot`). */
	snapshot(): TriggerRuntimeSnapshot {
		return {
			dedupEntries: this.dedup.size,
			activeTraces: this.cycle.size,
			acceptedTotal: this.acceptedTotal,
			dedupedTotal: this.dedupedTotal,
			cycleSuppressedTotal: this.cycleSuppressedTotal,
		};
	}

	/**
	 * Decide whether `trigger` should be admitted, deduped, or cycle-suppressed. oracle
	 * trigger_runtime.rs:191-244 (`TriggerRuntime::evaluate`).
	 *
	 * PORT-DIVERGENCE: B9 (RULEBOOK §5; oracle trigger_runtime.rs:387-394 + this method's dedup
	 * branch, trigger_runtime.rs:200-207). **Fixed in phase 18 — this no longer matches oracle.**
	 *
	 * Oracle never honors `ReplacementPolicy::LatestReplaces` inside the dedup window: its dedup
	 * branch only READS the stored entry to report it back in `Deduped`, and never writes the map
	 * again, so the first arrival's `trace_id` survives the whole window. `LatestReplaces` is
	 * therefore indistinguishable from `Drop`/`Coalesce` — first-wins under a name that promises
	 * latest-wins, which silently pins downstream correlation to a trace the caller believes it
	 * superseded.
	 *
	 * Here the stored `traceId` is replaced when the governing policy is `latest_replaces`, so
	 * `previousTraceId` walks forward with each duplicate. Two invariants are deliberately kept
	 * from oracle:
	 *   - The **first** arrival's policy governs the window (RFC 1 §5; oracle's own
	 *     `deduped_outcome_carries_first_arrivals_replacement_policy` test) — a later duplicate
	 *     declaring a different policy cannot change how the window collapses.
	 *   - `receivedAtMs` is NOT refreshed, so the window still expires `dedupWindowMs` after the
	 *     FIRST arrival. Sliding it would let an unbroken duplicate stream hold a key forever.
	 */
	evaluate(trigger: Trigger): EvaluationOutcome {
		const nowMs = Date.parse(trigger.received_at);
		pruneExpired(this.dedup, nowMs, this.runtimeConfig.dedupWindowMs);
		pruneExpiredCycle(this.cycle, nowMs, this.runtimeConfig.dedupWindowMs);

		// Dedup check runs first: a duplicate event is never "real" for cycle counting.
		const prev = this.dedup.get(trigger.idempotency_key);
		if (prev !== undefined) {
			this.dedupedTotal = saturatingIncrement(this.dedupedTotal);
			const outcome: EvaluationOutcome = {
				type: "deduped",
				replacementPolicy: prev.replacementPolicy,
				previousTraceId: prev.traceId,
			};
			if (prev.replacementPolicy === "latest_replaces") {
				this.dedup.set(trigger.idempotency_key, { ...prev, traceId: trigger.trace_id });
			}
			return outcome;
		}

		// Cycle check runs against the counter as it stands BEFORE this trigger.
		const existingCycle = this.cycle.get(trigger.trace_id);
		if (existingCycle !== undefined && existingCycle.hopCount >= this.runtimeConfig.cycleHopLimit) {
			this.cycleSuppressedTotal = saturatingIncrement(this.cycleSuppressedTotal);
			return { type: "cycleSuppressed", hopCount: existingCycle.hopCount };
		}

		// Admit. Record both the dedup entry and the hop bump.
		this.dedup.set(trigger.idempotency_key, {
			receivedAtMs: nowMs,
			replacementPolicy: trigger.replacement_policy,
			traceId: trigger.trace_id,
		});
		if (existingCycle !== undefined) {
			existingCycle.hopCount += 1;
			existingCycle.lastSeenAtMs = nowMs;
		} else {
			this.cycle.set(trigger.trace_id, { hopCount: 1, lastSeenAtMs: nowMs });
		}
		this.acceptedTotal = saturatingIncrement(this.acceptedTotal);
		return { type: "accept" };
	}

	/**
	 * Record an additional hop on `traceId` without going through dedup. oracle
	 * trigger_runtime.rs:246-266 (`TriggerRuntime::record_follow_up_hop`). Called immediately
	 * before spawning a follow-up trigger that inherits the parent's trace.
	 */
	recordFollowUpHop(traceId: string, now: Date): void {
		const nowMs = now.getTime();
		pruneExpiredCycle(this.cycle, nowMs, this.runtimeConfig.dedupWindowMs);
		const existing = this.cycle.get(traceId);
		if (existing !== undefined) {
			existing.hopCount += 1;
			existing.lastSeenAtMs = nowMs;
		} else {
			this.cycle.set(traceId, { hopCount: 1, lastSeenAtMs: nowMs });
		}
	}

	/** Test helper mirroring oracle's `#[cfg(test)] pub(crate) fn dedup_entry_count`. */
	dedupEntryCount(): number {
		return this.dedup.size;
	}

	/** Test helper mirroring oracle's `#[cfg(test)] pub(crate) fn cycle_entry_count`. */
	cycleEntryCount(): number {
		return this.cycle.size;
	}
}

/**
 * oracle's three lifetime counters (`deduped_total`, `cycle_suppressed_total`, `accepted_total`
 * — trigger_runtime.rs:100-102, "never decrement and survive entry pruning") are `u64`, bumped
 * with `.saturating_add(1)` (trigger_runtime.rs:205, 216, 241) rather than plain `+`, so a
 * pathologically long-lived process cannot wrap the counter back through zero at `u64::MAX`.
 *
 * JS `number` has no integer-saturating-arithmetic primitive, and RULEBOOK §2.1 already maps
 * `u64` counters to plain `number` on the (accurate, for these fields) assumption that realistic
 * counts stay well under 2^53. Reaching `Number.MAX_SAFE_INTEGER` (2^53-1) via `evaluate()` calls
 * is practically unreachable (billions of years at any plausible trigger rate) — this clamp exists
 * purely so the TS counter is wire-faithful to oracle's "never overflow" invariant rather than
 * silently losing integer precision (`+1` past 2^53 stops incrementing predictably) if the
 * unreachable ever happens. Chosen over a comment-only approach because the fix is a one-line,
 * zero-cost substitution with no behavioral difference below the ceiling.
 */
function saturatingIncrement(n: number): number {
	return n < Number.MAX_SAFE_INTEGER ? n + 1 : Number.MAX_SAFE_INTEGER;
}

/** oracle trigger_runtime.rs:282-286 (`prune_expired`). */
function pruneExpired(map: Map<string, DedupEntry>, nowMs: number, windowMs: number): void {
	const cutoff = nowMs - windowMs;
	for (const [key, entry] of map) {
		if (entry.receivedAtMs < cutoff) map.delete(key);
	}
}

/** oracle trigger_runtime.rs:288-296 (`prune_expired_cycle`). */
function pruneExpiredCycle(map: Map<string, CycleEntry>, nowMs: number, windowMs: number): void {
	const cutoff = nowMs - windowMs;
	for (const [key, entry] of map) {
		if (entry.lastSeenAtMs < cutoff) map.delete(key);
	}
}
