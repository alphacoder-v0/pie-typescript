import { describe, expect, it } from "vitest";
import { formatSkillsForSystemPrompt } from "../../src/harness/system-prompt.ts";

const alphaSkill = {
	name: "alpha",
	description: "first skill",
	content: "alpha content",
	filePath: "/skills/alpha/SKILL.md",
};

const betaSkill = {
	name: "beta",
	description: "second skill",
	content: "beta content",
	filePath: "/skills/beta/SKILL.md",
};

const disabledSkill = {
	name: "hidden",
	description: "hidden but still catalogued",
	content: "hidden content",
	filePath: "/skills/hidden/SKILL.md",
	disableModelInvocation: true,
};

// pie: system_prompt.rs:39-68 (translated `#[cfg(test)] mod tests`) plus the divergences found
// against the oracle-vs-base diff: no XML, no disable_model_invocation filtering.
describe("formatSkillsForSystemPrompt", () => {
	it("is empty when there are no skills", () => {
		expect(formatSkillsForSystemPrompt([])).toBe("");
	});

	it("renders each skill as one dash-list line, verbatim preamble, no XML", () => {
		const out = formatSkillsForSystemPrompt([alphaSkill, betaSkill]);
		expect(out.startsWith("<skills>\n")).toBe(true);
		expect(out).toContain(
			"The user has provided skills they want you to use whenever the user request can be solved with their help.\n",
		);
		expect(out).toContain("Below is a list of skills with their unique names and descriptions of what they do.\n");
		expect(out).toContain("Use the `Skill` tool to invoke a skill by name when applicable.\n");
		expect(out).toContain(
			"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.\n",
		);
		expect(out).toContain("- name: alpha\n  description: first skill\n");
		expect(out).toContain("- name: beta\n  description: second skill\n");
		expect(out.endsWith("</skills>")).toBe(true);
		expect(out).not.toContain("<available_skills>");
		expect(out).not.toContain("<name>");
	});

	it("produces the exact byte layout oracle produces", () => {
		const out = formatSkillsForSystemPrompt([alphaSkill]);
		expect(out).toBe(
			"<skills>\n" +
				"The user has provided skills they want you to use whenever the user request can be solved with their help.\n" +
				"Below is a list of skills with their unique names and descriptions of what they do.\n" +
				"Use the `Skill` tool to invoke a skill by name when applicable.\n" +
				"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.\n" +
				"\n" +
				"- name: alpha\n  description: first skill\n" +
				"</skills>",
		);
	});

	// pie: crates/agent/tests/skills_loader.rs:230-238 (issue #25 v3) -- disable_model_invocation
	// does NOT affect the system-prompt block; a disabled skill still appears in the catalog. The
	// flag is enforced only at Skill-tool execute time (out of scope for this unit), not here.
	it("still lists a disable_model_invocation skill in the catalog", () => {
		const out = formatSkillsForSystemPrompt([alphaSkill, disabledSkill]);
		expect(out).toContain("- name: hidden\n  description: hidden but still catalogued\n");
	});
});
