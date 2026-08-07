import { describe, expect, it } from "vitest";
import { AsyncQueue, Signal } from "../../src/harness/async-queue.ts";

describe("AsyncQueue", () => {
	it("resolves next() immediately when a value was already pushed", async () => {
		const queue = new AsyncQueue<number>();
		queue.push(1);
		await expect(queue.next()).resolves.toBe(1);
	});

	it("resolves a pending next() once a value is pushed", async () => {
		const queue = new AsyncQueue<string>();
		const pending = queue.next();
		queue.push("hello");
		await expect(pending).resolves.toBe("hello");
	});

	it("delivers values in FIFO order", async () => {
		const queue = new AsyncQueue<number>();
		queue.push(1);
		queue.push(2);
		queue.push(3);
		await expect(queue.next()).resolves.toBe(1);
		await expect(queue.next()).resolves.toBe(2);
		await expect(queue.next()).resolves.toBe(3);
	});

	it("push returns true when accepted, false once closed (mirrors Result<(), SendError>)", () => {
		const queue = new AsyncQueue<number>();
		expect(queue.push(1)).toBe(true);
		queue.close();
		expect(queue.push(2)).toBe(false);
		expect(queue.size).toBe(1);
	});

	it("drains buffered values before reporting closed (matches a dropped mpsc::Sender)", async () => {
		const queue = new AsyncQueue<number>();
		queue.push(1);
		queue.push(2);
		queue.close();
		await expect(queue.next()).resolves.toBe(1);
		await expect(queue.next()).resolves.toBe(2);
		await expect(queue.next()).resolves.toBeUndefined();
		await expect(queue.next()).resolves.toBeUndefined();
	});

	it("resolves a pending next() with undefined when closed with nothing buffered", async () => {
		const queue = new AsyncQueue<number>();
		const pending = queue.next();
		queue.close();
		await expect(pending).resolves.toBeUndefined();
	});

	it("resolves multiple concurrent next() callers FIFO as values arrive (no last-wins clobbering)", async () => {
		const queue = new AsyncQueue<number>();
		const first = queue.next();
		const second = queue.next();
		queue.push(10);
		queue.push(20);
		await expect(first).resolves.toBe(10);
		await expect(second).resolves.toBe(20);
	});

	it("push is unbounded — never rejects/blocks regardless of backlog size", () => {
		const queue = new AsyncQueue<number>();
		for (let i = 0; i < 10_000; i++) {
			expect(queue.push(i)).toBe(true);
		}
		expect(queue.size).toBe(10_000);
	});

	it("next(signal) resolves immediately from the buffer even if the signal is already aborted (not waiting, so nothing to cancel)", async () => {
		const queue = new AsyncQueue<number>();
		queue.push(7);
		const controller = new AbortController();
		controller.abort();
		await expect(queue.next(controller.signal)).resolves.toBe(7);
	});

	it("next(signal) rejects immediately if the signal is already aborted and there is nothing buffered", async () => {
		const queue = new AsyncQueue<number>();
		const controller = new AbortController();
		controller.abort();
		await expect(queue.next(controller.signal)).rejects.toBe(controller.signal.reason);
	});

	it("next(signal) removes its own waiter and rejects when aborted while waiting — the waiter must not linger and steal a later push", async () => {
		const queue = new AsyncQueue<number>();
		const controller = new AbortController();
		const pending = queue.next(controller.signal);
		// `.reason` is only populated once `abort()` runs, so it must be read after — reading it
		// beforehand (to build the assertion) would capture `undefined` instead of the real reason.
		controller.abort();
		await expect(pending).rejects.toBe(controller.signal.reason);

		// If the aborted call's waiter were still registered, this push would resolve *that*
		// stale (already-rejected) promise instead of a fresh next() call.
		queue.push(99);
		await expect(queue.next()).resolves.toBe(99);
	});

	it("next(signal) that is never aborted resolves normally, same as next() with no signal", async () => {
		const queue = new AsyncQueue<number>();
		const controller = new AbortController();
		const pending = queue.next(controller.signal);
		queue.push(5);
		await expect(pending).resolves.toBe(5);
	});
});

describe("Signal", () => {
	it("notifyOne wakes exactly one pending waiter", async () => {
		const signal = new Signal();
		const order: string[] = [];
		const a = signal.wait().then(() => order.push("a"));
		const b = signal.wait().then(() => order.push("b"));
		signal.notifyOne();
		await Promise.race([a, new Promise((resolve) => setTimeout(resolve, 10))]);
		expect(order).toEqual(["a"]);
		signal.notifyOne();
		await b;
		expect(order).toEqual(["a", "b"]);
	});

	it("notifyOne stores a permit when nobody is waiting, consumed by the next wait()", async () => {
		const signal = new Signal();
		signal.notifyOne();
		// wait() must resolve immediately (permit already stored) rather than hang.
		await expect(
			Promise.race([signal.wait(), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 20))]),
		).resolves.toBeUndefined();
	});

	it("notifyAll wakes every currently-registered waiter and stores no permit", async () => {
		const signal = new Signal();
		const order: string[] = [];
		const a = signal.wait().then(() => order.push("a"));
		const b = signal.wait().then(() => order.push("b"));
		signal.notifyAll();
		await Promise.all([a, b]);
		expect(order.sort()).toEqual(["a", "b"]);

		// No permit stored: a fresh wait() must NOT resolve immediately.
		let resolved = false;
		signal.wait().then(() => {
			resolved = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(resolved).toBe(false);
	});

	it("wait(signal) removes its own waiter and rejects when aborted while waiting — the waiter must not linger and steal a later notifyOne", async () => {
		const signal = new Signal();
		const controller = new AbortController();
		const pending = signal.wait(controller.signal);
		// `.reason` is only populated once `abort()` runs, so it must be read after.
		controller.abort();
		await expect(pending).rejects.toBe(controller.signal.reason);

		// If the aborted call's waiter were still registered, this notifyOne would wake *that*
		// stale (already-rejected) promise and be lost instead of waking a fresh wait() call.
		let resolved = false;
		signal.wait().then(() => {
			resolved = true;
		});
		signal.notifyOne();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(resolved).toBe(true);
	});

	it("wait(signal) rejects immediately if the signal is already aborted and no permit is stored", async () => {
		const signal = new Signal();
		const controller = new AbortController();
		controller.abort();
		await expect(signal.wait(controller.signal)).rejects.toBe(controller.signal.reason);
	});

	it("wait(signal) resolves immediately from a stored permit even if the signal is already aborted (not waiting, so nothing to cancel)", async () => {
		const signal = new Signal();
		signal.notifyOne();
		const controller = new AbortController();
		controller.abort();
		await expect(signal.wait(controller.signal)).resolves.toBeUndefined();
	});
});
