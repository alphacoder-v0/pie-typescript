/**
 * `SkillBuilder` builtin tool.
 *
 * Authors a new user-global skill from structured fields. Where `InstallSkill` ingests a
 * complete, externally sourced `SKILL.md`, `SkillBuilder` owns the format: the model supplies
 * `name` / `description` / `instructions` (+ optional `examples`) and the tool renders the
 * canonical template, so every produced skill is loadable by construction and the model never
 * hand-assembles frontmatter.
 *
 * Safety model is inherited from `InstallSkill` (`install-skill.ts`) and shares its code paths:
 * two-phase `confirm` flow, the same `parseAndValidateSkillMd` validation, the same atomic
 * tempfile+rename write, and the same catalog-snapshot "reload" approximation (see
 * `install-skill.ts` module docs for why this is a snapshot recompute rather than a live
 * running-harness mutation, and why the `skill_install` audit entry is not written here either).
 *
 * Port of oracle `crates/coding-agent/src/tools/skill_builder.rs` (pie @0a120dfd).
 */

import type { AgentTool, PermissionClassification } from "@pie/agent-core";
import { type Static, Type } from "typebox";
import { stringify as stringifyYaml } from "yaml";
import { getAgentDir } from "../config.ts";
import type { ToolDefinition } from "../core/extensions/types.ts";
import { wrapToolDefinition } from "../core/tools/tool-definition-wrapper.ts";
import {
	atomicWriteSkill,
	defaultSkillsRoot,
	onDiskSkillHash,
	parseAndValidateSkillMd,
	relevantDiagnosticWarnings,
	reloadSkillCatalog,
} from "./install-skill.ts";

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// ──────────────────────────────────────────────────────────────────────────────────────────
// Input
// ──────────────────────────────────────────────────────────────────────────────────────────

// pie: skill_builder.rs:356-388 (DEFINITION.parameters, verbatim text)
const skillBuilderSchema = Type.Object(
	{
		name: Type.String({
			description:
				"Skill name: lowercase kebab-case (a-z, 0-9, hyphens), max 64 chars. Becomes the directory name and the /skill lookup key.",
		}),
		description: Type.String({
			description:
				"One-line summary of what the skill does AND when to use it (max 1024 chars). This is the trigger line the model sees in the catalog — include concrete cue phrases.",
		}),
		instructions: Type.String({
			description:
				"Markdown body: the steps, conventions, and guidance the skill teaches. Rendered under an '## Instructions' heading.",
		}),
		examples: Type.Optional(
			Type.String({ description: "Optional markdown examples, rendered under an '## Examples' heading." }),
		),
		confirm: Type.Optional(
			Type.Boolean({
				default: false,
				description:
					"When false (default), validates and returns a preview without writing. When true, writes the skill and reloads the catalog.",
			}),
		),
		overwrite: Type.Optional(
			Type.Boolean({
				default: false,
				description: "Required when a skill of the same name already exists with different content.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type SkillBuilderToolInput = Static<typeof skillBuilderSchema>;

// pie: skill_builder.rs:233-333 -- details keys kept snake_case verbatim, matching install-skill.ts.
export interface SkillBuilderToolDetails {
	phase: "preview" | "installed";
	name: string;
	description?: string;
	target_path: string;
	content_hash: string;
	size: number;
	existing?: boolean;
	overwrite_required?: boolean;
	overwrote?: boolean;
	total_skills_after?: number;
	diagnostics_count?: number;
	warnings: string[];
	installed_visible_in_catalog?: boolean;
	/** Always undefined -- see install-skill.ts module docs (no session-append hook reachable). */
	audit_entry_id?: string;
}

export interface SkillBuilderToolOptions {
	/** Root directory containing per-skill subdirectories. Defaults to `defaultSkillsRoot()`. */
	skillsRoot?: string;
	/** Agent config dir used to resolve the default `skillsRoot`. Defaults to `getAgentDir()`. */
	agentDir?: string;
}

// ──────────────────────────────────────────────────────────────────────────────────────────
// Render
// ──────────────────────────────────────────────────────────────────────────────────────────

/** `code-review-checklist` -> `Code Review Checklist`. pie: skill_builder.rs:109-122 (title_from_name) */
function titleFromName(name: string): string {
	return name
		.split("-")
		.filter((part) => part.length > 0)
		.map((part) => part[0]!.toUpperCase() + part.slice(1))
		.join(" ");
}

/**
 * Render the canonical `SKILL.md`. Frontmatter goes through the `yaml` package so special
 * characters in `description` are escaped correctly; the description is collapsed to a single
 * line first (it is the catalog trigger line, not body text).
 * pie: skill_builder.rs:78-107 (render_skill_md)
 */
export function renderSkillMd(name: string, description: string, instructions: string, examples?: string): string {
	const collapsedDescription = description
		.split(/\s+/)
		.filter((part) => part.length > 0)
		.join(" ");
	if (collapsedDescription.length === 0) {
		throw new Error("description must not be empty");
	}
	if (instructions.trim().length === 0) {
		throw new Error("instructions must not be empty");
	}

	let yaml: string;
	try {
		// pie: skill_builder.rs:92-96 -- `serde_yaml::Mapping` with insertion order name, description.
		yaml = stringifyYaml({ name, description: collapsedDescription });
	} catch (err) {
		throw new Error(`render frontmatter: ${errorMessage(err)}`);
	}

	let out = `---\n${yaml}---\n\n# ${titleFromName(name)}\n\n## Instructions\n\n${instructions.trim()}\n`;
	const trimmedExamples = examples?.trim();
	if (trimmedExamples) {
		out += `\n## Examples\n\n${trimmedExamples}\n`;
	}
	return out;
}

// ──────────────────────────────────────────────────────────────────────────────────────────
// Permission classification
// ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * pie: skill_builder.rs:147-168 (permission_classification) -- preview (`confirm` false/absent)
 * is a pure read and runs under Allow; only the `confirm: true` write phase prompts. The skill
 * name only enters the bounded reason after passing the same charset/length shape the validator
 * enforces (defense against a hostile name value leaking through the reason text).
 */
export function classifySkillBuilderPermission(preparedArgs: SkillBuilderToolInput): PermissionClassification {
	if (!preparedArgs?.confirm) {
		return { type: "allow" };
	}
	const rawName = preparedArgs.name;
	const isValidShape =
		typeof rawName === "string" && rawName.length > 0 && rawName.length <= 64 && /^[a-z0-9-]*$/.test(rawName);
	const name = isValidShape ? rawName : "<invalid name>";
	return { type: "prompt", reason: `create user skill \`${name}\`` };
}

// ──────────────────────────────────────────────────────────────────────────────────────────
// Tool definition
// ──────────────────────────────────────────────────────────────────────────────────────────

export function createSkillBuilderToolDefinition(
	cwd: string,
	options?: SkillBuilderToolOptions,
): ToolDefinition<typeof skillBuilderSchema, SkillBuilderToolDetails> {
	const agentDir = options?.agentDir ?? getAgentDir();
	const skillsRoot = options?.skillsRoot ?? defaultSkillsRoot(agentDir);

	return {
		name: "SkillBuilder",
		label: "SkillBuilder",
		// pie: skill_builder.rs:341-355 (verbatim, "~/.pie/skills" left as-is -- see install-skill.ts
		// module docs for the agentDir mapping this prose describes)
		description:
			"Create a NEW user skill from structured fields and hot-reload the catalog. Use this " +
			"when the user asks to create, save, or codify a reusable skill, workflow, checklist, " +
			'or convention — including "summarize the recent work / this conversation into a ' +
			'skill": distill the generalizable workflow from the conversation (steps actually ' +
			"performed, commands used, pitfalls hit) and write instructions for the general case, " +
			"not a transcript of this one instance. Use InstallSkill instead when installing an " +
			"existing SKILL.md from a URL, file, or pasted content. The tool renders canonical " +
			"SKILL.md (frontmatter + sections) from name/description/instructions — do not " +
			"hand-write frontmatter. Two-phase: first call without `confirm` validates and " +
			"returns a preview (target path, hash, size, shadow warnings); show the user the " +
			"planned name/description and get their go-ahead, then call again with `confirm: " +
			"true` to write atomically to ~/.pie/skills/<name>/SKILL.md and reload. A same-name " +
			"skill with different content additionally requires `overwrite: true`.",
		promptSnippet: "Author a new skill from name/description/instructions (two-phase confirm)",
		parameters: skillBuilderSchema,
		// pie: skill_builder.rs:134-137
		executionMode: "sequential",
		// See `install-skill.ts` for why this is declared on the definition, not just the tool.
		permissionClassification: classifySkillBuilderPermission,
		async execute(
			_toolCallId,
			{ name, description, instructions, examples, confirm, overwrite },
			_signal,
			_onUpdate,
			_ctx,
		) {
			// Phase 1: render + validate. Pure read; no fs writes happen here. The rendered
			// content goes through the exact validation InstallSkill applies (parseAndValidateSkillMd),
			// so authored skills can never diverge from what the loader accepts.
			const rendered = renderSkillMd(name, description, instructions, examples);
			const parsed = parseAndValidateSkillMd(rendered);
			if (parsed.name !== name) {
				throw new Error(`skill name \`${name}\` did not survive rendering; use lowercase kebab-case`);
			}
			const targetPath = `${skillsRoot}/${parsed.name}/SKILL.md`;
			const existingHash = await onDiskSkillHash(targetPath);
			const existing = existingHash !== undefined;
			const overwriteRequired = existing && existingHash !== parsed.contentHash;

			// pie: skill_builder.rs:201-220 -- shadow warnings from the live catalog: a same-name
			// project skill takes precedence over the new user skill. Oracle also warns when a
			// same-name BUILTIN skill would be shadowed (SkillSource::Builtin); pi's
			// `../core/skills.ts` catalog has no builtin-skill concept to check against (skills are
			// always file-based: user dir + project dir + explicit paths), so that branch has no
			// TS equivalent. TODO(port): revisit if/when a builtin-skill source is introduced.
			const currentCatalog = reloadSkillCatalog(skillsRoot, cwd);
			const warnings = [...parsed.warnings];
			for (const skill of currentCatalog.skills) {
				if (skill.name === parsed.name && skill.sourceInfo.scope === "project") {
					warnings.push(`a project skill named '${parsed.name}' exists and will shadow this user skill`);
				}
			}

			if (!confirm) {
				return {
					content: [
						{
							type: "text" as const,
							text:
								"preview only — call again with `confirm: true` to create the skill. " +
								`name=${parsed.name} target=${targetPath} size=${parsed.size}B existing=${existing} overwrite_required=${overwriteRequired}`,
						},
					],
					details: {
						phase: "preview",
						name: parsed.name,
						description: parsed.description,
						warnings,
						target_path: targetPath,
						content_hash: parsed.contentHash,
						size: parsed.size,
						existing,
						overwrite_required: overwriteRequired,
					},
				};
			}

			// Phase 2: write. Refuse silent overwrite unless caller explicitly asked.
			if (overwriteRequired && !overwrite) {
				throw new Error(
					`skill '${parsed.name}' already exists with different content. Call again with ` +
						"`overwrite: true` to replace it.",
				);
			}

			await atomicWriteSkill(targetPath, parsed.normalizedContent);

			const reload = reloadSkillCatalog(skillsRoot, cwd);
			const installed = reload.skills.some((s) => s.name === parsed.name);
			warnings.push(...relevantDiagnosticWarnings(reload.diagnostics, parsed.name, targetPath));

			return {
				content: [
					{
						type: "text" as const,
						text: `created skill '${parsed.name}' at ${targetPath} (${parsed.size}B). catalog now has ${reload.skills.length} skill(s).`,
					},
				],
				details: {
					phase: "installed",
					name: parsed.name,
					target_path: targetPath,
					content_hash: parsed.contentHash,
					size: parsed.size,
					overwrote: overwriteRequired,
					total_skills_after: reload.skills.length,
					diagnostics_count: reload.diagnostics.length,
					warnings,
					installed_visible_in_catalog: installed,
					audit_entry_id: undefined,
				},
			};
		},
	};
}

export function createSkillBuilderTool(
	cwd: string,
	options?: SkillBuilderToolOptions,
): AgentTool<typeof skillBuilderSchema, SkillBuilderToolDetails> {
	const definition = createSkillBuilderToolDefinition(cwd, options);
	const tool = wrapToolDefinition(definition) as AgentTool<typeof skillBuilderSchema, SkillBuilderToolDetails>;
	return {
		...tool,
		permissionClassification: classifySkillBuilderPermission,
	};
}
