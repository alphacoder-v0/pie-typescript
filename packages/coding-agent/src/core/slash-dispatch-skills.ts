/**
 * `/skills`, `/skill`, and the dynamic per-skill shortcut commands — the skill family of oracle
 * `crates/coding-agent/src/commands.rs` (pie @0a120dfd).
 *
 * pie: commands.rs:343-853 (`SkillsCommand`, `SkillCommand`, `attach_skill_prompt` and their
 * helpers) + commands.rs:3061-3145 (`SkillShortcut`, `skill_shortcuts`, `resolve_skill_shortcut`,
 * `run_skill_shortcut`).
 *
 * The one behavioral invariant that binds every function here: a SKILL.md **body is never echoed**
 * — not into console output, not into an error message, not into a generated agent prompt. That is
 * why `CommandSkill` (see `slash-dispatch-deps.ts`) has no `content` field at all.
 *
 * `/skills install` and `/skills remove` route through the same two tools oracle routes through
 * (`InstallSkillTool` / `RemoveSkillTool`), so the slash path and the model path share one
 * implementation. Oracle hands them a `SkillHarnessCell`; this port's tool ports take
 * `(cwd, { skillsRoot, agentDir, baseDir })` instead and re-scan disk themselves — see
 * `tools/skill.ts`'s module doc for why the whole skill family standardised on that.
 */

import { join } from "node:path";
import { getAgentDir } from "../config.ts";
import { type SkillSource, setAndSaveSkillsState, skillSourceLabel } from "../skills-state.ts";
import { createInstallSkillToolDefinition, type InstallSkillToolDetails } from "../tools/install-skill.ts";
import { createRemoveSkillToolDefinition, type RemoveSkillToolDetails } from "../tools/remove-skill.ts";
import type { ExtensionContext } from "./extensions/types.ts";
import {
	type CommandCtx,
	type CommandOutcome,
	type CommandRegistry,
	type CommandSkill,
	commandError,
	emitCommandLine,
	HANDLED,
	previewText,
} from "./slash-dispatch-deps.ts";

/**
 * `ToolDefinition.execute`'s fifth parameter is a required `ExtensionContext`, but both skill
 * tools ignore it (`_ctx`) — oracle's `AgentTool::execute` has no such parameter at all. Passing a
 * sentinel keeps the slash path on the exact same code path as the model path instead of forking
 * a second implementation.
 * TODO(port): drop once `ToolDefinition.execute` makes `ctx` optional.
 */
const NO_EXTENSION_CTX = undefined as unknown as ExtensionContext;

/* -------------------------------------------------------------------------------------------
 * Skill lookup helpers — pie: commands.rs:749-786.
 * ----------------------------------------------------------------------------------------- */

/** pie: commands.rs:754-761 (`parse_skill_source`). Message is oracle-verbatim. */
export function parseCommandSkillSource(raw: string): SkillSource {
	switch (raw) {
		case "builtin":
			return "builtin";
		case "user":
			return "user";
		case "project":
			return "project";
		default:
			throw new Error("invalid skill source; expected one of: builtin, user, project");
	}
}

/** pie: commands.rs:749-752 (`optional_skill_source`). */
function optionalSkillSource(raw: string | undefined): { source?: SkillSource } | { error: string } {
	if (raw === undefined) return {};
	try {
		return { source: parseCommandSkillSource(raw) };
	} catch (error) {
		return { error: errorText(error) };
	}
}

/** pie: commands.rs:763-786 (`resolve_active_skill`). */
function resolveActiveSkill(
	skills: readonly CommandSkill[],
	name: string,
	source: SkillSource | undefined,
): { skill: CommandSkill } | { error: string } {
	const matches = skills.filter((skill) => skill.name === name && (source === undefined || skill.source === source));
	if (matches.length === 1) return { skill: matches[0] as CommandSkill };
	if (matches.length === 0) {
		// pie: commands.rs:775-777 — the hint keeps the surrounding spaces so the sentence reads
		// "no active user skill named 'x'." / "no active skill named 'x'.".
		const sourceHint = source === undefined ? " " : ` ${skillSourceLabel(source)} `;
		return { error: `no active${sourceHint}skill named '${name}'. Run /skills to list loaded skills.` };
	}
	return { error: `multiple active skills named '${name}'; pass source: builtin, user, or project` };
}

/* -------------------------------------------------------------------------------------------
 * /skills — pie: commands.rs:343-374.
 * ----------------------------------------------------------------------------------------- */

const SKILLS_USAGE =
	"usage: /skills [install [--confirm] [--overwrite] <url|path>|show <name>|reload|enable <name> [source]|disable <name> [source]|remove [--confirm] <name> [source]]";

/** pie: commands.rs:356-373 (`SkillsCommand::run`). */
export async function runSkillsCommand(argv: readonly string[], ctx: CommandCtx): Promise<CommandOutcome> {
	const sub = argv[0];
	switch (sub) {
		case undefined:
		case "list":
		case "ls":
			printSkillsList(ctx.harness.skills());
			return HANDLED;
		case "install":
			return installSkill(argv.slice(1), ctx);
		case "show":
			return showSkill(argv.slice(1), ctx);
		case "reload":
			return reloadSkills(ctx);
		case "enable":
			return setSkillEnabled(argv.slice(1), ctx, true);
		case "disable":
			return setSkillEnabled(argv.slice(1), ctx, false);
		case "remove":
			return removeSkill(argv.slice(1), ctx);
		default:
			return commandError(SKILLS_USAGE);
	}
}

/** pie: commands.rs:376-396 (`print_skills_list`). */
function printSkillsList(skills: readonly CommandSkill[]): void {
	if (skills.length === 0) {
		emitCommandLine(
			"(no skills loaded — drop SKILL.md files under ~/.pie/skills/<name>/ or <cwd>/.pie/skills/<name>/)",
		);
		return;
	}
	emitCommandLine(`Loaded skills (${skills.length}):`);
	for (const s of skills) {
		const disabled = s.disableModelInvocation ? "  [disabled: disable_model_invocation=true]" : "";
		emitCommandLine(`  - ${s.name}  (${skillSourceLabel(s.source)})${disabled}`);
		if (s.description !== "") emitCommandLine(`      ${s.description}`);
		emitCommandLine(`      path: ${s.filePath}`);
	}
}

/** pie: commands.rs:398-426 (`show_skill`). */
function showSkill(argv: readonly string[], ctx: CommandCtx): CommandOutcome {
	const name = argv[0];
	if (name === undefined) return commandError("usage: /skills show <name> [source]");
	const parsed = optionalSkillSource(argv[1]);
	if ("error" in parsed) return commandError(parsed.error);
	const resolved = resolveActiveSkill(ctx.harness.skills(), name, parsed.source);
	if ("error" in resolved) return commandError(resolved.error);
	const skill = resolved.skill;
	emitCommandLine(`Skill: ${skill.name} (${skillSourceLabel(skill.source)})`);
	emitCommandLine(`Status: ${skill.disableModelInvocation ? "disabled" : "enabled"}`);
	if (skill.description !== "") emitCommandLine(`Description: ${skill.description}`);
	emitCommandLine(`Path: ${skill.filePath}`);
	emitCommandLine("Body: not shown; use the file path if you need to inspect the full skill.");
	return HANDLED;
}

/** pie: commands.rs:428-440 (`reload_skills`). */
async function reloadSkills(ctx: CommandCtx): Promise<CommandOutcome> {
	try {
		const out = await ctx.harness.reloadSkillsFromDisk();
		emitCommandLine(`reloaded skills: ${out.skills.length} loaded, ${out.diagnostics.length} diagnostics`);
		return HANDLED;
	} catch (error) {
		return commandError(`reload skills failed: ${errorText(error)}`);
	}
}

/* -------------------------------------------------------------------------------------------
 * /skills install — pie: commands.rs:442-558.
 * ----------------------------------------------------------------------------------------- */

interface InstallSkillArgs {
	target: string;
	confirm: boolean;
	overwrite: boolean;
}

/** pie: commands.rs:478-500 (`parse_skill_install_args`). */
function parseSkillInstallArgs(argv: readonly string[]): InstallSkillArgs | { error: string } {
	let confirm = false;
	let overwrite = false;
	const positional: string[] = [];
	for (const arg of argv) {
		if (arg === "--confirm" || arg === "--yes") confirm = true;
		else if (arg === "--overwrite") overwrite = true;
		else if (arg.startsWith("--")) return { error: `unknown option for /skills install: ${arg}` };
		else positional.push(arg);
	}
	if (positional.length !== 1) {
		return { error: "usage: /skills install [--confirm] [--overwrite] <https-url|path>" };
	}
	return { target: positional[0] as string, confirm, overwrite };
}

/** pie: commands.rs:502-514 (`skill_install_source`). */
function skillInstallSource(
	target: string,
	cwd: string,
): { type: "url"; url: string } | { type: "path"; path: string } {
	if (target.startsWith("http://") || target.startsWith("https://")) {
		return { type: "url", url: target };
	}
	return { type: "path", path: isAbsolutePath(target) ? target : join(cwd, target) };
}

/** pie: commands.rs:442-470 (`install_skill`). */
async function installSkill(argv: readonly string[], ctx: CommandCtx): Promise<CommandOutcome> {
	const parsed = parseSkillInstallArgs(argv);
	if ("error" in parsed) return commandError(parsed.error);
	const tool = createInstallSkillToolDefinition(ctx.cwd);
	try {
		const result = await tool.execute(
			"slash-skills-install",
			{ source: skillInstallSource(parsed.target, ctx.cwd), confirm: parsed.confirm, overwrite: parsed.overwrite },
			undefined,
			undefined,
			NO_EXTENSION_CTX,
		);
		printInstallSkillResult(result.details, toolResultText(result.content), parsed);
		await refreshCatalogAfterWrite(ctx, result.details.phase);
		return HANDLED;
	} catch (error) {
		return commandError(`install skill failed: ${errorText(error)}`);
	}
}

/**
 * Oracle's `InstallSkillTool`/`RemoveSkillTool` hold a `SkillHarnessCell` and hot-reload the live
 * catalog themselves after a confirmed write (install_skill.rs / remove_skill.rs), which is why
 * `commands.rs` never reloads at the call site. This port's tools have no harness handle at all
 * (see `tools/skill.ts`'s module doc), so the same user-visible effect — "after `--confirm`, the
 * catalog reflects the write" — is produced one frame out, here. Preview results never reload,
 * matching oracle. A reload failure is swallowed: the write already succeeded, and oracle's tools
 * likewise do not fail the command on a reload error.
 * TODO(port): move back inside the tools once they can reach the harness catalog.
 */
async function refreshCatalogAfterWrite(ctx: CommandCtx, phase: string): Promise<void> {
	if (phase === "preview") return;
	try {
		await ctx.harness.reloadSkillsFromDisk();
	} catch {
		// best-effort; the filesystem write itself already succeeded
	}
}

/** pie: commands.rs:516-558 (`print_install_skill_result`). */
function printInstallSkillResult(details: InstallSkillToolDetails, text: string, args: InstallSkillArgs): void {
	if (details.phase === "preview") {
		const name = details.name ?? "<unknown>";
		const target = details.target_path ?? "<unknown>";
		const size = details.size ?? 0;
		const existing = details.existing ?? false;
		const overwriteRequired = details.overwrite_required ?? false;
		emitCommandLine(
			`skill install preview: ${name} -> ${target} (${size}B, existing=${existing}, overwrite_required=${overwriteRequired})`,
		);
		const overwrite = overwriteRequired && !args.overwrite ? " --overwrite" : "";
		emitCommandLine(`run \`/skills install --confirm${overwrite} <same-url-or-path>\` to install`);
		return;
	}
	for (const line of text.split("\n")) emitCommandLine(line);
}

/* -------------------------------------------------------------------------------------------
 * /skills enable|disable — pie: commands.rs:560-612 + 720-747.
 * ----------------------------------------------------------------------------------------- */

/** pie: commands.rs:560-612 (`set_skill_enabled`). */
async function setSkillEnabled(argv: readonly string[], ctx: CommandCtx, enabled: boolean): Promise<CommandOutcome> {
	const rawName = argv[0];
	if (rawName === undefined) {
		return commandError(`usage: /skills ${enabled ? "enable" : "disable"} <name> [source]`);
	}
	const parsedSource = optionalSkillSource(argv[1]);
	if ("error" in parsedSource) return commandError(parsedSource.error);
	const resolved = resolveActiveSkill(ctx.harness.skills(), rawName, parsedSource.source);
	if ("error" in resolved) return commandError(resolved.error);

	const source = resolved.skill.source;
	const name = resolved.skill.name;
	const wasEnabled = !resolved.skill.disableModelInvocation;

	if (wasEnabled === enabled) {
		emitCommandLine(`skill already ${enabled ? "enabled" : "disabled"}: ${name} (${skillSourceLabel(source)})`);
		return HANDLED;
	}

	try {
		await setAndSaveSkillsState(getAgentDir(), name, source, enabled);
	} catch (error) {
		return commandError(`persist skill state failed: ${errorText(error)}`);
	}
	let out: { skills: CommandSkill[]; diagnostics: readonly unknown[] };
	try {
		out = await ctx.harness.reloadSkillsFromDisk();
	} catch (error) {
		return commandError(`reload after skill state change failed: ${errorText(error)}`);
	}
	await writeSkillStateAudit(ctx, name, source, wasEnabled, enabled);
	const diagnostics = out.diagnostics.length === 0 ? "" : ` (${out.diagnostics.length} diagnostics)`;
	emitCommandLine(`${enabled ? "enabled" : "disabled"} skill: ${name} (${skillSourceLabel(source)})${diagnostics}`);
	return HANDLED;
}

/**
 * pie: commands.rs:720-747 (`write_skill_state_audit`). A failed audit write is logged and
 * swallowed in oracle (`tracing::warn!`) — the state change itself already succeeded, so this is a
 * precondition-guard site (RULEBOOK §2.4), not an allocation guard.
 */
async function writeSkillStateAudit(
	ctx: CommandCtx,
	name: string,
	source: SkillSource,
	beforeEnabled: boolean,
	afterEnabled: boolean,
): Promise<void> {
	const audit = {
		op: "set_state",
		actor: "slash",
		name,
		source: skillSourceLabel(source),
		before_enabled: beforeEnabled,
		after_enabled: afterEnabled,
	};
	try {
		await ctx.harness.session().appendCustomEntry("skill_control_plane", audit);
	} catch {
		// pie: commands.rs:741-746 — warn-and-continue; no wired logger here (see skills-state.ts).
	}
}

/* -------------------------------------------------------------------------------------------
 * /skills remove — pie: commands.rs:614-698.
 * ----------------------------------------------------------------------------------------- */

interface RemoveSkillArgs {
	name: string;
	source?: SkillSource;
	confirm: boolean;
}

/** pie: commands.rs:651-676 (`parse_skill_remove_args`). */
function parseSkillRemoveArgs(argv: readonly string[]): RemoveSkillArgs | { error: string } {
	let confirm = false;
	const positional: string[] = [];
	for (const arg of argv) {
		if (arg === "--confirm" || arg === "--yes") confirm = true;
		else if (arg.startsWith("--")) return { error: `unknown option for /skills remove: ${arg}` };
		else positional.push(arg);
	}
	if (positional.length === 1) return { name: positional[0] as string, confirm };
	if (positional.length === 2) {
		try {
			return { name: positional[0] as string, source: parseCommandSkillSource(positional[1] as string), confirm };
		} catch (error) {
			return { error: errorText(error) };
		}
	}
	return { error: "usage: /skills remove [--confirm] <name> [source]" };
}

/** pie: commands.rs:614-643 (`remove_skill`). */
async function removeSkill(argv: readonly string[], ctx: CommandCtx): Promise<CommandOutcome> {
	const parsed = parseSkillRemoveArgs(argv);
	if ("error" in parsed) return commandError(parsed.error);
	const tool = createRemoveSkillToolDefinition(ctx.cwd);
	try {
		const result = await tool.execute(
			"slash-skills-remove",
			{
				name: parsed.name,
				confirm: parsed.confirm,
				...(parsed.source === undefined ? {} : { source: skillSourceLabel(parsed.source) }),
			} as Parameters<typeof tool.execute>[1],
			undefined,
			undefined,
			NO_EXTENSION_CTX,
		);
		printRemoveSkillResult(result.details, toolResultText(result.content));
		await refreshCatalogAfterWrite(ctx, result.details.phase);
		return HANDLED;
	} catch (error) {
		return commandError(`remove skill failed: ${errorText(error)}`);
	}
}

/** pie: commands.rs:678-698 (`print_remove_skill_result`). The literal `(user)` is oracle's — the
 * tool only ever removes user skills, so the label is not read off the result. */
function printRemoveSkillResult(details: RemoveSkillToolDetails, text: string): void {
	if (details.phase === "preview") {
		const name = details.name ?? "<unknown>";
		const target = details.target_path ?? "<unknown>";
		emitCommandLine(`skill remove preview: ${name} (user) -> ${target}`);
		emitCommandLine(`run \`/skills remove --confirm ${name}\` to remove it`);
		return;
	}
	for (const line of text.split("\n")) emitCommandLine(line);
}

/* -------------------------------------------------------------------------------------------
 * /skill — pie: commands.rs:788-853.
 * ----------------------------------------------------------------------------------------- */

/** pie: commands.rs:801-842 (`SkillCommand::run`). */
export async function runSkillCommand(argv: readonly string[], ctx: CommandCtx): Promise<CommandOutcome> {
	if (argv.length !== 1) return commandError("usage: /skill <name>");
	const name = argv[0] as string;
	const skills = ctx.harness.skills();
	const skill = skills.find((s) => s.name === name);
	if (skill === undefined) {
		let matches = skills
			.filter((s) => s.name.startsWith(name))
			.map((s) => s.name)
			.slice(0, 5);
		if (matches.length === 0) {
			matches = skills
				.filter((s) => s.name.includes(name))
				.map((s) => s.name)
				.slice(0, 5);
		}
		const hint = matches.length === 0 ? "" : ` Did you mean: ${matches.join(", ")}?`;
		return commandError(`no skill named '${name}'. Run /skills to list loaded skills.${hint}`);
	}
	if (skill.disableModelInvocation) {
		return commandError(
			`skill '${name}' is disabled (disable_model_invocation=true); edit the skill frontmatter to enable it`,
		);
	}
	emitCommandLine(`using skill: ${skill.name} (${skillSourceLabel(skill.source)}) for next turn`);
	return { kind: "attach_skill", name };
}

/**
 * pie: commands.rs:845-853 (`attach_skill_prompt`). Names the skill and the `Skill tool`; the
 * body is loaded by the model through that tool, never inlined here.
 */
export function attachSkillPrompt(text: string, skillName: string | undefined): string {
	if (skillName === undefined) return text;
	return (
		`Before answering, invoke the Skill tool with name "${skillName}" and use that skill's instructions for this turn.` +
		`\n\nUser request:\n${text}`
	);
}

/* -------------------------------------------------------------------------------------------
 * Dynamic per-skill shortcuts — pie: commands.rs:3061-3145.
 * ----------------------------------------------------------------------------------------- */

/** pie: commands.rs:3061-3066 (`SkillShortcut`). */
export interface SkillShortcut {
	command: string;
	source: SkillSource;
	description: string;
}

/**
 * pie: commands.rs:3068-3089 (`skill_shortcuts`). Three filters, in oracle order: drop
 * frontmatter-disabled skills, drop names that appear more than once among the *enabled* skills,
 * and drop names that collide with a registered builtin. Sorted by command string (Rust
 * `sort_by` on the `/name` form).
 */
export function skillShortcuts(skills: readonly CommandSkill[], registry: CommandRegistry): SkillShortcut[] {
	const counts = new Map<string, number>();
	for (const skill of skills) {
		if (skill.disableModelInvocation) continue;
		counts.set(skill.name, (counts.get(skill.name) ?? 0) + 1);
	}
	return skills
		.filter((skill) => !skill.disableModelInvocation)
		.filter((skill) => counts.get(skill.name) === 1)
		.filter((skill) => registry.find(skill.name) === undefined)
		.map((skill) => ({
			command: `/${skill.name}`,
			source: skill.source,
			description: previewText(skill.description, 72),
		}))
		.sort((a, b) => (a.command < b.command ? -1 : a.command > b.command ? 1 : 0));
}

/**
 * pie: commands.rs:3091-3120 (`resolve_skill_shortcut`). An empty object means "not a shortcut"
 * (name is a builtin, or no skill by that name); `{ error }` carries the oracle-verbatim message
 * for the all-disabled and ambiguous cases.
 */
export function resolveSkillShortcut(
	skills: readonly CommandSkill[],
	registry: CommandRegistry,
	name: string,
): { skill?: CommandSkill } | { error: string } {
	if (registry.find(name) !== undefined) return {};
	const matching = skills.filter((skill) => skill.name === name);
	if (matching.length === 0) return {};
	const enabled = matching.filter((skill) => !skill.disableModelInvocation);
	if (enabled.length === 1) return { skill: enabled[0] as CommandSkill };
	if (enabled.length === 0) {
		return {
			error: `skill '${name}' is disabled; run /skills enable ${name} [source] or /skills to list loaded skills`,
		};
	}
	return {
		error: `multiple enabled skills named '${name}'; use /skill ${name} after resolving the source with /skills show ${name} [source]`,
	};
}

/**
 * pie: commands.rs:3122-3145 (`run_skill_shortcut`). `undefined` means "not a shortcut — let the
 * caller fall through to the unknown-command error".
 */
export function runSkillShortcut(
	name: string,
	argv: readonly string[],
	registry: CommandRegistry,
	ctx: CommandCtx,
): CommandOutcome | undefined {
	const resolved = resolveSkillShortcut(ctx.harness.skills(), registry, name);
	if ("error" in resolved) return commandError(resolved.error);
	const skill = resolved.skill;
	if (skill === undefined) return undefined;
	emitCommandLine(`using skill: ${skill.name} (${skillSourceLabel(skill.source)})`);
	if (argv.length === 0) return { kind: "attach_skill", name: skill.name };
	return {
		kind: "run_agent_prompt",
		prompt: attachSkillPrompt(argv.join(" "), skill.name),
		errorContext: "skill command failed: ",
	};
}

/* -------------------------------------------------------------------------------------------
 * Local helpers.
 * ----------------------------------------------------------------------------------------- */

/** pie: commands.rs:708-718 (`tool_result_text`) — text blocks joined with `\n`, images dropped. */
function toolResultText(content: readonly { type: string; text?: string }[]): string {
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** `node:path`'s `isAbsolute`, inlined to keep the import list to one path helper. */
function isAbsolutePath(path: string): boolean {
	return path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path);
}
