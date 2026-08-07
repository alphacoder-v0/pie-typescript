/**
 * Package-local async plumbing: the TS equivalent of what pie's Rust side gets for free from
 * `tokio::sync::mpsc`, `tokio::time::timeout`, and `tokio_util::sync::CancellationToken`.
 *
 * Not a 1:1 port of any single oracle file/struct — `crates/mcp/src/{client,http,stdio}.rs`
 * each call straight into tokio/stdlib primitives (RULEBOOK §2.2 inventory rows: mpsc channel ->
 * AsyncQueue, oneshot -> `Promise.withResolvers`, select! -> selectN+abort). RULEBOOK §4 mandates
 * a *single* shared implementation of those primitives at `packages/agent/src/harness/` for the
 * rest of the monorepo — but `packages/mcp` is a leaf package that must not depend on
 * `@pie/agent-core` (RULEBOOK §4 dependency graph; oracle's own crate doc, lib.rs:8-10, states
 * the same architectural constraint for the Rust crate). This file is the package-local
 * equivalent, kept intentionally tiny and generic (no MCP-specific shapes) so it reads as "the
 * stdlib pie gets natively" rather than business logic. Flagged for the orchestrator as a
 * RULEBOOK §2.2/§4 tension — RULEBOOK §6 Deviation log 2026-08-03 (leaf-package exception), analogous to the
 * 2026-08-03 retry.ts deviation.
 */
import { McpError } from "../errors.ts";

/** Minimal unbounded async channel — the send/receive halves of `mpsc::(unbounded_)channel`. */
export interface AsyncChannelSender<T> {
	send(value: T): void;
	close(): void;
}

export interface AsyncChannelReceiver<T> {
	/** Resolves to the next value, or `undefined` once the channel is closed and drained. */
	recv(): Promise<T | undefined>;
}

/**
 * `Promise.withResolvers<T>()` equivalent (RULEBOOK §2.2: `oneshot` -> `Promise.withResolvers`),
 * hand-written rather than using the native API: the native API requires TS lib "es2024", and
 * bumping `tsconfig.base.json`'s shared `lib` would affect every package in the monorepo, out of
 * scope for this unit. Node 22 (this monorepo's minimum) has `Promise.withResolvers` at runtime
 * regardless — this is purely a typings-availability workaround. Single-resolver only (no
 * `reject`): the one caller (client.ts) never rejects the settlement promise, matching the
 * oracle's `oneshot::Sender::send` which only ever sends a `Result` *value*, never drops without
 * sending in the paths this crate exercises.
 */
export function createResolvablePromise<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolveFn!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolveFn = res;
	});
	return { promise, resolve: resolveFn };
}

export function createChannel<T>(): { sender: AsyncChannelSender<T>; receiver: AsyncChannelReceiver<T> } {
	const buffer: T[] = [];
	let waiter: ((value: T | undefined) => void) | undefined;
	let closed = false;

	const sender: AsyncChannelSender<T> = {
		send(value) {
			if (closed) return;
			if (waiter) {
				const resolve = waiter;
				waiter = undefined;
				resolve(value);
				return;
			}
			buffer.push(value);
		},
		close() {
			if (closed) return;
			closed = true;
			if (waiter) {
				const resolve = waiter;
				waiter = undefined;
				resolve(undefined);
			}
		},
	};

	const receiver: AsyncChannelReceiver<T> = {
		recv() {
			if (waiter) {
				// pie: `rx: AsyncMutex<mpsc::Receiver<...>>` (http.rs:109, client.rs-equivalent) — oracle
				// serializes concurrent `recv()` callers behind a lock, so a second caller queues rather
				// than racing. This channel has no such lock; silently letting a second concurrent
				// `recv()` overwrite `waiter` would orphan the first caller's promise forever
				// ("last-wins", never observed). Every consumer in this codebase is single-consumer by
				// construction (one read pump per channel) — fail loudly instead of masking the bug.
				throw new Error(
					"createChannel: recv() called while a previous recv() is still pending (single-consumer channel)",
				);
			}
			if (buffer.length > 0) return Promise.resolve(buffer.shift() as T);
			if (closed) return Promise.resolve(undefined);
			return new Promise((resolve) => {
				waiter = resolve;
			});
		},
	};

	return { sender, receiver };
}

/**
 * Races `promise` against a deadline. On timeout, rejects with `buildTimeoutError()` — pie:
 * `tokio::time::timeout(dur, fut).await` mapping (RULEBOOK §2.2 selectN+abort family).
 */
export function withDeadline<T>(promise: Promise<T>, ms: number, buildTimeoutError: () => McpError): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(buildTimeoutError()), ms);
	});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Sleeps `ms`, resolving early with `"aborted"` if `signal` fires first; otherwise resolves
 * `"elapsed"`. pie: `tokio::select! { _ = close_token.cancelled() => ..., _ = sleep(delay) => ... }`
 * (http.rs:278-281).
 */
export function sleepOrAbort(ms: number, signal: AbortSignal): Promise<"aborted" | "elapsed"> {
	if (signal.aborted) return Promise.resolve("aborted");
	return new Promise((resolve) => {
		const onAbort = () => {
			cleanup();
			resolve("aborted");
		};
		const timer = setTimeout(() => {
			cleanup();
			resolve("elapsed");
		}, ms);
		const cleanup = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
		};
		signal.addEventListener("abort", onAbort);
	});
}

/**
 * Races `promise` against `signal` firing, biased towards `promise` (mirrors Rust's
 * `select! { biased; r = wait => r, _ = token.cancelled() => ... }`, client.rs:294-309): if
 * `promise` settles first, `onCancel` is never invoked. If `signal` fires first, `onCancel` runs
 * and the returned promise rejects with `McpError.cancelled()`.
 *
 * Tie-break: a `biased` select re-polls *all* branches, in written order, every time it wakes —
 * so if `promise` has *also* become ready by the time the executor gets around to handling a
 * same-tick cancel, the response branch wins even though the cancel fired "first". Plain
 * `promise.then()`/`signal.addEventListener("abort", ...)` callbacks don't reproduce that: they
 * fire in whatever order the two operations happened to be triggered, so a cancel issued in the
 * same synchronous turn as (but immediately after) a response resolving would win the race here,
 * inverting the oracle's bias. Fixed by deferring the abort branch's commit to a microtask
 * checkpoint (`queueMicrotask`): `promise.then()` is always attached *before* this function checks
 * `signal.aborted`/registers the abort listener, so if `promise` had already settled by the time
 * abort fires, its `.then()` callback is already queued ahead of the deferred cancel-commit
 * microtask (microtasks run FIFO) and will flip `done` first — exactly the "check settlement
 * before committing to cancel" ordering `biased` gives Rust.
 */
export function raceCancellable<T>(
	promise: Promise<T>,
	signal: AbortSignal,
	onCancel: () => Promise<void>,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let done = false;
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		function onAbort() {
			queueMicrotask(() => {
				if (done) return;
				done = true;
				cleanup();
				void onCancel().finally(() => reject(McpError.cancelled()));
			});
		}
		promise.then(
			(value) => {
				if (done) return;
				done = true;
				cleanup();
				resolve(value);
			},
			(error) => {
				if (done) return;
				done = true;
				cleanup();
				reject(error);
			},
		);
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener("abort", onAbort);
	});
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Byte length of a UTF-8 string — Rust's `String::len()`/`&[u8].len()` are byte counts, JS `.length` is UTF-16 code units. */
export function utf8ByteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/** Strict UTF-8 decode — mirrors `String::from_utf8`, which errors on invalid sequences (`Buffer#toString` silently replaces them). */
export function decodeUtf8Strict(bytes: Uint8Array): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch (error) {
		throw McpError.protocol(`utf8: ${errorMessage(error)}`);
	}
}
