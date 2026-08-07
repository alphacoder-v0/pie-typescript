/**
 * Shared REPL execution kernel for terminal and future web frontends.
 *
 * Port of oracle `crates/coding-agent/src/ui/kernel.rs` (pie @0a120dfd). Oracle module doc:
 * "This module owns the 'what work should the agent run' boundary: prompt futures, abort, model
 * capability checks, and queued-turn value types. The terminal UI still owns rendering and
 * keyboard/mouse handling, but it should not construct harness futures directly. Keeping that
 * split narrow lets the upcoming web UI reuse the same turn semantics without copying TUI code."
 *
 * ── NAMING CONVENTION IN THIS MODULE ─────────────────────────────────────────────────────────
 * Nothing here derives `serde::Serialize`, so no field name in this file is a wire name and every
 * one of them is camelCase per repo style. (Contrast `./feed.ts`, whose `FeedUpdate` /
 * `WebFeedBlock` / `TriggerPollStatus` ARE serde types and therefore keep snake_case field names —
 * RULEBOOK §2.1 "TS object field names are wire names".)
 *
 * ── LAZY RUST FUTURES vs EAGER JS PROMISES ───────────────────────────────────────────────────
 * `TurnFut` is oracle's `Pin<Box<dyn Future<…>>>`. A Rust future does no work until polled, so
 * `turn.fut = Some(kernel.prompt_turn(p))` in `ui/mod.rs` merely *stages* the turn; the `select!`
 * loop starts it. A JS promise starts immediately. The observable difference only shows up if a
 * caller builds a `TurnFut` and then drops it without awaiting — in oracle nothing happens, here
 * the harness call already ran. Every oracle call site polls what it stages, so this is inert in
 * practice; see {@link ReplKernel.guardUnawaited} for how the resulting rejection is kept from
 * becoming a process-level unhandled rejection.
 */

import { detach } from "@pie/agent-core";
import type { ImageContent, Model } from "@pie/ai";
import type { RetrySettings } from "../core/settings-manager.ts";

/**
 * pie: kernel.rs:71 (`harness: Arc<AgentHarness>`) — the slice this kernel drives, and no wider.
 *
 * Declared structurally rather than as `@pie/agent-core`'s `AgentHarness` class because the CLI does
 * not run that class: `migration/reviews/phase13/reachability-audit.md` §1 shows it is unreachable
 * from `cli.ts`, and the product runtime is `core/agent-session.ts` (bound to this shape by
 * `./app-harness.ts`). The class carries ~30 private fields, so a nominal parameter type would have
 * made the product harness un-passable. A real `AgentHarness` still satisfies every member below —
 * these are its public method names — so nothing that used to compile stops compiling.
 */
export interface KernelHarness {
	/** pie: `AgentHarness::abort`. */
	abort(): Promise<unknown>;
	/** pie: `harness.agent().state().model`. */
	getModel(): Model<any> | undefined;
	/** pie: `AgentHarness::prompt` / `prompt_with_images`. */
	prompt(text: string, options?: { images?: ImageContent[] }): Promise<unknown>;
	/** pie: `AgentHarness::prompt_from_template`. */
	promptFromTemplate(name: string, vars?: Record<string, unknown>): Promise<unknown>;
	/** pie: `AgentHarness::force_compact` — `bool` there, a discriminated result here. */
	compact(customInstructions?: string): Promise<{ ran: true; result: unknown } | { ran: false }>;
	/** pie: `AgentHarness::continue_`. */
	continue(): Promise<unknown>;
}

/**
 * pie: kernel.rs:21 (`type TurnFut`). Oracle doc: "In-flight model turn, polled by a frontend
 * event loop. Running this as a local future (not `tokio::spawn`) sidesteps the `Send` bound:
 * `AgentSession::prompt` briefly holds a `parking_lot` guard across an `.await`, so its future is
 * `!Send`."
 *
 * `Result<Option<String>, AgentRunError>` → a promise that resolves with the optional status line
 * (currently only `compaction_turn` produces one) or rejects (RULEBOOK §2.4: `Result::Err`
 * propagation → throw, caught at the oracle `match` terminus — here `ui/index.ts`'s event loop).
 */
export type TurnFut = Promise<string | undefined>;

/** pie: kernel.rs:23-29 (`#[derive(Default)] struct TurnState`). */
export interface TurnState {
	/** pie: kernel.rs:25 (`fut: Option<TurnFut>`). */
	fut?: TurnFut;
	/** pie: kernel.rs:26 (`aborted: bool`). */
	aborted: boolean;
	/** pie: kernel.rs:27-28 — "Prefix for the error line if the turn fails (e.g. `triggered turn: `)." */
	prefix: string;
}

/**
 * pie: `TurnState::default()` — `#[derive(Default)]` gives `fut: None`, `aborted: false` and
 * `prefix: ""` (the `Default` impl for `&'static str`).
 */
export function newTurnState(): TurnState {
	return { fut: undefined, aborted: false, prefix: "" };
}

/**
 * pie: kernel.rs:31-34 (`poll_turn`). Oracle comment on the `expect`: "Only created by `select!`
 * when `fut.is_some()`, so the unwrap is sound."
 *
 * RULEBOOK §2.4 maps `.expect(msg)` to an allocation-guard: crash the operation, never degrade
 * silently. The repo has no shared `invariant()` helper yet, so this throws directly with oracle's
 * panic message verbatim.
 */
export function pollTurn(fut: TurnFut | undefined): TurnFut {
	if (fut === undefined) {
		throw new Error("turn future present");
	}
	return fut;
}

/**
 * pie: kernel.rs:36-56 (`enum QueuedTurn`).
 *
 * `QueuedTurn` has NO serde derive in oracle (unlike `./feed.ts`'s `FeedUpdate`), so its `kind` tag
 * is not a wire name and either casing is equally faithful — this is the one naming question in the
 * `ui/` port that two agents can answer differently, and RULEBOOK's meta-rule sends it to the
 * orchestrator. Resolved here as **snake_case**, matching the tag spelling the sibling `FeedUpdate`
 * union already carries so the REPL loop's two `switch (x.kind)` statements read alike; the payload
 * fields stay camelCase per this file's header. Flagged for the phase-15 rulebook sweep.
 */
export type QueuedTurn =
	| {
			readonly kind: "user_prompt";
			readonly display: string;
			readonly prompt: string;
			readonly images: ImageContent[];
	  }
	| {
			readonly kind: "agent_prompt";
			readonly display: string;
			readonly prompt: string;
			/** pie: kernel.rs:45 (`error_context: &'static str`). */
			readonly errorContext: string;
	  }
	| {
			readonly kind: "prompt_template";
			readonly display: string;
			readonly name: string;
			/** pie: kernel.rs:50 (`serde_json::Map<String, serde_json::Value>`). */
			readonly vars: Record<string, unknown>;
	  }
	| { readonly kind: "compaction"; readonly display: string; readonly custom?: string };

/**
 * pie: kernel.rs:58-67 (`impl QueuedTurn { fn display(&self) -> &str }`). Every variant carries a
 * `display` field, so TS could read `turn.display` straight off the union; kept as a named function
 * so the oracle site stays greppable and so a future variant without the field is a type error here
 * rather than at each call site.
 */
export function queuedTurnDisplay(turn: QueuedTurn): string {
	return turn.display;
}

/**
 * pie: kernel.rs:69-160 (`#[derive(Clone)] struct ReplKernel`).
 *
 * Oracle's `Clone` is over `Arc<AgentHarness>` + a cheap `RetrySettings` clone; TS shares the
 * harness by reference, so no `clone()` surface is provided. The one piece of per-instance state
 * this port adds — the in-flight turn counter behind {@link isStreaming} — would NOT survive an
 * oracle-style clone anyway, so adding `clone()` would silently change its meaning.
 */
export class ReplKernel {
	/** pie: kernel.rs:71 (`harness: Arc<AgentHarness>`). See {@link KernelHarness}. */
	private readonly _harness: KernelHarness;
	/** pie: kernel.rs:72 (`retry: RetrySettings`). */
	private readonly _retry: RetrySettings;

	/**
	 * TODO(port): stand-in for oracle's `harness.agent().is_streaming()` (kernel.rs:88-90). The
	 * ported `AgentHarness` keeps its `phase` field private and exposes no accessor, and the bare
	 * `Agent` it drives is not reachable from the harness at all. Counting the turns this kernel
	 * itself has in flight reproduces the ONE oracle call site's intent exactly
	 * (`ui/mod.rs:1009-1018`: "a user prompt may have started in the gap; `continue_` would return
	 * AlreadyStreaming. Skip rather than error." — every such prompt goes through this kernel), and
	 * fails in the conservative direction otherwise: a turn started on the harness behind the
	 * kernel's back leaves this at 0, so `continue()` throws `AgentHarnessError("busy")` instead of
	 * being silently skipped (RULEBOOK §3 — crash beats silent degradation). Revisit if
	 * `AgentHarness` ever grows a public phase accessor.
	 */
	private inFlightTurns = 0;

	/** pie: kernel.rs:76-78 (`ReplKernel::new`). */
	constructor(harness: KernelHarness, retry: RetrySettings) {
		this._harness = harness;
		this._retry = retry;
	}

	/** pie: kernel.rs:80-82 (`harness`). */
	harness(): KernelHarness {
		return this._harness;
	}

	/**
	 * pie: kernel.rs:84-86 (`abort`). Oracle's `AgentHarness::abort()` is infallible and returns
	 * immediately (it only signals cancel tokens), so its call site — `ui/mod.rs:1314`, inside a
	 * synchronous `fn request_abort` — needs no error handling. The ported `AgentHarness.abort()`
	 * is `async` (it also drains queues, awaits idle, and emits an `abort` hook event) and can
	 * reject. Keeping this method `void`-returning preserves oracle's call shape, so the async
	 * work is detached through the canonical helper (RULEBOOK §2.2).
	 */
	abort(): void {
		detach(
			async () => {
				await this._harness.abort();
			},
			() => {
				// Oracle's `abort()` has no failure surface at all (`fn abort(&self)` → `()`), so
				// there is no oracle-side sink to route this to. Same posture as the `lsp.ts` read
				// pump / stderr drain detaches: a defensive backstop for a hook that throws during
				// teardown, not a new silent-failure surface for anything oracle reports.
			},
		);
	}

	/** pie: kernel.rs:88-90 (`is_streaming`). See {@link inFlightTurns} for the mapping caveat. */
	isStreaming(): boolean {
		return this.inFlightTurns > 0;
	}

	/**
	 * pie: kernel.rs:92-99 (`current_model_accepts_images`). Oracle reads
	 * `agent().state().model: Option<Model>` and answers `false` when unset; the ported harness
	 * always has a model, so the `unwrap_or(false)` arm survives only as the `?? undefined` guard.
	 * `InputModality::Image` is the string `"image"` in the ported `Model.input` union.
	 */
	currentModelAcceptsImages(): boolean {
		const model = this._harness.getModel() ?? undefined;
		return model?.input.includes("image") ?? false;
	}

	/** pie: kernel.rs:101-104 (`prompt_turn`). */
	promptTurn(prompt: string): TurnFut {
		return this.track(async () => {
			await this._harness.prompt(prompt);
			return undefined;
		});
	}

	/**
	 * The no-image branch's runner. `undefined` means "no wrapper installed", which degrades to the
	 * bare `harness.prompt()` this unit shipped on its own. See {@link setUserPromptRunner}.
	 */
	private userPromptRunner?: (promptText: string) => Promise<void>;

	/**
	 * Install the auto-retry wrapper oracle's no-image `user_prompt_turn` runs inside.
	 *
	 * pie: kernel.rs:121-124 — `AgentSession::new(harness, retry).prompt(text)`, the retry loop in
	 * `crates/coding-agent/src/agent_session.rs:87-149` (retryable-error classification, exponential
	 * backoff, `rewind_failed_assistant`, one fallback-model swap). That loop could not be reached
	 * from this file: this repo's `AgentSession` (`core/agent-session.ts`) keeps retry in private
	 * methods on a session built from an `AgentSessionConfig`, never from a bare `AgentHarness`.
	 *
	 * Phase 15 closed the gap by porting oracle's *own* thin wrapper — `./retry-prompt.ts`'s
	 * {@link promptWithRetry}, which takes exactly a harness plus settings, as `agent_session.rs`
	 * does — and having `ui/index.ts` install it here at construction. The seam is a setter rather
	 * than a constructor argument so this unit stays buildable (and testable) without the wrapper,
	 * and so {@link isStreaming}'s in-flight count keeps covering the retried turn: the runner
	 * executes *inside* {@link track}, not around it.
	 */
	setUserPromptRunner(run: (promptText: string) => Promise<void>): void {
		this.userPromptRunner = run;
	}

	/** pie: kernel.rs:106-127 (`user_prompt_turn`). */
	userPromptTurn(promptText: string, loadedImages: ImageContent[]): TurnFut {
		// pie: kernel.rs:113 — snapshot taken before the future is built, not inside it.
		const hasImages = loadedImages.length > 0;
		return this.track(async () => {
			if (hasImages) {
				// pie: kernel.rs:116-119 (`harness.prompt_with_images`) — oracle does NOT wrap this
				// branch in `AgentSession`, so it stays a single un-retried call.
				await this._harness.prompt(promptText, { images: loadedImages });
			} else if (this.userPromptRunner !== undefined) {
				// pie: kernel.rs:121-124.
				await this.userPromptRunner(promptText);
			} else {
				// No wrapper installed (this unit's tests, and any embedder that skips the setter):
				// one un-retried prompt, identical to the `has_images` branch apart from the images.
				await this._harness.prompt(promptText);
			}
			return undefined;
		});
	}

	/** pie: kernel.rs:129-141 (`template_turn`). */
	templateTurn(name: string, vars: Record<string, unknown>): TurnFut {
		return this.track(async () => {
			await this._harness.promptFromTemplate(name, vars);
			return undefined;
		});
	}

	/**
	 * pie: kernel.rs:143-154 (`compaction_turn`). Oracle's `force_compact` yields `bool`; the ported
	 * `AgentHarness.compact()` yields `{ ran: true, result } | { ran: false }`. Both status strings
	 * are user-visible, so they are reproduced character for character.
	 */
	compactionTurn(custom: string | undefined): TurnFut {
		return this.track(async () => {
			const outcome = await this._harness.compact(custom);
			return outcome.ran ? "compaction ran" : "nothing to compact";
		});
	}

	/** pie: kernel.rs:156-159 (`continue_turn`). */
	continueTurn(): TurnFut {
		return this.track(async () => {
			await this._harness.continue();
			return undefined;
		});
	}

	/**
	 * pie: kernel.rs:72 (`retry: RetrySettings`) — the policy this kernel was built with. `ui/index.ts`
	 * reads the same settings to build the wrapper it installs via {@link setUserPromptRunner}, so
	 * this accessor is what keeps the two in step.
	 */
	retry(): RetrySettings {
		return this._retry;
	}

	/**
	 * Wraps every `Box::pin(async move { … })` body: runs it, keeps {@link inFlightTurns} accurate,
	 * and installs the unawaited-rejection guard.
	 */
	private track(body: () => Promise<string | undefined>): TurnFut {
		this.inFlightTurns += 1;
		const fut = body().finally(() => {
			this.inFlightTurns -= 1;
		});
		return this.guardUnawaited(fut);
	}

	/**
	 * A staged-but-never-polled Rust future is inert; a staged-but-never-awaited JS promise that
	 * rejects tears the process down via `unhandledRejection`. Attaching a no-op handler to a
	 * SEPARATE branch of `fut` marks the rejection as observed without consuming it: the promise
	 * this returns still rejects for whoever awaits it, so nothing is swallowed (RULEBOOK §2.4) —
	 * only the "nobody ever looked at it" crash is suppressed, restoring oracle's drop semantics.
	 */
	private guardUnawaited(fut: TurnFut): TurnFut {
		void fut.catch(() => {
			// Observed here purely so Node does not treat an unpolled turn as a fatal unhandled
			// rejection; the returned promise below is the one that carries the error to the caller.
		});
		return fut;
	}
}
