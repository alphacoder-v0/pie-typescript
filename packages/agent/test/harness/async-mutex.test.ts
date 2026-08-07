import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AsyncMutex } from "../../src/harness/async-mutex.ts";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("AsyncMutex", () => {
	it("serializes two overlapping runExclusive calls (second waits for the first to finish)", async () => {
		const mutex = new AsyncMutex();
		const order: string[] = [];

		const first = mutex.runExclusive(async () => {
			order.push("first-start");
			await sleep(20);
			order.push("first-end");
		});
		const second = mutex.runExclusive(async () => {
			order.push("second-start");
			await sleep(1);
			order.push("second-end");
		});

		await Promise.all([first, second]);

		expect(order).toEqual(["first-start", "first-end", "second-start", "second-end"]);
	});

	it("returns the value produced by fn", async () => {
		const mutex = new AsyncMutex();
		const result = await mutex.runExclusive(async () => 42);
		expect(result).toBe(42);
	});

	it("supports a synchronous fn (no await required inside the critical section)", async () => {
		const mutex = new AsyncMutex();
		const result = await mutex.runExclusive(() => "sync-value");
		expect(result).toBe("sync-value");
	});

	it("releases the lock for the next queued caller even when fn rejects", async () => {
		const mutex = new AsyncMutex();
		const order: string[] = [];

		const failing = mutex
			.runExclusive(async () => {
				order.push("failing-start");
				await sleep(10);
				throw new Error("boom");
			})
			.catch((error: unknown) => {
				order.push("failing-caught");
				return error;
			});

		const next = mutex.runExclusive(async () => {
			order.push("next-start");
		});

		await Promise.all([failing, next]);

		// The lock releases in the `finally` block, inside the mutex's own machinery — before
		// the rejection propagates out to whatever `.then`/`.catch` chain the *caller* happens
		// to have attached to the returned promise. So "next-start" is not guaranteed to occur
		// after "failing-caught" (that ordering is an artifact of how many external handlers
		// are chained, not a mutex contract); what the contract actually guarantees is that
		// both `next-start` and `failing-caught` happen only after `failing-start`, and that
		// `next` is never permanently blocked by a rejecting predecessor.
		expect(order[0]).toBe("failing-start");
		expect(order).toContain("next-start");
		expect(order).toContain("failing-caught");
		expect(order).toHaveLength(3);
	});

	it("three queued callers run strictly in submission order", async () => {
		const mutex = new AsyncMutex();
		const order: number[] = [];
		const results = await Promise.all([
			mutex.runExclusive(async () => {
				order.push(1);
				await sleep(15);
				return 1;
			}),
			mutex.runExclusive(async () => {
				order.push(2);
				await sleep(5);
				return 2;
			}),
			mutex.runExclusive(async () => {
				order.push(3);
				return 3;
			}),
		]);

		expect(order).toEqual([1, 2, 3]);
		expect(results).toEqual([1, 2, 3]);
	});

	describe("reentrant call deadlocks (characterization of a known tokio::Mutex trap, not a regression — see the WARNING in async-mutex.ts)", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("a runExclusive call made from inside another runExclusive call on the SAME mutex never settles", async () => {
			const mutex = new AsyncMutex();
			let innerSettled = false;
			let outerSettled = false;

			const outer = mutex.runExclusive(async () => {
				// Reentrant: this inner call's `await previous` waits on `this.tail`, which the
				// OUTER call itself currently owns — the outer call can't return (and release the
				// lock) until this inner call resolves. Circular wait.
				const inner = mutex.runExclusive(async () => "inner");
				inner.then(
					() => {
						innerSettled = true;
					},
					() => {
						innerSettled = true;
					},
				);
				await inner;
				return "outer";
			});
			outer.then(
				() => {
					outerSettled = true;
				},
				() => {
					outerSettled = true;
				},
			);

			// Neither callback does any real async work, so a non-deadlocked mutex would settle
			// within a handful of microtask flushes. Advance a large amount of *simulated* time
			// (no real waiting — nothing here uses a real timer) and flush microtasks repeatedly;
			// if the promises are still unsettled afterwards, that's the deadlock, proven without
			// ever letting the test itself hang.
			for (let i = 0; i < 50; i++) {
				await vi.advanceTimersByTimeAsync(1000);
			}

			expect(innerSettled).toBe(false);
			expect(outerSettled).toBe(false);
		});
	});
});
