/**
 * The real-terminal {@link TerminalDriver} — the painter `./index.ts:210` left as a `TODO(port)`.
 *
 * Oracle talks to crossterm + ratatui directly (`ui/mod.rs:358-366` drives a
 * `Terminal<CrosstermBackend<Stdout>>`). Neither crate has a TS counterpart and RULEBOOK §1 admits
 * no new dependency, so this file is the seam: it takes the {@link Frame} `App.render()` already
 * produces — the very rows ratatui would have been handed — and paints them with ANSI, and it turns
 * raw stdin bytes back into the {@link TuiEvent}s `handle_event` matches on.
 *
 * ## What is ported and what is not
 *
 * - **Layout, wrapping, scroll, overlay geometry**: all of it already happened in
 *   `./app-render.ts`. Nothing here re-decides any of it; the painter only places rows at the rects
 *   the frame carries.
 * - **Colors**: ratatui's `Color::{Cyan,DarkGray,Yellow,Red,Green,Magenta}` render as the standard
 *   SGR 3x/9x codes, and `Modifier::{BOLD,ITALIC}` as SGR 1/3 — see {@link sgr}. (This is a
 *   *different* regime from `../tui.ts`, whose crossterm command queue emits the 256-colour
 *   `38;5;N` form; both are faithful to their own oracle call sites. Do not unify them.)
 * - **The caret**: `Frame` carries no cursor coordinate (see `./app-render.ts` — the frame is a row
 *   list, not a cell grid, ED21), so the terminal cursor is parked at the end of the last input row.
 *   TODO(port): thread `InputArea.cursor()` through `Frame` to place it exactly.
 *
 * ## The paint buffer
 *
 * Overlays sit *on top of* the feed, so composing them needs per-column overwrite. The painter
 * therefore builds one throwaway `Cell[]` per row inside {@link paintFrame} and drops it again the
 * same call. That is a driver-local implementation detail of "write bytes to a terminal", not a
 * widening of the `Frame` contract — `App.render()` still returns rows and rects and nothing else.
 */

import { AsyncQueue } from "@pie/agent-core";
import { isKeyRelease, isKeyRepeat, ProcessTerminal, parseKey, type Terminal } from "@pie/tui";
import type { Frame, Overlay, Rect } from "./app-render.ts";
import { enterTuiCommands, leaveTuiCommands } from "./app-text.ts";
import { type FeedColor, type FeedLine, type FeedStyle, strWidth } from "./feed.ts";
import type { TerminalDriver, TuiEvent, TuiKey } from "./index.ts";
import type { InputKeyCode } from "./input-area.ts";

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * SGR — the ratatui `Style` slice `FeedStyle` models.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/** ratatui `Color` → the standard SGR foreground code its crossterm backend writes. */
const FG_CODE: Record<FeedColor, number> = {
	cyan: 36,
	darkGray: 90,
	yellow: 33,
	red: 31,
	green: 32,
	magenta: 35,
};

const RESET = "\x1b[0m";

/** The escape prefix for one `FeedStyle`; empty when the style is ratatui's default. */
function sgr(style: FeedStyle): string {
	const codes: number[] = [];
	if (style.bold === true) codes.push(1);
	if (style.italic === true) codes.push(3);
	if (style.fg !== undefined) codes.push(FG_CODE[style.fg]);
	return codes.length === 0 ? "" : `\x1b[${codes.join(";")}m`;
}

function sameStyle(a: FeedStyle, b: FeedStyle): boolean {
	return a.fg === b.fg && a.bold === b.bold && a.italic === b.italic;
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Paint buffer.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

interface Cell {
	/** The grapheme occupying this column. `""` marks the trailing half of a wide char. */
	readonly ch: string;
	readonly style: FeedStyle;
}

const DEFAULT_STYLE: FeedStyle = {};

function blankRow(width: number): Cell[] {
	const row: Cell[] = new Array(width);
	for (let i = 0; i < width; i++) row[i] = { ch: " ", style: DEFAULT_STYLE };
	return row;
}

/**
 * Write `text` into `row` starting at column `x`, clipped to `[x, x + maxWidth)` and to the row.
 * Zero-width characters are dropped (`charWidth` already returns 0 for C0/DEL/C1 — see `./feed.ts`),
 * and a double-width character claims a following continuation cell so the join below stays aligned.
 */
function writeText(row: Cell[], x: number, maxWidth: number, text: string, style: FeedStyle): void {
	let col = x;
	const limit = Math.min(row.length, x + maxWidth);
	for (const ch of text) {
		const w = strWidth(ch);
		if (w === 0) continue;
		if (col >= limit) return;
		row[col] = { ch, style };
		for (let i = 1; i < w; i++) {
			if (col + i >= limit) break;
			row[col + i] = { ch: "", style };
		}
		col += w;
	}
}

/**
 * One painted row: SGR only where the style actually changes, then a single reset.
 *
 * Unstyled trailing blanks are dropped — the row is emitted after a `CSI K` (erase-to-end-of-line),
 * so painting them again would only cost bytes.
 */
function renderRow(cells: Cell[]): string {
	let end = cells.length;
	while (end > 0) {
		const cell = cells[end - 1];
		if (cell.ch !== " " && cell.ch !== "") break;
		if (!sameStyle(cell.style, DEFAULT_STYLE)) break;
		end--;
	}
	const row = end === cells.length ? cells : cells.slice(0, end);
	let out = "";
	let current: FeedStyle = DEFAULT_STYLE;
	let styled = false;
	for (const cell of row) {
		if (cell.ch === "") continue;
		if (!sameStyle(cell.style, current)) {
			// A style change always resets first: SGR codes are additive, so dropping bold needs it.
			if (styled) out += RESET;
			const sequence = sgr(cell.style);
			out += sequence;
			current = cell.style;
			styled = sequence.length > 0;
		}
		out += cell.ch;
	}
	return styled ? out + RESET : out;
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Frame → rows.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/** ratatui `Block::bordered()` — the single-line box-drawing set its default `BorderType` uses. */
const BORDER = { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" } as const;

function paintBlock(rows: Cell[][], rect: Rect, style: FeedStyle, title?: string): void {
	if (rect.width < 2 || rect.height < 2) return;
	const top = rows[rect.y];
	const bottom = rows[rect.y + rect.height - 1];
	if (top !== undefined) {
		writeText(top, rect.x, rect.width, BORDER.tl + BORDER.h.repeat(rect.width - 2) + BORDER.tr, style);
		// ratatui renders the title over the top border, one cell in from the corner.
		if (title !== undefined && title.length > 0) writeText(top, rect.x + 1, rect.width - 2, title, style);
	}
	if (bottom !== undefined) {
		writeText(bottom, rect.x, rect.width, BORDER.bl + BORDER.h.repeat(rect.width - 2) + BORDER.br, style);
	}
	for (let y = rect.y + 1; y < rect.y + rect.height - 1; y++) {
		const row = rows[y];
		if (row === undefined) continue;
		writeText(row, rect.x, 1, BORDER.v, style);
		writeText(row, rect.x + rect.width - 1, 1, BORDER.v, style);
	}
}

function paintLines(rows: Cell[][], rect: Rect, lines: readonly FeedLine[]): void {
	for (let i = 0; i < lines.length && i < rect.height; i++) {
		const row = rows[rect.y + i];
		if (row === undefined) continue;
		const line = lines[i];
		writeText(row, rect.x, rect.width, line.text, line.style);
	}
}

/**
 * pie: mod.rs:1567-1653, 1967-2009 — every overlay is a `Clear` plus a bordered block. The clear is
 * reproduced by blanking the rect before the block is drawn, so the feed never bleeds through.
 */
function paintOverlay(rows: Cell[][], overlay: Overlay): void {
	const { rect } = overlay;
	for (let y = rect.y; y < rect.y + rect.height; y++) {
		const row = rows[y];
		if (row === undefined) continue;
		writeText(row, rect.x, rect.width, " ".repeat(rect.width), DEFAULT_STYLE);
	}
	paintBlock(rows, rect, { fg: overlay.borderColor }, overlay.title);
	paintLines(
		rows,
		{
			x: rect.x + 1,
			y: rect.y + 1,
			width: Math.max(rect.width - 2, 0),
			height: Math.max(rect.height - 2, 0),
		},
		overlay.lines,
	);
}

/** pie: mod.rs:1465-1564 (`render`) — the ratatui half, replayed onto a byte stream. */
export function paintFrame(frame: Frame, area: Rect): string {
	const width = Math.max(area.width, 0);
	const height = Math.max(area.height, 0);
	if (width === 0 || height === 0) return "";
	const rows: Cell[][] = [];
	for (let y = 0; y < height; y++) rows.push(blankRow(width));

	// pie: mod.rs:1494-1507 — the feed paragraph, already wrapped and viewport-sliced.
	paintLines(rows, frame.feedArea, frame.feedLines);
	if (frame.triggerArea !== undefined && frame.triggerLines !== undefined) {
		// pie: mod.rs:1655-1668 — the rail is a left-bordered block with one column of padding, which
		// is exactly why `app-render.ts` hands it `width - 2` of text.
		const rail = frame.triggerArea;
		for (let y = rail.y; y < rail.y + rail.height; y++) {
			const row = rows[y];
			if (row !== undefined) writeText(row, rail.x, 1, BORDER.v, { fg: "darkGray" });
		}
		paintLines(
			rows,
			{ x: rail.x + 2, y: rail.y, width: Math.max(rail.width - 2, 0), height: rail.height },
			frame.triggerLines,
		);
	}

	// pie: mod.rs:1513-1516 — the status rule.
	paintLines(rows, frame.layout.status, [{ text: frame.statusText, style: { fg: "darkGray" } }]);

	// pie: mod.rs:1518-1545 — the bordered input box, its cyan prompt column, then the buffer.
	const input = frame.layout.input;
	paintBlock(rows, input, { fg: "cyan" });
	const innerWidth = Math.max(input.width - 2, 0);
	const innerHeight = Math.max(input.height - 2, 0);
	const promptWidth = Math.min(innerWidth, 2);
	for (let i = 0; i < frame.inputRows.length && i < innerHeight; i++) {
		const row = rows[input.y + 1 + i];
		if (row === undefined) continue;
		writeText(row, input.x + 1, promptWidth, "> ", { fg: "cyan" });
		writeText(row, input.x + 1 + promptWidth, Math.max(innerWidth - promptWidth, 0), frame.inputRows[i], {});
	}

	// pie: mod.rs:1547-1559 — the hint line.
	paintLines(rows, frame.layout.hint, [{ text: frame.hintText, style: { fg: "darkGray" } }]);

	// pie: mod.rs:1561-1563 — completions, then the picker, then the confirm card (painted last).
	if (frame.completions !== undefined) paintOverlay(rows, frame.completions);
	if (frame.modelPicker !== undefined) paintOverlay(rows, frame.modelPicker);
	if (frame.controlPlanePrompt !== undefined) paintOverlay(rows, frame.controlPlanePrompt);

	let out = "";
	for (let y = 0; y < height; y++) {
		// Absolute placement + clear-to-EOL: no full-screen erase, so a redraw does not flash.
		out += `\x1b[${y + 1};1H\x1b[K${renderRow(rows[y])}`;
	}
	return out;
}

/** Where the terminal caret is parked after a paint — see this file's header. */
export function caretPosition(frame: Frame): { row: number; column: number } {
	const input = frame.layout.input;
	const innerHeight = Math.max(input.height - 2, 0);
	const shown = Math.min(frame.inputRows.length, Math.max(innerHeight, 1));
	const lastIndex = Math.max(shown - 1, 0);
	const text = frame.inputRows[lastIndex] ?? "";
	const promptWidth = Math.min(Math.max(input.width - 2, 0), 2);
	// 1-based, as CUP expects.
	return {
		row: input.y + 1 + lastIndex + 1,
		column: input.x + 1 + promptWidth + strWidth(text) + 1,
	};
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Input decoding — `crossterm::event::EventStream` (mod.rs:371).
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/** `\x1b[<button;col;rowM|m` — the SGR encoding `enter_tui` asks for (`app-text.ts:196`). */
const SGR_MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

/** `KeyId` (`@pie/tui`'s `keys.ts`) → the `crossterm::event::KeyCode` slice `InputArea` acts on. */
const KEY_CODES: Record<string, InputKeyCode> = {
	enter: { kind: "enter" },
	return: { kind: "enter" },
	escape: { kind: "esc" },
	esc: { kind: "esc" },
	tab: { kind: "tab" },
	backspace: { kind: "backspace" },
	delete: { kind: "delete" },
	left: { kind: "left" },
	right: { kind: "right" },
	up: { kind: "up" },
	down: { kind: "down" },
	home: { kind: "home" },
	end: { kind: "end" },
	pageUp: { kind: "pageUp" },
	pageDown: { kind: "pageDown" },
	space: { kind: "char", char: " " },
};

/**
 * Split a `KeyId` such as `ctrl+alt+c` into the `crossterm::event::KeyEvent` fields. An unmodelled
 * name becomes `{ kind: "other", name }`, which `InputArea.input` ignores and `App.handleKey` falls
 * through on — the conservative answer for a key neither side acts on (RULEBOOK §8).
 */
export function keyIdToTuiKey(keyId: string, kind: TuiKey["kind"]): TuiKey {
	const parts = keyId.split("+");
	let ctrl = false;
	let alt = false;
	let shift = false;
	while (parts.length > 1) {
		const modifier = parts[0];
		if (modifier === "ctrl") ctrl = true;
		else if (modifier === "alt") alt = true;
		else if (modifier === "shift") shift = true;
		else break;
		parts.shift();
	}
	const name = parts.join("+");
	const known = KEY_CODES[name];
	let code: InputKeyCode;
	if (known !== undefined) {
		code = known;
	} else if ([...name].length === 1) {
		code = { kind: "char", char: name };
	} else {
		code = { kind: "other", name };
	}
	return { code, ctrl, alt, shift, kind };
}

/** True when `data` still holds a C0 control byte or DEL, i.e. it is not plain typed text. */
function hasControlByte(data: string): boolean {
	for (const char of data) {
		const code = char.codePointAt(0) ?? 0;
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

/**
 * One raw stdin sequence → zero or more {@link TuiEvent}s. `@pie/tui`'s `StdinBuffer` (installed by
 * `ProcessTerminal.start`) has already split batched input into individual sequences, so this sees
 * one escape sequence — or one run of typed characters — per call.
 */
export function decodeTerminalInput(data: string): TuiEvent[] {
	if (data.length === 0) return [];

	// Bracketed paste. `enter_tui` enables it (`\x1b[?2004h`), so a paste arrives wrapped.
	const start = data.indexOf(BRACKETED_PASTE_START);
	if (start !== -1) {
		const rest = data.slice(start + BRACKETED_PASTE_START.length);
		const end = rest.indexOf(BRACKETED_PASTE_END);
		const text = end === -1 ? rest : rest.slice(0, end);
		const tail = end === -1 ? "" : rest.slice(end + BRACKETED_PASTE_END.length);
		return [{ type: "paste", text }, ...decodeTerminalInput(tail)];
	}

	const mouse = SGR_MOUSE.exec(data);
	if (mouse !== null) {
		const button = Number(mouse[1]);
		// crossterm: 64 = wheel up, 65 = wheel down; everything else is a press/drag this UI ignores.
		const kind = button === 64 ? "scrollUp" : button === 65 ? "scrollDown" : "other";
		// SGR coordinates are 1-based; `mouse_in_feed` compares against 0-based rects.
		return [
			{
				type: "mouse",
				kind,
				column: Math.max(Number(mouse[2]) - 1, 0),
				row: Math.max(Number(mouse[3]) - 1, 0),
			},
		];
	}

	// pie: mod.rs:704 — `key.kind != KeyEventKind::Release`. The Kitty protocol is the only source of
	// release/repeat events here; legacy terminals only ever send presses.
	const kind: TuiKey["kind"] = isKeyRelease(data) ? "release" : isKeyRepeat(data) ? "repeat" : "press";

	const keyId = parseKey(data);
	if (keyId !== undefined) return [{ type: "key", key: keyIdToTuiKey(keyId, kind) }];

	// `parseKey` only answers for single-byte printables, so a typed non-ASCII grapheme (or a run of
	// characters delivered in one chunk) lands here. Anything still carrying an escape or a control
	// byte is a sequence neither side models and is dropped rather than typed into the buffer.
	if (hasControlByte(data)) return [];
	return [...data].map((char) => ({
		type: "key" as const,
		key: { code: { kind: "char" as const, char }, ctrl: false, alt: false, shift: false, kind },
	}));
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * The driver.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * pie: `ui/mod.rs:358-366` — `enter_tui()`, `Terminal::new(CrosstermBackend::new(stdout()))`, the
 * event loop, then `leave_tui()` + `show_cursor()`. {@link App.run} owns that sequence; this object
 * is the crossterm/ratatui half of it.
 *
 * The terminal is only put into raw mode by `enter()`, which `App.run` calls *after* its own TTY
 * check — so constructing a driver on a pipe is inert and the headless fallback still works.
 */
export function createTerminalDriver(terminal: Terminal = new ProcessTerminal()): TerminalDriver {
	const events = new AsyncQueue<TuiEvent>();
	let started = false;

	const onInput = (data: string): void => {
		for (const event of decodeTerminalInput(data)) events.push(event);
	};
	const onResize = (): void => {
		events.push({ type: "resize" });
	};

	return {
		events,
		size: (): Rect => ({ x: 0, y: 0, width: terminal.columns, height: terminal.rows }),
		draw: (frame: Frame): void => {
			if (!started) return;
			const area: Rect = { x: 0, y: 0, width: terminal.columns, height: terminal.rows };
			const caret = caretPosition(frame);
			// Hide → paint → reposition → show, so the caret never streaks across the repaint.
			terminal.write(`\x1b[?25l${paintFrame(frame, area)}\x1b[${caret.row};${caret.column}H\x1b[?25h`);
		},
		enter: (): void => {
			if (started) return;
			started = true;
			terminal.start(onInput, onResize);
			terminal.write(enterTuiCommands());
		},
		leave: (): void => {
			if (!started) return;
			started = false;
			terminal.write(leaveTuiCommands());
			terminal.stop();
			// pie: mod.rs:363-364 — teardown is best-effort and runs even on error. Closing the queue
			// here keeps a late listener from holding Node's event loop open past the REPL.
			events.close();
		},
		clear: (): void => {
			if (started) terminal.clearScreen();
		},
		showCursor: (): void => {
			terminal.showCursor();
		},
	};
}
