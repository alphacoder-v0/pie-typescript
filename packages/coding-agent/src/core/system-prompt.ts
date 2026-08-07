/**
 * System prompt construction.
 *
 * pie: crates/coding-agent/src/main.rs:1187-1225 (`compose_system_prompt` / `render_base_prompt`).
 * Oracle composes the coding agent's system prompt from exactly three pieces — the base prompt
 * (a single paragraph whose tool inventory is rendered from the live tool registry), the
 * `Current working directory:` line, and the persistent `<memory>` block — then `AgentHarness`
 * appends the `<skills>` catalog (agent_harness.rs:2161-2169 `build_system_prompt`).
 *
 * The pi skeleton's prompt (tool snippet list + guidelines + "Pi documentation" section + current
 * date + `<project_context>`) has no oracle counterpart and is therefore gone: RULEBOOK §4
 * "what this port does not do" already forbids the `<project_context>` half ("do not load AGENTS.md/CLAUDE.md into the system prompt"),
 * and the rest is skeleton copy the model must not see.
 */

import { formatSkillsForSystemPrompt } from "@pie/agent-core";
import type { Skill } from "./skills.ts";

export interface BuildSystemPromptOptions {
	/**
	 * Custom system prompt: replaces the rendered base prompt (the `render_base_prompt` half),
	 * keeping the cwd / memory / skills composition around it.
	 *
	 * pie: no counterpart — oracle has no `--system-prompt` flag and always uses
	 * `render_base_prompt`. Retained as pi SDK surface; an oracle-equivalent CLI invocation never
	 * sets it, so the composed prompt stays byte-identical to oracle's.
	 */
	customPrompt?: string;
	/**
	 * Tool names, in registration order, rendered into the base prompt's inventory sentence.
	 * pie: main.rs:669-676 (`tool_names`) — every registered tool, built-ins then MCP.
	 */
	selectedTools?: string[];
	/**
	 * pie: no counterpart. Oracle's inventory is bare names with no per-tool blurb; kept on the
	 * options type because pi extensions may still declare `promptSnippet`, but it no longer
	 * reaches the prompt.
	 */
	toolSnippets?: Record<string, string>;
	/**
	 * pie: no counterpart. Oracle's base prompt is a fixed literal with no guideline list; kept
	 * for the same reason as {@link toolSnippets} and likewise unused by the composed prompt.
	 */
	promptGuidelines?: string[];
	/**
	 * Text appended after the base prompt. pie: no counterpart (oracle has no
	 * `--append-system-prompt`); an oracle-equivalent invocation leaves it undefined.
	 */
	appendSystemPrompt?: string;
	/** Working directory. pie: main.rs:1191 (`Current working directory: {}`). */
	cwd: string;
	/**
	 * pie: RULEBOOK §4 "what this port does not do" — oracle never loads AGENTS.md/CLAUDE.md into the system prompt,
	 * and `loadProjectContextFiles` is already a no-op (resource-loader.ts:58-70). Accepted and
	 * ignored so the option's shape stays stable for SDK callers.
	 */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. pie: agent_harness.rs:2161-2169 (`build_system_prompt`). */
	skills?: Skill[];
	/**
	 * Persistent cross-session memory block.
	 * pie: main.rs:677 (`tools::memory::load_memory_block(&memory_dir)`) — loaded once at startup
	 * and folded into the prompt by `compose_system_prompt`. See BUG(port): B11.
	 */
	memory?: string;
}

/**
 * Build the prompt header. The tool inventory is rendered from the actual registered tool
 * definitions so adding/removing a tool flows through here without a hand-edited literal list.
 *
 * pie: crates/coding-agent/src/main.rs:1203-1225 (`render_base_prompt`) — the literal below is
 * byte-for-byte oracle's (Rust `\`-continuations collapse to single spaces).
 */
export function renderBasePrompt(toolNames: readonly string[]): string {
	const inventory = toolNames.length === 0 ? "no tools registered" : toolNames.join(", ");
	return (
		`You are pie-coding-agent, a minimal coding assistant running in a terminal. ` +
		`You have access to the following tools: ${inventory}. ` +
		`Prefer running a tool over guessing. When making file changes, read the file first to confirm the exact current contents, then edit or write. Keep responses concise. ` +
		`When the user asks for a fixed time, recurring, scheduled, hourly, daily, weekly, crontab, 定时任务, 每小时, or similar time-based job, call NewCronJob instead of NewTrigger. ` +
		`When the user asks to view, list, show, inspect, or find scheduled jobs or cron job ids, call ListCronJobs. ` +
		`When the user asks to pause or disable a scheduled job or cron job, call SetCronJobState with enabled=false; enabling/resuming should point the user to /cron enable <id> until confirmation support is wired. ` +
		`When the user asks to delete, remove, or clear scheduled jobs or cron jobs, call RemoveCronJob first with confirm=false to preview, then only call confirm=true after explicit user confirmation. ` +
		`When the user asks to create a trigger, reminder, watcher, or automation, call NewTrigger and extract a natural-language condition and action from their request. Dynamic triggers fire once by default; set fire_once=false only when the user explicitly asks for a repeating trigger. Trigger output is shown in the TUI and audit by default; set promote_to_chat=true only when the user explicitly asks for trigger results to enter the main chat context or be visible to future turns. ` +
		`When the user asks to view, list, show, inspect, or find trigger ids, call ListTriggers. ` +
		`When the user asks to pause, disable, enable, or resume a dynamic trigger, call SetTriggerState. ` +
		`When the user asks to delete, remove, or clear dynamic triggers, call RemoveTrigger. ` +
		`When the user asks to create, save, or codify a reusable skill, workflow, checklist, or convention, or to summarize recent work or this conversation into a skill (技能, 保存为技能, 把刚才的工作总结成 skill), call SkillBuilder with structured name/description/instructions. For summarize-into-skill requests, distill the generalizable steps from the conversation — what was actually done, the commands used, the pitfalls — not a transcript. Call once without confirm to preview and show the user the planned name and description, then call with confirm=true after they agree. Use InstallSkill only for installing an existing SKILL.md from a URL, file, or pasted content.`
	);
}

/**
 * pie: crates/coding-agent/src/main.rs:1187-1201 (`compose_system_prompt`) with the base prompt
 * hoisted to a parameter. The trailing newline on the cwd line and the blank line before the
 * memory block are load-bearing for byte-level parity with oracle's request body.
 */
function composeFromBase(base: string, cwd: string, memory: string): string {
	let s = base;
	s += "\n\n";
	s += `Current working directory: ${cwd}\n`;
	if (memory !== "") {
		s += "\n";
		s += memory;
		s += "\n";
	}
	return s;
}

/** pie: crates/coding-agent/src/main.rs:1187-1201 (`compose_system_prompt`), verbatim signature. */
export function composeSystemPrompt(cwd: string, memory: string, toolNames: readonly string[]): string {
	return composeFromBase(renderBasePrompt(toolNames), cwd, memory);
}

/** Build the system prompt: oracle's base + cwd + memory, then the `<skills>` catalog. */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	const { customPrompt, selectedTools, appendSystemPrompt, cwd, skills: providedSkills, memory } = options;
	const promptCwd = cwd.replace(/\\/g, "/");
	const skills = providedSkills ?? [];

	// pie: main.rs:1189 — `render_base_prompt(tool_names)` is the only base oracle knows. A
	// caller-supplied `customPrompt` substitutes for it and nothing else.
	let base = customPrompt ?? renderBasePrompt(selectedTools ?? []);
	if (appendSystemPrompt) {
		base += `\n\n${appendSystemPrompt}`;
	}

	const prompt = composeFromBase(base, promptCwd, memory ?? "");

	// pie: agent_harness.rs:2161-2169 (`build_system_prompt`) — the `<skills>` block is joined to
	// the base with a blank line, and an empty catalog leaves the base untouched.
	const skillsBlock = formatSkillsForSystemPrompt(skills);
	return skillsBlock === "" ? prompt : `${prompt}\n\n${skillsBlock}`;
}
