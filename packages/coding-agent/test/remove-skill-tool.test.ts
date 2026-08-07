import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSkillsState, setAndSaveSkillsState } from "../src/skills-state.ts";
import {
	classifyRemoveSkillPermission,
	createRemoveSkillTool,
	createRemoveSkillToolDefinition,
	deletionTarget,
} from "../src/tools/remove-skill.ts";

// pie: crates/coding-agent/src/tools/remove_skill.rs (pie @0a120dfd) -- tests ported from the
// oracle `#[cfg(test)] mod tests` block. Structural adaptation (documented in remove-skill.ts's
// module docs, NOT ported here as a pass/fail assertion): oracle wires a live `AgentHarness` +
// `reload_skills_from_disk`; this port re-derives the catalog from disk + the skills-state.json
// overlay per call via `loadEffectiveSkills`. `writes_remove_audit` (oracle test) is intentionally
// NOT ported -- no session-append hook is reachable from `ToolDefinition.execute` in this port's
// architecture (`audit_entry_id` is always `undefined`), same as `install-skill.ts`'s documented
// gap.

function writeUserSkill(agentDir: string, name: string): string {
	const skillDir = join(agentDir, "skills", name);
	mkdirSync(skillDir, { recursive: true });
	const content = `---\nname: ${name}\ndescription: description of ${name}\n---\nbody of ${name}\n`;
	const filePath = join(skillDir, "SKILL.md");
	writeFileSync(filePath, content);
	return filePath;
}

function writeProjectSkill(cwd: string, name: string): string {
	const skillDir = join(cwd, ".pie", "skills", name);
	mkdirSync(skillDir, { recursive: true });
	const content = `---\nname: ${name}\ndescription: description of ${name}\n---\nbody of ${name}\n`;
	const filePath = join(skillDir, "SKILL.md");
	writeFileSync(filePath, content);
	return filePath;
}

describe("remove-skill tool", () => {
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "remove-skill-agent-"));
		cwd = mkdtempSync(join(tmpdir(), "remove-skill-cwd-"));
	});

	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});

	function tool() {
		return createRemoveSkillTool(cwd, { agentDir });
	}

	// pie: remove_skill.rs:306-335 (verbatim description + schema shape)
	it("exposes the oracle schema shape (name/source/confirm/additionalProperties)", () => {
		const def = createRemoveSkillToolDefinition(cwd, { agentDir });
		expect(def.name).toBe("RemoveSkill");
		const params = def.parameters as unknown as { additionalProperties: boolean; required: string[] };
		expect(params.additionalProperties).toBe(false);
		expect(params.required).toEqual(["name"]);
	});

	// pie: remove_skill.rs:435-450 (deletion_target_is_direct_child_of_skills_root)
	it("deletionTarget is the direct child of the skills root", () => {
		const root = "/home/u/.pie/skills";
		expect(deletionTarget(root, "/home/u/.pie/skills/foo/SKILL.md")).toBe("/home/u/.pie/skills/foo");
		expect(deletionTarget(root, "/home/u/.pie/skills/bar.md")).toBe("/home/u/.pie/skills/bar.md");
		expect(deletionTarget(root, "/etc/passwd")).toBeUndefined();
	});

	// pie: remove_skill.rs:452-469 (preview_does_not_delete)
	it("preview does not delete", async () => {
		const fp = writeUserSkill(agentDir, "foo");
		const result = await tool().execute("c1", { name: "foo" }, undefined, undefined);
		expect(result.details).toMatchObject({ phase: "preview", source: "user" });
		expect(existsSync(fp)).toBe(true);
	});

	// pie: remove_skill.rs:471-493 (confirm_deletes_and_reload_drops_it)
	it("confirm deletes and reload drops it", async () => {
		writeUserSkill(agentDir, "foo");
		const result = await tool().execute("c1", { name: "foo", confirm: true }, undefined, undefined);
		expect(result.details).toMatchObject({ phase: "removed", still_present_after_reload: false });
		expect(existsSync(join(agentDir, "skills", "foo"))).toBe(false);
	});

	// pie: remove_skill.rs:495-513 (builtin_cannot_be_removed)
	// This loader has no "builtin" scope wired (see skill.ts's resolveSkillSource doc) so there is
	// no fixture that resolves as source "builtin" to exercise the same code path oracle's test
	// does; instead this asserts the "project" branch of the identical scope-guard message, which
	// IS reachable in this port (see next test) and shares the same error-formatting code.

	// pie: remove_skill.rs:515-537 (project_cannot_be_removed)
	it("project skill cannot be removed", async () => {
		writeProjectSkill(cwd, "p");
		const err = await tool()
			.execute("c1", { name: "p", confirm: true }, undefined, undefined)
			.catch((e: Error) => e);
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toContain("project skill");
		expect((err as Error).message).toContain("disable");
	});

	// pie: remove_skill.rs:539-563 (remove_clears_overlay_entry)
	it("remove clears the overlay entry", async () => {
		writeUserSkill(agentDir, "foo");
		await setAndSaveSkillsState(agentDir, "foo", "user", false);
		await tool().execute("c1", { name: "foo", confirm: true }, undefined, undefined);
		const state = await loadSkillsState(agentDir);
		expect(state.overrides.find((e) => e.name === "foo" && e.source === "user")).toBeUndefined();
	});

	// pie: remove_skill.rs:597-609 (unknown_skill_is_typed_error)
	it("unknown skill is a typed error", async () => {
		await expect(tool().execute("c1", { name: "ghost", confirm: true }, undefined, undefined)).rejects.toThrow(
			/no loaded skill named 'ghost'/,
		);
	});

	// pie: remove_skill.rs:85-97 (permission_classification -- always Prompt)
	it("permission classification always prompts, naming the skill", () => {
		const result = classifyRemoveSkillPermission({ name: "foo" } as never);
		expect(result).toEqual({ type: "prompt", reason: "remove user skill `foo`" });
	});
});
