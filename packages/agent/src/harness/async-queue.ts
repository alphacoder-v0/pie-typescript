/**
 * Canonical mapping for `mpsc::(unbounded_)channel` (RULEBOOK §2.2, 72 oracle sites) and
 * `tokio::sync::Notify` (RULEBOOK §2.2, 5 oracle sites — kept in this file per the rulebook's
 * "keep it in the async-queue file" instruction). §4 requires exactly one implementation of each shape under
 * `packages/agent/src/harness/`; other packages import this file rather than hand-rolling a queue.
 *
 * `agent/harness/notification_hook` (this phase) is the direct motivating site:
 * `notification_hook.rs:30` — `pub type TriggerSink = mpsc::UnboundedSender<Trigger>` — is the
 * push-only half of exactly this queue. `agent_harness.rs:1462` (a later phase-8 unit) destructures
 * `tokio::sync::mpsc::unbounded_channel()` into `(sink, rx)`; this queue plays both roles at once
 * (push side and consume side) since JS has no borrow checker forcing the split.
 */

/**
 * Unbounded FIFO queue — the TS shape of `mpsc::UnboundedSender`/`UnboundedReceiver` combined
 * into one object. `push` never blocks (unbounded, matching the oracle's default choice — bounded
 * back-pressure is explicitly a follow-up per `notification_hook.rs:27-29`) and `next` resolves
 * values in the order they were pushed.
 *
 * Unlike the oracle's `mpsc` (single-consumer, enforced by the borrow checker), this queue
 * supports multiple concurrent `next()` callers: each is queued as its own waiter and resolved
 * FIFO as values arrive, rather than the last caller silently clobbering an earlier one. Shared
 * canonical utilities can't assume every future call site is single-consumer.
 */
export class AsyncQueue<T> {
	private readonly buffer: T[] = [];
	private readonly waiters: Array<(value: T | undefined) => void> = [];
	private closed = false;

	/**
	 * Enqueue `value`. Returns `true` if accepted, `false` if the queue is already closed (the
	 * value is discarded) — mirrors `Sender::send`'s `Result<(), SendError<T>>` collapsed to a
	 * boolean, so a hook's `run()` loop can tell when to stop pushing instead of pushing into the
	 * void silently.
	 */
	push(value: T): boolean {
		if (this.closed) return false;
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter(value);
			return true;
		}
		this.buffer.push(value);
		return true;
	}

	/**
	 * Resolves with the next queued value, or `undefined` once closed and fully drained.
	 *
	 * `signal`, if given, cancels a call that has to *wait* (buffer empty, queue open): on abort,
	 * this call's waiter is removed from `waiters` and the returned promise rejects with
	 * `signal.reason`. This is what makes `AsyncQueue.next()` usable as a `selectN`/`selectBiased`
	 * branch (RULEBOOK §2.2: `select!` over `mpsc::Receiver::recv()` is exactly this shape) —
	 * without it, a losing branch's waiter would stay registered in `waiters` forever, silently
	 * "stealing" the next value pushed from whichever caller actually needed it (see
	 * `async-queue.test.ts`'s "select over queue.next() ... releases the losing waiter" test).
	 * A `signal` that is already aborted before the call, or one that never fires, behaves exactly
	 * as if `next()` had been called without a signal at all.
	 */
	next(signal?: AbortSignal): Promise<T | undefined> {
		if (this.buffer.length > 0) {
			return Promise.resolve(this.buffer.shift() as T);
		}
		if (this.closed) {
			return Promise.resolve(undefined);
		}
		if (signal?.aborted) {
			return Promise.reject(signal.reason);
		}
		return new Promise((resolve, reject) => {
			const waiter = (value: T | undefined): void => {
				signal?.removeEventListener("abort", onAbort);
				resolve(value);
			};
			const onAbort = (): void => {
				const index = this.waiters.indexOf(waiter);
				if (index !== -1) this.waiters.splice(index, 1);
				reject(signal?.reason);
			};
			this.waiters.push(waiter);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	/**
	 * Close the queue. Values already buffered remain available via `next()` (drain-before-close,
	 * matching a dropped `mpsc::Sender` — the receiver still drains its buffer before seeing the
	 * channel end); waiters with nothing left to receive resolve `undefined`.
	 */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		const pending = this.waiters.splice(0);
		for (const waiter of pending) waiter(undefined);
	}

	/** `true` once `close()` has been called. */
	get isClosed(): boolean {
		return this.closed;
	}

	/** Number of buffered-but-undelivered values. Observability / test helper. */
	get size(): number {
		return this.buffer.length;
	}
}

/**
 * Canonical mapping for `tokio::sync::Notify`. `notifyOne` wakes exactly one waiter, storing a
 * single permit for the next `wait()` call if nobody is currently waiting (mirrors
 * `Notify::notify_one`'s permit semantics); `notifyAll` wakes every waiter currently registered
 * and does not store a permit (mirrors `Notify::notify_waiters`).
 */
export class Signal {
	private readonly waiters: Array<() => void> = [];
	private permit = false;

	/** Wake one waiter, or store a permit for the next `wait()` if none are currently waiting. */
	notifyOne(): void {
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter();
			return;
		}
		this.permit = true;
	}

	/** Wake every currently-registered waiter. Does not store a permit for future callers. */
	notifyAll(): void {
		const pending = this.waiters.splice(0);
		for (const waiter of pending) waiter();
	}

	/**
	 * Resolves immediately if a stored permit exists (consuming it), else waits for the next
	 * notify.
	 *
	 * `signal`, if given, cancels a call that has to wait (no stored permit): on abort, this call's
	 * waiter is removed from `waiters` and the returned promise rejects with `signal.reason` —
	 * mirrors `AsyncQueue.next(signal)` above, for the same reason (usable as a losing `selectN`
	 * branch without leaking a waiter that would silently swallow a future `notifyOne`).
	 */
	wait(signal?: AbortSignal): Promise<void> {
		if (this.permit) {
			this.permit = false;
			return Promise.resolve();
		}
		if (signal?.aborted) {
			return Promise.reject(signal.reason);
		}
		return new Promise((resolve, reject) => {
			const waiter = (): void => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			};
			const onAbort = (): void => {
				const index = this.waiters.indexOf(waiter);
				if (index !== -1) this.waiters.splice(index, 1);
				reject(signal?.reason);
			};
			this.waiters.push(waiter);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}
}
