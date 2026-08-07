/**
 * Tests for the oracle `--resume` picker logic diff-ported into `cli/session-picker.ts`.
 *
 * Ported from the Rust unit tests in oracle crates/coding-agent/src/resume_picker.rs:231-337,
 * plus coverage for the selection state machine and terminal-geometry rules that oracle only
 * exercises inside the crossterm loop (`pick_blocking`).
 *
 * No terminal is started: every assertion runs against pure functions.
 */

import { describe, expect, test } from "vitest";
import {
	applyPickerAction,
	entryCount,
	keyAction,
	type PickerAction,
	type PickerKeyEvent,
	type PickerRow,
	pickerFrame,
	pickerKeyFromInput,
	renderLines,
	SELECTED_PREFIX,
	truncateLine,
	visibleWindow,
} from "../src/cli/session-picker.ts";

function row(id: string): PickerRow {
	return { idShort: id, createdAt: "2026-06-11T03:43", preview: `preview for ${id}` };
}

function key(code: string, extra: Partial<PickerKeyEvent> = {}): PickerKeyEvent {
	return { code, ...extra };
}

// ============================================================================
// visibleWindow (resume_picker.rs:55-68)
// ============================================================================

describe("visibleWindow", () => {
	// resume_picker.rs:249-253
	test("shows everything when it fits", () => {
		expect(visibleWindow(0, 5, 10)).toEqual({ start: 0, end: 5 });
		expect(visibleWindow(4, 5, 10)).toEqual({ start: 0, end: 5 });
	});

	// resume_picker.rs:255-265
	test("follows the selection through long lists", () => {
		// Selection at top: window starts at 0.
		expect(visibleWindow(0, 100, 10)).toEqual({ start: 0, end: 10 });
		// Selection below the fold: window slides so the selection is visible.
		const mid = visibleWindow(50, 100, 10);
		expect(mid.start).toBeLessThanOrEqual(50);
		expect(mid.end).toBeGreaterThan(50);
		expect(mid.end - mid.start).toBe(10);
		// Selection at the very end: window pins to the tail.
		expect(visibleWindow(99, 100, 10)).toEqual({ start: 90, end: 100 });
	});

	// resume_picker.rs:58 -- `height.max(1)`.
	test("clamps a zero height to one row", () => {
		expect(visibleWindow(3, 100, 0)).toEqual({ start: 3, end: 4 });
	});

	// resume_picker.rs:63-66 -- `.min(selected)` keeps the selection from scrolling off the top.
	test("never starts the window below the selection", () => {
		const w = visibleWindow(1, 100, 10);
		expect(w.start).toBeLessThanOrEqual(1);
		expect(w).toEqual({ start: 0, end: 10 });
	});
});

// ============================================================================
// renderLines / truncateLine (resume_picker.rs:70-133)
// ============================================================================

describe("renderLines", () => {
	// resume_picker.rs:267-304
	test("marks the selection and shows badges and scroll indicators", () => {
		const rows = Array.from({ length: 20 }, (_, i) => row(`session-${String(i).padStart(2, "0")}`));
		rows[0] = { ...rows[0], badge: "2 cron, 1 trigger" };

		// Clean row selected: it carries the marker, first session does not.
		let lines = renderLines(rows, 0, 100, 5);
		let joined = lines.join("\n");
		expect(joined).toContain("start a new session");
		expect(lines.some((l) => l.includes(SELECTED_PREFIX) && l.includes("start a new session"))).toBe(true);
		expect(joined).toContain("[2 cron, 1 trigger]");
		expect(joined).toContain("more below");

		// Selecting deep in the list keeps the selection on screen -- the newest-first top rows
		// scroll away instead of the selection.
		lines = renderLines(rows, 15, 100, 5);
		joined = lines.join("\n");
		expect(joined).toContain("session-14");
		expect(lines.some((l) => l.includes(SELECTED_PREFIX) && l.includes("session-14"))).toBe(true);
		expect(joined).toContain("more above");
	});

	// resume_picker.rs:306-315
	test("truncates every line to the terminal width", () => {
		const long: PickerRow = { ...row("session-00"), preview: "x".repeat(500) };
		const lines = renderLines([long], 0, 60, 5);
		expect(lines.every((l) => Array.from(l).length <= 60)).toBe(true);
	});

	// resume_picker.rs:77-83 -- header counts session rows, not entries.
	test("header reports the session count, excluding the pinned clean row", () => {
		const lines = renderLines([row("a"), row("b")], 0, 100, 10);
		expect(lines[0]).toBe("resume a session (2 total) — ↑/↓ move · Enter select · q cancel");
	});

	// resume_picker.rs:93-107 -- exact entry body layout, badge included.
	test("renders the exact entry layout", () => {
		const rows: PickerRow[] = [
			{ idShort: "0197abc", createdAt: "2026-06-11T03:43", preview: "hello", badge: "1 cron" },
			{ idShort: "0197def", createdAt: "2026-06-10T09:01", preview: "world" },
		];
		const lines = renderLines(rows, 1, 200, 10);
		expect(lines).toEqual([
			"resume a session (2 total) — ↑/↓ move · Enter select · q cancel",
			"  ✚ start a new session",
			"\x1b[7m→ 0197abc  2026-06-11T03:43  [1 cron]  hello\x1b[0m",
			"  0197def  2026-06-10T09:01  world",
		]);
	});

	// resume_picker.rs:84-86,117-122 -- both scroll indicators, with counts.
	test("reports how many entries are above and below the window", () => {
		const rows = Array.from({ length: 20 }, (_, i) => row(`s${i}`));
		const lines = renderLines(rows, 10, 100, 5);
		// total = 21 entries, height 5, selected 10 -> window [8, 13)
		expect(lines[1]).toBe("  … 8 more above");
		expect(lines[lines.length - 1]).toBe("  … 8 more below");
	});

	// resume_picker.rs:108-115 -- the escape codes are added after truncation.
	test("wraps only the selected line in reverse video, outside the width budget", () => {
		const lines = renderLines([row("session-00")], 1, 20, 10);
		const selected = lines.find((l) => l.startsWith("\x1b[7m"));
		expect(selected).toBeDefined();
		expect(selected!.endsWith("\x1b[0m")).toBe(true);
		// Visible payload obeys the width; the escapes do not count against it.
		const visible = selected!.slice("\x1b[7m".length, -"\x1b[0m".length);
		expect(Array.from(visible).length).toBe(20);
	});
});

describe("truncateLine", () => {
	// resume_picker.rs:126-133
	test("returns the line untouched when it fits", () => {
		expect(truncateLine("abc", 3)).toBe("abc");
		expect(truncateLine("abc", 10)).toBe("abc");
	});

	test("cuts to width-1 characters and appends an ellipsis", () => {
		expect(truncateLine("abcdef", 4)).toBe("abc…");
		expect(truncateLine("abcdef", 1)).toBe("…");
	});

	// Rust counts `chars()`, i.e. Unicode scalar values, not UTF-16 code units.
	test("counts code points, not UTF-16 units", () => {
		expect(truncateLine("中中中", 3)).toBe("中中中");
		expect(truncateLine("中中中中", 3)).toBe("中中…");
	});
});

// ============================================================================
// entryCount + key mapping (resume_picker.rs:50-53, 135-153)
// ============================================================================

describe("entryCount", () => {
	test("adds the pinned clean row", () => {
		expect(entryCount(0)).toBe(1);
		expect(entryCount(7)).toBe(8);
	});
});

describe("keyAction", () => {
	// resume_picker.rs:317-336
	test("maps keys to actions", () => {
		expect(keyAction(key("up"))).toBe("up");
		expect(keyAction(key("k"))).toBe("up");
		expect(keyAction(key("down"))).toBe("down");
		expect(keyAction(key("j"))).toBe("down");
		expect(keyAction(key("enter"))).toBe("select");
		expect(keyAction(key("escape"))).toBe("cancel");
		expect(keyAction(key("q"))).toBe("cancel");
		expect(keyAction(key("home"))).toBe("home");
		expect(keyAction(key("end"))).toBe("end");
		expect(keyAction(key("pageUp"))).toBe("pageUp");
		expect(keyAction(key("pageDown"))).toBe("pageDown");
		expect(keyAction(key("c", { ctrl: true }))).toBe("cancel");
	});

	// resume_picker.rs:332-335 -- key release events (kitty protocol) must not double-fire.
	test("ignores key release events", () => {
		expect(keyAction(key("down", { kind: "release" }))).toBe("none");
		expect(keyAction(key("c", { ctrl: true, kind: "release" }))).toBe("none");
	});

	test("unmapped keys are inert", () => {
		expect(keyAction(key("x"))).toBe("none");
		expect(keyAction(key("tab"))).toBe("none");
		expect(keyAction(key("a", { ctrl: true }))).toBe("none");
	});
});

describe("pickerKeyFromInput", () => {
	test("maps raw terminal input through to actions", () => {
		const cases: Array<[string, PickerAction]> = [
			["\x1b[A", "up"],
			["\x1b[B", "down"],
			["\x1b[5~", "pageUp"],
			["\x1b[6~", "pageDown"],
			["\x1b[H", "home"],
			["\x1b[F", "end"],
			["\r", "select"],
			["\x1b", "cancel"],
			["q", "cancel"],
			["\x03", "cancel"],
			["k", "up"],
			["j", "down"],
		];
		for (const [data, expected] of cases) {
			const event = pickerKeyFromInput(data);
			expect(event, data).toBeDefined();
			expect(keyAction(event!), data).toBe(expected);
		}
	});

	test("kitty release sequences resolve to no action", () => {
		const event = pickerKeyFromInput("\x1b[106;1:3u");
		expect(event).toEqual({ code: "j", ctrl: false, kind: "release" });
		expect(keyAction(event!)).toBe("none");
	});

	test("returns undefined for input that is not a key", () => {
		expect(pickerKeyFromInput("\x1b[200~pasted")).toBeUndefined();
	});
});

// ============================================================================
// applyPickerAction -- the pick_blocking selection loop (resume_picker.rs:192-208)
// ============================================================================

describe("applyPickerAction", () => {
	const total = entryCount(20); // 21 entries: clean row + 20 sessions

	test("up and down move one entry and saturate at the ends", () => {
		expect(applyPickerAction(5, "down", total)).toEqual({ kind: "selected", selected: 6 });
		expect(applyPickerAction(5, "up", total)).toEqual({ kind: "selected", selected: 4 });
		expect(applyPickerAction(0, "up", total)).toEqual({ kind: "selected", selected: 0 });
		expect(applyPickerAction(total - 1, "down", total)).toEqual({ kind: "selected", selected: total - 1 });
	});

	test("page keys move ten entries and saturate at the ends", () => {
		expect(applyPickerAction(0, "pageDown", total)).toEqual({ kind: "selected", selected: 10 });
		expect(applyPickerAction(15, "pageDown", total)).toEqual({ kind: "selected", selected: total - 1 });
		expect(applyPickerAction(12, "pageUp", total)).toEqual({ kind: "selected", selected: 2 });
		expect(applyPickerAction(3, "pageUp", total)).toEqual({ kind: "selected", selected: 0 });
	});

	test("home and end jump to the ends", () => {
		expect(applyPickerAction(9, "home", total)).toEqual({ kind: "selected", selected: 0 });
		expect(applyPickerAction(9, "end", total)).toEqual({ kind: "selected", selected: total - 1 });
	});

	// resume_picker.rs:199-205 -- index 0 is the pinned clean row; the rest are offset by one.
	test("select on the pinned row starts a clean session", () => {
		expect(applyPickerAction(0, "select", total)).toEqual({ kind: "done", choice: { kind: "clean" } });
	});

	test("select on a session row resumes the caller's index minus the pinned row", () => {
		expect(applyPickerAction(1, "select", total)).toEqual({
			kind: "done",
			choice: { kind: "resume", index: 0 },
		});
		expect(applyPickerAction(total - 1, "select", total)).toEqual({
			kind: "done",
			choice: { kind: "resume", index: 19 },
		});
	});

	test("cancel ends the loop, unmapped keys leave the selection alone", () => {
		expect(applyPickerAction(4, "cancel", total)).toEqual({ kind: "done", choice: { kind: "cancelled" } });
		expect(applyPickerAction(4, "none", total)).toEqual({ kind: "selected", selected: 4 });
	});

	test("a full key-driven walk lands on the expected session", () => {
		let selected = 0;
		for (const data of ["\x1b[B", "\x1b[B", "j", "\x1b[A"]) {
			const step = applyPickerAction(selected, keyAction(pickerKeyFromInput(data)!), total);
			expect(step.kind).toBe("selected");
			if (step.kind === "selected") selected = step.selected;
		}
		expect(selected).toBe(2);
		expect(applyPickerAction(selected, keyAction(pickerKeyFromInput("\r")!), total)).toEqual({
			kind: "done",
			choice: { kind: "resume", index: 1 },
		});
	});
});

// ============================================================================
// pickerFrame -- terminal geometry rules (resume_picker.rs:166-173)
// ============================================================================

describe("pickerFrame", () => {
	const rows = Array.from({ length: 50 }, (_, i) => row(`s${i}`));

	// resume_picker.rs:167-170 -- degenerate pseudo-terminal sizes fall back to 100x30.
	test("falls back to a sane size for degenerate terminals", () => {
		expect(pickerFrame(rows, 0, 0, 0).width).toBe(100);
		expect(pickerFrame(rows, 0, 39, 4).width).toBe(100);
		expect(pickerFrame(rows, 0, 40, 5).width).toBe(40);
		// rows < 5 -> 30 rows -> height 26
		expect(pickerFrame(rows, 0, 100, 4).height).toBe(26);
	});

	// resume_picker.rs:171-172 -- height = rows - 4, clamped to [1, 30].
	test("reserves four rows for chrome and clamps the height", () => {
		expect(pickerFrame(rows, 0, 100, 10).height).toBe(6);
		expect(pickerFrame(rows, 0, 100, 5).height).toBe(1);
		expect(pickerFrame(rows, 0, 100, 200).height).toBe(30);
	});

	test("lines match renderLines for the derived geometry", () => {
		const frame = pickerFrame(rows, 3, 100, 12);
		expect(frame.lines).toEqual(renderLines(rows, 3, 100, 8));
	});
});
