import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultTools, McpAgentTool, subagentReadOnlyTools, taskTool } from "../src/tools/index.ts";

// pie: crates/coding-agent/src/tools/mod.rs:29-59 -- oracle's `default_tools`/
// `subagent_read_only_tools` have no #[cfg(test)] of their own (mod.rs is glue, not logic); these
// tests instead lock the ORDER and MEMBERSHIP of the two registries, since order is what's
// model-visible (tool list position), and a silent reorder/drop on either list would be a
// registration-face regression this unit exists to prevent.
describe("pie tool registry (tools/index.ts, port of oracle tools/mod.rs)", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "coding-agent-tools-index-"));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("defaultTools() matches oracle's default_tools() order exactly (mod.rs:31-45)", () => {
		const memoryDir = join(cwd, "memory");
		const tools = defaultTools({ cwd, memoryDir });
		expect(tools.map((t) => t.name)).toEqual([
			"read",
			"write",
			"edit",
			"bash",
			"ls",
			"grep",
			"find",
			"web_fetch",
			"web_search",
			"git",
			"memory",
		]);
	});

	it("subagentReadOnlyTools() matches oracle's subagent_read_only_tools() order exactly (mod.rs:47-59)", () => {
		const tools = subagentReadOnlyTools({ cwd });
		expect(tools.map((t) => t.name)).toEqual(["read", "ls", "grep", "find", "web_fetch", "git"]);
	});

	it("subagentReadOnlyTools() excludes write/edit/bash/web_search/memory (subagents must not mutate the workspace)", () => {
		const names = new Set(subagentReadOnlyTools({ cwd }).map((t) => t.name));
		for (const forbidden of ["write", "edit", "bash", "web_search", "memory"]) {
			expect(names.has(forbidden)).toBe(false);
		}
	});

	it("taskTool() builds the 'task' tool, wiring subagentReadOnlyTools() as its own subagent toolset", () => {
		// A stub model is sufficient: taskTool()/createTaskTool() only capture the model handle
		// at construction time (pie: task.rs:39-41, 49-55), they don't validate or call it until
		// execute() actually spawns a subagent -- not exercised here.
		const stubModel = { provider: "test", id: "test-model" } as any;
		const tool = taskTool(cwd, stubModel);
		expect(tool.name).toBe("task");
	});

	it("re-exports the pie-only tool factories used by defaultTools()/subagentReadOnlyTools() for callers that assemble a custom toolset", () => {
		expect(typeof McpAgentTool).toBe("function");
	});
});
