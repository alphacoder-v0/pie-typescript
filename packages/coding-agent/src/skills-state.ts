/**
 * Runtime skill enable/disable overlay, persisted at `<baseDir>/skills-state.json`.
 *
 * Port of oracle `crates/coding-agent/src/skills_state.rs` (pie @0a120dfd). This is manifest
 * unit `coding-agent/skills_state` (phase 11, `port`, out_path
 * `packages/coding-agent/src/skills-state.ts` -- matches this file's actual location).
 * Pre-completed here (ahead of phase 11) because phase 9's `SetSkillState`/`RemoveSkill` tools
 * (`tools/set-skill-state.ts`, `tools/remove-skill.ts`) hard-depend on this persistence module
 * to function at all -- there is no other unit that could stand in for it. Not on the phase-9
 * "don't touch other tool files" list (it's an infra module, not a tool), so this is additive,
 * not a modification of anyone else's in-flight work.
 *
 * Why an overlay instead of editing `SKILL.md` (pie: skills_state.rs:1-17, verbatim rationale):
 * a skill's `SKILL.md` is the author's read-only source of truth (often vendored or
 * project-shared). Flipping `disable_model_invocation` by rewriting that file would dirty
 * vendored/project content and make updates harder. Instead, runtime enable/disable is recorded
 * as local control-plane *state* keyed by `{source, name}`, applied at load time. The user's
 * SKILL.md stays pristine; disabling is reversible.
 *
 * Boundary (locked with Provider/Auth + QA on the #ux skill-lifecycle thread, pie: skills_state.rs
 * :10-12): the overlay stores ONLY `{name, source, enabled}` -- never the skill body, never a
 * source URL/token, never any credential.
 *
 * Base dir mapping: oracle keys this off `${PIE_DIR:-$HOME/.pie}` (see
 * `tools/set_skill_state.rs::default_base_dir`). `getAgentDir()` (`config.ts`) now resolves to
 * that very `~/.pie` root itself (honors `PIE_DIR` first, then the pi-only additive
 * `PI_CODING_AGENT_DIR` override) -- see the RULEBOOK user-dir-layout.md arbitration. Following
 * `tools/install-skill.ts`'s precedent, callers pass `getAgentDir()` as `baseDir` here so
 * `skills-state.json` sits next to the very `skills/` directory it overlays.
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { emit } from "./logging.ts";

// pie: skills_state.rs:25 (STATE_FILE)
export const SKILLS_STATE_FILE = "skills-state.json";

/**
 * Origin of a loaded skill. Unit-only enum -> string literal union (RULEBOOK Section 2.1).
 * pie: crates/agent/src/harness/types.rs:244-263 (`SkillSource`). This port has no separate
 * agent-core `Skill.source` field to draw the type from (see `tools/skill.ts`'s module doc for
 * why) -- defined here since `SkillStateEntry.source` is this module's own concern, and
 * `tools/skill.ts` imports it back from here (skills-state.ts has no dependency on tools/).
 */
export type SkillSource = "builtin" | "user" | "project";

/** Stable lowercase label -- oracle's `SkillSource::label()` returns the variant name itself. */
export function skillSourceLabel(source: SkillSource): string {
	return source;
}

/**
 * One explicit enable/disable override for a `{source, name}` skill. Presence of an entry means
 * the user made an explicit runtime choice that overrides the skill's frontmatter
 * `disable_model_invocation` default.
 * pie: skills_state.rs:27-36 (`SkillStateEntry`)
 */
export interface SkillStateEntry {
	name: string;
	source: SkillSource;
	/** `true` = explicitly enabled (overrides a frontmatter disable); `false` = disabled. */
	enabled: boolean;
}

/**
 * The persisted overlay. Forward-compatible: unknown fields are ignored, missing file = empty.
 * pie: skills_state.rs:38-43 (`SkillsState`)
 */
export interface SkillsState {
	overrides: SkillStateEntry[];
}

export function createEmptySkillsState(): SkillsState {
	return { overrides: [] };
}

/** pie: skills_state.rs:46-51 (`SkillsState::lookup`) */
export function lookupSkillState(state: SkillsState, name: string, source: SkillSource): SkillStateEntry | undefined {
	return state.overrides.find((entry) => entry.name === name && entry.source === source);
}

/**
 * Upsert an explicit `{source, name} -> enabled` override. Returns a NEW `SkillsState` (RULEBOOK
 * global coding-style: immutable update) rather than mutating `state` in place, unlike oracle's
 * `&mut self` method (pie: skills_state.rs:53-68, `SkillsState::set`).
 */
export function setSkillState(state: SkillsState, name: string, source: SkillSource, enabled: boolean): SkillsState {
	const index = state.overrides.findIndex((entry) => entry.name === name && entry.source === source);
	if (index === -1) {
		return { overrides: [...state.overrides, { name, source, enabled }] };
	}
	const overrides = state.overrides.slice();
	overrides[index] = { ...overrides[index]!, enabled };
	return { overrides };
}

/**
 * Drop the `{source, name}` override, if present. `removed` mirrors oracle's boolean return (pie:
 * skills_state.rs:70-78, `SkillsState::remove`) -- used by callers that want to skip the write on
 * a no-op.
 */
export function removeSkillState(
	state: SkillsState,
	name: string,
	source: SkillSource,
): { state: SkillsState; removed: boolean } {
	const overrides = state.overrides.filter((entry) => !(entry.name === name && entry.source === source));
	return { state: { overrides }, removed: overrides.length !== state.overrides.length };
}

/** Absolute path to the overlay file under `baseDir`. pie: skills_state.rs:81-84 (`state_path`) */
export function skillsStatePath(baseDir: string): string {
	return join(baseDir, SKILLS_STATE_FILE);
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Load the overlay. A missing file is an empty overlay; a malformed file is treated as empty (the
 * disable/enable state simply isn't applied) rather than failing skill loading entirely.
 * pie: skills_state.rs:86-97 (`load`). Oracle logs a `tracing::warn!` on malformed JSON; the
 * subscriber that consumes it is `logging.ts`, installed by `main.ts` at startup (phase 13 T5-a),
 * so this now routes to the real sink instead of being dropped. Before a subscriber exists (SDK
 * embedders, tests) `logging.emit` is a silent no-op — the same posture `tracing`'s macros have
 * before `init` runs.
 */
export async function loadSkillsState(baseDir: string): Promise<SkillsState> {
	const path = skillsStatePath(baseDir);
	let raw: string;
	try {
		raw = await readFile(path, "utf-8");
	} catch {
		return createEmptySkillsState();
	}
	try {
		const parsed = JSON.parse(raw) as { overrides?: unknown };
		if (!parsed || !Array.isArray(parsed.overrides)) {
			return createEmptySkillsState();
		}
		const overrides = parsed.overrides.filter(
			(entry): entry is SkillStateEntry =>
				!!entry &&
				typeof entry === "object" &&
				typeof (entry as SkillStateEntry).name === "string" &&
				(entry as SkillStateEntry).source !== undefined &&
				typeof (entry as SkillStateEntry).enabled === "boolean",
		);
		return { overrides };
	} catch (error) {
		// pie: skills_state.rs:92 — `tracing::warn!(path = %…, error = %e, "malformed
		// skills-state.json; ignoring overlay")`, field names and message verbatim.
		emit("warn", "pie::skills_state", "malformed skills-state.json; ignoring overlay", {
			path,
			error: errorMessage(error),
		});
		return createEmptySkillsState();
	}
}

/**
 * Atomically persist the overlay (tempfile + rename within the same dir).
 * pie: skills_state.rs:99-118 (`save`)
 */
export async function saveSkillsState(baseDir: string, state: SkillsState): Promise<void> {
	try {
		await mkdir(baseDir, { recursive: true });
	} catch (err) {
		throw new Error(`create ${baseDir}: ${errorMessage(err)}`);
	}
	const json = JSON.stringify(state, null, 2);
	const tmp = join(baseDir, `.${SKILLS_STATE_FILE}.${process.pid}.${process.hrtime.bigint()}.tmp`);
	try {
		await writeFile(tmp, json, "utf-8");
	} catch (err) {
		throw new Error(`write ${tmp}: ${errorMessage(err)}`);
	}
	try {
		await rename(tmp, skillsStatePath(baseDir));
	} catch (err) {
		try {
			await unlink(tmp);
		} catch {
			// best-effort cleanup only
		}
		throw new Error(`rename ${tmp} -> ${skillsStatePath(baseDir)}: ${errorMessage(err)}`);
	}
}

/**
 * Apply the overlay to a freshly-loaded skill catalog: for each skill that has an explicit
 * `{source, name}` override, set `disableModelInvocation = !enabled`. Skills with no override
 * keep their frontmatter value. Returns a NEW array of NEW skill objects (immutable update)
 * rather than oracle's in-place `&mut [Skill]` mutation (pie: skills_state.rs:120-130, `apply`).
 *
 * Generic over `T` (rather than a concrete `Skill` type) because this module has no dependency on
 * `core/skills.ts` or any tool file -- callers (`tools/skill.ts`) supply their own skill shape and
 * a `resolveSource` projection, avoiding a circular import (skill.ts already imports FROM this
 * file for `SkillSource`/state helpers).
 */
export function applySkillsStateOverlay<T extends { name: string; disableModelInvocation: boolean }>(
	state: SkillsState,
	skills: T[],
	resolveSource: (skill: T) => SkillSource,
): T[] {
	return skills.map((skill) => {
		const entry = lookupSkillState(state, skill.name, resolveSource(skill));
		if (!entry) return skill;
		return { ...skill, disableModelInvocation: !entry.enabled };
	});
}

/**
 * Convenience: load -> set -> save in one call, returning the updated overlay. Used by
 * `SetSkillState` (`tools/set-skill-state.ts`).
 * pie: skills_state.rs:132-145 (`set_and_save`)
 */
export async function setAndSaveSkillsState(
	baseDir: string,
	name: string,
	source: SkillSource,
	enabled: boolean,
): Promise<SkillsState> {
	const state = await loadSkillsState(baseDir);
	const next = setSkillState(state, name, source, enabled);
	await saveSkillsState(baseDir, next);
	return next;
}

/**
 * Convenience: load -> remove the `{source, name}` override -> save (only if something was
 * actually removed, matching oracle's no-op-skips-write behavior). Used by `RemoveSkill`
 * (`tools/remove-skill.ts`) so removing a skill also forgets any disabled state for it.
 * pie: skills_state.rs:147-161 (`remove_and_save`)
 */
export async function removeAndSaveSkillsState(baseDir: string, name: string, source: SkillSource): Promise<void> {
	const state = await loadSkillsState(baseDir);
	const { state: next, removed } = removeSkillState(state, name, source);
	if (removed) {
		await saveSkillsState(baseDir, next);
	}
}
