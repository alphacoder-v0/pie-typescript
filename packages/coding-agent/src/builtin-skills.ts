/**
 * Built-in skill catalog.
 *
 * Port of oracle `crates/coding-agent/src/builtin_skills.rs` (pie @0a120dfd). Bundles a small,
 * curated set of skills into the `pie` binary so users can opt them in without manually checking
 * out a skill repo into `~/.pie/skills/`. This is the **lowest precedence** skill source -- any
 * user (`~/.pie/skills/`) or project (`<cwd>/.pie/skills/`) skill of the same name shadows the
 * built-in version, same as the existing user/project precedence in `crate::skills::load_all`
 * (this port's `../core/skills.ts` `loadSkills()`).
 *
 * **Default behavior is OFF**: a built-in skill is included in the skill catalog only when the
 * user explicitly enables it via:
 *
 * - the `--builtin-skill <name>` CLI flag (repeatable, one-time enable for that run)
 * - `~/.pie/config.toml`: `[builtin_skills] enabled = [...]` (persistent enable)
 *
 * Both inputs are unioned + de-duplicated. Unknown names from the CLI flag are a hard error (the
 * user typed a name and we cannot honor it) -- {@link resolveBuiltins} throws
 * {@link UnknownBuiltinSkillError}. Unknown names from the config file are a soft startup
 * diagnostic (the config may have drifted from the binary's bundled set, but we do not lock the
 * user out -- known names still take effect, unknown names are simply skipped). Either way, an
 * unknown name **never** silently enables anything.
 *
 * Oracle's `include_str!` bundles the vendored `SKILL.md` at *compile* time; the closest TS
 * analog is a string constant baked into this module (not a runtime file read relative to the
 * package install dir) -- see {@link RAW_KARPATHY_GUIDELINES_MARKDOWN}.
 *
 * Wiring this catalog into the actual coding-agent CLI (the `--builtin-skill` flag itself,
 * `~/.pie/config.toml` reading, and merging into the live skill catalog surfaced by
 * `core/skills.ts`/`tools/skill.ts`) is out of this unit's scope -- `tools/skill.ts`'s own module
 * doc already documents that no builtin-skill catalog is wired into this repo yet. This module
 * exposes the same building blocks oracle's `main.rs` composes (`resolveBuiltins` +
 * `mergeWithUserProject` + `parseBuiltinSkillsConfig`), directly unit-testable the same way
 * oracle's own `#[cfg(test)]` module exercises them without spinning up the full binary.
 *
 * See c4pt0r/pie#32 for the spec.
 */

import { parse as parseToml } from "smol-toml";
import type { SkillSource } from "./skills-state.ts";

/**
 * Raw markdown of the `karpathy-guidelines` built-in skill, vendored verbatim from
 * `crates/coding-agent/skills/karpathy-guidelines/SKILL.md` (byte-for-byte, including
 * frontmatter). {@link stripFrontmatter} strips the frontmatter at runtime, mirroring oracle's
 * `spec_to_skill`.
 */
const RAW_KARPATHY_GUIDELINES_MARKDOWN =
	'---\nname: karpathy-guidelines\ndescription: Behavioral guidelines to reduce common LLM coding mistakes. Use when writing, reviewing, or refactoring code to avoid overcomplication, make surgical changes, surface assumptions, and define verifiable success criteria.\nlicense: MIT\n---\n\n# Karpathy Guidelines\n\nBehavioral guidelines to reduce common LLM coding mistakes, derived from [Andrej Karpathy\'s observations](https://x.com/karpathy/status/2015883857489522876) on LLM coding pitfalls.\n\n**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.\n\n## 1. Think Before Coding\n\n**Don\'t assume. Don\'t hide confusion. Surface tradeoffs.**\n\nBefore implementing:\n- State your assumptions explicitly. If uncertain, ask.\n- If multiple interpretations exist, present them - don\'t pick silently.\n- If a simpler approach exists, say so. Push back when warranted.\n- If something is unclear, stop. Name what\'s confusing. Ask.\n\n## 2. Simplicity First\n\n**Minimum code that solves the problem. Nothing speculative.**\n\n- No features beyond what was asked.\n- No abstractions for single-use code.\n- No "flexibility" or "configurability" that wasn\'t requested.\n- No error handling for impossible scenarios.\n- If you write 200 lines and it could be 50, rewrite it.\n\nAsk yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.\n\n## 3. Surgical Changes\n\n**Touch only what you must. Clean up only your own mess.**\n\nWhen editing existing code:\n- Don\'t "improve" adjacent code, comments, or formatting.\n- Don\'t refactor things that aren\'t broken.\n- Match existing style, even if you\'d do it differently.\n- If you notice unrelated dead code, mention it - don\'t delete it.\n\nWhen your changes create orphans:\n- Remove imports/variables/functions that YOUR changes made unused.\n- Don\'t remove pre-existing dead code unless asked.\n\nThe test: Every changed line should trace directly to the user\'s request.\n\n## 4. Goal-Driven Execution\n\n**Define success criteria. Loop until verified.**\n\nTransform tasks into verifiable goals:\n- "Add validation" → "Write tests for invalid inputs, then make them pass"\n- "Fix the bug" → "Write a test that reproduces it, then make it pass"\n- "Refactor X" → "Ensure tests pass before and after"\n\nFor multi-step tasks, state a brief plan:\n```\n1. [Step] → verify: [check]\n2. [Step] → verify: [check]\n3. [Step] → verify: [check]\n```\n\nStrong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.\n';

interface BuiltinSpec {
	/** Stable lowercase-kebab name. Must match the frontmatter `name:` value. */
	name: string;
	/** Short description shown in `/skills` and the system-prompt catalog. */
	description: string;
	/** Full SKILL.md content including frontmatter. */
	rawMarkdown: string;
}

/**
 * All built-in skills bundled with this build. Adding a new one means: vendor its raw markdown
 * as a string constant above, then add an entry here.
 * pie: builtin_skills.rs:42-46 (`BUILTINS`)
 */
const BUILTINS: readonly BuiltinSpec[] = [
	{
		name: "karpathy-guidelines",
		description:
			"Behavioral guidelines to reduce common LLM coding mistakes. Use when writing, reviewing, or refactoring code to avoid overcomplication, make surgical changes, surface assumptions, and define verifiable success criteria.",
		rawMarkdown: RAW_KARPATHY_GUIDELINES_MARKDOWN,
	},
];

/**
 * A resolved built-in skill, shaped like oracle's `pie_agent_core::Skill`. This is deliberately
 * NOT `core/skills.ts`'s `Skill` type (no `sourceInfo`/`baseDir`, has a `content` field instead of
 * a lazy `filePath` read) -- see this file's module doc for why merging into that catalog is a
 * separate, not-yet-wired concern.
 */
export interface BuiltinSkill {
	name: string;
	description: string;
	/** Synthetic path used in `/skills` listings and audit, e.g. `<builtin>/karpathy-guidelines/SKILL.md`. */
	filePath: string;
	/** SKILL.md body with the leading frontmatter block stripped. */
	content: string;
	disableModelInvocation: boolean;
	source: SkillSource;
}

/**
 * List every built-in name in stable alphabetical order. Used by error/diagnostic messages so
 * the "Available: ..." list is reproducible across runs.
 * pie: builtin_skills.rs:50-54 (`available_builtin_names`)
 */
export function availableBuiltinNames(): string[] {
	return BUILTINS.map((b) => b.name).sort();
}

/* -------------------------------------------------------------------------------------------
 * Enabled-built-ins registry
 *
 * oracle threads `ResolvedBuiltins.skills` from `main.rs:698-707` straight into the skill
 * catalog it hands the harness. This port's `loadEffectiveSkills` (`tools/skill.ts`) re-scans
 * disk on every invocation and has no access to CLI args, so the resolved set is published into
 * a process-level registry at startup and read back there — the same shape `local-models.ts`
 * uses for `~/.pie/models.json`.
 *
 * That precedent came with a lesson, and it is why there is exactly ONE reader: phase 21 batch A
 * found that custom models were published into `ModelRegistry` while `/model` read `@pie/ai`'s
 * static catalog instead, so a models.json model could start `pie` yet be invisible to
 * `/model list`. **A registry is only as good as the set of readers that consult it.**
 * `loadEffectiveSkills` is the single funnel every skill consumer already goes through —
 * `/skills`, `/skill`, `SetSkillState`, `RemoveSkill` and the system-prompt catalog all call it.
 * ----------------------------------------------------------------------------------------- */

let enabledBuiltins: BuiltinSkill[] = [];

/**
 * Publish the resolved built-in set. Called once from `main.ts` right after `resolveBuiltins`,
 * before any skill catalog is built. Idempotent; last write wins.
 */
export function setEnabledBuiltinSkills(skills: readonly BuiltinSkill[]): void {
	enabledBuiltins = [...skills];
}

/** The built-ins enabled for this process. Empty unless `--builtin-skill` / config asked for some. */
export function enabledBuiltinSkills(): BuiltinSkill[] {
	return [...enabledBuiltins];
}

/** Outcome of resolving the user's requested set of built-in skills. */
export interface ResolvedBuiltins {
	/** Skills to fold into the harness skill catalog. Empty when no built-in was enabled. */
	skills: BuiltinSkill[];
	/**
	 * Soft diagnostic strings to print at startup (e.g. unknown names found in
	 * `~/.pie/config.toml`). Each string is a complete user-readable line.
	 */
	diagnostics: string[];
}

/**
 * Error thrown when the CLI enabled a built-in skill name this build does not recognise. The
 * caller is expected to print `.message` and exit with a non-zero status (hard fail, per #32's
 * CLI-side acceptance).
 * pie: builtin_skills.rs:233-253 (`UnknownBuiltinError`)
 */
export class UnknownBuiltinSkillError extends Error {
	readonly unknown: string[];
	readonly available: string[];

	constructor(unknown: string[], available: string[]) {
		super(
			`unknown built-in skill(s) requested via --builtin-skill: ${unknown.join(", ")}. Available: ${available.join(", ")}.`,
		);
		this.name = "UnknownBuiltinSkillError";
		this.unknown = unknown;
		this.available = available;
	}
}

function sortedUniqueUnknown(requested: readonly string[], known: ReadonlySet<string>): string[] {
	return Array.from(new Set(requested.filter((name) => !known.has(name)))).sort();
}

/**
 * Build the union of CLI-requested + config-requested built-in skills.
 *
 * `cliRequested` is treated as authoritative: an unknown name throws {@link UnknownBuiltinSkillError}
 * (the CLI surface is expected to hard-fail with a non-zero exit). `configRequested` is treated
 * permissively: unknown names produce a diagnostic line but do not fail. Known names from either
 * source are unioned and de-duplicated; the same name appearing in both, or twice in the CLI
 * list, still produces exactly one catalog entry.
 * pie: builtin_skills.rs:74-140 (`resolve_builtins`)
 */
export function resolveBuiltins(cliRequested: readonly string[], configRequested: readonly string[]): ResolvedBuiltins {
	const known = new Set(BUILTINS.map((b) => b.name));

	// CLI path: hard-fail on any unknown name. Collect all unknowns so the user sees the full
	// list, not a one-at-a-time game of whack-a-mole.
	const unknownCli = sortedUniqueUnknown(cliRequested, known);
	if (unknownCli.length > 0) {
		throw new UnknownBuiltinSkillError(unknownCli, availableBuiltinNames());
	}

	// Config path: collect unknowns into a diagnostic, but do not block startup.
	const diagnostics: string[] = [];
	const unknownConfig = sortedUniqueUnknown(configRequested, known);
	if (unknownConfig.length > 0) {
		diagnostics.push(
			`config: ignoring unknown built-in skill(s) in \`[builtin_skills] enabled\`: ${unknownConfig.join(", ")}. Available: ${availableBuiltinNames().join(", ")}.`,
		);
	}

	// Union + dedup the known names from both sources, in stable alphabetical order so the
	// system-prompt catalog is reproducible across runs.
	const enabled = new Set<string>();
	for (const name of [...cliRequested, ...configRequested]) {
		if (known.has(name)) enabled.add(name);
	}
	const sortedEnabled = Array.from(enabled).sort();

	const skills = sortedEnabled.map((name) => {
		const spec = BUILTINS.find((b) => b.name === name);
		if (!spec) throw new Error("name validated against known set above");
		return specToSkill(spec);
	});

	return { skills, diagnostics };
}

function specToSkill(spec: BuiltinSpec): BuiltinSkill {
	return {
		name: spec.name,
		description: spec.description,
		filePath: `<builtin>/${spec.name}/SKILL.md`,
		content: stripFrontmatter(spec.rawMarkdown),
		disableModelInvocation: false,
		source: "builtin",
	};
}

/**
 * Return the body of a SKILL.md after stripping the leading YAML frontmatter block, if any.
 * Mirrors the behavior the on-disk loader applies to a real SKILL.md.
 *
 * Ported verbatim from oracle's byte-offset algorithm (builtin_skills.rs:157-185) rather than
 * reusing this port's other frontmatter parsers -- oracle's version has specific quirks (falls
 * back to the ORIGINAL, un-BOM-trimmed `content` -- not the BOM-trimmed `trimmed` -- whenever no
 * valid opening/closing delimiter is found) that are easiest to keep faithful by mirroring the
 * exact control flow rather than adapting a differently-shaped shared helper.
 */
export function stripFrontmatter(content: string): string {
	const trimmed = content.replace(/^﻿+/, "");
	if (!trimmed.startsWith("---")) {
		return content;
	}
	const withoutOpen = trimmed.slice(3);
	const newlineIndex = withoutOpen.indexOf("\n");
	if (newlineIndex === -1) {
		return content;
	}
	const afterOpen = withoutOpen.slice(newlineIndex + 1);

	let searchFrom = 0;
	for (;;) {
		const pos = afterOpen.indexOf("\n---", searchFrom);
		if (pos === -1) break;
		const absolute = pos + 1; // skip the leading '\n', point at the start of "---"
		const afterClose = afterOpen.slice(absolute + 3);
		if (afterClose.startsWith("\n")) {
			return afterClose.slice(1).replace(/^\n+/, "");
		}
		if (afterClose.length === 0) {
			return "";
		}
		// This "---" has trailing text on the same line -- not a valid closing marker; keep
		// scanning past it.
		searchFrom = absolute + 3;
	}
	// No closing marker found -- return the original content rather than guess.
	return content;
}

/**
 * Merge the resolved built-in skills with the user/project skills the existing dual-root loader
 * returned. Same-name precedence is **user/project wins over built-in** (built-in is the lowest
 * tier per #32). The returned array preserves built-in skills first (in their original position),
 * then any user/project skills not already shadowing a built-in, in `userProject`'s order.
 * pie: builtin_skills.rs:187-206 (`merge_with_user_project`)
 *
 * Unlike oracle's in-place `Vec` mutation, this returns a NEW array (RULEBOOK immutability
 * convention) rather than mutating `builtins`.
 */
export function mergeWithUserProject<T extends { name: string }>(
	builtins: readonly T[],
	userProject: readonly T[],
): T[] {
	let merged = builtins.slice();
	for (const skill of userProject) {
		const index = merged.findIndex((s) => s.name === skill.name);
		if (index === -1) {
			merged = [...merged, skill];
		} else {
			merged = merged.map((s, i) => (i === index ? skill : s));
		}
	}
	return merged;
}

interface BuiltinSkillsConfigFile {
	builtin_skills?: {
		enabled?: unknown;
	};
}

/**
 * Parse the contents of `~/.pie/config.toml` and extract the `[builtin_skills] enabled = [...]`
 * list. Missing section / missing key / parse failure / non-array-of-strings value all degrade to
 * an empty list -- the soft fail-closed posture from #32: the caller treats unknown names as a
 * startup diagnostic, but a malformed config never prevents the CLI from running at all.
 * pie: builtin_skills.rs:215-231 (`parse_builtin_skills_config`)
 */
export function parseBuiltinSkillsConfig(tomlText: string): string[] {
	let parsed: unknown;
	try {
		parsed = parseToml(tomlText);
	} catch {
		return [];
	}
	const enabled = (parsed as BuiltinSkillsConfigFile | undefined)?.builtin_skills?.enabled;
	if (!Array.isArray(enabled)) return [];
	return enabled.filter((v): v is string => typeof v === "string");
}
