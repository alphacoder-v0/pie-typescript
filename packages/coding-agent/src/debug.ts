/**
 * UI-facing debug helpers.
 *
 * Port of oracle `crates/coding-agent/src/debug.rs` (pie @0a120dfd).
 *
 * {@link wrapStreamFn} decorates a `StreamFn` so every LLM call narrates itself into the
 * conversation feed: a `start` line before the request, a `context` line showing the last
 * message, a `tool-call` line per emitted tool call, and a terminal `done`/`error`/`closed` line.
 * Every payload passes through {@link debugPreview} first — redacted, then bounded to
 * {@link DEBUG_PREVIEW_MAX_LINES} lines / {@link DEBUG_PREVIEW_MAX_CHARS} characters.
 *
 * Line text is user-visible, so RULEBOOK §2.1 requires it to align with oracle character for
 * character. Two consequences worth flagging, both handled below:
 *
 * - Rust `{:?}` on a fieldless enum prints the *variant identifier* (`Stop`, `ToolUse`,
 *   `Xhigh`), whereas the pi skeleton's counterparts are lowercase/camelCase string unions
 *   (`"stop"`, `"toolUse"`, `"xhigh"`). The `*_DEBUG` tables below restore oracle's spelling.
 * - `str::len()` is a **byte** count, not a character count — so `system_chars` (which oracle
 *   names "chars" but computes in bytes, debug.rs:97) uses `Buffer.byteLength`, while
 *   `bounded_preview`'s budget really is in `chars()` (Unicode scalars) and uses code-point
 *   iteration.
 */

import { detach, type StreamFn } from "@pie/agent-core";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type ImageContent,
	type Model,
	type Context as PiContext,
	type Message as PiMessage,
	type SimpleStreamOptions,
	type StopReason,
	type TextContent,
	type ThinkingLevel,
	type ToolCall,
} from "@pie/ai";
import { redact } from "./bug-report.ts";

/** oracle debug.rs:18. */
export const DEBUG_PREVIEW_MAX_CHARS = 4_000;
/** oracle debug.rs:19. */
export const DEBUG_PREVIEW_MAX_LINES = 80;

/* -----------------------------------------------------------------------------------------
 * crate::ui::feed — packages/coding-agent/src/ui/feed.ts.
 *
 * `debug.rs` only ever constructs `FeedUpdate::Plain { text, level }` with `Level::System`
 * (debug.rs:83-88), so this module keeps the narrow single-variant view it always had — it is
 * structurally the `"plain"` arm of `ui/feed.ts`'s real union, so a value built here drops straight
 * into that channel. The wire names come from oracle's serde attributes:
 * `#[serde(tag = "kind", rename_all = "snake_case")]` on `FeedUpdate` (feed.rs:41-42) and
 * `#[serde(rename_all = "snake_case")]` on `Level` (feed.rs:20-21).
 * --------------------------------------------------------------------------------------- */

/** oracle `crates/coding-agent/src/ui/feed.rs:22-36` (`enum Level`) — unit-only enum → string union. */
export type FeedLevel = "output" | "system" | "error" | "note" | "header" | "qr";

/** oracle `crates/coding-agent/src/ui/feed.rs:43-71` (`enum FeedUpdate`), `Plain` variant only. */
export interface FeedUpdate {
	kind: "plain";
	text: string;
	level: FeedLevel;
}

/**
 * pie: debug.rs:22 (`feed_tx: mpsc::UnboundedSender<FeedUpdate>`) — the *send* half only.
 *
 * Declared structurally so `main.ts` can hand this the one real UI channel, an
 * `AsyncQueue<ui/feed.ts FeedUpdate>`: `AsyncQueue<T>` is invariant in `T` (its `next()` puts `T` in
 * the return position), so the wider queue is not an `AsyncQueue<FeedUpdate>` even though every
 * value this module pushes is a valid element of it. Narrowing the parameter to the sink half is
 * what makes the two views meet — and it is closer to oracle, which passes a `Sender`, not a queue.
 */
export interface FeedSink {
	/** pie: `let _ = tx.send(update)` — the closed-channel error is discarded on both sides. */
	push(update: FeedUpdate): boolean;
}

/* -----------------------------------------------------------------------------------------
 * Rust `{:?}` on fieldless enums (RULEBOOK §2.1: user-visible text aligns with oracle verbatim).
 * --------------------------------------------------------------------------------------- */

/** `pie_ai::DoneReason` (oracle `crates/ai/src/types.rs:525-531`). */
const DONE_REASON_DEBUG: Record<"stop" | "length" | "toolUse", string> = {
	stop: "Stop",
	length: "Length",
	toolUse: "ToolUse",
};

/** `pie_ai::ErrorReason` (oracle `crates/ai/src/types.rs:533-536`). */
const ERROR_REASON_DEBUG: Record<"aborted" | "error", string> = { aborted: "Aborted", error: "Error" };

/** `pie_ai::StopReason` (oracle `crates/ai/src/types.rs:326-332`). */
const STOP_REASON_DEBUG: Record<StopReason, string> = {
	stop: "Stop",
	length: "Length",
	toolUse: "ToolUse",
	error: "Error",
	aborted: "Aborted",
};

/** `pie_ai::ThinkingLevel` (oracle `crates/ai/src/types.rs:89-95`). */
const THINKING_LEVEL_DEBUG: Record<ThinkingLevel, string> = {
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Xhigh",
};

/* -----------------------------------------------------------------------------------------
 * wrap_stream_fn
 * --------------------------------------------------------------------------------------- */

/**
 * oracle debug.rs:21-81 (`wrap_stream_fn`).
 *
 * `tx: UnboundedSender<FeedUpdate>` → {@link FeedSink} (RULEBOOK §2.2's `mpsc::unbounded` row maps
 * the channel to `AsyncQueue`; this parameter takes only its *sender* half, which is what oracle
 * passes and what lets `main.ts` supply the one shared `ui/feed.ts` queue — see {@link FeedSink}).
 */
export function wrapStreamFn(base: StreamFn, tx: FeedSink): StreamFn {
	// oracle debug.rs:22 — `Arc<AtomicU64::new(1)>`; `fetch_add` returns the value *before* the
	// add, so the first call is #1.
	let seq = 1;

	return (model: Model<Api>, context: PiContext, options?: SimpleStreamOptions) => {
		const callId = seq++;
		// oracle debug.rs:25-29.
		emitFeed(tx, startLine(callId, model, context, options));
		const ctxLine = contextLine(callId, context);
		if (ctxLine !== undefined) emitFeed(tx, ctxLine);

		// oracle debug.rs:30-31. `base` is invoked synchronously, exactly as in Rust; only the
		// pump below is detached. `StreamFn` in this skeleton may also return a promise, which
		// oracle's sync `Fn` cannot — awaited inside the pump.
		const innerResult = base(model, context, options);
		// oracle debug.rs:31 — `AssistantMessageEventStream::new()` hands back a (stream, sender)
		// pair; `@pie/ai`'s stream object is both halves at once (`push`/`end` are on it).
		const stream = createAssistantMessageEventStream();
		// oracle debug.rs:33 — `Instant::now()` → `performance.now()` (RULEBOOK §2.3).
		const startedAt = performance.now();

		// oracle debug.rs:34-77 — detached `tokio::spawn` (RULEBOOK §2.2 → the single `detach()`
		// helper; never inline-awaited, which would serialise the stream).
		detach(
			async () => {
				let sawTerminal = false;
				try {
					const inner = await innerResult;
					for await (const event of inner) {
						switch (event.type) {
							// oracle debug.rs:38-40.
							case "toolcall_end":
								emitFeed(tx, toolCallLine(callId, event.toolCall));
								break;
							// oracle debug.rs:41-44.
							case "done":
								sawTerminal = true;
								emitFeed(tx, doneLine(callId, event.reason, event.message, startedAt));
								break;
							// oracle debug.rs:45-60.
							case "error": {
								sawTerminal = true;
								const message =
									event.error.errorMessage !== undefined
										? debugPreview(event.error.errorMessage)
										: "unknown error";
								emitFeed(
									tx,
									`[debug llm #${callId} error] reason=${ERROR_REASON_DEBUG[event.reason]} elapsed=${elapsedMs(startedAt)} message="${message}"`,
								);
								break;
							}
							default:
								break;
						}
						// oracle debug.rs:63.
						stream.push(event);
						// TODO(port): oracle debug.rs:64-66 breaks out of the pump when
						// `sender.is_closed()` — i.e. the consumer dropped the receiver. `@pie/ai`'s
						// `EventStream` exposes no `isClosed` equivalent, and a `push` after the stream
						// finished is already a no-op there, so this port keeps draining `inner`
						// instead. Nothing downstream observes the difference; it is wasted work only.
					}
					// oracle debug.rs:68-76.
					if (!sawTerminal) {
						emitFeed(
							tx,
							`[debug llm #${callId} closed] elapsed=${elapsedMs(startedAt)} stream ended without terminal event`,
						);
					}
				} finally {
					// oracle debug.rs:77 — the spawned task owns `sender` and drops it on return,
					// which closes the channel so the consumer's stream iteration ends. TS has no
					// `Drop`, so the close is explicit; without it a provider stream that finished
					// without a terminal event would leave every consumer awaiting forever. After a
					// terminal event this is a no-op: `push` already marked the stream done.
					stream.end();
				}
			},
			(error) => {
				// Defensive only, and NOT an oracle string: oracle's `StreamFn` returns a plain
				// `AssistantMessageEventStream` by value, so "the pump itself failed" is
				// unrepresentable there. It becomes representable here because this skeleton's
				// `StreamFn` may return a promise. Reachable only when `base` violates its own
				// documented contract ("must not throw or return a rejected promise"); RULEBOOK
				// §2.4 forbids swallowing it silently, and the feed is the only sink this wrapper
				// owns.
				emitFeed(tx, `[debug llm #${callId} pump failed] ${debugPreview(errorText(error))}`);
			},
		);

		// oracle debug.rs:79.
		return stream;
	};
}

/** oracle debug.rs:83-88 (`emit`) — always `Level::System`. */
function emitFeed(tx: FeedSink, text: string): void {
	// Rust discards the send result (`let _ = tx.send(...)`); `AsyncQueue.push` returns false on a
	// closed queue, discarded here for the same reason.
	tx.push({ kind: "plain", text, level: "system" });
}

/** oracle debug.rs:90-117 (`start_line`). */
export function startLine(
	callId: number,
	model: Model<Api>,
	context: PiContext,
	options?: SimpleStreamOptions,
): string {
	// oracle debug.rs:96.
	const toolCount = context.tools?.length ?? 0;
	// oracle debug.rs:97 — `str::len` is the UTF-8 **byte** length despite the field's name.
	const systemChars = context.systemPrompt === undefined ? 0 : Buffer.byteLength(context.systemPrompt, "utf8");
	// oracle debug.rs:98-101.
	const reasoning = options?.reasoning === undefined ? "off" : THINKING_LEVEL_DEBUG[options.reasoning];
	// oracle debug.rs:102-105 — `options.base.session_id`.
	const session = options?.sessionId ?? "-";
	// oracle debug.rs:106-116. `model.provider.0` / `model.api.0` unwrap Rust newtypes; the
	// skeleton's `Provider`/`Api` are already plain strings.
	return `[debug llm #${callId} start] provider=${model.provider} api=${model.api} model=${model.id} messages=${context.messages.length} tools=${toolCount} system_chars=${systemChars} reasoning=${reasoning} session=${session}`;
}

/** oracle debug.rs:119-126 (`context_line`) — `None` when there is no message to show. */
export function contextLine(callId: number, context: PiContext): string | undefined {
	const last = context.messages.at(-1);
	if (last === undefined) return undefined;
	return `[debug llm #${callId} context] last_${roleLabel(last)}:\n${messageLog(last)}`;
}

/** oracle debug.rs:128-137 (`tool_call_line`). */
export function toolCallLine(callId: number, toolCall: ToolCall): string {
	// oracle debug.rs:129-130 — `serde_json::to_string_pretty` (2-space indent); the fallback arm
	// is unreachable for a `Map<String, Value>`, which always serialises.
	const args = JSON.stringify(toolCall.arguments, null, 2);
	return `[debug llm #${callId} tool-call] id=${toolCall.id} name=${toolCall.name} args=\n${debugPreview(args)}`;
}

/** oracle debug.rs:139-164 (`done_line`). */
export function doneLine(
	callId: number,
	reason: "stop" | "length" | "toolUse",
	message: AssistantMessage,
	startedAt: number,
): string {
	const usage = message.usage;
	// oracle debug.rs:146-150.
	const responseId = message.responseId ?? "-";
	// oracle debug.rs:151-163. `{:.6}` on the cost → six fixed decimals.
	return (
		`[debug llm #${callId} done] reason=${DONE_REASON_DEBUG[reason]} stop=${STOP_REASON_DEBUG[message.stopReason]}` +
		` elapsed=${elapsedMs(startedAt)} usage=input:${usage.input} output:${usage.output}` +
		` cache_read:${usage.cacheRead} cache_write:${usage.cacheWrite} total:${usage.totalTokens}` +
		` cost:$${usage.cost.total.toFixed(6)} response_id=${responseId} text:\n${debugPreview(assistantLog(message))}`
	);
}

/** oracle debug.rs:166-168 (`elapsed_ms`) — `Duration::as_millis` truncates. */
function elapsedMs(startedAt: number): string {
	return `${Math.trunc(performance.now() - startedAt)}ms`;
}

/** oracle debug.rs:170-176 (`role_label`). */
function roleLabel(message: PiMessage): string {
	switch (message.role) {
		case "user":
			return "user";
		case "assistant":
			return "assistant";
		default:
			return "tool_result";
	}
}

/** oracle debug.rs:178-190 (`message_log`). */
function messageLog(message: PiMessage): string {
	let raw: string;
	switch (message.role) {
		case "user":
			raw = userContentLog(message.content);
			break;
		case "assistant":
			raw = assistantLog(message);
			break;
		default:
			raw = message.content.map(userContentBlockLog).join("\n");
			break;
	}
	return debugPreview(raw);
}

/**
 * oracle debug.rs:192-201 (`user_content_log`) — `UserContent::Text` vs `UserContent::Blocks`
 * becomes the skeleton's `string | (TextContent | ImageContent)[]`.
 */
function userContentLog(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return content.map(userContentBlockLog).join("\n");
}

/** oracle debug.rs:203-208 (`user_content_block_log`). */
function userContentBlockLog(block: TextContent | ImageContent): string {
	return block.type === "text" ? block.text : `[image:${block.mimeType}]`;
}

/** oracle debug.rs:210-224 (`assistant_log`). */
function assistantLog(message: AssistantMessage): string {
	return message.content
		.map((block) => {
			switch (block.type) {
				case "text":
					return block.text;
				case "thinking":
					return block.thinking;
				case "toolCall":
					return `[tool-call:${block.id}:${block.name}]`;
				default:
					// oracle debug.rs:217 — `ContentBlock::Image`. The skeleton's
					// `AssistantMessage.content` union has no image variant, so this arm is
					// unreachable through the type system; kept so a provider that emits one at
					// runtime still renders oracle's text rather than `undefined`.
					return `[image:${(block as ImageContent).mimeType}]`;
			}
		})
		.join("\n");
}

/** oracle debug.rs:226-228 (`debug_preview`) — redact first, then bound. */
export function debugPreview(input: string): string {
	return boundedPreview(redact(input));
}

/**
 * oracle debug.rs:230-279 (`bounded_preview`).
 *
 * The budget is in `chars()` — Unicode scalar values — so the character loop iterates code
 * points (`[...segment]`), not UTF-16 units.
 */
export function boundedPreview(input: string): string {
	let out = "";
	let lines = 0;
	let chars = 0;
	let truncatedForLines = false;
	let truncatedForChars = false;

	for (const segment of splitInclusive(input)) {
		// oracle debug.rs:238-241.
		if (lines >= DEBUG_PREVIEW_MAX_LINES) {
			truncatedForLines = true;
			break;
		}

		// oracle debug.rs:243-253.
		const segmentChars = [...segment];
		let taken = 0;
		while (chars < DEBUG_PREVIEW_MAX_CHARS && taken < segmentChars.length) {
			const ch = segmentChars[taken++];
			out += ch;
			chars += 1;
			if (ch === "\n") lines += 1;
		}

		// oracle debug.rs:255-258 — anything left in this segment means the char budget ran out.
		if (taken < segmentChars.length) {
			truncatedForChars = true;
			break;
		}

		// oracle debug.rs:260-262.
		if (!segment.endsWith("\n")) lines += 1;
	}

	// oracle debug.rs:265-267.
	if (chars >= DEBUG_PREVIEW_MAX_CHARS && [...input].length > DEBUG_PREVIEW_MAX_CHARS) {
		truncatedForChars = true;
	}

	// oracle debug.rs:269-276.
	if (truncatedForLines || truncatedForChars) {
		if (!out.endsWith("\n")) out += "\n";
		out += `[debug preview truncated: max ${DEBUG_PREVIEW_MAX_LINES} lines / ${DEBUG_PREVIEW_MAX_CHARS} chars]`;
	}

	return out;
}

/**
 * Rust `str::split_inclusive('\n')` — segments keep their trailing newline, an empty input yields
 * *no* segments (not one empty segment, which is what `String.prototype.split` would give), and
 * a trailing newline does not produce an extra empty tail.
 */
function splitInclusive(input: string): string[] {
	if (input === "") return [];
	const segments: string[] = [];
	let start = 0;
	for (let i = 0; i < input.length; i++) {
		if (input[i] === "\n") {
			segments.push(input.slice(start, i + 1));
			start = i + 1;
		}
	}
	if (start < input.length) segments.push(input.slice(start));
	return segments;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
