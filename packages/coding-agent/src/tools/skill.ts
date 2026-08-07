/**
 * `Skill` builtin tool. Closes the gap flagged in oracle issue #25: the model should be able to
 * invoke a skill by name and get its body wrapped for use, without going through `read`.
 *
 * Port of oracle `crates/coding-agent/src/tools/skill.rs` (pie @0a120dfd).
 *
 * Behavior (pie: skill.rs:6-16, per issue #25 acceptance):
 * - Looks the requested name up in the live skill catalog.
 * - On hit + enabled (`disableModelInvocation` false/absent): returns the body wrapped by
 *   `formatSkillInvocationBody` (this file's port of oracle's `format_skill_invocation`) as the
 *   tool result content.
 * - On hit + `disableModelInvocation: true`: returns a typed error regardless of caller path. The
 *   model-facing schema deliberately has NO `force` parameter so the model cannot bypass the
 *   disable flag.
 * - On miss: returns a typed error suggesting `/skills`.
 *
 * Architecture note (this file is also the shared home other skill-family tools import from --
 * oracle: `set_skill_state.rs`/`remove_skill.rs` both `use crate::tools::skill::SkillHarnessCell`;
 * this port's equivalent shared exports are `resolveSkillSource`, `parseSkillSource`,
 * `loadEffectiveSkills`, `findLoadedSkillOrThrow`):
 *
 * Oracle's `SkillTool` reaches a live `AgentHarness::skills()` snapshot via a
 * `SkillHarnessCell = Arc<OnceCell<Arc<AgentHarness>>>` set once by `main.rs` after harness
 * construction. This port does NOT use `@pie/agent-core`'s `AgentHarness`/`Skill` for the
 * skill-family tools: that harness is not wired into this repo's actual running coding-agent CLI
 * (confirmed: no file under `packages/coding-agent/src` constructs one), and the ported
 * `@pie/agent-core` `Skill` type (`packages/agent/src/harness/types.ts`) additionally lacks the
 * `source: SkillSource` field oracle's agent-core `Skill` struct carries
 * (`crates/agent/src/harness/types.rs:284`) -- a phase-8 simplification, not something this
 * phase-9 unit's scope covers ("harness/skills.ts ... import only, do not modify").
 *
 * Instead this file follows the precedent already established by the sibling unit
 * `tools/install-skill.ts` (same phase, same skill family, landed first): map the "live skill
 * catalog" onto pi's existing `core/skills.ts` (`Skill` type + `loadSkills()`), which the actual
 * coding-agent CLI already uses today via `core/resource-loader.ts`. Because `ToolDefinition`'s
 * `execute()` (pi's tool-authoring shape, used here via `wrapToolDefinition` for the same reason
 * install-skill.ts uses it) has no live, harness-cached resource snapshot threaded into it either,
 * "the live catalog" here means a fresh disk re-scan per invocation via `loadEffectiveSkills`
 * (which additionally layers the `skills-state.json` overlay via `../skills-state.ts` -- the pie
 * enable/disable feature `core/skills.ts` alone knows nothing about). install-skill.ts's own
 * module doc documents the identical limitation for its own hot-reload approximation
 * (`reloadSkillCatalog`) and the same follow-up TODO(port) (no session-audit-write hook reachable
 * from `ToolDefinition.execute`'s `ExtensionContext`) -- both are re-affirmed here for
 * `SetSkillState`/`RemoveSkill` rather than re-litigated.
 */

import { readFile } from "node:fs/promises";
import type { AgentTool } from "@pie/agent-core";
import { type Static, Type } from "typebox";
import { getAgentDir } from "../config.ts";
import type { ResourceDiagnostic } from "../core/diagnostics.ts";
import type { ToolDefinition } from "../core/extensions/types.ts";
import { loadSkills, mergeSkillsWithBuiltins, type Skill } from "../core/skills.ts";
import { wrapToolDefinition } from "../core/tools/tool-definition-wrapper.ts";
import { applySkillsStateOverlay, loadSkillsState, type SkillSource } from "../skills-state.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";

export type { SkillSource } from "../skills-state.ts";

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Resolve a `core/skills.ts` `Skill`'s pie-style `SkillSource` from its `sourceInfo.scope`.
 *
 * pie: crates/agent/src/harness/types.rs:254-260 (`SkillSource` default = `User`). This loader has
 * no "builtin" scope at all -- `coding-agent/builtin_skills` (`crates/coding-agent/src/
 * builtin_skills.rs`) is a separate phase-11 unit, still pending, so there is no bundled-skills
 * catalog wired into this repo yet. `"builtin"` is kept reachable in the `SkillSource` type (and
 * in `SetSkillState`/`RemoveSkill`'s scope-guard messages) for forward-compatible 1:1 parity with
 * oracle's enum, matching how `tools/install-skill.ts`'s own `<unknown source>` classifier branch
 * is "unreachable in production but preserved verbatim ... for defense-in-depth and 1:1 parity".
 * Any scope besides "user"/"project" (i.e. `core/skills.ts`'s "temporary", used for explicit
 * `--skill <path>` args) defaults to `"user"`, mirroring oracle's `#[default] SkillSource::User`.
 */
export function resolveSkillSource(skill: Skill): SkillSource {
	if (skill.sourceInfo.scope === "project") return "project";
	return "user";
}

/**
 * Parse a caller-supplied `source` string into a `SkillSource`, throwing the oracle-verbatim
 * error on anything else. pie: set_skill_state.rs:277-289 / remove_skill.rs:295-304
 * (`parse_source`, identical in both files). The TS `Type.Union(Type.Literal(...))` schema already
 * constrains the wire value to these 3 literals in the common case; this defensive re-parse
 * mirrors oracle's own belt-and-suspenders re-validation (same rationale as `tools/git.ts`'s
 * subcommand re-check).
 */
export function parseSkillSource(raw: string): SkillSource {
	switch (raw.toLowerCase()) {
		case "builtin":
			return "builtin";
		case "user":
			return "user";
		case "project":
			return "project";
		default:
			throw new Error("invalid `source` (expected one of: builtin, user, project)");
	}
}

export interface LoadEffectiveSkillsOptions {
	/** Working directory used to resolve the project skills root. */
	cwd: string;
	/** Agent config dir. Defaults to `getAgentDir()`. */
	agentDir?: string;
	/** Base dir for `skills-state.json`. Defaults to `agentDir`. */
	baseDir?: string;
}

export interface LoadEffectiveSkillsResult {
	skills: Skill[];
	diagnostics: ResourceDiagnostic[];
}

/**
 * Load the "live" skill catalog: `core/skills.ts`'s `loadSkills()` (user + project roots, deduped
 * by name) with the `skills-state.json` enable/disable overlay applied on top. This is the closest
 * available analog to oracle's `harness.skills()` snapshot in this port's architecture (see this
 * file's module doc) -- a fresh disk re-scan per call rather than a cached in-memory catalog.
 */
export async function loadEffectiveSkills(options: LoadEffectiveSkillsOptions): Promise<LoadEffectiveSkillsResult> {
	const agentDir = options.agentDir ?? getAgentDir();
	const baseDir = options.baseDir ?? agentDir;
	const loaded = loadSkills({ cwd: options.cwd, agentDir, skillPaths: [], includeDefaults: true });
	// pie: main.rs:698-707 resolves `--builtin-skill` + `[builtin_skills] enabled` and folds the
	// result into the catalog with `merge_with_user_project` (builtin_skills.rs:196-206) — built-ins
	// first, then a user/project skill of the SAME NAME replaces the built-in in place.
	//
	// Before this, `main.ts` validated the CLI names and threw the resolved catalog away, so
	// `--builtin-skill <known-name>` neither errored nor took effect: silently inert.
	const merged = mergeSkillsWithBuiltins(loaded).skills;
	const state = await loadSkillsState(baseDir);
	const skills = applySkillsStateOverlay(state, merged, resolveSkillSource);
	return { skills, diagnostics: loaded.diagnostics };
}

/**
 * Find a loaded skill by exact name, with a "did you mean" hint over near-matches. Shared by
 * `SetSkillState`/`RemoveSkill` (identical message text in both oracle files -- see
 * set_skill_state.rs:149-166 / remove_skill.rs:116-133). NOT used by this file's own `Skill` tool,
 * which has its own, differently-worded miss message (skill.rs:84-88, no hint).
 */
export function findLoadedSkillOrThrow(skills: Skill[], name: string): Skill {
	const skill = skills.find((s) => s.name === name);
	if (skill) return skill;

	const matches = skills.filter((s) => s.name.startsWith(name) || s.name.includes(name)).map((s) => s.name);
	const top5 = matches.slice(0, 5);
	const deduped: string[] = [];
	for (const candidate of top5) {
		if (deduped.length === 0 || deduped[deduped.length - 1] !== candidate) deduped.push(candidate);
	}
	const hint = deduped.length === 0 ? "" : ` Did you mean: ${deduped.join(", ")}?`;
	throw new Error(`no loaded skill named '${name}'. Run /skills to list loaded skills.${hint}`);
}

/**
 * Reconstruct oracle's `<skill>` wrapper text verbatim.
 * pie: crates/agent/src/harness/skills.ts:42-47 (`formatSkillInvocation`) -- reimplemented locally
 * (rather than imported from `@pie/agent-core`) because that function takes an agent-core `Skill`
 * with a `content` field this port's `core/skills.ts` `Skill` type does not have (see module doc);
 * `body` is supplied by the caller after an on-demand file read + frontmatter strip.
 */
function formatSkillInvocationBody(skill: Skill, body: string, additionalInstructions?: string): string {
	const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
	// pie: skills.rs:23-34 -- an explicit `Some("")` would still append the separator; this port
	// has no caller that passes additionalInstructions at all yet, so this branch is exercised
	// only by direct unit tests, kept for 1:1 parity with the ported oracle helper's contract.
	return additionalInstructions !== undefined ? `${skillBlock}\n\n${additionalInstructions}` : skillBlock;
}

const skillToolSchema = Type.Object(
	{
		name: Type.String({ description: "Exact skill name as listed in the system-prompt registry." }),
	},
	{ additionalProperties: false },
);

export type SkillToolInput = Static<typeof skillToolSchema>;

// pie: skill.rs:100-104 (json!({ "name": ..., "path": ... }) -- kept verbatim, logs/UI-only)
export interface SkillToolDetails {
	name: string;
	path: string;
}

export interface SkillToolOptions {
	agentDir?: string;
	baseDir?: string;
}

export function createSkillToolDefinition(
	cwd: string,
	options?: SkillToolOptions,
): ToolDefinition<typeof skillToolSchema, SkillToolDetails> {
	const agentDir = options?.agentDir ?? getAgentDir();
	const baseDir = options?.baseDir ?? agentDir;

	return {
		name: "Skill",
		label: "Skill",
		// pie: skill.rs:110-115 (verbatim)
		description:
			"Invoke a skill by name. Returns the skill body wrapped in a `<skill>` block for the " +
			"model to follow. Use this when the skill registry in the system prompt indicates the " +
			"skill is relevant to the current task. The skill name must match exactly an entry in " +
			"the registry.",
		promptSnippet: "Invoke a named skill and get its body wrapped for use",
		parameters: skillToolSchema,
		// pie: skill.rs:57-61 (ToolExecutionMode::Parallel -- read-only in-memory-ish lookup)
		executionMode: "parallel",
		async execute(_toolCallId, { name }, _signal, _onUpdate, _ctx) {
			// pie: skill.rs:70-74 -- defensive re-validation even though the schema already
			// requires `name`; kept for the same belt-and-suspenders reason as tools/git.ts's
			// subcommand re-check (a direct execute() call, e.g. from a unit test, bypasses schema
			// validation entirely).
			if (typeof name !== "string" || name.length === 0) {
				throw new Error("missing required arg: name");
			}

			const { skills } = await loadEffectiveSkills({ cwd, agentDir, baseDir });

			// pie: skill.rs:84-88 (no "did you mean" hint here, unlike findLoadedSkillOrThrow --
			// distinct wording from SetSkillState/RemoveSkill's miss message)
			const skill = skills.find((s) => s.name === name);
			if (!skill) {
				throw new Error(`no skill named '${name}'. Use /skills to list available skills.`);
			}

			// pie: skill.rs:90-97 -- uniform enforcement: refuses the body on every call path
			// (including a `/skill <name>` steering message that would end up here), since the
			// schema deliberately has no `force` parameter to bypass this.
			if (skill.disableModelInvocation) {
				throw new Error(
					`skill '${name}' is disabled (disable_model_invocation=true); update the frontmatter to enable`,
				);
			}

			let raw: string;
			try {
				raw = await readFile(skill.filePath, "utf-8");
			} catch (err) {
				throw new Error(`read ${skill.filePath}: ${errorMessage(err)}`);
			}
			const body = stripFrontmatter(raw);
			const text = formatSkillInvocationBody(skill, body);

			return {
				content: [{ type: "text" as const, text }],
				details: { name: skill.name, path: skill.filePath },
			};
		},
	};
}

export function createSkillTool(
	cwd: string,
	options?: SkillToolOptions,
): AgentTool<typeof skillToolSchema, SkillToolDetails> {
	return wrapToolDefinition(createSkillToolDefinition(cwd, options)) as AgentTool<
		typeof skillToolSchema,
		SkillToolDetails
	>;
}
