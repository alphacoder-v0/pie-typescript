import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSkillsState } from "../src/skills-state.ts";
import {
	classifySetSkillStatePermission,
	createSetSkillStateTool,
	createSetSkillStateToolDefinition,
} from "../src/tools/set-skill-state.ts";

// pie: crates/coding-agent/src/tools/set_skill_state.rs (pie @0a120dfd) -- tests ported from the
// oracle `#[cfg(test)] mod tests` block. Structural adaptation (documented in
// set-skill-state.ts's module docs, NOT ported here as a pass/fail assertion): oracle wires a
// live `AgentHarness` + `reload_skills_from_disk`; this port re-derives the catalog from disk +
// the skills-state.json overlay per call via `loadEffectiveSkills` instead of a cached harness
// snapshot. `writes_skill_control_plane_audit` (oracle test) is intentionally NOT ported -- no
// session-append hook is reachable from `ToolDefinition.execute` in this port's architecture
// (`audit_entry_id` is always `undefined`), same as `install-skill.ts`'s documented gap.

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((c) => c.type === "text")?.text ?? "";
}

function writeSkillMd(skillsRoot: string, name: string, opts?: { disabled?: boolean }): string {
	const skillDir = join(skillsRoot, name);
	mkdirSync(skillDir, { recursive: true });
	const frontmatterLines = [`name: ${name}`, `description: description of ${name}`];
	if (opts?.disabled) frontmatterLines.push("disable-model-invocation: true");
	const content = `---\n${frontmatterLines.join("\n")}\n---\nBody of ${name}.\n`;
	const filePath = join(skillDir, "SKILL.md");
	writeFileSync(filePath, content);
	return filePath;
}

describe("set-skill-state tool", () => {
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "set-skill-state-agent-"));
		cwd = mkdtempSync(join(tmpdir(), "set-skill-state-cwd-"));
	});

	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});

	function tool() {
		return createSetSkillStateTool(cwd, { agentDir });
	}

	// pie: set_skill_state.rs:295-332 (verbatim description + schema shape)
	it("exposes the oracle schema shape (name/source/enabled/confirm/additionalProperties)", () => {
		const def = createSetSkillStateToolDefinition(cwd, { agentDir });
		expect(def.name).toBe("SetSkillState");
		const params = def.parameters as unknown as { additionalProperties: boolean; required: string[] };
		expect(params.additionalProperties).toBe(false);
		expect(params.required).toEqual(["name", "enabled"]);
	});

	// pie: set_skill_state.rs:411-428 (preview_does_not_write_overlay)
	it("preview does not write the overlay", async () => {
		writeSkillMd(join(agentDir, "skills"), "foo");
		const result = await tool().execute("c1", { name: "foo", enabled: false }, undefined, undefined);
		expect(result.details).toMatchObject({ phase: "preview", currently_enabled: true, target_enabled: false });
		const state = await loadSkillsState(agentDir);
		expect(state.overrides).toHaveLength(0);
	});

	// pie: set_skill_state.rs:430-461 (disable_then_reload_reflects_state)
	it("disable then reload reflects the new state", async () => {
		writeSkillMd(join(agentDir, "skills"), "foo");
		const result = await tool().execute("c1", { name: "foo", enabled: false, confirm: true }, undefined, undefined);
		expect(result.details).toMatchObject({
			phase: "applied",
			enabled: false,
			effective_enabled_after_reload: false,
		});
		const state = await loadSkillsState(agentDir);
		expect(state.overrides).toEqual([{ name: "foo", source: "user", enabled: false }]);
	});

	// pie: set_skill_state.rs:463-508 (classifier_routes_disable_through_allow_and_enable_through_prompt)
	it("classifier routes disable through Allow and enable through Prompt", () => {
		const disable = classifySetSkillStatePermission({ name: "foo", enabled: false } as never);
		expect(disable).toEqual({ type: "allow" });

		const enable = classifySetSkillStatePermission({ name: "foo", enabled: true } as never);
		expect(enable).toMatchObject({ type: "prompt" });
		if (enable.type === "prompt") {
			expect(enable.reason).toContain("re-enable");
			expect(enable.reason).toContain("`foo`");
		}

		// Missing `enabled` field defaults to false (narrowing) -- defensive default.
		const missing = classifySetSkillStatePermission({ name: "foo" } as never);
		expect(missing).toEqual({ type: "allow" });
	});

	// pie: set_skill_state.rs:510-545 (enable_no_longer_short_circuits_in_execute)
	it("enable succeeds directly via execute() (no model-side reject)", async () => {
		writeSkillMd(join(agentDir, "skills"), "foo", { disabled: true });
		const result = await tool().execute("c1", { name: "foo", enabled: true, confirm: true }, undefined, undefined);
		expect(result.content.length).toBeGreaterThan(0);
		expect(getText(result)).toContain("enabled skill 'foo'");
	});

	// pie: set_skill_state.rs:584-599 (unknown_skill_is_typed_error_with_hint)
	it("unknown skill is a typed error with a hint", async () => {
		writeSkillMd(join(agentDir, "skills"), "formatter");
		await expect(tool().execute("c1", { name: "format", enabled: false }, undefined, undefined)).rejects.toThrow(
			/no loaded skill named 'format'/,
		);
	});

	// pie: set_skill_state.rs:601-620 (mismatched_source_is_rejected)
	it("mismatched source is rejected", async () => {
		writeSkillMd(join(agentDir, "skills"), "foo");
		await expect(
			tool().execute("c1", { name: "foo", source: "project", enabled: false }, undefined, undefined),
		).rejects.toThrow(/active from source 'user'/);
	});
});
