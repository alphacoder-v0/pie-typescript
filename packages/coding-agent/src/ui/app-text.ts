/**
 * The free functions and constants of oracle `crates/coding-agent/src/ui/mod.rs` (pie @0a120dfd) —
 * everything below the `impl App` block at :2117-2298, plus the module constants at :71-79.
 *
 * Split out of `./index.ts` purely for file size (RULEBOOK §"File Organization"); every symbol here
 * is `ui/mod.rs`'s and carries its oracle line. None of them touch `App` state, which is what makes
 * them independently testable — and every one of them is user-visible text, so they are reproduced
 * character for character (RULEBOOK §2.1 `format!` row).
 */

import { envVarNames } from "@pie/ai";
import { redact } from "../bug-report.ts";
import { type FeedUpdate, truncateChars } from "./feed.ts";

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Constants — pie: mod.rs:71-79.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/** pie: mod.rs:71. */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
/** pie: mod.rs:72. */
export const MAX_INPUT_ROWS = 6;
/** pie: mod.rs:73. */
export const SCROLL_STEP = 3;
/** pie: mod.rs:74. */
export const COMPLETION_POPUP_MAX = 8;
/** pie: mod.rs:75. */
export const QUEUED_PREVIEW_CHARS = 80;
/** pie: mod.rs:76. */
export const TRIGGER_PANEL_MIN_TOTAL_WIDTH = 100;
/** pie: mod.rs:77. */
export const TRIGGER_PANEL_WIDTH = 36;
/** pie: mod.rs:78. */
export const TRIGGER_PANEL_RULE_LIMIT = 5;
/** pie: mod.rs:79. */
export const CONTROL_PROMPT_TEXT_WIDTH = 68;
/** pie: mod.rs:186. */
export const IMPORT_ACTIVATION_PROMPT_ID = "session-import-activation";

/** pie: mod.rs:1333 — the idle Ctrl-C double-tap window. */
export const IDLE_CTRLC_WINDOW_MS = 1500;
/** pie: mod.rs:372 (`tokio::time::interval(Duration::from_millis(100))`). */
export const TICK_INTERVAL_MS = 100;

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Control-plane prompt redaction — pie: mod.rs:2135-2160.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/** pie: mod.rs:2135-2137 (`safe_control_prompt_label`). */
export function safeControlPromptLabel(text: string): string {
	return safeControlPromptText(text, 120);
}

/**
 * pie: mod.rs:2139-2143 (`safe_control_prompt_text`). Truncate wide first so the regex scan is
 * bounded, redact, truncate to the real cap, then flatten newlines — the order is load-bearing
 * (redacting *after* the final truncate would let a half-token through).
 */
export function safeControlPromptText(text: string, cap: number): string {
	// pie: mod.rs:2140 — `cap.max(1).saturating_mul(4).min(1024)`.
	const redactionWindow = Math.min(Math.max(cap, 1) * 4, 1024);
	const redacted = redactControlPromptSecrets(truncateChars(text, redactionWindow));
	return truncateChars(redacted, Math.max(cap, 1)).replaceAll("\n", " ");
}

/**
 * pie: mod.rs:2145-2148 (`safe_control_prompt_payload`). `serde_json::to_string(value)` on a
 * `serde_json::Value` cannot fail, so the `unwrap_or_else(|_| "{}")` arm is unreachable in oracle;
 * `JSON.stringify` *can* return `undefined` (for a bare `undefined` payload) or throw (cycles), and
 * both land on oracle's fallback literal.
 */
export function safeControlPromptPayload(value: unknown, cap: number): string {
	let text: string;
	try {
		text = JSON.stringify(value) ?? "{}";
	} catch {
		text = "{}";
	}
	return safeControlPromptText(text, cap);
}

/** pie: mod.rs:2152-2156. */
const TOKENISH_FIELD = /(token|secret|password|api[_-]?key|authorization|cookie)(["'=:\s]+)([^"',\s&}]+)/gi;

/**
 * pie: mod.rs:2149-2160 (`redact_control_prompt_secrets`). `bug_report::redact` first (shared
 * credential shapes), then the token-ish `field: value` sweep.
 *
 * Rust `(?i)` → the JS `i` flag; `replace_all` → the `g` flag. The character classes are copied
 * verbatim; note `[^"',\s&}]+` keeps `=` and `:` inside the *value*, which is oracle's behavior.
 */
export function redactControlPromptSecrets(text: string): string {
	// pie: mod.rs:2158-2159 — compiled once in oracle (`Lazy<Regex>`); a module-level literal here.
	const redacted = redact(text);
	return redacted.replaceAll(TOKENISH_FIELD, "$1$2[REDACTED]");
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Previews and labels — pie: mod.rs:2162-2201.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/** pie: mod.rs:2162-2165 (`panel_rule_preview`). */
export function panelRulePreview(text: string, width: number): string {
	const redacted = redact(text).replaceAll("\n", " ");
	return truncateChars(redacted, Math.max(width, 1));
}

/** pie: mod.rs:2167-2170 (`queue_preview`). */
export function queuePreview(text: string): string {
	const redacted = redact(text).replaceAll("\n", " ");
	return truncateChars(redacted, QUEUED_PREVIEW_CHARS);
}

/**
 * pie: mod.rs:2172-2182 (`prompt_display`). An image-only prompt still needs a visible feed row,
 * so the attachment label stands in for the (empty) text rather than being appended to it.
 */
export function promptDisplay(text: string, imageCount: number): string {
	// pie: mod.rs:2173-2175.
	if (imageCount === 0) {
		return text;
	}
	const suffix = imageAttachmentDisplay(imageCount);
	// pie: mod.rs:2177-2181.
	return text === "" ? suffix : `${text}\n${suffix}`;
}

/** pie: mod.rs:2184-2189 (`image_attachment_display`). */
export function imageAttachmentDisplay(imageCount: number): string {
	return imageCount === 1 ? "[1 image attachment]" : `[${imageCount} image attachments]`;
}

/**
 * pie: mod.rs:2191-2201 (`human_bytes`). Rust `{:.1}` is round-half-away-from-zero on the decimal
 * expansion and `Number.prototype.toFixed` is round-half-to-even on the binary one; the inputs here
 * are byte counts divided by a power of two, whose one-decimal roundings agree.
 */
export function humanBytes(bytes: number): string {
	const KIB = 1024;
	const MIB = 1024 * 1024;
	if (bytes >= MIB) {
		return `${(bytes / MIB).toFixed(1)} MiB`;
	}
	if (bytes >= KIB) {
		return `${(bytes / KIB).toFixed(1)} KiB`;
	}
	return `${bytes} B`;
}

/**
 * pie: mod.rs:2203-2218 (`user_facing_run_error`). Rewrites the provider layer's
 * "no API key for provider: X; set X_API_KEY or pass options.api_key" into a message whose recovery
 * action is a *pie* action (`/login`), dropping the embedder-only `options.api_key` half.
 * Everything that does not start with the exact prefix passes through untouched.
 */
export function userFacingRunError(error: string): string {
	// pie: mod.rs:2204-2206 — `strip_prefix`, so a message merely *containing* the phrase is not
	// rewritten.
	const PREFIX = "no API key for provider: ";
	if (!error.startsWith(PREFIX)) {
		return error;
	}
	const rest = error.slice(PREFIX.length);
	// pie: mod.rs:2207 — `rest.split(';').next().unwrap_or(rest).trim()`; `split(';').next()` is
	// always `Some` in Rust, so the `unwrap_or` arm is unreachable and the `[0]` below is total.
	const provider = rest.split(";")[0].trim();
	// pie: mod.rs:2208-2210.
	if (provider === "") {
		return error;
	}
	// pie: mod.rs:2211-2216.
	const vars = envVarNames(provider);
	const credentialHint = vars.length === 0 ? "configure a provider-specific credential" : `set ${vars.join(" or ")}`;
	// pie: mod.rs:2217.
	return `no API key for provider: ${provider}; run /login ${provider} or ${credentialHint}`;
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Terminal mode escape sequences — pie: mod.rs:2227-2255.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * pie: mod.rs:2239-2246 (`write_enter_tui_commands`) — `execute!(out, EnterAlternateScreen,
 * EnableBracketedPaste, EnableMouseCapture)`. crossterm renders those as the literal CSI sequences
 * inlined here (`terminal::EnterAlternateScreen` = `?1049h`, `event::EnableBracketedPaste` =
 * `?2004h`, `event::EnableMouseCapture` = the five-mode block). Mouse capture is what makes
 * wheel-scroll reach the feed, hence its own oracle test (mod.rs:3210-3231).
 */
export function enterTuiCommands(): string {
	return (
		// EnterAlternateScreen
		"\x1b[?1049h" +
		// EnableBracketedPaste
		"\x1b[?2004h" +
		// EnableMouseCapture: normal / button-event / any-event tracking, then RXVT + SGR encodings.
		"\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1015h\x1b[?1006h"
	);
}

/**
 * pie: mod.rs:2248-2255 (`write_leave_tui_commands`) — `execute!(out, DisableMouseCapture,
 * DisableBracketedPaste, LeaveAlternateScreen)`. crossterm disables the mouse modes in the reverse
 * order it enabled them.
 */
export function leaveTuiCommands(): string {
	return (
		// DisableMouseCapture
		"\x1b[?1006l\x1b[?1015l\x1b[?1003l\x1b[?1002l\x1b[?1000l" +
		// DisableBracketedPaste
		"\x1b[?2004l" +
		// LeaveAlternateScreen
		"\x1b[?1049l"
	);
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Headless printer — pie: mod.rs:2257-2298.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/** The `std::io::stdout()` slice `print_headless_update` writes through, injectable for tests. */
export interface HeadlessOut {
	write(text: string): void;
}

/** `at_line_start` is oracle's `&mut bool` — a cursor-column tracker carried across updates. */
export interface HeadlessCursor {
	atLineStart: boolean;
}

/**
 * pie: mod.rs:2257-2298 (`print_headless_update`). Streams a feed update to stdout with just
 * enough newline bookkeeping that a mid-line text delta is not glued to the next block.
 *
 * Oracle ignores every `write!`/`flush` error (`let _ = …`); the sink here is infallible for the
 * same reason (a broken pipe surfaces as an `EPIPE` event on the Node stream, which the CLI entry
 * already owns, not as a throw from `write`).
 */
export function printHeadlessUpdate(update: FeedUpdate, cursor: HeadlessCursor, out: HeadlessOut): void {
	switch (update.kind) {
		// pie: mod.rs:2261-2264 — no newline, and the cursor tracks whether the delta ended one.
		case "text_delta":
			out.write(update.delta);
			cursor.atLineStart = update.delta.endsWith("\n");
			return;
		// pie: mod.rs:2265 — thinking is not echoed in headless mode.
		case "thinking_delta":
			return;
		// pie: mod.rs:2266-2272.
		case "tool_start":
			if (!cursor.atLineStart) out.write("\n");
			out.write(`⚙ ${update.name}${update.args}\n`);
			cursor.atLineStart = true;
			return;
		// pie: mod.rs:2273.
		case "tool_progress":
			return;
		// pie: mod.rs:2274-2279 — four-space indent, one line each.
		case "tool_end":
			for (const line of update.lines) {
				out.write(`    ${line}\n`);
			}
			// pie: mod.rs:2278 — set unconditionally, even when `lines` is empty.
			cursor.atLineStart = true;
			return;
		// pie: mod.rs:2280-2286.
		case "plain":
			if (!cursor.atLineStart) out.write("\n");
			out.write(`${update.text}\n`);
			cursor.atLineStart = true;
			return;
		// pie: mod.rs:2287-2288.
		case "trigger_poll_status":
		case "skills_reloaded":
			return;
		// pie: mod.rs:2289.
		case "turn_start":
			return;
		// pie: mod.rs:2290-2295 — close a dangling line so the next prompt starts clean.
		case "turn_end":
			if (!cursor.atLineStart) {
				out.write("\n");
				cursor.atLineStart = true;
			}
			return;
	}
}
