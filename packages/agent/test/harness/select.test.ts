import { describe, expect, it } from "vitest";
import { AsyncQueue } from "../../src/harness/async-queue.ts";
import { select2, selectBiased, selectN } from "../../src/harness/select.ts";

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			reject(new Error("aborted"));
		});
	});
}

describe("selectN", () => {
	it("resolves with the index and value of the first branch to settle", async () => {
		const result = await selectN([
			{ run: (signal: AbortSignal) => sleep(20, signal).then(() => "slow") },
			{ run: () => Promise.resolve("fast") },
		]);

		expect(result).toEqual({ index: 1, value: "fast" });
	});

	it("aborts every losing branch's signal once a winner settles", async () => {
		let loserAborted = false;
		await selectN([
			{
				run: (signal: AbortSignal) => {
					signal.addEventListener("abort", () => {
						loserAborted = true;
					});
					return sleep(50, signal).catch(() => "loser");
				},
			},
			{ run: () => Promise.resolve("winner") },
		]);

		// Give the abort listener's synchronous callback a tick to run.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(loserAborted).toBe(true);
	});

	it("does not abort the winning branch's own signal", async () => {
		let winnerAborted = false;
		await selectN([
			{
				run: (signal: AbortSignal) => {
					signal.addEventListener("abort", () => {
						winnerAborted = true;
					});
					return Promise.resolve("winner");
				},
			},
			{ run: (signal: AbortSignal) => sleep(50, signal).then(() => "loser") },
		]);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(winnerAborted).toBe(false);
	});

	it("throws when called with zero cases", async () => {
		await expect(selectN([])).rejects.toThrow(/at least one case/);
	});

	it("resolves deterministically in declaration order for already-settled branches (no select! random fairness)", async () => {
		// Both branches resolve on the same microtask tick — Promise.race is documented to
		// prefer the earliest-declared already-settled promise, which this pins as a
		// characterization test per RULEBOOK §2.2 ("order-sensitive behavior must be pinned by a
		// characterization test").
		const result = await selectN([{ run: () => Promise.resolve("first") }, { run: () => Promise.resolve("second") }]);
		expect(result).toEqual({ index: 0, value: "first" });
	});

	it("aborts every losing branch's signal even when the winning branch rejects (CRITICAL regression guard)", async () => {
		// An earlier implementation awaited `Promise.race(branches)` with no try/finally: when the
		// winning branch REJECTED, the abort loop below it was skipped entirely and every losing
		// branch's AbortController was never aborted. The prior "aborts every losing branch's
		// signal" test above doesn't catch this — its loser swallows its own abort-triggered
		// rejection internally via `.catch(() => "loser")`, so selectN's own `Promise.race` never
		// actually rejects in that test. This test makes the winner itself reject.
		let loserAborted = false;
		const error = new Error("boom");
		const promise = selectN([
			{ run: () => Promise.reject(error) },
			{
				run: (signal: AbortSignal) => {
					signal.addEventListener("abort", () => {
						loserAborted = true;
					});
					return sleep(50, signal).catch(() => "loser");
				},
			},
		]);

		await expect(promise).rejects.toBe(error);
		// Give the abort listener's synchronous callback a tick to run.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(loserAborted).toBe(true);
	});

	it("select over a losing AsyncQueue.next() releases the waiter (no stolen value for the next caller)", async () => {
		const queue = new AsyncQueue<number>();
		const result = await selectN<number | undefined>([
			{ run: (signal: AbortSignal) => queue.next(signal) },
			{ run: () => Promise.resolve(-1) },
		]);
		expect(result).toEqual({ index: 1, value: -1 });

		// If the losing next() call's waiter had leaked, this push would resolve *that* stale
		// waiter instead of a fresh next() call — the value would be lost to whatever discarded
		// the losing branch's promise.
		queue.push(42);
		await expect(queue.next()).resolves.toBe(42);
	});
});

describe("selectBiased", () => {
	it("resolves deterministically in declaration order for already-settled branches (both ready)", async () => {
		const result = await selectBiased([
			{ run: () => Promise.resolve("first") },
			{ run: () => Promise.resolve("second") },
		]);
		expect(result).toEqual({ index: 0, value: "first" });
	});

	it("prefers the earlier-declared branch over a later-declared one that settles first chronologically, when both are ready within the same tick (unlike plain selectN/Promise.race)", async () => {
		// Sets up the exact tie raceCancellable (packages/mcp/src/internal/async-utils.ts:154-190)
		// documents: `rival` (declared second) is resolved BEFORE `primary` (declared first) in
		// the same synchronous turn, so rival's `.then` callback is queued into the microtask
		// queue ahead of primary's. Plain `Promise.race` (what `selectN` uses) would therefore
		// settle on `rival` first — proven below. `selectBiased` defers each commit by one
		// microtask tick, giving primary's already-queued `.then` a chance to run first, and wins
		// the scan because it is declared first.
		let resolvePrimary!: (value: string) => void;
		const primary = new Promise<string>((resolve) => {
			resolvePrimary = resolve;
		});
		let resolveRival!: (value: string) => void;
		const rival = new Promise<string>((resolve) => {
			resolveRival = resolve;
		});

		const biasedPromise = selectBiased([{ run: () => primary }, { run: () => rival }]);
		resolveRival("rival");
		resolvePrimary("primary");
		const biasedResult = await biasedPromise;
		expect(biasedResult).toEqual({ index: 0, value: "primary" });
	});

	it("plain selectN (Promise.race) picks the chronologically-first branch in the same setup, demonstrating the divergence selectBiased exists to fix", async () => {
		let resolvePrimary!: (value: string) => void;
		const primary = new Promise<string>((resolve) => {
			resolvePrimary = resolve;
		});
		let resolveRival!: (value: string) => void;
		const rival = new Promise<string>((resolve) => {
			resolveRival = resolve;
		});

		const racedPromise = selectN([{ run: () => primary }, { run: () => rival }]);
		resolveRival("rival");
		resolvePrimary("primary");
		const racedResult = await racedPromise;
		expect(racedResult).toEqual({ index: 1, value: "rival" });
	});

	it("aborts every losing branch even when the winning branch rejects", async () => {
		let loserAborted = false;
		const error = new Error("boom");
		const promise = selectBiased([
			{ run: () => Promise.reject(error) },
			{
				run: (signal: AbortSignal) => {
					signal.addEventListener("abort", () => {
						loserAborted = true;
					});
					return sleep(50, signal).catch(() => "loser");
				},
			},
		]);

		await expect(promise).rejects.toBe(error);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(loserAborted).toBe(true);
	});

	it("throws when called with zero cases", async () => {
		await expect(selectBiased([])).rejects.toThrow(/at least one case/);
	});
});

describe("select2", () => {
	it("races exactly two branches and reports the winning index", async () => {
		const result = await select2(
			{ run: (signal: AbortSignal) => sleep(20, signal).then(() => "a") },
			{ run: () => Promise.resolve("b") },
		);
		expect(result).toEqual({ index: 1, value: "b" });
	});
});
