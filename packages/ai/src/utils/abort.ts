/**
 * The synthetic message emitted on abort.
 *
 * pie: `crates/ai/src/utils/abort.rs:116-135` (`push_aborted`).
 *
 * **Why this file exists.** The manifest records this module as dissolved into the native
 * abort signal, on the grounds that the upstream helpers are provided for free by the
 * platform. That holds for five of them. It does not hold for the sixth: **synthesising a
 * termination message is application behavior, and an abort signal does not provide it.**
 * The surface-coverage audit flagged this, and this file is the response.
 *
 * Nine providers previously hand-wrote an equivalent in their catch blocks, and each pushed
 * the **accumulated** output: partial content received so far, accumulated tokens and
 * **cost**, the real error text, and any response id already obtained. Upstream pushes a
 * **fresh empty message**. The consequence is not cosmetic:
 *
 * - A caller using `complete()` or `stream()` directly saw a **non-zero cost** on an aborted
 *   turn where upstream reports zero. Any code that sums cost without first filtering on the
 *   stop reason was billing for aborted turns.
 * - Partial content travelled downstream with the message, into session history, exports and
 *   the interface, where upstream has no such content at all.
 *
 * The interactive escape path is intercepted further up by the agent loop on both sides and
 * is unaffected. What this changes is library-level consumers.
 */
import type { AssistantMessage, Model, Usage } from "../types.ts";

/** All counters and costs zero, matching the upstream default. */
export function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/**
 * Builds the message upstream pushes when a request is aborted.
 *
 * Field for field against `abort.rs:117-130`: empty content, all usage counters zero, no
 * response model, no response id,
 * no diagnostics, a stop reason of aborted, and an error message that is **always the literal
 * string "aborted"** rather than whatever the underlying failure said. An abort is not an
 * error, and the implementation detail should not leak to the caller.
 */
export function abortedMessage(model: Model<any>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: zeroUsage(),
		stopReason: "aborted",
		errorMessage: "aborted",
		timestamp: Date.now(),
	};
}
