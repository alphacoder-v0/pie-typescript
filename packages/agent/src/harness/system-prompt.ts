import type { Skill } from "./types.ts";

// pie: system_prompt.rs:9-14 preamble text, verbatim (user-visible system-prompt copy).
const SKILL_BLOCK_PREAMBLE = [
	"The user has provided skills they want you to use whenever the user request can be solved with their help.",
	"Below is a list of skills with their unique names and descriptions of what they do.",
	"Use the `Skill` tool to invoke a skill by name when applicable.",
	"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
];

/**
 * Render the skill catalog into a `<skills>` block for inclusion in the system prompt. Returns
 * the empty string when `skills` is empty so the surrounding prompt stays clean.
 *
 * pie: system_prompt.rs:18-37 -- this used to be a different, XML-formatted block that also
 * filtered out `disableModelInvocation` skills. Oracle does neither: it renders a plain
 * dash-list ("- name: X\n  description: Y\n") and does NOT filter by
 * `disable_model_invocation` -- per `crates/agent/tests/skills_loader.rs:230-238` (issue #25
 * v3), a disabled skill still appears in the catalog; the flag is enforced only at `Skill`-tool
 * execute time, not in catalog rendering.
 */
export function formatSkillsForSystemPrompt(
	// Only `name`/`description` are rendered, so the parameter is structural: coding-agent's own
	// `Skill` (core/skills.ts) carries `baseDir`/`sourceInfo` instead of `content` and still feeds
	// the exact same block through `buildSystemPrompt`.
	skills: ReadonlyArray<Pick<Skill, "name" | "description">>,
): string {
	if (skills.length === 0) return "";
	let out = "<skills>\n";
	for (const line of SKILL_BLOCK_PREAMBLE) out += `${line}\n`;
	out += "\n";
	for (const skill of skills) {
		out += `- name: ${skill.name}\n  description: ${skill.description}\n`;
	}
	out += "</skills>";
	return out;
}
