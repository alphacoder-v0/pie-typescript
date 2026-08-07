/**
 * Port of oracle `crates/agent/src/harness/cost.rs` (pie @0a120dfd).
 *
 * Token + cost accumulator. Subscribes to assistant `message_end` events and aggregates the
 * `Usage` already attached to each assistant message by the provider. `record()` itself has no
 * provider-specific logic — it is a pure sum-only fold over whatever `usage`/`usage.cost` the
 * caller hands it, ported verbatim from oracle's `record()` (cost.rs:58-73).
 *
 * PORT-DIVERGENCE: B3 (RULEBOOK §5, oracle cost.rs:58-73) — fixed upstream; nothing in this file
 * changed. Oracle's file-level doc comment claims "the providers populate `Usage::cost` per-message
 * via the catalog's pricing table, so the tracker is a sum-only fold". That claim was false: no
 * oracle provider ever computed `usage.cost` (B3a — `crates/ai/src/providers/openai_responses.rs:
 * 542-564` and every sibling), so every `Usage.cost.*` reaching this fold was 0, and every cost the
 * product showed a user — the `/cost` breakdown, `oneLineSummary`'s status line, agent-harness's
 * `budget_cap_usd` gate — was $0 no matter how much was actually spent.
 *
 * B3 was therefore an EMERGENT defect, not a defect in `record()`: the fold correctly sums whatever
 * it is handed, which is exactly why it kept working for a faux/self-filled `Usage` (oracle's own
 * `accumulates_usage_and_costs` unit test, ported below) and misreported only for real provider
 * output — the masking that let it survive. The fix lands where the bug actually lived: phase 18 has
 * `packages/ai`'s provider layer price each message from the catalog (`computeCost` in
 * `packages/ai/src/usage.ts`), so this fold now sums real dollars with its arithmetic untouched.
 *
 * B4 note (RULEBOOK §5, agent_harness.rs:1716-1729,1882-1893): the budget_cap_usd check itself
 * lives in agent-harness.ts (a different unit, out of scope here), reading the numbers this file
 * produces via `snapshot()`/`totalCost()`. This file (cost.rs) has no budget-cap-checking
 * function of its own to port — grep-confirmed zero occurrences of "budget" in the oracle file.
 */

import type { Usage } from "@pie/ai";
import type { AgentEvent, AgentMessage } from "../types.ts";

/** Snapshot of the running totals. Cheap to clone via `snapshot()` — plain data. */
export interface CostSnapshot {
	tokens: Usage;
	turnCount: number;
}

/** Listener signature accepted by `Agent.subscribe()` (agent.ts). */
export type AgentListener = (event: AgentEvent, signal: AbortSignal) => Promise<void> | void;

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function cloneUsage(usage: Usage): Usage {
	return { ...usage, cost: { ...usage.cost } };
}

/** Total USD (input + output + cache). Convenience for the `/cost` summary line. */
export function totalCost(snapshot: CostSnapshot): number {
	return snapshot.tokens.cost.total;
}

/**
 * Accumulator. Unlike oracle's `Arc<Mutex<CostSnapshot>>` (cost.rs:31-33), `record()`/`reset()`/
 * `snapshot()` never cross an `await` (RULEBOOK §2.2 Mutex judgment: no cross-await critical
 * section → direct field access, single-threaded-atomic — no AsyncMutex needed). Cloning the
 * oracle tracker shares state via `Arc`; the TS equivalent of "share state" is simply passing the
 * same `CostTracker` instance around (object references), not re-cloning per call site.
 */
export class CostTracker {
	private tokens: Usage = emptyUsage();
	private turnCount = 0;

	/** pie: cost.rs:52-54 (snapshot) — returns an independent copy. */
	snapshot(): CostSnapshot {
		return { tokens: cloneUsage(this.tokens), turnCount: this.turnCount };
	}

	/** pie: cost.rs:56-58 (reset) — used by `/cost reset` and on session-switch. */
	reset(): void {
		this.tokens = emptyUsage();
		this.turnCount = 0;
	}

	/**
	 * pie: cost.rs:60-73 (record) — apply a single assistant usage record. Ported verbatim: a
	 * pure sum-only fold, no provider-specific logic and no cost derivation of its own (see the
	 * PORT-DIVERGENCE: B3 note above — the tracker trusts whatever `usage.cost` it is handed, and
	 * the provider layer is now the thing that fills it in).
	 */
	record(usage: Usage): void {
		this.tokens.input += usage.input;
		this.tokens.output += usage.output;
		this.tokens.cacheRead += usage.cacheRead;
		this.tokens.cacheWrite += usage.cacheWrite;
		this.tokens.totalTokens += usage.totalTokens;
		this.tokens.cost.input += usage.cost.input;
		this.tokens.cost.output += usage.cost.output;
		this.tokens.cost.cacheRead += usage.cost.cacheRead;
		this.tokens.cost.cacheWrite += usage.cost.cacheWrite;
		this.tokens.cost.total += usage.cost.total;
		this.turnCount += 1;
	}

	/**
	 * pie: cost.rs:75-89 (as_listener) — build an `AgentListener` that records every assistant
	 * `message_end`. Matches oracle's `AgentEvent::MessageEnd { message: AgentMessage::Llm(pie_ai
	 * ::Message::Assistant(a)) }` guard: TS's `AgentMessage` is a flat `role`-discriminated union
	 * (types.ts) rather than a nested Llm/Custom enum, so `message.role === "assistant"` is the
	 * equivalent type-system-mandated guard (every `CustomAgentMessages` extension in this
	 * codebase uses a distinct, non-"assistant" `role` tag — see harness/messages.ts and
	 * coding-agent/core/messages.ts). Synchronous end-to-end (no `await`), matching `record()`.
	 */
	asListener(): AgentListener {
		return (event: AgentEvent) => {
			if (event.type !== "message_end") return;
			const message = event.message;
			if (isAssistantMessage(message)) {
				this.record(message.usage);
			}
		};
	}
}

function isAssistantMessage(message: AgentMessage): message is AgentMessage & { role: "assistant"; usage: Usage } {
	return (
		typeof message === "object" &&
		message !== null &&
		(message as { role?: unknown }).role === "assistant" &&
		"usage" in message
	);
}

/**
 * pie: cost.rs:95-105 (one_line_summary) — render a one-line summary for the REPL status bar /
 * banner. User-visible text: format matched character-for-character (RULEBOOK §2.1).
 */
export function oneLineSummary(snapshot: CostSnapshot): string {
	const tokens = snapshot.tokens;
	return `tokens: in=${tokens.input} out=${tokens.output} cached=${tokens.cacheRead + tokens.cacheWrite} total=${tokens.totalTokens} | cost $${totalCost(snapshot).toFixed(4)}`;
}

/**
 * pie: cost.rs:108-127 (full_breakdown) — render the full breakdown used by the `/cost` slash
 * command. User-visible text: format matched character-for-character (RULEBOOK §2.1), including
 * blank lines and column alignment, verified against the oracle's backslash-continued format!
 * string byte-by-byte.
 */
export function fullBreakdown(snapshot: CostSnapshot): string {
	const tokens = snapshot.tokens;
	const cost = tokens.cost;
	return (
		`  turns:        ${snapshot.turnCount}\n` +
		`\n` +
		`Tokens:\n` +
		`\n` +
		`  input         ${tokens.input}\n` +
		`  output        ${tokens.output}\n` +
		`  cache read    ${tokens.cacheRead}\n` +
		`  cache write   ${tokens.cacheWrite}\n` +
		`  total         ${tokens.totalTokens}\n` +
		`\n` +
		`Cost (USD):\n` +
		`\n` +
		`  input         $${cost.input.toFixed(4)}\n` +
		`  output        $${cost.output.toFixed(4)}\n` +
		`  cache read    $${cost.cacheRead.toFixed(4)}\n` +
		`  cache write   $${cost.cacheWrite.toFixed(4)}\n` +
		`  total         $${cost.total.toFixed(4)}\n`
	);
}
