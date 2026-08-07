/**
 * Local crontab-style scheduler.
 *
 * Port of oracle `crates/coding-agent/src/triggers/cron.rs` (pie @0a120dfd). Cron jobs are a
 * time-based source parallel to event triggers: the notification hook emits a normal runtime
 * Trigger envelope, then the cron action hook maps that accepted trigger into an
 * `InjectAndRun` parent turn (or a detached `SubAgent` turn for `stateful` loop jobs). Storage
 * intentionally contains only schedule/action text and never provider credentials.
 *
 * FF3 switchover (phase 10, `migration/reviews/agent/forward-flags.md`): this file now imports
 * `Trigger`/`NotificationHook`/`HarnessEvent`/etc. from the real `@pie/agent-core` (phase 8) and
 * `append`/`listNew` from the real `../inbox.ts` (phase 10), rather than the phase-5 stubs in
 * `./cron-deps.ts`. The real types are wire-shaped (snake_case fields, e.g. `source_label` not
 * `sourceLabel`; and some string *values* changed too, e.g. `TriggerDelivery`'s
 * `"sub_agent"`/`"inject_and_run"` not `"subAgent"`/`"injectAndRun"`) — every call site below was
 * updated to match, not just the imports. See ./cron-deps.ts for what's still a local stand-in
 * (the `AgentTool` trait-shaped family, and `HarnessCell`/`AgentHarness`/`AgentHarnessSession`)
 * and why.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	type BeforeTriggerActionContext,
	type BeforeTriggerActionHook,
	type HarnessEvent,
	type HarnessListener,
	HookError,
	type NotificationHook,
	type NotificationHookStatus,
	notificationHookStatusPending,
	type PromoteAction,
	type ToolExecutionMode,
	type Trigger,
	type TriggerAction,
	type TriggerAuthority,
	type TriggerSink,
	triggerRecordReceivedFrom,
} from "@pie/agent-core";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { append as inboxAppend } from "../inbox.ts";
import { emit } from "../logging.ts";
import {
	type AgentTool,
	AgentToolError,
	type AgentToolResult,
	type AgentToolUpdate,
	type CancellationSignal,
	type HarnessCell,
	redact,
	simpleUuid,
	type ToolDefinition,
	textBlock,
	type UserContentBlock,
} from "./cron-deps.ts";

const CRON_SUBKIND = "cron";
const TICK_SECS = 30;
const TICK_MS = TICK_SECS * 1000;
const MAX_ACTION_PREVIEW_CHARS = 120;
const MAX_ACTION_BYTES = 4096;
/** Cap on persisted loop state. */
const LOOP_STATE_MAX_CHARS = 2000;
/** At most this many `<inbox>` findings are honored per run. */
const INBOX_TAGS_PER_RUN = 16;

/* -------------------------------------------------------------------------------------------
 * CronJob — wire structure for the `<session>.cron.toml` sidecar.
 *
 * Field names equal the wire (TOML) names exactly, per RULEBOOK §2.1 — no camelCase rename.
 * Verified against migration/parity/out/oracle/S7/cron.toml (field order + omission of unset
 * optional fields matches exactly: id, schedule, action, enabled, [running_trace_id],
 * [last_due_at], [last_fired_at], [last_completed_at], [last_error], skipped_overlap_count,
 * stateful, created_at).
 * ----------------------------------------------------------------------------------------- */

export interface CronJob {
	id: string;
	/** Standard 5-field cron expression: minute hour day-of-month month day-of-week. */
	schedule: string;
	action: string;
	enabled: boolean;
	running_trace_id?: string;
	/** ISO-8601 timestamp. */
	last_due_at?: string;
	/** ISO-8601 timestamp. */
	last_fired_at?: string;
	/** ISO-8601 timestamp. */
	last_completed_at?: string;
	last_error?: string;
	skipped_overlap_count: number;
	/**
	 * Loop mode (issue #23): run in a fresh sub-agent with persistent cross-run state and the
	 * inbox output protocol instead of injecting into the parent conversation.
	 */
	stateful: boolean;
	/** ISO-8601 timestamp. */
	created_at: string;
}

export function cronJobNextRunAfter(job: CronJob, after: Date): Date | undefined {
	let expr: CronExpression;
	try {
		expr = parseCronExpression(job.schedule);
	} catch {
		return undefined;
	}
	return cronExpressionNextAfter(expr, after);
}

/* -------------------------------------------------------------------------------------------
 * Errors (§2.4: thiserror variant -> Error subclass + `code` field)
 * ----------------------------------------------------------------------------------------- */

export class CronScheduleError extends Error {
	readonly code: "wrong_field_count" | "invalid_field";
	readonly field?: string;
	readonly reason?: string;

	private constructor(message: string, code: "wrong_field_count" | "invalid_field", field?: string, reason?: string) {
		super(message);
		this.name = "CronScheduleError";
		this.code = code;
		this.field = field;
		this.reason = reason;
	}

	static wrongFieldCount(): CronScheduleError {
		return new CronScheduleError(
			"cron schedule must have 5 fields: minute hour day-of-month month day-of-week",
			"wrong_field_count",
		);
	}

	static invalidField(field: string, reason: string): CronScheduleError {
		return new CronScheduleError(`invalid cron field \`${field}\`: ${reason}`, "invalid_field", field, reason);
	}
}

export class CronStorageError extends Error {
	readonly code: "io" | "parse" | "serialize" | "schedule";

	private constructor(message: string, code: CronStorageError["code"], options?: { cause?: unknown }) {
		super(message, options);
		this.name = "CronStorageError";
		this.code = code;
	}

	static io(message: string): CronStorageError {
		return new CronStorageError(`cron storage io: ${message}`, "io");
	}

	static parse(message: string): CronStorageError {
		return new CronStorageError(`parse cron storage: ${message}`, "parse");
	}

	static serialize(message: string): CronStorageError {
		return new CronStorageError(`serialize cron storage: ${message}`, "serialize");
	}

	static schedule(err: CronScheduleError): CronStorageError {
		return new CronStorageError(err.message, "schedule", { cause: err });
	}
}

export class AddCronJobError extends Error {
	readonly code: "empty_action" | "action_too_large" | "schedule" | "storage";
	readonly maxBytes?: number;

	private constructor(
		message: string,
		code: AddCronJobError["code"],
		options?: { cause?: unknown; maxBytes?: number },
	) {
		super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
		this.name = "AddCronJobError";
		this.code = code;
		this.maxBytes = options?.maxBytes;
	}

	static emptyAction(): AddCronJobError {
		return new AddCronJobError("cron action cannot be empty", "empty_action");
	}

	static actionTooLarge(maxBytes: number): AddCronJobError {
		return new AddCronJobError(`cron action exceeds ${maxBytes} bytes`, "action_too_large", { maxBytes });
	}

	static schedule(err: CronScheduleError): AddCronJobError {
		return new AddCronJobError(err.message, "schedule", { cause: err });
	}

	static storage(err: CronStorageError): AddCronJobError {
		return new AddCronJobError(err.message, "storage", { cause: err });
	}
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * This file's best-effort catch sites that mirror an oracle `tracing::warn!(...)`-and-continue
 * (the operation stands even though the side write failed).
 *
 * Routed to the real subscriber (`logging.ts`, installed by `main.ts` at startup — phase 13 T5-a).
 * It was `console.error` while no sink existed; that is no longer acceptable now that
 * `cronHarnessListener` runs under the interactive TUI (phase 13 T2), where a stray stderr write
 * lands on top of the rendered frame.
 */
function warnCron(message: string, err: unknown): void {
	emit("warn", "pie::triggers::cron", message, { error: errorMessage(err) });
}

/* -------------------------------------------------------------------------------------------
 * CronExpression — 5-field cron parser/matcher, local-time semantics.
 * ----------------------------------------------------------------------------------------- */

// Exported for tests only (mirrors oracle's `#[cfg(test)] mod tests { use super::*; }` access to
// private items — Rust's inline test module sees these directly; the TS port's tests live in a
// separate file under test/ported/, so the equivalent access is a plain export).
export interface CronExpression {
	minutes: Set<number>;
	hours: Set<number>;
	daysOfMonth: Set<number>;
	months: Set<number>;
	daysOfWeek: Set<number>;
}

// Oracle: `raw.parse::<u32>()` (cron.rs:1049-1054,1089-1103) — Rust's unsigned integer FromStr
// accepts an optional leading `+`; `/^\d+$/` alone rejected that.
function parseNumber(field: string, raw: string, min: number, max: number): number {
	if (!/^\+?\d+$/.test(raw)) {
		throw CronScheduleError.invalidField(field, `\`${raw}\` is not a number`);
	}
	const value = Number(raw);
	if (value < min || value > max) {
		throw CronScheduleError.invalidField(field, `value ${value} outside ${min}-${max}`);
	}
	return value;
}

function parseField(field: string, min: number, max: number): Set<number> {
	const out = new Set<number>();
	for (const rawPart of field.split(",")) {
		const part = rawPart.trim();
		if (part.length === 0) {
			throw CronScheduleError.invalidField(field, "empty item");
		}

		let rangePart: string;
		let step: number;
		const slashIdx = part.indexOf("/");
		if (slashIdx >= 0) {
			rangePart = part.slice(0, slashIdx);
			const stepRaw = part.slice(slashIdx + 1);
			if (!/^\+?\d+$/.test(stepRaw)) {
				throw CronScheduleError.invalidField(field, "step must be a positive integer");
			}
			step = Number(stepRaw);
			if (step === 0) {
				throw CronScheduleError.invalidField(field, "step must be at least 1");
			}
		} else {
			rangePart = part;
			step = 1;
		}

		let start: number;
		let end: number;
		if (rangePart === "*") {
			start = min;
			end = max;
		} else {
			const dashIdx = rangePart.indexOf("-");
			if (dashIdx >= 0) {
				start = parseNumber(field, rangePart.slice(0, dashIdx), min, max);
				end = parseNumber(field, rangePart.slice(dashIdx + 1), min, max);
			} else {
				const value = parseNumber(field, rangePart, min, max);
				start = value;
				end = value;
			}
		}

		if (start > end) {
			throw CronScheduleError.invalidField(field, "range start must be <= range end");
		}
		for (let value = start; value <= end; value += step) {
			out.add(value);
		}
	}
	return out;
}

function parseDayOfWeek(field: string): Set<number> {
	const set = parseField(field, 0, 7);
	if (set.delete(7)) {
		set.add(0);
	}
	return set;
}

export function parseCronExpression(input: string): CronExpression {
	const parts = input.split(/\s+/).filter((p) => p.length > 0);
	if (parts.length !== 5) {
		throw CronScheduleError.wrongFieldCount();
	}
	return {
		minutes: parseField(parts[0], 0, 59),
		hours: parseField(parts[1], 0, 23),
		daysOfMonth: parseField(parts[2], 1, 31),
		months: parseField(parts[3], 1, 12),
		daysOfWeek: parseDayOfWeek(parts[4]),
	};
}

function cronExpressionMatches(expr: CronExpression, dt: Date): boolean {
	return (
		expr.minutes.has(dt.getMinutes()) &&
		expr.hours.has(dt.getHours()) &&
		expr.daysOfMonth.has(dt.getDate()) &&
		expr.months.has(dt.getMonth() + 1) &&
		expr.daysOfWeek.has(dt.getDay())
	);
}

const FIVE_YEARS_MS = 366 * 5 * 24 * 60 * 60 * 1000;

export function cronExpressionNextAfter(expr: CronExpression, after: Date): Date | undefined {
	let candidate = new Date(after.getTime() + 60_000);
	candidate.setSeconds(0, 0);
	const limit = after.getTime() + FIVE_YEARS_MS;
	while (candidate.getTime() <= limit) {
		if (cronExpressionMatches(expr, candidate)) return candidate;
		candidate = new Date(candidate.getTime() + 60_000);
	}
	return undefined;
}

/* -------------------------------------------------------------------------------------------
 * Storage — TOML sidecar read/write. All synchronous, per RULEBOOK §2.3's "faithful synchrony" exception
 * (2026-08-03 revision, pilot B): the oracle registry guards its jobs with `parking_lot::Mutex`
 * (cron.rs:16,72) around `std::fs::*` calls (not `tokio::fs`) — the mechanical co-occurrence
 * judgment the rule defines. CronRegistry's synchronous implementation was reviewed and
 * confirmed compliant against that line (B2-F1).
 * ----------------------------------------------------------------------------------------- */

/**
 * Wire schema for a single `[[jobs]]` table in the `<session>.cron.toml` sidecar (RULEBOOK
 * §2.1/§1: typebox is the sanctioned validation library — see core/model-registry.ts's
 * `Type.Object` + `Compile` precedent). Field names/optionality mirror the oracle `CronJob`
 * struct (cron.rs:36-60) exactly; `skipped_overlap_count`/`stateful` default after validation,
 * matching serde's `#[serde(default)]` on those two fields.
 */
const CronJobSchema = Type.Object({
	id: Type.String(),
	schedule: Type.String(),
	action: Type.String(),
	enabled: Type.Boolean(),
	running_trace_id: Type.Optional(Type.String()),
	last_due_at: Type.Optional(Type.String()),
	last_fired_at: Type.Optional(Type.String()),
	last_completed_at: Type.Optional(Type.String()),
	last_error: Type.Optional(Type.String()),
	skipped_overlap_count: Type.Optional(Type.Number()),
	stateful: Type.Optional(Type.Boolean()),
	created_at: Type.String(),
});

type CronJobWire = Static<typeof CronJobSchema>;

const validateCronJob = Compile(CronJobSchema);

function toCronJob(raw: unknown): CronJob {
	if (!validateCronJob.Check(raw)) {
		const [first] = validateCronJob.Errors(raw);
		const where = first !== undefined ? first.instancePath.replace(/^\//, "") || "root" : "root";
		const reason = first !== undefined ? first.message : "cron job entry must be a table";
		throw new Error(`invalid cron job entry at \`${where}\`: ${reason}`);
	}
	const job: CronJobWire = raw;
	return {
		id: job.id,
		schedule: job.schedule,
		action: job.action,
		enabled: job.enabled,
		running_trace_id: job.running_trace_id,
		last_due_at: job.last_due_at,
		last_fired_at: job.last_fired_at,
		last_completed_at: job.last_completed_at,
		last_error: job.last_error,
		skipped_overlap_count: job.skipped_overlap_count ?? 0,
		stateful: job.stateful ?? false,
		created_at: job.created_at,
	};
}

function readJobsFile(filePath: string): CronJob[] {
	let text: string;
	try {
		text = fs.readFileSync(filePath, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw CronStorageError.io(errorMessage(err));
	}

	let parsed: Record<string, unknown>;
	try {
		parsed = parseToml(text) as Record<string, unknown>;
	} catch (err) {
		throw CronStorageError.parse(errorMessage(err));
	}

	const rawJobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
	try {
		return rawJobs.map(toCronJob);
	} catch (err) {
		throw CronStorageError.parse(errorMessage(err));
	}
}

function writeJobsFile(filePath: string, jobs: readonly CronJob[]): void {
	const dir = path.dirname(filePath);
	try {
		fs.mkdirSync(dir, { recursive: true });
	} catch (err) {
		throw CronStorageError.io(errorMessage(err));
	}

	let text: string;
	try {
		text = stringifyToml({ jobs: jobs as unknown as Record<string, unknown>[] });
	} catch (err) {
		throw CronStorageError.serialize(errorMessage(err));
	}

	try {
		fs.writeFileSync(filePath, text, "utf8");
	} catch (err) {
		throw CronStorageError.io(errorMessage(err));
	}
}

function clearStaleRunningState(jobs: CronJob[]): boolean {
	let changed = false;
	for (const job of jobs) {
		if (job.running_trace_id !== undefined) {
			job.running_trace_id = undefined;
			job.last_error = "cleared stale running state on startup";
			changed = true;
		}
	}
	return changed;
}

function cloneCronJob(job: CronJob): CronJob {
	return { ...job };
}

function cronJobEquals(a: CronJob, b: CronJob): boolean {
	return (
		a.id === b.id &&
		a.schedule === b.schedule &&
		a.action === b.action &&
		a.enabled === b.enabled &&
		a.running_trace_id === b.running_trace_id &&
		a.last_due_at === b.last_due_at &&
		a.last_fired_at === b.last_fired_at &&
		a.last_completed_at === b.last_completed_at &&
		a.last_error === b.last_error &&
		a.skipped_overlap_count === b.skipped_overlap_count &&
		a.stateful === b.stateful &&
		a.created_at === b.created_at
	);
}

function jobsEqual(a: readonly CronJob[], b: readonly CronJob[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (!cronJobEquals(a[i], b[i])) return false;
	}
	return true;
}

/* -------------------------------------------------------------------------------------------
 * CronRegistry
 * ----------------------------------------------------------------------------------------- */

interface CronRegistryState {
	jobs: CronJob[];
	storagePath?: string;
}

export class CronRegistry {
	private state: CronRegistryState = { jobs: [], storagePath: undefined };

	loadFromPath(filePath: string): void {
		const jobs = readJobsFile(filePath);
		for (const job of jobs) {
			try {
				parseCronExpression(job.schedule);
			} catch (err) {
				if (err instanceof CronScheduleError) throw CronStorageError.schedule(err);
				throw err;
			}
		}
		if (clearStaleRunningState(jobs)) {
			writeJobsFile(filePath, jobs);
		}
		this.state = { jobs, storagePath: filePath };
	}

	storagePath(): string | undefined {
		return this.state.storagePath;
	}

	list(): CronJob[] {
		return this.state.jobs.map(cloneCronJob);
	}

	/** Convenience wrapper (non-stateful); production paths pass `stateful` via {@link addJobFull}. */
	addJob(schedule: string, action: string): CronJob {
		return this.addJobFull(schedule, action, false);
	}

	/**
	 * PORT-DIVERGENCE: B6 — `options.enabled` has no oracle counterpart.
	 *
	 * Oracle (cron.rs:138) hardcodes `enabled: true` in the `CronJob` constructor, so *every*
	 * caller of `add_job_full` produces a job that fires on the very next tick. That is fine for
	 * the human control plane (`/cron add`, which is an explicit user action) but it is the hole
	 * B6 names: the model-callable `NewCronJob` tool reaches the same constructor and therefore
	 * brings a job into effect with no human in the loop, while `SetCronJobState` refuses a
	 * model-driven enable outright (oracle cron.rs:578). Two tools, one capability, opposite rules.
	 *
	 * We keep the registry API — the layer the human `/cron add` path uses — behaving exactly as
	 * the oracle does (`enabled` defaults to true), and let the *model-facing* caller opt into a
	 * disabled creation via `options.enabled: false`. The gate lives in {@link NewCronJobTool},
	 * not here, so gating never leaks into the human path.
	 */
	addJobFull(schedule: string, action: string, stateful: boolean, options?: { readonly enabled?: boolean }): CronJob {
		const trimmedSchedule = schedule.trim();
		const trimmedAction = action.trim();
		if (trimmedAction.length === 0) {
			throw AddCronJobError.emptyAction();
		}
		if (Buffer.byteLength(trimmedAction, "utf8") > MAX_ACTION_BYTES) {
			throw AddCronJobError.actionTooLarge(MAX_ACTION_BYTES);
		}
		try {
			parseCronExpression(trimmedSchedule);
		} catch (err) {
			if (err instanceof CronScheduleError) throw AddCronJobError.schedule(err);
			throw err;
		}

		const job: CronJob = {
			id: `cron-${simpleUuid()}`,
			schedule: trimmedSchedule,
			action: trimmedAction,
			// Defaults to the oracle's unconditional `enabled: true` (cron.rs:138); only the
			// model-facing tool passes `enabled: false`. See the PORT-DIVERGENCE: B6 note above.
			enabled: options?.enabled ?? true,
			running_trace_id: undefined,
			last_due_at: undefined,
			last_fired_at: undefined,
			last_completed_at: undefined,
			last_error: undefined,
			skipped_overlap_count: 0,
			stateful,
			created_at: toIsoAutoSiZ(new Date().toISOString()),
		};
		return this.insertJob(job);
	}

	private insertJob(job: CronJob): CronJob {
		const next = [...this.state.jobs, job];
		if (this.state.storagePath !== undefined) {
			try {
				writeJobsFile(this.state.storagePath, next);
			} catch (err) {
				if (err instanceof CronStorageError) throw AddCronJobError.storage(err);
				throw err;
			}
		}
		this.state = { ...this.state, jobs: next };
		return cloneCronJob(job);
	}

	/**
	 * BUG(port): B7 — removing a job deletes it from the sidecar but never deletes the
	 * corresponding `loop-<id>.md` state file written by {@link writeLoopState} (oracle
	 * cron.rs:162 `remove_job`; docs describe `/cron remove` as deleting loop state, the code
	 * never calls anything like `fs::remove_file(loop_state_path(...))`).
	 */
	removeJob(id: string): CronJob | undefined {
		const trimmedId = id.trim();
		const pos = this.state.jobs.findIndex((job) => job.id === trimmedId);
		if (pos === -1) return undefined;
		const removed = this.state.jobs[pos];
		const next = this.state.jobs.filter((_, i) => i !== pos);
		if (this.state.storagePath !== undefined) {
			writeJobsFile(this.state.storagePath, next);
		}
		this.state = { ...this.state, jobs: next };
		return cloneCronJob(removed);
	}

	setJobEnabled(id: string, enabled: boolean): CronJob | undefined {
		const trimmedId = id.trim();
		const pos = this.state.jobs.findIndex((job) => job.id === trimmedId);
		if (pos === -1) return undefined;
		// Build the replacement entry instead of editing one in place. The in-place version was
		// survivable only by accident: its safety came from the clone on the line above, not from
		// anything the mutation itself guaranteed. Constructing the new object keeps this correct
		// even if the array ever stops being freshly cloned.
		const current = this.state.jobs[pos];
		const updated: CronJob = {
			...current,
			enabled,
			// Disabling clears the in-flight marker; enabling leaves whatever was already there.
			running_trace_id: enabled ? current.running_trace_id : undefined,
		};
		const next = this.state.jobs.map((job, i) => (i === pos ? updated : job));
		if (this.state.storagePath !== undefined) {
			writeJobsFile(this.state.storagePath, next);
		}
		this.state = { ...this.state, jobs: next };
		return cloneCronJob(updated);
	}

	/**
	 * Jobs due in `(since, now]`. Mutates matched jobs' bookkeeping fields (running_trace_id,
	 * last_due_at, last_fired_at, skipped_overlap_count, last_error) and persists only when
	 * something actually changed value-wise, so idle ticks (called every TICK_SECS for every
	 * session) don't accrete rewritten/empty sidecar files.
	 */
	dueJobs(since: Date, now: Date): Array<[CronJob, Date]> {
		const next = this.state.jobs.map(cloneCronJob);
		const due: Array<[CronJob, Date]> = [];
		for (const job of next) {
			if (!job.enabled) continue;

			let expr: CronExpression;
			try {
				expr = parseCronExpression(job.schedule);
			} catch {
				job.last_error = "invalid schedule";
				continue;
			}

			const dueAt = cronExpressionNextAfter(expr, since);
			if (dueAt === undefined) {
				job.last_error = "no next run within 5 years";
				continue;
			}
			if (dueAt.getTime() > now.getTime()) continue;

			if (job.running_trace_id !== undefined) {
				job.skipped_overlap_count += 1;
				job.last_due_at = toIsoAutoSiZ(dueAt.toISOString());
				job.last_error = "skipped: previous run still active";
				continue;
			}

			const traceId = `cron-${simpleUuid()}`;
			job.running_trace_id = traceId;
			job.last_due_at = toIsoAutoSiZ(dueAt.toISOString());
			job.last_fired_at = toIsoAutoSiZ(now.toISOString());
			job.last_error = undefined;
			due.push([cloneCronJob(job), dueAt]);
		}

		if (!jobsEqual(next, this.state.jobs)) {
			if (this.state.storagePath !== undefined) {
				try {
					writeJobsFile(this.state.storagePath, next);
				} catch {
					// Best-effort persist, matches oracle's `let _ = write_jobs_file(...)`.
				}
			}
			this.state = { ...this.state, jobs: next };
		}
		return due;
	}

	/**
	 * Job currently running under `traceId`, if any. Must be called before {@link markCompleted},
	 * which clears the trace binding.
	 */
	jobForTrace(traceId: string): CronJob | undefined {
		const job = this.state.jobs.find((j) => j.running_trace_id === traceId);
		return job !== undefined ? cloneCronJob(job) : undefined;
	}

	markCompleted(traceId: string, error: string | undefined): void {
		const pos = this.state.jobs.findIndex((job) => job.running_trace_id === traceId);
		if (pos === -1) return;
		const next = this.state.jobs.map((job, i) => (i === pos ? cloneCronJob(job) : job));
		next[pos].running_trace_id = undefined;
		next[pos].last_completed_at = toIsoAutoSiZ(new Date().toISOString());
		next[pos].last_error = error;
		if (this.state.storagePath !== undefined) {
			try {
				writeJobsFile(this.state.storagePath, next);
			} catch {
				// Best-effort persist, matches oracle's `let _ = write_jobs_file(...)`.
			}
		}
		this.state = { ...this.state, jobs: next };
	}
}

let globalRegistryInstance: CronRegistry | undefined;

export function globalCronRegistry(): CronRegistry {
	if (globalRegistryInstance === undefined) {
		globalRegistryInstance = new CronRegistry();
	}
	return globalRegistryInstance;
}

/* -------------------------------------------------------------------------------------------
 * Loop-mode (stateful) state file + `<loop-state>`/`<inbox>` output protocol.
 * ----------------------------------------------------------------------------------------- */

/**
 * `<sess>.cron.toml` + `cron-abcdef...` -> `<sess>.loop-cron-abcdef12.md` (8-char id prefix
 * after the `cron-` marker keeps names short but unambiguous in practice).
 */
export function loopStatePath(cronSidecar: string, jobId: string): string {
	const base = path.basename(cronSidecar);
	const stem = base.endsWith(".cron.toml") ? base.slice(0, -".cron.toml".length) : "session";
	const short = jobId.slice(0, 13); // "cron-" + 8 hex
	const file = `${stem}.loop-${short}.md`;
	return path.join(path.dirname(cronSidecar), file);
}

export function readLoopState(filePath: string): string | undefined {
	let text: string;
	try {
		text = fs.readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}
	const trimmed = text.trim();
	const chars = [...trimmed];
	if (chars.length > LOOP_STATE_MAX_CHARS) {
		return `${chars.slice(0, LOOP_STATE_MAX_CHARS).join("")}…`;
	}
	return trimmed;
}

export function writeLoopState(filePath: string, state: string): void {
	const trimmed = state.trim();
	const chars = [...trimmed];
	const capped = chars.length > LOOP_STATE_MAX_CHARS ? `${chars.slice(0, LOOP_STATE_MAX_CHARS).join("")}…` : trimmed;
	fs.writeFileSync(filePath, capped, "utf8");
}

/** Assemble the stateful-loop prompt: previous state, the job's action, and the output protocol. */
export function composeStatefulPrompt(action: string, state: string | undefined): string {
	return (
		`[loop-state] (your notes from the previous run of this recurring job)\n${state ?? "(first run)"}\n[/loop-state]\n\n` +
		`${action}\n\n` +
		"Output protocol (mandatory):\n" +
		"- End your reply with <loop-state>notes for the next run</loop-state> — it REPLACES the saved state; keep it under 2000 characters and make it the information your next run needs (baselines, ids already seen, watermarks).\n" +
		"- For each finding a human should act on, emit <inbox>one concise line</inbox>. No findings → no inbox tags; do not invent work.\n" +
		"- Keep everything after the last tool call short so the tags are not truncated."
	);
}

/**
 * Remove `<loop-state>`/`<inbox>` protocol blocks for display: the listener persists them;
 * UI lines should show only the human-facing remainder.
 */
export function stripLoopProtocolTags(text: string): string {
	let out = text;
	let stripped = false;
	for (const tag of ["loop-state", "inbox"]) {
		const open = `<${tag}>`;
		const close = `</${tag}>`;
		while (true) {
			const start = out.indexOf(open);
			if (start === -1) break;
			const endRel = out.slice(start).indexOf(close);
			if (endRel === -1) break;
			out = out.slice(0, start) + out.slice(start + endRel + close.length);
			stripped = true;
		}
	}
	if (!stripped) {
		// No protocol tags: leave the text untouched so multi-line summaries render as-is.
		return out;
	}
	// Collapse the blank residue the removed blocks leave behind.
	let result = "";
	let prevBlank = false;
	for (const rawLine of out.split("\n")) {
		const line = rawLine.trimEnd(); // Rust trim_end() — both are Unicode-whitespace-aware
		const blank = line.trim().length === 0;
		if (blank && prevBlank) continue;
		if (result.length > 0) result += "\n";
		result += line;
		prevBlank = blank;
	}
	return result.trim();
}

/** Last `<tag>...</tag>` block in `text`, trimmed. Unclosed tags are ignored. */
export function extractTagBlock(text: string, tag: string): string | undefined {
	const open = `<${tag}>`;
	const close = `</${tag}>`;
	const start = text.lastIndexOf(open);
	if (start === -1) return undefined;
	const rest = text.slice(start + open.length);
	const end = rest.indexOf(close);
	if (end === -1) return undefined;
	return rest.slice(0, end).trim();
}

/** Every `<tag>...</tag>` block in order, capped at `max`. */
export function extractTagAll(text: string, tag: string, max: number): string[] {
	const open = `<${tag}>`;
	const close = `</${tag}>`;
	const out: string[] = [];
	let rest = text;
	while (out.length < max) {
		const start = rest.indexOf(open);
		if (start === -1) break;
		const after = rest.slice(start + open.length);
		const end = after.indexOf(close);
		if (end === -1) break;
		const body = after.slice(0, end).trim();
		if (body.length > 0) out.push(body);
		rest = after.slice(end + close.length);
	}
	return out;
}

/* -------------------------------------------------------------------------------------------
 * Trigger action hook + harness listener.
 * ----------------------------------------------------------------------------------------- */

/** oracle `agent_harness.rs`'s `PromoteAction::None` — not exported as a constant by the real
 * `@pie/agent-core` (only the `PromoteAction` type is), so this file defines its own. */
const PROMOTE_ACTION_NONE: PromoteAction = { kind: "none" };

/**
 * Fallback action for a trigger the cron-specific mapping below doesn't recognize (unknown
 * `job_id`, or a non-cron trigger reaching this hook with no `inner` — shouldn't happen given
 * `cronActionHook`'s own `isCron` guard, but mirrored for parity). Port of oracle
 * `agent_harness.rs`'s private (non-exported) `default_trigger_action` — real `@pie/agent-core`
 * doesn't export this, so it's reimplemented here against the real snake_case `Trigger` shape.
 */
function defaultTriggerActionFor(trigger: Trigger): TriggerAction {
	return {
		prompt: `${trigger.source_label} fired: ${trigger.event_label}`,
		promote: PROMOTE_ACTION_NONE,
		promoteRequiresApproval: false,
		delivery: "sub_agent",
	};
}

export function cronActionHook(registry: CronRegistry, inner: BeforeTriggerActionHook): BeforeTriggerActionHook {
	return async (ctx: BeforeTriggerActionContext, cancel: CancellationSignal): Promise<TriggerAction> => {
		const isCron = ctx.trigger.source.kind === "local" && ctx.trigger.source.subkind === CRON_SUBKIND;
		if (!isCron) {
			return inner(ctx, cancel);
		}

		const payload = ctx.trigger.payload as Record<string, unknown> | undefined;
		const jobId = payload !== undefined && typeof payload.job_id === "string" ? payload.job_id : undefined;
		if (jobId === undefined) {
			return defaultTriggerActionFor(ctx.trigger);
		}

		const job = registry.list().find((j) => j.id === jobId);
		if (job === undefined) {
			return defaultTriggerActionFor(ctx.trigger);
		}

		if (job.stateful) {
			// Loop mode (issue #23): fresh sub-agent, state injected, findings routed to the
			// inbox by the harness listener — the main conversation is never interrupted.
			const sidecar = registry.storagePath();
			const state = sidecar !== undefined ? readLoopState(loopStatePath(sidecar, job.id)) : undefined;
			return {
				prompt: composeStatefulPrompt(job.action, state),
				promote: PROMOTE_ACTION_NONE,
				promoteRequiresApproval: false,
				delivery: "sub_agent",
			};
		}

		return {
			prompt: job.action,
			promote: PROMOTE_ACTION_NONE,
			promoteRequiresApproval: false,
			delivery: "inject_and_run",
		};
	};
}

export function cronHarnessListener(registry: CronRegistry, inboxPath: string): HarnessListener {
	return (event: HarnessEvent): void => {
		if (event.type === "trigger_completed") {
			// Resolve the job BEFORE markCompleted clears the trace binding.
			const job = registry.jobForTrace(event.traceId);
			registry.markCompleted(event.traceId, undefined);
			if (job === undefined || event.summary === undefined) return;
			if (!job.stateful) return;

			const sidecar = registry.storagePath();
			const state = extractTagBlock(event.summary, "loop-state");
			if (state !== undefined && sidecar !== undefined) {
				try {
					writeLoopState(loopStatePath(sidecar, job.id), state);
				} catch (err) {
					// Best-effort: mirrors oracle's `tracing::warn!(... "loop state write failed")`.
					// TODO(port): route to coding-agent logging unit (phase 13, manifest coding-agent/logging)
					warnCron(`loop state write failed for job ${job.id}`, err);
				}
			}

			let sessionStem = "";
			if (sidecar !== undefined) {
				const base = path.basename(sidecar);
				sessionStem = base.endsWith(".cron.toml") ? base.slice(0, -".cron.toml".length) : "";
			}
			const source = `cron:${job.id.slice(0, 13)}`;
			for (const finding of extractTagAll(event.summary, "inbox", INBOX_TAGS_PER_RUN)) {
				try {
					inboxAppend(inboxPath, source, finding, event.traceId, sessionStem);
				} catch (err) {
					// Best-effort: mirrors oracle's `tracing::warn!(... "inbox append failed")`.
					// TODO(port): route to coding-agent logging unit (phase 13, manifest coding-agent/logging)
					warnCron("inbox append failed", err);
				}
			}
			return;
		}
		if (event.type === "trigger_failed") {
			registry.markCompleted(event.traceId, event.reason);
		}
	};
}

/* -------------------------------------------------------------------------------------------
 * Notification hook — 30s tick, overlap skip, no missed-tick catch-up.
 * ----------------------------------------------------------------------------------------- */

/**
 * The tick wait. `unref()` because this timer must not, by itself, keep the process alive: oracle's
 * hook runs on a `tokio::spawn`ed task, and dropping the runtime at the end of `main` cancels it —
 * so `echo prompt | pie --tui` exits at EOF (verified against the oracle binary: exit 0). A ref'd
 * Node timer has no such owner and would pin the event loop for a further 30s after the REPL
 * returned, on every iteration, forever. Every live front-end holds its own handle (the terminal's
 * stdin, the readline interface, the web server), so unref'ing changes nothing while pie is running.
 *
 * Optionally called because a fake-timer test double may not provide `unref`.
 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms).unref?.();
	});
}

/**
 * Rust: `.to_rfc3339()` on a UTC `DateTime` renders `+00:00` (not `Z`) and uses chrono's
 * `SecondsFormat::AutoSi`: no fractional part at all on a whole second, otherwise the minimal
 * digit count that loses no precision (oracle `.to_rfc3339()` call sites: cron.rs:707,712,714,
 * 1155,1208,1240-1253). serde's default `DateTime<Utc>` `Serialize` impl (the CronJob wire
 * fields persisted to the TOML sidecar) uses the same AutoSi rule but with a `Z` suffix instead
 * of `+00:00` — {@link toIsoAutoSiZ} below covers that path.
 *
 * TODO(port): chrono AutoSi renders up to 9 ns digits; JS Date is ms-bound.
 *
 * Both helpers accept either a raw `Date#toISOString()` string (always exactly 3 fractional
 * digits) or an already-AutoSi-normalized string (no dot at all) — CronJob fields written by
 * {@link toIsoAutoSiZ} get re-read and re-formatted by {@link toRfc3339Offset} at render time
 * (see cronJobDetailsForModel), so both shapes must round-trip through both functions.
 */
function toRfc3339Offset(iso: string): string {
	if (!iso.endsWith("Z")) return iso;
	const zulu = iso.slice(0, -1);
	const dot = zulu.indexOf(".");
	if (dot === -1) return `${zulu}+00:00`;
	return zulu.slice(dot + 1) === "000" ? `${zulu.slice(0, dot)}+00:00` : `${zulu}+00:00`;
}

/** AutoSi formatting for the serde-`Z` path (CronJob's own persisted timestamp fields). */
function toIsoAutoSiZ(iso: string): string {
	if (!iso.endsWith("Z")) return iso;
	const dot = iso.lastIndexOf(".");
	if (dot === -1) return iso;
	return iso.slice(dot + 1, -1) === "000" ? `${iso.slice(0, dot)}Z` : iso;
}

export function cronTriggerForJob(job: CronJob, dueAt: Date, traceId: string): Trigger {
	const authority: TriggerAuthority = {
		principal_id: "local-cron",
		principal_label: "local cron",
		credential_scope: "None",
		allowed_source_actions: [],
		expires_at: undefined,
	};
	return {
		source: { kind: "local", subkind: CRON_SUBKIND },
		source_kind: "local",
		source_label: "Cron",
		event_label: job.id,
		payload_visibility: "local",
		payload_summary: `cron \`${job.id}\` due at ${toRfc3339Offset(dueAt.toISOString())}: ${previewRedacted(job.action, MAX_ACTION_PREVIEW_CHARS)}`,
		payload: { job_id: job.id, due_at: toRfc3339Offset(dueAt.toISOString()) },
		idempotency_key: `cron:${job.id}:${toRfc3339Offset(dueAt.toISOString())}`,
		replacement_policy: "drop",
		trace_id: traceId,
		authority,
		received_at: new Date().toISOString(),
	};
}

export class CronNotificationHook implements NotificationHook {
	private readonly registryRef: CronRegistry;
	private status_: NotificationHookStatus;
	private stopped = false;

	constructor(registry: CronRegistry) {
		this.registryRef = registry;
		this.status_ = notificationHookStatusPending();
		this.status_.subscription_labels = ["local crontab"];
	}

	label(): string {
		return "cron";
	}

	/**
	 * TODO(port): replace with real CancellationToken wiring once the phase-8 supervisor exists.
	 * `stop()` is a test-only affordance not present on the oracle's `NotificationHook` trait —
	 * JS has no ambient task-cancellation for an arbitrary infinite loop the way tokio's
	 * supervisor cancels the spawned task, so tests need an explicit way to end the loop.
	 */
	stop(): void {
		this.stopped = true;
	}

	async run(sink: TriggerSink): Promise<void> {
		this.status_.state = { kind: "connected" };
		this.status_.last_error = null;

		let lastScan = new Date();
		// tokio::time::interval(30s) + MissedTickBehavior::Skip -> injectable setTimeout loop
		// (RULEBOOK §2.2). The oracle consumes interval's immediate first tick before the loop
		// (`interval.tick().await;`) so the first real scan happens ~30s after `run` starts, not
		// immediately — mirrored below by sleeping before the first scan too. Skip semantics
		// (no missed-tick catch-up burst) have no separately observable effect here since
		// `dueJobs` windows on wall-clock timestamps rather than the timer's own schedule grid.
		while (!this.stopped) {
			await sleep(TICK_MS);
			if (this.stopped) return;

			const now = new Date();
			for (const [job, dueAt] of this.registryRef.dueJobs(lastScan, now)) {
				if (job.running_trace_id === undefined) continue;
				const trigger = cronTriggerForJob(job, dueAt, job.running_trace_id);
				const sent = sink.push(trigger);
				if (!sent) {
					this.status_.state = { kind: "disconnected", reason: "sink closed" };
					this.status_.last_error = "sink closed";
					throw HookError.sinkClosed();
				}
				this.status_.last_event_at = now.toISOString();
			}
			lastScan = now;
		}
	}

	status(): NotificationHookStatus {
		const jobs = this.registryRef.list();
		const status: NotificationHookStatus = { ...this.status_ };
		status.queued_count = jobs.filter((job) => job.running_trace_id !== undefined).length;
		status.subscription_labels =
			jobs.length === 0
				? ["local crontab: 0 jobs"]
				: [`local crontab: ${jobs.length} job(s), ${jobs.filter((job) => job.enabled).length} enabled`];
		return status;
	}
}

/* -------------------------------------------------------------------------------------------
 * Schedule normalization (aliases).
 * ----------------------------------------------------------------------------------------- */

const HOURLY_ALIASES = new Set(["hourly", "every hour", "once an hour"]);
const DAILY_ALIASES = new Set(["daily", "every day", "once a day"]);
const WEEKLY_ALIASES = new Set(["weekly", "every week", "once a week"]);

export function normalizeSchedule(input: string): string {
	const trimmed = input.trim();
	try {
		parseCronExpression(trimmed);
		return trimmed;
	} catch {
		// Fall through to alias resolution.
	}

	const normalized = trimmed.toLowerCase();
	let alias: string | undefined;
	if (HOURLY_ALIASES.has(normalized)) {
		alias = "0 * * * *";
	} else if (DAILY_ALIASES.has(normalized)) {
		alias = "0 9 * * *";
	} else if (WEEKLY_ALIASES.has(normalized)) {
		alias = "0 9 * * 1";
	} else if (trimmed.includes("每小时") || trimmed.includes("每個小時")) {
		alias = "0 * * * *";
	} else if (trimmed.includes("每天") || trimmed.includes("每日")) {
		alias = "0 9 * * *";
	} else if (trimmed.includes("每周") || trimmed.includes("每週")) {
		alias = "0 9 * * 1";
	}

	if (alias === undefined) {
		throw AgentToolError.message(
			"invalid schedule: provide a 5-field cron expression, or a supported alias such as hourly / every hour / 每小时",
		);
	}
	return alias;
}

/* -------------------------------------------------------------------------------------------
 * Control-plane audit + rendering helpers.
 * ----------------------------------------------------------------------------------------- */

export function cronControlPlaneAudit(
	op: string,
	actor: string,
	before: CronJob | undefined,
	after: CronJob | undefined,
): Record<string, unknown> {
	const job = after ?? before;
	const now = new Date();
	let nextRun: string | undefined;
	if (after?.enabled) {
		const next = cronJobNextRunAfter(after, now);
		nextRun = next !== undefined ? toRfc3339Offset(next.toISOString()) : undefined;
	}
	return {
		op,
		actor,
		job_id: job?.id,
		schedule: job?.schedule,
		action_preview: job !== undefined ? previewRedacted(job.action, MAX_ACTION_PREVIEW_CHARS) : undefined,
		before_enabled: before?.enabled,
		after_enabled: after?.enabled,
		next_run: nextRun,
		removed: before !== undefined && after === undefined,
	};
}

async function writeToolCronControlAudit(
	harness: HarnessCell | undefined,
	op: string,
	before: CronJob | undefined,
	after: CronJob | undefined,
): Promise<string | undefined> {
	const instance = harness?.get();
	if (instance === undefined) return undefined;
	const audit = cronControlPlaneAudit(op, "tool", before, after);
	try {
		return await instance.session().appendCustom("cron_control_plane", audit);
	} catch (err) {
		// Best-effort: the tool's own cron change stands even if the audit write fails; mirrors
		// oracle's `tracing::warn!(... "cron_control_plane audit write failed")`.
		// TODO(port): route to coding-agent logging unit (phase 13, manifest coding-agent/logging)
		warnCron("cron_control_plane audit write failed; tool cron change itself succeeded", err);
		return undefined;
	}
}

function renderCronJobsForTool(jobs: readonly CronJob[]): string {
	if (jobs.length === 0) {
		return "session cron jobs: none";
	}
	const now = new Date();
	const lines = [`session cron jobs: ${jobs.length}`];
	for (const job of jobs) {
		const state = job.enabled ? "enabled" : "disabled";
		lines.push(
			`- ${job.id} [${state}] schedule: ${job.schedule} action: ${previewRedacted(job.action, MAX_ACTION_PREVIEW_CHARS)}`,
		);
		if (job.enabled) {
			const next = cronJobNextRunAfter(job, now);
			if (next !== undefined) {
				lines.push(`  next_run: ${toRfc3339Offset(next.toISOString())}`);
			}
		}
		if (job.running_trace_id !== undefined) {
			lines.push(`  running_trace_id: ${job.running_trace_id}`);
		}
		if (job.last_error !== undefined) {
			lines.push(`  last_error: ${previewRedacted(job.last_error, MAX_ACTION_PREVIEW_CHARS)}`);
		}
		if (job.skipped_overlap_count > 0) {
			lines.push(`  skipped_overlap_count: ${job.skipped_overlap_count}`);
		}
	}
	return lines.join("\n");
}

function cronJobDetailsForModel(job: CronJob): Record<string, unknown> {
	const now = new Date();
	const next = job.enabled ? cronJobNextRunAfter(job, now) : undefined;
	return {
		id: job.id,
		schedule: job.schedule,
		action_preview: previewRedacted(job.action, MAX_ACTION_PREVIEW_CHARS),
		enabled: job.enabled,
		scope: "session",
		running_trace_id: job.running_trace_id,
		last_due_at: job.last_due_at !== undefined ? toRfc3339Offset(job.last_due_at) : undefined,
		last_fired_at: job.last_fired_at !== undefined ? toRfc3339Offset(job.last_fired_at) : undefined,
		last_completed_at: job.last_completed_at !== undefined ? toRfc3339Offset(job.last_completed_at) : undefined,
		last_error: job.last_error !== undefined ? previewRedacted(job.last_error, MAX_ACTION_PREVIEW_CHARS) : undefined,
		skipped_overlap_count: job.skipped_overlap_count,
		next_run: next !== undefined ? toRfc3339Offset(next.toISOString()) : undefined,
		created_at: toRfc3339Offset(job.created_at),
	};
}

function previewRedacted(input: string, maxChars: number): string {
	return preview(redact(input), maxChars);
}

function preview(input: string, maxChars: number): string {
	const chars = [...input];
	if (chars.length <= maxChars) return input;
	return `${chars.slice(0, maxChars).join("")}…`;
}

/* -------------------------------------------------------------------------------------------
 * Tool definitions (verbatim copies of the oracle's model-facing strings/schemas, except where a
 * PORT-DIVERGENCE note says otherwise).
 * ----------------------------------------------------------------------------------------- */

/**
 * PORT-DIVERGENCE: B6 — the single sentence both model-facing cron tools use for "a model may not
 * bring a cron job into effect; only an explicit human action can".
 *
 * {@link SetCronJobStateTool} throws this byte-identically to the oracle (cron.rs:578).
 * {@link NewCronJobTool} echoes the same sentence with the concrete job id substituted for
 * `<id>`, so the create path and the enable path name the same command and cannot drift apart.
 */
const MODEL_ENABLE_REQUIRES_HUMAN =
	"enabling cron jobs from model-facing tools requires user confirmation; use /cron enable <id>";

/** {@link MODEL_ENABLE_REQUIRES_HUMAN} with `<id>` resolved to a concrete job id. */
function modelEnableRequiresHumanFor(id: string): string {
	return MODEL_ENABLE_REQUIRES_HUMAN.replace("<id>", id);
}

const NEW_CRON_JOB_TOOL: ToolDefinition = {
	name: "NewCronJob",
	description:
		// PORT-DIVERGENCE: B6 — the final sentence has no oracle counterpart (oracle cron.rs:1275-1278
		// stops after "scoped to the current chat session by default."). Oracle's NewCronJob puts
		// the job live immediately, so it had nothing to declare; ours creates the job disabled and
		// the model must be told, or it will report a job as scheduled when it is not.
		"Create a session-scoped cron scheduled job. Use this when the user asks for a fixed time, recurring, scheduled, hourly, daily, weekly, crontab, 定时任务, 每小时, 每天, or similar time-based job. Do not use NewTrigger for these scheduled jobs. Cron jobs are scoped to the current chat session by default. The job is created disabled and will not run until the user enables it — when you report that the job was created, say so and give the user the /cron enable command with the job id from the tool result.",
	parameters: {
		type: "object",
		properties: {
			schedule: {
				type: "string",
				description:
					"A 5-field cron expression in local time (minute hour day-of-month month day-of-week), or a supported alias such as hourly / every hour / 每小时.",
			},
			action: {
				type: "string",
				description: "Natural-language instruction to run when the schedule is due.",
			},
			stateful: {
				type: "boolean",
				default: false,
				description:
					'Loop mode: run in a fresh sub-agent that keeps persistent notes across runs (injected each time) and routes findings to the triage inbox instead of the chat. Use for recurring watch/triage jobs like "check for new issues and report only what changed".',
			},
		},
		required: ["schedule", "action"],
		additionalProperties: false,
	},
};

const LIST_CRON_JOBS_TOOL: ToolDefinition = {
	name: "ListCronJobs",
	description:
		"List the session-scoped cron scheduled jobs. Use this when the user asks to view, list, inspect, or find scheduled jobs, cron jobs, crontab entries, 定时任务, or recurring jobs.",
	parameters: {
		type: "object",
		properties: {},
		additionalProperties: false,
	},
};

const REMOVE_CRON_JOB_TOOL: ToolDefinition = {
	name: "RemoveCronJob",
	description:
		"Preview or confirm removal of a session-scoped cron scheduled job by exact id. Use confirm=false first when the user asks to delete, remove, or clear a scheduled job, cron job, crontab entry, or 定时任务. Call confirm=true only after the user explicitly confirms removal.",
	parameters: {
		type: "object",
		properties: {
			id: {
				type: "string",
				description: "Exact cron job id, for example cron-abc123.",
			},
			confirm: {
				type: "boolean",
				description: "false to preview the removal; true only after explicit user confirmation.",
			},
		},
		required: ["id"],
		additionalProperties: false,
	},
};

const SET_CRON_JOB_STATE_TOOL: ToolDefinition = {
	name: "SetCronJobState",
	description:
		"Disable a session-scoped cron scheduled job by exact id. Model-facing enable/resume is refused until control-plane confirmation is wired; use /cron enable <id> for enabling.",
	parameters: {
		type: "object",
		properties: {
			id: {
				type: "string",
				description: "Exact cron job id, for example cron-abc123.",
			},
			enabled: {
				type: "boolean",
				description: "true to enable/resume the cron job; false to disable/pause it.",
			},
		},
		required: ["id", "enabled"],
		additionalProperties: false,
	},
};

/* -------------------------------------------------------------------------------------------
 * Tools.
 * ----------------------------------------------------------------------------------------- */

export class NewCronJobTool implements AgentTool {
	private readonly harness: HarnessCell | undefined;

	constructor(harness?: HarnessCell) {
		this.harness = harness;
	}

	definition(): ToolDefinition {
		return NEW_CRON_JOB_TOOL;
	}

	label(): string {
		return "NewCronJob";
	}

	executionMode(): ToolExecutionMode {
		return "sequential";
	}

	async execute(
		_id: string,
		params: unknown,
		_cancel: CancellationSignal,
		_onUpdate?: AgentToolUpdate,
	): Promise<AgentToolResult> {
		const p = (params ?? {}) as Record<string, unknown>;
		const scheduleRaw = typeof p.schedule === "string" ? p.schedule : undefined;
		if (scheduleRaw === undefined) throw AgentToolError.message("missing required arg: schedule");
		const schedule = normalizeSchedule(scheduleRaw);

		const action = typeof p.action === "string" ? p.action : undefined;
		if (action === undefined) throw AgentToolError.message("missing required arg: action");

		const stateful = typeof p.stateful === "boolean" ? p.stateful : false;

		let job: CronJob;
		try {
			// PORT-DIVERGENCE: B6 — oracle (cron.rs:375-420, the `add_job_full` call at :395-396) calls it straight through,
			// and since that constructor hardcodes `enabled: true` (cron.rs:138) the model puts a
			// cron job into effect on the very next tick with no human in the loop — while
			// SetCronJobState refuses a model-driven enable of an *existing* job (cron.rs:578).
			// The strict tool is the one that reflects the intended invariant, so we close the hole
			// on this side instead: a model may create a job, but only an explicit human action
			// (`/cron enable <id>`, or `/cron add`, both human control-plane entry points) can
			// bring one into effect. Creation still succeeds; it is the enabling that is gated.
			job = globalCronRegistry().addJobFull(schedule, action, stateful, { enabled: false });
		} catch (err) {
			throw AgentToolError.message(errorMessage(err));
		}

		const auditEntryId = await writeToolCronControlAudit(this.harness, "add", undefined, job);

		return {
			content: [
				textBlock(
					`created cron job ${job.id}\nschedule: ${job.schedule}\naction: ${previewRedacted(job.action, MAX_ACTION_PREVIEW_CHARS)}\nstate: disabled — the job is NOT running and will not fire until a user enables it\n${modelEnableRequiresHumanFor(job.id)}`,
				),
			],
			details: {
				id: job.id,
				schedule: job.schedule,
				action: job.action,
				enabled: job.enabled,
				stateful: job.stateful,
				scope: "session",
				audit_entry_id: auditEntryId,
			},
			terminate: undefined,
		};
	}
}

export class ListCronJobsTool implements AgentTool {
	definition(): ToolDefinition {
		return LIST_CRON_JOBS_TOOL;
	}

	label(): string {
		return "ListCronJobs";
	}

	executionMode(): ToolExecutionMode {
		return "parallel";
	}

	async execute(
		_id: string,
		_params: unknown,
		_cancel: CancellationSignal,
		_onUpdate?: AgentToolUpdate,
	): Promise<AgentToolResult> {
		const jobs = globalCronRegistry().list();
		const storagePath = globalCronRegistry().storagePath();
		return {
			content: [textBlock(renderCronJobsForTool(jobs))],
			details: {
				count: jobs.length,
				scope: "session",
				storage_path: storagePath,
				jobs: jobs.map(cronJobDetailsForModel),
			},
			terminate: undefined,
		};
	}
}

export class RemoveCronJobTool implements AgentTool {
	private readonly harness: HarnessCell | undefined;

	constructor(harness?: HarnessCell) {
		this.harness = harness;
	}

	definition(): ToolDefinition {
		return REMOVE_CRON_JOB_TOOL;
	}

	label(): string {
		return "RemoveCronJob";
	}

	executionMode(): ToolExecutionMode {
		return "sequential";
	}

	async execute(
		_id: string,
		params: unknown,
		_cancel: CancellationSignal,
		_onUpdate?: AgentToolUpdate,
	): Promise<AgentToolResult> {
		const p = (params ?? {}) as Record<string, unknown>;
		const id = typeof p.id === "string" ? p.id : undefined;
		if (id === undefined) throw AgentToolError.message("missing required arg: id");

		const job = globalCronRegistry()
			.list()
			.find((j) => j.id === id);
		if (job === undefined) throw AgentToolError.message(`no cron job with id '${id}'`);

		const confirm = typeof p.confirm === "boolean" ? p.confirm : false;
		if (!confirm) {
			return {
				content: [
					textBlock(
						`remove cron job ${job.id} requires confirmation\nschedule: ${job.schedule}\naction: ${previewRedacted(job.action, MAX_ACTION_PREVIEW_CHARS)}\ncall RemoveCronJob again with confirm=true only after the user confirms`,
					),
				],
				details: {
					id: job.id,
					removed_count: 0,
					confirmation_required: true,
					scope: "session",
					action_preview: previewRedacted(job.action, MAX_ACTION_PREVIEW_CHARS),
				},
				terminate: undefined,
			};
		}

		// See BUG(port): B7 on CronRegistry.removeJob — loop state file is never cleaned up here.
		let removed: CronJob | undefined;
		try {
			removed = globalCronRegistry().removeJob(id);
		} catch (err) {
			// Oracle cron.rs:518-520: `.remove_job(id).map_err(|e| AgentToolError::Message(e.to_string()))?`
			throw AgentToolError.message(errorMessage(err));
		}
		if (removed === undefined) throw AgentToolError.message(`no cron job with id '${id}'`);

		const auditEntryId = await writeToolCronControlAudit(this.harness, "remove", removed, undefined);
		return {
			content: [
				textBlock(
					`removed cron job ${removed.id}\nschedule: ${removed.schedule}\naction: ${previewRedacted(removed.action, MAX_ACTION_PREVIEW_CHARS)}`,
				),
			],
			details: {
				id: removed.id,
				removed_count: 1,
				scope: "session",
				audit_entry_id: auditEntryId,
			},
			terminate: undefined,
		};
	}
}

export class SetCronJobStateTool implements AgentTool {
	private readonly harness: HarnessCell | undefined;

	constructor(harness?: HarnessCell) {
		this.harness = harness;
	}

	definition(): ToolDefinition {
		return SET_CRON_JOB_STATE_TOOL;
	}

	label(): string {
		return "SetCronJobState";
	}

	executionMode(): ToolExecutionMode {
		return "sequential";
	}

	async execute(
		_id: string,
		params: unknown,
		_cancel: CancellationSignal,
		_onUpdate?: AgentToolUpdate,
	): Promise<AgentToolResult> {
		const p = (params ?? {}) as Record<string, unknown>;
		const id = typeof p.id === "string" ? p.id : undefined;
		if (id === undefined) throw AgentToolError.message("missing required arg: id");
		const enabled = typeof p.enabled === "boolean" ? p.enabled : undefined;
		if (enabled === undefined) throw AgentToolError.message("missing required arg: enabled");

		if (enabled) {
			// PORT-DIVERGENCE: B6 — *this* half is unchanged from the oracle. The refusal (oracle
			// cron.rs:578) and the tool description above (oracle cron.rs:1343) are the correct
			// half of B6's inconsistency: they already encode "only a human may bring a cron job
			// into effect". What changed is the other half — NewCronJobTool now creates jobs
			// disabled instead of live — so both model-facing paths finally obey one invariant.
			// The message text below is byte-identical to the oracle's.
			throw AgentToolError.message(MODEL_ENABLE_REQUIRES_HUMAN);
		}

		const before = globalCronRegistry()
			.list()
			.find((j) => j.id === id);
		let updated: CronJob | undefined;
		try {
			updated = globalCronRegistry().setJobEnabled(id, enabled);
		} catch (err) {
			// Oracle cron.rs:586-588: `.set_job_enabled(id, enabled).map_err(|e| AgentToolError::Message(e.to_string()))?`
			throw AgentToolError.message(errorMessage(err));
		}
		if (updated === undefined) throw AgentToolError.message(`no cron job with id '${id}'`);

		const auditEntryId = await writeToolCronControlAudit(this.harness, "disable", before, updated);
		const state = updated.enabled ? "enabled" : "disabled";
		return {
			content: [
				textBlock(
					`updated cron job ${updated.id}\nstate: ${state}\nschedule: ${updated.schedule}\naction: ${previewRedacted(updated.action, MAX_ACTION_PREVIEW_CHARS)}`,
				),
			],
			details: {
				id: updated.id,
				schedule: updated.schedule,
				enabled: updated.enabled,
				stateful: updated.stateful,
				scope: "session",
				audit_entry_id: auditEntryId,
			},
			terminate: undefined,
		};
	}
}

// Re-exported for tests / downstream consumers that want the trigger record helper without a
// separate `@pie/agent-core` import.
export { triggerRecordReceivedFrom };
export type { UserContentBlock };
