/**
 * Headless multi-line text buffer — the stand-in for oracle's `tui_textarea::TextArea`
 * (`crates/coding-agent/src/ui/mod.rs:126` `input: TextArea<'static>`, constructed at :2220-2225).
 *
 * TODO(port): `tui_textarea` is a Rust crate with no TS counterpart, and RULEBOOK §1 admits no new
 * dependency. `packages/tui`'s `Editor` (`components/editor.ts:217`) is not usable here: it is a
 * `Component, Focusable` in pi's component tree and its constructor needs a live `TUI` — importing
 * it would couple this REPL to the *other* REPL's renderer. So the buffer is reimplemented at
 * exactly the surface `ui/mod.rs` touches, and no wider:
 *
 *   `lines()` · `insert_str` · `insert_newline` · `input(key)` · `set_cursor_line_style` ·
 *   `set_placeholder_text`
 *
 * The two style setters are cosmetic in oracle (they configure how ratatui paints the widget, not
 * what it contains), so they survive here as inert fields the painter can read. Editing semantics
 * are the conservative subset a REPL prompt needs; anything richer that `tui_textarea` offers
 * (selection, undo, word motions, kill ring) has no `ui/mod.rs` call site and is deliberately
 * absent rather than guessed at.
 */

/** `crossterm::event::KeyCode`, narrowed to what a prompt buffer acts on. */
export type InputKeyCode =
	| { readonly kind: "char"; readonly char: string }
	| { readonly kind: "backspace" }
	| { readonly kind: "delete" }
	| { readonly kind: "left" }
	| { readonly kind: "right" }
	| { readonly kind: "up" }
	| { readonly kind: "down" }
	| { readonly kind: "home" }
	| { readonly kind: "end" }
	| { readonly kind: "enter" }
	| { readonly kind: "esc" }
	| { readonly kind: "tab" }
	| { readonly kind: "pageUp" }
	| { readonly kind: "pageDown" }
	/** Any key this buffer does not act on (F-keys, Insert, …) — `input()` ignores it. */
	| { readonly kind: "other"; readonly name?: string };

/** The key shape {@link InputArea.input} understands — the `crossterm::event::KeyEvent` slice. */
export interface InputKey {
	readonly code: InputKeyCode;
	readonly ctrl: boolean;
	readonly alt: boolean;
	readonly shift: boolean;
}

/** A cursor position, in **code points** (Rust `char` indices), never UTF-16 units. */
export interface InputCursor {
	readonly line: number;
	readonly col: number;
}

export class InputArea {
	/** Code points per row. Always at least one row, as `TextArea::default()` is one empty line. */
	private rows: string[][] = [[]];
	private cursorLine = 0;
	private cursorCol = 0;

	/** pie: mod.rs:2222 — cosmetic; read by a painter, never by behavior. */
	cursorLineStyled = true;
	/** pie: mod.rs:2223 — cosmetic; shown when the buffer is empty. */
	placeholder = "";

	/** `TextArea::lines()`. */
	lines(): string[] {
		return this.rows.map((row) => row.join(""));
	}

	/** The whole buffer, `\n`-joined — oracle spells this `self.input.lines().join("\n")`. */
	text(): string {
		return this.lines().join("\n");
	}

	cursor(): InputCursor {
		return { line: this.cursorLine, col: this.cursorCol };
	}

	/** True for the one-row buffer `input_is_single_line` (mod.rs:1348-1350) tests for. */
	isSingleLine(): boolean {
		return this.rows.length <= 1;
	}

	isEmpty(): boolean {
		return this.rows.length === 1 && this.rows[0].length === 0;
	}

	/**
	 * `TextArea::insert_str` — splits on `\n` so a pasted multi-line block lands as multiple rows,
	 * which is what oracle relies on for `Event::Paste` (mod.rs:713-716).
	 */
	insertStr(text: string): void {
		const chunks = text.split("\n");
		for (let i = 0; i < chunks.length; i++) {
			if (i > 0) this.insertNewline();
			const chars = [...chunks[i]];
			if (chars.length === 0) continue;
			const row = this.rows[this.cursorLine];
			row.splice(this.cursorCol, 0, ...chars);
			this.cursorCol += chars.length;
		}
	}

	/** `TextArea::insert_newline` — splits the current row at the cursor. */
	insertNewline(): void {
		const row = this.rows[this.cursorLine];
		const tail = row.splice(this.cursorCol);
		this.rows.splice(this.cursorLine + 1, 0, tail);
		this.cursorLine += 1;
		this.cursorCol = 0;
	}

	/**
	 * `TextArea::input(key)` — the default arm of oracle's `handle_key` (mod.rs:792-795), which
	 * forwards every key it did not itself claim.
	 *
	 * Keys oracle claims before this point (Enter, Tab, Esc, PageUp/Down, Ctrl-C/D/U/V, and the
	 * arrow keys while single-line) never reach here, so their handling below only matters for the
	 * multi-line case oracle *does* forward (`Up`/`Down` with more than one row).
	 */
	input(key: InputKey): void {
		switch (key.code.kind) {
			case "char":
				// Ctrl/Alt-modified characters are commands, not text; `tui_textarea` maps the ones it
				// knows and drops the rest. None of the ones it knows survive oracle's own match, so
				// dropping them all is the conservative reading.
				if (key.ctrl || key.alt) return;
				this.insertChar(key.code.char);
				return;
			case "backspace":
				this.deleteBackward();
				return;
			case "delete":
				this.deleteForward();
				return;
			case "left":
				this.moveLeft();
				return;
			case "right":
				this.moveRight();
				return;
			case "up":
				this.moveVertical(-1);
				return;
			case "down":
				this.moveVertical(1);
				return;
			case "home":
				this.cursorCol = 0;
				return;
			case "end":
				this.cursorCol = this.rows[this.cursorLine].length;
				return;
			default:
				return;
		}
	}

	private insertChar(char: string): void {
		// A "char" carrying a surrogate pair or a combining sequence still inserts as one unit.
		const chars = [...char];
		if (chars.length === 0) return;
		this.rows[this.cursorLine].splice(this.cursorCol, 0, ...chars);
		this.cursorCol += chars.length;
	}

	private deleteBackward(): void {
		if (this.cursorCol > 0) {
			this.rows[this.cursorLine].splice(this.cursorCol - 1, 1);
			this.cursorCol -= 1;
			return;
		}
		if (this.cursorLine === 0) return;
		const row = this.rows.splice(this.cursorLine, 1)[0];
		this.cursorLine -= 1;
		this.cursorCol = this.rows[this.cursorLine].length;
		this.rows[this.cursorLine].push(...row);
	}

	private deleteForward(): void {
		const row = this.rows[this.cursorLine];
		if (this.cursorCol < row.length) {
			row.splice(this.cursorCol, 1);
			return;
		}
		if (this.cursorLine + 1 >= this.rows.length) return;
		const next = this.rows.splice(this.cursorLine + 1, 1)[0];
		row.push(...next);
	}

	private moveLeft(): void {
		if (this.cursorCol > 0) {
			this.cursorCol -= 1;
			return;
		}
		if (this.cursorLine === 0) return;
		this.cursorLine -= 1;
		this.cursorCol = this.rows[this.cursorLine].length;
	}

	private moveRight(): void {
		if (this.cursorCol < this.rows[this.cursorLine].length) {
			this.cursorCol += 1;
			return;
		}
		if (this.cursorLine + 1 >= this.rows.length) return;
		this.cursorLine += 1;
		this.cursorCol = 0;
	}

	private moveVertical(delta: number): void {
		const next = this.cursorLine + delta;
		if (next < 0 || next >= this.rows.length) return;
		this.cursorLine = next;
		this.cursorCol = Math.min(this.cursorCol, this.rows[next].length);
	}
}

/** pie: mod.rs:2220-2225 (`new_textarea`) — an empty buffer with oracle's placeholder. */
export function newInputArea(): InputArea {
	const area = new InputArea();
	// pie: mod.rs:2222 — `set_cursor_line_style(Style::default())`, i.e. no cursor-line highlight.
	area.cursorLineStyled = false;
	// pie: mod.rs:2223.
	area.placeholder = "type a message, or /help";
	return area;
}
