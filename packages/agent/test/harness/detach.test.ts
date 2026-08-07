import { describe, expect, it, vi } from "vitest";
import { detach } from "../../src/harness/detach.ts";

describe("detach", () => {
	it("returns synchronously without waiting for fn to settle (no inline await)", () => {
		let resolveFn: (() => void) | undefined;
		const fn = () =>
			new Promise<void>((resolve) => {
				resolveFn = resolve;
			});
		const onError = vi.fn();

		const returned = detach(fn, onError);

		expect(returned).toBeUndefined();
		expect(resolveFn).toBeDefined();
		resolveFn?.();
	});

	it("routes a rejection to onError instead of producing an unhandled rejection", async () => {
		const error = new Error("boom");
		const onError = vi.fn();

		detach(() => Promise.reject(error), onError);
		// Let the microtask queue drain so the .catch() handler runs.
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(onError).toHaveBeenCalledExactlyOnceWith(error);
	});

	it("does not call onError when fn resolves", async () => {
		const onError = vi.fn();

		detach(() => Promise.resolve(), onError);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(onError).not.toHaveBeenCalled();
	});

	it("runs two detached operations concurrently, not serially", async () => {
		const order: string[] = [];
		const onError = vi.fn();

		detach(async () => {
			order.push("a-start");
			await new Promise((resolve) => setTimeout(resolve, 10));
			order.push("a-end");
		}, onError);
		detach(async () => {
			order.push("b-start");
			await new Promise((resolve) => setTimeout(resolve, 0));
			order.push("b-end");
		}, onError);

		await new Promise((resolve) => setTimeout(resolve, 20));

		// Both started before either finished — proof the two detached calls interleave rather
		// than the second waiting for the first (which an inline `await detach(...)` would force).
		expect(order.indexOf("a-start")).toBeLessThan(order.indexOf("b-end"));
		expect(order.indexOf("b-start")).toBeLessThan(order.indexOf("a-end"));
	});

	it("routes a synchronous throw from a non-async fn to onError instead of throwing at the detach() call site", async () => {
		const error = new Error("sync boom");
		const onError = vi.fn();
		// Typed as `() => Promise<void>` per the signature, but throws synchronously at runtime
		// (never returns a promise at all) — the exact escape hatch this test guards against.
		const fn = (): Promise<void> => {
			throw error;
		};

		expect(() => detach(fn, onError)).not.toThrow();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(onError).toHaveBeenCalledExactlyOnceWith(error);
	});

	it("does not produce an unhandled rejection when onError is itself async and rejects", async () => {
		const primaryError = new Error("primary boom");
		const onErrorFailure = new Error("onError itself failed");
		const onError = vi.fn(async () => {
			throw onErrorFailure;
		});

		let unhandledReason: unknown;
		const onUnhandledRejection = (reason: unknown) => {
			unhandledReason = reason;
		};
		process.on("unhandledRejection", onUnhandledRejection);
		try {
			detach(() => Promise.reject(primaryError), onError);
			// Give both the primary rejection and onError's own rejection a chance to surface as
			// an unhandled rejection, if the fix didn't work.
			await new Promise((resolve) => setTimeout(resolve, 20));
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
		}

		expect(onError).toHaveBeenCalledExactlyOnceWith(primaryError);
		expect(unhandledReason).toBeUndefined();
	});
});
