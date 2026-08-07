import type { Skill } from "@pie/agent-core";
import { describe, expect, test } from "vitest";
import { PIE_BUILTIN_COMMANDS } from "../src/core/slash-commands.ts";
import { SlashCompleter } from "../src/readline.ts";

// pie: crates/coding-agent/src/readline.rs:75-144 -- full port of the #[cfg(test)] module.
//
// Oracle's fixture is `Registry::with_builtins()` (commands.rs:215-248); the ported registry is the
// same list as data, `PIE_BUILTIN_COMMANDS` (core/slash-commands.ts:88).

/**
 * pie: readline.rs:79-88. Oracle's `Skill` additionally carries `source: SkillSource::User`, a
 * field the TS `Skill` (packages/agent/src/harness/types.ts:46) does not have; nothing the
 * completer does reads it (only `/help` rendering does, commands.rs:3078).
 */
function skill(name: string, disabled: boolean): Skill {
	return {
		name,
		description: `description for ${name}`,
		filePath: `/tmp/${name}/SKILL.md`,
		content: "SECRET SKILL BODY",
		disableModelInvocation: disabled,
	};
}

/** pie: readline.rs:90-92 (`completer`). */
function completer(): SlashCompleter {
	return SlashCompleter.fromRegistry(PIE_BUILTIN_COMMANDS);
}

describe("SlashCompleter.matches", () => {
	// pie: readline.rs:94-100
	test("lists commands and aliases for a bare slash", () => {
		const m = completer().matches("/");
		expect(m).toContain("/help");
		expect(m).toContain("/quit");
		expect(m).toContain("/q");
	});

	// pie: readline.rs:102-109
	test("filters by prefix", () => {
		expect(completer().matches("/thi")).toEqual(["/thinking"]);
		expect(completer().matches("/goal-s")).toEqual(["/goal-start"]);
	});

	// pie: readline.rs:111-115
	test("no completion once an argument is typed", () => {
		expect(completer().matches("/skill test")).toEqual([]);
		expect(completer().matches("hello")).toEqual([]);
	});

	// pie: readline.rs:117-121
	test("an exact unique match is not offered", () => {
		// Already fully typed and unique -- nothing left to complete.
		expect(completer().matches("/thinking")).toEqual([]);
	});

	// pie: readline.rs:123-143
	test("includes enabled skill commands and hides disabled or conflicting ones", () => {
		const c = SlashCompleter.fromRegistryAndSkills(PIE_BUILTIN_COMMANDS, [
			skill("db9", false),
			skill("hidden-skill", true),
			skill("help", false),
		]);

		expect(c.matches("/d")).toContain("/db9");
		expect(c.matches("/hidden")).not.toContain("/hidden-skill");
		expect(c.matches("/help")).not.toContain("/help");
	});

	/* -- Beyond oracle's own test module ------------------------------------------------------
	 * Behaviour readline.rs implements but does not test, and about which the TS translation had
	 * to make a decision (whitespace class, sort/dedup order, the `Default` impl).
	 * ---------------------------------------------------------------------------------------- */

	// pie: readline.rs:65 (`trim_start`) -- leading whitespace is stripped before the `/` test, and
	// the returned token keeps its `/`.
	test("leading whitespace is trimmed before the slash test", () => {
		expect(completer().matches("   /thi")).toEqual(["/thinking"]);
		expect(completer().matches("\t/goal-s")).toEqual(["/goal-start"]);
	});

	// pie: readline.rs:69 -- ANY interior whitespace (not just a space) suppresses completion,
	// because Rust's `char::is_whitespace` is the Unicode `White_Space` property. Every case below
	// would complete to `/thinking` if the trailing character were absent (asserted first), so none
	// of them passes vacuously.
	test("interior unicode whitespace suppresses completion", () => {
		expect(completer().matches("/thi")).toEqual(["/thinking"]);
		expect(completer().matches("/thi ")).toEqual([]);
		expect(completer().matches("/thi\t")).toEqual([]);
		// U+0085 (NEL) is in Rust's White_Space but NOT in JavaScript's `\s`, so a naive `\s`
		// translation would still have offered `/thinking` here.
		expect(completer().matches("/thi")).toEqual([]);
		// U+3000 (ideographic space) is in both.
		expect(completer().matches("/thi　")).toEqual([]);
	});

	// pie: readline.rs:36-37 (`sort` + `dedup`). `/goal` and `/goal-start` are two distinct
	// commands, so a fully-typed `/goal` that is a prefix of another entry still offers a popup --
	// the "exact unique match" guard (readline.rs:53-56) only fires when there is exactly one match.
	test("results are sorted, de-duplicated, and keep prefix-of-another matches", () => {
		const m = completer().matches("/goal");
		expect(m).toEqual(["/goal", "/goal-start"]);
		expect(new Set(m).size).toBe(m.length);
	});

	// pie: readline.rs:12 (`#[derive(Default)]`).
	test("an empty completer matches nothing", () => {
		expect(SlashCompleter.empty().matches("/")).toEqual([]);
		expect(SlashCompleter.empty().matches("/help")).toEqual([]);
	});

	// pie: commands.rs:3072-3074 -- a duplicate skill name is ambiguous and drops out entirely,
	// even though each copy on its own would have produced a shortcut.
	test("duplicate skill names produce no shortcut", () => {
		const c = SlashCompleter.fromRegistryAndSkills(PIE_BUILTIN_COMMANDS, [skill("db9", false), skill("db9", false)]);
		expect(c.matches("/db9")).toEqual([]);
	});
});
