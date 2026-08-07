/**
 * Conversation-feed model for the full-screen TUI.
 *
 * Port of oracle `crates/coding-agent/src/ui/feed.rs` (pie @0a120dfd). Oracle module doc: "The feed
 * is the scrolling region above the pinned input box. It is an ordered list of [`Block`]s — user
 * prompts, assistant text, thinking, tool calls/results, and assorted status lines. Streaming
 * [`FeedUpdate`]s mutate it in place (text/thinking deltas append to the currently-open block;
 * tool/turn boundaries close it), mirroring the transition state machine the old line-stream
 * renderer in `tui.rs` used, but producing a structured model we can re-wrap and scroll instead of
 * raw stdout bytes. Rendering is width-aware: [`Feed::lines`] word-wraps every block to the
 * available width and returns ready-to-draw `ratatui` lines, so scroll math operates on real
 * display rows."
 *
 * ── WHAT REPLACES `ratatui` ──────────────────────────────────────────────────────────────────
 * Oracle returns `Vec<Line<'static>>` — ratatui's styled-span rows. There is no ratatui in this
 * workspace and RULEBOOK §1 admits no new dependency for one, so `Feed.lines()` returns
 * {@link FeedLine}: exactly the two things every oracle call site reads off a `Line` — the row text
 * and one `Style` applied to the whole row. Oracle never builds a multi-span line here (every arm
 * is `Line::styled(row, style)` or `Line::raw("")`), so nothing is lost: `ui/web.rs:768`'s
 * `line.spans.map(|s| s.content).collect::<String>()` becomes `line.text`, and the TUI integrator
 * maps {@link FeedStyle} onto whatever terminal writer it uses.
 *
 * ── NAMING CONVENTION IN THIS MODULE ─────────────────────────────────────────────────────────
 * {@link Level}, {@link FeedUpdate}, {@link WebFeedBlock} and {@link TriggerPollStatus} all derive
 * `serde::Serialize` in oracle and the first three of those reach the browser through
 * `WebSnapshot` (`ui/web.rs:59-71`), so their tag values and field names are **wire names** and
 * stay snake_case verbatim (RULEBOOK §2.1: "TS object field names are wire names"). Everything else in this file
 * — the private `Block`, {@link FeedLine}, {@link FeedStyle} — is internal and uses camelCase.
 *
 * ── MUTATION ─────────────────────────────────────────────────────────────────────────────────
 * `Feed` is an explicitly mutable model in oracle (`&mut self` on every method; deltas are
 * `String::push_str` onto the open block). RULEBOOK §0 makes oracle the spec, so this port mutates
 * in place too rather than rebuilding the block list per delta — a copy-per-delta feed would be
 * O(n²) on a long streaming turn.
 */

import type { ImageContent, TextContent } from "@pie/ai";
import { visibleWidth } from "@pie/tui";
import { preview, truncateChars } from "../tui.ts";

/**
 * pie: feed.rs:671-690 (`preview`) and feed.rs:775-782 (`truncate_chars`) are byte-for-byte
 * duplicates of `tui.rs:412-436` / `tui.rs:438-448`, which this repo already ported to
 * `src/tui.ts`. Re-exported here so oracle's `feed::preview` / `feed::truncate_chars` import paths
 * (`ui/mod.rs:333,1555,1727,…`, `ui/listener.rs:16`, `ui/web.rs:373,781,799`) translate to
 * `import { preview, truncateChars } from "./feed.ts"` unchanged.
 */
export { preview, truncateChars };

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Wire types (serde-derived — snake_case is load-bearing)
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * pie: feed.rs:19-37 (`enum Level`, `#[serde(rename_all = "snake_case")]`). Oracle doc: "Visual
 * class for a plain status/output line. Maps to a concrete [`Style`] at render time." Per-variant
 * docs, verbatim:
 * - `output` — "Slash-command stdout and other neutral output."
 * - `system` — "Dim diagnostic line (the old `[system]` style)."
 * - `error`  — "Error line."
 * - `note`   — "Positive status (e.g. a trigger completed)."
 * - `header` — "Banner heading."
 * - `qr`     — "Terminal-only block art (the /web-connect QR code). The TUI renders it; web
 *   surfaces skip it — a browser viewer has already opened the page, and browser line-height
 *   breaks the half-block grid anyway."
 */
export type Level = "output" | "system" | "error" | "note" | "header" | "qr";

/**
 * pie: feed.rs:109-116 (`struct TriggerPollStatus`). Oracle doc: "Bounded, display-only status for
 * periodic trigger checks that should stay visible in the main UI without appending a line to the
 * conversation feed." Serialized into `WebSnapshot::latest_trigger_poll` (`ui/web.rs:66`), so the
 * field names are wire names.
 */
export interface TriggerPollStatus {
	readonly checked_at: string;
	readonly trace_id: string;
	readonly source_label: string;
	readonly event_label: string;
	readonly summary: string;
}

/**
 * pie: feed.rs:39-73 (`enum FeedUpdate`, `#[serde(tag = "kind", rename_all = "snake_case")]`).
 * Oracle doc: "A message sent from the agent/harness listeners (or the console sink) into the UI
 * loop, where it is applied to the [`Feed`]. Crosses thread boundaries, so every field is owned."
 *
 * TODO(port): oracle's `TextDelta(String)` / `ThinkingDelta(String)` are newtype variants holding a
 * bare `String` under an *internally tagged* representation — `serde_json` errors at runtime on
 * those ("cannot serialize tagged newtype variant containing a string"). No oracle site ever
 * serializes a `FeedUpdate` (only `WebFeedBlock` / `TriggerPollStatus` reach `WebSnapshot`), so the
 * derive is latent and there is no wire name to be faithful to; `delta` is this port's choice.
 * `TriggerPollStatus(TriggerPollStatus)` IS representable (newtype-of-struct flattens), so that
 * variant is modelled flattened, exactly as serde would emit it.
 */
export type FeedUpdate =
	| { readonly kind: "turn_start" }
	| { readonly kind: "turn_end" }
	| { readonly kind: "text_delta"; readonly delta: string }
	| { readonly kind: "thinking_delta"; readonly delta: string }
	| { readonly kind: "tool_start"; readonly name: string; readonly args: string }
	| {
			readonly kind: "tool_progress";
			readonly tool_call_id: string;
			readonly lines: string[];
			readonly is_error: boolean;
	  }
	| {
			readonly kind: "tool_end";
			readonly tool_call_id: string;
			readonly lines: string[];
			readonly is_error: boolean;
	  }
	| { readonly kind: "plain"; readonly text: string; readonly level: Level }
	| ({ readonly kind: "trigger_poll_status" } & TriggerPollStatus)
	/**
	 * pie: feed.rs:67-72 — "The skill catalog was hot-reloaded. Display-only: appends no feed
	 * block, but the update itself drives a TUI repaint / web snapshot republish so sidebars
	 * showing the catalog never go stale."
	 */
	| { readonly kind: "skills_reloaded"; readonly total: number };

/** pie: feed.rs:75-105 (`enum WebFeedBlock`, `#[serde(tag = "kind", rename_all = "snake_case")]`). */
export type WebFeedBlock =
	| { readonly kind: "user"; readonly text: string; readonly timestamp?: string }
	| { readonly kind: "assistant"; readonly text: string; readonly timestamp?: string }
	| { readonly kind: "thinking"; readonly text: string; readonly timestamp?: string }
	| { readonly kind: "tool"; readonly name: string; readonly args: string; readonly timestamp?: string }
	| {
			readonly kind: "tool_result";
			readonly lines: string[];
			readonly is_error: boolean;
			readonly timestamp?: string;
	  }
	| { readonly kind: "plain"; readonly text: string; readonly level: Level; readonly timestamp?: string };

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Rendered rows — the `ratatui::text::Line` stand-in
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/** The ratatui `Color`s this module actually names (feed.rs:449-453, 542-546, 568-579). */
export type FeedColor = "cyan" | "darkGray" | "yellow" | "red" | "green" | "magenta";

/** A ratatui `Style` reduced to the properties feed.rs sets. Absent field = ratatui default. */
export interface FeedStyle {
	readonly fg?: FeedColor;
	/** ratatui `Modifier::BOLD`. */
	readonly bold?: boolean;
	/** ratatui `Modifier::ITALIC`. */
	readonly italic?: boolean;
}

/** One rendered row: oracle's single-span `Line<'static>`. */
export interface FeedLine {
	readonly text: string;
	readonly style: FeedStyle;
}

/** ratatui `Style::default()` / `Line::raw(..)`. */
const DEFAULT_STYLE: FeedStyle = {};
/** pie: feed.rs:542. */
const USER_STYLE: FeedStyle = { fg: "cyan", bold: true };
/** pie: feed.rs:543-545. */
const THINKING_STYLE: FeedStyle = { fg: "darkGray", italic: true };
/** pie: feed.rs:546. */
const TOOL_STYLE: FeedStyle = { fg: "yellow" };

/** pie: feed.rs:547. */
export const TOOL_OUTPUT_HEAD_LINES = 20;
/** pie: feed.rs:548. */
export const TOOL_OUTPUT_TAIL_LINES = 4;
/** pie: feed.rs:549. */
export const TOOL_OUTPUT_ERROR_HEAD_LINES = 40;
/** pie: feed.rs:550. */
export const TOOL_OUTPUT_ERROR_TAIL_LINES = 8;
/** pie: feed.rs:551. */
export const TOOL_OUTPUT_MAX_LINE_CHARS = 200;
/** pie: feed.rs:552. */
export const TOOL_OUTPUT_ERROR_MAX_LINE_CHARS = 240;

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Rust primitives with no JS equivalent
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * `unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0)` (feed.rs:646). Three regimes:
 *  - Rust returns `None` for C0/DEL/C1 control characters — including `\t` — and feed.rs folds that
 *    to 0. Handled here first, because `visibleWidth` would score a tab as 3.
 *  - printable ASCII is 1 in both.
 *  - everything else defers to `@pie/tui`'s `visibleWidth`, which scores by East Asian Width (the
 *    same Unicode property `unicode-width` 0.2 uses: W/F → 2, else 1) and returns 0 for combining
 *    marks / default-ignorable code points, matching `unicode-width`'s zero-width class.
 *
 * TODO(port): one residual divergence, unreachable from feed content today — Hangul jamo medial
 * vowels / final consonants (U+1160–U+11FF) are width 0 in `unicode-width` and 1 here.
 */
function charWidth(ch: string): number {
	const cp = ch.codePointAt(0) ?? 0;
	if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) {
		return 0;
	}
	if (cp < 0x7f) {
		return 1;
	}
	return visibleWidth(ch);
}

/** `unicode_width::UnicodeWidthStr::width(s)` (feed.rs:653, 865) — the sum over scalar values. */
export function strWidth(s: string): number {
	let width = 0;
	for (const ch of s) {
		width += charWidth(ch);
	}
	return width;
}

const UTF8_ENCODER = new TextEncoder();

/** Rust `str::len()` — UTF-8 **bytes**, not JS `.length` (UTF-16 units) or code points. */
function utf8Len(s: string): number {
	return UTF8_ENCODER.encode(s).length;
}

/**
 * Rust `str::lines()`: split on `\n`, strip one trailing `\r` per line, and drop the empty final
 * segment produced by a trailing newline. `"".lines()` yields nothing at all.
 *
 * TODO(port): identical to the module-private `rustLines` in `src/tui.ts:145-151`, which does not
 * export it. Deduplicating means touching `tui.ts`, which is frozen for this phase (parity S1);
 * flagged to the orchestrator for a later consolidation into a shared string util.
 */
function rustLines(s: string): string[] {
	const parts = s.split("\n");
	if (parts[parts.length - 1] === "") {
		parts.pop();
	}
	return parts.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/** Rust `char::is_ascii_whitespace`: space, `\t`, `\n`, `\x0c`, `\r`. NOT `\x0b`, NOT Unicode spaces. */
const ASCII_WHITESPACE: ReadonlySet<string> = new Set([" ", "\t", "\n", "\x0c", "\r"]);

/** pie: feed.rs:373 (`delta.trim_start_matches(|c: char| c.is_ascii_whitespace())`). */
function trimStartAsciiWhitespace(s: string): string {
	let i = 0;
	while (i < s.length && ASCII_WHITESPACE.has(s.charAt(i))) {
		i += 1;
	}
	return s.slice(i);
}

/** pie: feed.rs:650 (`rest.trim_start_matches(' ')`) — the literal space only. */
function trimStartSpaces(s: string): string {
	let i = 0;
	while (i < s.length && s.charAt(i) === " ") {
		i += 1;
	}
	return s.slice(i);
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Timestamps — chrono `%Y-%m-%d %H:%M` in the local zone
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

function pad(value: number, width: number): string {
	return String(value).padStart(width, "0");
}

/**
 * chrono's `%Y-%m-%d %H:%M` against a `DateTime<Local>`. `%Y` is zero-padded to at least 4 digits.
 *
 * TODO(port): chrono prefixes years outside 0..=9999 with an explicit sign; `padStart` does not.
 * Unreachable from `Local::now()` or from any session timestamp.
 */
function formatLocalYmdHm(date: Date): string {
	return (
		`${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}` +
		` ${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}`
	);
}

/** pie: feed.rs:589-591 (`current_time_label`) — always `Some`. */
function currentTimeLabel(): string | undefined {
	return formatLocalYmdHm(new Date());
}

/** pie: feed.rs:593-599 (`message_timestamp_label`). Non-positive or unrepresentable → `None`. */
function messageTimestampLabel(timestampMs: number): string | undefined {
	if (timestampMs <= 0) {
		return undefined;
	}
	// Rust: `Utc.timestamp_millis_opt(ms).single()?` — `None` outside the representable range,
	// which JS signals as an Invalid Date.
	const dt = new Date(timestampMs);
	if (Number.isNaN(dt.getTime())) {
		return undefined;
	}
	return formatTimestampLabel(dt, new Date());
}

/**
 * pie: feed.rs:601-604 (`format_timestamp_label`). The `_now` argument is unused in oracle too —
 * a leftover from an earlier relative-time format — and is kept so the ported test mirrors
 * oracle's `timestamp_label_includes_full_date_and_time` call shape exactly.
 */
export function formatTimestampLabel(timestamp: Date, _now?: Date): string {
	return formatLocalYmdHm(timestamp);
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Blocks
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/** pie: feed.rs:118-149 (`enum Block`) — "One renderable unit in the feed." Private in oracle. */
type Block =
	| { kind: "user"; text: string; timestamp?: string }
	| { kind: "assistant"; text: string; timestamp?: string }
	| { kind: "thinking"; text: string; timestamp?: string }
	| { kind: "tool"; name: string; args: string; timestamp?: string }
	| { kind: "toolResult"; toolCallId: string; lines: string[]; isError: boolean; timestamp?: string }
	| { kind: "plain"; text: string; level: Level; timestamp?: string };

/** pie: feed.rs:151-157 (`enum Open`) — "Which streaming block (if any) is currently open for appends." */
type Open = "none" | "text" | "thinking";

/** pie: feed.rs:159-165 (`struct Feed`). */
export class Feed {
	private blocks: Block[] = [];
	private open: Open = "none";
	/**
	 * pie: feed.rs:162-164 — "True until the first non-whitespace character of the current assistant
	 * text block is seen, so we drop the leading whitespace the model often emits after tool calls."
	 */
	private trimText = true;

	/** pie: feed.rs:176-180 (`clear`). */
	clear(): void {
		this.blocks = [];
		this.open = "none";
		this.trimText = true;
	}

	/** pie: feed.rs:182-185 — "Push a user prompt block. Called directly by the loop on submit / on resume replay." */
	pushUser(text: string): void {
		this.pushUserWithTimestamp(text, currentTimeLabel());
	}

	/** pie: feed.rs:187-189 (`push_user_at`). */
	pushUserAt(text: string, timestampMs: number): void {
		this.pushUserWithTimestamp(text, messageTimestampLabel(timestampMs));
	}

	/**
	 * pie: feed.rs:199-203 — "Push a finished assistant text block (used by resume replay where we
	 * have whole turns)." Oracle gates this behind `#[cfg(test)]` (only `ui/mod.rs:2432`'s test
	 * calls it); TS has no such gate, so it is a normal method — do not use it from product code
	 * without a matching oracle site.
	 */
	pushAssistant(text: string): void {
		this.pushAssistantWithTimestamp(text, currentTimeLabel());
	}

	/** pie: feed.rs:205-207 (`push_assistant_at`). */
	pushAssistantAt(text: string, timestampMs: number): void {
		this.pushAssistantWithTimestamp(text, messageTimestampLabel(timestampMs));
	}

	/** pie: feed.rs:221-223 (`push_thinking_at`). */
	pushThinkingAt(text: string, timestampMs: number): void {
		this.pushThinkingWithTimestamp(text, messageTimestampLabel(timestampMs));
	}

	/** pie: feed.rs:233-235 (`push_plain`). */
	pushPlain(text: string, level: Level): void {
		this.pushPlainWithTimestamp(text, level, currentTimeLabel());
	}

	/** pie: feed.rs:237-239 (`push_plain_untimed`). */
	pushPlainUntimed(text: string, level: Level): void {
		this.pushPlainWithTimestamp(text, level, undefined);
	}

	/** pie: feed.rs:255-257 (`push_tool`). */
	pushTool(name: string, args: string): void {
		this.pushToolWithTimestamp(name, args, currentTimeLabel());
	}

	/** pie: feed.rs:259-266 (`push_tool_at`). */
	pushToolAt(name: string, args: string, timestampMs: number): void {
		this.pushToolWithTimestamp(name, args, messageTimestampLabel(timestampMs));
	}

	/** pie: feed.rs:282-289 (`push_tool_result`). */
	pushToolResult(toolCallId: string, lines: string[], isError: boolean): void {
		this.pushToolResultWithTimestamp(toolCallId, lines, isError, currentTimeLabel());
	}

	/** pie: feed.rs:291-304 (`push_tool_result_at`). */
	pushToolResultAt(toolCallId: string, lines: string[], isError: boolean, timestampMs: number): void {
		this.pushToolResultWithTimestamp(toolCallId, lines, isError, messageTimestampLabel(timestampMs));
	}

	/** pie: feed.rs:346-369 (`apply`). */
	apply(update: FeedUpdate): void {
		switch (update.kind) {
			// pie: feed.rs:348-351
			case "turn_start":
			case "turn_end":
				this.open = "none";
				this.trimText = true;
				return;
			// pie: feed.rs:352
			case "text_delta":
				this.textDelta(update.delta);
				return;
			// pie: feed.rs:353
			case "thinking_delta":
				this.thinkingDelta(update.delta);
				return;
			// pie: feed.rs:354
			case "tool_start":
				this.pushTool(update.name, update.args);
				return;
			// pie: feed.rs:355-364 — ToolProgress and ToolEnd share one arm.
			case "tool_progress":
			case "tool_end":
				this.upsertToolResult(update.tool_call_id, update.lines, update.is_error);
				return;
			// pie: feed.rs:365
			case "plain":
				this.pushPlain(update.text, update.level);
				return;
			// pie: feed.rs:366-367 — both are display-only; they append no block.
			case "trigger_poll_status":
			case "skills_reloaded":
				return;
		}
	}

	/**
	 * pie: feed.rs:412-485 (`lines`). Oracle doc: "Render the whole feed to width-wrapped `ratatui`
	 * lines, ready to scroll/draw."
	 */
	lines(width: number): FeedLine[] {
		const w = Math.max(width, 1);
		const out: FeedLine[] = [];
		let previous: Block | undefined;
		for (const block of this.blocks) {
			if (shouldSeparate(previous, block, out.length > 0)) {
				// pie: feed.rs:419 (`Line::raw("")`).
				out.push({ text: "", style: DEFAULT_STYLE });
			}
			switch (block.kind) {
				// pie: feed.rs:422-425
				case "user":
					pushParagraphs(out, block.text, USER_STYLE, displayPrefix(block.timestamp, "you ▸ "), w);
					break;
				// pie: feed.rs:426-429
				case "assistant":
					pushParagraphs(out, block.text, DEFAULT_STYLE, displayPrefix(block.timestamp, "ai ▸ "), w);
					break;
				// pie: feed.rs:430-433
				case "thinking":
					pushParagraphs(out, block.text, THINKING_STYLE, displayPrefix(block.timestamp, "[thinking] "), w);
					break;
				// pie: feed.rs:434-442
				case "tool":
					pushParagraphs(out, `⚙ ${block.name}${block.args}`, TOOL_STYLE, displayPrefix(block.timestamp, ""), w);
					break;
				// pie: feed.rs:443-466
				case "toolResult": {
					const style: FeedStyle = block.isError ? { fg: "red" } : { fg: "green" };
					let first = true;
					for (const line of block.lines) {
						let indented: string;
						if (first) {
							first = false;
							indented = `${displayPrefix(block.timestamp, "")}    ${line}`;
						} else {
							indented = `    ${line}`;
						}
						for (const row of wrapStr(indented, w)) {
							out.push({ text: row, style });
						}
					}
					break;
				}
				// pie: feed.rs:467-480 — note the prefix is `None` (no prefix at all) when the block
				// carries no timestamp, unlike the labelled blocks above.
				case "plain": {
					const prefix = block.timestamp === undefined ? undefined : displayPrefix(block.timestamp, "");
					pushParagraphs(out, block.text, styleForLevel(block.level), prefix, w);
					break;
				}
			}
			previous = block;
		}
		return out;
	}

	/** pie: feed.rs:487-533 (`web_blocks`). */
	webBlocks(): WebFeedBlock[] {
		return this.blocks.map(toWebBlock);
	}

	/** pie: feed.rs:191-197 (`push_user_with_timestamp`). */
	private pushUserWithTimestamp(text: string, timestamp: string | undefined): void {
		this.open = "none";
		this.blocks.push({ kind: "user", text, timestamp });
	}

	/** pie: feed.rs:209-219 (`push_assistant_with_timestamp`). */
	private pushAssistantWithTimestamp(text: string, timestamp: string | undefined): void {
		this.open = "none";
		this.blocks.push({ kind: "assistant", text, timestamp });
	}

	/** pie: feed.rs:225-231 (`push_thinking_with_timestamp`). */
	private pushThinkingWithTimestamp(text: string, timestamp: string | undefined): void {
		this.open = "none";
		this.blocks.push({ kind: "thinking", text, timestamp });
	}

	/** pie: feed.rs:241-253 (`push_plain_with_timestamp`). */
	private pushPlainWithTimestamp(text: string, level: Level, timestamp: string | undefined): void {
		this.open = "none";
		this.blocks.push({ kind: "plain", text, level, timestamp });
	}

	/** pie: feed.rs:268-280 (`push_tool_with_timestamp`). */
	private pushToolWithTimestamp(name: string, args: string, timestamp: string | undefined): void {
		this.open = "none";
		this.blocks.push({ kind: "tool", name, args, timestamp });
	}

	/** pie: feed.rs:306-320 (`push_tool_result_with_timestamp`). */
	private pushToolResultWithTimestamp(
		toolCallId: string,
		lines: string[],
		isError: boolean,
		timestamp: string | undefined,
	): void {
		this.open = "none";
		this.blocks.push({ kind: "toolResult", toolCallId, lines, isError, timestamp });
	}

	/**
	 * pie: feed.rs:322-344 (`upsert_tool_result`). Searches from the END (`iter_mut().rev()`), so a
	 * repeated tool-call id updates the most recent block; a miss falls through to a fresh push. The
	 * timestamp is refreshed to "now" on every update, not preserved from the original progress line.
	 */
	private upsertToolResult(toolCallId: string, lines: string[], isError: boolean): void {
		this.open = "none";
		for (let i = this.blocks.length - 1; i >= 0; i -= 1) {
			const block = this.blocks[i];
			if (block?.kind === "toolResult" && block.toolCallId === toolCallId) {
				block.lines = lines;
				block.isError = isError;
				block.timestamp = currentTimeLabel();
				return;
			}
		}
		this.pushToolResult(toolCallId, lines, isError);
	}

	/** pie: feed.rs:371-394 (`text_delta`). */
	private textDelta(rawDelta: string): void {
		let delta = rawDelta;
		if (this.trimText) {
			const trimmed = trimStartAsciiWhitespace(rawDelta);
			if (trimmed !== "") {
				this.trimText = false;
			}
			delta = trimmed;
		}
		if (delta === "") {
			return;
		}
		if (this.open !== "text") {
			this.blocks.push({ kind: "assistant", text: "", timestamp: currentTimeLabel() });
			this.open = "text";
		}
		// pie: feed.rs:391-393 — appends only if the LAST block is an assistant block.
		const last = this.blocks[this.blocks.length - 1];
		if (last?.kind === "assistant") {
			last.text += delta;
		}
	}

	/**
	 * pie: feed.rs:396-410 (`thinking_delta`). Note the guard shape vs {@link textDelta}: oracle
	 * bails on an empty delta only when no thinking block is open (`delta.is_empty() && self.open !=
	 * Open::Thinking`), where `text_delta` bails on an empty delta unconditionally. With a thinking
	 * block already open the empty delta falls through and appends nothing, so the two agree
	 * observationally — but the condition is transcribed as written, not simplified.
	 */
	private thinkingDelta(delta: string): void {
		if (delta === "" && this.open !== "thinking") {
			return;
		}
		if (this.open !== "thinking") {
			this.blocks.push({ kind: "thinking", text: "", timestamp: currentTimeLabel() });
			this.open = "thinking";
		}
		const last = this.blocks[this.blocks.length - 1];
		if (last?.kind === "thinking") {
			last.text += delta;
		}
	}
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Rendering helpers
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * pie: feed.rs:490-531 — the per-block arm of `web_blocks`. Split out of the `.map()` callback so
 * the switch's exhaustiveness is visible to the linter as well as to `tsc`.
 */
function toWebBlock(block: Block): WebFeedBlock {
	switch (block.kind) {
		case "user":
			return { kind: "user", text: block.text, timestamp: block.timestamp };
		case "assistant":
			return { kind: "assistant", text: block.text, timestamp: block.timestamp };
		case "thinking":
			return { kind: "thinking", text: block.text, timestamp: block.timestamp };
		case "tool":
			return { kind: "tool", name: block.name, args: block.args, timestamp: block.timestamp };
		// pie: feed.rs:512-521 — `tool_call_id` is deliberately dropped on the web shape.
		case "toolResult":
			return {
				kind: "tool_result",
				lines: [...block.lines],
				is_error: block.isError,
				timestamp: block.timestamp,
			};
		case "plain":
			return { kind: "plain", text: block.text, level: block.level, timestamp: block.timestamp };
	}
}

/**
 * pie: feed.rs:554-566 (`should_separate`). A blank row goes in before every user block, and before
 * the first assistant / thinking / tool block that follows one — never before a tool result, which
 * stays glued to its tool call.
 */
function shouldSeparate(previous: Block | undefined, current: Block, hasOutput: boolean): boolean {
	if (!hasOutput) {
		return false;
	}
	if (current.kind === "user") {
		return true;
	}
	return (
		previous?.kind === "user" &&
		(current.kind === "assistant" || current.kind === "thinking" || current.kind === "tool")
	);
}

/** pie: feed.rs:568-579 (`style_for_level`). */
function styleForLevel(level: Level): FeedStyle {
	switch (level) {
		case "output":
			return DEFAULT_STYLE;
		case "system":
			return { fg: "darkGray" };
		case "error":
			return { fg: "red" };
		case "note":
			return { fg: "green" };
		case "header":
			return { fg: "magenta", bold: true };
		case "qr":
			return DEFAULT_STYLE;
	}
}

/** pie: feed.rs:581-587 (`display_prefix`). */
function displayPrefix(timestamp: string | undefined, label: string): string {
	if (timestamp === undefined) {
		return label;
	}
	return label === "" ? `${timestamp} ` : `${timestamp} ${label}`;
}

/**
 * pie: feed.rs:606-631 (`push_paragraphs`). Oracle doc: "Split `text` on newlines, word-wrap each
 * paragraph to `width`, and push styled lines. An optional `prefix` is prepended to the very first
 * paragraph (e.g. `you ▸ `)."
 *
 * Rust `split('\n')` (not `lines()`), so a trailing newline yields a final empty paragraph, which
 * `wrap_str` turns into one blank row.
 */
function pushParagraphs(
	out: FeedLine[],
	text: string,
	style: FeedStyle,
	prefix: string | undefined,
	width: number,
): void {
	const paragraphs = text.split("\n");
	for (let i = 0; i < paragraphs.length; i += 1) {
		const raw = paragraphs[i] as string;
		const para = i === 0 && prefix !== undefined ? `${prefix}${raw}` : raw;
		for (const row of wrapStr(para, width)) {
			out.push({ text: row, style });
		}
	}
}

/**
 * pie: feed.rs:633-667 (`wrap_str`). Oracle doc: "Display-width-aware word wrap. Breaks at the last
 * space that fits; hard-breaks a single word longer than `width`. Preserves leading whitespace (so
 * indented tool output keeps its shape). Returns at least one row (possibly empty) so blank lines
 * survive."
 *
 * `last_space` is a Rust byte offset into `cur`; here it is a UTF-16 offset into the same buffer.
 * The two disagree in general but never at a break point: the offset is only ever recorded
 * immediately after pushing an ASCII space, and both encodings agree on positions adjacent to
 * ASCII, so `split_off` lands on the identical character either way.
 */
export function wrapStr(text: string, width: number): string[] {
	const w = Math.max(width, 1);
	if (text === "") {
		return [""];
	}
	const rows: string[] = [];
	let cur = "";
	let curW = 0;
	let lastSpace: number | undefined;
	for (const ch of text) {
		const cw = charWidth(ch);
		if (curW + cw > w && cur !== "") {
			if (lastSpace !== undefined) {
				// pie: feed.rs:648-653 — `take()` clears the breakpoint before it is used.
				const bp = lastSpace;
				lastSpace = undefined;
				const rest = trimStartSpaces(cur.slice(bp));
				const done = cur.slice(0, bp);
				cur = rest;
				// Rust `trim_end()` drops Unicode White_Space; JS `trimEnd()` additionally drops
				// U+FEFF, which cannot appear here because it is zero-width and never a breakpoint.
				rows.push(done.trimEnd());
				curW = strWidth(cur);
			} else {
				// pie: feed.rs:654-657 — hard break, no trimming.
				rows.push(cur);
				cur = "";
				curW = 0;
			}
		}
		cur += ch;
		curW += cw;
		if (ch === " ") {
			lastSpace = cur.length;
		}
	}
	rows.push(cur);
	return rows;
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Tool-output compaction
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * pie: feed.rs:692-741 (`compact_tool_output_lines`). Oracle doc: "Build a compact, display-only
 * preview of tool output. The full tool result still flows to the model/session; this only limits
 * what the TUI/feed shows while tools are running."
 *
 * Every counter oracle mixes here is a UTF-8 **byte** count (`str::len()`), never chars and never
 * UTF-16 units — except the per-line cap, which really is code points (`chars().take(n)`). The
 * `+ 1` per omitted line is the newline that would have joined them.
 */
export function compactToolOutputLines(lines: readonly string[], isError: boolean): string[] {
	// pie: feed.rs:695-707
	const headLines = isError ? TOOL_OUTPUT_ERROR_HEAD_LINES : TOOL_OUTPUT_HEAD_LINES;
	const tailLines = isError ? TOOL_OUTPUT_ERROR_TAIL_LINES : TOOL_OUTPUT_TAIL_LINES;
	const maxLineChars = isError ? TOOL_OUTPUT_ERROR_MAX_LINE_CHARS : TOOL_OUTPUT_MAX_LINE_CHARS;

	const originalLineCount = lines.length;
	let hiddenBytes = 0;
	// pie: feed.rs:710-721
	let compacted = lines.map((line) => {
		const keptBytes = utf8Len([...line].slice(0, maxLineChars).join(""));
		const lineBytes = utf8Len(line);
		if (keptBytes < lineBytes) {
			hiddenBytes += lineBytes - keptBytes;
			return truncateChars(line, maxLineChars);
		}
		return line;
	});

	// pie: feed.rs:723-734
	const maxLines = headLines + tailLines;
	let hiddenLines = 0;
	if (compacted.length > maxLines) {
		hiddenLines = compacted.length - maxLines;
		const tail = compacted.slice(compacted.length - tailLines);
		const head = compacted.slice(0, headLines);
		const omitted = compacted.slice(headLines, compacted.length - tailLines);
		for (const line of omitted) {
			hiddenBytes += utf8Len(line) + 1;
		}
		compacted = [...head, truncationMarker(hiddenBytes, hiddenLines), ...tail];
	} else if (hiddenBytes > 0) {
		compacted = [...compacted, truncationMarker(hiddenBytes, hiddenLines)];
	}

	// pie: feed.rs:736-740 — an empty input yields an empty result, never a bare marker.
	return originalLineCount === 0 ? [] : compacted;
}

/**
 * pie: feed.rs:743-754 (`compact_tool_content_blocks`). Oracle doc: "Extract text blocks from a tool
 * result and build the same display-only compact preview used for live tool events. This keeps
 * resume replay, headless output, and legacy renderers from accidentally bypassing the display cap."
 *
 * `UserContentBlock` is `TextContent | ImageContent` in the ported `@pie/ai`; image blocks
 * contribute nothing, exactly as oracle's `if let UserContentBlock::Text(t)` does.
 */
export function compactToolContentBlocks(blocks: readonly (TextContent | ImageContent)[], isError: boolean): string[] {
	const lines: string[] = [];
	for (const block of blocks) {
		if (block.type === "text") {
			lines.push(...rustLines(block.text));
		}
	}
	return compactToolOutputLines(lines, isError);
}

/** pie: feed.rs:756-771 (`truncation_marker`). Four distinct user-visible phrasings; kept verbatim. */
function truncationMarker(hiddenBytes: number, hiddenLines: number): string {
	if (hiddenBytes === 0 && hiddenLines === 0) {
		return "… truncated for display; full output remains available to the agent …";
	}
	if (hiddenLines === 0) {
		return `… truncated ${hiddenBytes} bytes for display; full output remains available to the agent …`;
	}
	if (hiddenBytes === 0) {
		return `… truncated ${hiddenLines} lines for display; full output remains available to the agent …`;
	}
	return (
		`… truncated ${hiddenBytes} bytes / ${hiddenLines} lines for display;` +
		" full output remains available to the agent …"
	);
}
