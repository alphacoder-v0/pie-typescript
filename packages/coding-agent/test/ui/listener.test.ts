/**
 * Tests for the port of oracle `crates/coding-agent/src/ui/listener.rs` (pie @0a120dfd).
 *
 * The first block ports the oracle's `#[cfg(test)] mod tests` (listener.rs:321-638) test for test,
 * same names, same assertions. The second block covers the listener wiring itself (oracle's
 * `agent_listener`/`harness_listener` closures, untested upstream) and the places where a Rust
 * primitive had to be re-implemented (`str::to_ascii_lowercase`, `chrono` local-time formatting).
 */

import type { AgentEvent, AgentToolResult, HarnessEvent } from "@pie/agent-core";
import { AsyncQueue } from "@pie/agent-core";
import { describe, expect, it } from "vitest";
import type { FeedUpdate } from "../../src/ui/feed.ts";
import {
	agentListener,
	dynamicPollStatusUpdate,
	harnessListener,
	mapAgentEvent,
	mapHarnessEvent,
} from "../../src/ui/listener.ts";

/** listener.rs:327-333 (`fn text_result`). */
function textResult(text: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details: null, terminate: undefined };
}

/** listener.rs:287-291 (`map_harness_event_for_test`). */
function mapHarnessEventForTest(event: HarnessEvent): FeedUpdate | undefined {
	return mapHarnessEvent(event, new Set<string>(), false);
}

// ── oracle listener.rs:321-638 (`mod tests`) ──────────────────────────────────────────────────

describe("listener (ported oracle tests)", () => {
	/** listener.rs:335-362. */
	it("tool_update_output_is_compacted_for_display", () => {
		const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
		const event: AgentEvent = {
			type: "tool_execution_update",
			toolCallId: "call-1",
			toolName: "bash",
			args: null,
			partialResult: textResult(text),
		};

		const updates = mapAgentEvent(event);
		expect(updates.length).toBe(1);
		const update = updates[0];
		if (update.kind !== "tool_progress") throw new Error("expected one tool progress update");
		expect(update.tool_call_id).toBe("call-1");
		expect(update.lines.some((line) => line.includes("truncated"))).toBe(true);
		expect(update.lines.length).toBeLessThanOrEqual(25);
	});

	/** listener.rs:364-383. */
	it("tool_result_output_is_compacted_without_mutating_result", () => {
		const original = "x".repeat(400);
		const result = textResult(original);
		const event: AgentEvent = {
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "bash",
			result,
			isError: false,
		};

		const updates = mapAgentEvent(event);
		expect(updates.length).toBe(1);
		const update = updates[0];
		if (update.kind !== "tool_end") throw new Error("expected one tool end update");
		expect(update.lines[0].endsWith("…")).toBe(true);
		const block = result.content[0];
		expect(block.type === "text" ? block.text : undefined).toBe(original);
	});

	/** listener.rs:385-399. */
	it("short_tool_output_display_stays_unchanged", () => {
		const event: AgentEvent = {
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "read",
			result: textResult("short\noutput"),
			isError: false,
		};

		const updates = mapAgentEvent(event);
		expect(updates.length).toBe(1);
		const update = updates[0];
		if (update.kind !== "tool_end") throw new Error("expected one tool end update");
		expect(update.lines).toEqual(["short", "output"]);
	});

	/** listener.rs:401-421. */
	it("skill_tool_start_uses_bounded_label_without_body", () => {
		const event: AgentEvent = {
			type: "tool_execution_start",
			toolCallId: "call-skill",
			toolName: "Skill",
			args: { name: "review-pr", content: "SECRET SKILL BODY" },
		};

		const updates = mapAgentEvent(event);
		expect(updates.length).toBe(1);
		const update = updates[0];
		if (update.kind !== "tool_start") throw new Error("expected one tool start update");
		expect(update.name).toBe("Skill(review-pr)");
		expect(update.args).toBe(""); // Skill tool args should not be rendered
	});

	/**
	 * listener.rs:423-433. A catalog hot-reload must reach the UI as an update (so the skills
	 * sidebar repaints and the web snapshot republishes) without appending a conversation line.
	 */
	it("skills_reloaded_maps_to_sidebar_refresh_update", () => {
		const update = mapHarnessEventForTest({ type: "skills_reloaded", total: 3 });
		expect(update).toEqual({ kind: "skills_reloaded", total: 3 });
	});

	/** listener.rs:435-453. */
	it("trigger_handling_start_renders_preview_safe_live_line", () => {
		const update = mapHarnessEventForTest({
			type: "trigger_handling_start",
			idempotencyKey: "idem-key",
			sourceKind: "mcp",
			sourceLabel: "mcp:github",
			eventLabel: "pr.merged",
			traceId: "trace-start",
		});
		if (update?.kind !== "plain") throw new Error("expected plain update");
		expect(update.level).toBe("system");
		expect(update.text).toContain("[trigger fired] trace=trace-start");
		expect(update.text).toContain("source=mcp:github");
		expect(update.text).toContain("event=pr.merged");
	});

	/** listener.rs:455-477. */
	it("debug_mode_renders_dynamic_periodic_trigger_lines", () => {
		const quiet = new Set<string>();
		const update = mapHarnessEvent(
			{
				type: "trigger_handling_start",
				idempotencyKey: "idem-key",
				sourceKind: "local",
				sourceLabel: "local:dynamic",
				eventLabel: "dynamic periodic check",
				traceId: "trace-debug",
			},
			quiet,
			true,
		);
		if (update?.kind !== "plain") throw new Error("expected plain update");
		expect(update.level).toBe("system");
		expect(update.text).toContain("[trigger fired] trace=trace-debug");
		expect(update.text).toContain("source=local:dynamic");
	});

	/** listener.rs:479-502. */
	it("trigger_completed_summary_is_not_display_truncated", () => {
		const summary = Array.from({ length: 30 }, (_, i) => `trigger result line ${i}`).join("\n");
		const update = mapHarnessEventForTest({
			type: "trigger_completed",
			traceId: "trace-full-trigger-result",
			summary,
			costUsd: undefined,
			details: null,
		});
		if (update?.kind !== "plain") throw new Error("expected plain update");
		expect(update.level).toBe("note");
		expect(update.text).toContain("[trigger completed] trace=trace-full-trigger-resu");
		expect(update.text).toContain("trigger result line 0");
		expect(update.text).toContain("trigger result line 29");
		expect(update.text.endsWith(summary)).toBe(true);
		expect(update.text).not.toContain("truncated");
	});

	/** listener.rs:504-520. */
	it("turn_end_continue_surfaces_goal_status_line", () => {
		const update = mapHarnessEventForTest({
			type: "turn_ended",
			decision: "continue",
			continuationCount: 1,
			reason: undefined,
			nextPromptPreview: "缺口: missing verification output. 继续。",
		});
		if (update?.kind !== "plain") throw new Error("expected plain update");
		expect(update.level).toBe("system");
		expect(update.text).toContain("[goal continuing]");
		expect(update.text).toContain("missing verification output");
	});

	/** listener.rs:522-531. */
	it("turn_end_stop_stays_quiet", () => {
		const update = mapHarnessEventForTest({
			type: "turn_ended",
			decision: "stop",
			continuationCount: 0,
			reason: undefined,
			nextPromptPreview: undefined,
		});
		expect(update).toBeUndefined(); // normal stop should not add feed noise
	});

	/** listener.rs:533-567. */
	it("dynamic_periodic_no_match_variants_stay_quiet", () => {
		const quiet = new Set<string>();
		expect(
			mapHarnessEvent(
				{
					type: "trigger_execution_started",
					traceId: "trace-chrome-check",
					sourceLabel: "local:dynamic",
					eventLabel: "dynamic periodic check",
					promptPreview: "Check Chrome Tab Job",
				},
				quiet,
				false,
			),
		).toBeUndefined();

		const update = mapHarnessEvent(
			{
				type: "trigger_completed",
				traceId: "trace-chrome-check",
				summary: "Checked Chrome tabs; no matching rule found.",
				costUsd: undefined,
				details: null,
			},
			quiet,
			false,
		);
		if (update?.kind !== "trigger_poll_status") {
			throw new Error("dynamic no-match poll completion should update poll status");
		}
		expect(update.trace_id).toBe("trace-chrome-check");
		expect(update.source_label).toBe("local:dynamic");
		expect(update.event_label).toBe("dynamic periodic check");
		expect(update.summary).toContain("no matching rule found");
	});

	/** listener.rs:569-584. */
	it("dynamic_periodic_poll_status_redacts_and_bounds_summary", () => {
		const marker = "sk-test-secret-1234567890";
		const update = dynamicPollStatusUpdate(
			"trace-secret",
			"local:dynamic",
			"dynamic periodic check",
			`Checked Chrome tabs with token ${marker}; no matching rule found.`,
		);
		if (update.kind !== "trigger_poll_status") throw new Error("expected poll status");
		expect(update.summary).not.toContain(marker);
		expect(update.summary).toContain("[REDACTED:");
		expect([...update.summary].length).toBeLessThanOrEqual(120);
	});

	/** listener.rs:586-619. */
	it("dynamic_periodic_matched_completion_renders_result", () => {
		const quiet = new Set<string>();
		expect(
			mapHarnessEvent(
				{
					type: "trigger_execution_started",
					traceId: "trace-chrome-match",
					sourceLabel: "local:dynamic",
					eventLabel: "dynamic periodic check",
					promptPreview: "Check Chrome Tab Job",
				},
				quiet,
				false,
			),
		).toBeUndefined();

		const update = mapHarnessEvent(
			{
				type: "trigger_completed",
				traceId: "trace-chrome-match",
				summary: "matched dyn-123 and archived the Chrome tab",
				costUsd: undefined,
				details: null,
			},
			quiet,
			false,
		);
		if (update?.kind !== "plain") throw new Error("expected plain update");
		expect(update.level).toBe("note");
		expect(update.text).toContain("archived the Chrome tab");
	});

	/** listener.rs:621-637. */
	it("trigger_deduped_renders_terminal_status_line", () => {
		const update = mapHarnessEventForTest({
			type: "trigger_handled",
			idempotencyKey: "idem-key",
			traceId: "trace-deduped",
			state: "deduped",
			auditEntryId: undefined,
			evaluatorDecision: { outcome: "deduped" },
		});
		if (update?.kind !== "plain") throw new Error("expected plain update");
		expect(update.level).toBe("system");
		expect(update.text).toBe("[trigger deduped] trace=trace-deduped");
	});
});

// ── port-specific: the listener closures and the re-implemented Rust primitives ───────────────

describe("agentListener (listener.rs:21-30)", () => {
	it("pushes every mapped update onto the queue and stays quiet for unmapped events", () => {
		const queue = new AsyncQueue<FeedUpdate>();
		const listener = agentListener(queue);
		const signal = new AbortController().signal;
		listener({ type: "agent_start" }, signal);
		listener(
			{
				type: "message_update",
				message: {} as never,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi", partial: {} as never },
			},
			signal,
		);
		listener(
			{
				type: "message_update",
				message: {} as never,
				assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hmm", partial: {} as never },
			},
			signal,
		);
		// Oracle's `_ => Vec::new()` arm: nothing is enqueued for these.
		listener({ type: "message_start", message: {} as never }, signal);
		listener(
			{
				type: "message_update",
				message: {} as never,
				assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: {} as never },
			},
			signal,
		);
		listener({ type: "agent_end", messages: [] }, signal);

		expect(queue.size).toBe(4);
	});

	it("renders non-Skill tool starts with the shared arg preview", () => {
		const updates = mapAgentEvent({
			type: "tool_execution_start",
			toolCallId: "call-read",
			toolName: "read",
			args: { path: "/tmp/x.rs", limit: 10 },
		});
		// `preview` (tui.ts:213, oracle tui.rs:412-436) brackets the pairs itself.
		expect(updates).toEqual([{ kind: "tool_start", name: "read", args: '(path="/tmp/x.rs", limit=10)' }]);
	});

	it("falls back to the plain tool label when a Skill call has no string name", () => {
		const updates = mapAgentEvent({
			type: "tool_execution_start",
			toolCallId: "call-skill",
			toolName: "Skill",
			args: { name: 42 },
		});
		expect(updates).toEqual([{ kind: "tool_start", name: "Skill", args: "(name=42)" }]);
	});
});

describe("harnessListener (listener.rs:95-102)", () => {
	it("keeps its own quiet set across events so a suppressed poll folds into a status update", async () => {
		const queue = new AsyncQueue<FeedUpdate>();
		const listener = harnessListener(queue, false);
		listener({
			type: "trigger_execution_started",
			traceId: "trace-quiet",
			sourceLabel: "local:dynamic",
			eventLabel: "dynamic periodic check",
			promptPreview: "poll",
		});
		expect(queue.size).toBe(0); // suppressed on the way in
		listener({
			type: "trigger_completed",
			traceId: "trace-quiet",
			summary: "nothing matched",
			costUsd: undefined,
			details: null,
		});
		expect(queue.size).toBe(1);
		expect((await queue.next())?.kind).toBe("trigger_poll_status");
	});

	it("two listeners do not share quiet state (oracle: one HashSet per closure)", async () => {
		const first = new AsyncQueue<FeedUpdate>();
		const second = new AsyncQueue<FeedUpdate>();
		harnessListener(
			first,
			false,
		)({
			type: "trigger_execution_started",
			traceId: "trace-a",
			sourceLabel: "local:dynamic",
			eventLabel: "dynamic periodic check",
			promptPreview: "poll",
		});
		// The second listener never saw the start event, so the completion is a normal feed line.
		harnessListener(
			second,
			false,
		)({
			type: "trigger_completed",
			traceId: "trace-a",
			summary: "nothing matched",
			costUsd: undefined,
			details: null,
		});
		expect(second.size).toBe(1);
		expect((await second.next())?.kind).toBe("plain");
	});
});

describe("harness event mapping details", () => {
	it("labels every terminal trigger state the way oracle spells it", () => {
		const label = (state: "cycle_suppressed" | "permission_denied" | "needs_approval"): string => {
			const update = mapHarnessEventForTest({
				type: "trigger_handled",
				idempotencyKey: "k",
				traceId: "t",
				state,
				auditEntryId: undefined,
				evaluatorDecision: undefined,
			});
			if (update?.kind !== "plain") throw new Error("expected plain update");
			return `${update.text} ${update.level}`;
		};
		expect(label("cycle_suppressed")).toBe("[trigger cycle-suppressed] trace=t system");
		expect(label("permission_denied")).toBe("[trigger permission-denied] trace=t error");
		expect(label("needs_approval")).toBe("[trigger needs-approval] trace=t error");
	});

	it("stays quiet for accepted and non-terminal trigger states", () => {
		for (const state of ["accepted", "received", "running", "failed", "completed"] as const) {
			expect(
				mapHarnessEventForTest({
					type: "trigger_handled",
					idempotencyKey: "k",
					traceId: "t",
					state,
					auditEntryId: undefined,
					evaluatorDecision: undefined,
				}),
			).toBeUndefined();
		}
	});

	it("substitutes 'completed' for a missing or tag-only summary and strips loop-protocol tags", () => {
		const line = (summary: string | undefined): string => {
			const update = mapHarnessEventForTest({
				type: "trigger_completed",
				traceId: "t",
				summary,
				costUsd: undefined,
				details: null,
			});
			if (update?.kind !== "plain") throw new Error("expected plain update");
			return update.text;
		};
		expect(line(undefined)).toBe("[trigger completed] trace=t completed");
		expect(line("<loop-state>x</loop-state>")).toBe("[trigger completed] trace=t completed");
		expect(line("<loop-state>x</loop-state>done")).toBe("[trigger completed] trace=t done");
	});

	it("renders goal pause lines from the reason, falling back to the decision", () => {
		const paused = mapHarnessEventForTest({
			type: "turn_ended",
			decision: "budget_limited",
			continuationCount: 2,
			reason: undefined,
			nextPromptPreview: undefined,
		});
		if (paused?.kind !== "plain") throw new Error("expected plain update");
		expect(paused.text).toBe("[goal paused] budget_limited");
		expect(paused.level).toBe("error");

		const withReason = mapHarnessEventForTest({
			type: "turn_ended",
			decision: "pause",
			continuationCount: 2,
			reason: "operator stopped it",
			nextPromptPreview: undefined,
		});
		if (withReason?.kind !== "plain") throw new Error("expected plain update");
		expect(withReason.text).toBe("[goal paused] operator stopped it");
	});

	it("uses the default continuation preview when the harness supplies none", () => {
		const update = mapHarnessEventForTest({
			type: "turn_ended",
			decision: "continue",
			continuationCount: 1,
			reason: undefined,
			nextPromptPreview: undefined,
		});
		if (update?.kind !== "plain") throw new Error("expected plain update");
		expect(update.text).toBe("[goal continuing] continuing toward the active goal");
	});

	it("truncates ids and labels outside debug mode only", () => {
		const long = "z".repeat(40);
		const quiet = new Set<string>();
		const plain = mapHarnessEvent({ type: "trigger_failed", traceId: long, reason: "boom" }, quiet, false);
		if (plain?.kind !== "plain") throw new Error("expected plain update");
		expect(plain.text).toBe(`[trigger failed] trace=${"z".repeat(24)}… boom`);

		const debugged = mapHarnessEvent({ type: "trigger_failed", traceId: long, reason: "boom" }, quiet, true);
		if (debugged?.kind !== "plain") throw new Error("expected plain update");
		expect(debugged.text).toBe(`[trigger failed] trace=${long} boom`);
	});

	it("ignores harness events with no oracle mapping", () => {
		expect(mapHarnessEventForTest({ type: "persistence_error", context: "c", message: "m" })).toBeUndefined();
		expect(mapHarnessEventForTest({ type: "trigger_requests_main_run", traceId: "t" })).toBeUndefined();
	});

	it("matches the no-match markers case-insensitively over ASCII only", () => {
		const quiet = new Set<string>(["t"]);
		const update = mapHarnessEvent(
			{ type: "trigger_completed", traceId: "t", summary: "  NO MATCH FOUND  ", costUsd: undefined, details: null },
			quiet,
			false,
		);
		expect(update?.kind).toBe("trigger_poll_status");
	});

	it("stamps the poll status with a zero-padded local wall clock and folds newlines", () => {
		const update = dynamicPollStatusUpdate("t", "local:dynamic", "dynamic periodic check", "nothing matched");
		if (update.kind !== "trigger_poll_status") throw new Error("expected poll status");
		expect(update.checked_at).toMatch(/^\d{2}:\d{2}:\d{2}$/);
		const multiline = dynamicPollStatusUpdate("t", "s", "e", "line one\nline two");
		if (multiline.kind !== "trigger_poll_status") throw new Error("expected poll status");
		expect(multiline.summary).toBe("line one line two");
	});
});
