/**
 * Characterization tests for `/help <topic>` rendering.
 * pie: crates/coding-agent/src/commands.rs — `help_text` (:1141-1151) →
 * `command_help_text` (:1203-1262); oracle tests `help_topic_renders_command_usage_and_aliases`
 * (:3337-3358) and `help_unknown_topic_gives_recovery_hint` (:3360-3366).
 *
 * ## Why this file exists (phase 21 batch A, two real gaps)
 *
 * `ported/commands.test.ts:105` asserts the `usage` **field values**
 * (`findPieCommand("model")?.usage === "[provider:model-id|list [provider]]"`). That is not what
 * the oracle tests assert. Oracle asserts the **rendered topic-help string** — that
 * `help_text(&registry, Some("model"))` splices the usage into a `/model <usage>` line, follows it
 * with the description, and appends a `more: /help model` footer; and that `/quit` renders an
 * `aliases: /exit, /q` line.
 *
 * A command could carry the right `usage` string and still render it wrong (or not at all), so
 * "calls the same function" is not "asserts the same behavior". `ported/cli-help.test.ts` does not
 * close this either — it drives the built binary's `pie --help`, a different surface that never
 * reaches `command_help_text`. The ledger therefore scores both oracle tests as gaps.
 */

import { describe, expect, it } from "vitest";
import { helpTextWithSkills, registryWithBuiltins } from "../../src/core/slash-dispatch.ts";

describe("help_text topic rendering (commands.rs:1203-1262)", () => {
	it("renders usage, description, and the more-footer for a named topic", () => {
		// pie: commands.rs:3339-3348
		//   let model = help_text(&registry, Some("model"));
		//   assert!(model.contains("/model [provider:model-id|list [provider]]"), "{model}");
		//   assert!(model.contains("show or switch the active model"), "{model}");
		//   assert!(model.contains("more: /help model"), "{model}");
		const model = helpTextWithSkills(registryWithBuiltins(), "model", []);
		expect(model).toContain("/model [provider:model-id|list [provider]]");
		expect(model).toContain("show or switch the active model");
		expect(model).toContain("more: /help model");
	});

	it("strips the leading slash and renders the alias line", () => {
		// pie: commands.rs:3350-3352
		//   let quit = help_text(&registry, Some("/quit"));
		//   assert!(quit.contains("/quit"), "{quit}");
		//   assert!(quit.contains("aliases: /exit, /q"), "{quit}");
		const quit = helpTextWithSkills(registryWithBuiltins(), "/quit", []);
		expect(quit).toContain("/quit");
		expect(quit).toContain("aliases: /exit, /q");
	});

	it("renders a topic whose usage is an argument placeholder", () => {
		// pie: commands.rs:3354-3357
		//   let goal_start = help_text(&registry, Some("goal-start"));
		//   assert!(goal_start.contains("/goal-start <prompt>"), "{goal_start}");
		//   assert!(goal_start.contains("start working on the active session goal"), "{goal_start}");
		const goalStart = helpTextWithSkills(registryWithBuiltins(), "goal-start", []);
		expect(goalStart).toContain("/goal-start <prompt>");
		expect(goalStart).toContain("start working on the active session goal");
	});

	it("names the unknown topic and suggests the prefix match", () => {
		// pie: commands.rs:3362-3365
		//   let text = help_text(&registry, Some("mod"));
		//   assert!(text.contains("unknown help topic: mod"), "{text}");
		//   assert!(text.contains("Did you mean /model?"), "{text}");
		const text = helpTextWithSkills(registryWithBuiltins(), "mod", []);
		expect(text).toContain("unknown help topic: mod");
		expect(text).toContain("Did you mean /model?");
	});
});
