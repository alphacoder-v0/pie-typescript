/**
 * `RemoveSkill` builtin tool (skill-lifecycle task #23, S-A2b): delete a **user-installed** skill
 * from the user-global skills directory and refresh the catalog.
 *
 * Port of oracle `crates/coding-agent/src/tools/remove_skill.rs` (pie @0a120dfd). See
 * `./skill.ts`'s module doc for the architecture this file follows (pi's `core/skills.ts` +
 * `ToolDefinition`, NOT `@pie/agent-core`'s `AgentHarness`) and why.
 *
 * Scope guard (pie: remove_skill.rs:4-8, locked with Provider/Auth + QA on the #ux
 * skill-lifecycle thread): only `SkillSource.User` skills can be removed. A `Builtin` skill is
 * compiled into the binary (not applicable to this port yet -- see `./skill.ts`'s
 * `resolveSkillSource` doc); a `Project` skill belongs to the repo, not this user. Removing those
 * isn't meaningful here -- the tool returns a bounded error pointing at `SetSkillState` /
 * `/skills disable` instead. This keeps "remove" strictly a deletion of something the user
 * installed.
 *
 * Safety:
 * - Two-phase: first call (without `confirm: true`) previews the target path; `confirm: true`
 *   deletes.
 * - The deletion target is derived from the resolved skill's `filePath` and must be a direct
 *   child of the user skills root (`../tools/install-skill.ts`'s `defaultSkillsRoot`) -- never a
 *   caller-supplied path component -- so a hostile name can't escape the skills root.
 * - After deleting, the skill's `{User, name}` overlay entry is cleared (`../skills-state.ts`) so
 *   a later reinstall of the same name doesn't inherit a stale disabled state.
 * - Audit: oracle records `Custom { custom_type: "skill_control_plane" }`, op `remove`. TODO(port):
 *   not written here -- `audit_entry_id` is always `undefined` -- see `./set-skill-state.ts`'s
 *   module doc for the same architectural reason (no session-append hook reachable from
 *   `ToolDefinition.execute`).
 */

import { lstat, rm, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { AgentTool, PermissionClassification } from "@pie/agent-core";
import { type Static, Type } from "typebox";
import { getAgentDir } from "../config.ts";
import type { ToolDefinition } from "../core/extensions/types.ts";
import { wrapToolDefinition } from "../core/tools/tool-definition-wrapper.ts";
import { removeAndSaveSkillsState } from "../skills-state.ts";
import { defaultSkillsRoot } from "./install-skill.ts";
import { findLoadedSkillOrThrow, loadEffectiveSkills, parseSkillSource, resolveSkillSource } from "./skill.ts";

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Compute what to delete for a skill whose SKILL.md is `filePath`, given the skills root. Returns
 * the direct child of `skillsRoot` on the path (a `<name>/` dir for a `<name>/SKILL.md` layout, or
 * a root-level `<x>.md` file), or `undefined` if `filePath` is not under `skillsRoot`. The
 * returned path is always `join(skillsRoot, <first component>)`, so it can never escape the root
 * regardless of what the skill record claims.
 * pie: remove_skill.rs:279-293 (`deletion_target`)
 */
export function deletionTarget(skillsRoot: string, filePath: string): string | undefined {
	const rel = relative(skillsRoot, filePath);
	if (!rel || rel === "." || rel === ".." || isAbsolute(rel) || rel.startsWith(`..${sep}`)) {
		return undefined;
	}
	const first = rel.split(sep)[0];
	if (!first) return undefined;
	return join(skillsRoot, first);
}

/**
 * Delete `target` (dir or file), tolerating it already being gone (idempotent, matches oracle
 * treating a `symlink_metadata` failure as "already gone -- success"). Throws on a genuine
 * removal failure.
 * pie: remove_skill.rs:196-213
 */
async function deleteSkillPath(target: string): Promise<void> {
	let stat: Awaited<ReturnType<typeof lstat>>;
	try {
		stat = await lstat(target);
	} catch {
		return;
	}
	try {
		if (stat.isDirectory()) {
			await rm(target, { recursive: true, force: true });
		} else {
			await unlink(target);
		}
	} catch (err) {
		throw new Error(`remove ${target}: ${errorMessage(err)}`);
	}
}

// pie: remove_skill.rs:315-335 (DEFINITION.parameters, verbatim text)
const removeSkillSchema = Type.Object(
	{
		name: Type.String({ description: "Exact skill name as shown in /skills." }),
		// pie: remove_skill.rs:315-335 — oracle hand-writes `{"type": "string", "enum": [...]}`.
		// See git.ts's `subcommand` for why `Type.Union([Type.Literal ...])` is the wrong wire shape.
		source: Type.Optional(
			Type.Unsafe<"builtin" | "user" | "project">({
				type: "string",
				enum: ["builtin", "user", "project"],
				description: "Optional. Must be `user` if given — only user-installed skills are removable.",
			}),
		),
		confirm: Type.Optional(
			Type.Boolean({
				default: false,
				description: "When false (default) returns a preview; when true performs the deletion.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type RemoveSkillToolInput = Static<typeof removeSkillSchema>;

// pie: remove_skill.rs:186-193 / 265-273 (details keys kept snake_case verbatim -- UI/log-only)
export type RemoveSkillToolDetails =
	| { phase: "preview"; name: string; source: "user"; target_path: string }
	| {
			phase: "removed";
			name: string;
			source: "user";
			target_path: string;
			still_present_after_reload: boolean;
			total_skills_after: number;
			/** Always undefined -- see module docs (no session-append hook reachable from execute()). */
			audit_entry_id?: string;
	  };

export interface RemoveSkillToolOptions {
	/** Agent config dir. Defaults to `getAgentDir()`. */
	agentDir?: string;
	/** Base dir for `skills-state.json`. Defaults to `agentDir`. */
	baseDir?: string;
	/** User skills root. Defaults to `defaultSkillsRoot(agentDir)`. Tests override to a temp dir. */
	skillsRoot?: string;
}

/**
 * pie: remove_skill.rs:85-97 (`permission_classification`) -- always Prompt; removing a user
 * skill is a destructive control-plane write the model cannot self-authorize.
 */
export function classifyRemoveSkillPermission(preparedArgs: RemoveSkillToolInput): PermissionClassification {
	const nameValue = (preparedArgs as { name?: unknown } | undefined)?.name;
	const name = typeof nameValue === "string" ? nameValue : "<unknown>";
	return { type: "prompt", reason: `remove user skill \`${name}\`` };
}

export function createRemoveSkillToolDefinition(
	cwd: string,
	options?: RemoveSkillToolOptions,
): ToolDefinition<typeof removeSkillSchema, RemoveSkillToolDetails> {
	const agentDir = options?.agentDir ?? getAgentDir();
	const baseDir = options?.baseDir ?? agentDir;
	const skillsRoot = options?.skillsRoot ?? defaultSkillsRoot(agentDir);

	return {
		name: "RemoveSkill",
		label: "RemoveSkill",
		// pie: remove_skill.rs:306-314 (verbatim, "~/.pie/skills/" left as-is: user-facing prose
		// describing the concept this port maps onto its own agentDir/skills location, same
		// convention as install-skill.ts's description)
		description:
			"Delete a user-installed skill (from ~/.pie/skills/) and hot-reload the catalog. Only " +
			"user-installed skills can be removed — builtin skills are compiled into pie and project " +
			"skills belong to the repo; for those, disable instead via SetSkillState. Two-phase: " +
			"first call previews the target path; call again with `confirm: true` to delete. Removing " +
			"also clears any disabled-state overlay entry for the skill.",
		promptSnippet: "Delete a user-installed skill (two-phase confirm)",
		parameters: removeSkillSchema,
		// pie: remove_skill.rs:79-83 (ToolExecutionMode::Sequential -- serialize control-plane writes)
		executionMode: "sequential",
		// See `install-skill.ts` for why this is declared on the definition, not just the tool.
		permissionClassification: classifyRemoveSkillPermission,
		async execute(_toolCallId, { name, source: sourceArg, confirm }, _signal, _onUpdate, _ctx) {
			const confirmed = confirm ?? false;

			const { skills } = await loadEffectiveSkills({ cwd, agentDir, baseDir });
			const skill = findLoadedSkillOrThrow(skills, name);
			const source = resolveSkillSource(skill);

			// pie: remove_skill.rs:136-146 -- scope guard: only user-installed skills are removable.
			if (source !== "user") {
				throw new Error(
					`'${name}' is a ${source} skill and cannot be removed (builtin skills are compiled in; ` +
						"project skills belong to the repo). Disable it instead with SetSkillState or " +
						`\`/skills disable ${name}\`.`,
				);
			}

			// pie: remove_skill.rs:148-158 -- optional source pin must also be `user`.
			if (sourceArg !== undefined) {
				const requestedSource = parseSkillSource(sourceArg);
				if (requestedSource !== "user") {
					throw new Error(
						`only user-installed skills can be removed; '${name}' is a user skill, not '${requestedSource}'.`,
					);
				}
			}

			const target = deletionTarget(skillsRoot, skill.filePath);
			if (target === undefined) {
				throw new Error(
					`refusing to remove '${name}': its file (${skill.filePath}) is not under the user skills root ` +
						`(${skillsRoot}).`,
				);
			}

			if (!confirmed) {
				return {
					content: [
						{
							type: "text" as const,
							text:
								"preview only — call again with `confirm: true` to delete. " +
								`skill=${name} source=user target=${target}`,
						},
					],
					details: { phase: "preview", name, source: "user", target_path: target },
				};
			}

			await deleteSkillPath(target);

			// Forget any disabled-state overlay entry so a future reinstall starts fresh.
			// pie: remove_skill.rs:217-223 -- best-effort; a failure here does not fail the removal
			// (oracle logs a tracing::warn! -- see ../skills-state.ts's module doc re: no wired logger).
			try {
				await removeAndSaveSkillsState(baseDir, name, source);
			} catch {
				// best-effort only; the deletion itself already succeeded
			}

			const reload = await loadEffectiveSkills({ cwd, agentDir, baseDir });
			const stillPresent = reload.skills.some((s) => s.name === name && resolveSkillSource(s) === "user");

			return {
				content: [
					{
						type: "text" as const,
						text: `removed skill '${name}' (user). catalog now has ${reload.skills.length} skill(s).`,
					},
				],
				details: {
					phase: "removed",
					name,
					source: "user",
					target_path: target,
					still_present_after_reload: stillPresent,
					total_skills_after: reload.skills.length,
					audit_entry_id: undefined,
				},
			};
		},
	};
}

export function createRemoveSkillTool(
	cwd: string,
	options?: RemoveSkillToolOptions,
): AgentTool<typeof removeSkillSchema, RemoveSkillToolDetails> {
	const definition = createRemoveSkillToolDefinition(cwd, options);
	const tool = wrapToolDefinition(definition) as AgentTool<typeof removeSkillSchema, RemoveSkillToolDetails>;
	return { ...tool, permissionClassification: classifyRemoveSkillPermission };
}
