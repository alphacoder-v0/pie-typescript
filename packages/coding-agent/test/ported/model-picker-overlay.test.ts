/**
 * Port of the model-picker UI tests in oracle `crates/coding-agent/src/ui/mod.rs:3327-3410`
 * (`model_picker_keys_are_modal_and_navigate`, `model_picker_esc_at_model_level_returns_to_
 * provider_level`, `model_picker_enter_descends_then_switches_model`,
 * `model_picker_renders_centered_overlay`), plus `commands.rs:927-939` (`parse_model_spec`).
 *
 * Construct mapping notes:
 * - Oracle drives `App::handle_model_picker_key(&KeyEvent)` and asserts on `app.model_picker`
 *   being `Some`/`None`. TS's overlay owns no App field — closing is a callback — so the
 *   equivalent observable is {@link modelPickerAction}'s returned `PickerAction`, which is exactly
 *   what oracle's `match action` switches on (ui/mod.rs:897-905).
 * - `model_picker_enter_descends_then_switches_model` additionally asserts the harness swapped
 *   models and the feed printed the spec. That half is the caller's (`setModelFromSpec` in
 *   `interactive-mode.ts`); here the assertion stops at the emitted spec string, and
 *   {@link parseModelSpec} is covered directly so the spec→model hop is not untested.
 * - `model_picker_renders_centered_overlay` uses ratatui's `TestBackend` buffer; TS's
 *   `Component.render(width)` already returns the lines, so the same substrings are asserted
 *   against the joined output (ANSI stripped).
 */

import { beforeAll, describe, expect, test } from "vitest";
import { parseModelSpec } from "../../src/core/slash-commands.ts";
import { ModelPickerState, type ProviderGroup } from "../../src/model-picker.ts";
import {
	ModelPickerOverlayComponent,
	modelPickerAction,
} from "../../src/modes/interactive/components/model-picker-overlay.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";

/** ui/mod.rs:3311-3325 (`picker_groups`). */
function pickerGroups(): ProviderGroup[] {
	return [
		{
			provider: "anthropic",
			hasCredential: true,
			models: [{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5" }],
		},
	];
}

const KEY_DOWN = "\x1b[B";
const KEY_UP = "\x1b[A";
const KEY_ENTER = "\r";
const KEY_ESC = "\x1b";
const KEY_CTRL_C = "\x03";

/** Built at runtime so the ESC byte never appears as a literal control char in the source. */
const ANSI_SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function stripAnsi(text: string): string {
	return text.replace(ANSI_SGR, "");
}

describe("model picker overlay key handling (ui/mod.rs:857-905)", () => {
	// ui/mod.rs:3326-3341
	test("navigation keys are consumed and Esc at the top level closes", () => {
		const state = new ModelPickerState(pickerGroups());
		expect(modelPickerAction(state, KEY_DOWN)).toEqual({ kind: "none" });
		expect(modelPickerAction(state, KEY_ESC)).toEqual({ kind: "close" });
	});

	// ui/mod.rs:864-869,891-893 — ctrl+c closes outright, at any level.
	test("ctrl+c closes", () => {
		const state = new ModelPickerState(pickerGroups());
		expect(modelPickerAction(state, KEY_CTRL_C)).toEqual({ kind: "close" });
		state.enter();
		expect(modelPickerAction(state, KEY_CTRL_C)).toEqual({ kind: "close" });
	});

	// ui/mod.rs:3343-3367
	test("Esc at model level returns to provider level without closing", () => {
		const state = new ModelPickerState(pickerGroups());
		expect(modelPickerAction(state, KEY_ENTER)).toEqual({ kind: "none" });
		expect(state.level).toEqual({ kind: "models", providerIdx: 0 });
		expect(modelPickerAction(state, KEY_ESC)).toEqual({ kind: "none" });
		expect(state.level).toEqual({ kind: "providers" });
	});

	// ui/mod.rs:3369-3394
	test("Enter descends then selects the model spec", () => {
		const state = new ModelPickerState(pickerGroups());
		expect(modelPickerAction(state, KEY_ENTER)).toEqual({ kind: "none" });
		expect(modelPickerAction(state, KEY_ENTER)).toEqual({
			kind: "select",
			spec: "anthropic:claude-haiku-4-5",
		});
	});

	// ui/mod.rs:872-879 — `KeyCode::Char('k')` / `Char('j')` are aliases for Up / Down.
	test("j and k mirror Down and Up", () => {
		const groups: ProviderGroup[] = [
			{ provider: "a", hasCredential: true, models: [{ id: "one", name: "One" }] },
			{ provider: "b", hasCredential: true, models: [{ id: "two", name: "Two" }] },
		];
		const state = new ModelPickerState(groups);
		modelPickerAction(state, "j");
		expect(state.cursor).toBe(1);
		modelPickerAction(state, "k");
		expect(state.cursor).toBe(0);
		modelPickerAction(state, KEY_DOWN);
		expect(state.cursor).toBe(1);
		modelPickerAction(state, KEY_UP);
		expect(state.cursor).toBe(0);
	});

	// ui/mod.rs:904 — anything unmapped is `PickerAction::None`.
	test("unmapped keys are inert", () => {
		const state = new ModelPickerState(pickerGroups());
		expect(modelPickerAction(state, "z")).toEqual({ kind: "none" });
		expect(state.level).toEqual({ kind: "providers" });
		expect(state.cursor).toBe(0);
	});

	test("handleInput routes close and select to the callbacks", () => {
		const selected: string[] = [];
		let closed = 0;
		const state = new ModelPickerState(pickerGroups());
		const component = new ModelPickerOverlayComponent(
			state,
			(spec) => selected.push(spec),
			() => {
				closed += 1;
			},
		);
		component.handleInput(KEY_ENTER); // descend, no callback
		expect(selected).toEqual([]);
		expect(closed).toBe(0);
		component.handleInput(KEY_ENTER); // select
		expect(selected).toEqual(["anthropic:claude-haiku-4-5"]);
		// The state machine itself does not unwind on select (oracle drops the whole picker
		// instead), so Esc still walks models -> providers -> close from here.
		component.handleInput(KEY_ESC); // models -> providers
		expect(closed).toBe(0);
		component.handleInput(KEY_ESC); // providers -> close
		expect(closed).toBe(1);
	});
});

describe("model picker overlay rendering (ui/mod.rs:1567-1601)", () => {
	// `theme` is a lazily-initialized global proxy; rendering touches it.
	beforeAll(() => {
		initTheme("dark");
	});

	// ui/mod.rs:3396-3410
	test("renders the provider level with the oracle's title and row text", () => {
		const state = new ModelPickerState(pickerGroups());
		const component = new ModelPickerOverlayComponent(
			state,
			() => {},
			() => {},
		);
		const text = stripAnsi(component.render(80).join("\n"));
		expect(text).toContain("Select model");
		expect(text).toContain("Select provider");
		expect(text).toContain("anthropic (1)");
		expect(text).toContain("↑↓/jk navigate · Enter select · Esc back");
	});

	// model_picker.rs:169-176 — the active model is marked `●`, and the selected row gets `❯ `.
	test("renders the model level with the active marker and the cursor prefix", () => {
		const state = new ModelPickerState(pickerGroups(), { provider: "anthropic", id: "claude-haiku-4-5" });
		state.enter();
		const component = new ModelPickerOverlayComponent(
			state,
			() => {},
			() => {},
		);
		const text = stripAnsi(component.render(80).join("\n"));
		expect(text).toContain("anthropic models");
		expect(text).toContain("❯ claude-haiku-4-5 ●");
	});

	// ui/mod.rs:1571 — `area.width.clamp(40, 64)`: a narrow terminal still gets a 40-wide box, a
	// wide one is capped at 64.
	test("box width is clamped to 40..64", () => {
		const component = new ModelPickerOverlayComponent(
			new ModelPickerState(pickerGroups()),
			() => {},
			() => {},
		);
		expect(stripAnsi(component.render(200).join("\n")).split("\n")[0]).toHaveLength(64);
		expect(stripAnsi(component.render(10).join("\n")).split("\n")[0]).toHaveLength(40);
	});
});

describe("parseModelSpec (commands.rs:927-939)", () => {
	test("splits on the first colon, then slash, then whitespace", () => {
		expect(parseModelSpec("anthropic:claude-haiku-4-5")).toEqual({
			provider: "anthropic",
			id: "claude-haiku-4-5",
		});
		expect(parseModelSpec("openai/gpt-5.2")).toEqual({ provider: "openai", id: "gpt-5.2" });
		expect(parseModelSpec("openai gpt-5.2")).toEqual({ provider: "openai", id: "gpt-5.2" });
		// `split_once` keeps everything after the FIRST separator.
		expect(parseModelSpec("ollama:llama3:70b")).toEqual({ provider: "ollama", id: "llama3:70b" });
		// `:` wins over `/` even when the slash comes first.
		expect(parseModelSpec("a/b:c")).toEqual({ provider: "a/b", id: "c" });
	});

	test("rejects specs with an empty half or no separator", () => {
		expect(parseModelSpec("")).toBeUndefined();
		expect(parseModelSpec("anthropic")).toBeUndefined();
		expect(parseModelSpec(":claude")).toBeUndefined();
		expect(parseModelSpec("anthropic:")).toBeUndefined();
		expect(parseModelSpec("  anthropic : claude  ")).toEqual({ provider: "anthropic", id: "claude" });
	});
});
