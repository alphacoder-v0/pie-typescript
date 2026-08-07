/**
 * Direct unit coverage for `packages/mcp/src/internal/async-utils.ts` primitives touched by the
 * phase-6 fixer pass:
 *  - finding #4: `raceCancellable` must be biased towards an already-ready response, even when a
 *    cancel signal fires in the same synchronous tick (oracle: `select! { biased; ... }`,
 *    client.rs:294-309).
 *  - finding #9: `createChannel`'s `recv()` must fail loudly on a second concurrent call rather
 *    than silently orphaning the first caller ("last-wins").
 *
 * Not a port of any single oracle test — implementer-added regression coverage per the fixer
 * task, in the same spirit as `wire-shapes.test.ts`'s RULEBOOK §4 self-declared "not a port"
 * fixtures.
 */
import { describe, expect, it, vi } from "vitest";
import { McpError } from "../src/errors.ts";
import { createChannel, raceCancellable } from "../src/internal/async-utils.ts";

describe("raceCancellable tie-break (finding #4)", () => {
	it("prefers an already-settled response over a same-tick abort (biased select parity)", async () => {
		const controller = new AbortController();
		let resolveFn!: (value: string) => void;
		const promise = new Promise<string>((resolve) => {
			resolveFn = resolve;
		});
		const onCancel = vi.fn(async () => {});

		const racePromise = raceCancellable(promise, controller.signal, onCancel);

		// Resolve the underlying promise, then abort, in the same synchronous tick. Without the
		// fix, `abort()`'s synchronous handler would win the race and reject as cancelled even
		// though the response had already arrived — inverting oracle's `biased` select, which
		// always re-checks the response branch first.
		resolveFn("response-won");
		controller.abort();

		await expect(racePromise).resolves.toBe("response-won");
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("prefers an already-settled rejection over a same-tick abort", async () => {
		const controller = new AbortController();
		let rejectFn!: (error: unknown) => void;
		const promise = new Promise<string>((_resolve, reject) => {
			rejectFn = reject;
		});
		const onCancel = vi.fn(async () => {});

		const racePromise = raceCancellable(promise, controller.signal, onCancel);
		const boom = new Error("boom");
		rejectFn(boom);
		controller.abort();

		await expect(racePromise).rejects.toBe(boom);
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("still cancels when the signal aborts and the promise never settles (non-tie control case)", async () => {
		const controller = new AbortController();
		const promise = new Promise<string>(() => {
			// never settles
		});
		const onCancel = vi.fn(async () => {});

		const racePromise = raceCancellable(promise, controller.signal, onCancel);
		controller.abort();

		await expect(racePromise).rejects.toBeInstanceOf(McpError);
		await expect(racePromise).rejects.toMatchObject({ code: "cancelled" });
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("still cancels when the signal is already aborted before the call (pre-existing abort)", async () => {
		const controller = new AbortController();
		controller.abort();
		const promise = new Promise<string>(() => {
			// never settles
		});
		const onCancel = vi.fn(async () => {});

		await expect(raceCancellable(promise, controller.signal, onCancel)).rejects.toMatchObject({ code: "cancelled" });
		expect(onCancel).toHaveBeenCalledTimes(1);
	});
});

describe("createChannel single-consumer invariant (finding #9)", () => {
	it("throws synchronously when recv() is called while a previous recv() is still pending", () => {
		const { receiver } = createChannel<string>();
		const first = receiver.recv();

		expect(() => receiver.recv()).toThrow(/single-consumer/);

		// The first recv() is left pending (never sent to) — nothing further to assert; avoid an
		// unhandled-rejection-style dangling promise by not awaiting it.
		void first;
	});

	it("allows a fresh recv() once the previous one has settled", async () => {
		const { sender, receiver } = createChannel<string>();
		const first = receiver.recv();
		sender.send("a");
		await expect(first).resolves.toBe("a");

		sender.send("b");
		await expect(receiver.recv()).resolves.toBe("b");
	});
});
