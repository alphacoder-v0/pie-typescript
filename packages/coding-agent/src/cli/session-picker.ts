/**
 * TUI session selector for --resume flag
 *
 * Two selectors live here:
 *
 * 1. {@link selectSession} -- the pi skeleton's full-screen `SessionSelectorComponent` wrapper,
 *    wired into `main.ts:269`. Unchanged.
 * 2. The oracle's scrolling-viewport picker, diff-ported from
 *    crates/coding-agent/src/resume_picker.rs. Oracle keeps "pure logic (viewport math, line
 *    rendering, key mapping) separated from the terminal IO so it stays unit-testable; only
 *    `pick_blocking` touches crossterm" (resume_picker.rs:8-9) -- that pure half is ported below
 *    verbatim. The crossterm half is a phase 14 (`coding-agent/tui`) unit; see the
 *    `TODO(port):` on {@link pickerFrame}.
 */

import { isKeyRelease, ProcessTerminal, parseKey, setKeybindings, TUI } from "@pie/tui";
import { KeybindingsManager } from "../core/keybindings.ts";
import type { SessionInfo, SessionListProgress } from "../core/session-manager.ts";
import { SessionSelectorComponent } from "../modes/interactive/components/session-selector.ts";

type SessionsLoader = (onProgress?: SessionListProgress) => Promise<SessionInfo[]>;

/** Show TUI session selector and return selected session path or null if cancelled */
export async function selectSession(
	currentSessionsLoader: SessionsLoader,
	allSessionsLoader: SessionsLoader,
): Promise<string | null> {
	return new Promise((resolve) => {
		const ui = new TUI(new ProcessTerminal());
		const keybindings = KeybindingsManager.create();
		setKeybindings(keybindings);
		let resolved = false;

		const selector = new SessionSelectorComponent(
			currentSessionsLoader,
			allSessionsLoader,
			(path: string) => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					resolve(path);
				}
			},
			() => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					resolve(null);
				}
			},
			() => {
				ui.stop();
				process.exit(0);
			},
			() => ui.requestRender(),
			{ showRenameHint: false, keybindings },
		);

		ui.addChild(selector);
		ui.setFocus(selector.getSessionList());
		ui.start();
	});
}

// ──────────────────────────────────────────────────────────────────────────────────────────
// Oracle resume picker (crates/coding-agent/src/resume_picker.rs)
//
// "Replaces the print-everything-then-read-a-number prompt: with a long history the old list
// pushed the newest sessions off screen. This renders a scrolling viewport menu in raw mode --
// newest sessions first, a pinned 'start a new session' row on top, arrow-key navigation, Enter
// to choose, `q`/Esc to cancel." (resume_picker.rs:3-6)
// ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * resume_picker.rs:16-23 -- one selectable session row (already newest-first; the pinned "clean"
 * row is added by the renderer, not the caller).
 */
export interface PickerRow {
	idShort: string;
	/** Pre-formatted display timestamp; the picker never parses it. */
	createdAt: string;
	badge?: string;
	preview: string;
}

/** resume_picker.rs:25-32 -- `PickerChoice`, as a tagged union (RULEBOOK §2.1). */
export type PickerChoice =
	/** Start a fresh session. */
	| { kind: "clean" }
	/** Resume the row at this index into the caller's (newest-first) slice. */
	| { kind: "resume"; index: number }
	| { kind: "cancelled" };

/** resume_picker.rs:34-45 -- `Action`, as a string-literal union (RULEBOOK §2.1 unit-only enum). */
export type PickerAction = "up" | "down" | "pageUp" | "pageDown" | "home" | "end" | "select" | "cancel" | "none";

/** resume_picker.rs:47-48 */
export const SELECTED_PREFIX = "→ ";
export const UNSELECTED_PREFIX = "  ";

/** resume_picker.rs:50-53 -- total selectable entries: the pinned clean row + every session row. */
export function entryCount(rows: number): number {
	return rows + 1;
}

/**
 * resume_picker.rs:55-68 -- compute the `[start, end)` slice of entries visible in a viewport of
 * `height` rows, keeping `selected` in view. `height` is clamped to at least 1.
 */
export function visibleWindow(selected: number, total: number, height: number): { start: number; end: number } {
	const clampedHeight = Math.max(height, 1);
	if (total <= clampedHeight) {
		return { start: 0, end: total };
	}
	// Center-ish follow: keep the selection visible, pin the window to the ends.
	// `saturating_sub` on usize floors at 0; `height / 2` is Rust integer division.
	const start = Math.min(
		Math.max(0, selected - Math.floor(clampedHeight / 2)),
		total - clampedHeight,
		selected, // selection never scrolls above the window
	);
	return { start, end: start + clampedHeight };
}

/**
 * resume_picker.rs:70-124 -- render the full menu (header, entries in the window, scroll
 * indicators, footer) for a terminal of `width` columns with `height` entry rows visible.
 */
export function renderLines(rows: readonly PickerRow[], selected: number, width: number, height: number): string[] {
	const total = entryCount(rows.length);
	const { start, end } = visibleWindow(selected, total, height);

	const lines: string[] = [];
	lines.push(truncateLine(`resume a session (${rows.length} total) — ↑/↓ move · Enter select · q cancel`, width));
	if (start > 0) {
		lines.push(truncateLine(`  … ${start} more above`, width));
	}
	for (let idx = start; idx < end; idx++) {
		const marker = idx === selected ? SELECTED_PREFIX : UNSELECTED_PREFIX;
		let body: string;
		if (idx === 0) {
			body = "✚ start a new session";
		} else {
			const row = rows[idx - 1];
			const badge = row.badge === undefined ? "" : `  [${row.badge}]`;
			body = `${row.idShort}  ${row.createdAt}${badge}  ${row.preview}`;
		}
		const line = `${marker}${body}`;
		if (idx === selected) {
			// resume_picker.rs:108-112 -- reverse video on the selection; applied after truncation
			// so the escape codes never count against the width budget.
			lines.push(`\x1b[7m${truncateLine(line, width)}\x1b[0m`);
		} else {
			lines.push(truncateLine(line, width));
		}
	}
	if (end < total) {
		lines.push(truncateLine(`  … ${total - end} more below`, width));
	}
	return lines;
}

/**
 * resume_picker.rs:126-133 -- width budget is counted in Unicode scalar values (Rust
 * `chars().count()`), so `Array.from` is used rather than `String.length` (UTF-16 units).
 *
 * PERF(port): materializes the code-point array for every line; a width-bounded scan would avoid
 * that, but menus are at most a few dozen lines per frame.
 */
export function truncateLine(line: string, width: number): string {
	const chars = Array.from(line);
	if (chars.length <= width) {
		return line;
	}
	return `${chars.slice(0, Math.max(0, width - 1)).join("")}…`;
}

/**
 * A crossterm `KeyEvent`, reduced to what {@link keyAction} inspects. Produced from raw terminal
 * input by {@link pickerKeyFromInput}.
 */
export interface PickerKeyEvent {
	/**
	 * crossterm `KeyCode`: a named key ("up", "down", "pageUp", "pageDown", "home", "end",
	 * "enter", "escape") or the character itself for `KeyCode::Char`.
	 */
	code: string;
	/** `KeyModifiers::CONTROL` */
	ctrl?: boolean;
	/** crossterm `KeyEventKind`; kitty-protocol terminals also deliver "release". */
	kind?: "press" | "repeat" | "release";
}

/** resume_picker.rs:135-153 -- key-to-action mapping. */
export function keyAction(key: PickerKeyEvent): PickerAction {
	// resume_picker.rs:136-138 -- release events (kitty protocol) must not double-fire.
	if (key.kind === "release") {
		return "none";
	}
	// resume_picker.rs:139-141 -- ctrl+c cancels regardless of the mapping below.
	if (key.ctrl && key.code === "c") {
		return "cancel";
	}
	switch (key.code) {
		case "up":
		case "k":
			return "up";
		case "down":
		case "j":
			return "down";
		case "pageUp":
			return "pageUp";
		case "pageDown":
			return "pageDown";
		case "home":
			return "home";
		case "end":
			return "end";
		// `@pie/tui` spells crossterm's `KeyCode::Enter`/`KeyCode::Esc` as enter|return and
		// escape|esc; both spellings map to the same oracle action.
		case "enter":
		case "return":
			return "select";
		case "escape":
		case "esc":
		case "q":
			return "cancel";
		default:
			return "none";
	}
}

/**
 * Adapt raw terminal input (what `@pie/tui` hands components) to the crossterm-shaped event
 * {@link keyAction} expects. This is the seam the phase 14 TUI unit wires up; oracle gets the
 * same information straight from `crossterm::event::read()` (resume_picker.rs:191-192).
 */
export function pickerKeyFromInput(data: string): PickerKeyEvent | undefined {
	const parsed = parseKey(data);
	if (parsed === undefined) {
		return undefined;
	}
	const parts = parsed.split("+");
	// A trailing "+" key (e.g. "shift++") leaves an empty tail; fall back to the literal.
	const code = parts[parts.length - 1] === "" ? "+" : parts[parts.length - 1];
	return { code, ctrl: parts.includes("ctrl"), kind: isKeyRelease(data) ? "release" : "press" };
}

/** One step of the picker loop: either a new selection index, or a terminal choice. */
export type PickerStep = { kind: "selected"; selected: number } | { kind: "done"; choice: PickerChoice };

/**
 * resume_picker.rs:192-208 -- the selection state machine from `pick_blocking`'s event loop,
 * extracted so it is testable without a terminal. `total` is {@link entryCount}, i.e. index 0 is
 * always the pinned "start a new session" row.
 */
export function applyPickerAction(selected: number, action: PickerAction, total: number): PickerStep {
	switch (action) {
		case "up":
			return { kind: "selected", selected: Math.max(0, selected - 1) };
		case "down":
			return { kind: "selected", selected: Math.min(selected + 1, total - 1) };
		case "pageUp":
			return { kind: "selected", selected: Math.max(0, selected - 10) };
		case "pageDown":
			return { kind: "selected", selected: Math.min(selected + 10, total - 1) };
		case "home":
			return { kind: "selected", selected: 0 };
		case "end":
			return { kind: "selected", selected: total - 1 };
		case "select":
			// resume_picker.rs:199-205 -- index 0 is the pinned clean row; every other index is
			// offset by one into the caller's newest-first slice.
			return {
				kind: "done",
				choice: selected === 0 ? { kind: "clean" } : { kind: "resume", index: selected - 1 },
			};
		case "cancel":
			return { kind: "done", choice: { kind: "cancelled" } };
		case "none":
			return { kind: "selected", selected };
	}
}

/**
 * resume_picker.rs:166-173 -- the per-frame geometry `pick_blocking` derives from the terminal
 * size, plus the rendered lines. Split out so the sizing rules (which carry real behaviour: the
 * degenerate-terminal fallbacks and the 30-row cap) are testable without a TTY.
 *
 * TODO(port): the surrounding IO half of `pick_blocking` (resume_picker.rs:157-213 -- raw mode
 * via `RawModeGuard`, in-place repaint with `MoveUp`/`Clear(FromCursorDown)`, `\r\n` line
 * endings, blocking `crossterm::event::read()`) belongs to the phase 14 `coding-agent/tui` unit:
 * it needs `@pie/tui` primitives for raw mode and cursor control that are not ported yet. Phase
 * 14 should drive it as: read a key -> {@link pickerKeyFromInput} -> {@link keyAction} ->
 * {@link applyPickerAction}, repainting {@link pickerFrame}`.lines` each iteration.
 */
export function pickerFrame(
	rows: readonly PickerRow[],
	selected: number,
	terminalWidth: number,
	terminalRows: number,
): { width: number; height: number; lines: string[] } {
	// resume_picker.rs:167-170 -- some pseudo-terminals report a zero/absurdly small size; render
	// for a sane minimum instead of truncating every row to nothing.
	const width = terminalWidth < 40 ? 100 : terminalWidth;
	const rowCount = terminalRows < 5 ? 30 : terminalRows;
	// resume_picker.rs:171-172 -- header + footer + possible two scroll indicators take ~4 rows.
	const height = Math.min(Math.max(Math.max(0, rowCount - 4), 1), 30);
	return { width, height, lines: renderLines(rows, selected, width, height) };
}
