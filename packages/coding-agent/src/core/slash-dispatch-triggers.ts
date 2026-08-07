/**
 * `/triggers`, `/new-trigger`, `/cron`, `/inbox` and their renderers — the automation family of
 * oracle `crates/coding-agent/src/commands.rs` (pie @0a120dfd).
 *
 * pie: commands.rs:2164-2597 (`TriggersCommand`, `NewTriggerCommand`, `CronCommand`,
 * `InboxCommand` + `set_cron_enabled`, `write_cron_control_plane_audit`,
 * `automation_elsewhere_hint_for_ctx`) and commands.rs:2599-3059 (`render_cron_jobs`,
 * `render_triggers_status`, `set_dynamic_trigger_enabled`, `render_dynamic_trigger_rules`,
 * `render_trigger_sources`, `render_running_triggers`, the trigger-audit row collector/renderer,
 * and their field helpers).
 *
 * Both registries are the process-global singletons the tool ports already use
 * (`triggers/dynamic.ts:globalRegistry`, `triggers/cron.ts:globalCronRegistry`), so the slash
 * path and the model-facing tool path mutate exactly the same state — as in oracle.
 *
 * Two renderer-only deviations from a literal transcription, both noted at their sites:
 * `preview_cron_action` reuses `bug-report.ts`'s real `redact`, and every timestamp line
 * re-formats an already-ISO string instead of calling chrono's `to_rfc3339()` on a
 * `DateTime<Utc>` that TS never materialises.
 */

import type { HookState, NotificationHookStatus, NotificationStatusSnapshot, SessionTreeEntry } from "@pie/agent-core";
import { redact } from "../bug-report.ts";
import * as inbox from "../inbox.ts";
import { type CronJob, cronControlPlaneAudit, globalCronRegistry } from "../triggers/cron.ts";
import { type DynamicTriggerRule, dynamicTriggerPollIntervalSecs, globalRegistry } from "../triggers/dynamic.ts";
import { automationElsewhereHint } from "./session-manager.ts";
import {
	type CommandCtx,
	type CommandOutcome,
	commandError,
	emitCommandLine,
	HANDLED,
	previewText,
} from "./slash-dispatch-deps.ts";

const TRIGGERS_USAGE =
	"[status|rules|sources|enable <id>|disable <id>|remove <id>|remove --all|running|audit [N]|abort <trace_id>|abort --all]";

const CRON_USAGE = '[list|add "<5-field-cron>" <prompt>|enable <id>|disable <id>|remove <id>]';

/* -------------------------------------------------------------------------------------------
 * /triggers — pie: commands.rs:2164-2280.
 * ----------------------------------------------------------------------------------------- */

/** pie: commands.rs:2177-2279 (`TriggersCommand::run`). Bare `/triggers` defaults to `status`. */
export async function runTriggersCommand(argv: readonly string[], ctx: CommandCtx): Promise<CommandOutcome> {
	const sub = argv[0] ?? "status";
	switch (sub) {
		case "status": {
			for (const line of renderTriggersStatus(ctx.harness.notificationStatusSnapshot())) emitCommandLine(line);
			return HANDLED;
		}
		case "rules": {
			const rules = globalRegistry().list();
			for (const line of renderDynamicTriggerRules(rules, Number.POSITIVE_INFINITY)) emitCommandLine(line);
			if (rules.length === 0) {
				const hint = await automationElsewhereHintForCtx(ctx);
				if (hint !== undefined) emitCommandLine(hint);
			}
			return HANDLED;
		}
		case "remove":
		case "rm":
		case "delete": {
			const target = argv[1];
			if (target === undefined) return commandError("usage: /triggers remove <id>|--all");
			try {
				if (target === "--all") {
					const count = globalRegistry().clearRules();
					emitCommandLine(`removed ${count} dynamic trigger rule(s)`);
					return HANDLED;
				}
				const rule = globalRegistry().removeRule(target);
				if (rule === undefined) return commandError(`no dynamic trigger rule with id '${target}'`);
				emitCommandLine(`removed trigger ${rule.id}`);
				emitCommandLine(`  condition: ${rule.condition}`);
				emitCommandLine(`  action: ${rule.action}`);
				return HANDLED;
			} catch (error) {
				return commandError(errorText(error));
			}
		}
		case "enable":
		case "resume":
			return setDynamicTriggerEnabled(argv[1], true);
		case "disable":
		case "pause":
			return setDynamicTriggerEnabled(argv[1], false);
		case "sources":
		case "hooks": {
			for (const line of renderTriggerSources(ctx.harness.notificationStatusSnapshot().hooks)) emitCommandLine(line);
			return HANDLED;
		}
		case "running": {
			for (const line of renderRunningTriggers(ctx.harness.notificationStatusSnapshot().running))
				emitCommandLine(line);
			return HANDLED;
		}
		case "audit": {
			const parsed = argv[1] === undefined ? Number.NaN : Number.parseInt(argv[1], 10);
			const limit = Number.isFinite(parsed) && parsed >= 0 ? parsed : 10;
			let entries: SessionTreeEntry[];
			try {
				entries = await ctx.harness.session().getEntries();
			} catch (error) {
				return commandError(`read trigger audit: ${errorText(error)}`);
			}
			for (const line of renderTriggerAudit(collectTriggerAuditRows(entries, limit))) emitCommandLine(line);
			return HANDLED;
		}
		case "abort": {
			const target = argv[1];
			if (target === undefined) return commandError("usage: /triggers abort <trace_id>|--all");
			const snapshot = ctx.harness.notificationStatusSnapshot();
			if (target === "--all") {
				const count = snapshot.running.length;
				ctx.harness.abortAllTriggers();
				emitCommandLine(`requested abort for ${count} running trigger(s)`);
			} else {
				if (!snapshot.running.some((t) => t.traceId === target)) {
					return commandError(`no running trigger with trace_id '${target}'`);
				}
				ctx.harness.abortTrigger(target);
				emitCommandLine(`requested abort for trigger ${target}`);
			}
			return HANDLED;
		}
		default:
			return commandError(`unknown /triggers command: ${sub}. usage: /triggers ${TRIGGERS_USAGE}`);
	}
}

/** pie: commands.rs:2750-2769 (`set_dynamic_trigger_enabled`). */
function setDynamicTriggerEnabled(target: string | undefined, enabled: boolean): CommandOutcome {
	if (target === undefined) {
		return commandError(`usage: /triggers ${enabled ? "enable" : "disable"} <id>`);
	}
	try {
		const rule = globalRegistry().setRuleEnabled(target, enabled);
		if (rule === undefined) return commandError(`no dynamic trigger rule with id '${target}'`);
		emitCommandLine(`${rule.enabled ? "enabled" : "disabled"} trigger ${rule.id}`);
		emitCommandLine(`  condition: ${rule.condition}`);
		emitCommandLine(`  action: ${rule.action}`);
		if (rule.enabled && rule.fire_once) {
			emitCommandLine("  fire_once: true (will disable again after the next successful match)");
		}
		return HANDLED;
	} catch (error) {
		return commandError(errorText(error));
	}
}

/* -------------------------------------------------------------------------------------------
 * /new-trigger — pie: commands.rs:2282-2314.
 * ----------------------------------------------------------------------------------------- */

/**
 * pie: commands.rs:2298-2313 (`NewTriggerCommand::run`). Deliberately does NOT touch the rule
 * registry: the model extracts condition/action during the turn the returned prompt drives, so
 * the REPL keeps ownership of Ctrl-C.
 */
export async function runNewTriggerCommand(argv: readonly string[]): Promise<CommandOutcome> {
	const spec = argv.join(" ");
	if (spec.trim() === "") {
		return commandError("usage: /new-trigger <natural-language trigger request>");
	}
	const prompt =
		"The user asked pie to create a dynamic trigger. Extract the trigger condition and action from the request, " +
		"then call NewTrigger with structured condition and action fields. Dynamic triggers fire once by default; " +
		"set fire_once=false only when the user explicitly asks for a repeating trigger. Trigger output is shown in " +
		"the TUI and audit by default; set promote_to_chat=true only when the user explicitly asks for trigger " +
		"results to enter the main chat context or be visible to future turns. Do not require a fixed syntax. If " +
		"either the condition or action is missing, ask one concise clarification question instead of calling tools." +
		`\n\nUser request:\n${spec}`;
	return { kind: "run_agent_prompt", prompt, errorContext: "create trigger: " };
}

/* -------------------------------------------------------------------------------------------
 * /cron — pie: commands.rs:2316-2469.
 * ----------------------------------------------------------------------------------------- */

/** pie: commands.rs:2336-2409 (`CronCommand::run`). Bare `/cron` defaults to `list`. */
export async function runCronCommand(argv: readonly string[], ctx: CommandCtx): Promise<CommandOutcome> {
	const sub = argv[0] ?? "list";
	switch (sub) {
		case "list":
		case "ls":
		case "status": {
			const jobs = globalCronRegistry().list();
			for (const line of renderCronJobs(jobs)) emitCommandLine(line);
			if (jobs.length === 0) {
				const hint = await automationElsewhereHintForCtx(ctx);
				if (hint !== undefined) emitCommandLine(hint);
			}
			return HANDLED;
		}
		case "add": {
			const rest = argv.slice(1).filter((arg) => arg !== "--stateful");
			const stateful = argv.slice(1).some((arg) => arg === "--stateful");
			if (rest.length < 2) {
				return commandError('usage: /cron add [--stateful] "<minute hour dom month dow>" <prompt>');
			}
			const schedule = rest[0] as string;
			const action = rest.slice(1).join(" ");
			try {
				const job = globalCronRegistry().addJobFull(schedule, action, stateful);
				await writeCronControlPlaneAudit(ctx, "add", undefined, job);
				emitCommandLine(`added cron job ${job.id}`);
				emitCommandLine(`  schedule: ${job.schedule}`);
				if (job.stateful) emitCommandLine("  mode: stateful loop (findings go to /inbox)");
				emitCommandLine(`  action: ${previewCronAction(job.action)}`);
				return HANDLED;
			} catch (error) {
				return commandError(errorText(error));
			}
		}
		case "enable":
		case "resume":
			return setCronEnabled(ctx, argv[1], true);
		case "disable":
		case "pause":
			return setCronEnabled(ctx, argv[1], false);
		case "remove":
		case "rm":
		case "delete": {
			const id = argv[1];
			if (id === undefined) return commandError("usage: /cron remove <id>");
			try {
				const job = globalCronRegistry().removeJob(id);
				if (job === undefined) return commandError(`no cron job with id '${id}'`);
				await writeCronControlPlaneAudit(ctx, "remove", job, undefined);
				emitCommandLine(`removed cron job ${job.id}`);
				return HANDLED;
			} catch (error) {
				return commandError(errorText(error));
			}
		}
		default:
			return commandError(`unknown /cron command: ${sub}. usage: /cron ${CRON_USAGE}`);
	}
}

/** pie: commands.rs:2412-2446 (`set_cron_enabled`). */
async function setCronEnabled(ctx: CommandCtx, id: string | undefined, enabled: boolean): Promise<CommandOutcome> {
	if (id === undefined) {
		return commandError(`usage: /cron ${enabled ? "enable" : "disable"} <id>`);
	}
	const before = globalCronRegistry()
		.list()
		.find((job) => job.id === id);
	try {
		const job = globalCronRegistry().setJobEnabled(id, enabled);
		if (job === undefined) return commandError(`no cron job with id '${id}'`);
		await writeCronControlPlaneAudit(ctx, enabled ? "enable" : "disable", before, job);
		emitCommandLine(`${enabled ? "enabled" : "disabled"} cron job ${job.id}`);
		return HANDLED;
	} catch (error) {
		return commandError(errorText(error));
	}
}

/**
 * pie: commands.rs:2448-2469 (`write_cron_control_plane_audit`). Oracle logs and swallows a failed
 * audit write — the cron mutation itself already succeeded (RULEBOOK §2.4 precondition guard).
 */
async function writeCronControlPlaneAudit(
	ctx: CommandCtx,
	op: string,
	before: CronJob | undefined,
	after: CronJob | undefined,
): Promise<void> {
	const audit = cronControlPlaneAudit(op, "slash", before, after);
	try {
		await ctx.harness.session().appendCustomEntry("cron_control_plane", audit);
	} catch {
		// pie: commands.rs:2462-2467 — warn-and-continue; no wired logger in this unit.
	}
}

/**
 * pie: commands.rs:2474-2488 (`automation_elsewhere_hint_for_ctx`). Every failure resolves to "no
 * hint" (oracle short-circuits through `Option` with `.ok()?`).
 */
async function automationElsewhereHintForCtx(ctx: CommandCtx): Promise<string | undefined> {
	try {
		const metadata = (await ctx.harness.session().getStorage().getMetadata()) as { path?: string };
		return await automationElsewhereHint(ctx.cwd, metadata.path);
	} catch {
		return undefined;
	}
}

/* -------------------------------------------------------------------------------------------
 * /inbox — pie: commands.rs:2490-2619.
 * ----------------------------------------------------------------------------------------- */

/** pie: commands.rs:2503-2596 (`InboxCommand::run`). */
export async function runInboxCommand(argv: readonly string[]): Promise<CommandOutcome> {
	const path = inbox.defaultInboxPath();
	const sub = argv[0];
	try {
		switch (sub) {
			case undefined:
			case "list": {
				const entries = inbox.listNew(path);
				if (entries.length === 0) {
					emitCommandLine("inbox: empty — stateful loops (/cron add --stateful) report findings here");
					return HANDLED;
				}
				emitCommandLine(`Inbox (${entries.length} new):`);
				entries.forEach((entry, idx) => {
					const id = [...entry.id].slice(0, 12).join("");
					const created = [...entry.created_at].slice(0, 16).join("");
					emitCommandLine(`  ${idx + 1}. [${id}] ${entry.text}  (${entry.source}, ${created})`);
				});
				emitCommandLine("claim with /inbox claim <n>, dismiss with /inbox dismiss <n>");
				return HANDLED;
			}
			case "all": {
				const entries = inbox.list(path);
				emitCommandLine(`Inbox history (${entries.length} total):`);
				for (const entry of entries) emitCommandLine(`  [${entry.status}] ${entry.text}  (${entry.source})`);
				return HANDLED;
			}
			case "claim": {
				const resolved = resolveInboxTarget(path, argv[1]);
				if ("error" in resolved) return commandError(resolved.error);
				inbox.setStatus(path, resolved.entry.id, "claimed");
				return {
					kind: "run_agent_prompt",
					prompt: `A recurring loop (${resolved.entry.source}) reported this finding — investigate and address it:\n${resolved.entry.text}`,
					errorContext: "inbox claim",
				};
			}
			case "dismiss": {
				const resolved = resolveInboxTarget(path, argv[1]);
				if ("error" in resolved) return commandError(resolved.error);
				inbox.setStatus(path, resolved.entry.id, "dismissed");
				emitCommandLine(`dismissed: ${resolved.entry.text}`);
				return HANDLED;
			}
			case "clear": {
				const n = inbox.dismissAllNew(path);
				emitCommandLine(`dismissed ${n} inbox entr${n === 1 ? "y" : "ies"}`);
				return HANDLED;
			}
			default:
				return commandError(`unknown /inbox subcommand: ${sub}; usage: /inbox [all|claim <n>|dismiss <n>|clear]`);
		}
	} catch (error) {
		return commandError(`inbox: ${errorText(error)}`);
	}
}

/** pie: commands.rs:2600-2619 (`resolve_inbox_target`) — `<n>` is 1-based, or an `inb-…` prefix. */
function resolveInboxTarget(path: string, arg: string | undefined): { entry: inbox.InboxEntry } | { error: string } {
	if (arg === undefined) return { error: "usage: /inbox claim|dismiss <n or inb-id>" };
	const entries = inbox.listNew(path);
	if (/^\d+$/.test(arg)) {
		const n = Number.parseInt(arg, 10);
		// pie: commands.rs:2610 uses `n.saturating_sub(1)`, so `/inbox claim 0` targets entry #1.
		const entry = entries[Math.max(n - 1, 0)];
		if (entry === undefined) return { error: `no inbox entry #${n} (have ${entries.length})` };
		return { entry };
	}
	const entry = entries.find((candidate) => candidate.id.startsWith(arg));
	if (entry === undefined) return { error: `no new inbox entry matching '${arg}'` };
	return { entry };
}

/* -------------------------------------------------------------------------------------------
 * Renderers — pie: commands.rs:2621-2880 + 2957-3059.
 * ----------------------------------------------------------------------------------------- */

/** pie: commands.rs:2621-2649 (`render_cron_jobs`). */
export function renderCronJobs(jobs: readonly CronJob[]): string[] {
	if (jobs.length === 0) return ["Cron jobs (session): none"];
	const lines = [`Cron jobs (session, ${jobs.length}):`];
	for (const job of jobs) {
		const state = job.enabled ? "enabled" : "disabled";
		const running = job.running_trace_id === undefined ? "" : `, running ${job.running_trace_id}`;
		const stateful = job.stateful ? "  [stateful]" : "";
		lines.push(`  ${job.id}  ${state}  ${job.schedule}${stateful}${running}`);
		lines.push(`    action: ${previewCronAction(job.action)}`);
		if (job.skipped_overlap_count > 0) lines.push(`    overlap skips: ${job.skipped_overlap_count}`);
		if (job.last_error !== undefined) {
			lines.push(`    last: ${job.last_error}`);
		} else if (job.last_fired_at !== undefined) {
			lines.push(`    last fired: ${toRfc3339Offset(job.last_fired_at)}`);
		}
	}
	return lines;
}

/** pie: commands.rs:2651-2653 (`preview_cron_action`) — redact first, then truncate. */
function previewCronAction(action: string): string {
	return previewCronText(redact(action), 120);
}

/**
 * pie: commands.rs:2655-2665 (`preview_cron_text`). Unlike `preview_text` this does NOT flatten
 * newlines, and it truncates by code point.
 */
function previewCronText(input: string, maxChars: number): string {
	const chars = [...input];
	if (chars.length <= maxChars) return input;
	return `${chars.slice(0, maxChars).join("")}…`;
}

/**
 * pie: commands.rs:2667-2748 (`render_triggers_status`). Reads the process-global rule registry
 * directly, exactly as oracle does — the snapshot argument only carries hooks/runtime/running.
 */
export function renderTriggersStatus(snapshot: NotificationStatusSnapshot): string[] {
	const lines: string[] = [];
	const runtime = snapshot.runtime;
	const dynamicRules = globalRegistry().list();
	const enabledCount = dynamicRules.filter((rule) => rule.enabled).length;
	const disabledCount = Math.max(dynamicRules.length - enabledCount, 0);
	const fireOnceCount = dynamicRules.filter((rule) => rule.fire_once).length;
	const repeatCount = Math.max(dynamicRules.length - fireOnceCount, 0);
	const promoteCount = dynamicRules.filter((rule) => rule.promote_to_chat).length;
	lines.push("Trigger status:");
	lines.push(
		`  dynamic rules: ${dynamicRules.length} total, ${enabledCount} enabled, ${disabledCount} disabled ` +
			`(${fireOnceCount} fire_once, ${repeatCount} repeat, ${promoteCount} promote_to_chat)`,
	);
	const dynamicCheckerCount = snapshot.hooks.filter((hook) =>
		hook.subscription_labels.some((label) => label.includes("dynamic trigger periodic check")),
	).length;
	const notificationHookCount = Math.max(snapshot.hooks.length - dynamicCheckerCount, 0);
	lines.push(
		`  local dynamic checker: ${dynamicCheckerCount} registered, polls every ${dynamicTriggerPollIntervalSecs()}s while enabled rules exist`,
	);
	lines.push(
		`  push trigger sources: ${notificationHookCount} configured source(s) feed server-pushed events into the same trigger runtime`,
	);
	lines.push(`  storage: ${globalRegistry().storagePath() ?? "memory"}`);
	lines.push("  output: default is TUI + audit only; rules marked promote_to_chat also enter the main chat context");
	lines.push(
		`  engine: accepted=${runtime.acceptedTotal} deduped=${runtime.dedupedTotal} ` +
			`cycle_suppressed=${runtime.cycleSuppressedTotal} recent_traces=${runtime.activeTraces} ` +
			`dedup_entries=${runtime.dedupEntries} running=${snapshot.running.length}`,
	);
	const attentionCount = snapshot.hooks.filter((h) => h.requires_attention !== null).length;
	const connectedCount = snapshot.hooks.filter((h) => h.state.kind === "connected").length;
	lines.push(
		`  sources: ${snapshot.hooks.length} total, ${connectedCount} connected, ${attentionCount} require attention`,
	);
	lines.push(...renderDynamicTriggerRules(dynamicRules, 3).slice(1));
	lines.push(
		"  commands: /triggers rules | /triggers sources | /triggers disable <id> | /triggers enable <id> | /triggers remove <id> | /triggers audit",
	);
	return lines;
}

/** pie: commands.rs:2771-2809 (`render_dynamic_trigger_rules`). */
export function renderDynamicTriggerRules(rules: readonly DynamicTriggerRule[], limit: number): string[] {
	if (rules.length === 0) return ["Dynamic trigger rules: none"];
	const shown = Math.min(rules.length, limit);
	const lines = [`Dynamic trigger rules (${rules.length}):`];
	for (const rule of rules.slice(0, shown)) {
		const state = rule.enabled ? "enabled" : "disabled";
		const fireMode = rule.fire_once ? "fire_once" : "repeat";
		const outputMode = rule.promote_to_chat ? "promote_to_chat" : "audit_only";
		const firedAt = rule.fired_at === null ? "" : `, fired_at=${toRfc3339Offset(rule.fired_at)}`;
		lines.push(
			`  - ${rule.id} [${state}, ${fireMode}, ${outputMode}${firedAt}] when ` +
				`${previewText(rule.condition, 80)} -> ${previewText(rule.action, 80)}`,
		);
	}
	if (shown < rules.length) lines.push(`  ... ${rules.length - shown} more; run /triggers rules`);
	return lines;
}

/** pie: commands.rs:2811-2840 (`render_trigger_sources`). */
export function renderTriggerSources(hooks: readonly NotificationHookStatus[]): string[] {
	if (hooks.length === 0) return ["(no trigger sources registered)"];
	const lines = [`Trigger sources (${hooks.length}):`];
	hooks.forEach((hook, idx) => {
		const labels =
			hook.subscription_labels.length === 0
				? "subscriptions: none"
				: `subscriptions: ${hook.subscription_labels.join(", ")}`;
		lines.push(
			`  - source #${idx + 1}: ${renderHookState(hook.state)} queued=${hook.queued_count} ` +
				`dropped=${hook.dropped_count} deduped=${hook.deduped_count} ` +
				`last_event=${hook.last_event_at === null ? "never" : toRfc3339Offset(hook.last_event_at)}` +
				renderRequiresAttention(hook),
		);
		lines.push(`      ${labels}`);
		if (hook.last_error !== null) lines.push(`      last error: ${previewText(hook.last_error, 160)}`);
	});
	return lines;
}

/** pie: commands.rs:2842-2852 (`render_hook_state`). */
function renderHookState(state: HookState): string {
	switch (state.kind) {
		case "connected":
			return "connected";
		case "reconnecting":
			return "reconnecting";
		case "disconnected":
			return `disconnected (${previewText(state.reason, 80)})`;
		case "disabled":
			return "disabled";
		case "auth_failed":
			return `auth_failed (${previewText(state.reason, 80)})`;
	}
}

/** pie: commands.rs:2854-2859 (`render_requires_attention`). */
function renderRequiresAttention(hook: NotificationHookStatus): string {
	return hook.requires_attention === null ? "" : `  attention: ${previewText(hook.requires_attention, 120)}`;
}

/** pie: commands.rs:2861-2880 (`render_running_triggers`). */
export function renderRunningTriggers(running: NotificationStatusSnapshot["running"]): string[] {
	if (running.length === 0) return ["(no running triggers)"];
	const lines = [`Running triggers (${running.length}):`];
	for (const trigger of running) {
		lines.push(
			`  - ${trigger.traceId}  ${trigger.sourceLabel} / ${trigger.eventLabel}  since ${toRfc3339Offset(trigger.startedAt)}`,
		);
		lines.push(`      prompt: ${previewText(trigger.promptPreview, 120)}`);
	}
	return lines;
}

/* -------------------------------------------------------------------------------------------
 * Trigger audit — pie: commands.rs:2882-3051.
 * ----------------------------------------------------------------------------------------- */

/** pie: commands.rs:2882-2892 (`TriggerAuditRow`). */
export interface TriggerAuditRow {
	customType: string;
	timestamp: string;
	traceId?: string;
	state: string;
	sourceLabel?: string;
	eventLabel?: string;
	summary?: string;
	details: string[];
}

/** pie: commands.rs:2894-2901 (`collect_trigger_audit_rows`) — newest first, capped at `limit`. */
export function collectTriggerAuditRows(entries: readonly SessionTreeEntry[], limit: number): TriggerAuditRow[] {
	const rows: TriggerAuditRow[] = [];
	for (let i = entries.length - 1; i >= 0 && rows.length < limit; i -= 1) {
		const row = triggerAuditRow(entries[i] as SessionTreeEntry);
		if (row !== undefined) rows.push(row);
	}
	return rows;
}

/** pie: commands.rs:2903-2955 (`trigger_audit_row`). */
function triggerAuditRow(entry: SessionTreeEntry): TriggerAuditRow | undefined {
	if (entry.type !== "custom") return undefined;
	const customType = entry.customType;
	if (customType !== "trigger" && customType !== "trigger_result" && customType !== "trigger_promotion") {
		return undefined;
	}
	const data = entry.data;
	if (data === undefined || data === null || typeof data !== "object") return undefined;
	const record = data as Record<string, unknown>;
	let state: string;
	let summary: string | undefined;
	let details: string[];
	if (customType === "trigger") {
		state = stringField(record, "state") ?? "unknown";
		summary = stringField(record, "payload_summary");
		details = triggerDecisionDetails(record);
	} else if (customType === "trigger_result") {
		const success = record.success;
		state = success === true ? "completed" : success === false ? "failed" : "unknown";
		summary = stringField(record, "summary") ?? stringField(record, "reason");
		details = triggerResultDetails(record);
	} else {
		state = stringField(record, "state") ?? "unknown";
		const redaction = stringField(record, "redaction_status");
		summary = redaction === undefined ? undefined : `redaction_status=${redaction}`;
		details = triggerPromotionDetails(record);
	}
	return {
		customType,
		timestamp: entry.timestamp,
		traceId: stringField(record, "trace_id"),
		state,
		sourceLabel: stringField(record, "source_label"),
		eventLabel: stringField(record, "event_label"),
		summary,
		details,
	};
}

/** pie: commands.rs:2957-2978 (`render_trigger_audit`). */
export function renderTriggerAudit(rows: readonly TriggerAuditRow[]): string[] {
	if (rows.length === 0) return ["(no trigger audit entries in this session)"];
	const lines = [`Recent trigger audit (${rows.length}):`];
	for (const row of rows) {
		const trace = row.traceId ?? "unknown-trace";
		const source = row.sourceLabel ?? "-";
		const event = row.eventLabel ?? "-";
		lines.push(`  - ${row.timestamp}  ${row.customType}/${row.state}  trace=${trace}  ${source} / ${event}`);
		if (row.summary !== undefined) lines.push(`      ${previewText(row.summary, 160)}`);
		for (const detail of row.details) lines.push(`      ${detail}`);
	}
	return lines;
}

/** pie: commands.rs:2980-3016 (`trigger_decision_details`). */
function triggerDecisionDetails(data: Record<string, unknown>): string[] {
	const decision = data.evaluator_decision;
	if (decision === undefined || decision === null || typeof decision !== "object") return [];
	const record = decision as Record<string, unknown>;
	const outcome = stringField(record, "outcome");
	if (outcome === undefined) return ["decision: present"];
	const fields = [`decision: ${outcome}`];
	if (outcome === "accept") {
		const permission = stringField(record, "permission");
		if (permission !== undefined) fields.push(`permission: ${previewText(permission, 80)}`);
		const reason = stringField(record, "reason");
		if (reason !== undefined) fields.push(`reason: ${previewText(reason, 160)}`);
	} else if (outcome === "deduped") {
		const previous = stringField(record, "previous_trace_id");
		if (previous !== undefined) fields.push(`previous_trace_id: ${previewText(previous, 80)}`);
		const policy = stringField(record, "replacement_policy");
		if (policy !== undefined) fields.push(`replacement_policy: ${previewText(policy, 80)}`);
	} else if (outcome === "cycle_suppressed") {
		const hops = numberField(record, "hop_count");
		if (hops !== undefined) fields.push(`hop_count: ${hops}`);
	}
	return fields;
}

/** pie: commands.rs:3018-3027 (`trigger_result_details`). */
function triggerResultDetails(data: Record<string, unknown>): string[] {
	const fields: string[] = [];
	const branchId = stringField(data, "branch_id");
	if (branchId !== undefined) fields.push(`branch_id: ${previewText(branchId, 80)}`);
	const count = numberField(data, "message_count");
	if (count !== undefined) fields.push(`message_count: ${count}`);
	return fields;
}

/** pie: commands.rs:3029-3041 (`trigger_promotion_details`). */
function triggerPromotionDetails(data: Record<string, unknown>): string[] {
	const fields: string[] = [];
	const kind = stringField(data, "promote_kind");
	if (kind !== undefined) fields.push(`promote_kind: ${previewText(kind, 80)}`);
	const inserted = stringField(data, "inserted_entry_id");
	if (inserted !== undefined) fields.push(`inserted_entry_id: ${previewText(inserted, 80)}`);
	return fields;
}

/** pie: commands.rs:3043-3047 (`string_field`). */
function stringField(data: Record<string, unknown>, name: string): string | undefined {
	const value = data[name];
	return typeof value === "string" ? value : undefined;
}

/** pie: commands.rs:3049-3051 (`number_field`) — `as_u64`, so negatives/floats do not qualify. */
function numberField(data: Record<string, unknown>, name: string): number | undefined {
	const value = data[name];
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/* -------------------------------------------------------------------------------------------
 * Local helpers.
 * ----------------------------------------------------------------------------------------- */

/**
 * Rust `DateTime<Utc>::to_rfc3339()` renders `+00:00`, not `Z`, and elides an all-zero fractional
 * part. The persisted TS timestamps are already ISO-8601 strings (a `DateTime<Utc>` never
 * materialises on this side), so the display conversion happens here. Same rule as
 * `triggers/cron.ts`'s own private `toRfc3339Offset`, which this unit cannot import (not exported,
 * and `src/triggers/**` is outside this unit).
 * TODO(port): export the cron one and delete this copy when the two units next move together.
 */
function toRfc3339Offset(iso: string): string {
	if (!iso.endsWith("Z")) return iso;
	const zulu = iso.slice(0, -1);
	const dot = zulu.indexOf(".");
	if (dot === -1) return `${zulu}+00:00`;
	return zulu.slice(dot + 1) === "000" ? `${zulu.slice(0, dot)}+00:00` : `${zulu}+00:00`;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
