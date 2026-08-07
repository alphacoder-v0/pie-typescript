import type { AgentTool, StreamFn } from "@pie/agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@pie/ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createTaskTool, createTaskToolDefinition, type TaskToolDetails } from "../src/tools/task.ts";

// pie: crates/coding-agent/src/tools/task.rs -- task.rs has no #[cfg(test)] module in oracle, so
// there is nothing to port verbatim here; these tests instead cover the behavior this file's doc
// comments claim to preserve bug-for-bug: single "general" type, fixed read-only tool set
// injection point, fresh context, no recursion cap (B10), and parent-abort cascading.

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

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
	errorMessage?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: EMPTY_USAGE,
		stopReason,
		errorMessage,
		timestamp: Date.now(),
	};
}

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((c) => c.type === "text")?.text ?? "";
}

const model = getModel("openai", "gpt-4o-mini");

const pingSchema = Type.Object({});
const pingTool: AgentTool<typeof pingSchema, undefined> = {
	name: "ping",
	label: "ping",
	description: "always-succeeding no-op tool used to drive multi-turn subagent loops in tests",
	parameters: pingSchema,
	async execute() {
		return { content: [{ type: "text", text: "pong" }], details: undefined };
	},
};

/** Streams `totalTurns - 1` tool-call turns, then a final text turn. */
function makeLoopingStreamFn(totalTurns: number): { streamFn: StreamFn; callCount: () => number } {
	let calls = 0;
	const streamFn = (() => {
		const stream = new MockAssistantStream();
		queueMicrotask(() => {
			calls++;
			if (calls < totalTurns) {
				stream.push({
					type: "done",
					reason: "toolUse",
					message: assistantMessage(
						[{ type: "toolCall", id: `call-${calls}`, name: "ping", arguments: {} }],
						"toolUse",
					),
				});
			} else {
				stream.push({
					type: "done",
					reason: "stop",
					message: assistantMessage([{ type: "text", text: `final after ${calls} turns` }]),
				});
			}
		});
		return stream;
	}) as StreamFn;
	return { streamFn, callCount: () => calls };
}

describe("task tool", () => {
	it("should expose the oracle schema shape (name/description/enum/additionalProperties)", () => {
		// pie: crates/coding-agent/src/tools/task.rs:174-199 (verbatim description; enum default +
		// additionalProperties:false shape)
		const def = createTaskToolDefinition({ model, subagentTools: () => [] });
		expect(def.name).toBe("task");
		expect(def.label).toBe("task");
		expect(def.description).toBe(
			"Delegate a self-contained research task to a fresh sub-agent. The subagent gets its own context window and tool set; this tool returns a single text result from the subagent. Use this when you need to inspect a large surface area (search, file reads) without polluting the main conversation.",
		);
		expect(def.executionMode).toBe("parallel");
		const params = def.parameters as unknown as {
			additionalProperties: boolean;
			required: string[];
			properties: { subagent_type: { default?: unknown } };
		};
		expect(params.additionalProperties).toBe(false);
		expect(params.required).toEqual(["prompt"]);
	});

	it("should run a single-turn subagent and return its final assistant text", async () => {
		const streamFn: StreamFn = (() => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: assistantMessage([{ type: "text", text: "the answer is 42" }]),
				});
			});
			return stream;
		}) as StreamFn;

		const tool = createTaskTool({ model, streamFn, subagentTools: () => [pingTool] });
		const result = await tool.execute("call-1", { prompt: "what is the answer?" }, undefined, undefined);
		expect(getText(result)).toBe("the answer is 42");
		const details = result.details as TaskToolDetails;
		expect(details).toMatchObject({ subagent_type: "general", description: "" });
	});

	it(// BUG(port): B10 (migration/RULEBOOK.md §5) -- oracle's task.rs:7 doc comment claims
	// "max 16 iterations" but no code in the construction chain (task.rs:98-155) enforces any
	// cap. This drives the subagent through 20 provider round-trips (> 16) and asserts it is
	// NOT truncated: every call happens, and the final result comes from the LAST turn.
	"should run past 16 subagent iterations without being truncated (B10: comment claims a cap, code enforces none)", async () => {
		const TOTAL_TURNS = 20;
		const { streamFn, callCount } = makeLoopingStreamFn(TOTAL_TURNS);
		const tool = createTaskTool({ model, streamFn, subagentTools: () => [pingTool] });

		const result = await tool.execute("call-loop", { prompt: "keep pinging" }, undefined, undefined);

		expect(callCount()).toBe(TOTAL_TURNS);
		expect(callCount()).toBeGreaterThan(16);
		expect(getText(result)).toBe(`final after ${TOTAL_TURNS} turns`);
	});

	it("should keep the LAST non-empty assistant turn's text, not the first (message_end overwrite semantics)", async () => {
		let calls = 0;
		const streamFn: StreamFn = (() => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				calls++;
				if (calls === 1) {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: assistantMessage(
							[
								{ type: "text", text: "first partial thought" },
								{ type: "toolCall", id: "call-1", name: "ping", arguments: {} },
							],
							"toolUse",
						),
					});
				} else {
					stream.push({
						type: "done",
						reason: "stop",
						message: assistantMessage([{ type: "text", text: "final thought" }]),
					});
				}
			});
			return stream;
		}) as StreamFn;

		const tool = createTaskTool({ model, streamFn, subagentTools: () => [pingTool] });
		const result = await tool.execute("call-order", { prompt: "think twice" }, undefined, undefined);
		expect(getText(result)).toBe("final thought");
	});

	it("should fall back to the oracle placeholder text when the subagent produces no text output", async () => {
		const streamFn: StreamFn = (() => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "done", reason: "stop", message: assistantMessage([]) });
			});
			return stream;
		}) as StreamFn;

		const tool = createTaskTool({ model, streamFn, subagentTools: () => [] });
		const result = await tool.execute("call-empty", { prompt: "say nothing" }, undefined, undefined);
		// pie: crates/coding-agent/src/tools/task.rs:157-160
		expect(getText(result)).toBe("(subagent produced no text output)");
	});

	it("should report `chars` as the UTF-8 byte length, not the JS string length (pie: task.rs:167, body.len())", async () => {
		const text = "emoji: \u{1F600}"; // 4-byte UTF-8 emoji; JS string length counts it as 2 UTF-16 units
		const streamFn: StreamFn = (() => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "done", reason: "stop", message: assistantMessage([{ type: "text", text }]) });
			});
			return stream;
		}) as StreamFn;

		const tool = createTaskTool({ model, streamFn, subagentTools: () => [] });
		const result = await tool.execute("call-bytes", { prompt: "emoji please" }, undefined, undefined);
		const details = result.details as TaskToolDetails;
		expect(details.chars).toBe(Buffer.byteLength(text, "utf-8"));
		expect(details.chars).not.toBe(text.length);
	});

	it("should reject an unknown subagent_type with oracle's exact message", async () => {
		// pie: crates/coding-agent/src/tools/task.rs:81-86
		const def = createTaskToolDefinition({ model, subagentTools: () => [] });
		await expect(
			def.execute(
				"call-bad-type",
				{ subagent_type: "coder" as any, prompt: "x" },
				undefined,
				undefined,
				{} as Parameters<typeof def.execute>[4],
			),
		).rejects.toThrow("unknown subagent_type: coder (allowed: general)");
	});

	it("should reject a missing prompt with oracle's exact message", async () => {
		const def = createTaskToolDefinition({ model, subagentTools: () => [] });
		await expect(
			def.execute("call-no-prompt", {} as any, undefined, undefined, {} as Parameters<typeof def.execute>[4]),
		).rejects.toThrow("missing required arg: prompt");
	});

	it("should surface a failed subagent run as 'subagent failed: ...' (Agent's StreamFn contract encodes failures into state.errorMessage instead of rejecting)", async () => {
		const streamFn: StreamFn = (() => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({
					// The event-level `reason` (constrained to "stop"|"length"|"toolUse" for a
					// "done" event) is never read by EventStream/AssistantMessageEventStream or by
					// task.ts -- only `event.message` (below) matters for stream completion. The
					// simulated failure lives in the resolved AssistantMessage's own
					// `stopReason`/`errorMessage` fields, which is what `sub.state.errorMessage`
					// (task.ts) actually surfaces as "subagent failed: ...".
					type: "done",
					reason: "stop",
					message: assistantMessage([{ type: "text", text: "" }], "error", "boom"),
				});
			});
			return stream;
		}) as StreamFn;

		const tool = createTaskTool({ model, streamFn, subagentTools: () => [] });
		await expect(tool.execute("call-fail", { prompt: "x" }, undefined, undefined)).rejects.toThrow(
			"subagent failed: boom",
		);
	});

	it("should cascade parent cancellation into the subagent and return 'cancelled'", async () => {
		// pie: crates/coding-agent/src/tools/task.rs:138-155
		const streamFn: StreamFn = ((_model, _context, options) => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: assistantMessage([]) });
				const checkAbort = () => {
					if (options?.signal?.aborted) {
						stream.push({
							type: "error",
							reason: "aborted",
							error: assistantMessage([{ type: "text", text: "" }], "aborted", "Aborted"),
						});
					} else {
						setTimeout(checkAbort, 5);
					}
				};
				checkAbort();
			});
			return stream;
		}) as StreamFn;

		const tool = createTaskTool({ model, streamFn, subagentTools: () => [] });
		const controller = new AbortController();
		const execPromise = tool.execute("call-cancel", { prompt: "do something slow" }, controller.signal, undefined);

		await new Promise((resolve) => setTimeout(resolve, 20));
		controller.abort();

		await expect(execPromise).rejects.toThrow("cancelled");
	});

	it("should build subagent tools fresh per call via the factory (not sharing instances across calls)", async () => {
		let factoryCalls = 0;
		const streamFn: StreamFn = (() => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "done", reason: "stop", message: assistantMessage([{ type: "text", text: "ok" }]) });
			});
			return stream;
		}) as StreamFn;

		const tool = createTaskTool({
			model,
			streamFn,
			subagentTools: () => {
				factoryCalls++;
				return [pingTool];
			},
		});

		await tool.execute("call-a", { prompt: "one" }, undefined, undefined);
		await tool.execute("call-b", { prompt: "two" }, undefined, undefined);
		expect(factoryCalls).toBe(2);
	});
});
