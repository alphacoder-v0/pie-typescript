/**
 * Slash-command completion for the TUI input box.
 *
 * Port of oracle `crates/coding-agent/src/readline.rs` (pie @0a120dfd), whose module header reads:
 * "Previously this wrapped `rustyline`'s `Completer`/`Hinter` traits. The full-screen TUI owns its
 * own input widget (`tui-textarea`), so this is now a plain matcher: given the current input line it
 * returns the slash commands whose names share the typed prefix. The app renders those as a
 * completion popup above the input and cycles/accepts them on Tab."
 *
 * Despite the file name there is no line editor, no raw mode and no history here -- prompt history
 * is a separate oracle file already ported as `src/history.ts` (`coding-agent/history`, phase 12).
 *
 * Wiring this matcher into the interactive UI (oracle `ui/mod.rs:191`, `ui/mod.rs:1366` and
 * `ui/web.rs:988`) belongs to the `coding-agent/tui` manifest unit, matching the "wiring left to
 * caller" convention `history.ts` established for itself.
 */

import type { Skill } from "@pie/agent-core";
import type { PieSlashCommand } from "./core/slash-commands.ts";

/**
 * Rust's `char::is_whitespace` is the Unicode `White_Space` property. JS's `\s` is NOT the same
 * set: it omits U+0085 (NEL) and adds U+FEFF. Both `slashToken`'s `trim_start` (readline.rs:65) and
 * its interior-whitespace test (readline.rs:69) are user-visible -- they decide whether the
 * completion popup is showing at all -- so the exact `White_Space` set is spelled out here rather
 * than approximated with `\s`.
 */
const WHITE_SPACE_CLASS = "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const WHITE_SPACE = new RegExp(`[${WHITE_SPACE_CLASS}]`);
const LEADING_WHITE_SPACE = new RegExp(`^[${WHITE_SPACE_CLASS}]+`);

/**
 * Rust sorts and compares `String` by UTF-8 byte order, which is code-point order. JS's default
 * `Array#sort` and its `<`/`>` operators use UTF-16 code-unit order, which disagrees for astral
 * characters (U+10000+ sorts before U+E000..U+FFFF). Command names are ASCII in practice, but the
 * skill-derived entries come from user-authored `SKILL.md` front matter, so the ordering that
 * `matches()` returns is pinned to oracle's rather than left to the runtime.
 *
 * pie: readline.rs:36 (`commands.sort()`).
 */
function compareCodePoints(a: string, b: string): number {
	const left = Array.from(a);
	const right = Array.from(b);
	const shared = Math.min(left.length, right.length);
	for (let i = 0; i < shared; i++) {
		const delta = (left[i].codePointAt(0) as number) - (right[i].codePointAt(0) as number);
		if (delta !== 0) {
			return delta;
		}
	}
	return left.length - right.length;
}

/**
 * pie: readline.rs:37 (`commands.dedup()`) -- Rust's `Vec::dedup` removes only CONSECUTIVE
 * duplicates, which is a full de-duplication because it runs right after `sort()`.
 */
function dedupSorted(sorted: readonly string[]): string[] {
	const out: string[] = [];
	for (const value of sorted) {
		if (out.length === 0 || out[out.length - 1] !== value) {
			out.push(value);
		}
	}
	return out;
}

/**
 * pie: commands.rs:258-264 (`Registry::find`) -- lookup by name or alias, a linear scan, first
 * match wins. `src/core/slash-commands.ts` exports `findPieCommand`, but that one is hard-wired to
 * `PIE_BUILTIN_COMMANDS`; oracle's `skill_shortcuts` scans whatever registry it is handed, and the
 * caller (`ui/mod.rs:191`) passes the registry the app actually built.
 */
function findCommand(registry: readonly PieSlashCommand[], name: string): PieSlashCommand | undefined {
	return registry.find((command) => command.name === name || command.aliases.includes(name));
}

/**
 * The `/name` strings oracle's `commands::skill_shortcuts` contributes to the completion set.
 *
 * pie: commands.rs:3061-3088 (`SkillShortcut` / `skill_shortcuts`). Three filters, in oracle's
 * order: skills with `disable_model_invocation` are dropped; a name carried by more than one
 * remaining skill is dropped entirely (ambiguous -- oracle counts first, then keeps only `== 1`);
 * and a name that collides with a registry command or alias is dropped, because the builtin wins
 * dispatch (`resolve_skill_shortcut`, commands.rs:3090-3096).
 *
 * TODO(port): oracle declares this in `commands.rs` and readline.rs merely imports it, but the
 * `coding-agent/commands` unit (`src/core/slash-commands.ts`, phase 13, done) did not port it --
 * that file's own `TODO(port)` defers the whole dispatch half to the `coding-agent/tui` unit. Only
 * the `command` field is reachable from readline, so only that is reproduced here (oracle's
 * `SkillShortcut` also carries `source` -- absent from the TS `Skill` type -- and a
 * `preview_text(description, 72)`, both of which exist solely for `/help` rendering,
 * commands.rs:1174/1226). When the canonical `skillShortcuts` lands next to the dispatcher, this
 * private helper should be deleted in favour of it.
 */
function skillShortcutCommands(skills: readonly Skill[], registry: readonly PieSlashCommand[]): string[] {
	// pie: commands.rs:3069-3075 -- the count is taken over the model-invocable skills only.
	const invocable = skills.filter((skill) => !skill.disableModelInvocation);
	const counts = new Map<string, number>();
	for (const skill of invocable) {
		counts.set(skill.name, (counts.get(skill.name) ?? 0) + 1);
	}
	return invocable
		.filter((skill) => counts.get(skill.name) === 1)
		.filter((skill) => findCommand(registry, skill.name) === undefined)
		.map((skill) => `/${skill.name}`)
		.sort(compareCodePoints);
}

/**
 * Extract the slash token at the start of `line` (after leading whitespace). Returns `undefined`
 * unless the trimmed line begins with `/` and contains no interior whitespace (i.e. the user is
 * still typing the command name, not its arguments).
 *
 * pie: readline.rs:61-73 (`slash_token`). Note the returned token keeps its leading `/` and its
 * trailing content as typed -- only the LEADING whitespace is stripped.
 */
function slashToken(line: string): string | undefined {
	const trimmed = line.replace(LEADING_WHITE_SPACE, "");
	if (!trimmed.startsWith("/")) {
		return undefined;
	}
	if (WHITE_SPACE.test(trimmed.slice(1))) {
		return undefined;
	}
	return trimmed;
}

/**
 * Precomputed, sorted, de-duplicated list of `/command` strings (canonical names + aliases).
 *
 * pie: readline.rs:11-15 (`struct SlashCompleter`). Oracle's `Registry` is a `Vec<Arc<dyn
 * SlashCommand>>`; the ported registry is the plain data array `PIE_BUILTIN_COMMANDS`
 * (`core/slash-commands.ts:88`), so `registry.commands()` (commands.rs:255-257) is the array
 * itself.
 */
export class SlashCompleter {
	private readonly commands: readonly string[];

	private constructor(commands: readonly string[]) {
		this.commands = commands;
	}

	/**
	 * pie: readline.rs:12 (`#[derive(Default)]`) -- an empty completer, which matches nothing.
	 * Oracle's `ui` module holds a `SlashCompleter` field that is replaced on every skill reload
	 * (`ui/mod.rs:1366`); `Default` is what such a field starts out as.
	 */
	static empty(): SlashCompleter {
		return new SlashCompleter([]);
	}

	/** pie: readline.rs:18-21 (`from_registry`). */
	static fromRegistry(registry: readonly PieSlashCommand[]): SlashCompleter {
		return SlashCompleter.fromRegistryAndSkills(registry, []);
	}

	/** pie: readline.rs:23-39 (`from_registry_and_skills`). */
	static fromRegistryAndSkills(registry: readonly PieSlashCommand[], skills: readonly Skill[]): SlashCompleter {
		const commands: string[] = [];
		// pie: readline.rs:25-30 -- canonical name first, then each alias, both `/`-prefixed.
		for (const command of registry) {
			commands.push(`/${command.name}`);
			for (const alias of command.aliases) {
				commands.push(`/${alias}`);
			}
		}
		// pie: readline.rs:31-35 -- skill shortcuts arrive already `/`-prefixed.
		commands.push(...skillShortcutCommands(skills, registry));
		// pie: readline.rs:36-37.
		commands.sort(compareCodePoints);
		return new SlashCompleter(dedupSorted(commands));
	}

	/**
	 * Completions for the current input. Returns matching `/command` strings when `line` is a bare
	 * slash token (`/`, `/he`, ...) with no whitespace yet; otherwise empty.
	 *
	 * pie: readline.rs:41-58 (`matches`). The final guard (readline.rs:53-56) is oracle's own:
	 * "Nothing left to complete when the only match is what the user already typed" -- so a fully
	 * typed, unambiguous command offers no popup, while a fully typed command that is also a prefix
	 * of another one still does.
	 */
	matches(line: string): string[] {
		const token = slashToken(line);
		if (token === undefined) {
			return [];
		}
		const matches = this.commands.filter((command) => command.startsWith(token));
		if (matches.length === 1 && matches[0] === token) {
			return [];
		}
		return matches;
	}
}
