/**
 * Tests for `src/ui/terminal-driver.ts` — the crossterm/ratatui half of oracle
 * `crates/coding-agent/src/ui/mod.rs:354-366`.
 *
 * Oracle has no `#[cfg(test)]` coverage for this seam at all: on that side the painter *is* ratatui
 * and the event source *is* `crossterm::event::EventStream`, both third-party and both tested
 * upstream. Everything below is therefore net-new coverage of the two things this port had to write
 * itself — turning a `Frame` into bytes, and turning bytes back into a `TuiEvent`.
 *
 * The painter assertions read the ANSI back out (`plain()` strips SGR and CUP), which is the same
 * posture `test/ported/tui-render-e2e.test.ts` takes: assert what a terminal would show, not the
 * byte sequence that gets it there — except where the sequence itself is the contract (the
 * per-row clear, the caret's CUP, ratatui's own SGR codes).
 */

import { describe, expect, it } from "vitest";
import { type Frame, type Rect, splitContent, verticalLayout } from "../../src/ui/app-render.ts";
import type { FeedLine } from "../../src/ui/feed.ts";
import { caretPosition, decodeTerminalInput, keyIdToTuiKey, paintFrame } from "../../src/ui/terminal-driver.ts";

const AREA: Rect = { x: 0, y: 0, width: 40, height: 10 };

const ROW_SPLIT = /\x1b\[\d+;1H\x1b\[K/;
const SGR = /\x1b\[[0-9;?]*[a-zA-Z]/g;

function line(text: string): FeedLine {
	return { text, style: {} };
}

/** A `Frame` built through the real layout code, so the rects are the ones `render` produces. */
function frame(overrides: Partial<Frame> = {}, inputRows: readonly string[] = [""]): Frame {
	const layout = verticalLayout(AREA, Math.min(Math.max(inputRows.length, 1), 10));
	const { feed: feedArea } = splitContent(layout.content, false);
	return {
		layout,
		feedArea,
		feedLines: [],
		feedTotal: 0,
		maxScroll: 0,
		statusText: "pie · faux:model · ready",
		inputRows,
		hintText: "Enter send",
		...overrides,
	};
}

/** Drop every SGR and cursor-position escape, then split the painted rows apart. */
function plain(painted: string): string[] {
	return painted
		.split(new RegExp(ROW_SPLIT, "g"))
		.slice(1)
		.map((row) => row.replace(SGR, ""));
}

describe("paintFrame — mod.rs:1465-1564", () => {
	it("emits exactly one absolutely-placed, cleared row per terminal line", () => {
		const painted = paintFrame(frame(), AREA);
		expect(plain(painted)).toHaveLength(AREA.height);
		// Absolute placement + clear-to-EOL rather than a full erase, so a redraw does not flash.
		expect(painted.startsWith("\x1b[1;1H\x1b[K")).toBe(true);
		expect(painted).toContain("\x1b[10;1H\x1b[K");
	});

	it("paints the feed at the top and the status/hint rows at oracle's offsets", () => {
		const painted = frame({ feedLines: [line("hello world"), line("second")] });
		const rows = plain(paintFrame(painted, AREA));
		expect(rows[0]).toBe("hello world");
		expect(rows[1]).toBe("second");
		// pie: mod.rs:1468-1476 — status, then the bordered input box (input rows + 2), then the hint.
		expect(rows[painted.layout.status.y]).toBe("pie · faux:model · ready");
		expect(rows[painted.layout.hint.y]).toBe("Enter send");
	});

	it("draws the input box border and oracle's `> ` prompt column (mod.rs:1518-1545)", () => {
		const painted = frame({}, ["type here"]);
		const rows = plain(paintFrame(painted, AREA));
		const box = painted.layout.input;
		expect(rows[box.y]).toBe(`┌${"─".repeat(AREA.width - 2)}┐`);
		expect(rows[box.y + 1]).toBe(`│> type here${" ".repeat(AREA.width - 13)}│`);
		expect(rows[box.y + box.height - 1]).toBe(`└${"─".repeat(AREA.width - 2)}┘`);
	});

	it("styles a feed row with ratatui's own SGR codes and resets after it", () => {
		const painted = paintFrame(frame({ feedLines: [{ text: "user", style: { fg: "cyan", bold: true } }] }), AREA);
		// `Modifier::BOLD` is SGR 1, `Color::Cyan` is SGR 36 — in that order, in one sequence.
		expect(painted).toContain("\x1b[1;36muser");
		expect(painted).toContain("\x1b[0m");
	});

	it("clears an overlay's rect so the feed cannot bleed through (mod.rs:1567-1653)", () => {
		const base = frame({ feedLines: [line("X".repeat(40)), line("X".repeat(40)), line("X".repeat(40))] });
		const overlay = {
			rect: { x: 2, y: 0, width: 20, height: 4 },
			title: " Confirm ",
			borderColor: "yellow" as const,
			lines: [line("Action: run"), line("Enter/Y approve")],
		};
		const rows = plain(paintFrame({ ...base, controlPlanePrompt: overlay }, AREA));
		// The overlay replaces the feed inside its rect; the feed survives on both sides of it.
		expect(rows[0]).toBe(`XX┌${" Confirm ".padEnd(18, "─")}┐${"X".repeat(18)}`);
		expect(rows[1]).toBe(`XX│Action: run       │${"X".repeat(18)}`);
		expect(rows[2]).toBe(`XX│Enter/Y approve   │${"X".repeat(18)}`);
	});

	it("clips a row to the frame width and keeps a wide character aligned", () => {
		const rows = plain(paintFrame(frame({ feedLines: [line("宽".repeat(30))] }), AREA));
		// 20 double-width graphemes fill exactly 40 columns; the rest is dropped, not wrapped.
		expect(rows[0]).toBe("宽".repeat(20));
	});

	it("returns nothing for a zero-sized terminal rather than throwing", () => {
		expect(paintFrame(frame(), { x: 0, y: 0, width: 0, height: 0 })).toBe("");
	});
});

describe("caretPosition", () => {
	it("parks the caret after the last input row, inside the box and past the prompt column", () => {
		const painted = frame({}, ["abc"]);
		const caret = caretPosition(painted);
		// 1-based CUP: box border (1) + prompt column (2) + "abc" (3), then one past.
		expect(caret.column).toBe(painted.layout.input.x + 1 + 2 + 3 + 1);
		expect(caret.row).toBe(painted.layout.input.y + 2);
	});
});

describe("keyIdToTuiKey", () => {
	it("splits modifiers off a `KeyId` and keeps the base name", () => {
		expect(keyIdToTuiKey("ctrl+c", "press")).toEqual({
			code: { kind: "char", char: "c" },
			ctrl: true,
			alt: false,
			shift: false,
			kind: "press",
		});
		expect(keyIdToTuiKey("ctrl+alt+x", "press")).toMatchObject({ ctrl: true, alt: true, shift: false });
		expect(keyIdToTuiKey("shift+tab", "press")).toMatchObject({ code: { kind: "tab" }, shift: true });
	});

	it("maps every named key `InputArea` acts on", () => {
		expect(keyIdToTuiKey("enter", "press").code).toEqual({ kind: "enter" });
		expect(keyIdToTuiKey("escape", "press").code).toEqual({ kind: "esc" });
		expect(keyIdToTuiKey("pageUp", "press").code).toEqual({ kind: "pageUp" });
		expect(keyIdToTuiKey("space", "press").code).toEqual({ kind: "char", char: " " });
	});

	it("falls through to `other` for a key neither side models (RULEBOOK §8)", () => {
		expect(keyIdToTuiKey("f7", "press").code).toEqual({ kind: "other", name: "f7" });
	});
});

describe("decodeTerminalInput — mod.rs:702-722", () => {
	it("decodes a typed character and Enter", () => {
		expect(decodeTerminalInput("a")).toEqual([
			{
				type: "key",
				key: { code: { kind: "char", char: "a" }, ctrl: false, alt: false, shift: false, kind: "press" },
			},
		]);
		expect(decodeTerminalInput("\r")[0]).toMatchObject({ type: "key", key: { code: { kind: "enter" } } });
	});

	it("decodes a non-ASCII grapheme `parseKey` does not answer for", () => {
		expect(decodeTerminalInput("宽")).toEqual([
			{
				type: "key",
				key: { code: { kind: "char", char: "宽" }, ctrl: false, alt: false, shift: false, kind: "press" },
			},
		]);
	});

	it("unwraps a bracketed paste into a paste event", () => {
		expect(decodeTerminalInput("\x1b[200~two\nlines\x1b[201~")).toEqual([{ type: "paste", text: "two\nlines" }]);
	});

	it("decodes SGR wheel events to the 0-based coordinates `mouse_in_feed` compares against", () => {
		expect(decodeTerminalInput("\x1b[<64;10;5M")).toEqual([{ type: "mouse", kind: "scrollUp", column: 9, row: 4 }]);
		expect(decodeTerminalInput("\x1b[<65;1;1M")).toEqual([{ type: "mouse", kind: "scrollDown", column: 0, row: 0 }]);
		// A press/drag is neither wheel direction; `handle_mouse_scroll` ignores it.
		expect(decodeTerminalInput("\x1b[<0;3;3M")).toEqual([{ type: "mouse", kind: "other", column: 2, row: 2 }]);
	});

	it("drops an unmodelled control sequence rather than typing it into the buffer", () => {
		expect(decodeTerminalInput("\x1b[?1004;1$y")).toEqual([]);
		expect(decodeTerminalInput("")).toEqual([]);
	});
});
