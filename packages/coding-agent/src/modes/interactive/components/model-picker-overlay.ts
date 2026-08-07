/**
 * TUI overlay driving {@link ModelPickerState} — the phase-14 half of `src/model-picker.ts`'s
 * "TUI overlay and web dropdown" (the state machine itself was ported in an earlier unit and is
 * NOT touched here).
 *
 * Port of oracle `crates/coding-agent/src/ui/mod.rs`:
 * - `render_model_picker` (ui/mod.rs:1567-1601): centered box titled `" Select model "`, a yellow
 *   title line, a blank line, one row per window entry (`❯ ` prefix + cyan when selected, two
 *   spaces otherwise), and a dark-gray footer hint.
 * - `handle_model_picker_key` (ui/mod.rs:857-905): Up/`k` → {@link ModelPickerState.up},
 *   Down/`j` → {@link ModelPickerState.down}, Enter → {@link ModelPickerState.enter} (a returned
 *   spec closes the overlay and switches the model), Esc → {@link ModelPickerState.back} (`true`
 *   closes), ctrl+c → close. Key-RELEASE events are swallowed (`key.kind == KeyEventKind::Release`
 *   returns early); base's `Component.wantsKeyRelease` defaults to `false`, so the TUI filters
 *   them before `handleInput` is ever called — same observable behavior, one layer up.
 *
 * Construct mapping notes:
 * - ratatui `Frame`/`Paragraph`/`Block` → this repo's line-array `Component.render(width)`, so the
 *   box chrome is drawn explicitly. Oracle's `centered_rect(area, width.clamp(40,64),
 *   height.clamp(8,18))` becomes the overlay-placement options the caller passes to
 *   `TUI.showOverlay` plus {@link MAX_VISIBLE_ROWS} here; the "borders (2) + title line + blank +
 *   footer = 5 rows of chrome" arithmetic (ui/mod.rs:1574) is reproduced verbatim.
 * - ratatui `Style::fg(Color::Yellow | Cyan | DarkGray)` → the repo theme's closest roles
 *   (`warning` / `accent` / `dim`), since this port renders through the shared theme rather than
 *   hardcoded ANSI colors.
 */

import { matchesKey } from "@pie/tui";
import type { ModelPickerState } from "../../../model-picker.ts";
import { theme } from "../theme/theme.ts";

/** ui/mod.rs:1571 — `area.width.clamp(40, 64)`. */
export const MIN_WIDTH = 40;
export const MAX_WIDTH = 64;
/** ui/mod.rs:1572 — `area.height.clamp(8, 18)`. */
export const MAX_HEIGHT = 18;
/** ui/mod.rs:1574 — box height minus "borders (2) + title line + blank + footer". */
export const MAX_VISIBLE_ROWS = MAX_HEIGHT - 5;
/** ui/mod.rs:1592-1595 */
const FOOTER_HINT = "↑↓/jk navigate · Enter select · Esc back";
/** ui/mod.rs:1598 */
const BOX_TITLE = " Select model ";

/** What {@link ModelPickerOverlayComponent.handleInput} decided, mirroring oracle's `PickerAction`. */
export type ModelPickerAction = { kind: "none" } | { kind: "close" } | { kind: "select"; spec: string };

/**
 * ui/mod.rs:857-905 — the pure key→action half, extracted so it is testable without a terminal.
 * Returns oracle's `PickerAction`; unmapped keys are `none` (oracle's `_ => PickerAction::None`).
 */
export function modelPickerAction(state: ModelPickerState, data: string): ModelPickerAction {
	// ui/mod.rs:891-893 — ctrl+c closes. Checked before the printable branches because some
	// terminals deliver control characters that would otherwise fall through.
	if (matchesKey(data, "ctrl+c")) return { kind: "close" };
	if (matchesKey(data, "up") || data === "k") {
		state.up();
		return { kind: "none" };
	}
	if (matchesKey(data, "down") || data === "j") {
		state.down();
		return { kind: "none" };
	}
	if (matchesKey(data, "enter")) {
		const spec = state.enter();
		return spec === undefined ? { kind: "none" } : { kind: "select", spec };
	}
	if (matchesKey(data, "escape")) {
		return state.back() ? { kind: "close" } : { kind: "none" };
	}
	return { kind: "none" };
}

export class ModelPickerOverlayComponent {
	private readonly state: ModelPickerState;
	private readonly onSelect: (spec: string) => void;
	private readonly onClose: () => void;

	constructor(state: ModelPickerState, onSelect: (spec: string) => void, onClose: () => void) {
		this.state = state;
		this.onSelect = onSelect;
		this.onClose = onClose;
	}

	invalidate(): void {
		// No cached render state.
	}

	/** ui/mod.rs:1567-1601 (`render_model_picker`). */
	render(width: number): string[] {
		const boxWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width));
		const inner = Math.max(1, boxWidth - 2);
		const { title, rows } = this.state.view(MAX_VISIBLE_ROWS);

		const lines: string[] = [];
		lines.push(theme.fg("accent", `┌${padTitle(BOX_TITLE, inner)}┐`));
		const clippedTitle = clip(title, inner - 2);
		lines.push(boxed(theme.fg("warning", clippedTitle), clippedTitle, inner));
		lines.push(boxed("", "", inner));
		for (const row of rows) {
			const raw = row.selected ? `❯ ${row.text}` : `  ${row.text}`;
			const clipped = clip(raw, inner - 2);
			lines.push(boxed(row.selected ? theme.fg("accent", clipped) : clipped, clipped, inner));
		}
		const hint = clip(FOOTER_HINT, inner - 2);
		lines.push(boxed(theme.fg("dim", hint), hint, inner));
		lines.push(theme.fg("accent", `└${"─".repeat(inner)}┘`));
		return lines;
	}

	handleInput(data: string): void {
		const action = modelPickerAction(this.state, data);
		// ui/mod.rs:897-905 — `Close` clears the picker; `Select` clears it FIRST, then switches.
		if (action.kind === "close") this.onClose();
		else if (action.kind === "select") this.onSelect(action.spec);
	}
}

/** ` text ` laid into the top border, oracle's `Block::title(" Select model ")`. */
function padTitle(title: string, inner: number): string {
	const clipped = clip(title, inner);
	return `${clipped}${"─".repeat(Math.max(0, inner - visibleLength(clipped)))}`;
}

/** One `│ … │` row; `styled` carries ANSI, `plain` is what the width math measures. */
function boxed(styled: string, plain: string, inner: number): string {
	const pad = " ".repeat(Math.max(0, inner - 2 - visibleLength(plain)));
	const border = theme.fg("accent", "│");
	return `${border} ${styled}${pad} ${border}`;
}

function clip(text: string, max: number): string {
	if (max <= 0) return "";
	const chars = Array.from(text);
	return chars.length <= max ? text : chars.slice(0, max).join("");
}

function visibleLength(text: string): number {
	return Array.from(text).length;
}
