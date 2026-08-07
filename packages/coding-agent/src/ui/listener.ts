/**
 * Port of oracle `crates/coding-agent/src/ui/listener.rs` (pie @0a120dfd).
 *
 * Adapters that turn live `AgentEvent`/`HarnessEvent` streams into {@link FeedUpdate}s and push
 * them onto the UI channel. These replace the old stdout-writing `tui::Tui` listeners: the
 * full-screen app owns the only writer (the ratatui terminal), so listeners must never touch
 * stdout — they only enqueue structured updates that the run loop drains and renders.
 *
 * RULEBOOK §2.2 mappings used here:
 * - `mpsc::UnboundedSender<FeedUpdate>` (listener.rs:13) → the shared `AsyncQueue` util. Oracle's
 *   `let _ = tx.send(update)` discards the closed-channel error; `AsyncQueue.push` returns the same
 *   information as a boolean and is likewise ignored.
 * - `parking_lot::Mutex<HashSet<String>>` (listener.rs:96) → a plain `Set<string>`: the critical
 *   sections (`quiet.lock().insert/remove`) are single operations that never cross an await, which
 *   is exactly the §2.2 `Mutex` row's "does not cross an await → direct field access" case.
 * - `Arc<dyn Fn…>` listener objects (listener.rs:22, 97) → plain closures, the shape
 *   `AgentListener`/`HarnessListener` already have in this repo.
 */

import type {
	AgentEvent,
	AgentListener,
	AgentToolResult,
	AsyncQueue,
	HarnessEvent,
	HarnessListener,
	SourceKind,
	TriggerState,
} from "@pie/agent-core";
import { redact } from "../bug-report.ts";
import { stripLoopProtocolTags } from "../triggers/cron.ts";
import {
	compactToolContentBlocks,
	type FeedUpdate,
	type Level,
	preview,
	type TriggerPollStatus,
	truncateChars,
} from "./feed.ts";

/**
 * listener.rs:19-30 (`agent_listener`). Build the per-turn agent listener. Maps streaming deltas,
 * tool calls, and turn boundaries into feed updates.
 *
 * Oracle wraps the body in `Box::pin(async move { … })` because `AgentListener` is a future-
 * returning trait object; the body contains no `.await`, so the TS listener is a plain synchronous
 * closure (`AgentListener` here is `(event, signal) => Promise<void> | void`). Making it `async`
 * would only insert a microtask hop the oracle does not have.
 */
export function agentListener(tx: AsyncQueue<FeedUpdate>): AgentListener {
	return (event) => {
		for (const update of mapAgentEvent(event)) tx.push(update);
	};
}

/**
 * listener.rs:32-79 (`map_agent_event`). Exported because the oracle's tests reach it through
 * `use super::*` on a private item; this port's tests import it instead.
 */
export function mapAgentEvent(event: AgentEvent): FeedUpdate[] {
	switch (event.type) {
		case "agent_start":
			return [{ kind: "turn_start" }];
		case "agent_end":
			return [{ kind: "turn_end" }];
		case "message_update":
			switch (event.assistantMessageEvent.type) {
				case "text_delta":
					return [{ kind: "text_delta", delta: event.assistantMessageEvent.delta }];
				case "thinking_delta":
					return [{ kind: "thinking_delta", delta: event.assistantMessageEvent.delta }];
				default:
					return [];
			}
		case "tool_execution_start": {
			const [name, args] = toolStartDisplay(event.toolName, event.args);
			return [{ kind: "tool_start", name, args }];
		}
		case "tool_execution_update":
			return [
				{
					kind: "tool_progress",
					tool_call_id: event.toolCallId,
					lines: compactToolContentBlocks((event.partialResult as AgentToolResult<unknown>).content, false),
					is_error: false,
				},
			];
		case "tool_execution_end":
			return [
				{
					kind: "tool_end",
					tool_call_id: event.toolCallId,
					lines: compactToolContentBlocks((event.result as AgentToolResult<unknown>).content, event.isError),
					is_error: event.isError,
				},
			];
		default:
			return [];
	}
}

/** listener.rs:81-91 (`tool_start_display`). Returns `[name, args]`. */
function toolStartDisplay(toolName: string, args: unknown): [string, string] {
	if (toolName === "Skill") {
		// `args.get("name").and_then(|v| v.as_str())` — only a *string* `name` takes this path.
		const name = asJsonObject(args)?.name;
		if (typeof name === "string") {
			return [`Skill(${truncateChars(name, 48)})`, ""];
		}
	}
	return [toolName, preview(args)];
}

function asJsonObject(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

/**
 * listener.rs:93-102 (`harness_listener`). Build the harness listener for trigger lifecycle lines.
 * Keeps the same "stay quiet unless a dynamic periodic check actually matched" behavior the old
 * renderer had.
 */
export function harnessListener(tx: AsyncQueue<FeedUpdate>, debug: boolean): HarnessListener {
	const quiet = new Set<string>();
	return (event) => {
		const update = mapHarnessEvent(event, quiet, debug);
		if (update !== undefined) tx.push(update);
	};
}

/**
 * listener.rs:104-249 (`map_harness_event`). `quiet` carries the trace ids of dynamic periodic
 * checks that were suppressed on the way in, so their completion can be folded into the poll-status
 * line instead of the conversation feed.
 */
export function mapHarnessEvent(event: HarnessEvent, quiet: Set<string>, debug: boolean): FeedUpdate | undefined {
	switch (event.type) {
		case "trigger_handling_start": {
			// listener.rs:117-121.
			if (!debug && event.sourceLabel === "local:dynamic" && event.eventLabel === "dynamic periodic check") {
				quiet.add(event.traceId);
				return undefined;
			}
			return {
				kind: "plain",
				text:
					`[trigger fired] trace=${debugText(debug, event.traceId, 24)} ` +
					`source=${debugText(debug, event.sourceLabel, 48)} ` +
					`kind=${sourceKindLabel(event.sourceKind)} ` +
					`event=${debugText(debug, event.eventLabel, 64)}`,
				level: "system",
			};
		}
		case "trigger_handled": {
			// listener.rs:133-152.
			switch (event.state) {
				case "accepted":
					return undefined;
				case "deduped":
				case "cycle_suppressed":
				case "permission_denied":
				case "needs_approval":
					quiet.delete(event.traceId);
					return {
						kind: "plain",
						text: `[trigger ${triggerStateLabel(event.state)}] trace=${debugText(debug, event.traceId, 24)}`,
						level: triggerStateLevel(event.state),
					};
				default:
					return undefined;
			}
		}
		case "trigger_completed": {
			// listener.rs:153-181. Loop-protocol tags are persisted by the cron listener; keep them
			// out of the conversation line.
			const stripped = event.summary === undefined ? undefined : stripLoopProtocolTags(event.summary);
			const summary = stripped !== undefined && stripped.length > 0 ? stripped : "completed";
			const wasQuiet = quiet.delete(event.traceId);
			if (!debug && wasQuiet && isNoMatchDynamicSummary(summary)) {
				return dynamicPollStatusUpdate(event.traceId, "local:dynamic", "dynamic periodic check", summary);
			}
			return {
				kind: "plain",
				text: `[trigger completed] trace=${debugText(debug, event.traceId, 24)} ${summary}`,
				level: "note",
			};
		}
		case "trigger_failed":
			// listener.rs:182-192.
			quiet.delete(event.traceId);
			return {
				kind: "plain",
				text: `[trigger failed] trace=${debugText(debug, event.traceId, 24)} ${debugText(debug, event.reason, 180)}`,
				level: "error",
			};
		case "trigger_execution_started": {
			// listener.rs:193-212.
			if (!debug && event.sourceLabel === "local:dynamic" && event.eventLabel === "dynamic periodic check") {
				quiet.add(event.traceId);
				return undefined;
			}
			return {
				kind: "plain",
				text: `[trigger running] trace=${debugText(debug, event.traceId, 24)} ${debugText(debug, event.promptPreview, 120)}`,
				level: "system",
			};
		}
		case "turn_ended":
			// listener.rs:213-240.
			switch (event.decision) {
				case "continue":
					return {
						kind: "plain",
						text: `[goal continuing] ${debugText(
							debug,
							event.nextPromptPreview ?? "continuing toward the active goal",
							160,
						)}`,
						level: "system",
					};
				case "pause":
				case "budget_limited":
					return {
						kind: "plain",
						text: `[goal paused] ${debugText(debug, event.reason ?? event.decision, 160)}`,
						level: "error",
					};
				default:
					return undefined;
			}
		// listener.rs:241-246. Display-only sidebar refresh: the catalog can change with no other
		// feed activity (sub-agent installs a skill while the parent is idle), so the reload must
		// drive a repaint itself.
		case "skills_reloaded":
			return { kind: "skills_reloaded", total: event.total };
		default:
			return undefined;
	}
}

/** listener.rs:251-257 (`debug_text`). */
function debugText(debug: boolean, s: string, maxChars: number): string {
	return debug ? s : truncateChars(s, maxChars);
}

/** listener.rs:259-272 (`dynamic_poll_status_update`). */
export function dynamicPollStatusUpdate(
	traceId: string,
	sourceLabel: string,
	eventLabel: string,
	summary: string,
): FeedUpdate {
	const status: TriggerPollStatus = {
		checked_at: localTimeOfDay(new Date()),
		trace_id: truncateChars(traceId, 24),
		source_label: truncateChars(sourceLabel, 48),
		event_label: truncateChars(eventLabel, 64),
		summary: truncateChars(redact(summary).replaceAll("\n", " "), 120),
	};
	return { kind: "trigger_poll_status", ...status };
}

/** `chrono::Local::now().format("%H:%M:%S")` (listener.rs:266) — zero-padded local wall clock. */
function localTimeOfDay(now: Date): string {
	const pad = (n: number): string => String(n).padStart(2, "0");
	return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

/** listener.rs:274-285 (`is_no_match_dynamic_summary`). */
function isNoMatchDynamicSummary(summary: string): boolean {
	const normalized = asciiLowercase(summary.trim());
	return (
		normalized === "no dynamic trigger rule matched" ||
		normalized.includes("no dynamic trigger rule matched") ||
		normalized.includes("no trigger rule matched") ||
		normalized.includes("no dynamic rule matched") ||
		normalized.includes("no matching trigger") ||
		normalized.includes("no matching rule") ||
		normalized.includes("no match found") ||
		normalized.includes("nothing matched") ||
		normalized.includes("not matched")
	);
}

/** `str::to_ascii_lowercase` — ASCII only. `String.prototype.toLowerCase` would additionally fold
 * non-ASCII uppercase (e.g. `İ` → `i̇`, which contains an ASCII `i`), letting a summary match a
 * marker the oracle would not. */
function asciiLowercase(s: string): string {
	return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** listener.rs:293-305 (`trigger_state_label`). Three labels are hyphenated where this repo's
 * `TriggerState` union is snake_case, so this is a real mapping, not an identity. */
function triggerStateLabel(state: TriggerState): string {
	switch (state) {
		case "deduped":
			return "deduped";
		case "cycle_suppressed":
			return "cycle-suppressed";
		case "permission_denied":
			return "permission-denied";
		case "needs_approval":
			return "needs-approval";
		case "received":
			return "received";
		case "accepted":
			return "accepted";
		case "running":
			return "running";
		case "failed":
			return "failed";
		case "completed":
			return "completed";
	}
}

/** listener.rs:307-312 (`trigger_state_level`). */
function triggerStateLevel(state: TriggerState): Level {
	return state === "permission_denied" || state === "needs_approval" ? "error" : "system";
}

/** listener.rs:314-319 (`source_kind_label`). This repo's `SourceKind` union already spells the
 * labels oracle's match arms produce; kept as a function so the oracle site stays greppable. */
function sourceKindLabel(kind: SourceKind): string {
	return kind === "mcp" ? "mcp" : "local";
}
