import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { loadSkills, loadSourcedSkills } from "../../src/harness/skills.ts";
import { createTempDir } from "./session-test-utils.ts";

describe("loadSkills", () => {
	it("loads SKILL.md files through the execution environment", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir(".agents/skills/example", { recursive: true });
		await env.writeFile(
			".agents/skills/example/SKILL.md",
			`---
name: example
description: Example skill
disable-model-invocation: true
---
Use this skill.
`,
		);

		const { skills, diagnostics } = await loadSkills(env, ".agents/skills");

		expect(diagnostics).toEqual([]);
		expect(skills).toEqual([
			{
				name: "example",
				description: "Example skill",
				content: "Use this skill.",
				filePath: join(root, ".agents/skills/example/SKILL.md"),
				disableModelInvocation: true,
			},
		]);
	});

	it("loads skills through symlinked directories", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("actual/example", { recursive: true });
		await env.writeFile(
			"actual/example/SKILL.md",
			"---\nname: example\ndescription: Example skill\n---\nUse this skill.",
		);
		await symlink(join(root, "actual"), join(root, "skills-link"));

		const { skills } = await loadSkills(env, "skills-link");

		expect(skills.map((skill) => skill.name)).toEqual(["example"]);
		expect(skills[0]?.filePath).toBe(join(root, "skills-link/example/SKILL.md"));
	});

	it("preserves source info for sourced skills", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("user/example", { recursive: true });
		await env.writeFile(
			"user/example/SKILL.md",
			"---\nname: example\ndescription: Example skill\n---\nUse this skill.",
		);

		const { skills, diagnostics } = await loadSourcedSkills(env, [
			{ path: "user", source: { type: "user" as const } },
		]);

		expect(diagnostics).toEqual([]);
		expect(skills).toEqual([
			{
				skill: {
					name: "example",
					description: "Example skill",
					content: "Use this skill.",
					filePath: join(root, "user/example/SKILL.md"),
					disableModelInvocation: false,
				},
				source: { type: "user" },
			},
		]);
	});

	it("attaches source info to diagnostics", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("user/broken", { recursive: true });
		await env.writeFile("user/broken/SKILL.md", "---\nname: broken\n---\nMissing description.");

		const { skills, diagnostics } = await loadSourcedSkills(env, [
			{ path: "user", source: { type: "user" as const } },
		]);

		expect(skills).toEqual([]);
		expect(diagnostics).toEqual([
			{
				type: "warning",
				code: "invalid_metadata",
				message: "description is required",
				path: join(root, "user/broken/SKILL.md"),
				source: { type: "user" },
			},
		]);
	});

	it("loads direct markdown children only from the root directory", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("skills/nested", { recursive: true });
		await env.writeFile("skills/root.md", "---\ndescription: Root skill\n---\nRoot content");
		await env.writeFile("skills/nested/ignored.md", "---\ndescription: Ignored\n---\nIgnored content");

		const { skills } = await loadSkills(env, "skills");

		expect(skills.map((skill) => skill.name)).toEqual(["skills"]);
		expect(skills[0]?.content).toBe("Root content");
	});

	// pie: harness/types.rs:294-304, skills.rs -- accepts both frontmatter spellings.
	it.each([
		["kebab", "disable-model-invocation"],
		["snake", "disable_model_invocation"],
	])("accepts the %s spelling of disable-model-invocation", async (_label, key) => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("skills/locked", { recursive: true });
		await env.writeFile(
			"skills/locked/SKILL.md",
			`---\nname: locked\ndescription: refuses model invocation\n${key}: true\n---\nBody body.`,
		);

		const { skills, diagnostics } = await loadSkills(env, "skills");

		expect(diagnostics).toEqual([]);
		expect(skills).toHaveLength(1);
		expect(skills[0]?.disableModelInvocation).toBe(true);
	});

	// pie: harness/types.rs:298-303 -- both spellings present at once hits serde's
	// "duplicate field" error (both keys map onto the same struct field via `alias`).
	it("reports a parse_failed diagnostic when both disable-model-invocation spellings are present", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("skills/dupe", { recursive: true });
		await env.writeFile(
			"skills/dupe/SKILL.md",
			"---\nname: dupe\ndescription: x\ndisable_model_invocation: true\ndisable-model-invocation: false\n---\nBody.",
		);

		const { skills, diagnostics } = await loadSkills(env, "skills");

		expect(skills).toEqual([]);
		expect(diagnostics).toEqual([
			{
				type: "warning",
				code: "parse_failed",
				message: "yaml: duplicate field `disable_model_invocation`",
				path: join(root, "skills/dupe/SKILL.md"),
			},
		]);
	});

	// pie: skills.rs:279-282 -- `frontmatter.name.unwrap_or_else(...)` only defaults on an
	// ABSENT key, not a falsy one; an explicit empty string is kept as-is.
	it("keeps an explicit empty frontmatter name instead of falling back to the parent dir name", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("skills/real-name", { recursive: true });
		await env.writeFile(`skills/real-name/SKILL.md`, `---\nname: ""\ndescription: x\n---\nBody.`);

		const { skills, diagnostics } = await loadSkills(env, "skills");

		expect(skills).toHaveLength(1);
		expect(skills[0]?.name).toBe("");
		expect(diagnostics.some((d) => d.message.includes('does not match parent directory "real-name"'))).toBe(true);
	});

	// pie: skills.rs:114-123,164-187 -- subdirectories are pushed onto a shared LIFO stack
	// rather than recursed into immediately: root `*.md` files load before ANY subdirectory's
	// skills, and sibling subdirectories are visited in *descending* name order.
	it("discovers skills in oracle's stack order: root .md files first, then subdirectories descending", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("skills/alpha", { recursive: true });
		await env.createDir("skills/gamma", { recursive: true });
		// Root-level *.md skills fall back to the parent (walk-root) dir name when frontmatter
		// omits `name` -- here that's "skills" itself (matches the pre-existing "loads direct
		// markdown children only from the root directory" test's fallback behavior above).
		await env.writeFile("skills/beta.md", "---\ndescription: beta skill\n---\nbeta body");
		await env.writeFile("skills/alpha/SKILL.md", "---\nname: alpha\ndescription: alpha skill\n---\nalpha body");
		await env.writeFile("skills/gamma/SKILL.md", "---\nname: gamma\ndescription: gamma skill\n---\ngamma body");

		const { skills, diagnostics } = await loadSkills(env, "skills");

		expect(diagnostics).toEqual([]);
		// pie: skills.rs:164-187,279-282 -- the root-level beta.md loads inline (before any
		// subdirectory), and falls back to the walk-root's own dir name ("skills") since its
		// frontmatter omits `name`; gamma/alpha follow in descending (stack) order.
		expect(skills.map((s) => s.name)).toEqual(["skills", "gamma", "alpha"]);
		expect(skills[0]?.content).toBe("beta body");
	});

	// pie: skills.rs:189-236,314-331 -- each ignore file REPLACES the accumulated matcher
	// wholesale rather than unioning with ancestor directories' rules (oracle's own documented
	// fidelity loss vs a true union).
	it("lets a subdirectory's own ignore file wipe out an ancestor's ignore rule (oracle's merge_ignores bug)", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("skills/childdir/subdir-x", { recursive: true });
		await env.createDir("skills/childdir/subdir-y", { recursive: true });
		await env.writeFile("skills/.gitignore", "childdir/subdir-x\n");
		await env.writeFile("skills/childdir/.gitignore", "unrelated-pattern\n");
		await env.writeFile(
			"skills/childdir/subdir-x/SKILL.md",
			"---\nname: subdir-x\ndescription: should have been ignored\n---\nbody",
		);
		await env.writeFile(
			"skills/childdir/subdir-y/SKILL.md",
			"---\nname: subdir-y\ndescription: control skill\n---\nbody",
		);

		const { skills } = await loadSkills(env, "skills");

		// Faithful to oracle: subdir-x's own ignore-file addition at `childdir` discards the
		// ancestor `.gitignore`'s "childdir/subdir-x" rule, so subdir-x is loaded anyway.
		expect(skills.map((s) => s.name).sort()).toEqual(["subdir-x", "subdir-y"]);
	});
});
