/**
 * 1:1 port of oracle `crates/coding-agent/tests/cli_skills.rs` (pie @0a120dfd) — 4
 * `#[tokio::test]` functions, 4 tests here, 0 skipped.
 *
 * Oracle module doc: "End-to-end test for the CLI's skills loader wiring. Strategy: simulate the
 * dual-root layout (user-global at `~/.pie/skills/<name>/SKILL.md` + project-local at
 * `<cwd>/.pie/skills/<name>/SKILL.md`) using a tempdir as the home (`PIE_DIR`) and a separate
 * tempdir as the project cwd. Then run the same loader the CLI runs and assert: 1. Both skills
 * are loaded. 2. When user + project define the same skill name, project wins. 3. Loaded skills
 * are stitched into the final harness system prompt."
 *
 * {@link loadAllSkills} below is the direct translation of oracle's `mod skills_mirror` — oracle
 * deliberately re-creates the binary's `skills::load_all` in the test file (the crate is a
 * `[[bin]]` with no `[lib]`, so the real module isn't importable) and carries the caveat "if the
 * duplicate drifts, the test fails the next time we touch it". Same construction here, over the
 * same primitive oracle's mirror calls: `pie_agent_core::load_skills` -> `@pie/agent-core`'s
 * `loadSkills(env, dirs)`. The shipped CLI reaches the identical project-wins outcome through
 * `src/core/skills.ts`'s `loadSkills({ includeDefaults: true })`, which loads project first and
 * keeps first-wins (see its `pie: skills.rs:14-16,41` comment) rather than oracle's
 * user-first/overwrite order; that function additionally reports a TS-only `type: "collision"`
 * diagnostic for the shadowed entry, which oracle's diagnostics vocabulary has no counterpart
 * for — one more reason the mirror (not the product wrapper) is the faithful target for oracle's
 * `diagnostics.is_empty()` assertions.
 *
 * Other construct mappings:
 * - `Skill.source: SkillSource` is a field on oracle's `Skill` struct. `@pie/agent-core`'s
 *   `Skill` has no such field — provenance lives in `src/skills-state.ts`'s standalone
 *   `SkillSource`/`skillSourceLabel` (see that file's `pie: types.rs:244-263` note), so the
 *   mirror attaches it as `SourcedSkill = Skill & { source }`, structurally still a `Skill`.
 * - `harness.skills()` -> `harness.getResources().skills`;
 *   `harness.system_prompt()` -> `harness.getSystemPrompt()`.
 * - `AgentHarnessOptions.skills` -> `AgentHarnessOptions.resources.skills`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Skill, SkillDiagnostic } from "@pie/agent-core";
import { AgentHarness, InMemorySessionStorage, loadSkills, Session } from "@pie/agent-core";
import { type FauxProviderRegistration, registerFauxProvider } from "@pie/ai";
import { afterEach, describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../../agent/src/harness/env/nodejs.ts";
import { type SkillSource, skillSourceLabel } from "../../src/skills-state.ts";

let registrations: FauxProviderRegistration[] = [];
let tempDirs: string[] = [];

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/** pie: cli_skills.rs:70-86 (`faux_model`). */
function fauxProvider(): FauxProviderRegistration {
	const registration = registerFauxProvider({ provider: "faux", models: [{ id: "faux", name: "Faux" }] });
	registrations.push(registration);
	return registration;
}

type SourcedSkill = Skill & { source: SkillSource };

interface LoadedSkills {
	skills: SourcedSkill[];
	diagnostics: SkillDiagnostic[];
}

/**
 * pie: cli_skills.rs:24-61 (`mod skills_mirror`, `load_all`). Mirrors the real `skills::load_all`:
 * load user first, project second (project wins), tagging each skill with the source of the root
 * it came from.
 */
async function loadAllSkills(cwd: string, baseDir: string): Promise<LoadedSkills> {
	const project = join(cwd, ".pie", "skills");
	const user = join(baseDir, "skills");
	const env = new NodeExecutionEnv({ cwd });
	const roots: Array<[string, SkillSource]> = [
		[user, "user"],
		[project, "project"],
	];
	let combined: SourcedSkill[] = [];
	let diagnostics: SkillDiagnostic[] = [];
	for (const [dir, source] of roots) {
		const out = await loadSkills(env, [dir]);
		diagnostics = [...diagnostics, ...out.diagnostics];
		for (const loaded of out.skills) {
			const skill: SourcedSkill = { ...loaded, source };
			const index = combined.findIndex((existing) => existing.name === skill.name);
			combined =
				index === -1 ? [...combined, skill] : combined.map((existing, i) => (i === index ? skill : existing));
		}
	}
	return { skills: combined, diagnostics };
}

/** pie: cli_skills.rs:63-68 (`write_skill`). */
function writeSkill(root: string, name: string, description: string, body: string): void {
	const dir = join(root, "skills", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`);
}

afterEach(() => {
	for (const registration of registrations) registration.unregister();
	registrations = [];
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	tempDirs = [];
});

describe("cli_skills.rs (char-tests port)", () => {
	// pie: cli_skills.rs:88-167
	it("project_skill_overrides_user_skill_with_same_name", async () => {
		const home = tempDir("pie-ported-cli-skills-home-");
		const cwd = tempDir("pie-ported-cli-skills-cwd-");

		// user-global skill
		writeSkill(home, "shared", "user-version", "USER BODY");
		// project-local skill with same name — should win
		writeSkill(join(cwd, ".pie"), "shared", "project-version", "PROJECT BODY");
		// user-only skill (no project counterpart)
		writeSkill(home, "only-user", "user-only", "ONLY USER BODY");

		const loaded = await loadAllSkills(cwd, home);
		expect(loaded.diagnostics, `unexpected diagnostics: ${JSON.stringify(loaded.diagnostics)}`).toEqual([]);
		const names = loaded.skills.map((s) => s.name);
		expect(names).toContain("shared");
		expect(names).toContain("only-user");
		const shared = loaded.skills.find((s) => s.name === "shared");
		expect(shared).toBeDefined();
		expect(shared?.description, "project should override user on same name").toBe("project-version");
		expect(shared?.content, `shared content should come from project: ${shared?.content}`).toContain("PROJECT BODY");

		// Now feed into an actual harness and confirm the system prompt includes both skills.
		const registration = fauxProvider();
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness<SourcedSkill>({
			env: new NodeExecutionEnv({ cwd }),
			session,
			model: registration.getModel(),
			systemPrompt: "base prompt",
			thinkingLevel: "off",
			resources: { skills: loaded.skills },
		});

		const prompt = harness.getSystemPrompt();
		expect(prompt).toContain("base prompt");
		expect(prompt, `system prompt should list 'shared' skill: ${prompt}`).toContain("name: shared");
		expect(prompt, `system prompt should list 'only-user' skill: ${prompt}`).toContain("name: only-user");
		// Description identifies which version landed. Skill bodies are invoked via the `Skill`
		// tool, not inlined into the prompt — so we don't assert on `PROJECT BODY` here.
		expect(prompt, `project version of 'shared' should win in system prompt: ${prompt}`).toContain(
			"description: project-version",
		);
		expect(prompt, `user version of 'shared' must NOT appear in the listing: ${prompt}`).not.toContain(
			"description: user-version",
		);

		// Sanity-check: the project body actually lives on the in-memory skill record (so when the
		// model later invokes `Skill('shared')`, it gets the project copy).
		const kept = harness.getResources().skills?.find((s) => s.name === "shared");
		expect(kept, "shared skill present").toBeDefined();
		expect(kept?.content, `harness should keep project body for the shared skill: ${kept?.content}`).toContain(
			"PROJECT BODY",
		);
	});

	// pie: cli_skills.rs:169-180
	it("missing_roots_load_cleanly", async () => {
		const home = tempDir("pie-ported-cli-skills-home-");
		const cwd = tempDir("pie-ported-cli-skills-cwd-");
		const loaded = await loadAllSkills(cwd, home);
		expect(loaded.skills).toEqual([]);
		expect(
			loaded.diagnostics,
			`non-existent roots should produce no diagnostics: ${JSON.stringify(loaded.diagnostics)}`,
		).toEqual([]);
	});

	// pie: cli_skills.rs:182-218
	it("loader_tags_skill_source_per_root", async () => {
		const home = tempDir("pie-ported-cli-skills-home-");
		const cwd = tempDir("pie-ported-cli-skills-cwd-");

		// One skill in each root, distinct names so no shadowing.
		writeSkill(home, "user-skill", "u", "USER");
		writeSkill(join(cwd, ".pie"), "project-skill", "p", "PROJECT");

		const loaded = await loadAllSkills(cwd, home);

		const user = loaded.skills.find((s) => s.name === "user-skill");
		expect(user, "user skill loaded").toBeDefined();
		const project = loaded.skills.find((s) => s.name === "project-skill");
		expect(project, "project skill loaded").toBeDefined();

		expect(user?.source, "skill from ~/.pie/skills must be tagged User").toBe("user");
		expect(project?.source, "skill from <cwd>/.pie/skills must be tagged Project").toBe("project");
		// The display label the `/skills` listing renders comes straight off the field now.
		expect(skillSourceLabel(user?.source as SkillSource)).toBe("user");
		expect(skillSourceLabel(project?.source as SkillSource)).toBe("project");
	});

	// pie: cli_skills.rs:220-243
	it("loader_tags_project_source_when_project_shadows_user", async () => {
		const home = tempDir("pie-ported-cli-skills-home-");
		const cwd = tempDir("pie-ported-cli-skills-cwd-");

		// Same name in both roots — project wins, and the surviving entry must carry the
		// Project source (not the User source it would have had if shadowing dropped the tag).
		writeSkill(home, "shared", "user-version", "USER BODY");
		writeSkill(join(cwd, ".pie"), "shared", "project-version", "PROJECT BODY");

		const loaded = await loadAllSkills(cwd, home);
		const shared = loaded.skills.find((s) => s.name === "shared");
		expect(shared, "shared skill loaded").toBeDefined();
		expect(shared?.source, "project-shadowed skill must report Project source").toBe("project");
	});
});
