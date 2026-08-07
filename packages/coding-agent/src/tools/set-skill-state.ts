/**
 * `SetSkillState` builtin tool (skill-lifecycle task #23, S-A2): enable or disable a loaded skill
 * at runtime without editing its `SKILL.md`.
 *
 * Port of oracle `crates/coding-agent/src/tools/set_skill_state.rs` (pie @0a120dfd). See
 * `./skill.ts`'s module doc for the architecture this file follows (pi's `core/skills.ts` +
 * `ToolDefinition`, NOT `@pie/agent-core`'s `AgentHarness`) and why.
 *
 * Persistence is the `skills-state.json` overlay (`../skills-state.ts`, port of
 * `crates/coding-agent/src/skills_state.rs`) keyed by `{source, name}` -- the user's SKILL.md
 * stays pristine and the choice survives restarts and reloads. Works for ANY source: a
 * builtin/project skill that can't be deleted can still be disabled. (Removal of user-installed
 * skills is the separate `RemoveSkill` tool, `./remove-skill.ts`.)
 *
 * Authorization model (pie: set_skill_state.rs:9-17, issue #110 sub-PR 3):
 * - `enabled: false` (disable) is narrowing -> `PermissionClassification::Allow`. The model may
 *   disable a skill on its own; the user can always re-enable via `/skills enable`.
 * - `enabled: true` (re-enable) is escalating -> `PermissionClassification::Prompt` with a bounded
 *   reason naming the skill, routed through the runtime's control-plane confirmation channel
 *   (`AgentTool.permissionClassification`, `@pie/agent-core`'s `packages/agent/src/types.ts`).
 *
 * Safety:
 * - Two-phase preview: the first call (without `confirm: true`) previews the change (current vs
 *   target enabled state, resolved source) without writing. `confirm: true` applies it.
 * - Source resolution is unambiguous: the catalog is deduped by name, so the active skill for a
 *   name has exactly one source. The optional `source` arg, if given, must match the resolved
 *   source.
 * - Audit: oracle additionally records a `Custom { custom_type: "skill_control_plane" }` session
 *   entry (op/name/source/before+after enabled state + actor, no skill body). TODO(port): not
 *   written here -- `audit_entry_id` is always `undefined` -- for the same reason
 *   `install-skill.ts` documents: `ToolDefinition.execute`'s `ExtensionContext` exposes only a
 *   read-only `sessionManager`, with no append/write hook reachable from tool execution in this
 *   port's architecture.
 */

import type { AgentTool, PermissionClassification } from "@pie/agent-core";
import { type Static, Type } from "typebox";
import { getAgentDir } from "../config.ts";
import type { ToolDefinition } from "../core/extensions/types.ts";
import { wrapToolDefinition } from "../core/tools/tool-definition-wrapper.ts";
import { type SkillSource, setAndSaveSkillsState } from "../skills-state.ts";
import { findLoadedSkillOrThrow, loadEffectiveSkills, parseSkillSource, resolveSkillSource } from "./skill.ts";

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function enabledWord(enabled: boolean): string {
	return enabled ? "enabled" : "disabled";
}

// pie: set_skill_state.rs:307-332 (DEFINITION.parameters, verbatim text)
const setSkillStateSchema = Type.Object(
	{
		name: Type.String({ description: "Exact skill name as shown in /skills." }),
		// pie: set_skill_state.rs:307-332 — oracle hand-writes `{"type": "string", "enum": [...]}`.
		// See git.ts's `subcommand` for why `Type.Union([Type.Literal ...])` is the wrong wire shape.
		source: Type.Optional(
			Type.Unsafe<SkillSource>({
				type: "string",
				enum: ["builtin", "user", "project"],
				description: "Optional. The active source is resolved automatically; if given, must match it.",
			}),
		),
		enabled: Type.Boolean({
			description:
				"Target state. `false` disables (no user prompt). `true` re-enables and triggers a user " +
				"confirmation prompt before the change applies.",
		}),
		confirm: Type.Optional(
			Type.Boolean({
				default: false,
				description: "When false (default) returns a preview; when true applies the change.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type SetSkillStateToolInput = Static<typeof setSkillStateSchema>;

// pie: set_skill_state.rs:199-208 / 264-271 (details keys kept snake_case verbatim -- UI/log-only)
export type SetSkillStateToolDetails =
	| {
			phase: "preview";
			name: string;
			source: SkillSource;
			currently_enabled: boolean;
			target_enabled: boolean;
			no_change: boolean;
	  }
	| {
			phase: "applied";
			name: string;
			source: SkillSource;
			enabled: boolean;
			effective_enabled_after_reload: boolean | null;
			/** Always undefined -- see module docs (no session-append hook reachable from execute()). */
			audit_entry_id?: string;
	  };

export interface SetSkillStateToolOptions {
	/** Agent config dir. Defaults to `getAgentDir()`. */
	agentDir?: string;
	/** Base dir for `skills-state.json`. Defaults to `agentDir`. Tests override to a temp dir. */
	baseDir?: string;
}

/**
 * pie: set_skill_state.rs:102-125 (`permission_classification`) -- branches on the prepared
 * `enabled` arg. `preparedArgs` is typed `Static<TParameters>`, but this reads it defensively
 * (same rationale as `install-skill.ts`'s `classifyInstallSkillPermission`): oracle classifies
 * against a loosely-typed `serde_json::Value` BEFORE struct deserialization, so a degenerate/
 * incomplete args object is a real oracle-tested scenario (`missing enabled defaults to Allow`).
 */
export function classifySetSkillStatePermission(preparedArgs: SetSkillStateToolInput): PermissionClassification {
	const enabled = (preparedArgs as { enabled?: unknown } | undefined)?.enabled === true;
	if (!enabled) {
		return { type: "allow" };
	}
	const nameValue = (preparedArgs as { name?: unknown } | undefined)?.name;
	const name = typeof nameValue === "string" ? nameValue : "<unknown>";
	return { type: "prompt", reason: `re-enable user-disabled skill \`${name}\`` };
}

export function createSetSkillStateToolDefinition(
	cwd: string,
	options?: SetSkillStateToolOptions,
): ToolDefinition<typeof setSkillStateSchema, SetSkillStateToolDetails> {
	const agentDir = options?.agentDir ?? getAgentDir();
	const baseDir = options?.baseDir ?? agentDir;

	return {
		name: "SetSkillState",
		label: "SetSkillState",
		// pie: set_skill_state.rs:297-306 (verbatim)
		description:
			"Enable or disable a loaded skill at runtime without editing its SKILL.md. The choice is " +
			"recorded in a local overlay (~/.pie/skills-state.json) keyed by source+name and survives " +
			"restarts. Works for any source — a builtin or project skill that can't be removed can " +
			"still be disabled. Two-phase: first call previews (current vs target state); call again " +
			"with `confirm: true` to apply. Disabling prevents the model from auto-invoking the skill " +
			"via the Skill tool; the skill still appears in the catalog. Re-enabling a " +
			"previously-disabled skill is a privileged control-plane write and requires explicit user " +
			"confirmation through the runtime prompt card before it takes effect (issue #110); " +
			"disabling does not prompt.",
		promptSnippet: "Enable or disable a loaded skill at runtime (two-phase confirm)",
		parameters: setSkillStateSchema,
		// pie: set_skill_state.rs:96-100 (ToolExecutionMode::Sequential -- serialize control-plane writes)
		executionMode: "sequential",
		// See `install-skill.ts` for why this is declared on the definition, not just the tool.
		permissionClassification: classifySetSkillStatePermission,
		async execute(_toolCallId, { name, source: sourceArg, enabled, confirm }, _signal, _onUpdate, _ctx) {
			const confirmed = confirm ?? false;

			const { skills } = await loadEffectiveSkills({ cwd, agentDir, baseDir });
			const skill = findLoadedSkillOrThrow(skills, name);
			const resolvedSource = resolveSkillSource(skill);

			// pie: set_skill_state.rs:169-182 -- optional source pin must match the resolved one.
			if (sourceArg !== undefined) {
				const requestedSource = parseSkillSource(sourceArg);
				if (requestedSource !== resolvedSource) {
					throw new Error(
						`skill '${name}' is active from source '${resolvedSource}', not '${requestedSource}'. ` +
							`Omit \`source\` or pass '${resolvedSource}' (the active source).`,
					);
				}
			}

			const currentlyEnabled = !skill.disableModelInvocation;
			const targetEnabled = enabled;

			if (!confirmed) {
				const noChange = currentlyEnabled === targetEnabled;
				return {
					content: [
						{
							type: "text" as const,
							text:
								"preview only — call again with `confirm: true` to apply. " +
								`skill=${name} source=${resolvedSource} currently=${enabledWord(currentlyEnabled)} ` +
								`target=${enabledWord(targetEnabled)}${noChange ? " (no change)" : ""}`,
						},
					],
					details: {
						phase: "preview",
						name,
						source: resolvedSource,
						currently_enabled: currentlyEnabled,
						target_enabled: targetEnabled,
						no_change: noChange,
					},
				};
			}

			// Apply: write the overlay, then re-derive the catalog so the result reflects the new state.
			try {
				await setAndSaveSkillsState(baseDir, name, resolvedSource, targetEnabled);
			} catch (err) {
				throw new Error(`persist skill state: ${errorMessage(err)}`);
			}

			const reload = await loadEffectiveSkills({ cwd, agentDir, baseDir });
			const reloaded = reload.skills.find((s) => s.name === name && resolveSkillSource(s) === resolvedSource);
			const effectiveEnabled = reloaded ? !reloaded.disableModelInvocation : null;

			return {
				content: [
					{
						type: "text" as const,
						text: `${enabledWord(targetEnabled)} skill '${name}' (source: ${resolvedSource}).`,
					},
				],
				details: {
					phase: "applied",
					name,
					source: resolvedSource,
					enabled: targetEnabled,
					effective_enabled_after_reload: effectiveEnabled,
					audit_entry_id: undefined,
				},
			};
		},
	};
}

export function createSetSkillStateTool(
	cwd: string,
	options?: SetSkillStateToolOptions,
): AgentTool<typeof setSkillStateSchema, SetSkillStateToolDetails> {
	const definition = createSetSkillStateToolDefinition(cwd, options);
	const tool = wrapToolDefinition(definition) as AgentTool<typeof setSkillStateSchema, SetSkillStateToolDetails>;
	return { ...tool, permissionClassification: classifySetSkillStatePermission };
}
