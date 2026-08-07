import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import {
	formatPromptTemplateInvocation,
	loadPromptTemplates,
	loadSourcedPromptTemplates,
	PromptTemplateRegistry,
} from "../../src/harness/prompt-templates.ts";
import { createTempDir } from "./session-test-utils.ts";

describe("loadPromptTemplates", () => {
	it("loads markdown templates non-recursively from one or more dirs", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("a/nested", { recursive: true });
		await env.createDir("b", { recursive: true });
		await env.writeFile("a/one.md", "---\ndescription: One template\n---\nHello $1");
		await env.writeFile("a/nested/ignored.md", "Ignored");
		await env.writeFile("b/two.md", "First line description\nBody");

		const { promptTemplates, diagnostics } = await loadPromptTemplates(env, ["a", "b"]);

		expect(diagnostics).toEqual([]);
		expect(promptTemplates).toEqual([
			{ name: "one", description: "One template", content: "Hello $1", filePath: join(root, "a/one.md") },
			// pie: prompt_templates.rs:142-148 -- oracle passes `frontmatter.description` through
			// as-is (`None` when absent); it does NOT derive a description from the body's first
			// line (that heuristic was TS-only and has been removed to match oracle).
			{
				name: "two",
				description: undefined,
				content: "First line description\nBody",
				filePath: join(root, "b/two.md"),
			},
		]);
	});

	it("prefers an explicit frontmatter name over the file stem", async () => {
		// pie: prompt_templates.rs:137-142 -- `frontmatter.name.unwrap_or(stem)` only falls back
		// to the file stem when the key is ABSENT.
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("a", { recursive: true });
		await env.writeFile("a/on-disk-name.md", "---\nname: custom-name\ndescription: d\n---\nBody");

		const { promptTemplates } = await loadPromptTemplates(env, "a");

		expect(promptTemplates).toEqual([
			{ name: "custom-name", description: "d", content: "Body", filePath: join(root, "a/on-disk-name.md") },
		]);
	});

	it("preserves source info for sourced prompt templates", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("prompts", { recursive: true });
		await env.writeFile("prompts/example.md", "---\ndescription: Example\n---\nExample body");

		const { promptTemplates, diagnostics } = await loadSourcedPromptTemplates(env, [
			{ path: "prompts", source: { type: "project" as const } },
		]);

		expect(diagnostics).toEqual([]);
		expect(promptTemplates).toEqual([
			{
				promptTemplate: {
					name: "example",
					description: "Example",
					content: "Example body",
					filePath: join(root, "prompts/example.md"),
				},
				source: { type: "project" },
			},
		]);
	});

	it("attaches source info to diagnostics", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("broken", { recursive: true });
		await env.writeFile("broken/bad.md", "---\ndescription: [unterminated\n---\nBody");

		const { promptTemplates, diagnostics } = await loadSourcedPromptTemplates(env, [
			{ path: "broken", source: { type: "user" as const } },
		]);

		expect(promptTemplates).toEqual([]);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({
			type: "warning",
			path: join(root, "broken/bad.md"),
			source: { type: "user" },
		});
	});

	// pie: prompt_templates.rs:74-96 -- `load_templates` only ever accepts DIRECTORY inputs (the
	// parameter is `dirs: &[&str]`); a bare file path -- or a symlink, since no
	// `resolve_kind`-equivalent exists in this file -- is silently skipped (no diagnostic).
	it("silently skips file-path and symlink inputs (oracle only supports directories)", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.writeFile("target.md", "---\ndescription: Target\n---\nTarget body");
		await symlink(join(root, "target.md"), join(root, "link.md"));

		const { promptTemplates, diagnostics } = await loadPromptTemplates(env, ["target.md", "link.md"]);

		expect(promptTemplates).toEqual([]);
		expect(diagnostics).toEqual([]);
	});

	// pie: prompt_templates.rs:108-114 -- entries within a directory are checked via raw
	// `entry.kind` with no symlink resolution, so a symlinked `.md` file inside a loaded
	// directory is skipped too (unlike skills.rs, which does resolve symlinks).
	it("skips symlinked .md files found inside a loaded directory", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("templates", { recursive: true });
		await env.writeFile("templates/real.md", "---\ndescription: Real\n---\nReal body");
		await symlink(join(root, "templates/real.md"), join(root, "templates/link.md"));

		const { promptTemplates } = await loadPromptTemplates(env, "templates");

		expect(promptTemplates.map((t) => t.name)).toEqual(["real"]);
	});

	it("missing directories are skipped without a diagnostic", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });

		const { promptTemplates, diagnostics } = await loadPromptTemplates(env, "nope");

		expect(promptTemplates).toEqual([]);
		expect(diagnostics).toEqual([]);
	});
});

describe("formatPromptTemplateInvocation", () => {
	it("substitutes command arguments", () => {
		const content = "$1 $" + "{@:2} $ARGUMENTS";
		expect(
			formatPromptTemplateInvocation({ name: "one", content, filePath: "/x/one.md" }, ["hello world", "test"]),
		).toBe("hello world test hello world test");
	});
});

// pie: prompt_templates.rs:22-51,173-197 -- `PromptTemplateRegistry` had no TS counterpart at
// all; these tests translate the oracle `#[cfg(test)]` block plus `tests/templates_loader.rs`'s
// interpolation round-trip.
describe("PromptTemplateRegistry", () => {
	it("interpolates known vars and leaves unknown placeholders untouched", () => {
		const template = { name: "t", content: "hi {{who}} — {{missing}}", filePath: "/x" };
		expect(PromptTemplateRegistry.interpolate(template, { who: "world" })).toBe("hi world — {{missing}}");
	});

	it("renders non-string values as their JSON text", () => {
		const template = { name: "t", content: "count={{n}} ok={{b}} nil={{z}}", filePath: "/x" };
		expect(PromptTemplateRegistry.interpolate(template, { n: 42, b: true, z: null })).toBe(
			"count=42 ok=true nil=null",
		);
	});

	it("lists and looks up templates by name", () => {
		const a = { name: "a", content: "A", filePath: "/a" };
		const b = { name: "b", content: "B", filePath: "/b" };
		const registry = new PromptTemplateRegistry([a, b]);
		expect(registry.list()).toEqual([a, b]);
		expect(registry.get("b")).toEqual(b);
		expect(registry.get("missing")).toBeUndefined();
	});
});
