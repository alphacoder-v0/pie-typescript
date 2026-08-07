/**
 * char-tests port of oracle `crates/agent/tests/skills_loader.rs` (pie @0a120dfd).
 *
 * End-to-end skill discovery against a real tempdir. Validates the SKILL.md walking, YAML
 * frontmatter parsing, name/parent-dir matching, and the system-prompt block format.
 *
 * `NativeEnv` -> `NodeExecutionEnv`; `load_skills(&env, dirs, cancel)` -> `loadSkills(env, dirs)`
 * (no cancellation-token param in the TS surface — no behavior gap, `skills.ts` has no
 * long-running/cancellable step). `SkillDiagnosticCode::InvalidMetadata` -> the string literal
 * `"invalid_metadata"`.
 */
import { registerFauxProvider } from "@pie/ai";
import { describe, expect, it } from "vitest";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { Session } from "../../src/harness/session/session.ts";
import { loadSkills } from "../../src/harness/skills.ts";
import { formatSkillsForSystemPrompt } from "../../src/harness/system-prompt.ts";
import { createTempDir } from "../harness/session-test-utils.ts";

function envAt(root: string): NodeExecutionEnv {
	return new NodeExecutionEnv({ cwd: root });
}

describe("skills_loader (char-tests port)", () => {
	it("discovers_skill_with_matching_parent_dir", async () => {
		const root = createTempDir();
		const env = envAt(root);
		await env.createDir("my-skill", { recursive: true });
		await env.writeFile("my-skill/SKILL.md", "---\nname: my-skill\ndescription: tells you things\n---\nBody body.");

		const out = await loadSkills(env, [root]);

		expect(out.diagnostics, `unexpected diagnostics: ${JSON.stringify(out.diagnostics)}`).toEqual([]);
		expect(out.skills).toHaveLength(1);
		const s = out.skills[0]!;
		expect(s.name).toBe("my-skill");
		expect(s.description).toBe("tells you things");
		expect(s.content).toBe("Body body.");
	});

	it("missing_description_emits_diagnostic_and_skips", async () => {
		const root = createTempDir();
		const env = envAt(root);
		await env.createDir("nodesc", { recursive: true });
		await env.writeFile("nodesc/SKILL.md", "---\nname: nodesc\n---\nBody.");

		const out = await loadSkills(env, [root]);

		expect(out.skills, "skills without description should be skipped").toEqual([]);
		expect(
			out.diagnostics.some((d) => d.code === "invalid_metadata" && d.message.includes("description is required")),
			`expected invalid_metadata diagnostic; got ${JSON.stringify(out.diagnostics)}`,
		).toBe(true);
	});

	it("name_must_match_parent_dir", async () => {
		const root = createTempDir();
		const env = envAt(root);
		await env.createDir("real-name", { recursive: true });
		await env.writeFile("real-name/SKILL.md", "---\nname: different\ndescription: x\n---\nBody.");

		const out = await loadSkills(env, [root]);

		// skill still loads (TS keeps it; only emits a warning), but a diagnostic flags the mismatch.
		expect(
			out.diagnostics.some((d) => d.message.includes("does not match parent directory")),
			`expected name-mismatch diagnostic; got ${JSON.stringify(out.diagnostics)}`,
		).toBe(true);
	});

	it("system_prompt_block_lists_each_skill", async () => {
		const root = createTempDir();
		const env = envAt(root);
		for (const name of ["alpha", "beta"]) {
			await env.createDir(name, { recursive: true });
			await env.writeFile(`${name}/SKILL.md`, `---\nname: ${name}\ndescription: it does ${name}\n---\nbody`);
		}
		const out = await loadSkills(env, [root]);
		expect(out.skills).toHaveLength(2);
		const block = formatSkillsForSystemPrompt(out.skills);
		expect(block.startsWith("<skills>\n")).toBe(true);
		expect(block).toContain("- name: alpha");
		expect(block).toContain("- name: beta");
		expect(block.endsWith("</skills>")).toBe(true);
	});

	it("disable_model_invocation_accepts_both_kebab_and_snake", async () => {
		for (const [label, frontmatterKey] of [
			["kebab", "disable-model-invocation"],
			["snake", "disable_model_invocation"],
		] as const) {
			const root = createTempDir();
			const env = envAt(root);
			await env.createDir("locked", { recursive: true });
			await env.writeFile(
				"locked/SKILL.md",
				`---\nname: locked\ndescription: refuses model invocation\n${frontmatterKey}: true\n---\nBody body.`,
			);
			const out = await loadSkills(env, [root]);
			expect(out.diagnostics, `[${label}] unexpected diagnostics: ${JSON.stringify(out.diagnostics)}`).toEqual([]);
			expect(out.skills, `[${label}] expected one skill`).toHaveLength(1);
			expect(
				out.skills[0]!.disableModelInvocation,
				`[${label}] frontmatter key ${frontmatterKey} must set disableModelInvocation=true`,
			).toBe(true);
		}
	});

	// Issue #25 PR C: prove the `<skills>` block in the system prompt is fully reconstructable
	// from disk — two independent `loadSkills` runs against the same tempdir must produce
	// byte-identical `formatSkillsForSystemPrompt` output.
	it("resume_rebuilds_skill_block_byte_identical_from_same_directory", async () => {
		const root = createTempDir();
		const env = envAt(root);
		for (const [name, description, body, disabled] of [
			["alpha", "first skill", "alpha body", false],
			["beta", "second skill", "beta body", true],
			["gamma", "third skill", "gamma body", false],
		] as const) {
			await env.createDir(name, { recursive: true });
			let frontmatter = `name: ${name}\ndescription: ${description}\n`;
			if (disabled) frontmatter += "disable_model_invocation: true\n";
			await env.writeFile(`${name}/SKILL.md`, `---\n${frontmatter}---\n${body}`);
		}

		const first = await loadSkills(env, [root]);
		expect(first.diagnostics, `unexpected diagnostics on first load: ${JSON.stringify(first.diagnostics)}`).toEqual(
			[],
		);
		const firstBlock = formatSkillsForSystemPrompt(first.skills);

		const second = await loadSkills(env, [root]);
		expect(
			second.diagnostics,
			`unexpected diagnostics on resume load: ${JSON.stringify(second.diagnostics)}`,
		).toEqual([]);
		const secondBlock = formatSkillsForSystemPrompt(second.skills);

		expect(firstBlock, "skill block diverged across reloads").toBe(secondBlock);

		expect(firstBlock.startsWith("<skills>\n")).toBe(true);
		expect(firstBlock).toContain("- name: alpha\n");
		expect(firstBlock).toContain("- name: beta\n");
		expect(firstBlock).toContain("- name: gamma\n");
		expect(firstBlock.endsWith("</skills>")).toBe(true);

		const positions = (block: string) =>
			[block.indexOf("- name: alpha\n"), block.indexOf("- name: beta\n"), block.indexOf("- name: gamma\n")] as const;
		expect(positions(firstBlock), "relative skill positions diverged across reloads").toEqual(positions(secondBlock));

		// disable_model_invocation does not affect the system-prompt block (per issue #25 v3: the
		// flag is enforced at Skill-tool execute time, not in the catalog rendering).
		expect(second.skills.some((s) => s.name === "beta" && s.disableModelInvocation)).toBe(true);
	});

	// pie: skills_loader.rs:242-339 (`resume_rebuilds_harness_system_prompt_byte_identical`).
	// Issue #25 PR C harness-level acceptance: two `AgentHarness` instances built against the same
	// skills directory and the same non-empty base `systemPrompt` must expose byte-identical
	// `getSystemPrompt()` — the actual `--resume` scenario. `AgentHarness.getSystemPrompt()`
	// composes `base + formatSkillsForSystemPrompt(skills)` (agent-harness.ts's `buildSystemPrompt`/
	// `getSystemPrompt`), so any drift in skill load ordering, formatter rendering, or the
	// concatenation itself would surface as a divergent system prompt and break LLM determinism on
	// resume.
	it("resume_rebuilds_harness_system_prompt_byte_identical", async () => {
		const root = createTempDir();
		const env = envAt(root);
		for (const [name, description, body, disabled] of [
			["alpha", "first skill", "alpha body", false],
			["beta", "second skill", "beta body", true],
			["gamma", "third skill", "gamma body", false],
		] as const) {
			await env.createDir(name, { recursive: true });
			let frontmatter = `name: ${name}\ndescription: ${description}\n`;
			if (disabled) frontmatter += "disable_model_invocation: true\n";
			await env.writeFile(`${name}/SKILL.md`, `---\n${frontmatter}---\n${body}`);
		}

		const baseSystemPrompt = "You are a careful coding assistant. Use the tools you have, never invent state.";
		const registration = registerFauxProvider();

		const buildHarnessSystemPrompt = async () => {
			const load = await loadSkills(env, [root]);
			expect(load.diagnostics, `unexpected diagnostics: ${JSON.stringify(load.diagnostics)}`).toEqual([]);
			const session = new Session(new InMemorySessionStorage());
			const harness = new AgentHarness({
				env,
				session,
				model: registration.getModel(),
				systemPrompt: baseSystemPrompt,
				resources: { skills: load.skills },
			});
			return harness.getSystemPrompt();
		};

		try {
			const firstPrompt = await buildHarnessSystemPrompt();
			const secondPrompt = await buildHarnessSystemPrompt();

			// The actual --resume acceptance: harness-level getSystemPrompt() is byte-identical
			// across two independent constructions from the same skills directory.
			expect(
				firstPrompt,
				"AgentHarness.getSystemPrompt diverged across reloads — would break LLM determinism on resume",
			).toBe(secondPrompt);

			// Covers the base + `<skills>` concatenation path inside `buildSystemPrompt`.
			expect(
				firstPrompt.startsWith(baseSystemPrompt),
				"system prompt must start with the supplied base prompt",
			).toBe(true);
			expect(firstPrompt.includes("<skills>"), "system prompt must include the skills catalog block").toBe(true);
			expect(firstPrompt.includes("- name: alpha\n"), "system prompt must list alpha").toBe(true);
			expect(
				firstPrompt.includes("- name: beta\n"),
				"system prompt must list beta even though disable_model_invocation=true",
			).toBe(true);
			expect(firstPrompt.endsWith("</skills>"), "system prompt must end with the closing skills tag").toBe(true);
		} finally {
			registration.unregister();
		}
	});
});
