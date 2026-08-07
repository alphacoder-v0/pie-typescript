/**
 * Pie tool registry -- the coding agent's pie-only built-in toolset, as distinct from
 * `../core/tools/index.ts` (pi's base read/bash/edit/write/grep/find/ls registry, which stays
 * untouched: this file is a sibling barrel, not a merge into it).
 *
 * Port of oracle `crates/coding-agent/src/tools/mod.rs` (pie @0a120dfd). No pi base counterpart
 * (pie-only registration face) -- manifest fixes out_path at
 * `packages/coding-agent/src/tools/index.ts`.
 *
 * Oracle mod.rs has two registration surfaces:
 *
 * 1. Two ordered `Vec<Arc<dyn AgentTool>>` factories (mod.rs:31-59) -- ORDER matters, it is the
 *    order tools appear in the model-facing tool list:
 *      - `default_tools(memory_dir)` (mod.rs:29-45): read, write, edit, bash, ls, grep, find,
 *        web_fetch, web_search, git, memory. Ported below as `defaultTools()`.
 *      - `subagent_read_only_tools()` (mod.rs:47-59): read, ls, grep, find, web_fetch, git (no
 *        write/edit/bash/web_search/memory -- subagents must not mutate the workspace). Ported
 *        below as `subagentReadOnlyTools()`.
 *
 * 2. A family of standalone builder functions (mod.rs:61-173) that are NOT part of either list
 *    above -- oracle wires them into the harness separately (main.rs), each needing a
 *    `SkillHarnessCell` for hot-reloading a live `AgentHarness::skills()` snapshot:
 *      - `task_tool(model, stream_fn)` (mod.rs:63-72) -- internally wires
 *        `Arc::new(subagent_read_only_tools)` as the subagent's own toolset. Ported below as
 *        `taskTool()`, which does the equivalent wiring against this file's own
 *        `subagentReadOnlyTools()`.
 *      - `skill_tool`, `install_skill_tool`, `skill_builder_tool`, `set_skill_state_tool`,
 *        `remove_skill_tool` (mod.rs:74-117) -- each threads the harness cell through to their
 *        Rust tool. Their TS counterparts (`./skill.ts`, `./install-skill.ts`,
 *        `./skill-builder.ts`, `./set-skill-state.ts`, `./remove-skill.ts`) all independently
 *        dropped that requirement (see each file's own header comment: pi has no live
 *        `AgentHarness` wired into the running coding-agent CLI, so "hot reload" is approximated
 *        by a fresh disk re-scan per call instead). Re-exported below as direct pass-throughs --
 *        no additional wiring needed.
 *      - `new_cron_job_tool`, `list_cron_jobs_tool`, `remove_cron_job_tool`,
 *        `set_cron_job_state_tool`, `new_trigger_tool`, `list_triggers_tool`,
 *        `remove_trigger_tool`, `set_trigger_state_tool` (mod.rs:119-173) -- these re-export a
 *        *different* Rust module (`crate::triggers`), which has its own TS destination
 *        (`../triggers/`) and manifest unit (`coding-agent/triggers/mod`, phase 10, pending as
 *        of this unit). Out of scope here; not touched.
 *
 * Wiring this registry into the CLI's actual runtime default tool list (oracle's `main.rs`
 * calling `default_tools(memory_dir)` / `subagent_read_only_tools()`) is manifest unit
 * `coding-agent/main` -> `packages/coding-agent/src/main.ts` (phase 13) -- also out of scope
 * here; this unit only builds and exposes the registration face.
 */

import type { AgentTool, StreamFn } from "@pie/agent-core";
import type { Model } from "@pie/ai";
import type { ToolDefinition } from "../core/extensions/types.ts";
import {
	createBashTool,
	createBashToolDefinition,
	createEditTool,
	createEditToolDefinition,
	createFindTool,
	createFindToolDefinition,
	createGrepTool,
	createGrepToolDefinition,
	createLsTool,
	createLsToolDefinition,
	createReadTool,
	createReadToolDefinition,
	createWriteTool,
	createWriteToolDefinition,
	type ToolsOptions,
} from "../core/tools/index.ts";
import { createGitTool, createGitToolDefinition, type GitToolOptions } from "./git.ts";
import { createInstallSkillToolDefinition, type InstallSkillToolOptions } from "./install-skill.ts";
import { createMemoryTool, createMemoryToolDefinition } from "./memory.ts";
import { createRemoveSkillToolDefinition, type RemoveSkillToolOptions } from "./remove-skill.ts";
import { createSetSkillStateToolDefinition, type SetSkillStateToolOptions } from "./set-skill-state.ts";
import { createSkillToolDefinition, type SkillToolOptions } from "./skill.ts";
import { createSkillBuilderToolDefinition, type SkillBuilderToolOptions } from "./skill-builder.ts";
import { createTaskTool, createTaskToolDefinition } from "./task.ts";
import { createWebFetchTool, createWebFetchToolDefinition } from "./web-fetch.ts";
import { createWebSearchTool, createWebSearchToolDefinition, type WebSearchToolOptions } from "./web-search.ts";

export interface DefaultToolsOptions {
	/** Working directory for the filesystem/git tools (read/write/edit/bash/ls/grep/find/git). */
	cwd: string;
	/**
	 * Directory backing the `memory` tool's `MEMORY.md` + per-entry files. Oracle's
	 * `default_tools(memory_dir: PathBuf)` takes this as a caller-supplied parameter rather than
	 * computing a default itself (mod.rs:31) -- same contract here.
	 */
	memoryDir: string;
	/** Passed through to `createGitTool` (e.g. a non-default `git` executable path). */
	git?: GitToolOptions;
	/** Passed through to `createWebSearchTool` (e.g. a mock backend URL in tests). */
	webSearch?: WebSearchToolOptions;
}

/**
 * pie: crates/coding-agent/src/tools/mod.rs:29-45 (`default_tools`) -- the full toolset the
 * coding agent ships with. Order matches oracle exactly: read, write, edit, bash, ls, grep,
 * find, web_fetch, web_search, git, memory.
 */
export function defaultTools(options: DefaultToolsOptions): AgentTool<any>[] {
	const { cwd, memoryDir } = options;
	return [
		createReadTool(cwd),
		createWriteTool(cwd),
		createEditTool(cwd),
		createBashTool(cwd),
		createLsTool(cwd),
		createGrepTool(cwd),
		createFindTool(cwd),
		createWebFetchTool(),
		createWebSearchTool(options.webSearch),
		createGitTool(cwd, options.git),
		createMemoryTool(memoryDir),
	];
}

export interface SubagentReadOnlyToolsOptions {
	cwd: string;
	git?: GitToolOptions;
}

/**
 * pie: crates/coding-agent/src/tools/mod.rs:47-59 (`subagent_read_only_tools`) -- the read-only
 * toolset given to spawned subagents (issue #11): no write/edit/bash, so a subagent cannot
 * mutate the workspace. Order matches oracle: read, ls, grep, find, web_fetch, git.
 */
export function subagentReadOnlyTools(options: SubagentReadOnlyToolsOptions): AgentTool<any>[] {
	const { cwd } = options;
	return [
		createReadTool(cwd),
		createLsTool(cwd),
		createGrepTool(cwd),
		createFindTool(cwd),
		createWebFetchTool(),
		createGitTool(cwd, options.git),
	];
}

/**
 * pie: crates/coding-agent/src/tools/mod.rs:61-72 (`task_tool`) -- builds the `Task` tool,
 * wiring `subagentReadOnlyTools()` (this file) as the spawned subagent's own toolset, mirroring
 * oracle's `Arc::new(subagent_read_only_tools)`. Separate from `defaultTools()` because Task
 * needs a model handle to spawn its inner harness (same rationale as oracle's doc comment).
 */
export function taskTool(cwd: string, model: Model<any>, streamFn?: StreamFn): AgentTool<any> {
	return createTaskTool({
		model,
		streamFn,
		subagentTools: () => subagentReadOnlyTools({ cwd }),
	});
}

export interface DefaultToolDefinitionsOptions {
	/** Working directory for the filesystem/git tools. */
	cwd: string;
	/** pie: main.rs:620 (`config::memory_dir()`) -- backs the `memory` tool. */
	memoryDir: string;
	/**
	 * Config dir threaded into the skill-family tools (`~/.pie` by default). Oracle reads it from
	 * the process-global `config::base_dir()`; passing it explicitly keeps a caller-supplied
	 * `agentDir` (SDK option, tests) from silently falling back to the global.
	 */
	agentDir?: string;
	/** Options for the pi base filesystem tools (image auto-resize, shell prefix/path). */
	base?: ToolsOptions;
	/**
	 * Model handed to the `task` tool's subagents. pie: main.rs:624
	 * (`tools::task_tool(model.clone(), ..)`). Omitted -> `task` is not registered; oracle always
	 * has a model here (`auto_detect_model` / `credential_less_default`), but pi's resolver can
	 * legitimately come up empty and `TaskToolOptions.model` is non-optional.
	 */
	model?: Model<any>;
	/** Stream backend shared with the parent agent. pie: main.rs:624 (`Some(stream_fn.clone())`). */
	streamFn?: StreamFn;
	git?: GitToolOptions;
	webSearch?: WebSearchToolOptions;
	skill?: SkillToolOptions;
	installSkill?: InstallSkillToolOptions;
	skillBuilder?: SkillBuilderToolOptions;
	setSkillState?: SetSkillStateToolOptions;
	removeSkill?: RemoveSkillToolOptions;
}

/**
 * The coding agent CLI's registered toolset, in oracle's registration order.
 *
 * pie: `crates/coding-agent/src/main.rs:621-655` -- `tools::default_tools(memory_dir)` followed by
 * the pushes for `task_tool`, `skill_tool`, `install_skill_tool`, `skill_builder_tool`,
 * `set_skill_state_tool` and `remove_skill_tool`. Order is load-bearing: it is the order tools
 * appear in the model-facing tool list and in the rendered system-prompt inventory
 * (`main.rs:673-678, 1200-1212`).
 *
 * Returns `ToolDefinition`s rather than `AgentTool`s (unlike the sibling {@link defaultTools})
 * because AgentSession's registry is definition-first: definitions carry `promptSnippet`,
 * `renderCall`/`renderResult` and the permission classifier, all of which a bare `AgentTool`
 * would drop on the way in.
 *
 * Deliberately NOT registered here:
 * - The 8 cron/dynamic-trigger tools (`main.rs:648-655`) -- they live in `../triggers/` and are
 *   wired by their own phase-13 unit (T2).
 * - MCP tools (`main.rs:672`, `tools.extend(mcp.tools)`) -- discovered at connect time and
 *   appended by `core/agent-session-services.ts` as custom tools.
 */
export function defaultToolDefinitions(options: DefaultToolDefinitionsOptions): ToolDefinition<any, any>[] {
	const { cwd, memoryDir, agentDir, base } = options;
	const skillOptions = { agentDir, ...(options.skill ?? {}) };
	const definitions: ToolDefinition<any, any>[] = [
		// pie: tools/mod.rs:29-45 (`default_tools`) -- exact order.
		createReadToolDefinition(cwd, base?.read),
		createWriteToolDefinition(cwd, base?.write),
		createEditToolDefinition(cwd, base?.edit),
		createBashToolDefinition(cwd, base?.bash),
		createLsToolDefinition(cwd, base?.ls),
		createGrepToolDefinition(cwd, base?.grep),
		createFindToolDefinition(cwd, base?.find),
		createWebFetchToolDefinition(),
		createWebSearchToolDefinition(options.webSearch),
		createGitToolDefinition(cwd, options.git),
		createMemoryToolDefinition(memoryDir),
	];
	// pie: main.rs:622-624 -- Task shares the parent's model + stream backend.
	if (options.model) {
		definitions.push(
			createTaskToolDefinition({
				model: options.model,
				streamFn: options.streamFn,
				subagentTools: () => subagentReadOnlyTools({ cwd, git: options.git }),
			}),
		);
	}
	// pie: main.rs:625-647 -- the skill family. Oracle threads a `SkillHarnessCell` for hot
	// reload; each TS counterpart re-scans disk per call instead (see each file's header).
	definitions.push(
		createSkillToolDefinition(cwd, skillOptions),
		createInstallSkillToolDefinition(cwd, { agentDir, ...(options.installSkill ?? {}) }),
		createSkillBuilderToolDefinition(cwd, { agentDir, ...(options.skillBuilder ?? {}) }),
		createSetSkillStateToolDefinition(cwd, { agentDir, ...(options.setSkillState ?? {}) }),
		createRemoveSkillToolDefinition(cwd, { agentDir, ...(options.removeSkill ?? {}) }),
	);
	return definitions;
}

// pie: crates/coding-agent/src/tools/mod.rs:9,21-22,40-41,56 -- re-exported so callers can
// build `defaultTools`/`subagentReadOnlyTools`-equivalent lists themselves with custom options,
// same as oracle's `pub mod` re-exports.
export { createGitTool, createGitToolDefinition, type GitToolDetails, type GitToolOptions } from "./git.ts";
export {
	createInstallSkillTool,
	createInstallSkillToolDefinition,
	type InstallSkillToolDetails,
	type InstallSkillToolOptions,
} from "./install-skill.ts";
// pie: crates/coding-agent/src/tools/mod.rs:12 (`pub mod mcp_adapter;`) -- `McpAgentTool` is
// constructed dynamically, one per remote tool discovered at MCP-server-connect time (by the
// out-of-scope `mcp_loader.rs`-equivalent loader), not a static entry in either
// `default_tools()` or `subagent_read_only_tools()` in oracle either -- so there is no
// list-position gap to fill here, only the re-export for callers that assemble the loader.
export { McpAgentTool, type McpAgentToolDetails } from "./mcp-adapter.ts";
export { createMemoryTool, createMemoryToolDefinition, type MemoryToolDetails } from "./memory.ts";
export {
	createRemoveSkillTool,
	createRemoveSkillToolDefinition,
	type RemoveSkillToolDetails,
	type RemoveSkillToolOptions,
} from "./remove-skill.ts";
export {
	createSetSkillStateTool,
	createSetSkillStateToolDefinition,
	type SetSkillStateToolDetails,
	type SetSkillStateToolOptions,
} from "./set-skill-state.ts";
// pie: crates/coding-agent/src/tools/mod.rs:74-117 (`skill_tool`, `install_skill_tool`,
// `skill_builder_tool`, `set_skill_state_tool`, `remove_skill_tool`) -- oracle threads a
// `SkillHarnessCell` for hot-reload; each TS counterpart dropped that requirement (see each
// file's own header comment), so these are direct pass-throughs.
export { createSkillTool, createSkillToolDefinition, type SkillToolDetails, type SkillToolOptions } from "./skill.ts";
export {
	createSkillBuilderTool,
	createSkillBuilderToolDefinition,
	type SkillBuilderToolDetails,
	type SkillBuilderToolOptions,
} from "./skill-builder.ts";
// pie: crates/coding-agent/src/tools/mod.rs:63-72 (`task_tool`) -- `taskTool()` above is the
// wired convenience builder; `createTaskTool`/`createTaskToolDefinition` are re-exported too for
// callers that want to supply their own `subagentTools` factory.
export { createTaskTool, createTaskToolDefinition, type TaskToolDetails, type TaskToolOptions } from "./task.ts";
export { createWebFetchTool, createWebFetchToolDefinition, type WebFetchToolDetails } from "./web-fetch.ts";
export {
	createWebSearchTool,
	createWebSearchToolDefinition,
	type WebSearchToolDetails,
	type WebSearchToolOptions,
} from "./web-search.ts";
