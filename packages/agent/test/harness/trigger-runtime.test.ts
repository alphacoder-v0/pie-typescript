import { describe, expect, it } from "vitest";
import type { ReplacementPolicy, Trigger } from "../../src/harness/trigger.ts";
import {
	DEFAULT_CYCLE_HOP_LIMIT,
	DEFAULT_DEDUP_WINDOW_MS,
	MAX_DEDUP_WINDOW_MS,
	TriggerRuntime,
} from "../../src/harness/trigger-runtime.ts";

const FIXED_NOW = new Date(1_700_000_000_000);

function makeTriggerAt(idempotency: string, trace: string, policy: ReplacementPolicy, receivedAt: Date): Trigger {
	return {
		source: { kind: "local", subkind: "test" },
		source_kind: "local",
		source_label: "test",
		event_label: "fire",
		payload_visibility: "local",
		payload_summary: null,
		payload: undefined,
		idempotency_key: idempotency,
		replacement_policy: policy,
		trace_id: trace,
		authority: {
			principal_id: "test:principal",
			principal_label: "test",
			credential_scope: "Project",
			allowed_source_actions: [],
			expires_at: undefined,
		},
		received_at: receivedAt.toISOString(),
	};
}

function makeTrigger(idempotency: string, trace: string, policy: ReplacementPolicy): Trigger {
	return makeTriggerAt(idempotency, trace, policy, FIXED_NOW);
}

describe("TriggerRuntime.evaluate", () => {
	it("accepts the first admission of a fresh idempotency key", () => {
		const runtime = new TriggerRuntime();
		const outcome = runtime.evaluate(makeTrigger("k1", "t1", "drop"));
		expect(outcome).toEqual({ type: "accept" });
		expect(runtime.dedupEntryCount()).toBe(1);
		expect(runtime.cycleEntryCount()).toBe(1);
	});

	it("dedupes a duplicate within the window, reporting the previous trace id", () => {
		const runtime = new TriggerRuntime();
		runtime.evaluate(makeTrigger("k1", "trace-original", "drop"));
		const outcome = runtime.evaluate(makeTrigger("k1", "trace-duplicate", "drop"));
		expect(outcome).toEqual({ type: "deduped", replacementPolicy: "drop", previousTraceId: "trace-original" });
		// A deduped event must not allocate a cycle entry for its own trace_id (dedup
		// short-circuits before cycle counting).
		expect(runtime.cycleEntryCount()).toBe(1);
	});

	it("reports the FIRST arrival's replacement policy, even when the duplicate declares a different one", () => {
		const runtime = new TriggerRuntime();
		runtime.evaluate(makeTrigger("k1", "t1", "latest_replaces"));
		const outcome = runtime.evaluate(makeTrigger("k1", "t2", "drop"));
		expect(outcome).toEqual({ type: "deduped", replacementPolicy: "latest_replaces", previousTraceId: "t1" });
	});

	it("re-admits the same key once the dedup window has expired", () => {
		const runtime = new TriggerRuntime({ dedupWindowMs: 60_000, cycleHopLimit: 10 });
		const t0 = FIXED_NOW;
		runtime.evaluate(makeTriggerAt("k1", "t1", "drop", t0));
		const justUnder = new Date(t0.getTime() + 59_000);
		expect(runtime.evaluate(makeTriggerAt("k1", "t2", "drop", justUnder)).type).toBe("deduped");
		const pastWindow = new Date(t0.getTime() + 61_000);
		const outcome = runtime.evaluate(makeTriggerAt("k1", "t3", "drop", pastWindow));
		expect(outcome).toEqual({ type: "accept" });
		expect(runtime.dedupEntryCount()).toBe(1);
	});

	it("suppresses a trace once it exceeds cycleHopLimit, reporting the pre-block hop count", () => {
		const runtime = new TriggerRuntime({ dedupWindowMs: 300_000, cycleHopLimit: 3 });
		const trace = "trace-loop";
		for (let i = 0; i < 3; i++) {
			expect(runtime.evaluate(makeTrigger(`k${i}`, trace, "drop"))).toEqual({ type: "accept" });
		}
		const suppressed = runtime.evaluate(makeTrigger("k4", trace, "drop"));
		expect(suppressed).toEqual({ type: "cycleSuppressed", hopCount: 3 });
	});

	it("recordFollowUpHop bumps the cycle counter without going through dedup", () => {
		const runtime = new TriggerRuntime({ dedupWindowMs: 300_000, cycleHopLimit: 2 });
		const trace = "trace-followup";
		expect(runtime.evaluate(makeTrigger("k1", trace, "drop"))).toEqual({ type: "accept" });
		runtime.recordFollowUpHop(trace, FIXED_NOW);
		const suppressed = runtime.evaluate(makeTrigger("k2", trace, "drop"));
		expect(suppressed).toEqual({ type: "cycleSuppressed", hopCount: 2 });
	});

	it("clamps dedupWindowMs to MAX_DEDUP_WINDOW_MS", () => {
		const runtime = new TriggerRuntime({ dedupWindowMs: 48 * 60 * 60 * 1000, cycleHopLimit: 5 });
		expect(runtime.config.dedupWindowMs).toBe(MAX_DEDUP_WINDOW_MS);
	});

	it("defaults to DEFAULT_DEDUP_WINDOW_MS / DEFAULT_CYCLE_HOP_LIMIT with no config", () => {
		const runtime = new TriggerRuntime();
		expect(runtime.config).toEqual({
			dedupWindowMs: DEFAULT_DEDUP_WINDOW_MS,
			cycleHopLimit: DEFAULT_CYCLE_HOP_LIMIT,
		});
	});

	it("config getter returns a copy — external mutation of the returned object does not affect the runtime (oracle's TriggerRuntimeConfig is Copy, trigger_runtime.rs:29,175-178)", () => {
		const runtime = new TriggerRuntime({ dedupWindowMs: 1_000, cycleHopLimit: 1 });
		const first = runtime.config;
		expect(first).not.toBe(runtime.config); // each read returns a fresh object, not a shared reference
		// Mutate the object the caller got back — this must NOT reach into the runtime's internal
		// state, and must NOT bypass the constructor's MAX_DEDUP_WINDOW_MS clamp on future reads.
		first.dedupWindowMs = 999_999_999;
		first.cycleHopLimit = 999;
		expect(runtime.config).toEqual({ dedupWindowMs: 1_000, cycleHopLimit: 1 });

		// Internal behavior must be unaffected too, not just the getter's return value: cycleHopLimit
		// of 1 should still suppress the second trigger on the same trace.
		expect(runtime.evaluate(makeTrigger("k1", "trace-x", "drop"))).toEqual({ type: "accept" });
		expect(runtime.evaluate(makeTrigger("k2", "trace-x", "drop"))).toEqual({
			type: "cycleSuppressed",
			hopCount: 1,
		});
	});

	it("keeps cycle entries for unrelated traces independent", () => {
		const runtime = new TriggerRuntime({ dedupWindowMs: 300_000, cycleHopLimit: 2 });
		runtime.evaluate(makeTrigger("k-a-1", "trace-a", "drop"));
		runtime.evaluate(makeTrigger("k-a-2", "trace-a", "drop"));
		expect(runtime.evaluate(makeTrigger("k-a-3", "trace-a", "drop")).type).toBe("cycleSuppressed");
		expect(runtime.evaluate(makeTrigger("k-b-1", "trace-b", "drop"))).toEqual({ type: "accept" });
	});

	it("tracks lifetime counters per outcome in snapshot()", () => {
		const runtime = new TriggerRuntime({ dedupWindowMs: 300_000, cycleHopLimit: 2 });
		runtime.evaluate(makeTrigger("k1", "ta", "drop"));
		runtime.evaluate(makeTrigger("k2", "tb", "drop"));
		runtime.evaluate(makeTrigger("k1", "tc", "drop")); // deduped
		runtime.evaluate(makeTrigger("k3", "ta", "drop")); // accept, ta hop=2
		runtime.evaluate(makeTrigger("k4", "ta", "drop")); // cycle-suppressed

		const snap = runtime.snapshot();
		expect(snap.acceptedTotal).toBe(3);
		expect(snap.dedupedTotal).toBe(1);
		expect(snap.cycleSuppressedTotal).toBe(1);
		expect(snap.dedupEntries).toBeGreaterThanOrEqual(1);
		expect(snap.activeTraces).toBeGreaterThanOrEqual(1);
	});
});

describe("PORT-DIVERGENCE B9 — LatestReplaces actually replaces the dedup entry (latest-wins)", () => {
	// Phase 18 fix. Oracle (trigger_runtime.rs:387-394 + evaluate()'s dedup branch,
	// trigger_runtime.rs:200-207) writes the dedup map exactly once per key, at first admission;
	// a duplicate declaring `latest_replaces` only ever READS the stored entry back. That makes
	// `LatestReplaces` a synonym for `Drop` — first-wins under a name promising latest-wins.
	it("walks previousTraceId forward across repeated LatestReplaces duplicates", () => {
		const runtime = new TriggerRuntime();
		expect(runtime.evaluate(makeTrigger("k1", "t1", "latest_replaces"))).toEqual({ type: "accept" });

		// Each Deduped outcome reports the trace being SUPERSEDED, then the stored entry moves on.
		const second = runtime.evaluate(makeTrigger("k1", "t2", "latest_replaces"));
		expect(second).toEqual({ type: "deduped", replacementPolicy: "latest_replaces", previousTraceId: "t1" });

		const third = runtime.evaluate(makeTrigger("k1", "t3", "latest_replaces"));
		expect(third, "B9 fixed: t2 replaced t1 in the map, so t3 supersedes t2 — not t1 as oracle reports").toEqual({
			type: "deduped",
			replacementPolicy: "latest_replaces",
			previousTraceId: "t2",
		});

		// Replacing must not leak entries: still one key, one entry.
		expect(runtime.dedupEntryCount()).toBe(1);
	});

	it("leaves Drop and Coalesce first-wins — only latest_replaces replaces", () => {
		for (const policy of ["drop", "coalesce"] as const) {
			const runtime = new TriggerRuntime();
			runtime.evaluate(makeTrigger("k1", "t1", policy));
			runtime.evaluate(makeTrigger("k1", "t2", policy));
			const third = runtime.evaluate(makeTrigger("k1", "t3", policy));
			expect(third, `${policy} must stay first-wins`).toEqual({
				type: "deduped",
				replacementPolicy: policy,
				previousTraceId: "t1",
			});
		}
	});

	it("keeps the FIRST arrival's policy governing the window (RFC 1 §5, unchanged from oracle)", () => {
		// oracle's `deduped_outcome_carries_first_arrivals_replacement_policy` (trigger_runtime.rs:
		// 380-398) — a later duplicate cannot change how the window collapses. A `drop` duplicate
		// arriving into a `latest_replaces` window is still governed by latest_replaces, so it
		// DOES replace; the reported policy stays the first arrival's either way.
		const runtime = new TriggerRuntime();
		runtime.evaluate(makeTrigger("k1", "t1", "latest_replaces"));
		expect(runtime.evaluate(makeTrigger("k1", "t2", "drop"))).toEqual({
			type: "deduped",
			replacementPolicy: "latest_replaces",
			previousTraceId: "t1",
		});
		expect(runtime.evaluate(makeTrigger("k1", "t3", "drop"))).toEqual({
			type: "deduped",
			replacementPolicy: "latest_replaces",
			previousTraceId: "t2",
		});

		// Mirror: a `latest_replaces` duplicate inside a `drop` window does NOT gain replace power.
		const dropWindow = new TriggerRuntime();
		dropWindow.evaluate(makeTrigger("k1", "t1", "drop"));
		dropWindow.evaluate(makeTrigger("k1", "t2", "latest_replaces"));
		expect(dropWindow.evaluate(makeTrigger("k1", "t3", "latest_replaces"))).toEqual({
			type: "deduped",
			replacementPolicy: "drop",
			previousTraceId: "t1",
		});
	});

	it("does not slide the dedup window — expiry stays anchored to the FIRST arrival", () => {
		// The replace must not refresh receivedAtMs, or an unbroken duplicate stream would hold a
		// key forever.
		const runtime = new TriggerRuntime();
		const windowMs = runtime.config.dedupWindowMs;
		const at = (offsetMs: number) => new Date(FIXED_NOW.getTime() + offsetMs);
		runtime.evaluate(makeTriggerAt("k1", "t1", "latest_replaces", at(0)));
		runtime.evaluate(makeTriggerAt("k1", "t2", "latest_replaces", at(windowMs - 1)));

		// Past the window measured from t1 (not from t2): the key must be gone.
		expect(
			runtime.evaluate(makeTriggerAt("k1", "t3", "latest_replaces", at(windowMs + 1))),
			"window must expire relative to the first arrival, not the last replacement",
		).toEqual({ type: "accept" });
	});
});

describe("Mutex mapping judgment (RULEBOOK §2.2, trigger_runtime.rs:80 parking_lot::Mutex)", () => {
	it("evaluate() and recordFollowUpHop() are synchronous end-to-end (no await crosses the critical section)", () => {
		const runtime = new TriggerRuntime();
		// If either method were async / returned a Promise, this would need `await` and the
		// `instanceof Promise` check below would fail — pinning the §2.2 judgment call that
		// justifies holding state as plain private fields instead of behind AsyncMutex.
		const evaluateResult = runtime.evaluate(makeTrigger("k1", "t1", "drop"));
		expect(evaluateResult).not.toBeInstanceOf(Promise);
		const hopResult = runtime.recordFollowUpHop("t1", FIXED_NOW);
		expect(hopResult).not.toBeInstanceOf(Promise);
	});

	it("many synchronous evaluate() calls never interleave — no dedup corruption under a burst", () => {
		// Node's single-threaded event loop makes this trivially true for synchronous methods,
		// but the test pins the observable consequence: N distinct keys on one trace all
		// Accept, and re-evaluating any of them immediately Dedupes — no lost/corrupted state
		// from "concurrent" (interleaved) synchronous calls.
		const runtime = new TriggerRuntime();
		const trace = "trace-burst";
		const keys = Array.from({ length: 50 }, (_, i) => `k${i}`);
		for (const key of keys) {
			// cycleHopLimit default is 5, so use a fresh trace per key to isolate dedup behavior.
			expect(runtime.evaluate(makeTrigger(key, `${trace}-${key}`, "drop"))).toEqual({ type: "accept" });
		}
		for (const key of keys) {
			expect(runtime.evaluate(makeTrigger(key, `${trace}-${key}-dup`, "drop")).type).toBe("deduped");
		}
		expect(runtime.dedupEntryCount()).toBe(keys.length);
	});
});

describe("process-local-only state (RULEBOOK §5 footer)", () => {
	it("a fresh TriggerRuntime instance has no memory of a previous instance's dedup/cycle state", () => {
		// Simulates a process restart: dedup/cycle bookkeeping is documented as reset-on-restart
		// (RULEBOOK §5: "dedup and cycle state live in the process only, and reset on restart") — there
		// is no persistence layer
		// for TriggerRuntime, so a brand-new instance is the faithful model of "after restart".
		const before = new TriggerRuntime();
		before.evaluate(makeTrigger("k1", "t1", "drop"));
		expect(before.dedupEntryCount()).toBe(1);
		expect(before.snapshot().acceptedTotal).toBe(1);

		const afterRestart = new TriggerRuntime();
		expect(afterRestart.dedupEntryCount()).toBe(0);
		expect(afterRestart.cycleEntryCount()).toBe(0);
		expect(afterRestart.snapshot()).toEqual({
			dedupEntries: 0,
			activeTraces: 0,
			acceptedTotal: 0,
			dedupedTotal: 0,
			cycleSuppressedTotal: 0,
		});
		// The same idempotency_key that was deduped-relevant before restart is admitted fresh.
		expect(afterRestart.evaluate(makeTrigger("k1", "t1", "drop"))).toEqual({ type: "accept" });
	});
});
