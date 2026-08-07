/**
 * The slash-command **registry + dispatcher** — the behavioral half of oracle
 * `crates/coding-agent/src/commands.rs` (pie @0a120dfd).
 *
 * pie: commands.rs:204-271 (`Registry`), :3147-3167 (`dispatch`), :1128-1262 (the `/help`
 * renderers). The per-command `run` bodies live in three sibling modules
 * (`slash-dispatch-session.ts`, `slash-dispatch-skills.ts`, `slash-dispatch-triggers.ts`); the
 * `name`/`aliases`/`description`/`usage` metadata is NOT restated here — every row is built from
 * `slash-commands.ts`'s `PIE_BUILTIN_COMMANDS`, the already-ported data half, so registration
 * order and help text cannot drift between the two.
 *
 * TODO(port): wiring this dispatcher into the live REPL — replacing
 * `modes/interactive/interactive-mode.ts:2517-2674`'s pi-shaped `if`-chain, and switching the
 * editor's autocomplete off `BUILTIN_SLASH_COMMANDS` onto {@link registryWithBuiltins} — is NOT
 * done here and is currently unowned: it was booked under the `coding-agent/tui` manifest row
 * until 2026-08-04 reclassified that row onto oracle's line-flow renderer (`src/tui.ts`). See the
 * phase-14 note on `migration/manifest.tsv`'s `coding-agent/commands` row. Until it lands,
 * `dispatch` is reached from `test/ported/commands-e2e.test.ts` only and the REPL keeps its own
 * command surface.
 */

import { PIE_BUILTIN_COMMANDS, parseSlashCommand } from "./slash-commands.ts";
import {
	type CommandCtx,
	type CommandOutcome,
	type CommandRegistry,
	type CommandSkill,
	commandError,
	emitCommandLines,
	HANDLED,
	previewText,
	type SlashCommand,
} from "./slash-dispatch-deps.ts";
import {
	modelCatalogText,
	modelHelpSummaryLines,
	runBugReportCommand,
	runClearCommand,
	runCompactCommand,
	runCostCommand,
	runDiagCommand,
	runFindCommand,
	runGoalCommand,
	runGoalStartCommand,
	runHistoryCommand,
	runLoginCommand,
	runLogoutCommand,
	runModelCommand,
	runNameCommand,
	runQuitCommand,
	runSaveCommand,
	runSessionCommand,
	runSessionsCommand,
	runShareCommand,
	runTemplateCommand,
	runThinkingCommand,
	runUndoCommand,
	runWebConnectCommand,
	runWebDisconnectCommand,
} from "./slash-dispatch-session.ts";
import {
	resolveSkillShortcut,
	runSkillCommand,
	runSkillShortcut,
	runSkillsCommand,
	skillShortcuts,
} from "./slash-dispatch-skills.ts";
import {
	runCronCommand,
	runInboxCommand,
	runNewTriggerCommand,
	runTriggersCommand,
} from "./slash-dispatch-triggers.ts";

/* -------------------------------------------------------------------------------------------
 * Registry — pie: commands.rs:204-271.
 * ----------------------------------------------------------------------------------------- */

type CommandRun = (argv: readonly string[], ctx: CommandCtx) => Promise<CommandOutcome>;

/**
 * One entry per `Registry::with_builtins()` registration (commands.rs:215-248). Keys are the
 * canonical names in `PIE_BUILTIN_COMMANDS`; a missing key would silently degrade the command to
 * "unknown command", so {@link registryWithBuiltins} asserts completeness instead.
 */
const BUILTIN_RUNS: Readonly<Record<string, CommandRun>> = {
	// pie: commands.rs:320-325 — the trait impl is a stub; `dispatch` renders `/help` itself
	// because the handler cannot see the registry. Kept here so the row exists in the registry.
	help: async () => HANDLED,
	clear: () => runClearCommand(),
	skills: (argv, ctx) => runSkillsCommand(argv, ctx),
	skill: (argv, ctx) => runSkillCommand(argv, ctx),
	quit: () => runQuitCommand(),
	model: (argv, ctx) => runModelCommand(argv, ctx),
	thinking: (argv, ctx) => runThinkingCommand(argv, ctx),
	cost: (argv, ctx) => runCostCommand(argv, ctx),
	diag: (_argv, ctx) => runDiagCommand(ctx),
	template: (argv, ctx) => runTemplateCommand(argv, ctx),
	save: (argv, ctx) => runSaveCommand(argv, ctx),
	compact: (argv) => runCompactCommand(argv),
	undo: (_argv, ctx) => runUndoCommand(ctx),
	"bug-report": (_argv, ctx) => runBugReportCommand(ctx),
	name: (argv, ctx) => runNameCommand(argv, ctx),
	session: (argv, ctx) => runSessionCommand(argv, ctx),
	"web-connect": (argv) => runWebConnectCommand(argv),
	"web-disconnect": () => runWebDisconnectCommand(),
	sessions: (_argv, ctx) => runSessionsCommand(ctx),
	share: (argv, ctx) => runShareCommand(argv, ctx),
	login: (argv) => runLoginCommand(argv),
	logout: (argv) => runLogoutCommand(argv),
	find: (argv, ctx) => runFindCommand(argv, ctx),
	history: (argv) => runHistoryCommand(argv),
	goal: (argv, ctx) => runGoalCommand(argv, ctx),
	"goal-start": (argv, ctx) => runGoalStartCommand(argv, ctx),
	triggers: (argv, ctx) => runTriggersCommand(argv, ctx),
	"new-trigger": (argv) => runNewTriggerCommand(argv),
	cron: (argv, ctx) => runCronCommand(argv, ctx),
	inbox: (argv) => runInboxCommand(argv),
};

/** pie: commands.rs:204-265 (`struct Registry` + its inherent methods). */
export class Registry implements CommandRegistry {
	private readonly rows: SlashCommand[] = [];

	/** pie: commands.rs:250-252 (`Registry::register`). */
	register(command: SlashCommand): void {
		this.rows.push(command);
	}

	/** pie: commands.rs:254-256 (`Registry::commands`) — registration order, as `/help` renders it. */
	commands(): readonly SlashCommand[] {
		return this.rows;
	}

	/** pie: commands.rs:258-264 (`Registry::find`) — linear scan, first match wins. */
	find(name: string): SlashCommand | undefined {
		return this.rows.find((c) => c.name === name || c.aliases.includes(name));
	}
}

/**
 * pie: commands.rs:215-248 (`Registry::with_builtins`). Registration order is user-visible
 * (`general_help_text` walks the registry as-is) and is exactly `PIE_BUILTIN_COMMANDS`'s order.
 */
export function registryWithBuiltins(): Registry {
	const registry = new Registry();
	for (const meta of PIE_BUILTIN_COMMANDS) {
		const run = BUILTIN_RUNS[meta.name];
		if (run === undefined) {
			throw new Error(`slash-dispatch: no handler registered for builtin /${meta.name}`);
		}
		registry.register({
			name: meta.name,
			aliases: meta.aliases,
			description: meta.description,
			usage: meta.usage,
			run,
		});
	}
	return registry;
}

/* -------------------------------------------------------------------------------------------
 * dispatch — pie: commands.rs:3147-3167.
 * ----------------------------------------------------------------------------------------- */

/**
 * pie: commands.rs:3147-3167 (`dispatch`). Three branches, in oracle order:
 *  1. not a slash command at all -> `Error("not a slash command")`;
 *  2. `/help` -> rendered here, because the handler cannot see the registry;
 *  3. registry hit -> its `run`; registry miss -> a dynamic skill shortcut, else unknown-command.
 */
export async function dispatch(input: string, registry: Registry, ctx: CommandCtx): Promise<CommandOutcome> {
	const parsed = parseSlashCommand(input);
	if (parsed === undefined) return commandError("not a slash command");
	const { name, argv } = parsed;
	if (name === "help") {
		printHelpWithSkills(registry, argv[0], ctx.harness.skills());
		return HANDLED;
	}
	const cmd = registry.find(name);
	if (cmd === undefined) {
		return runSkillShortcut(name, argv, registry, ctx) ?? commandError(`unknown command: /${name} (try /help)`);
	}
	return cmd.run(argv, ctx);
}

/* -------------------------------------------------------------------------------------------
 * /help renderers — pie: commands.rs:1128-1262.
 * ----------------------------------------------------------------------------------------- */

/** pie: commands.rs:1132-1134 (`print_help_with_skills`). */
export function printHelpWithSkills(
	registry: Registry,
	topic: string | undefined,
	skills: readonly CommandSkill[],
): void {
	emitCommandLines(helpTextWithSkills(registry, topic, skills));
}

/** pie: commands.rs:1141-1151 (`help_text_with_skills`). */
export function helpTextWithSkills(
	registry: Registry,
	topic: string | undefined,
	skills: readonly CommandSkill[],
): string {
	const trimmed = topic?.trim();
	if (trimmed === undefined || trimmed === "") return generalHelpText(registry, skills);
	// pie: commands.rs:1145 (`trim_start_matches('/')`) strips EVERY leading slash, not just one.
	const stripped = trimmed.replace(/^\/+/, "");
	if (stripped === "models") {
		const catalog = modelCatalogText(undefined);
		return "error" in catalog ? catalog.error : catalog.text;
	}
	return commandHelpText(registry, stripped, skills);
}

/** pie: commands.rs:1153-1201 (`general_help_text`). */
export function generalHelpText(registry: Registry, skills: readonly CommandSkill[]): string {
	const lines: string[] = ["", "Commands:"];
	for (const cmd of registry.commands()) {
		const aliases = cmd.aliases.length === 0 ? "" : ` (aliases: ${cmd.aliases.join(", ")})`;
		const usage = cmd.usage === "" ? "" : ` ${cmd.usage}`;
		lines.push(`  /${cmd.name}${usage}    ${cmd.description}${aliases}`);
	}
	const shortcuts = skillShortcuts(skills, registry);
	if (shortcuts.length > 0) {
		lines.push("");
		lines.push("Skill commands:");
		for (const shortcut of shortcuts) {
			const description = shortcut.description === "" ? "" : ` — ${shortcut.description}`;
			lines.push(`  ${shortcut.command} [prompt]    use loaded skill (${shortcut.source})${description}`);
		}
	}
	lines.push("");
	lines.push("Models:");
	lines.push(...modelHelpSummaryLines());
	lines.push("");
	lines.push("Anything else is sent as a prompt to the agent.");
	lines.push("");
	return lines.join("\n");
}

/** pie: commands.rs:1203-1262 (`command_help_text`). */
export function commandHelpText(registry: Registry, topic: string, skills: readonly CommandSkill[]): string {
	const cmd = registry.find(topic);
	if (cmd === undefined) {
		// pie: commands.rs:1205 (`if let Ok(Some(skill))`) — an ambiguous/disabled shortcut (the
		// `Err` arm) falls through to the suggestion path, it does not surface its message here.
		const resolved = resolveSkillShortcut(skills, registry, topic);
		if (!("error" in resolved) && resolved.skill !== undefined) {
			const skill = resolved.skill;
			const lines = [`/${topic} [prompt]`, `  use loaded skill '${skill.name}' (${skill.source})`];
			if (skill.description !== "") lines.push(`  ${previewText(skill.description, 120)}`);
			lines.push(`  equivalent: /skill ${skill.name}`);
			return lines.join("\n");
		}
		const suggestions = [
			...registry
				.commands()
				.filter((c) => c.name.startsWith(topic) || c.aliases.includes(topic))
				.map((c) => `/${c.name}`),
			...skillShortcuts(skills, registry)
				.filter((shortcut) => shortcut.command.slice(1).startsWith(topic))
				.map((shortcut) => shortcut.command),
		].slice(0, 5);
		const suggestion =
			suggestions.length === 0
				? "Run /help to list commands or /help models for the model catalog."
				: `Did you mean ${suggestions.join(", ")}?`;
		return `unknown help topic: ${topic}\n${suggestion}`;
	}

	const usage = cmd.usage === "" ? `/${cmd.name}` : `/${cmd.name} ${cmd.usage}`;
	const lines = [usage, `  ${cmd.description}`];
	if (cmd.aliases.length > 0) {
		lines.push(`  aliases: ${cmd.aliases.map((alias) => `/${alias}`).join(", ")}`);
	}
	if (cmd.name === "help") {
		lines.push("  examples: /help model, /help /quit, /help models");
	} else {
		lines.push(`  more: /help ${cmd.name}`);
	}
	return lines.join("\n");
}
