/**
 * char-tests port of oracle `crates/coding-agent/tests/tui_render_e2e.rs` (pie @0a120dfd).
 *
 * Oracle module doc: "Capture-test for the TUI renderer. Drives a realistic event sequence
 * (thinking → text → tool call → tool result → final text → agent end) and asserts on the captured
 * byte stream. Stand-in for a real terminal e2e: without a TTY we can't observe cursor moves, but we
 * can pin the textual content + ANSI escapes that get emitted in order, which catches the bugs we
 * hit live (spinner remnants, double-printed tool names, stale color formatting bleeding into
 * post-thinking text)."
 *
 * Oracle test functions: 19. Ported (running): 19. `it.skip`: 0.
 *
 * ── STATUS: ALL 19 RUN AGAINST THE PHASE-14 RENDERER ─────────────────────────────────────────
 * The unit under test is oracle `crates/coding-agent/src/tui.rs` — specifically its two pure
 * rendering entry points `Tui::render_event(&AgentEvent, &mut dyn Write)` (tui.rs:142-211) and
 * `Tui::render_harness_event(&HarnessEvent, &mut dyn Write)` (tui.rs:213-326), plus the
 * `RenderState` they thread through (tui.rs:20-30). Phase 14 landed it as
 * `packages/coding-agent/src/tui.ts` (a full `port`, not a `diff-port`) and every `it.skip` here
 * was dropped, with no assertion weakened.
 *
 * Why a NEW file rather than a diff onto the manifest's stated out_path: manifest.tsv line 199
 * files this unit as
 *   `coding-agent/tui  crates/coding-agent/src/tui.rs -> packages/coding-agent/src/modes/interactive/interactive-mode.ts  diff-port  phase 14`
 * That base file is pi's component-tree TUI: it composes `@pie/tui` components and repaints through
 * a differential renderer. It has NO `renderEvent(event, out)` line-stream path at all — a repo-wide
 * grep for `renderEvent` / `[thinking]` / `⚙` across `packages/coding-agent/src` and
 * `packages/tui/src` returned nothing. The only other event consumer, `src/modes/print-mode.ts`,
 * emits either one JSON line per event (`--mode json`, print-mode.ts:104-106) or just the final
 * assistant text blocks (`--mode text`, print-mode.ts:138-142); it never renders a `[thinking]`
 * label, a `⚙ tool(args)` line, an indented tool-result body, or any `[trigger …]` status line.
 * So every assertion below was unimplemented behavior, not a mismatch — the same miscuration
 * `coding-agent/spinner` hit (Deviation log 2026-08-04). The manifest row still needs its
 * out_path/kind corrected by the orchestrator.
 *
 * What IS already ported and therefore type-checked in the bodies below: the whole event model.
 * `AgentEvent` (`agent_start` / `agent_end` / `message_update` / `tool_execution_start` /
 * `tool_execution_end`), `AssistantMessageEvent` (`thinking_delta` / `text_delta` /
 * `toolcall_start`), and the five trigger-lifecycle harness events are all real exported types from
 * `@pie/agent-core` + `@pie/ai`. The fixtures constructed here compile today, which is itself the
 * evidence that the ported event model can express every sequence oracle's renderer is specified
 * against.
 *
 * ── CONSTRUCT MAPPING (what the skipped bodies assume) ───────────────────────────────────────
 * - `&mut dyn std::io::Write` (a `Vec<u8>` in the test) -> {@link CaptureSink}, `write(chunk: string)`.
 *   Oracle does `String::from_utf8(buf).unwrap()` on the captured bytes and asserts on the string;
 *   the one test that leans on the bytes themselves, `chinese_content_renders_unchanged`, asserts
 *   only that the decode succeeds and the glyphs survive — which a string sink gives for free (the
 *   Rust-side hazard it guards, byte-offset slicing mid-codepoint, is a `String::truncate` problem
 *   that has no TS analogue; see `long_chinese_tool_arg_does_not_panic`).
 * - `tui::Tui::new()` -> `new TuiPort.Tui()`. Oracle's `Tui` is `Clone` over `Arc<Mutex<RenderState>>`;
 *   TS needs no such wrapper, but the state MUST still be per-instance and MUST persist across calls
 *   (three tests depend on it: the `quiet_dynamic_trigger_traces` set, and `text_open` /
 *   `trim_text_prefix` spanning multiple `renderEvent` calls).
 * - Oracle keeps `render_event` and `render_harness_event` separate because pie has two listener
 *   channels (`AgentListener` + `HarnessListener`). The TS harness merges them into one
 *   `AgentHarnessEvent` stream, so phase 14 may legitimately collapse these into a single
 *   `renderEvent`. If it does, only the call sites below change — no assertion does.
 * - `AgentEvent::MessageUpdate { message: AgentMessage::Llm(Message::Assistant(partial)), .. }` ->
 *   `{ type: "message_update", message: partial, assistantMessageEvent: ev }` (`AgentMessage` is
 *   `Message | CustomAgentMessages[...]`, so the assistant message goes in directly).
 * - `AssistantMessageEvent::ToolCallStart` -> `"toolcall_start"`; `TextDelta` -> `"text_delta"`;
 *   `ThinkingDelta` -> `"thinking_delta"` (contentIndex/delta/partial fields are 1:1).
 * - `TriggerState::Deduped` -> `"deduped"`; `SourceKind::Mcp` -> `"mcp"`.
 * - `HarnessEvent::TriggerHandled` in TS additionally carries `idempotencyKey` / `auditEntryId` /
 *   `evaluatorDecision`; oracle's struct has them too (it just `..`-ignores them at the match site).
 * - `serde_json::Value::Null` (tool result `details`, trigger `details`) -> `null`.
 */

import type {
	AgentEvent,
	AgentToolResult,
	TriggerCompletedEvent,
	TriggerExecutionStartedEvent,
	TriggerFailedEvent,
	TriggerHandledEvent,
	TriggerHandlingStartEvent,
} from "@pie/agent-core";
import type { AssistantMessage, AssistantMessageEvent, TextContent, ThinkingContent, ToolCall } from "@pie/ai";
import { describe, expect, it } from "vitest";

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Port surface demanded from phase 14's `coding-agent/tui` unit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/** pie: `&mut dyn std::io::Write` — the renderer's output target. */
interface OutputSink {
	write(chunk: string): void;
}

/** The five `HarnessEvent` variants oracle's `render_harness_event` acts on (tui.rs:213-326). */
type TuiHarnessEvent =
	| TriggerHandlingStartEvent
	| TriggerHandledEvent
	| TriggerCompletedEvent
	| TriggerFailedEvent
	| TriggerExecutionStartedEvent;

/** pie: tui.rs:32-359 (`struct Tui`). Per-instance `RenderState`, persisted across calls. */
interface TuiRenderer {
	/** pie: tui.rs:142-211 (`render_event`). */
	renderEvent(event: AgentEvent, out: OutputSink): void;
	/** pie: tui.rs:213-326 (`render_harness_event`). */
	renderHarnessEvent(event: TuiHarnessEvent, out: OutputSink): void;
}

interface TuiPort {
	Tui: new () => TuiRenderer;
}

/**
 * Typed `string` (not a literal) so the compiler leaves the specifier alone. That indirection was
 * originally needed because the renderer did not exist and a literal specifier would have been a
 * hard `tsgo` resolution error; phase 14 landed `packages/coding-agent/src/tui.ts`, so the target
 * now resolves at runtime and all 19 tests below run against it. Left as a variable on purpose: the
 * *assertions* are the binding artifact, and if the renderer is ever re-homed (e.g. re-exported
 * from `src/modes/interactive/interactive-mode.ts` once the line-stream mode is wired into the
 * REPL), retarget this constant rather than relaxing anything underneath it.
 */
const TUI_MODULE: string = "../../src/tui.ts";

async function loadTui(): Promise<TuiPort> {
	return (await import(TUI_MODULE)) as TuiPort;
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Test-local fixtures (oracle's own test scaffolding, not product behavior).
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

class CaptureSink implements OutputSink {
	private buf = "";

	write(chunk: string): void {
		this.buf += chunk;
	}

	asString(): string {
		return this.buf;
	}
}

/** pie: tui_render_e2e.rs:22-37 (`assistant`). */
function assistant(content: (TextContent | ThinkingContent | ToolCall)[]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

/** pie: tui_render_e2e.rs:39-44 (`message_update`). */
function messageUpdate(event: AssistantMessageEvent, partial: AssistantMessage): AgentEvent {
	return { type: "message_update", message: partial, assistantMessageEvent: event };
}

/** pie: tui_render_e2e.rs:190-195 — the `AgentToolResult` shape used by every tool-result event. */
function toolResult(text: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details: null };
}

/**
 * pie: tui_render_e2e.rs:46-66 (`strip_ansi`). Oracle doc: "Strip ANSI SGR escapes so assertions can
 * read the textual content directly. Operates on chars to preserve multi-byte UTF-8 glyphs (like the
 * `⚙` gear)." Spreading a JS string yields code points, the direct analogue of Rust's `chars()`.
 */
function stripAnsi(s: string): string {
	const chars = [...s];
	let out = "";
	let i = 0;
	while (i < chars.length) {
		const c = chars[i];
		i += 1;
		if (c === "\u001b" && chars[i] === "[") {
			i += 1; // consume '['
			// Skip CSI bytes until a final byte in 0x40..=0x7e.
			while (i < chars.length) {
				const peek = chars[i];
				i += 1;
				const code = peek.codePointAt(0) ?? 0;
				if (code >= 0x40 && code <= 0x7e) break;
			}
			continue;
		}
		out += c;
	}
	return out;
}

/** Rust `str::matches(pat).count()`. */
function countMatches(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

/** pie: tui_render_e2e.rs:79 etc. — `AgentEvent::AgentStart`. */
const AGENT_START: AgentEvent = { type: "agent_start" };
/** pie: tui_render_e2e.rs:110-115 etc. — `AgentEvent::AgentEnd { messages: Vec::new() }`. */
const AGENT_END: AgentEvent = { type: "agent_end", messages: [] };

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Tests
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

describe("tui_render_e2e (char-tests port)", () => {
	/** pie: tui_render_e2e.rs:68-146. Needs `renderEvent` + the thinking/text transition state. */
	it("renders_thinking_then_text_with_clean_transition", async () => {
		const tui = new (await loadTui()).Tui();
		const out = new CaptureSink();

		// pie: tui_render_e2e.rs:73-90
		const thinkingPartial = assistant([{ type: "thinking", thinking: "" }]);
		tui.renderEvent(AGENT_START, out);
		tui.renderEvent(
			messageUpdate(
				{ type: "thinking_delta", contentIndex: 0, delta: "considering options", partial: thinkingPartial },
				thinkingPartial,
			),
			out,
		);

		// pie: tui_render_e2e.rs:91-109
		const textPartial = assistant([
			{ type: "thinking", thinking: "considering options" },
			{ type: "text", text: "" },
		]);
		tui.renderEvent(
			messageUpdate(
				{ type: "text_delta", contentIndex: 1, delta: "the answer is 42", partial: textPartial },
				textPartial,
			),
			out,
		);
		tui.renderEvent(AGENT_END, out);

		const plain = stripAnsi(out.asString());

		// pie: tui_render_e2e.rs:121-126. Thinking block is labeled and contains its content.
		expect(plain, plain).toContain("[thinking] considering options");
		expect(plain.includes("pi>"), `assistant prompt marker should not render: ${plain}`).toBe(false);

		// pie: tui_render_e2e.rs:127-133. Final text appears AFTER the thinking line.
		const idxThinking = plain.indexOf("[thinking]");
		const idxAnswer = plain.indexOf("the answer is 42");
		expect(idxThinking, "[thinking] label present").toBeGreaterThanOrEqual(0);
		expect(idxAnswer, "answer present").toBeGreaterThanOrEqual(0);
		expect(
			idxAnswer,
			`answer should follow thinking: thinking@${idxThinking} answer@${idxAnswer}\n${plain}`,
		).toBeGreaterThan(idxThinking);

		// pie: tui_render_e2e.rs:134-139. Between thinking and answer there must be a newline.
		const between = plain.slice(idxThinking, idxAnswer);
		expect(between.includes("\n"), `missing line break between thinking and answer: ${JSON.stringify(between)}`).toBe(
			true,
		);

		// pie: tui_render_e2e.rs:140-145. No stale `[thinking]` label after the answer.
		expect(countMatches(plain, "[thinking]"), `exactly one [thinking] label expected, got:\n${plain}`).toBe(1);
	});

	/** pie: tui_render_e2e.rs:148-223. The regression that `toolcall_start` must NOT print. */
	it("tool_call_prints_exactly_once_not_duplicated", async () => {
		const tui = new (await loadTui()).Tui();
		const out = new CaptureSink();

		// pie: tui_render_e2e.rs:153-163
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-1",
			name: "read",
			arguments: { path: "/tmp/x.rs" },
		};
		const partial = assistant([toolCall]);

		tui.renderEvent(AGENT_START, out);
		// pie: tui_render_e2e.rs:166-177. `ToolCallStart` used to print the tool name. Verify we
		// DON'T duplicate it — only `ToolExecutionStart` should print.
		tui.renderEvent(messageUpdate({ type: "toolcall_start", contentIndex: 0, partial }, partial), out);
		tui.renderEvent(
			{ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "/tmp/x.rs" } },
			out,
		);
		tui.renderEvent(
			{
				type: "tool_execution_end",
				toolCallId: "call-1",
				toolName: "read",
				result: toolResult("file contents here"),
				isError: false,
			},
			out,
		);
		tui.renderEvent(AGENT_END, out);

		const plain = stripAnsi(out.asString());

		// pie: tui_render_e2e.rs:210-215. The tool name appears exactly once.
		const count = countMatches(plain, "⚙ read");
		expect(count, `tool name should print exactly once; got ${count} occurrences:\n${plain}`).toBe(1);
		// pie: tui_render_e2e.rs:216-217. The args preview is included.
		expect(plain, `args preview missing: ${plain}`).toContain("path=");
		// pie: tui_render_e2e.rs:218-222. The result body appears indented.
		expect(plain, `result not rendered: ${plain}`).toContain("    file contents here");
	});

	/** pie: tui_render_e2e.rs:225-307. */
	it("text_to_tool_to_text_transitions_have_clean_line_breaks", async () => {
		const tui = new (await loadTui()).Tui();
		const out = new CaptureSink();

		// pie: tui_render_e2e.rs:230-282. Round 1: text "first reply" → tool call → text "second
		// reply" → end.
		tui.renderEvent(AGENT_START, out);
		const firstPartial = assistant([{ type: "text", text: "" }]);
		tui.renderEvent(
			messageUpdate(
				{ type: "text_delta", contentIndex: 0, delta: "first reply", partial: firstPartial },
				firstPartial,
			),
			out,
		);
		tui.renderEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "ls", args: {} }, out);
		tui.renderEvent(
			{
				type: "tool_execution_end",
				toolCallId: "t1",
				toolName: "ls",
				result: toolResult("a.rs\nb.rs"),
				isError: false,
			},
			out,
		);
		const secondPartial = assistant([{ type: "text", text: "" }]);
		tui.renderEvent(
			messageUpdate(
				{ type: "text_delta", contentIndex: 0, delta: "second reply", partial: secondPartial },
				secondPartial,
			),
			out,
		);
		tui.renderEvent(AGENT_END, out);

		const plain = stripAnsi(out.asString());

		// pie: tui_render_e2e.rs:287-295. Each segment appears in order.
		const p1 = plain.indexOf("first reply");
		const pTool = plain.indexOf("⚙ ls");
		const pResult = plain.indexOf("    a.rs");
		const p2 = plain.indexOf("second reply");
		expect(p1, "first reply present").toBeGreaterThanOrEqual(0);
		expect(pTool, "tool present").toBeGreaterThanOrEqual(0);
		expect(pResult, "result line present").toBeGreaterThanOrEqual(0);
		expect(p2, "second reply present").toBeGreaterThanOrEqual(0);
		expect(p1 < pTool && pTool < pResult && pResult < p2, `order broken: ${plain}`).toBe(true);

		// pie: tui_render_e2e.rs:296-306. No "first reply⚙" or "a.rssecond" — every transition has
		// a line break.
		const betweenFirstTool = plain.slice(p1, pTool);
		expect(betweenFirstTool.includes("\n"), `first→tool needs newline: ${JSON.stringify(betweenFirstTool)}`).toBe(
			true,
		);
		const betweenResultSecond = plain.slice(pResult, p2);
		expect(
			betweenResultSecond.includes("\n"),
			`result→second needs newline: ${JSON.stringify(betweenResultSecond)}`,
		).toBe(true);
	});

	/** pie: tui_render_e2e.rs:309-347. */
	it("pure_text_output_drops_single_prefix_space", async () => {
		const tui = new (await loadTui()).Tui();
		const out = new CaptureSink();

		tui.renderEvent(AGENT_START, out);
		const partial = assistant([{ type: "text", text: "" }]);
		// pie: tui_render_e2e.rs:316-337
		tui.renderEvent(messageUpdate({ type: "text_delta", contentIndex: 0, delta: " hello", partial }, partial), out);
		tui.renderEvent(messageUpdate({ type: "text_delta", contentIndex: 0, delta: " world", partial }, partial), out);
		tui.renderEvent(AGENT_END, out);

		// pie: tui_render_e2e.rs:345-346
		const plain = stripAnsi(out.asString());
		expect(plain.startsWith("hello world"), JSON.stringify(plain)).toBe(true);
	});

	/** pie: tui_render_e2e.rs:349-387. */
	it("pure_text_output_drops_prefix_space_after_empty_delta", async () => {
		const tui = new (await loadTui()).Tui();
		const out = new CaptureSink();

		tui.renderEvent(AGENT_START, out);
		const partial = assistant([{ type: "text", text: "" }]);
		// pie: tui_render_e2e.rs:356-377. An empty delta must not flip `trim_text_prefix` off.
		tui.renderEvent(messageUpdate({ type: "text_delta", contentIndex: 0, delta: "", partial }, partial), out);
		tui.renderEvent(messageUpdate({ type: "text_delta", contentIndex: 0, delta: " dongxu!", partial }, partial), out);
		tui.renderEvent(AGENT_END, out);

		// pie: tui_render_e2e.rs:385-386
		const plain = stripAnsi(out.asString());
		expect(plain.startsWith("dongxu!"), JSON.stringify(plain)).toBe(true);
	});

	/** pie: tui_render_e2e.rs:389-418. */
	it("pure_text_output_drops_prefix_whitespace_split_across_deltas", async () => {
		const tui = new (await loadTui()).Tui();
		const out = new CaptureSink();

		tui.renderEvent(AGENT_START, out);
		const partial = assistant([{ type: "text", text: "" }]);
		// pie: tui_render_e2e.rs:396-408
		for (const delta of [" ", "\n", "\t", " dongxu!"]) {
			tui.renderEvent(messageUpdate({ type: "text_delta", contentIndex: 0, delta, partial }, partial), out);
		}
		tui.renderEvent(AGENT_END, out);

		// pie: tui_render_e2e.rs:416-417. Exact equality — the whole captured stream is "dongxu!\n".
		const plain = stripAnsi(out.asString());
		expect(plain, JSON.stringify(plain)).toBe("dongxu!\n");
	});

	/** pie: tui_render_e2e.rs:429-514. */
	it("chinese_content_renders_unchanged", async () => {
		const tui = new (await loadTui()).Tui();
		const out = new CaptureSink();

		// pie: tui_render_e2e.rs:434-439. A full turn: Chinese thinking + Chinese reply + Chinese
		// tool args + Chinese tool result. Assert every byte sequence survives the renderer intact
		// (no mojibake, no truncation, no panic from byte-level indexing).
		const thinkingText = "让我思考一下这个问题…";
		const replyText = "答案是：你好，世界！这是一个混合的回复，包含 ASCII and 中文。";
		const toolResultLines = "第一行\n第二行 with mixed ASCII\n第三行";

		tui.renderEvent(AGENT_START, out);

		// pie: tui_render_e2e.rs:443-458
		const thinkingPartial = assistant([{ type: "thinking", thinking: "" }]);
		tui.renderEvent(
			messageUpdate(
				{ type: "thinking_delta", contentIndex: 0, delta: thinkingText, partial: thinkingPartial },
				thinkingPartial,
			),
			out,
		);

		// pie: tui_render_e2e.rs:460-480
		tui.renderEvent(
			{
				type: "tool_execution_start",
				toolCallId: "t1",
				toolName: "read",
				args: { path: "/tmp/中文文件.rs", query: "查找" },
			},
			out,
		);
		tui.renderEvent(
			{
				type: "tool_execution_end",
				toolCallId: "t1",
				toolName: "read",
				result: toolResult(toolResultLines),
				isError: false,
			},
			out,
		);

		// pie: tui_render_e2e.rs:482-499
		const textPartial = assistant([{ type: "text", text: "" }]);
		tui.renderEvent(
			messageUpdate({ type: "text_delta", contentIndex: 0, delta: replyText, partial: textPartial }, textPartial),
			out,
		);
		tui.renderEvent(AGENT_END, out);

		const plain = stripAnsi(out.asString());

		// pie: tui_render_e2e.rs:505-513
		expect(plain, `thinking lost: ${plain}`).toContain(thinkingText);
		expect(plain, `reply lost: ${plain}`).toContain(replyText);
		expect(plain, `tool arg lost: ${plain}`).toContain("/tmp/中文文件.rs");
		expect(plain, `result line 1 lost: ${plain}`).toContain("第一行");
		expect(plain, `result line 2 lost: ${plain}`).toContain("第二行 with mixed ASCII");
		expect(plain, `result line 3 lost: ${plain}`).toContain("第三行");
	});

	/**
	 * pie: tui_render_e2e.rs:516-550. Oracle doc: "Specifically regress against the `preview()`
	 * byte-truncation panic. A long Chinese argument would hit `String::truncate(60)` mid-codepoint
	 * and crash the renderer. With the char-bounded fix, the long arg gets cleanly truncated + an
	 * ellipsis." The panic itself is Rust-specific, but the OBSERVABLE contract is not and is what
	 * this asserts: the arg preview truncates at 60 CHARS (not bytes/UTF-16 units) and appends `…`
	 * (tui.rs:412-448, `preview` + `truncate_chars`).
	 */
	it("long_chinese_tool_arg_does_not_panic", async () => {
		const tui = new (await loadTui()).Tui();
		const out = new CaptureSink();

		// pie: tui_render_e2e.rs:526. 120 chars, 360 bytes — `String::truncate(60)` would have panicked.
		const longChinese = "中文测试".repeat(30);
		tui.renderEvent(AGENT_START, out);
		tui.renderEvent(
			{ type: "tool_execution_start", toolCallId: "t1", toolName: "search", args: { query: longChinese } },
			out,
		);
		tui.renderEvent(AGENT_END, out);

		const plain = stripAnsi(out.asString());
		// pie: tui_render_e2e.rs:544-549. Output contains the tool name + an ellipsis from truncation.
		expect(plain, plain).toContain("⚙ search");
		expect(plain, `ellipsis expected from truncation: ${plain}`).toContain("…");
	});

	/**
	 * pie: tui_render_e2e.rs:552-589. Oracle doc: "Streaming arrives in fragments — sometimes
	 * splitting *inside* a multi-byte UTF-8 glyph at the network layer. The renderer never sees raw
	 * bytes (StreamFn already decodes), but we verify the chunk-by-chunk path doesn't break Chinese."
	 */
	it("streaming_chunks_preserve_chinese", async () => {
		const tui = new (await loadTui()).Tui();
		const out = new CaptureSink();

		tui.renderEvent(AGENT_START, out);
		const partial = assistant([{ type: "text", text: "" }]);
		// pie: tui_render_e2e.rs:563-576. Emit one character at a time.
		for (const ch of "你好，世界！") {
			tui.renderEvent(messageUpdate({ type: "text_delta", contentIndex: 0, delta: ch, partial }, partial), out);
		}
		tui.renderEvent(AGENT_END, out);

		// pie: tui_render_e2e.rs:584-588
		const plain = stripAnsi(out.asString());
		expect(plain, `single-char chunked text dropped chars: ${plain}`).toContain("你好，世界！");
	});

	/** pie: tui_render_e2e.rs:591-625. Needs BOTH renderers on ONE instance (shared RenderState). */
	it("trigger_completion_renders_live_result_line", async () => {
		const tui = new (await loadTui()).Tui();
		const out = new CaptureSink();

		tui.renderEvent(AGENT_START, out);
		const partial = assistant([{ type: "text", text: "" }]);
		// pie: tui_render_e2e.rs:597-608
		tui.renderEvent(
			messageUpdate({ type: "text_delta", contentIndex: 0, delta: "partial reply", partial }, partial),
			out,
		);
		tui.renderHarnessEvent(
			{
				type: "trigger_completed",
				traceId: "trace-live-result",
				summary: "wrote /tmp/trigger-output",
				costUsd: undefined,
				details: null,
			},
			out,
		);

		const plain = stripAnsi(out.asString());
		// pie: tui_render_e2e.rs:620-624. The open text block is closed with a newline FIRST.
		expect(plain, plain).toContain("partial reply\n");
		expect(plain, plain).toContain("[trigger completed] trace=trace-live-result wrote /tmp/trigger-output");
	});

	/** pie: tui_render_e2e.rs:627-650. */
	it("trigger_start_renders_live_fired_line", async () => {
		const tui = new (await loadTui()).Tui();
		const out = new CaptureSink();

		// pie: tui_render_e2e.rs:632-641
		tui.renderHarnessEvent(
			{
				type: "trigger_handling_start",
				idempotencyKey: "idem-key",
				sourceKind: "mcp",
				sourceLabel: "mcp:github",
				eventLabel: "pr.merged",
				traceId: "trace-trigger-start",
			},
			out,
		);

		const plain = stripAnsi(out.asString());
		// pie: tui_render_e2e.rs:643-649
		expect(plain, plain).toContain(
			"[trigger fired] trace=trace-trigger-start source=mcp:github kind=mcp event=pr.merged",
		);
	});

	/** pie: tui_render_e2e.rs:652-673. */
	it("trigger_terminal_non_running_state_renders_live_status_line", async () => {
		const tui = new (await loadTui()).Tui();
		const out = new CaptureSink();

		// pie: tui_render_e2e.rs:657-666
		tui.renderHarnessEvent(
			{
				type: "trigger_handled",
				idempotencyKey: "idem-key",
				traceId: "trace-deduped",
				state: "deduped",
				auditEntryId: undefined,
				evaluatorDecision: { outcome: "deduped" },
			},
			out,
		);

		const plain = stripAnsi(out.asString());
		// pie: tui_render_e2e.rs:668-672
		expect(plain, plain).toContain("[trigger deduped] trace=trace-deduped");
	});

	/** pie: tui_render_e2e.rs:675-701. */
	it("trigger_completion_summary_is_not_display_truncated", async () => {
		const tui = new (await loadTui()).Tui();
		const out = new CaptureSink();
		// pie: tui_render_e2e.rs:679-682
		const longSummary = Array.from({ length: 40 }, (_, i) => `result-line-${i}`).join("\n");

		tui.renderHarnessEvent(
			{
				type: "trigger_completed",
				traceId: "trace-long-result",
				summary: longSummary,
				costUsd: undefined,
				details: null,
			},
			out,
		);

		const plain = stripAnsi(out.asString());
		// pie: tui_render_e2e.rs:694-700
		expect(plain, plain).toContain("result-line-0");
		expect(plain, plain).toContain("result-line-39");
		expect(
			!plain.includes("truncated") && !plain.includes("…"),
			`trigger completion is final output and should not use preview truncation:\n${plain}`,
		).toBe(true);
	});

	/** pie: tui_render_e2e.rs:703-723. */
	it("trigger_completion_starts_on_new_line_while_readline_prompt_is_idle", async () => {
		const tui = new (await loadTui()).Tui();
		const out = new CaptureSink();

		// pie: tui_render_e2e.rs:708-716
		tui.renderHarnessEvent(
			{
				type: "trigger_completed",
				traceId: "trace-idle-result",
				summary: "hello from trigger",
				costUsd: undefined,
				details: null,
			},
			out,
		);

		const plain = stripAnsi(out.asString());
		// pie: tui_render_e2e.rs:718-722. With nothing open, `begin_async_status_line` still emits a
		// leading newline so the line never lands on the idle readline prompt.
		expect(
			plain.startsWith("\n[trigger completed] trace=trace-idle-result hello from trigger"),
			JSON.stringify(plain),
		).toBe(true);
	});

	/** pie: tui_render_e2e.rs:725-752. */
	it("trigger_completion_renders_full_summary_without_preview_truncation", async () => {
		const tui = new (await loadTui()).Tui();
		const out = new CaptureSink();
		// pie: tui_render_e2e.rs:729-732
		const summary = Array.from({ length: 30 }, (_, i) => `trigger output line ${i}`).join("\n");

		tui.renderHarnessEvent(
			{ type: "trigger_completed", traceId: "trace-long-result", summary, costUsd: undefined, details: null },
			out,
		);

		const plain = stripAnsi(out.asString());
		// pie: tui_render_e2e.rs:744-751
		expect(plain, plain).toContain("trigger output line 0");
		expect(plain, plain).toContain("trigger output line 29");
		expect(
			!plain.includes("…"),
			`trigger completion is the only result surface and should not be preview-truncated:\n${plain}`,
		).toBe(true);
		expect(plain.endsWith(`${summary}\n`), JSON.stringify(plain)).toBe(true);
	});

	/** pie: tui_render_e2e.rs:754-772. */
	it("trigger_failure_renders_live_error_line", async () => {
		const tui = new (await loadTui()).Tui();
		const out = new CaptureSink();

		// pie: tui_render_e2e.rs:759-765
		tui.renderHarnessEvent({ type: "trigger_failed", traceId: "trace-failed", reason: "tool denied" }, out);

		const plain = stripAnsi(out.asString());
		// pie: tui_render_e2e.rs:767-771
		expect(plain, plain).toContain("[trigger failed] trace=trace-failed tool denied");
	});

	/**
	 * pie: tui_render_e2e.rs:774-800. The quiet-dynamic-trace contract: a `local:dynamic` /
	 * "dynamic periodic check" execution-start registers the trace as quiet and prints NOTHING, and a
	 * subsequent completion whose summary matches `is_no_match_dynamic_summary` (tui.rs:375-386) is
	 * also swallowed. Requires state to persist between the two `renderHarnessEvent` calls.
	 */
	it("dynamic_poll_no_match_stays_quiet", async () => {
		const tui = new (await loadTui()).Tui();
		const out = new CaptureSink();

		// pie: tui_render_e2e.rs:779-796
		tui.renderHarnessEvent(
			{
				type: "trigger_execution_started",
				traceId: "trace-dynamic-check",
				sourceLabel: "local:dynamic",
				eventLabel: "dynamic periodic check",
				promptPreview: "A trigger check event arrived.",
			},
			out,
		);
		tui.renderHarnessEvent(
			{
				type: "trigger_completed",
				traceId: "trace-dynamic-check",
				summary: "no dynamic trigger rule matched",
				costUsd: undefined,
				details: null,
			},
			out,
		);

		// pie: tui_render_e2e.rs:798-799. Nothing at all may be emitted.
		expect(stripAnsi(out.asString())).toBe("");
	});

	/** pie: tui_render_e2e.rs:802-828. Same, via the "no matching rule found" phrasing variant. */
	it("dynamic_poll_no_match_variant_stays_quiet", async () => {
		const tui = new (await loadTui()).Tui();
		const out = new CaptureSink();

		// pie: tui_render_e2e.rs:807-824
		tui.renderHarnessEvent(
			{
				type: "trigger_execution_started",
				traceId: "trace-chrome-check",
				sourceLabel: "local:dynamic",
				eventLabel: "dynamic periodic check",
				promptPreview: "Check Chrome Tab Job",
			},
			out,
		);
		tui.renderHarnessEvent(
			{
				type: "trigger_completed",
				traceId: "trace-chrome-check",
				summary: "Checked Chrome tabs; no matching rule found.",
				costUsd: undefined,
				details: null,
			},
			out,
		);

		// pie: tui_render_e2e.rs:826-827
		expect(stripAnsi(out.asString())).toBe("");
	});

	/** pie: tui_render_e2e.rs:830-860. A quiet trace that DID do work must still render. */
	it("dynamic_poll_matched_result_still_renders", async () => {
		const tui = new (await loadTui()).Tui();
		const out = new CaptureSink();

		// pie: tui_render_e2e.rs:835-852
		tui.renderHarnessEvent(
			{
				type: "trigger_execution_started",
				traceId: "trace-chrome-match",
				sourceLabel: "local:dynamic",
				eventLabel: "dynamic periodic check",
				promptPreview: "Check Chrome Tab Job",
			},
			out,
		);
		tui.renderHarnessEvent(
			{
				type: "trigger_completed",
				traceId: "trace-chrome-match",
				summary: "matched dyn-123 and archived the Chrome tab",
				costUsd: undefined,
				details: null,
			},
			out,
		);

		const plain = stripAnsi(out.asString());
		// pie: tui_render_e2e.rs:854-859
		expect(plain, plain).toContain("[trigger completed] trace=trace-chrome-match matched dyn-123");
		expect(plain, plain).toContain("archived the Chrome tab");
	});
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * PHASE 14 ACCEPTANCE — `coding-agent/tui` (manifest.tsv:199) — DELIVERED
 *
 * The 19 tests above reduce to the following deliverables. Line refs are oracle
 * `crates/coding-agent/src/tui.rs` unless noted. All of A–E landed in
 * `packages/coding-agent/src/tui.ts`; the paragraphs below are kept verbatim as the acceptance
 * record, so their present-tense "today's `interactive-mode.ts` …" framing describes the state at
 * the time the list was written, not the state now.
 *
 * A. A line-stream renderer with an injectable output sink and per-instance, call-spanning state
 *    (`RenderState`, tui.rs:20-30: `text_open`, `trim_text_prefix`, `thinking_open`,
 *    `quiet_dynamic_trigger_traces`). Today's `interactive-mode.ts` repaints a component tree and
 *    exposes no such surface; `print-mode.ts` emits JSON or final text only.
 *
 * B. Agent-event rendering (tui.rs:142-211):
 *    B1. `agent_start` resets the turn: `text_open=false`, `trim_text_prefix=true`,
 *        `thinking_open=false`.
 *    B2. First `thinking_delta` opens with `"\n" + DARK_GREY + ITALIC + "[thinking] "`, then raw
 *        deltas. Exactly ONE `[thinking]` label per block — no re-labelling per delta.
 *    B3. `text_delta` first closes any open thinking block with `RESET + "\n"`, then writes the
 *        delta. While `trim_text_prefix` holds, ASCII whitespace is stripped from the delta's
 *        START; the flag only clears once a delta is non-empty AFTER trimming — so an empty delta,
 *        or a delta that is pure whitespace, must NOT arm the un-trimmed path
 *        (three tests pin this: single space, empty-then-space, whitespace split across 4 deltas).
 *    B4. `tool_execution_start` closes thinking THEN text, then writes
 *        `YELLOW + "⚙ " + tool_name + preview(args) + RESET + "\n"` — exactly once per call.
 *        `toolcall_start` message updates render NOTHING (tui.rs:182, the de-duplication fix).
 *    B5. `tool_execution_end` writes each text line of the result as `color + "    " + line + RESET`
 *        + newline, `color` = RED when `isError` else DARK_GREEN. Non-text blocks are skipped.
 *    B6. `agent_end` closes whatever block is open so the next REPL prompt isn't glued on.
 *    B7. `preview(args)` (tui.rs:412-436): first 3 object entries as `k=v`, strings quoted with
 *        newlines escaped to a literal backslash-n, every value truncated to 60 CHARS with a `…`
 *        suffix, plus a trailing `…` entry when the object has >3 keys; wrapped in `(...)`;
 *        non-objects -> "". Truncation MUST be codepoint-based (tui.rs:441-448 `truncate_chars`) —
 *        the whole point of `long_chinese_tool_arg_does_not_panic`.
 *
 * C. Harness/trigger rendering (tui.rs:213-326). Every one of these lines is preceded by
 *    `begin_async_status_line` (tui.rs:354-358): close the open block, or emit a bare newline if
 *    nothing was open — so an async status line never lands on the idle readline prompt.
 *    C1. `trigger_handling_start` -> `[trigger fired] trace=<24> source=<48> kind=<local|mcp> event=<64>`
 *        (DARK_GREY), each field char-truncated to the width shown.
 *    C2. `trigger_handled` -> `[trigger <label>] trace=<24>` for deduped / cycle-suppressed /
 *        permission-denied / needs-approval ONLY; `accepted` and every transitional state render
 *        nothing. Labels: tui.rs:361-373. Color RED for permission-denied/needs-approval, else
 *        DARK_GREY (tui.rs:388-394). It also clears the trace from the quiet set.
 *    C3. `trigger_completed` -> `[trigger completed] trace=<24> <summary>` (DARK_GREEN), summary
 *        defaulting to "completed" when absent. The summary is NOT truncated and NOT ellipsised —
 *        it is the only result surface (two separate tests assert this, at 30 and 40 lines).
 *    C4. `trigger_failed` -> `[trigger failed] trace=<24> <reason truncated to 180 chars>` (RED).
 *    C5. `trigger_execution_started` -> `[trigger running] trace=<24> <prompt_preview to 120>`.
 *    C6. QUIET DYNAMIC TRACES: `trigger_handling_start` and `trigger_execution_started` whose
 *        `sourceLabel === "local:dynamic"` AND `eventLabel === "dynamic periodic check"` render
 *        NOTHING and instead record the trace id. A later `trigger_completed` for a recorded trace
 *        renders nothing IFF the summary matches `is_no_match_dynamic_summary` (tui.rs:375-386:
 *        lowercased+trimmed, then any of "no dynamic trigger rule matched", "no trigger rule
 *        matched", "no dynamic rule matched", "no matching trigger", "no matching rule", "no match
 *        found", "nothing matched", "not matched"). A matched/worked result renders normally. The
 *        trace id is consumed either way.
 *
 * D. ANSI constants must be the literal SGR strings (tui.rs:405-410), because `stripAnsi` in this
 *    file only removes CSI sequences: RESET `\x1b[0m`, ITALIC `\x1b[3m`, YELLOW `\x1b[33m`,
 *    RED `\x1b[31m`, DARK_GREY `\x1b[90m`, DARK_GREEN `\x1b[32;2m`.
 *
 * E. Out of scope for these 19 tests but part of the same oracle unit, so worth porting together:
 *    `banner` (tui.rs:47-73), `system_line` / `error_line` (tui.rs:86-98), and `render_persisted`
 *    (tui.rs:452-523, the `--resume` transcript redisplay, including the `  ⤷ <tool> →` header and
 *    `<image {mime_type}>` placeholder). `user_prompt_marker` (tui.rs:78-84) is already dead in
 *    oracle ("rustyline now renders the prompt directly") — note that test 1 asserts the marker
 *    `pi>` must NOT appear in rendered output.
 *
 * ── E, AS DELIVERED ─────────────────────────────────────────────────────────────────────────
 * All of E is ported (`banner`, `userPromptMarker`, `systemLine`, `errorLine`, `renderPersisted`).
 * Two facts that group E's summary above does not mention and that any future test of these
 * surfaces must account for:
 *  1. They go through crossterm, not the hand-rolled constants of D. crossterm 0.28.1 emits
 *     256-colour `CSI 38;5;<n> m` foregrounds, so replay grey is `\x1b[38;5;8m` while the streaming
 *     renderer's DARK_GREY is `\x1b[90m` — oracle's own asymmetry, preserved.
 *  2. `render_persisted`'s tool-call line double-wraps: oracle tui.rs:493-497 formats `⚙ {}({})`
 *     around `preview(...)`, which already returns a parenthesized string (tui.rs:432), so replay
 *     renders `⚙ read((path="/tmp/x.rs"))`. Reproduced bug-for-bug; proposed for a §5 ledger id.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */
