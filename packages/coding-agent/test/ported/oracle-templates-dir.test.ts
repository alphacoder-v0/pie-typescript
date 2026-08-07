/**
 * phase 20-8: upstream's template directory is `templates/`, not `prompts/`.
 *
 * pie: `crates/coding-agent/src/templates.rs:16-19` —— `cwd.join(".pie").join("templates")`
 * and `base_dir().join("templates")`.
 *
 * Both call sites here had `prompts/` hard-coded, so **a user arriving with existing templates
 * loaded none of them**: the slash command reported an unknown name with no hint why. That is a
 * silent total failure, not a partial degradation.
 *
 * The resolution is to read both (see the note in `prompt-templates.ts`): `prompts/` is the
 * skeleton's existing location, and renaming it would make skeleton users' templates disappear the
 * other way.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadPromptTemplates } from "../../src/core/prompt-templates.ts";

const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function seed(scopeDirName: string, templateName: string, body: string): { cwd: string; agentDir: string } {
	const cwd = mkdtempSync(join(tmpdir(), "pie-tpl-cwd-"));
	const agentDir = mkdtempSync(join(tmpdir(), "pie-tpl-agent-"));
	dirs.push(cwd, agentDir);
	const dir = join(cwd, ".pie", scopeDirName);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `${templateName}.md`),
		`---\nname: ${templateName}\ndescription: d\n---\n${body}\n`,
		"utf-8",
	);
	return { cwd, agentDir };
}

describe("the template directory name", () => {
	// This is the discriminating case: before the change, nothing under `templates/` got in.
	it("loads upstream's <cwd>/.pie/templates/", () => {
		const { cwd, agentDir } = seed("templates", "oracle-tpl", "from templates dir");
		const templates = loadPromptTemplates({ cwd, agentDir, promptPaths: [], includeDefaults: true });
		expect(templates.map((t) => t.name)).toContain("oracle-tpl");
	});

	// The negative-control direction: the skeleton's existing location has to keep working, or the
	// change merely points the failure the other way.
	it("negative control: the skeleton's <cwd>/.pie/prompts/ still loads", () => {
		const { cwd, agentDir } = seed("prompts", "pi-tpl", "from prompts dir");
		const templates = loadPromptTemplates({ cwd, agentDir, promptPaths: [], includeDefaults: true });
		expect(templates.map((t) => t.name)).toContain("pi-tpl");
	});

	it("when both directories exist, both are loaded", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pie-tpl-both-"));
		const agentDir = mkdtempSync(join(tmpdir(), "pie-tpl-agent-"));
		dirs.push(cwd, agentDir);
		for (const [dirName, tplName] of [
			["prompts", "a-pi"],
			["templates", "b-oracle"],
		]) {
			const d = join(cwd, ".pie", dirName);
			mkdirSync(d, { recursive: true });
			writeFileSync(join(d, `${tplName}.md`), `---\nname: ${tplName}\ndescription: d\n---\nbody\n`, "utf-8");
		}
		const names = loadPromptTemplates({ cwd, agentDir, promptPaths: [], includeDefaults: true }).map((t) => t.name);
		expect(names).toContain("a-pi");
		expect(names).toContain("b-oracle");
	});
});
