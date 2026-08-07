/**
 * char-tests port of oracle `crates/agent/tests/templates_loader.rs` (pie @0a120dfd).
 *
 * Tests the prompt-template file loader. Verifies that two roots overlay properly and that the
 * loaded templates are usable via `PromptTemplateRegistry` interpolation.
 *
 * `NativeEnv` -> `NodeExecutionEnv`; `load_templates(&env, dirs, cancel)` -> `loadPromptTemplates`
 * (no cancellation-token param — no behavior gap, same as skills_loader's `loadSkills`);
 * `LoadTemplatesOutput { templates, diagnostics }` -> `{ promptTemplates, diagnostics }`.
 */
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { loadPromptTemplates, PromptTemplateRegistry } from "../../src/harness/prompt-templates.ts";
import type { PromptTemplate } from "../../src/harness/types.ts";
import { createTempDir } from "../harness/session-test-utils.ts";

/** oracle templates_loader.rs:10-14 (`write`). */
async function write(env: NodeExecutionEnv, dirRelPath: string, name: string, frontmatterDesc: string, body: string) {
	await env.createDir(dirRelPath, { recursive: true });
	const content = `---\nname: ${name}\ndescription: ${frontmatterDesc}\n---\n${body}\n`;
	await env.writeFile(`${dirRelPath}/${name}.md`, content);
}

describe("templates_loader (char-tests port)", () => {
	it("loads_templates_from_dual_roots_with_project_winning", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const userRoot = "home/templates";
		const projectRoot = "cwd/.pie/templates";

		await write(env, userRoot, "shared", "user", "User body {{var}}");
		await write(env, projectRoot, "shared", "project", "Project body {{var}}");
		await write(env, userRoot, "only-user", "user-only", "Only user");

		// Load user first, then project, then dedupe with project winning.
		const userLoad = await loadPromptTemplates(env, [userRoot]);
		expect(userLoad.diagnostics, JSON.stringify(userLoad.diagnostics)).toEqual([]);
		const combined: PromptTemplate[] = [...userLoad.promptTemplates];
		const projectLoad = await loadPromptTemplates(env, [projectRoot]);
		for (const t of projectLoad.promptTemplates) {
			const i = combined.findIndex((x) => x.name === t.name);
			if (i >= 0) combined[i] = t;
			else combined.push(t);
		}

		const names = combined.map((t) => t.name);
		expect(names).toContain("shared");
		expect(names).toContain("only-user");

		const shared = combined.find((t) => t.name === "shared");
		if (!shared) throw new Error("expected 'shared' template");
		expect(shared.description).toBe("project");
		expect(shared.content).toContain("Project body");

		// Interpolation round-trip.
		const rendered = PromptTemplateRegistry.interpolate(shared, { var: "world" });
		expect(rendered).toBe("Project body world");
	});

	it("missing_dirs_produce_no_diagnostics", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const out = await loadPromptTemplates(env, ["nope"]);
		expect(out.promptTemplates).toEqual([]);
		expect(out.diagnostics, JSON.stringify(out.diagnostics)).toEqual([]);
	});
});
