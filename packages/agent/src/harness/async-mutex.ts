/**
 * Canonical mapping for `Mutex<T>` (RULEBOOK §2.2, 92 oracle sites) in the ONE case it applies:
 * critical sections that cross an `.await`. §2.2's judgment is mechanical and per-site: if a
 * `Mutex<T>`/`parking_lot::Mutex<T>` guard's critical section never awaits, Node's single-threaded
 * event loop already makes it atomic — use direct field access instead (see e.g.
 * `trigger_runtime.rs:80`, ported this phase as `TriggerRuntime`, which holds its state directly
 * for exactly this reason; the inventory row for that site is tagged "await-in-critical-section
 * test" — n/a because it does NOT cross await).
 *
 * §4 requires exactly one implementation of this shape under `packages/agent/src/harness/`; other
 * packages import this file rather than hand-rolling a promise-chain lock inline.
 */

/**
 * Serializes access to an async critical section. `runExclusive` queues behind any in-flight
 * call, runs `fn`, then releases — the promise-chaining equivalent of `Mutex::lock().await`
 * around a body that itself awaits. A rejection from `fn` still releases the lock for the next
 * queued caller (mirrors a Rust `MutexGuard` dropping on unwind).
 *
 * WARNING — NOT REENTRANT, deliberately, mirroring `tokio::Mutex` (not a re-entrant lock type):
 * if a call chain that is already running inside `runExclusive`'s critical section calls
 * `runExclusive` AGAIN on the SAME `AsyncMutex` instance, it deadlocks — silently and permanently,
 * with no error and no timeout. Why: the inner call captures `this.tail` (the outer call's own
 * release promise) as `previous` and awaits it; but `this.tail` only resolves once the OUTER
 * call's `fn` returns, which itself is now blocked awaiting the inner call. Circular wait, zero
 * progress, forever. This is intentional behavioral fidelity to the oracle (`tokio::Mutex` has the
 * identical non-reentrant trap) — do not "fix" this with a reentrancy guard or a recursive-lock
 * counter, that would diverge from `Mutex<T>` semantics (RULEBOOK §2.2). Callers MUST ensure a
 * call chain never re-enters `runExclusive` on a mutex it already holds. See
 * `async-mutex.test.ts`'s "reentrant call deadlocks" characterization test, which pins this exact
 * failure mode under a fake-timer bound so the test suite itself doesn't hang.
 */
export class AsyncMutex {
	private tail: Promise<void> = Promise.resolve();

	async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
		const previous = this.tail;
		let release!: () => void;
		this.tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await fn();
		} finally {
			release();
		}
	}
}
