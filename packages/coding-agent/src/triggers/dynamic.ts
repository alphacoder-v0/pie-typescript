/**
 * Dynamic trigger rules created at runtime from natural-language user requests.
 *
 * Port of oracle `crates/coding-agent/src/triggers/dynamic.rs` (pie @0a120dfd). Intentionally
 * source-agnostic: a rule stores the user's condition as text and lets the trigger action agent
 * evaluate that condition against whatever event envelope arrived. Concrete sources (MCP, future
 * GitHub/webhook/local watchers) only need to emit normal runtime `Trigger`s.
 *
 * **Not a filesystem watcher.** The local `DynamicTriggerCheckHook` does not use `fs.watch` (or
 * any OS-level notification API) at all — it emits a plain periodic `Trigger` every
 * {@link dynamicTriggerPollIntervalSecs} (default 10 minutes, overridable via
 * {@link setDynamicTriggerPollIntervalSecs} / the coding-agent CLI's `--trigger-poll-secs` flag,
 * wired outside this unit), and the SUB-AGENT that then runs is the one that inspects filesystem
 * state, environment, clock time, etc. with its own tools per rule condition (see
 * {@link renderDynamicTriggerPrompt}'s prompt text). "When X happens" is therefore "every N
 * minutes, ask the model whether X is now true" — not "get notified the instant X happens".
 *
 * See ./dynamic-deps.ts for the local stand-ins this file needs for the pie Rust `AgentTool`
 * trait shape (permission_classification-capable, unlike cron.ts's narrower stand-in) — the real
 * `@pie/agent-core` trigger three-piece-set (`Trigger`/`TriggerSource`/`NotificationHook`/
 * `TriggerSink`/`HarnessEvent`/`HarnessListener`/`BeforeTriggerActionHook`/`TriggerAction`/
 * `PromoteAction`) is already ported (phase 8, manifest `agent/harness/{trigger,trigger_runtime,
 * notification_hook,agent_harness}`) and is imported directly from `@pie/agent-core`, unlike
 * cron.ts's phase-5-pilot stand-ins for those same names in cron-deps.ts.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	type BeforeTriggerActionContext,
	type BeforeTriggerActionHook,
	type CredentialScope,
	type HarnessEvent,
	type HarnessListener,
	HookError,
	type NotificationHook,
	type NotificationHookStatus,
	notificationHookStatusPending,
	type PromoteAction,
	type Trigger,
	type TriggerAction,
	type TriggerSink,
} from "@pie/agent-core";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import {
	type AgentTool,
	AgentToolError,
	type AgentToolResult,
	type AgentToolUpdate,
	type CancellationSignal,
	type PermissionClassification,
	simpleUuid,
	type ToolDefinition,
	type ToolExecutionMode,
	textBlock,
} from "./dynamic-deps.ts";

const ZH_WHEN_PREFIX = "当";
const ZH_IF_PREFIX = "如果";
const ZH_TIME_SUFFIX_LONG = "的时候";
const ZH_TIME_SUFFIX_SHORT = "时";
const ZH_EXECUTE_PREFIX = "执行";

/** oracle dynamic.rs:36 (`DEFAULT_DYNAMIC_TRIGGER_POLL_INTERVAL_SECS`). */
export const DEFAULT_DYNAMIC_TRIGGER_POLL_INTERVAL_SECS = 10 * 60;

// oracle: `static CONFIGURED_DYNAMIC_TRIGGER_POLL_INTERVAL_SECS: AtomicU64` (dynamic.rs:37-38).
// The written rule lists this row as having no sites, but this genuinely is one; the mechanical judgment
// still applies (Node is single-threaded, so a plain module-level `let` is already atomic with
// respect to every synchronous caller — no separate primitive needed).
let configuredDynamicTriggerPollIntervalSecs = DEFAULT_DYNAMIC_TRIGGER_POLL_INTERVAL_SECS;

/** oracle dynamic.rs:252-254 (`set_dynamic_trigger_poll_interval_secs`). Clamped to >= 1. */
export function setDynamicTriggerPollIntervalSecs(secs: number): void {
	configuredDynamicTriggerPollIntervalSecs = Math.max(1, secs);
}

/** oracle dynamic.rs:256-258 (`dynamic_trigger_poll_interval_secs`). */
export function dynamicTriggerPollIntervalSecs(): number {
	return configuredDynamicTriggerPollIntervalSecs;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Rust `.to_rfc3339()` on a UTC `DateTime` renders `+00:00` (not `Z`) using chrono's
 * `SecondsFormat::AutoSi`. serde's default `DateTime<Utc>` `Serialize` impl (used when a
 * `DynamicTriggerRule` is embedded whole in JSON — the storage file and a tool's `details`) uses
 * the same AutoSi rule but with a `Z` suffix instead. Same pair of helpers cron.ts carries under
 * its own name (cron.ts:913-941) — kept as a local copy rather than a shared import: RULEBOOK §4
 * reserves cross-file util sharing for the four designated concurrency primitives only, and this
 * unit is forbidden from editing cron.ts/cron-deps.ts.
 */
function toRfc3339Offset(iso: string): string {
	if (!iso.endsWith("Z")) return iso;
	const zulu = iso.slice(0, -1);
	const dot = zulu.indexOf(".");
	if (dot === -1) return `${zulu}+00:00`;
	return zulu.slice(dot + 1) === "000" ? `${zulu.slice(0, dot)}+00:00` : `${zulu}+00:00`;
}

/** AutoSi formatting for the serde-`Z` path (DynamicTriggerRule's own persisted timestamp fields). */
function toIsoAutoSiZ(iso: string): string {
	if (!iso.endsWith("Z")) return iso;
	const dot = iso.lastIndexOf(".");
	if (dot === -1) return iso;
	return iso.slice(dot + 1, -1) === "000" ? `${iso.slice(0, dot)}Z` : iso;
}

/* -------------------------------------------------------------------------------------------
 * DynamicTriggerRule — wire structure for the `<session>.triggers.json` sidecar.
 *
 * Field names equal the wire (JSON) names exactly, per RULEBOOK §2.1 — oracle's `#[derive(...,
 * Serialize, Deserialize)]` struct has no `rename_all`, so its already-snake_case Rust field
 * names ARE the wire names verbatim (same judgment as cron.ts's `CronJob`). `fired_at` is
 * `Option<DateTime<Utc>>` with `#[serde(default)]` but NO `skip_serializing_if` (dynamic.rs:48-49)
 * — absent on read defaults to `None`, but on write it is ALWAYS present, `null` when unset (not
 * omitted) — hence `string | null`, not `string | undefined`.
 * ----------------------------------------------------------------------------------------- */

export interface DynamicTriggerRule {
	id: string;
	condition: string;
	action: string;
	enabled: boolean;
	fire_once: boolean;
	/** ISO-8601 timestamp or `null`. */
	fired_at: string | null;
	promote_to_chat: boolean;
	/** ISO-8601 timestamp. */
	created_at: string;
}

function cloneRule(rule: DynamicTriggerRule): DynamicTriggerRule {
	return { ...rule };
}

/* -------------------------------------------------------------------------------------------
 * Errors (§2.4: thiserror variant -> Error subclass + `code` field, matching cron.ts's style).
 * ----------------------------------------------------------------------------------------- */

export class ParseTriggerRuleError extends Error {
	readonly code: "empty" | "missing_action" | "empty_part";

	private constructor(message: string, code: ParseTriggerRuleError["code"]) {
		super(message);
		this.name = "ParseTriggerRuleError";
		this.code = code;
	}

	static empty(): ParseTriggerRuleError {
		return new ParseTriggerRuleError("usage: /new-trigger <when condition, run action>", "empty");
	}

	static missingAction(): ParseTriggerRuleError {
		return new ParseTriggerRuleError(
			"could not split the trigger into a condition and action. In normal chat, ask pie to create the trigger so the model can extract them, or use `/new-trigger if condition, then action`.",
			"missing_action",
		);
	}

	static emptyPart(): ParseTriggerRuleError {
		return new ParseTriggerRuleError("condition and action must both be non-empty", "empty_part");
	}
}

export class DynamicTriggerStorageError extends Error {
	readonly code: "read" | "parse" | "write";

	private constructor(message: string, code: DynamicTriggerStorageError["code"]) {
		super(message);
		this.name = "DynamicTriggerStorageError";
		this.code = code;
	}

	static read(message: string): DynamicTriggerStorageError {
		return new DynamicTriggerStorageError(`read dynamic triggers: ${message}`, "read");
	}

	static parse(message: string): DynamicTriggerStorageError {
		return new DynamicTriggerStorageError(`parse dynamic triggers: ${message}`, "parse");
	}

	static write(message: string): DynamicTriggerStorageError {
		return new DynamicTriggerStorageError(`write dynamic triggers: ${message}`, "write");
	}
}

export class AddTriggerRuleError extends Error {
	readonly code: "parse" | "storage";

	private constructor(message: string, code: AddTriggerRuleError["code"], options?: { cause?: unknown }) {
		super(message, options);
		this.name = "AddTriggerRuleError";
		this.code = code;
	}

	static parse(err: ParseTriggerRuleError): AddTriggerRuleError {
		return new AddTriggerRuleError(err.message, "parse", { cause: err });
	}

	static storage(err: DynamicTriggerStorageError): AddTriggerRuleError {
		return new AddTriggerRuleError(err.message, "storage", { cause: err });
	}
}

/* -------------------------------------------------------------------------------------------
 * Storage — JSON sidecar read/write. All synchronous, matching the rule's exception for
 * the oracle registry guards its rules with `parking_lot::Mutex` (dynamic.rs:16,61) around
 * `std::fs::*` calls (not `tokio::fs`) — the mechanical co-occurrence judgment the rule defines,
 * same precedent as cron.ts's `CronRegistry` (B2-F1).
 *
 * Unlike cron's TOML sidecar, dynamic.rs uses JSON (`serde_json`) with an explicit atomic
 * write-then-rename (dynamic.rs:428-449: write to `<file>.tmp-<uuid>`, then `rename` over the
 * target) rather than a direct write — mirrored exactly below rather than simplified to a direct
 * `writeFileSync`, since a partially-written sidecar under concurrent readers is exactly what the
 * tmp+rename dance exists to prevent.
 * ----------------------------------------------------------------------------------------- */

const DynamicTriggerRuleSchema = Type.Object({
	id: Type.String(),
	condition: Type.String(),
	action: Type.String(),
	enabled: Type.Boolean(),
	fire_once: Type.Optional(Type.Boolean()),
	fired_at: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	promote_to_chat: Type.Optional(Type.Boolean()),
	created_at: Type.String(),
});

const DynamicTriggerFileSchema = Type.Object({
	version: Type.Number(),
	rules: Type.Array(DynamicTriggerRuleSchema),
});

type DynamicTriggerRuleWire = Static<typeof DynamicTriggerRuleSchema>;
type DynamicTriggerFileWire = Static<typeof DynamicTriggerFileSchema>;

const validateDynamicTriggerFile = Compile(DynamicTriggerFileSchema);

/** oracle dynamic.rs:412 (`DYNAMIC_TRIGGER_FILE_VERSION`). Write-only bookkeeping; never checked on read. */
const DYNAMIC_TRIGGER_FILE_VERSION = 1;

function toDynamicTriggerRule(raw: DynamicTriggerRuleWire): DynamicTriggerRule {
	return {
		id: raw.id,
		condition: raw.condition,
		action: raw.action,
		enabled: raw.enabled,
		fire_once: raw.fire_once ?? true,
		fired_at: raw.fired_at ?? null,
		promote_to_chat: raw.promote_to_chat ?? false,
		created_at: raw.created_at,
	};
}

// Field declaration order matches oracle's struct field order (id, condition, action, enabled,
// fire_once, fired_at, promote_to_chat, created_at) so `JSON.stringify` output ordering matches
// serde's — load-bearing for `renderDynamicTriggerPrompt`'s embedded `rules_json`.
function toWireRule(rule: DynamicTriggerRule): DynamicTriggerRuleWire {
	return {
		id: rule.id,
		condition: rule.condition,
		action: rule.action,
		enabled: rule.enabled,
		fire_once: rule.fire_once,
		fired_at: rule.fired_at,
		promote_to_chat: rule.promote_to_chat,
		created_at: rule.created_at,
	};
}

function readRulesFile(filePath: string): DynamicTriggerRule[] {
	let text: string;
	try {
		text = fs.readFileSync(filePath, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw DynamicTriggerStorageError.read(errorMessage(err));
	}
	if (text.trim().length === 0) return [];

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		throw DynamicTriggerStorageError.parse(errorMessage(err));
	}

	if (!validateDynamicTriggerFile.Check(parsed)) {
		const [first] = validateDynamicTriggerFile.Errors(parsed);
		const where = first !== undefined ? first.instancePath.replace(/^\//, "") || "root" : "root";
		const reason = first !== undefined ? first.message : "dynamic trigger file must be an object";
		throw DynamicTriggerStorageError.parse(`invalid dynamic trigger file at \`${where}\`: ${reason}`);
	}
	const file = parsed as DynamicTriggerFileWire;
	return file.rules.map(toDynamicTriggerRule);
}

function writeRulesFile(filePath: string, rules: readonly DynamicTriggerRule[]): void {
	const dir = path.dirname(filePath);
	try {
		fs.mkdirSync(dir, { recursive: true });
	} catch (err) {
		throw DynamicTriggerStorageError.write(errorMessage(err));
	}

	const file: DynamicTriggerFileWire = { version: DYNAMIC_TRIGGER_FILE_VERSION, rules: rules.map(toWireRule) };
	let text: string;
	try {
		text = JSON.stringify(file, null, 2);
	} catch (err) {
		throw DynamicTriggerStorageError.write(errorMessage(err));
	}

	const fileName = path.basename(filePath).length > 0 ? path.basename(filePath) : "dynamic-triggers.json";
	const tmp = path.join(path.dirname(filePath), `${fileName}.tmp-${simpleUuid()}`);
	try {
		fs.writeFileSync(tmp, text, "utf8");
		fs.renameSync(tmp, filePath);
	} catch (err) {
		throw DynamicTriggerStorageError.write(errorMessage(err));
	}
}

/* -------------------------------------------------------------------------------------------
 * DynamicTriggerRegistry
 * ----------------------------------------------------------------------------------------- */

interface DynamicTriggerRegistryState {
	rules: DynamicTriggerRule[];
	storagePath?: string;
}

export class DynamicTriggerRegistry {
	private state: DynamicTriggerRegistryState = { rules: [], storagePath: undefined };

	loadFromPath(filePath: string): void {
		const rules = readRulesFile(filePath);
		this.state = { rules, storagePath: filePath };
	}

	storagePath(): string | undefined {
		return this.state.storagePath;
	}

	list(): DynamicTriggerRule[] {
		return this.state.rules.map(cloneRule);
	}

	/** Convenience wrapper: `fire_once = true`, `promote_to_chat = false`. */
	addRule(condition: string, action: string): DynamicTriggerRule {
		return this.addRuleWithOptions(condition, action, true);
	}

	/** `promote_to_chat = false`; production paths pass it via {@link addRuleWithFlags}. */
	addRuleWithOptions(condition: string, action: string, fireOnce: boolean): DynamicTriggerRule {
		return this.addRuleWithFlags(condition, action, fireOnce, false);
	}

	addRuleWithFlags(condition: string, action: string, fireOnce: boolean, promoteToChat: boolean): DynamicTriggerRule {
		const trimmedCondition = condition.trim();
		const trimmedAction = action.trim();
		if (trimmedCondition.length === 0 || trimmedAction.length === 0) {
			throw AddTriggerRuleError.parse(ParseTriggerRuleError.emptyPart());
		}
		const rule: DynamicTriggerRule = {
			id: `dyn-${simpleUuid()}`,
			condition: trimmedCondition,
			action: trimmedAction,
			enabled: true,
			fire_once: fireOnce,
			fired_at: null,
			promote_to_chat: promoteToChat,
			created_at: toIsoAutoSiZ(new Date().toISOString()),
		};
		return this.insertRule(rule);
	}

	addFromSpec(spec: string): DynamicTriggerRule {
		let parsed: ParsedTriggerRule;
		try {
			parsed = parseTriggerRule(spec);
		} catch (err) {
			if (err instanceof ParseTriggerRuleError) throw AddTriggerRuleError.parse(err);
			throw err;
		}
		return this.addRule(parsed.condition, parsed.action);
	}

	private insertRule(rule: DynamicTriggerRule): DynamicTriggerRule {
		const next = [...this.state.rules, rule];
		if (this.state.storagePath !== undefined) {
			try {
				writeRulesFile(this.state.storagePath, next);
			} catch (err) {
				if (err instanceof DynamicTriggerStorageError) throw AddTriggerRuleError.storage(err);
				throw err;
			}
		}
		this.state = { ...this.state, rules: next };
		return cloneRule(rule);
	}

	removeRule(id: string): DynamicTriggerRule | undefined {
		const trimmedId = id.trim();
		const pos = this.state.rules.findIndex((rule) => rule.id === trimmedId);
		if (pos === -1) return undefined;
		const removed = this.state.rules[pos]!;
		const next = this.state.rules.filter((_, i) => i !== pos);
		if (this.state.storagePath !== undefined) {
			writeRulesFile(this.state.storagePath, next);
		}
		this.state = { ...this.state, rules: next };
		return cloneRule(removed);
	}

	setRuleEnabled(id: string, enabled: boolean): DynamicTriggerRule | undefined {
		const trimmedId = id.trim();
		const pos = this.state.rules.findIndex((rule) => rule.id === trimmedId);
		if (pos === -1) return undefined;
		const next = this.state.rules.map((rule, i) => (i === pos ? cloneRule(rule) : rule));
		next[pos]!.enabled = enabled;
		if (enabled) {
			next[pos]!.fired_at = null;
		}
		const updated = next[pos]!;
		if (this.state.storagePath !== undefined) {
			writeRulesFile(this.state.storagePath, next);
		}
		this.state = { ...this.state, rules: next };
		return cloneRule(updated);
	}

	clearRules(): number {
		const count = this.state.rules.length;
		if (count === 0) return 0;
		if (this.state.storagePath !== undefined) {
			writeRulesFile(this.state.storagePath, []);
		}
		this.state = { ...this.state, rules: [] };
		return count;
	}

	markRulesFired(ids: readonly string[]): DynamicTriggerRule[] {
		if (ids.length === 0) return [];

		const now = toIsoAutoSiZ(new Date().toISOString());
		const next = this.state.rules.map(cloneRule);
		const changed: DynamicTriggerRule[] = [];
		for (const rule of next) {
			if (!rule.fire_once || !rule.enabled || !ids.includes(rule.id)) continue;
			rule.enabled = false;
			rule.fired_at = now;
			changed.push(cloneRule(rule));
		}
		if (changed.length === 0) return [];
		if (this.state.storagePath !== undefined) {
			writeRulesFile(this.state.storagePath, next);
		}
		this.state = { ...this.state, rules: next };
		return changed;
	}
}

let globalRegistryInstance: DynamicTriggerRegistry | undefined;

/** oracle dynamic.rs:247-250 (`global_registry`). */
export function globalRegistry(): DynamicTriggerRegistry {
	if (globalRegistryInstance === undefined) {
		globalRegistryInstance = new DynamicTriggerRegistry();
	}
	return globalRegistryInstance;
}

/* -------------------------------------------------------------------------------------------
 * DynamicTriggerCheckHook — periodic "ask the LLM to check all enabled rules" notification hook.
 *
 * NOT a filesystem watcher: emits one `Trigger` per poll interval carrying only a cwd/clock/
 * rule-count summary; a downstream sub-agent (`beforeTriggerActionHook`'s
 * `render_dynamic_trigger_prompt`) does the actual condition inspection with its own tools.
 * ----------------------------------------------------------------------------------------- */

/**
 * The poll wait. `unref()` for the same reason `triggers/cron.ts`'s twin does — see that file's note:
 * oracle's hook dies with the tokio runtime at the end of `main`, so a piped `pie --tui` exits at
 * EOF (oracle binary: exit 0), while a ref'd Node timer would pin the event loop for another full
 * poll interval (600s by default) after the REPL returned.
 *
 * Optionally called because a fake-timer test double may not provide `unref`.
 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms).unref?.();
	});
}

/**
 * Best-effort substitute for chrono's `%Z` (oracle dynamic.rs:298, `now_local.format("%Y-%m-%d
 * %H:%M:%S %Z")`) via `Intl.DateTimeFormat`'s short timezone name. No parity fixture or oracle
 * test depends on this string's exact bytes (the only oracle assertion on this summary,
 * `periodic_hook_emits_check_trigger_when_rules_exist`, checks a `"1 enabled rule"` substring
 * that appears later in the format string) — chrono's own `%Z` output is itself
 * platform/tz-database-dependent, so byte-exact cross-runtime fidelity was never available here.
 */
function formatLocalTimestamp(d: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	const datePart = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
	let tz = "";
	try {
		const part = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
			.formatToParts(d)
			.find((p) => p.type === "timeZoneName");
		tz = part?.value ?? "";
	} catch {
		tz = "";
	}
	return tz.length > 0 ? `${datePart} ${tz}` : datePart;
}

export class DynamicTriggerCheckHook implements NotificationHook {
	private readonly registryRef: DynamicTriggerRegistry;
	private readonly intervalMs: number;
	private readonly status_: NotificationHookStatus;
	private stopped = false;

	/**
	 * `intervalMs` covers both oracle constructors in one: omitted (oracle
	 * `DynamicTriggerCheckHook::new`) uses the module-level configured poll interval
	 * ({@link dynamicTriggerPollIntervalSecs}); an explicit value (oracle
	 * `DynamicTriggerCheckHook::with_interval`, test-only) overrides it.
	 */
	constructor(registry: DynamicTriggerRegistry, intervalMs?: number) {
		this.registryRef = registry;
		this.intervalMs = intervalMs ?? dynamicTriggerPollIntervalSecs() * 1000;
		const status = notificationHookStatusPending();
		status.subscription_labels = ["dynamic trigger periodic check"];
		this.status_ = status;
	}

	label(): string {
		return "local:dynamic";
	}

	/**
	 * TODO(port): test-only affordance, not present on the oracle's `NotificationHook` trait —
	 * see cron.ts's `CronNotificationHook.stop()` for the identical rationale (no ambient
	 * task-cancellation for an arbitrary infinite loop the way tokio's supervisor cancels a
	 * spawned task).
	 */
	stop(): void {
		this.stopped = true;
	}

	private buildTrigger(ruleCount: number): Trigger {
		const nowUtc = new Date();
		let currentDir: string | undefined;
		try {
			currentDir = process.cwd();
		} catch {
			currentDir = undefined;
		}
		// RFC 0 §3.2.2 / RFC 1 §4.2.3: `payload_visibility = Local` means consumers see only
		// `payload_summary` — the cwd/clock/rule-count context is folded into the summary text
		// rather than `payload` for exactly that reason (oracle dynamic.rs:290-295).
		const summary =
			`Periodic dynamic trigger check at local time ${formatLocalTimestamp(nowUtc)} / UTC ${nowUtc.toISOString()} ` +
			`with ${ruleCount} enabled rule(s); cwd: ${currentDir ?? "<unknown>"}`;
		return {
			source: { kind: "local", subkind: "dynamic" },
			source_kind: "local",
			source_label: "local:dynamic",
			event_label: "dynamic periodic check",
			payload_visibility: "local",
			payload_summary: summary,
			payload: undefined,
			idempotency_key: `local:dynamic:${nowUtc.getTime()}`,
			replacement_policy: "drop",
			trace_id: randomUUID(),
			authority: {
				principal_id: "local:dynamic",
				principal_label: "dynamic trigger checker",
				credential_scope: "User" as CredentialScope,
				allowed_source_actions: [],
				expires_at: undefined,
			},
			received_at: nowUtc.toISOString(),
		};
	}

	async run(sink: TriggerSink): Promise<void> {
		this.status_.state = { kind: "connected" };
		this.status_.last_error = null;

		// oracle: no pre-loop `interval.tick().await` warm-up here (contrast cron.ts's
		// CronNotificationHook, which DOES discard tokio::time::interval's immediate first tick
		// before its own loop — cron.rs:649-653 vs dynamic.rs:337-341). tokio::time::interval's
		// first `.tick()` resolves immediately (already-elapsed), so dynamic.rs's FIRST periodic
		// check fires right when `run()` starts, not after a full poll interval; only the SECOND
		// and later checks are interval-spaced. Mirrored below by skipping the sleep on the first
		// loop pass instead of sleeping unconditionally like cron.ts does.
		let firstTick = true;
		while (!this.stopped) {
			if (firstTick) {
				firstTick = false;
			} else {
				await sleep(this.intervalMs);
				if (this.stopped) return;
			}

			const enabledCount = this.registryRef.list().filter((rule) => rule.enabled).length;
			if (enabledCount === 0) continue;

			const trigger = this.buildTrigger(enabledCount);
			const sent = sink.push(trigger);
			if (!sent) {
				this.status_.state = { kind: "disconnected", reason: "sink closed" };
				throw HookError.sinkClosed();
			}
			this.status_.last_event_at = new Date().toISOString();
			this.status_.last_error = null;
		}
	}

	status(): NotificationHookStatus {
		return { ...this.status_ };
	}
}

/* -------------------------------------------------------------------------------------------
 * `/new-trigger <spec>` natural-language parsing.
 * ----------------------------------------------------------------------------------------- */

export interface ParsedTriggerRule {
	condition: string;
	action: string;
}

// oracle dynamic.rs:458-492. Order matters: the first marker that matches (scanning this list
// top-to-bottom) wins, and Chinese markers are searched before the English ones.
const MARKERS: readonly string[] = [
	"的时候，执行",
	"的时候,执行",
	"的时候 执行",
	"的时候执行",
	"的时候，",
	"的时候,",
	"时，执行",
	"时,执行",
	"时 执行",
	"时执行",
	"时，",
	"时,",
	"，则",
	", 则",
	",则",
	" 则 ",
	"则",
	"，就",
	", 就",
	",就",
	" 就 ",
	"，执行",
	", 执行",
	",执行",
	" 执行 ",
	" then ",
	" then run ",
	" then execute ",
	", run ",
	", execute ",
	", do ",
	" run ",
	" execute ",
];

/** Rust `str::is_ascii()` — true iff every UTF-16 code unit is <= 0x7F. */
function isAsciiMarker(marker: string): boolean {
	for (let i = 0; i < marker.length; i++) {
		if (marker.charCodeAt(i) > 0x7f) return false;
	}
	return true;
}

/**
 * Repeatedly strip `suffix` from the end of `s` for as long as it matches — Rust's
 * `str::trim_end_matches` semantics (a single call removes ALL trailing occurrences, not just
 * one), unlike JS's `String.prototype.endsWith`/manual-slice idioms which strip once.
 */
function trimEndRepeated(s: string, suffix: string): string {
	let result = s;
	while (suffix.length > 0 && result.endsWith(suffix)) {
		result = result.slice(0, result.length - suffix.length);
	}
	return result;
}

function cleanCondition(raw: string): string {
	let s = raw.trim();
	// Two SEQUENTIAL (not mutually exclusive) strip_prefix checks, oracle dynamic.rs:525-530 —
	// both markers can apply in sequence: a phrase carrying two leading conjunctions has the
	// first stripped, then the second from what remains.
	if (s.startsWith(ZH_WHEN_PREFIX)) {
		s = s.slice(ZH_WHEN_PREFIX.length).trim();
	}
	if (s.startsWith(ZH_IF_PREFIX)) {
		s = s.slice(ZH_IF_PREFIX.length).trim();
	}
	const lower = s.toLowerCase();
	if (lower.startsWith("when ")) {
		s = s.slice(5).trim();
	} else if (lower.startsWith("if ")) {
		s = s.slice(3).trim();
	}
	s = trimEndRepeated(s, ZH_TIME_SUFFIX_LONG);
	s = trimEndRepeated(s, ZH_TIME_SUFFIX_SHORT);
	return s.trim();
}

function cleanAction(raw: string): string {
	let s = raw.trim();
	if (s.startsWith(ZH_EXECUTE_PREFIX)) {
		s = s.slice(ZH_EXECUTE_PREFIX.length).trim();
	}
	const lower = s.toLowerCase();
	if (lower.startsWith("run ")) {
		s = s.slice(4).trim();
	} else if (lower.startsWith("execute ")) {
		s = s.slice(8).trim();
	}
	return s;
}

/** oracle dynamic.rs:452-521 (`parse_trigger_rule`). */
export function parseTriggerRule(spec: string): ParsedTriggerRule {
	const trimmedSpec = spec.trim();
	if (trimmedSpec.length === 0) {
		throw ParseTriggerRuleError.empty();
	}

	const lower = trimmedSpec.toLowerCase();
	let split: { idx: number; marker: string } | undefined;
	for (const marker of MARKERS) {
		const haystack = isAsciiMarker(marker) ? lower : trimmedSpec;
		const idx = haystack.indexOf(marker);
		if (idx !== -1) {
			split = { idx, marker };
			break;
		}
	}

	if (split === undefined) {
		throw ParseTriggerRuleError.missingAction();
	}

	const rawCondition = trimmedSpec.slice(0, split.idx).trim();
	const rawAction = trimmedSpec.slice(split.idx + split.marker.length).trim();
	const condition = cleanCondition(rawCondition);
	const action = cleanAction(rawAction);
	if (condition.length === 0 || action.length === 0) {
		throw ParseTriggerRuleError.emptyPart();
	}

	return { condition, action };
}

/* -------------------------------------------------------------------------------------------
 * Trigger action hooks + harness listener.
 * ----------------------------------------------------------------------------------------- */

/**
 * pie: agent_harness.rs:481-488 (`TriggerAction::default_for`). Not exported from
 * `@pie/agent-core` — agent-harness.ts's own `defaultTriggerAction` is module-private — so this
 * unit carries an identical local copy for `beforeTriggerActionHook`'s no-enabled-rules fallback.
 */
function defaultTriggerActionFor(trigger: Trigger): TriggerAction {
	return {
		prompt: `${trigger.source_label} fired: ${trigger.event_label}`,
		promote: { kind: "none" },
		promoteRequiresApproval: false,
		delivery: "sub_agent",
	};
}

/** oracle dynamic.rs:557-595 (`before_trigger_action_hook`). */
export function beforeTriggerActionHook(registry: DynamicTriggerRegistry): BeforeTriggerActionHook {
	return async (ctx: BeforeTriggerActionContext, _signal: AbortSignal): Promise<TriggerAction> => {
		const enabled = registry.list().filter((rule) => rule.enabled);
		if (enabled.length === 0) {
			return defaultTriggerActionFor(ctx.trigger);
		}
		const promoteRuleIds = enabled.filter((rule) => rule.promote_to_chat).map((rule) => rule.id);

		let promote: PromoteAction;
		if (promoteRuleIds.length === 0) {
			promote = { kind: "none" };
		} else {
			// Transitional: still uses the deprecated summary-substring path (oracle
			// dynamic.rs:578-587, `#[allow(deprecated)] PromoteAction::PromoteSummaryWhenSummaryContains`).
			// Tools-MCP's follow-up PR migrates this to
			// `PromoteAction::PromoteSummaryWhenResultDetailsMatch` once the
			// `mark_dynamic_rule_matched` tool is wired into the sub-agent. Allowed locally until
			// then — see the `PromoteAction` type doc in packages/agent/src/harness/agent-harness.ts
			// for why the deprecated variant was added there specifically for this call site.
			promote = { kind: "promote_summary_when_summary_contains", requiredSubstrings: promoteRuleIds };
		}

		return {
			prompt: renderDynamicTriggerPrompt(ctx.trigger, enabled),
			promote,
			promoteRequiresApproval: false,
			delivery: "sub_agent",
		};
	};
}

/**
 * oracle dynamic.rs:597-670 (`direct_inject_action_hook`). Wraps a `before_trigger_action` hook so
 * triggers from configured MCP servers bypass the sub-agent:
 * - `injectSummaryServers` -> `"inject_summary"`: the pushed `payload_summary` is injected into
 *   the parent chat verbatim. No model call.
 * - `injectAndRunServers` -> `"inject_and_run"`: the summary is injected into the parent chat AND
 *   one model turn runs in the parent's full context. `inject_and_run` wins if a server is in
 *   both sets.
 * Every other trigger falls through to `inner` (the dynamic-rule sub-agent path) unchanged.
 */
export function directInjectActionHook(
	injectSummaryServers: ReadonlySet<string>,
	injectAndRunServers: ReadonlySet<string>,
	inner: BeforeTriggerActionHook,
): BeforeTriggerActionHook {
	return async (ctx: BeforeTriggerActionContext, signal: AbortSignal): Promise<TriggerAction> => {
		const server = ctx.trigger.source.kind === "mcp" ? ctx.trigger.source.server_name : undefined;
		const run = server !== undefined && injectAndRunServers.has(server);
		const summaryOnly = !run && server !== undefined && injectSummaryServers.has(server);

		if (run) {
			const prompt = ctx.trigger.payload_summary ?? `${ctx.trigger.source_label} fired: ${ctx.trigger.event_label}`;
			return {
				prompt,
				promote: { kind: "none" },
				promoteRequiresApproval: false,
				delivery: "inject_and_run",
			};
		}
		if (summaryOnly) {
			const hasSummary = ctx.trigger.payload_summary !== null;
			return {
				prompt: "",
				promote: hasSummary
					? { kind: "promote_summary_now", templateBody: "{{trigger.payload_summary}}" }
					: { kind: "none" },
				promoteRequiresApproval: false,
				delivery: "inject_summary",
			};
		}
		return inner(ctx, signal);
	};
}

/** oracle dynamic.rs:672-684 (`fire_once_harness_listener`). */
export function fireOnceHarnessListener(registry: DynamicTriggerRegistry): HarnessListener {
	return (event: HarnessEvent): void => {
		if (event.type !== "trigger_completed" || event.summary === undefined) return;
		const ids = extractDynamicRuleIds(event.summary);
		try {
			registry.markRulesFired(ids);
		} catch {
			// oracle: `let _ = registry.mark_rules_fired(&ids);` — result explicitly discarded.
		}
	};
}

function safeJsonStringifyPretty(value: unknown): string | undefined {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return undefined;
	}
}

/** oracle dynamic.rs:686-721 (`render_dynamic_trigger_prompt`). */
function renderDynamicTriggerPrompt(trigger: Trigger, rules: readonly DynamicTriggerRule[]): string {
	const rulesJson = safeJsonStringifyPretty(rules.map(toWireRule)) ?? "[]";
	// RFC 0 §3.2.2 / RFC 1 §4.2.3 privacy contract: the full `payload` only reaches a consumer
	// when `payload_visibility = Shared`. For `Local` (default) and `Redacted` sources only the
	// safe summary is surfaced; `payload` renders as `null` either way (present, not omitted —
	// see the `"payload"` key handling below).
	const payloadForPrompt: unknown = trigger.payload_visibility === "shared" ? (trigger.payload ?? null) : null;
	const triggerJsonObj = {
		source_kind: trigger.source_kind,
		source: trigger.source,
		source_label: trigger.source_label,
		event_label: trigger.event_label,
		payload_visibility: trigger.payload_visibility,
		payload_summary: trigger.payload_summary,
		// Explicit `null` (never `undefined`): `JSON.stringify` DROPS `undefined`-valued keys, but
		// oracle's `serde_json::json!({"payload": payload_for_prompt})` always emits the key
		// (`Option<Value>::None` -> `null`) — dropped here would fail the ported
		// `action_hook_wraps_event_and_rules_for_agent_evaluation` test's
		// `prompt.contains("\"payload\"")` assertion.
		payload: payloadForPrompt,
		received_at: trigger.received_at,
		idempotency_key: trigger.idempotency_key,
		trace_id: trigger.trace_id,
		authority: {
			principal_id: trigger.authority.principal_id,
			principal_label: trigger.authority.principal_label,
			credential_scope: trigger.authority.credential_scope,
		},
	};
	const triggerJson = safeJsonStringifyPretty(triggerJsonObj) ?? "{}";
	return (
		"A trigger check event arrived.\n\n" +
		`Event:\n${triggerJson}\n\n` +
		`Dynamic trigger rules:\n${rulesJson}\n\n` +
		"Evaluate each rule's natural-language condition. For source-specific events, compare the rule against the event. For `local:dynamic` periodic checks, inspect current local or remote state with the available tools whenever the condition depends on filesystem state, paths, environment variables, shell expansion, command output, clock time, network/API state, or any fact not already present in the Event JSON. Do not report no match for those conditions until after the needed inspection. If no enabled rule matches after any required inspection, reply with exactly: no dynamic trigger rule matched.\n\n" +
		"If one or more rules match, execute each matching rule's action. Treat the action as an instruction from the user. If it asks to read or print a file, use the read tool or a safe shell command, then include the requested file contents in your final response. If it asks to run a local program or shell command, use the bash tool. Keep the final response concise and include the exact matched rule id(s), for example `matched dyn-...`."
	);
}

/** Rust `u8::is_ascii_hexdigit` — `0-9`, `A-F`, `a-f`. */
function isAsciiHexDigit(code: number): boolean {
	return (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
}

/**
 * oracle dynamic.rs:723-746 (`extract_dynamic_rule_ids`). Scans for `dyn-` followed by exactly 32
 * ASCII hex digits (matching {@link simpleUuid}'s output format), deduping while preserving first-
 * seen order.
 */
export function extractDynamicRuleIds(text: string): string[] {
	const ids: string[] = [];
	let i = 0;
	while (i + 4 <= text.length) {
		if (text.slice(i, i + 4) !== "dyn-") {
			i += 1;
			continue;
		}
		const start = i;
		i += 4;
		while (i < text.length && isAsciiHexDigit(text.charCodeAt(i))) {
			i += 1;
		}
		if (i - start === 36) {
			const id = text.slice(start, i);
			if (!ids.includes(id)) {
				ids.push(id);
			}
		}
	}
	return ids;
}

/* -------------------------------------------------------------------------------------------
 * Tools (verbatim copies of the oracle's model-facing strings/schemas).
 * ----------------------------------------------------------------------------------------- */

const NEW_TRIGGER_TOOL: ToolDefinition = {
	name: "NewTrigger",
	description:
		"Create an event/condition-based dynamic trigger rule. Use this for future events such as a browser tab, file, MCP notification, webhook, or other condition becoming true. Do not use this for fixed time, recurring, scheduled, hourly, daily, weekly, cron, crontab, 定时任务, 每小时, or similar time-based jobs; use NewCronJob instead.",
	parameters: {
		type: "object",
		properties: {
			condition: {
				type: "string",
				description: "The natural-language condition that should be evaluated against future trigger events.",
			},
			action: {
				type: "string",
				description:
					"The action to perform when the condition matches. This may be a shell command or a natural-language instruction.",
			},
			spec: {
				type: "string",
				description: "Fallback complete trigger rule text when condition and action cannot be supplied separately.",
			},
			fire_once: {
				type: "boolean",
				description:
					"Whether to disable the rule after the first successful match. Defaults to true unless the user explicitly asks for a repeating trigger.",
			},
			promote_to_chat: {
				type: "boolean",
				description:
					"Whether successful trigger output should be inserted into the parent chat context so future turns can see it. Defaults to false unless the user explicitly asks for that behavior.",
			},
		},
		required: ["condition", "action"],
		additionalProperties: false,
	},
};

const LIST_TRIGGERS_TOOL: ToolDefinition = {
	name: "ListTriggers",
	description:
		"List dynamic trigger rules currently registered in pie. Use this when the user asks to view, list, show, inspect, or find trigger ids.",
	parameters: {
		type: "object",
		properties: {},
		additionalProperties: false,
	},
};

const REMOVE_TRIGGER_TOOL: ToolDefinition = {
	name: "RemoveTrigger",
	description:
		"Delete dynamic trigger rules. Use this when the user asks pie to delete, remove, or clear an existing dynamic trigger.",
	parameters: {
		type: "object",
		properties: {
			id: {
				type: "string",
				description: "The exact dynamic trigger rule id to remove.",
			},
			all: {
				type: "boolean",
				description: "Set true only when the user explicitly asks to remove all dynamic trigger rules.",
			},
		},
		additionalProperties: false,
	},
};

const SET_TRIGGER_STATE_TOOL: ToolDefinition = {
	name: "SetTriggerState",
	description:
		"Enable or disable an existing dynamic trigger rule without deleting it. Use this when the user asks to pause, disable, enable, or resume a trigger.",
	parameters: {
		type: "object",
		properties: {
			id: {
				type: "string",
				description: "The exact dynamic trigger rule id to update.",
			},
			enabled: {
				type: "boolean",
				description: "Set false to pause or disable the trigger; set true to enable or resume it.",
			},
		},
		required: ["id", "enabled"],
		additionalProperties: false,
	},
};

function renderTriggerRulesForTool(rules: readonly DynamicTriggerRule[]): string {
	if (rules.length === 0) {
		return "dynamic trigger rules: none";
	}
	const lines = [`dynamic trigger rules: ${rules.length}`];
	for (const rule of rules) {
		const state = rule.enabled ? "enabled" : "disabled";
		const fireMode = rule.fire_once ? "fire_once" : "repeat";
		const outputMode = rule.promote_to_chat ? "promote_to_chat" : "audit_only";
		lines.push(
			`- ${rule.id} [${state}, ${fireMode}, ${outputMode}] created_at=${toRfc3339Offset(rule.created_at)} condition: ${rule.condition} action: ${rule.action}`,
		);
	}
	return lines.join("\n");
}

const FIXED_SCHEDULE_ENGLISH_NEEDLES: readonly string[] = [
	"every hour",
	"hourly",
	"every day",
	"daily",
	"every week",
	"weekly",
	"scheduled job",
	"cron",
	"crontab",
];

const FIXED_SCHEDULE_ZH_NEEDLES: readonly string[] = [
	"定时任务",
	"定時任務",
	"每小时",
	"每小時",
	"每天",
	"每日",
	"每周",
	"每週",
];

function looksLikeFixedScheduleRequest(text: string): boolean {
	const lower = text.toLowerCase();
	if (FIXED_SCHEDULE_ENGLISH_NEEDLES.some((needle) => lower.includes(needle))) return true;
	return FIXED_SCHEDULE_ZH_NEEDLES.some((needle) => text.includes(needle));
}

export class NewTriggerTool implements AgentTool {
	definition(): ToolDefinition {
		return NEW_TRIGGER_TOOL;
	}

	label(): string {
		return "NewTrigger";
	}

	executionMode(): ToolExecutionMode {
		return "parallel";
	}

	/**
	 * Issue #110 sub-PR 3 classifier — every new dynamic trigger is a persistent
	 * agent-self-modification. Always Prompt. The reason is value-free by construction (names
	 * the input fields the model supplied, NOT their content) so a tokenized URL or other
	 * secret-bearing payload smuggled into `condition`/`action`/`spec` cannot leak through
	 * `Prompt.reason` into the audit/UI surface.
	 */
	permissionClassification(preparedArgs: unknown): PermissionClassification {
		const p = (preparedArgs ?? {}) as Record<string, unknown>;
		const hasCondition = typeof p.condition === "string" && p.condition.trim().length > 0;
		const hasAction = typeof p.action === "string" && p.action.trim().length > 0;
		const hasSpec = typeof p.spec === "string" && p.spec.trim().length > 0;
		let reason: string;
		if (hasCondition && hasAction) {
			reason = "create dynamic trigger from `condition` + `action` fields";
		} else if (hasSpec) {
			reason = "create dynamic trigger from `spec` field";
		} else {
			reason = "create dynamic trigger";
		}
		return { type: "prompt", reason };
	}

	async execute(
		_id: string,
		params: unknown,
		_cancel: CancellationSignal,
		_onUpdate?: AgentToolUpdate,
	): Promise<AgentToolResult<unknown>> {
		const p = (params ?? {}) as Record<string, unknown>;
		const condition = typeof p.condition === "string" ? p.condition : undefined;
		const action = typeof p.action === "string" ? p.action : undefined;
		const fireOnce = typeof p.fire_once === "boolean" ? p.fire_once : true;
		const promoteToChat = typeof p.promote_to_chat === "boolean" ? p.promote_to_chat : false;
		const spec = typeof p.spec === "string" ? p.spec : undefined;

		const fixedScheduleText = [condition, action, spec].some(
			(text) => text !== undefined && looksLikeFixedScheduleRequest(text),
		);
		if (fixedScheduleText) {
			throw AgentToolError.message("fixed scheduled jobs must use NewCronJob, not NewTrigger");
		}

		let rule: DynamicTriggerRule;
		if (condition !== undefined && action !== undefined) {
			try {
				rule = globalRegistry().addRuleWithFlags(condition, action, fireOnce, promoteToChat);
			} catch (err) {
				throw AgentToolError.message(errorMessage(err));
			}
		} else {
			if (spec === undefined) {
				throw AgentToolError.message("missing required args: provide condition and action");
			}
			try {
				rule = globalRegistry().addFromSpec(spec);
			} catch (err) {
				throw AgentToolError.message(errorMessage(err));
			}
		}

		return {
			content: [
				textBlock(
					`created dynamic trigger ${rule.id}\ncondition: ${rule.condition}\naction: ${rule.action}\nfire_once: ${rule.fire_once}\npromote_to_chat: ${rule.promote_to_chat}`,
				),
			],
			details: {
				id: rule.id,
				condition: rule.condition,
				action: rule.action,
				enabled: rule.enabled,
				fire_once: rule.fire_once,
				fired_at: rule.fired_at,
				promote_to_chat: rule.promote_to_chat,
			},
			terminate: undefined,
		};
	}
}

export class ListTriggersTool implements AgentTool {
	definition(): ToolDefinition {
		return LIST_TRIGGERS_TOOL;
	}

	label(): string {
		return "ListTriggers";
	}

	executionMode(): ToolExecutionMode {
		return "parallel";
	}

	async execute(
		_id: string,
		_params: unknown,
		_cancel: CancellationSignal,
		_onUpdate?: AgentToolUpdate,
	): Promise<AgentToolResult<unknown>> {
		const rules = globalRegistry().list();
		const storagePath = globalRegistry().storagePath();
		return {
			content: [textBlock(renderTriggerRulesForTool(rules))],
			details: {
				count: rules.length,
				rules,
				storage_path: storagePath,
			},
			terminate: undefined,
		};
	}
}

export class RemoveTriggerTool implements AgentTool {
	definition(): ToolDefinition {
		return REMOVE_TRIGGER_TOOL;
	}

	label(): string {
		return "RemoveTrigger";
	}

	executionMode(): ToolExecutionMode {
		return "parallel";
	}

	/**
	 * Issue #110 sub-PR 3 classifier — every trigger removal is a destructive control-plane
	 * write. Prompt with a reason that distinguishes single-id removal from the `all = true`
	 * bulk path.
	 */
	permissionClassification(preparedArgs: unknown): PermissionClassification {
		const p = (preparedArgs ?? {}) as Record<string, unknown>;
		let reason: string;
		if (p.all === true) {
			reason = "remove ALL dynamic triggers";
		} else if (typeof p.id === "string") {
			reason = `remove dynamic trigger \`${p.id}\``;
		} else {
			reason = "remove dynamic trigger";
		}
		return { type: "prompt", reason };
	}

	async execute(
		_id: string,
		params: unknown,
		_cancel: CancellationSignal,
		_onUpdate?: AgentToolUpdate,
	): Promise<AgentToolResult<unknown>> {
		const p = (params ?? {}) as Record<string, unknown>;

		if (p.all === true) {
			let count: number;
			try {
				count = globalRegistry().clearRules();
			} catch (err) {
				throw AgentToolError.message(errorMessage(err));
			}
			return {
				content: [textBlock(`removed ${count} dynamic trigger rule(s)`)],
				details: { removed_count: count, all: true },
				terminate: undefined,
			};
		}

		const id = typeof p.id === "string" ? p.id : undefined;
		if (id === undefined) throw AgentToolError.message("missing required arg: id");

		let removed: DynamicTriggerRule | undefined;
		try {
			removed = globalRegistry().removeRule(id);
		} catch (err) {
			throw AgentToolError.message(errorMessage(err));
		}
		if (removed === undefined) throw AgentToolError.message(`no dynamic trigger rule with id '${id}'`);

		return {
			content: [
				textBlock(
					`removed dynamic trigger ${removed.id}\ncondition: ${removed.condition}\naction: ${removed.action}`,
				),
			],
			details: {
				id: removed.id,
				condition: removed.condition,
				action: removed.action,
				removed_count: 1,
			},
			terminate: undefined,
		};
	}
}

export class SetTriggerStateTool implements AgentTool {
	definition(): ToolDefinition {
		return SET_TRIGGER_STATE_TOOL;
	}

	label(): string {
		return "SetTriggerState";
	}

	executionMode(): ToolExecutionMode {
		return "parallel";
	}

	/**
	 * Issue #110 sub-PR 3 classifier — same narrowing/escalating split as cron.ts's
	 * `SetCronJobStateTool` doc: disabling an existing trigger is narrowing and falls through
	 * `Allow`; re-enabling an existing trigger is escalating and routes through the prompt.
	 * Unlike cron's SetCronJobState (see PORT-DIVERGENCE: B6 in cron.ts), a model-driven re-enable
	 * here is NOT refused outright — it just requires the classifier's Prompt gate, matching oracle
	 * exactly (dynamic.rs's `SetTriggerStateTool::execute` has no analogous refusal branch). Cron
	 * is stricter on both of its model-facing paths (create and re-enable); dynamic triggers stay
	 * on the prompt gate, which is still a human decision, so the invariant holds here too.
	 */
	permissionClassification(preparedArgs: unknown): PermissionClassification {
		const p = (preparedArgs ?? {}) as Record<string, unknown>;
		const enabled = p.enabled === true;
		if (!enabled) return { type: "allow" };
		const id = typeof p.id === "string" ? p.id : "<unknown>";
		return { type: "prompt", reason: `re-enable dynamic trigger \`${id}\`` };
	}

	async execute(
		_id: string,
		params: unknown,
		_cancel: CancellationSignal,
		_onUpdate?: AgentToolUpdate,
	): Promise<AgentToolResult<unknown>> {
		const p = (params ?? {}) as Record<string, unknown>;
		const id = typeof p.id === "string" ? p.id : undefined;
		if (id === undefined) throw AgentToolError.message("missing required arg: id");
		const enabled = typeof p.enabled === "boolean" ? p.enabled : undefined;
		if (enabled === undefined) throw AgentToolError.message("missing required arg: enabled");

		let updated: DynamicTriggerRule | undefined;
		try {
			updated = globalRegistry().setRuleEnabled(id, enabled);
		} catch (err) {
			throw AgentToolError.message(errorMessage(err));
		}
		if (updated === undefined) throw AgentToolError.message(`no dynamic trigger rule with id '${id}'`);

		const state = updated.enabled ? "enabled" : "disabled";
		return {
			content: [
				textBlock(
					`updated dynamic trigger ${updated.id}\nstate: ${state}\ncondition: ${updated.condition}\naction: ${updated.action}`,
				),
			],
			details: {
				id: updated.id,
				condition: updated.condition,
				action: updated.action,
				enabled: updated.enabled,
				fire_once: updated.fire_once,
				fired_at: updated.fired_at,
				promote_to_chat: updated.promote_to_chat,
			},
			terminate: undefined,
		};
	}
}
