/**
 * Canonical mapping for detached `tokio::spawn` (RULEBOOK §2.2, 61 oracle sites across
 * `crates/agent`/`crates/coding-agent`). Node has no task scheduler to hand work to — a
 * "detached" async operation is just a promise nobody awaits — so the only thing this helper
 * buys over `void fn()` is a single, auditable place that routes the rejection somewhere instead
 * of letting it become an unhandled rejection.
 *
 * §4 requires exactly one implementation of this shape under `packages/agent/src/harness/`; every
 * other package imports this file rather than hand-rolling `void promise.catch(...)` inline.
 *
 * Call sites MUST NOT `await` the return value inline — `detach()` returns `void` specifically so
 * a caller cannot accidentally do so and turn concurrent work into serial work (the failure mode
 * RULEBOOK §2.2 calls out explicitly: "no inline await").
 */

/** Sink for a detached operation's failure. Mirrors the oracle's `reportDetachedError(ctx, err)` call. */
export type DetachedErrorHandler = (error: unknown) => void;

/**
 * Run `fn` without waiting for it. Any rejection — including a *synchronous* throw from a
 * non-async `fn` — is routed to `onError` — mandatory, not optional, so every call site makes an
 * explicit choice about where a detached failure goes (RULEBOOK §2.4: never silently swallow an
 * error).
 *
 * Two escape hatches an earlier `void fn().catch(onError)` implementation had, both closed here:
 *
 * 1. If `fn` throws synchronously (not async, no promise ever returned — a caller can violate the
 *    `() => Promise<void>` signature at runtime even though not at the type level), the exception
 *    came straight out of the `fn()` call expression, before `.catch()` ever got attached — it
 *    would propagate synchronously out of `detach()`'s own call site instead of reaching `onError`.
 *    Calling `fn()` inside `runDetached`'s `try` (itself only ever invoked via `void`, never
 *    awaited inline) catches this the same way it catches an async rejection: a synchronous throw
 *    inside an async function's `try` block behaves like an ordinary `try`/`catch` — execution
 *    hasn't reached an `await` yet, so there's no promise machinery involved for the throw itself.
 * 2. If `onError` is itself `async` and its returned promise rejects, `fn().catch(onError)`
 *    produces a *new* promise (the `.catch()` chain) that `void` discards without attaching a
 *    further handler — an unhandled rejection. `runDetached` awaits `onError`'s result inside its
 *    own `try`/`catch` so a second-order failure is swallowed instead of escaping — there is no
 *    further sink to report a failure of the error handler itself to.
 */
export function detach(fn: () => Promise<void>, onError: DetachedErrorHandler): void {
	void runDetached(fn, onError);
}

async function runDetached(fn: () => Promise<void>, onError: DetachedErrorHandler): Promise<void> {
	try {
		await fn();
	} catch (error) {
		try {
			await onError(error);
		} catch {
			// onError itself failed; there is no further sink to route a second-order failure to.
			// This is a defensive backstop for a buggy onError implementation, not a new silent-
			// failure surface — the *original* error already reached onError above.
		}
	}
}
