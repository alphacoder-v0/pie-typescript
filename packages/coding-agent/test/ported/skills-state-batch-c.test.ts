/**
 * phase 21 batch C — the ten inline tests in upstream `crates/coding-agent/src/skills_state.rs`.
 *
 * The **pure-function layer of `skills-state.ts` had no direct coverage**: `setSkillState`,
 * `removeSkillState`, `applySkillsStateOverlay`, `loadSkillsState` and `saveSkillsState` were never
 * called directly anywhere in the test suite, only reached indirectly through tool-layer tests such
 * as `set-skill-state-tool.test.ts` — and those assert the tool's schema shape, permission class and
 * error text, not the semantics of the overlay.
 *
 * The one exception is `set_and_save_persists`: `set-skill-state-tool.test.ts:82` already asserts
 * `state.overrides` equals `[{name:"foo", source:"user", enabled:false}]`, so that one is judged
 * covered.
 *
 * The most valuable additions in this batch are **`apply_is_source_aware` and the source-aware half
 * of remove**: skills with the same name from different sources each keep their own override record.
 * Collapse the source dimension and disabling the user's `foo` also disables the project's `foo` —
 * what the user sees is a skill they never turned off going missing.
 *
 * Hermetic: everything runs in a `mkdtemp` directory and writes only `skills-state.json`; the real
 * `~/.pie/` is neither read nor written.
 */

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applySkillsStateOverlay,
	createEmptySkillsState,
	loadSkillsState,
	lookupSkillState,
	removeAndSaveSkillsState,
	removeSkillState,
	SKILLS_STATE_FILE,
	type SkillSource,
	saveSkillsState,
	setSkillState,
	skillsStatePath,
} from "../../src/skills-state.ts";

/** Upstream's `skill(name, source, disable_model_invocation)` fixture (skills_state.rs:168-176). */
function skill(name: string, source: SkillSource, disableModelInvocation: boolean) {
	return { name, source, disableModelInvocation };
}

const sourceOf = (s: { source: SkillSource }) => s.source;

describe("apply — how the overlay rewrites frontmatter (skills_state.rs:100-118)", () => {
	it("an explicit disable applies to the matching {source, name}", () => {
		// pie: skills_state.rs:179-188
		//   state.set("foo", SkillSource::User, false);
		//   apply(&state, &mut skills);
		//   assert!(skills[0].disable_model_invocation, "overlay disable applies");
		const state = setSkillState(createEmptySkillsState(), "foo", "user", false);
		const out = applySkillsStateOverlay(state, [skill("foo", "user", false)], sourceOf);
		expect(out[0]?.disableModelInvocation).toBe(true);
	});

	it("an explicit enable overrides a frontmatter disable", () => {
		// pie: skills_state.rs:191-200
		//   state.set("foo", SkillSource::User, true);   // explicitly enabled
		//   let mut skills = vec![skill("foo", SkillSource::User, true)];  // frontmatter disabled
		//   assert!(!skills[0].disable_model_invocation, "explicit enable overrides frontmatter disable");
		const state = setSkillState(createEmptySkillsState(), "foo", "user", true);
		const out = applySkillsStateOverlay(state, [skill("foo", "user", true)], sourceOf);
		expect(out[0]?.disableModelInvocation, "explicit enable overrides frontmatter disable").toBe(false);
	});

	it("is source-aware: a user-scoped disable leaves the project skill of the same name alone", () => {
		// pie: skills_state.rs:203-217
		//   state.set("foo", SkillSource::User, false);
		//   skills = [skill("foo", User, false), skill("foo", Project, false)];
		//   assert!(skills[0].disable_model_invocation, "user foo disabled");
		//   assert!(!skills[1].disable_model_invocation,
		//           "project foo must not be affected by a user-scoped disable");
		//
		// Collapse the source dimension and disabling the user's `foo` also disables the project's `foo`.
		// The user sees a skill they never turned off going missing, with nothing in skills-state.json to
		// explain why.
		const state = setSkillState(createEmptySkillsState(), "foo", "user", false);
		const out = applySkillsStateOverlay(
			state,
			[skill("foo", "user", false), skill("foo", "project", false)],
			sourceOf,
		);
		expect(out[0]?.disableModelInvocation, "user foo disabled").toBe(true);
		expect(out[1]?.disableModelInvocation, "project foo must not be affected by a user-scoped disable").toBe(false);
	});

	it("leaves the frontmatter value untouched when there is no override", () => {
		// pie: skills_state.rs:220-232 — with an empty state, each skill keeps its own frontmatter value.
		const out = applySkillsStateOverlay(
			createEmptySkillsState(),
			[skill("a", "user", false), skill("b", "user", true)],
			sourceOf,
		);
		expect(out[0]?.disableModelInvocation).toBe(false);
		expect(out[1]?.disableModelInvocation).toBe(true);
	});
});

describe("set and remove — adding and dropping overlay records (skills_state.rs:56-78)", () => {
	it("upserts on the same {source, name} instead of appending a duplicate", () => {
		// pie: skills_state.rs:235-241
		//   state.set("foo", User, false); state.set("foo", User, true);
		//   assert_eq!(state.overrides.len(), 1, "same {source,name} upserts");
		//   assert!(state.overrides[0].enabled);
		let state = setSkillState(createEmptySkillsState(), "foo", "user", false);
		state = setSkillState(state, "foo", "user", true);
		expect(state.overrides, "same {source,name} upserts").toHaveLength(1);
		expect(state.overrides[0]?.enabled).toBe(true);
	});

	it("removes only the matching {source, name}", () => {
		// pie: skills_state.rs:244-256 — remove is source-aware: after dropping the user's foo, the
		// project's foo has to still be there.
		let state = setSkillState(createEmptySkillsState(), "foo", "user", false);
		state = setSkillState(state, "foo", "project", false);

		const { state: afterUser, removed } = removeSkillState(state, "foo", "user");
		expect(removed).toBe(true);
		expect(lookupSkillState(afterUser, "foo", "user")).toBeUndefined();
		expect(lookupSkillState(afterUser, "foo", "project"), "project foo survives a user-scoped remove").toBeDefined();

		// An entry that does not exist: removed=false, so the caller can skip the write — which is what
		// upstream's boolean return is for.
		expect(removeSkillState(afterUser, "foo", "user").removed).toBe(false);
	});
});

describe("load and save — persisting the overlay (skills_state.rs:86-161)", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pie-skills-state-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("a missing overlay file loads as an empty overlay", async () => {
		// pie: skills_state.rs:299-303
		//   let loaded = load(dir.path()).await;
		//   assert!(loaded.overrides.is_empty());
		expect((await loadSkillsState(dir)).overrides).toEqual([]);
	});

	it("a malformed overlay file loads as empty instead of breaking skill loading", async () => {
		// pie: skills_state.rs:306-316
		//   tokio::fs::write(state_path(dir.path()), "{ not valid json").await.unwrap();
		//   assert!(loaded.overrides.is_empty(), "malformed overlay must not break skill loading");
		//
		// The direction matters: this **degrades to empty**, it does not fail closed. A hand-broken
		// skills-state.json should not make every skill fail to load. Contrast `local_models`'s
		// `malformed_config_fails_closed_without_registering`, which points the other way.
		writeFileSync(skillsStatePath(dir), "{ not valid json", "utf8");
		expect((await loadSkillsState(dir)).overrides, "malformed overlay must not break skill loading").toEqual([]);
	});

	it("round-trips both entries through disk and leaves no temp file behind", async () => {
		// pie: skills_state.rs:270-296
		//   state.set("foo", Project, false); state.set("bar", User, true);
		//   save(dir).await; let loaded = load(dir).await;
		//   assert_eq!(loaded.overrides.len(), 2);
		//   assert_eq!(loaded.lookup("foo", Project).map(|e| e.enabled), Some(false));
		//   assert_eq!(loaded.lookup("bar", User).map(|e| e.enabled), Some(true));
		//   assert_eq!(names, vec![STATE_FILE.to_string()]);   // No leftover tempfile.
		let state = setSkillState(createEmptySkillsState(), "foo", "project", false);
		state = setSkillState(state, "bar", "user", true);
		await saveSkillsState(dir, state);

		const loaded = await loadSkillsState(dir);
		expect(loaded.overrides).toHaveLength(2);
		expect(lookupSkillState(loaded, "foo", "project")?.enabled).toBe(false);
		expect(lookupSkillState(loaded, "bar", "user")?.enabled).toBe(true);

		// A .tmp left behind by the atomic write would let the next load see a half-written file;
		// upstream asserts explicitly that the directory holds only the one file.
		expect(readdirSync(dir), "no leftover tempfile").toEqual([SKILLS_STATE_FILE]);
	});

	it("remove_and_save clears the entry on disk", async () => {
		// pie: skills_state.rs:330-345 (`remove_and_save_clears_entry_on_disk`)
		await saveSkillsState(dir, setSkillState(createEmptySkillsState(), "foo", "user", false));
		expect(lookupSkillState(await loadSkillsState(dir), "foo", "user")).toBeDefined();

		await removeAndSaveSkillsState(dir, "foo", "user");
		const afterRemove = lookupSkillState(await loadSkillsState(dir), "foo", "user");
		expect(afterRemove, "removeAndSave cleared it on disk, not just in memory").toBeUndefined();
	});
});
