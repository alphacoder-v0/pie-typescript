/**
 * Auto-retry wrapper around `AgentHarness::prompt` — the port of oracle
 * `crates/coding-agent/src/agent_session.rs:63-217` (`struct AgentSession` + `prompt` +
 * `last_assistant` / `assistant_error_message` / `rewind_failed_assistant` / `backoff_ms`).
 *
 * ## Why here and not in `core/agent-session.ts`
 *
 * Oracle has **two** things called `AgentSession`. `core/agent-session.ts` is the port of pi's own
 * class — an `AgentSessionConfig`-constructed object owning an `Agent`, a `SessionManager` and a
 * `SettingsManager`, whose retry lives in private methods. Oracle's `agent_session.rs` is a
 * *different*, deliberately thin thing: "Lightweight wrapper. Holds the harness + retry settings;
 * not a deep clone of TS `AgentSession` (no extension orchestration, no event-bus fan-out — just
 * retry)" (agent_session.rs:62-64). Its only consumer is `ui/kernel.rs:121-124` — the no-image
 * `user_prompt_turn` branch — and a bare `AgentHarness` is all it is ever handed.
 *
 * `ui/kernel.ts` first shipped that branch un-retried, under a `TODO(port)`, because the pi-shaped
 * `AgentSession` cannot be built from a harness. This file closes that gap by porting the wrapper
 * oracle actually uses, at the surface oracle actually uses it on; `ReplKernel.setUserPromptRunner`
 * is the seam `ui/index.ts` installs it through. The retryable-error pattern is **not** duplicated:
 * it is imported from `core/agent-session.ts`, so one regex serves both sites.
 *
 * ## One mapping that is not line-for-line
 *
 * `rewind_failed_assistant` (agent_session.rs:172-210) does two things: pop trailing
 * `stop_reason == Error` assistants off `harness.agent().state().messages`, then move the session
 * leaf off the failed entry. Oracle's `Agent` carries a live message buffer that survives between
 * turns and *is* the next turn's context; the ported `AgentHarness` carries none — it rebuilds
 * context from the session branch each turn (`rehydrateFromSession` / `buildContext`). So the first
 * half has no TS state to act on, and the second half alone achieves what oracle's two halves
 * jointly achieve: the retried `continue()` sees a context that does not end in an error. Noted
 * rather than silently dropped, per RULEBOOK §3.
 */

import type { AgentMessage, SessionTreeEntry } from "@pie/agent-core";
import { type AssistantMessage, type ImageContent, listModels, type Model } from "@pie/ai";
import { isRetryableErrorMessage, RETRY_MAX_DELAY_MS, retryBackoffMs } from "../core/agent-session.ts";
import { sleep } from "../utils/sleep.ts";

/**
 * pie: agent_session.rs:25-34 (`struct RetrySettings`).
 *
 * `maxDelayMs` and `fallbackModel` have no key in this repo's `SettingsManager.getRetrySettings()`
 * because oracle has no settings file for them either — `main.rs:861` always builds
 * `RetrySettings::default()`, so `fallback_model` is `None` in every shipped invocation and the
 * fallback arm below is unreachable from the CLI. It is ported anyway (RULEBOOK §0: translate, do
 * not prune) and is reachable by an embedder that supplies one.
 */
export interface RetryPolicy {
	readonly enabled: boolean;
	readonly maxRetries: number;
	readonly baseDelayMs: number;
	readonly maxDelayMs: number;
	/** `(provider, model_id)` — swapped in **once**, after the primary model exhausts its retries. */
	readonly fallbackModel?: readonly [provider: string, id: string];
}

/** pie: agent_session.rs:36-47 (`impl Default for RetrySettings`). */
export function defaultRetryPolicy(): RetryPolicy {
	return {
		enabled: true,
		maxRetries: 5,
		baseDelayMs: 1000,
		maxDelayMs: RETRY_MAX_DELAY_MS,
		fallbackModel: undefined,
	};
}

/**
 * Widens this repo's `RetrySettings` (`core/settings-manager.ts`, which carries no `maxDelayMs`)
 * into the oracle shape by filling the cap oracle hardcodes.
 */
export function retryPolicyFrom(settings: {
	enabled?: boolean;
	maxRetries?: number;
	baseDelayMs?: number;
	fallbackModel?: readonly [string, string];
}): RetryPolicy {
	const base = defaultRetryPolicy();
	return {
		enabled: settings.enabled ?? base.enabled,
		maxRetries: settings.maxRetries ?? base.maxRetries,
		baseDelayMs: settings.baseDelayMs ?? base.baseDelayMs,
		maxDelayMs: base.maxDelayMs,
		fallbackModel: settings.fallbackModel,
	};
}

/** The `Session` methods `rewind_failed_assistant` calls (agent_session.rs:184-208). */
export interface RetrySession {
	/** pie: `session.leaf_id()`. */
	getLeafId(): Promise<string | null>;
	/** pie: `session.get_entry(&leaf_id)`. */
	getEntry(id: string): Promise<SessionTreeEntry | undefined>;
	/** pie: `session.move_to(parent_id.as_deref(), None)`. */
	moveTo(entryId: string | null, summary?: { summary: string; details?: unknown }): Promise<string | undefined>;
}

/** The `AgentHarness` slice this wrapper drives (agent_session.rs:87-149). */
export interface RetryHarness {
	prompt(text: string, options?: { images?: ImageContent[] }): Promise<AssistantMessage>;
	continue(): Promise<AssistantMessage>;
	setModel(model: Model<any>): Promise<void>;
	session(): RetrySession;
}

/** Injectable process-global lookups, so tests need neither a clock nor the model registry. */
export interface RetryDeps {
	/** pie: `tokio::time::sleep`. */
	sleep?: (ms: number) => Promise<void>;
	/** pie: `pie_ai::get_model(&Provider::from(provider), model_id)`. */
	findModel?: (provider: string, id: string) => Model<any> | undefined;
}

/** Rust `AgentRunError::Other(msg)` — a plain error carrying the message the loop classifies on. */
function runError(message: string): Error {
	return new Error(message);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * `pie_ai::get_model` over the merged registry, matching how `/model` resolves a spec
 * (`core/slash-dispatch-session.ts:215`).
 */
function findModelFromRegistry(provider: string, id: string): Model<any> | undefined {
	return listModels().find((model) => model.provider === provider && model.id === id);
}

/**
 * pie: agent_session.rs:159-170 (`assistant_error_message`). A `prompt()` that *resolved* can still
 * have produced a synthesized error assistant (the provider encoded the failure in the stream), so
 * the success path is re-examined through the same retry policy as the throw path.
 */
export function assistantErrorMessage(message: AssistantMessage | undefined): string | undefined {
	// pie: agent_session.rs:160-161.
	if (message === undefined) return undefined;
	// pie: agent_session.rs:162-164.
	if (message.stopReason !== "error") return undefined;
	// pie: agent_session.rs:166-168 — an error stop with no message still counts as an error.
	return message.errorMessage ?? "assistant stopped with an error";
}

/**
 * pie: agent_session.rs:172-210 (`rewind_failed_assistant`) — the session-tree half. See this
 * module's doc for why the agent-state half has no TS counterpart.
 *
 * Every "not a failed assistant leaf" shape (no leaf, non-message entry, healthy assistant) is a
 * no-op, exactly as oracle's `let … else { return Ok(()) }` arms are.
 */
export async function rewindFailedAssistant(session: RetrySession): Promise<void> {
	let leafId: string | null;
	try {
		// pie: agent_session.rs:186-190.
		leafId = await session.getLeafId();
	} catch (error) {
		throw runError(`session retry leaf lookup: ${errorText(error)}`);
	}
	if (leafId === null) return;

	let leaf: SessionTreeEntry | undefined;
	try {
		// pie: agent_session.rs:192-201.
		leaf = await session.getEntry(leafId);
	} catch (error) {
		throw runError(`session retry leaf entry lookup: ${errorText(error)}`);
	}
	if (leaf === undefined || leaf.type !== "message") return;

	const message = (leaf as unknown as { message: AgentMessage }).message;
	if (message.role !== "assistant") return;
	// pie: agent_session.rs:203.
	if ((message as AssistantMessage).stopReason !== "error") return;

	try {
		// pie: agent_session.rs:204-208 — `parent_id.as_deref()`, i.e. `None` when the failed entry
		// is the root.
		await session.moveTo((leaf as unknown as { parentId: string | null }).parentId ?? null);
	} catch (error) {
		throw runError(`session retry rewind: ${errorText(error)}`);
	}
}

/**
 * pie: agent_session.rs:85-150 (`AgentSession::prompt`).
 *
 * `attempt == 0` runs `prompt(text)`; every later attempt runs `continue()`, so the retried turn
 * resumes the conversation rather than re-sending the user message. Non-retryable errors, a
 * disabled policy, and an exhausted budget all surface the *original* error to the caller.
 */
export async function promptWithRetry(
	harness: RetryHarness,
	policy: RetryPolicy,
	text: string,
	deps: RetryDeps = {},
): Promise<void> {
	const wait = deps.sleep ?? ((ms: number) => sleep(ms));
	let attempt = 0;
	// pie: agent_session.rs:88 — one fallback swap per call, never a loop over models.
	let fallbackUsed = false;

	for (;;) {
		let err: unknown;
		try {
			// pie: agent_session.rs:90-95.
			const message = attempt === 0 ? await harness.prompt(text) : await harness.continue();
			// pie: agent_session.rs:97-100 — a resolved call can still carry an error assistant.
			const errorMessage = assistantErrorMessage(message);
			if (errorMessage === undefined) {
				return;
			}
			err = runError(errorMessage);
		} catch (error) {
			// pie: agent_session.rs:101.
			err = error;
		}

		// pie: agent_session.rs:106-108.
		if (!policy.enabled) throw err;
		// pie: agent_session.rs:110-112.
		if (!isRetryableErrorMessage(errorText(err))) throw err;

		// pie: agent_session.rs:114-133 — budget exhausted: try the fallback model once, else give up.
		if (attempt >= policy.maxRetries) {
			const fallback = policy.fallbackModel;
			if (fallback !== undefined && !fallbackUsed) {
				fallbackUsed = true;
				const model = (deps.findModel ?? findModelFromRegistry)(fallback[0], fallback[1]);
				if (model !== undefined) {
					// pie: agent_session.rs:123 — rewind BEFORE the swap, and let a rewind failure
					// propagate (`?`) rather than being folded into the swap error.
					await rewindFailedAssistant(harness.session());
					try {
						await harness.setModel(model);
					} catch (error) {
						// pie: agent_session.rs:125-128 — a distinct message, not the original error.
						throw runError(`fallback set_model failed: ${errorText(error)}`);
					}
					attempt = 0;
					continue;
				}
				// pie: an unknown fallback model falls through to the throw below, having consumed
				// the one swap (`fallback_used` is already set) — oracle's control flow exactly.
			}
			throw err;
		}

		// pie: agent_session.rs:135-142.
		attempt += 1;
		await wait(retryBackoffMs(attempt, policy.baseDelayMs, policy.maxDelayMs));
		// pie: agent_session.rs:144-146 — drop the failed turn so `continue()` does not replay a
		// context that ends in an error.
		await rewindFailedAssistant(harness.session());
	}
}
