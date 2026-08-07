import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSkillTool, createSkillToolDefinition } from "../src/tools/skill.ts";

// pie: crates/coding-agent/src/tools/skill.rs (pie @0a120dfd) -- tests ported from the oracle
// `#[cfg(test)] mod tests` block. Structural adaptation (documented in skill.ts's module docs,
// NOT ported here as a pass/fail assertion): oracle reaches a live `AgentHarness::skills()`
// snapshot via a `SkillHarnessCell`; this port has no such cell (see skill.ts's module doc for
// why) and instead re-scans disk + the skills-state.json overlay per call via
// `loadEffectiveSkills`. `unset_harness_cell_returns_recoverable_error_not_panic` (oracle test) is
// therefore not portable -- there is no "unset cell" state in this architecture -- and is
// intentionally NOT ported. `disabled_skill_refuses_body_via_model_path` and
// `..._via_steering_path` (oracle: identical assertions on two different call sites into the same
// `execute()`) collapse into a single test here since this port has only one call path.

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((c) => c.type === "text")?.text ?? "";
}

function writeSkillMd(skillsRoot: string, name: string, opts?: { description?: string; disabled?: boolean }): string {
	const skillDir = join(skillsRoot, name);
	mkdirSync(skillDir, { recursive: true });
	const frontmatterLines = [`name: ${name}`, `description: ${opts?.description ?? `description of ${name}`}`];
	if (opts?.disabled) frontmatterLines.push("disable-model-invocation: true");
	const content = `---\n${frontmatterLines.join("\n")}\n---\nBody of the ${name} skill.\n`;
	const filePath = join(skillDir, "SKILL.md");
	writeFileSync(filePath, content);
	return filePath;
}

describe("skill tool", () => {
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "skill-tool-agent-"));
		cwd = mkdtempSync(join(tmpdir(), "skill-tool-cwd-"));
	});

	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});

	function tool() {
		return createSkillTool(cwd, { agentDir });
	}

	// pie: skill.rs:108-127 (verbatim description + schema shape)
	it("exposes the oracle schema shape (name/description/additionalProperties)", () => {
		const def = createSkillToolDefinition(cwd, { agentDir });
		expect(def.name).toBe("Skill");
		expect(def.description).toBe(
			"Invoke a skill by name. Returns the skill body wrapped in a `<skill>` block for the " +
				"model to follow. Use this when the skill registry in the system prompt indicates the " +
				"skill is relevant to the current task. The skill name must match exactly an entry in " +
				"the registry.",
		);
		const params = def.parameters as unknown as {
			additionalProperties: boolean;
			required: string[];
			properties: { name: { type?: string } };
		};
		expect(params.additionalProperties).toBe(false);
		expect(params.required).toEqual(["name"]);
	});

	// pie: skill.rs:189-203 (hit_returns_wrapped_body)
	it("hit returns the wrapped body", async () => {
		writeSkillMd(join(agentDir, "skills"), "alpha");
		const result = await tool().execute("call-1", { name: "alpha" }, undefined, undefined);
		const text = getText(result);
		expect(text).toContain('<skill name="alpha"');
		expect(text).toContain("Body of the alpha skill.");
		expect(result.details).toMatchObject({ name: "alpha" });
	});

	// pie: skill.rs:205-220 (miss_returns_typed_error)
	it("miss returns a typed error naming /skills", async () => {
		writeSkillMd(join(agentDir, "skills"), "alpha");
		await expect(tool().execute("call-1", { name: "nonexistent" }, undefined, undefined)).rejects.toThrow(
			/no skill named 'nonexistent'.*\/skills/,
		);
	});

	// pie: skill.rs:222-260 (disabled_skill_refuses_body_via_model_path + ..._via_steering_path,
	// collapsed -- see file header)
	it("disabled skill refuses the body", async () => {
		writeSkillMd(join(agentDir, "skills"), "locked", { disabled: true });
		await expect(tool().execute("call-1", { name: "locked" }, undefined, undefined)).rejects.toThrow(
			/disabled.*disable_model_invocation.*frontmatter/s,
		);
	});

	// pie: skill.rs:277-292 (missing_name_arg_is_a_typed_error)
	it("missing name arg is a typed error", async () => {
		await expect(tool().execute("call-1", {} as unknown as { name: string }, undefined, undefined)).rejects.toThrow(
			"missing required arg: name",
		);
	});

	it("enforces disable_model_invocation set via the skills-state.json overlay, not just frontmatter", async () => {
		// Not an oracle test (oracle's harness.skills() already reflects whatever overlay-applying
		// reload_skills_fn the embedder wired); asserts this port's loadEffectiveSkills() actually
		// layers ../skills-state.ts on top of the raw frontmatter value.
		const { setAndSaveSkillsState } = await import("../src/skills-state.ts");
		writeSkillMd(join(agentDir, "skills"), "beta");
		await setAndSaveSkillsState(agentDir, "beta", "user", false);
		await expect(tool().execute("call-1", { name: "beta" }, undefined, undefined)).rejects.toThrow(/disabled/);
	});
});
