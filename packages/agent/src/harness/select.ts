/**
 * Canonical mapping for `select!` (RULEBOOK §2.2, 36 oracle sites). `Promise.race` picks the
 * winner; every losing branch's `AbortController` is aborted so it can cancel its own work. Rust's
 * `select!` (without `biased`) picks pseudo-randomly among branches that are *simultaneously*
 * ready, for fairness (so repeated polling doesn't starve a rarely-ready branch behind an
 * always-ready one) — this does not reproduce that fairness: `Promise.race` is deterministic,
 * first-settled wins, and ties (branches that settle within the same microtask tick) go to
 * declaration order rather than a coin flip.
 *
 * Judgment for oracle call sites (RULEBOOK §2.2: "order-sensitive behavior must be pinned by a
 * characterization test"): this
 * deterministic substitute is acceptable everywhere a `select!`'s branches are driven by
 * independent real-world timing (network I/O, timers, an external cancellation) — genuinely
 * simultaneous readiness essentially never occurs there, so `selectN` picks whichever branch
 * actually became ready first, same as Rust would (minus Rust's tie-break coin flip on the rare
 * literal tie). The one place this substitution changes *observable* behavior is a call site that
 * invokes `selectN` repeatedly in a loop where one branch (e.g. a busy queue) is systematically
 * ready before another (e.g. a rarely-firing shutdown signal): Rust's randomization gives the
 * rarely-ready branch occasional chances even under contention, while `selectN`'s determinism
 * could in principle starve it every iteration. No oracle site in this phase's inventory relies on
 * that fairness; a future site that does needs either `selectBiased`'s explicit ordering (if the
 * oracle site uses `biased`) or a documented `BUG(port)` ledger entry (if it relies on genuine
 * randomization) instead of silently inheriting starvation risk.
 *
 * §4 requires exactly one implementation of this shape under `packages/agent/src/harness/`; other
 * packages import this file rather than hand-rolling `Promise.race` + manual abort wiring inline.
 */

/** One branch of a `selectN`/`selectBiased` call. `run` receives an `AbortSignal` that fires if this branch loses. */
export interface SelectCase<T> {
	run(signal: AbortSignal): Promise<T>;
}

export interface SelectResult<T> {
	/** Index into the `cases` array passed to `selectN`/`selectBiased` of the branch that won. */
	index: number;
	value: T;
}

/** Internal: a branch's settlement, tagged with its declaration index so the winner's index is
 * always known from the resolved value itself rather than from mutable shared state (which would
 * be racy — see `selectN`'s implementation comment). */
type Outcome<T> =
	| { index: number; status: "fulfilled"; value: T }
	| { index: number; status: "rejected"; error: unknown };

function toOutcome<T>(cases: readonly SelectCase<T>[], controllers: readonly AbortController[]): Promise<Outcome<T>>[] {
	return cases.map(
		(c, index): Promise<Outcome<T>> =>
			c.run(controllers[index].signal).then(
				(value): Outcome<T> => ({ index, status: "fulfilled", value }),
				(error: unknown): Outcome<T> => ({ index, status: "rejected", error }),
			),
	);
}

/**
 * Race `cases` against each other. The first to settle (resolve OR reject) wins; every other
 * branch's `AbortSignal` is aborted immediately after (losers are expected to use the signal to
 * cancel their own in-flight work, e.g. an HTTP request, a `setTimeout`, or a queued `AsyncQueue`
 * waiter — see `AsyncQueue.next`/`Signal.wait` in `./async-queue.ts`).
 *
 * The `outcomes` array never itself rejects — each branch's rejection is captured and re-tagged as
 * a *fulfilled* `Outcome`, so `Promise.race(outcomes)` always resolves with a plain value carrying
 * the winning index unambiguously. That sidesteps a subtle race that an earlier version of this
 * function had: tracking "which index won" via a shared mutable variable set from inside each
 * branch's own `.then()` handler is not safe, because `await Promise.race(...)` takes one extra
 * microtask tick to resume after the winning branch's wrapped promise settles — a *second* branch
 * that also happens to settle within that tick would overwrite the shared variable before the
 * abort loop reads it, aborting the actual winner instead of the loser. Baking the index into the
 * resolved value itself (rather than a side channel) makes the winner's identity immune to that
 * ordering window.
 *
 * try/finally guards the abort loop so it always runs — including when the winning branch
 * *rejected* (`winner.status === "rejected"`, re-thrown below). An earlier version of this function
 * awaited `Promise.race(branches)` with no try/finally: if the winning branch rejected, the
 * rejection propagated straight out of `selectN` and the abort loop below it was skipped entirely,
 * leaving every losing branch's `AbortController` un-aborted forever (CRITICAL — see
 * `select.test.ts`'s "aborts every losing branch's signal even when the winning branch rejects").
 */
export async function selectN<T>(cases: readonly SelectCase<T>[]): Promise<SelectResult<T>> {
	if (cases.length === 0) {
		throw new Error("selectN: at least one case is required");
	}
	const controllers = cases.map(() => new AbortController());
	const outcomes = toOutcome(cases, controllers);
	const winner = await Promise.race(outcomes);
	try {
		if (winner.status === "rejected") throw winner.error;
		return { index: winner.index, value: winner.value };
	} finally {
		for (let i = 0; i < controllers.length; i++) {
			if (i !== winner.index) controllers[i].abort();
		}
	}
}

/** Two-branch convenience wrapper over `selectN`. */
export function select2<A, B>(a: SelectCase<A>, b: SelectCase<B>): Promise<SelectResult<A | B>> {
	return selectN<A | B>([a, b]);
}

/**
 * Biased variant of `selectN`, mapping `select! { biased; ... }` (a subset of the 36 `select!`
 * oracle sites use `biased` — see inventory). A `biased` select polls its branches in declaration
 * order on every wake and takes the first one that is `Ready`, rather than Rust's default random
 * choice among simultaneously-ready branches.
 *
 * Plain `selectN` already ties-break same-microtask-tick resolutions in declaration order (see its
 * characterization test), so it happens to match `biased` for genuinely-simultaneous *promise*
 * resolutions. Where it does NOT match: a branch that settles even one microtask tick sooner than
 * an earlier-declared branch still wins under `selectN`/`Promise.race`, even though from a
 * `biased`-poll perspective both were "ready around the same moment" — e.g. a synchronous
 * cancellation event racing a response that resolved in the same synchronous turn but needs one
 * extra microtask hop to reach its own `.then`. `raceCancellable` in
 * `packages/mcp/src/internal/async-utils.ts:154-190` documents exactly this tie and fixes it (for
 * its 2-branch promise-vs-abort-signal case) by deferring the lower-priority branch's commit by one
 * `queueMicrotask` hop, giving the higher-priority branch's already-queued `.then` a chance to run
 * first. `selectBiased` generalizes that pattern to N branches: whenever any branch settles, its
 * outcome is recorded and a commit check is scheduled one microtask tick later (if one isn't
 * already pending); the check scans recorded outcomes in declaration order and commits to the
 * first one found. That one-tick grace period lets an earlier-declared branch which is "ready at
 * the same moment" get recorded too before the scan runs. A branch that is genuinely not ready by
 * the time the (possibly several, chained) checks run does not benefit from this — bias only
 * reorders branches that are ready within the same tick window, not branches that settle
 * meaningfully later, so it does not turn `selectBiased` into "always wait for branch 0".
 */
export function selectBiased<T>(cases: readonly SelectCase<T>[]): Promise<SelectResult<T>> {
	if (cases.length === 0) {
		// Not `throw` — this function is not `async`, so a bare `throw` here would escape
		// synchronously to the caller instead of becoming a promise rejection (unlike `selectN`,
		// which is declared `async` and so auto-wraps a synchronous throw into a rejected
		// promise). Returning `Promise.reject` keeps the same-shaped contract as `selectN`/
		// `select2` for this error, so callers can uniformly `await`/`.catch()` it.
		return Promise.reject(new Error("selectBiased: at least one case is required"));
	}
	const controllers = cases.map(() => new AbortController());
	const outcomes: Array<Outcome<T> | undefined> = cases.map(() => undefined);
	let done = false;
	let checkScheduled = false;

	return new Promise<SelectResult<T>>((resolve, reject) => {
		const commitIfReady = (): void => {
			checkScheduled = false;
			if (done) return;
			const winnerIndex = outcomes.findIndex((outcome) => outcome !== undefined);
			if (winnerIndex === -1) return; // nothing settled yet; wait for the next settlement to re-schedule
			done = true;
			const winner = outcomes[winnerIndex] as Outcome<T>;
			for (let i = 0; i < controllers.length; i++) {
				if (i !== winnerIndex) controllers[i].abort();
			}
			if (winner.status === "rejected") reject(winner.error);
			else resolve({ index: winnerIndex, value: winner.value });
		};
		const scheduleCheck = (): void => {
			if (checkScheduled || done) return;
			checkScheduled = true;
			queueMicrotask(commitIfReady);
		};
		cases.forEach((c, index) => {
			c.run(controllers[index].signal).then(
				(value) => {
					if (done || outcomes[index] !== undefined) return;
					outcomes[index] = { index, status: "fulfilled", value };
					scheduleCheck();
				},
				(error: unknown) => {
					if (done || outcomes[index] !== undefined) return;
					outcomes[index] = { index, status: "rejected", error };
					scheduleCheck();
				},
			);
		});
	});
}
