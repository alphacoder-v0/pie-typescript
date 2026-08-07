import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import { parseAndValidateSkillMd } from "../src/tools/install-skill.ts";
import {
	classifySkillBuilderPermission,
	createSkillBuilderTool,
	createSkillBuilderToolDefinition,
	renderSkillMd,
	type SkillBuilderToolDetails,
} from "../src/tools/skill-builder.ts";

// pie: crates/coding-agent/src/tools/skill_builder.rs (pie @0a120dfd) -- tests ported from the
// oracle `#[cfg(test)] mod tests` block. Same two structural adaptations as install-skill.test.ts
// (stateless catalog-snapshot instead of a live harness; no `audit_entry_id` -- see
// install-skill.ts module docs). The oracle "shadow warns about a BUILTIN skill" branch has no TS
// equivalent (`../core/skills.ts` has no builtin-skill concept) and is not ported; see the
// TODO(port) at that site in skill-builder.ts.

function makeArgs(name: string, confirm: boolean) {
	return {
		name,
		description: "review rust code for unwrap abuse; use when reviewing rust PRs",
		instructions: "1. grep for unwrap\n2. flag each in non-test code",
		confirm,
	};
}

describe("skill-builder tool", () => {
	let dir: string;
	let cwd: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "skill-builder-root-"));
		cwd = mkdtempSync(join(tmpdir(), "skill-builder-cwd-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});

	function tool() {
		return createSkillBuilderTool(cwd, { skillsRoot: dir });
	}

	// pie: skill_builder.rs:339-388 (verbatim description + schema shape)
	it("exposes the oracle schema shape (name/description/required/additionalProperties)", () => {
		const def = createSkillBuilderToolDefinition(cwd, { skillsRoot: dir });
		expect(def.name).toBe("SkillBuilder");
		expect(def.description).toContain("Create a NEW user skill from structured fields and hot-reload the catalog.");
		expect(def.description).toContain("Use InstallSkill instead when installing an existing SKILL.md");
		const params = def.parameters as unknown as { additionalProperties: boolean; required: string[] };
		expect(params.additionalProperties).toBe(false);
		expect(params.required).toEqual(["name", "description", "instructions"]);
	});

	// pie: skill_builder.rs:474-494 (render_produces_loadable_canonical_template)
	it("renders a loadable canonical template", () => {
		const rendered = renderSkillMd(
			"code-review-checklist",
			"review code; use when asked to review",
			"step one\nstep two",
		);
		expect(rendered.startsWith("---\n")).toBe(true);
		expect(rendered).toContain("# Code Review Checklist");
		expect(rendered).toContain("## Instructions");
		expect(rendered).toContain("step one\nstep two");
		expect(rendered).not.toContain("## Examples");

		const parsed = parseAndValidateSkillMd(rendered);
		expect(parsed.name).toBe("code-review-checklist");
		expect(parsed.warnings).toHaveLength(0);
	});

	// pie: skill_builder.rs:496-507 (render_includes_examples_section_when_provided)
	it("includes an examples section when provided", () => {
		const rendered = renderSkillMd("alpha", "desc; when", "body", "```\npie session export\n```");
		expect(rendered).toContain("## Examples");
		expect(rendered).toContain("pie session export");
	});

	// pie: skill_builder.rs:509-525 (render_escapes_yaml_specials_and_folds_newlines_in_description)
	it("escapes yaml specials and folds newlines in the description", () => {
		const rendered = renderSkillMd("alpha", 'tricky: contains #yaml "specials"\nand a second line', "body");
		const parsed = parseAndValidateSkillMd(rendered);
		expect(parsed.description).toBe('tricky: contains #yaml "specials" and a second line');
		expect(parsed.warnings).toHaveLength(0);
	});

	// pie: skill_builder.rs:530-556 (preview_is_allowed_and_only_confirm_prompts)
	it("preview is allowed and only confirm prompts", () => {
		const preview = classifySkillBuilderPermission(makeArgs("alpha", false) as never);
		expect(preview.type).toBe("allow");

		const confirm = classifySkillBuilderPermission(makeArgs("alpha", true) as never);
		expect(confirm.type).toBe("prompt");
		expect((confirm as { reason: string }).reason).toContain("alpha");

		const badName = classifySkillBuilderPermission(makeArgs("../etc", true) as never);
		expect(badName.type).toBe("prompt");
		expect((badName as { reason: string }).reason).toContain("<invalid name>");
	});

	// pie: skill_builder.rs:559-581 (preview_returns_metadata_without_writing)
	it("preview returns metadata without writing", async () => {
		const result = await tool().execute("call-1", makeArgs("alpha", false), undefined, undefined);
		const details = result.details as SkillBuilderToolDetails;
		expect(details.phase).toBe("preview");
		expect(details.name).toBe("alpha");
		expect(details.existing).toBe(false);
		expect(details.overwrite_required).toBe(false);
		expect(details.target_path.endsWith("alpha/SKILL.md")).toBe(true);
		expect(() => readFileSync(join(dir, "alpha", "SKILL.md"))).toThrow();
	});

	// pie: skill_builder.rs:583-605 (confirm_writes_skill_and_reloads_catalog) -- adapted:
	// audit_entry_id assertion dropped, see module-level note.
	it("confirm writes the skill and reports it visible in the catalog", async () => {
		const result = await tool().execute("call-1", makeArgs("alpha", true), undefined, undefined);
		const details = result.details as SkillBuilderToolDetails;
		expect(details.phase).toBe("installed");
		expect(details.installed_visible_in_catalog).toBe(true);
		expect(details.audit_entry_id).toBeUndefined();
		const onDisk = readFileSync(join(dir, "alpha", "SKILL.md"), "utf-8");
		expect(onDisk.startsWith("---\nname: alpha\n")).toBe(true);
	});

	// pie: skill_builder.rs:607-621 (rejects_invalid_name_before_any_write)
	it("rejects an invalid name before any write", async () => {
		await expect(tool().execute("call-1", makeArgs("../escape", true), undefined, undefined)).rejects.toThrow(/name/);
		expect(readdirSync(dir)).toHaveLength(0);
	});

	// pie: skill_builder.rs:623-643 (overwrite_requires_explicit_flag)
	it("overwrite requires an explicit flag", async () => {
		const t = tool();
		await t.execute("call-1", makeArgs("alpha", true), undefined, undefined);

		const changed = { ...makeArgs("alpha", true), instructions: "totally different body" };
		await expect(t.execute("call-2", changed, undefined, undefined)).rejects.toThrow(/overwrite/);

		const result = await t.execute("call-3", { ...changed, overwrite: true }, undefined, undefined);
		const details = result.details as SkillBuilderToolDetails;
		expect(details.overwrote).toBe(true);
		const onDisk = readFileSync(join(dir, "alpha", "SKILL.md"), "utf-8");
		expect(onDisk).toContain("totally different body");
	});

	// pie: skill_builder.rs:645-664 (preview_warns_when_project_skill_shadows_new_name) -- adapted:
	// oracle seeds the harness's in-memory skill list directly; this port has no such seed, so the
	// "project skill" must actually exist on disk under cwd's project skills dir for the catalog
	// scan (reloadSkillCatalog) to see it.
	it("preview warns when a project skill shadows the new name", async () => {
		const projectSkillsDir = join(cwd, CONFIG_DIR_NAME, "skills", "alpha");
		mkdirSync(projectSkillsDir, { recursive: true });
		writeFileSync(join(projectSkillsDir, "SKILL.md"), "---\nname: alpha\ndescription: project one\n---\nbody\n");

		const result = await tool().execute("call-1", makeArgs("alpha", false), undefined, undefined);
		const details = result.details as SkillBuilderToolDetails;
		expect(JSON.stringify(details.warnings)).toContain("project");
	});
});
