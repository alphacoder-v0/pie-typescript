import { describe, expect, it } from "vitest";
import {
	availableBuiltinNames,
	type BuiltinSkill,
	mergeWithUserProject,
	parseBuiltinSkillsConfig,
	resolveBuiltins,
	stripFrontmatter,
	UnknownBuiltinSkillError,
} from "../src/builtin-skills.ts";

// pie: crates/coding-agent/src/builtin_skills.rs `#[cfg(test)] mod tests` -- ported 1:1 (test
// names kept close to oracle's for reviewer cross-reference).

describe("builtin-skills", () => {
	it("available names is sorted and contains karpathy", () => {
		const names = availableBuiltinNames();
		const sorted = [...names].sort();
		expect(names).toEqual(sorted);
		expect(names).toContain("karpathy-guidelines");
	});

	it("no request returns empty, no diagnostics", () => {
		const resolved = resolveBuiltins([], []);
		expect(resolved.skills).toHaveLength(0);
		expect(resolved.diagnostics).toHaveLength(0);
	});

	it("cli known name enables skill with stripped body", () => {
		const resolved = resolveBuiltins(["karpathy-guidelines"], []);
		expect(resolved.skills).toHaveLength(1);
		const s = resolved.skills[0]!;
		expect(s.name).toBe("karpathy-guidelines");
		expect(s.description.startsWith("Behavioral guidelines")).toBe(true);
		expect(s.filePath).toBe("<builtin>/karpathy-guidelines/SKILL.md");
		// Frontmatter is stripped -- body starts with the H1 header.
		expect(s.content.startsWith("# Karpathy Guidelines")).toBe(true);
		// No frontmatter delimiter left in the body.
		expect(s.content.startsWith("---")).toBe(false);
		expect(s.content.includes("\nlicense: MIT")).toBe(false);
		// Sanity: real guideline text is there.
		expect(s.content.includes("Think Before Coding")).toBe(true);
		// disableModelInvocation defaults to false (frontmatter has no flag).
		expect(s.disableModelInvocation).toBe(false);
		expect(s.source).toBe("builtin");
	});

	it("cli unknown name hard fails with available list", () => {
		expect(() => resolveBuiltins(["nonexistent-skill"], [])).toThrow(UnknownBuiltinSkillError);
		try {
			resolveBuiltins(["nonexistent-skill"], []);
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(UnknownBuiltinSkillError);
			const e = err as UnknownBuiltinSkillError;
			expect(e.unknown).toEqual(["nonexistent-skill"]);
			expect(e.available).toContain("karpathy-guidelines");
			// Sorted available list -- assert order is stable.
			expect(e.available).toEqual([...e.available].sort());
		}
	});

	it("cli mixes known and unknown reports all unknown at once", () => {
		try {
			resolveBuiltins(["karpathy-guidelines", "missing-a", "missing-b"], []);
			expect.unreachable();
		} catch (err) {
			const e = err as UnknownBuiltinSkillError;
			// Whack-a-mole avoidance -- both unknowns surface in one error.
			expect(e.unknown).toContain("missing-a");
			expect(e.unknown).toContain("missing-b");
			expect(e.unknown).toHaveLength(2);
		}
	});

	it("config unknown name is soft warning, not fail", () => {
		const resolved = resolveBuiltins([], ["nonexistent-skill"]);
		expect(resolved.skills).toHaveLength(0);
		expect(resolved.diagnostics).toHaveLength(1);
		const diag = resolved.diagnostics[0]!;
		expect(diag).toContain("nonexistent-skill");
		expect(diag).toContain("Available: karpathy-guidelines");
	});

	it("config mixes known and unknown keeps known, skips unknown", () => {
		const resolved = resolveBuiltins([], ["karpathy-guidelines", "missing"]);
		expect(resolved.skills).toHaveLength(1);
		expect(resolved.skills[0]!.name).toBe("karpathy-guidelines");
		expect(resolved.diagnostics).toHaveLength(1);
		expect(resolved.diagnostics[0]).toContain("missing");
	});

	it("cli and config same name does not duplicate catalog entry", () => {
		const resolved = resolveBuiltins(["karpathy-guidelines"], ["karpathy-guidelines"]);
		expect(resolved.skills).toHaveLength(1);
		expect(resolved.diagnostics).toHaveLength(0);
	});

	it("cli repeated same name does not duplicate catalog entry", () => {
		const resolved = resolveBuiltins(["karpathy-guidelines", "karpathy-guidelines"], []);
		expect(resolved.skills).toHaveLength(1);
	});

	function fakeSkill(name: string, filePath: string): BuiltinSkill {
		return {
			name,
			description: `desc for ${name}`,
			filePath,
			content: `body of ${name}`,
			disableModelInvocation: false,
			source: "user",
		};
	}

	it("merge: no user/project returns builtins unchanged", () => {
		const builtins = [fakeSkill("karpathy-guidelines", "<builtin>/karpathy-guidelines/SKILL.md")];
		const merged = mergeWithUserProject(builtins, []);
		expect(merged).toHaveLength(1);
		expect(merged[0]!.name).toBe("karpathy-guidelines");
		expect(merged[0]!.filePath).toBe("<builtin>/karpathy-guidelines/SKILL.md");
	});

	it("merge: user/project skill shadows builtin of same name", () => {
		const builtins = [fakeSkill("karpathy-guidelines", "<builtin>/karpathy-guidelines/SKILL.md")];
		const userProject = [fakeSkill("karpathy-guidelines", "/home/me/.pie/skills/karpathy-guidelines/SKILL.md")];
		const merged = mergeWithUserProject(builtins, userProject);
		expect(merged).toHaveLength(1);
		expect(merged[0]!.name).toBe("karpathy-guidelines");
		expect(merged[0]!.filePath).toBe("/home/me/.pie/skills/karpathy-guidelines/SKILL.md");
	});

	it("merge: unrelated user/project skills appended after builtins", () => {
		const builtins = [fakeSkill("karpathy-guidelines", "<builtin>/karpathy-guidelines/SKILL.md")];
		const userProject = [fakeSkill("my-personal-skill", "/home/me/.pie/skills/my-personal-skill/SKILL.md")];
		const merged = mergeWithUserProject(builtins, userProject);
		expect(merged).toHaveLength(2);
		expect(merged[0]!.name).toBe("karpathy-guidelines");
		expect(merged[1]!.name).toBe("my-personal-skill");
	});

	it("merge: handles empty builtins with user/project", () => {
		const userProject = [fakeSkill("my-personal-skill", "/home/me/.pie/skills/my-personal-skill/SKILL.md")];
		const merged = mergeWithUserProject([], userProject);
		expect(merged).toHaveLength(1);
		expect(merged[0]!.name).toBe("my-personal-skill");
	});

	it("parse config extracts enabled list", () => {
		const text = `
[builtin_skills]
enabled = ["karpathy-guidelines", "future-other-skill"]
`;
		expect(parseBuiltinSkillsConfig(text)).toEqual(["karpathy-guidelines", "future-other-skill"]);
	});

	it("parse config missing section is empty list", () => {
		const text = `
[some_other_section]
key = "value"
`;
		expect(parseBuiltinSkillsConfig(text)).toEqual([]);
	});

	it("parse config missing enabled key is empty list", () => {
		const text = `
[builtin_skills]
`;
		expect(parseBuiltinSkillsConfig(text)).toEqual([]);
	});

	it("parse config malformed toml degrades to empty, not throw", () => {
		expect(() => parseBuiltinSkillsConfig("this is not valid toml [ [ [")).not.toThrow();
		expect(parseBuiltinSkillsConfig("this is not valid toml [ [ [")).toEqual([]);
	});

	it("parse config empty string is empty list", () => {
		expect(parseBuiltinSkillsConfig("")).toEqual([]);
	});

	it("vendored SKILL.md frontmatter matches hardcoded metadata (self-check)", () => {
		const resolved = resolveBuiltins(["karpathy-guidelines"], []);
		const s = resolved.skills[0]!;
		// The description used in BuiltinSkill.description must byte-match the description found
		// in the vendored raw markdown's frontmatter (drift detector).
		expect(s.description).toContain("Behavioral guidelines to reduce common LLM coding mistakes");
	});

	describe("stripFrontmatter", () => {
		it("returns original content when no frontmatter delimiter present", () => {
			expect(stripFrontmatter("# just a heading\nbody")).toBe("# just a heading\nbody");
		});

		it("returns original content when opening delimiter has no newline", () => {
			expect(stripFrontmatter("---no newline here")).toBe("---no newline here");
		});

		it("returns original content when no closing delimiter is found", () => {
			const input = "---\nname: x\nbody without closing marker";
			expect(stripFrontmatter(input)).toBe(input);
		});

		it("returns empty string when closing delimiter is exactly at EOF", () => {
			expect(stripFrontmatter("---\nname: x\n---")).toBe("");
		});

		it("strips a BOM only when frontmatter is actually present", () => {
			const withBom = `﻿---\nname: x\n---\n\nbody`;
			expect(stripFrontmatter(withBom)).toBe("body");
		});

		it("keeps the BOM in the fallback path when no frontmatter is present", () => {
			const withBom = "﻿no frontmatter here";
			expect(stripFrontmatter(withBom)).toBe(withBom);
		});
	});
});
