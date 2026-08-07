/**
 * char-tests port of oracle `crates/coding-agent/tests/task_tool_e2e.rs` (pie @0a120dfd).
 *
 * Oracle module doc: "End-to-end test for the subagent / Task tool (issue #11). Drives
 * `TaskTool::execute` with a faux StreamFn shared with the inner subagent harness. Verifies:
 * 1. The tool returns the subagent's final assistant text. 2. Unknown subagent_type errors
 * clearly. 3. Missing required `prompt` arg errors clearly."
 *
 * Oracle test functions: 4. Ported: 4. Skipped: 0.
 *
 * Construct mapping notes (all already adjudicated inside `src/tools/task.ts`, repeated here only
 * where they change the shape of a call in this file):
 * - `task::TaskTool::new(model, Some(stream_fn), tools_fn)` (task_tool_e2e.rs:71-75) ->
 *   `createTaskTool({ model, streamFn, subagentTools })`. `Arc::new(Vec::new)` (a factory
 *   returning an empty tool vec) -> `() => []`.
 * - `tool.execute(id, json, CancellationToken, None)` -> `tool.execute(id, params, signal,
 *   undefined)`; oracle's `CancellationToken::new()` (a never-cancelled token) maps to
 *   `undefined` for the AbortSignal, which task.ts treats identically (`signal?.aborted`).
 * - Oracle asserts on `res.content[0]` being `UserContentBlock::Text`; the TS tool result's
 *   `content` is the same ordered block list, so `content[0]` is read the same way.
 * - Oracle's `faux_stream` pushes `Start { partial }` then `Done { reason: Stop, message }` on an
 *   `AssistantMessageEventStream`; `MockAssistantStream` below is the same two-event shape on
 *   `@pie/ai`'s `EventStream` (its completion predicate is `done`/`error`, matching oracle's
 *   `DoneReason`-terminated stream).
 */

import type { StreamFn } from "@pie/agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, type Model } from "@pie/ai";
import { describe, expect, it } from "vitest";
import { createTaskTool } from "../../src/tools/task.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

/** pie: task_tool_e2e.rs:21-37 (`faux_model`). Field-for-field: oracle's `String::new()`
 * `base_url`, empty `input`, `ModelCost::default()`, and zero `context_window`/`max_tokens`. */
function fauxModel(): Model<string> {
	return {
		id: "faux",
		name: "Faux",
		api: "faux",
		provider: "faux",
		baseUrl: "",
		reasoning: false,
		input: [],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 0,
		maxTokens: 0,
	};
}

const EMPTY_USAGE: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** pie: task_tool_e2e.rs:39-67 (`faux_stream`). */
function fauxStream(text: string): StreamFn {
	return (() => {
		const stream = new MockAssistantStream();
		queueMicrotask(() => {
			const msg: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text }],
				api: "faux",
				provider: "faux",
				model: "faux",
				usage: EMPTY_USAGE,
				stopReason: "stop",
				timestamp: 0,
			};
			stream.push({ type: "start", partial: { ...msg, content: [] } });
			stream.push({ type: "done", reason: "stop", message: msg });
		});
		return stream;
	}) as StreamFn;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	const first = result.content[0];
	if (first?.type !== "text" || first.text === undefined) throw new Error("expected text content");
	return first.text;
}

describe("task_tool_e2e", () => {
	/** pie: task_tool_e2e.rs:69-94 */
	it("task_returns_subagent_final_text", async () => {
		const tool = createTaskTool({
			model: fauxModel(),
			streamFn: fauxStream("subagent result"),
			subagentTools: () => [],
		});
		const res = await tool.execute(
			"t-1",
			{
				subagent_type: "general",
				description: "look up X",
				prompt: "tell me about X",
			},
			undefined,
			undefined,
		);
		const body = textOf(res);
		expect(body).toBe("subagent result");
	});

	/** pie: task_tool_e2e.rs:96-113 */
	it("task_unknown_subagent_type_errors", async () => {
		const tool = createTaskTool({
			model: fauxModel(),
			streamFn: fauxStream("nope"),
			subagentTools: () => [],
		});
		let err = "";
		try {
			await tool.execute(
				"t-2",
				{
					// Oracle passes an out-of-enum value through `serde_json::json!`; the TS schema
					// narrows `subagent_type` to the literal union, so the cast reproduces the same
					// "value that failed validation upstream reaches execute()" scenario oracle's
					// defensive re-check (task.rs:77-86) exists for.
					subagent_type: "nope" as "general",
					prompt: "x",
				},
				undefined,
				undefined,
			);
		} catch (error) {
			err = error instanceof Error ? error.message : String(error);
		}
		expect(err, err).toContain("unknown subagent_type");
	});

	/** pie: task_tool_e2e.rs:115-124 */
	it("task_missing_prompt_errors", async () => {
		const tool = createTaskTool({
			model: fauxModel(),
			streamFn: fauxStream("nope"),
			subagentTools: () => [],
		});
		let err = "";
		try {
			// Oracle passes a bare `json!({})`; `prompt` is schema-required in TS too, so the cast
			// reproduces oracle's "arg absent at execute() time" case.
			await tool.execute("t-3", {} as { prompt: string }, undefined, undefined);
		} catch (error) {
			err = error instanceof Error ? error.message : String(error);
		}
		expect(err, err).toContain("missing required arg: prompt");
	});

	/** pie: task_tool_e2e.rs:126-156 */
	it("task_parent_abort_cascades_to_subagent", async () => {
		// pie: task_tool_e2e.rs:127-137 -- "Stalled subagent stream: subagent never finishes on
		// its own; only parent abort can unblock it." Oracle holds the sender for 30s; the TS
		// analog simply never pushes an event onto the stream (nothing else can complete it), so
		// the only path out is the agent loop's biased abort race (agent-loop.ts:363-369, which
		// exists precisely so "a stream that never notices `signal` doesn't block indefinitely").
		const stalled: StreamFn = (() => new MockAssistantStream()) as StreamFn;
		const tool = createTaskTool({ model: fauxModel(), streamFn: stalled, subagentTools: () => [] });
		const controller = new AbortController();
		const exec = tool.execute("t-4", { prompt: "x" }, controller.signal, undefined);
		// Oracle asserts the abort unblocks within 2s (`tokio::time::timeout`); vitest's
		// per-test timeout (30s, vitest.config.ts) is the outer bound, so the explicit race below
		// preserves oracle's 2s deadline as a hard assertion.
		let settled = false;
		const result = exec.then(
			(value) => {
				settled = true;
				return { ok: true as const, value };
			},
			(error: unknown) => {
				settled = true;
				return { ok: false as const, error };
			},
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		controller.abort();
		const deadline = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 2_000));
		const raced = await Promise.race([result, deadline]);
		expect(settled, "parent abort must unblock subagent within 2s").toBe(true);
		if (raced === "timeout") throw new Error("unreachable");
		expect(raced.ok, "execute must reject once the parent aborts").toBe(false);
		if (raced.ok) throw new Error("unreachable");
		const err = raced.error instanceof Error ? raced.error.message : String(raced.error);
		// pie: task_tool_e2e.rs:151-155
		expect(
			err.toLowerCase().includes("cancel") || err.toLowerCase().includes("abort"),
			`expected abort error: ${err}`,
		).toBe(true);
	});
});
