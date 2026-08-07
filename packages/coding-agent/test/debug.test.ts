/**
 * Characterization tests for `packages/coding-agent/src/debug.ts`
 * (port of oracle `crates/coding-agent/src/debug.rs`, pie @0a120dfd).
 *
 * The first four `describe` blocks translate oracle's own `#[cfg(test)]` module
 * (debug.rs:281-422) one test at a time; the rest lock line formatting, the `bounded_preview`
 * boundary arithmetic and the `wrap_stream_fn` pump, none of which oracle asserts directly but
 * all of which are user-visible text (RULEBOOK §2.1).
 */
import { AsyncQueue, type StreamFn } from "@pie/agent-core";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	createAssistantMessageEventStream,
	type Model,
	type Context as PiContext,
	type TextContent,
	type ThinkingContent,
	type ToolCall,
	type Usage,
} from "@pie/ai";
import { describe, expect, it } from "vitest";
import {
	boundedPreview,
	contextLine,
	DEBUG_PREVIEW_MAX_CHARS,
	DEBUG_PREVIEW_MAX_LINES,
	debugPreview,
	doneLine,
	type FeedUpdate,
	startLine,
	toolCallLine,
	wrapStreamFn,
} from "../src/debug.ts";

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** oracle debug.rs:291-306 (`fn assistant_message`). */
function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "faux" as Api,
		provider: "debug-provider",
		model: "debug-model",
		usage: emptyUsage,
		stopReason: "stop",
		timestamp: 0,
	};
}

function text(value: string): TextContent {
	return { type: "text", text: value };
}

function thinking(value: string): ThinkingContent {
	return { type: "thinking", thinking: value };
}

function ctx(messages: PiContext["messages"], extra: Partial<PiContext> = {}): PiContext {
	return { messages, ...extra };
}

const model: Model<Api> = {
	id: "debug-model",
	name: "Debug Model",
	api: "faux" as Api,
	provider: "debug-provider",
	baseUrl: "http://provider.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

describe("context_line redacts user and tool-result secrets (oracle debug.rs:308-349)", () => {
	it("redacts an OpenAI/Anthropic key in a user message", () => {
		const line = contextLine(
			1,
			ctx([{ role: "user", content: "token sk-abcdefghijklmnopqrstuvwxyz123456", timestamp: 0 }]),
		);
		expect(line).toBeDefined();
		expect(line).toContain("[REDACTED:openai_anthropic_key]");
		expect(line).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
	});

	it("redacts a bearer token in a tool result", () => {
		const line = contextLine(
			2,
			ctx([
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [text("Authorization: Bearer abcdefghijklmnopqrstuvwxyz")],
					isError: false,
					timestamp: 0,
				},
			]),
		);
		expect(line).toContain("[REDACTED:bearer_token]");
		expect(line).not.toContain("abcdefghijklmnopqrstuvwxyz");
	});
});

describe("tool-call and assistant text are redacted (oracle debug.rs:351-384)", () => {
	it("redacts a GitHub token inside pretty-printed tool arguments", () => {
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-1",
			name: "example",
			arguments: { token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" },
		};
		const line = toolCallLine(1, toolCall);
		expect(line).toContain("[REDACTED:github_token]");
		expect(line).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
	});

	it("redacts assistant text and thinking in the done line", () => {
		const assistant = assistantMessage([
			text("assistant sk-abcdefghijklmnopqrstuvwxyz123456"),
			thinking("thinking xoxb-1234567890-abcdef"),
		]);
		const line = doneLine(2, "stop", assistant, performance.now());
		expect(line).toContain("[REDACTED:openai_anthropic_key]");
		expect(line).toContain("[REDACTED:slack_token]");
		expect(line).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
		expect(line).not.toContain("xoxb-1234567890-abcdef");
	});
});

describe("error message is redacted (oracle debug.rs:386-409)", () => {
	it("scrubs a bearer token out of the provider error text", () => {
		const message = assistantMessage([]);
		message.errorMessage = "provider said Authorization: Bearer abcdefghijklmnopqrstuvwxyz";
		const rendered = `reason=Error message="${debugPreview(message.errorMessage)}"`;
		expect(rendered).toContain("[REDACTED:bearer_token]");
		expect(rendered).not.toContain("abcdefghijklmnopqrstuvwxyz");
	});
});

describe("debug_preview is bounded (oracle debug.rs:411-421)", () => {
	it("truncates a 200-line payload and stays inside both budgets", () => {
		const huge = Array.from({ length: 200 }, (_, i) => `line-${i} ${"x".repeat(100)}`).join("\n");
		const preview = debugPreview(huge);
		expect(preview).toContain("[debug preview truncated:");
		expect(preview.split("\n").length).toBeLessThanOrEqual(DEBUG_PREVIEW_MAX_LINES + 1);
		expect([...preview].length).toBeLessThanOrEqual(DEBUG_PREVIEW_MAX_CHARS + 128);
	});
});

describe("boundedPreview (oracle debug.rs:230-279)", () => {
	const MARKER = `[debug preview truncated: max ${DEBUG_PREVIEW_MAX_LINES} lines / ${DEBUG_PREVIEW_MAX_CHARS} chars]`;

	it("passes short input through untouched", () => {
		expect(boundedPreview("hello\nworld")).toBe("hello\nworld");
	});

	it("returns the empty string for empty input (split_inclusive yields no segments)", () => {
		expect(boundedPreview("")).toBe("");
	});

	it("keeps a trailing newline without inventing an extra empty line", () => {
		expect(boundedPreview("a\n")).toBe("a\n");
	});

	it("truncates on the line budget and appends the marker on its own line", () => {
		const input = Array.from({ length: DEBUG_PREVIEW_MAX_LINES + 5 }, (_, i) => `l${i}`).join("\n");
		const out = boundedPreview(input);
		expect(out.endsWith(MARKER)).toBe(true);
		const kept = out.slice(0, out.indexOf(MARKER));
		expect(kept.split("\n").filter((l) => l !== "").length).toBe(DEBUG_PREVIEW_MAX_LINES);
	});

	it("leaves input at exactly the line budget alone", () => {
		const input = Array.from({ length: DEBUG_PREVIEW_MAX_LINES }, (_, i) => `l${i}`).join("\n");
		expect(boundedPreview(input)).toBe(input);
	});

	it("truncates on the character budget", () => {
		const out = boundedPreview("y".repeat(DEBUG_PREVIEW_MAX_CHARS + 10));
		expect(out).toContain("[debug preview truncated:");
		expect(out.startsWith("y".repeat(DEBUG_PREVIEW_MAX_CHARS))).toBe(true);
	});

	it("leaves input at exactly the character budget alone", () => {
		const input = "y".repeat(DEBUG_PREVIEW_MAX_CHARS);
		expect(boundedPreview(input)).toBe(input);
	});

	it("counts Unicode scalars, not UTF-16 units, against the character budget", () => {
		// Each astral character is 2 UTF-16 units but 1 `char` in Rust; at exactly the budget in
		// `chars` the payload must survive intact.
		const input = "🙂".repeat(DEBUG_PREVIEW_MAX_CHARS);
		expect(boundedPreview(input)).toBe(input);
	});
});

describe("start_line (oracle debug.rs:90-117)", () => {
	it("renders every field, defaulting reasoning and session", () => {
		expect(startLine(1, model, ctx([]))).toBe(
			"[debug llm #1 start] provider=debug-provider api=faux model=debug-model messages=0 tools=0 system_chars=0 reasoning=off session=-",
		);
	});

	it("spells the thinking level with Rust's Debug identifier and carries the session id", () => {
		const line = startLine(4, model, ctx([{ role: "user", content: "hi", timestamp: 0 }], { systemPrompt: "abc" }), {
			reasoning: "xhigh",
			sessionId: "sess-1",
		});
		expect(line).toContain("messages=1");
		expect(line).toContain("system_chars=3");
		expect(line).toContain("reasoning=Xhigh");
		expect(line).toContain("session=sess-1");
	});

	it("counts system_chars in UTF-8 bytes, matching Rust's str::len", () => {
		// 3 characters, 9 UTF-8 bytes.
		expect(startLine(1, model, ctx([], { systemPrompt: "。。。" }))).toContain("system_chars=9");
	});

	it("counts tools", () => {
		const tools = [{ name: "t", description: "d", parameters: {} }] as unknown as PiContext["tools"];
		expect(startLine(1, model, ctx([], { tools }))).toContain("tools=1");
	});
});

describe("context_line (oracle debug.rs:119-126)", () => {
	it("is undefined when the context has no messages", () => {
		expect(contextLine(1, ctx([]))).toBeUndefined();
	});

	it("labels the last message's role, using oracle's snake_case tool_result", () => {
		expect(contextLine(1, ctx([{ role: "user", content: "hi", timestamp: 0 }]))).toBe(
			"[debug llm #1 context] last_user:\nhi",
		);
		expect(contextLine(2, ctx([assistantMessage([text("yo")])]))).toBe("[debug llm #2 context] last_assistant:\nyo");
		expect(
			contextLine(
				3,
				ctx([
					{
						role: "toolResult",
						toolCallId: "c",
						toolName: "read",
						content: [text("out")],
						isError: false,
						timestamp: 0,
					},
				]),
			),
		).toBe("[debug llm #3 context] last_tool_result:\nout");
	});

	it("joins user content blocks with newlines and renders images by mime type", () => {
		const line = contextLine(
			1,
			ctx([
				{
					role: "user",
					content: [text("look"), { type: "image", data: "AAAA", mimeType: "image/png" }],
					timestamp: 0,
				},
			]),
		);
		expect(line).toBe("[debug llm #1 context] last_user:\nlook\n[image:image/png]");
	});

	it("renders assistant tool calls in oracle's bracket form", () => {
		const line = contextLine(
			1,
			ctx([assistantMessage([{ type: "toolCall", id: "c1", name: "read", arguments: {} }])]),
		);
		expect(line).toBe("[debug llm #1 context] last_assistant:\n[tool-call:c1:read]");
	});
});

describe("tool_call_line (oracle debug.rs:128-137)", () => {
	it("pretty-prints arguments with a 2-space indent after `args=`", () => {
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "c1",
			name: "read",
			arguments: { path: "/tmp/x", limit: 10 },
		};
		expect(toolCallLine(3, toolCall)).toBe(
			'[debug llm #3 tool-call] id=c1 name=read args=\n{\n  "path": "/tmp/x",\n  "limit": 10\n}',
		);
	});

	it("renders empty arguments as {}", () => {
		expect(toolCallLine(1, { type: "toolCall", id: "c", name: "n", arguments: {} })).toContain("args=\n{}");
	});
});

describe("done_line (oracle debug.rs:139-164)", () => {
	it("renders usage, a 6-decimal cost and Rust's Debug enum spellings", () => {
		const message = assistantMessage([text("done")]);
		message.stopReason = "toolUse";
		message.responseId = "resp-1";
		message.usage = {
			input: 100,
			output: 20,
			cacheRead: 5,
			cacheWrite: 3,
			totalTokens: 128,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001234 },
		};
		const line = doneLine(9, "toolUse", message, performance.now());
		expect(line).toContain("[debug llm #9 done] reason=ToolUse stop=ToolUse");
		expect(line).toContain("usage=input:100 output:20 cache_read:5 cache_write:3 total:128");
		expect(line).toContain("cost:$0.001234");
		expect(line).toContain("response_id=resp-1");
		expect(line).toMatch(/text:\ndone$/);
	});

	it("renders a missing response id as `-` and elapsed in whole milliseconds", () => {
		const line = doneLine(1, "length", assistantMessage([]), performance.now());
		expect(line).toContain("reason=Length stop=Stop");
		expect(line).toContain("response_id=-");
		expect(line).toMatch(/elapsed=\d+ms/);
	});
});

describe("wrapStreamFn (oracle debug.rs:21-81)", () => {
	async function drain(queue: AsyncQueue<FeedUpdate>): Promise<FeedUpdate[]> {
		queue.close();
		const out: FeedUpdate[] = [];
		for (;;) {
			const value = await queue.next();
			if (value === undefined) return out;
			out.push(value);
		}
	}

	function baseReturning(events: AssistantMessageEvent[]): StreamFn {
		return () => {
			const stream = createAssistantMessageEventStream();
			for (const event of events) stream.push(event);
			stream.end();
			return stream;
		};
	}

	it("emits start, context, tool-call and done lines, and forwards every event", async () => {
		const tx = new AsyncQueue<FeedUpdate>();
		const message = assistantMessage([text("hi")]);
		const toolCall: ToolCall = { type: "toolCall", id: "c1", name: "read", arguments: {} };
		const wrapped = wrapStreamFn(
			baseReturning([
				{ type: "toolcall_end", contentIndex: 0, toolCall, partial: message },
				{ type: "done", reason: "stop", message },
			]),
			tx,
		);

		const out = await wrapped(model, ctx([{ role: "user", content: "hi", timestamp: 0 }]));
		const forwarded: AssistantMessageEvent[] = [];
		for await (const event of out) forwarded.push(event);

		expect(forwarded.map((e) => e.type)).toEqual(["toolcall_end", "done"]);

		const lines = (await drain(tx)).map((u) => u.text);
		expect(lines).toHaveLength(4);
		expect(lines[0]).toContain("[debug llm #1 start]");
		expect(lines[1]).toContain("[debug llm #1 context] last_user:");
		expect(lines[2]).toContain("[debug llm #1 tool-call] id=c1 name=read");
		expect(lines[3]).toContain("[debug llm #1 done] reason=Stop");
	});

	it("tags every feed update as a system-level plain line (oracle debug.rs:83-88)", async () => {
		const tx = new AsyncQueue<FeedUpdate>();
		wrapStreamFn(baseReturning([]), tx)(model, ctx([]));
		const updates = await drain(tx);
		expect(updates.length).toBeGreaterThan(0);
		expect(updates.every((u) => u.kind === "plain" && u.level === "system")).toBe(true);
	});

	it("omits the context line when the context is empty", async () => {
		const tx = new AsyncQueue<FeedUpdate>();
		wrapStreamFn(baseReturning([]), tx)(model, ctx([]));
		const lines = (await drain(tx)).map((u) => u.text);
		expect(lines.filter((l) => l.includes("context]"))).toEqual([]);
	});

	it("numbers calls from 1, incrementing per invocation", async () => {
		const tx = new AsyncQueue<FeedUpdate>();
		const wrapped = wrapStreamFn(baseReturning([]), tx);
		wrapped(model, ctx([]));
		wrapped(model, ctx([]));
		const lines = (await drain(tx)).map((u) => u.text);
		expect(lines[0]).toContain("#1 start");
		expect(lines[1]).toContain("#2 start");
	});

	it("emits the error line for an error termination", async () => {
		const tx = new AsyncQueue<FeedUpdate>();
		const error = assistantMessage([]);
		error.stopReason = "error";
		error.errorMessage = "boom";
		const wrapped = wrapStreamFn(baseReturning([{ type: "error", reason: "error", error }]), tx);

		const out = await wrapped(model, ctx([]));
		for await (const _event of out) {
			/* drain */
		}

		const lines = (await drain(tx)).map((u) => u.text);
		expect(lines.at(-1)).toMatch(/^\[debug llm #1 error\] reason=Error elapsed=\d+ms message="boom"$/);
	});

	it('falls back to "unknown error" when the error carries no message (oracle debug.rs:47-51)', async () => {
		const tx = new AsyncQueue<FeedUpdate>();
		const wrapped = wrapStreamFn(
			baseReturning([{ type: "error", reason: "aborted", error: assistantMessage([]) }]),
			tx,
		);

		const out = await wrapped(model, ctx([]));
		for await (const _event of out) {
			/* drain */
		}

		const lines = (await drain(tx)).map((u) => u.text);
		expect(lines.at(-1)).toContain("reason=Aborted");
		expect(lines.at(-1)).toContain('message="unknown error"');
	});

	it("emits the closed line when the stream ends without a terminal event (oracle debug.rs:68-76)", async () => {
		const tx = new AsyncQueue<FeedUpdate>();
		const message = assistantMessage([]);
		const wrapped = wrapStreamFn(baseReturning([{ type: "start", partial: message }]), tx);

		const out = await wrapped(model, ctx([]));
		for await (const _event of out) {
			/* drain */
		}
		// The wrapper's own stream never terminates here, so give the detached pump a turn.
		await new Promise((resolve) => setImmediate(resolve));

		const lines = (await drain(tx)).map((u) => u.text);
		expect(lines.at(-1)).toMatch(/^\[debug llm #1 closed\] elapsed=\d+ms stream ended without terminal event$/);
	});
});
