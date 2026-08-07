/**
 * Control-plane prompt hooks for the CLI.
 *
 * Port of oracle crates/coding-agent/src/control_plane_prompt.rs (whole file).
 *
 * The agent loop suspends a tool call that needs user confirmation and calls
 * `AgentLoopConfig.onControlPlanePrompt`. This module builds the three hooks the CLI uses:
 * an interactive one that hands the request to the TUI over a queue, plus a constant deny and a
 * constant allow for headless/policy modes.
 *
 * Construct mapping notes (RULEBOOK §2.2):
 * - `mpsc::unbounded_channel` → the shared {@link AsyncQueue} util.
 * - `oneshot::channel` → `Promise.withResolvers` (captured inline; see the call site for why the
 *   native API is not used).
 * - `tokio::select!` → the shared {@link selectN} helper.
 * - `CancellationToken` → `AbortSignal` (the shape `onControlPlanePrompt` already takes).
 * - `Arc<dyn Fn ...>` → a plain closure value.
 */

import {
	AsyncQueue,
	type ControlPlanePromptDecision,
	type ControlPlanePromptRequest,
	type SelectCase,
	selectN,
} from "@pie/agent-core";

/** The hook shape `AgentLoopConfig.onControlPlanePrompt` expects.
 * pie: oracle `pie_agent_core::OnControlPlanePromptHook` (crates/agent/src/types.rs:590-598). */
export type OnControlPlanePromptHook = (
	request: ControlPlanePromptRequest,
	signal?: AbortSignal,
) => Promise<ControlPlanePromptDecision>;

/**
 * pie: control_plane_prompt.rs:9-18 (`struct UiControlPlanePrompt` + `resolve`).
 *
 * Rust's `oneshot::Sender` reports "dropped without sending" to the receiver for free. TS has no
 * destructor, so {@link UiControlPlanePrompt.close} is the explicit stand-in a UI must call when it
 * abandons a prompt — that is what produces oracle's `decision_rx` error branch
 * (control_plane_prompt.rs:41-43).
 * TODO(port): if the TUI ever drops prompts without calling `close`, the hook waits forever
 * instead of denying; revisit when `ui/mod.rs` is ported and the drop sites are known.
 */
export interface UiControlPlanePrompt {
	readonly request: ControlPlanePromptRequest;
	/** pie: control_plane_prompt.rs:15-17 — `let _ = self.responder.send(decision)`, so a second
	 * resolve (or a resolve after `close`) is silently ignored rather than throwing. */
	resolve(decision: ControlPlanePromptDecision): void;
	/** Stand-in for dropping the Rust `oneshot::Sender`. */
	close(): void;
}

/** Resolves to `deny` when `cancel` fires; cleans up its listener when the branch loses. */
function cancellationCase(cancel: AbortSignal | undefined, reason: string): SelectCase<ControlPlanePromptDecision> {
	return {
		run: (loserSignal) =>
			new Promise<ControlPlanePromptDecision>((resolve) => {
				if (cancel === undefined) {
					return; // No cancellation channel: this branch can never win.
				}
				const decision: ControlPlanePromptDecision = { type: "deny", reason };
				if (cancel.aborted) {
					resolve(decision);
					return;
				}
				const onCancel = () => {
					loserSignal.removeEventListener("abort", onLose);
					resolve(decision);
				};
				const onLose = () => {
					cancel.removeEventListener("abort", onCancel);
				};
				cancel.addEventListener("abort", onCancel, { once: true });
				loserSignal.addEventListener("abort", onLose, { once: true });
			}),
	};
}

/**
 * pie: control_plane_prompt.rs:20-51 (`interactive_hook`).
 *
 * Returns the hook plus the queue the UI drains. Oracle returns the `(hook, rx)` tuple; the TS
 * pair is named because a positional tuple reads worse at the call site.
 */
export function interactiveHook(): { hook: OnControlPlanePromptHook; prompts: AsyncQueue<UiControlPlanePrompt> } {
	const prompts = new AsyncQueue<UiControlPlanePrompt>();

	const hook: OnControlPlanePromptHook = async (request, cancel) => {
		// pie: control_plane_prompt.rs:28 `let (decision_tx, decision_rx) = oneshot::channel();` →
		// RULEBOOK §2.2's `oneshot` row (`Promise.withResolvers<T>()`). The resolvers are captured
		// inline instead of calling the native API because that needs TS lib "es2024" while this
		// monorepo's shared `tsconfig.base.json` is on "es2022" — same workaround and rationale as
		// `lsp.ts:391-400`, `oauth.ts`'s `awaitCallback` and `packages/mcp/src/internal/async-utils.ts:30-45`.
		let resolve!: (decision: ControlPlanePromptDecision) => void;
		const promise = new Promise<ControlPlanePromptDecision>((res) => {
			resolve = res;
		});
		let settled = false;
		const settle = (decision: ControlPlanePromptDecision): void => {
			if (settled) return;
			settled = true;
			resolve(decision);
		};

		const pending: UiControlPlanePrompt = {
			request,
			resolve: settle,
			close: () => settle({ type: "deny", reason: "control-plane prompt UI closed before a decision" }),
		};

		// pie: control_plane_prompt.rs:29-39 — a closed channel means the UI is gone.
		if (!prompts.push(pending)) {
			return { type: "deny", reason: "control-plane prompt UI is unavailable" };
		}

		// pie: control_plane_prompt.rs:40-47 — race the decision against cancellation.
		const result = await selectN<ControlPlanePromptDecision>([
			{ run: () => promise },
			cancellationCase(cancel, "control-plane prompt cancelled"),
		]);
		return result.value;
	};

	return { hook, prompts };
}

/** pie: control_plane_prompt.rs:53-63 (`deny_hook`). */
export function denyHook(reason: string): OnControlPlanePromptHook {
	return async () => ({ type: "deny", reason });
}

/** pie: control_plane_prompt.rs:65-71 (`allow_hook`). */
export function allowHook(): OnControlPlanePromptHook {
	return async () => ({ type: "allow" });
}
