import {
	type AssistantMessage,
	getModel as getCatalogModel,
	type ImageContent,
	type Model,
	streamSimple,
	type UserMessage,
} from "@pie/ai";
import { runAgentLoop, runAgentLoopContinue } from "../agent-loop.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	ControlPlanePromptDecision,
	ControlPlanePromptRequest,
	QueueMode,
	StreamFn,
	ThinkingLevel,
} from "../types.ts";
import { AsyncQueue } from "./async-queue.ts";
import { collectEntriesForBranchSummary, generateBranchSummary } from "./compaction/branch-summarization.ts";
import {
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	prepareCompaction,
	shouldCompact,
} from "./compaction/compaction.ts";
import { type CostSnapshot, CostTracker } from "./cost.ts";
import { detach } from "./detach.ts";
import { convertToLlm } from "./messages.ts";
import type { NotificationHook, NotificationHookStatus } from "./notification-hook.ts";
import { PromptTemplateRegistry } from "./prompt-templates.ts";
import { selectBiased } from "./select.ts";
import { formatSkillInvocation, type SkillDiagnostic } from "./skills.ts";
import { formatSkillsForSystemPrompt } from "./system-prompt.ts";
import {
	TRIGGER_RECORD_CUSTOM_TYPE,
	type Trigger,
	type TriggerRecord,
	type TriggerState,
	triggerRecordReceivedFrom,
} from "./trigger.ts";
import {
	type EvaluationOutcome,
	TriggerRuntime,
	type TriggerRuntimeConfig,
	type TriggerRuntimeSnapshot,
} from "./trigger-runtime.ts";
import type {
	AbortResult,
	AgentHarnessEvent,
	AgentHarnessEventResultMap,
	AgentHarnessOptions,
	AgentHarnessOwnEvent,
	AgentHarnessPhase,
	AgentHarnessResources,
	AgentHarnessStreamOptions,
	AgentHarnessStreamOptionsPatch,
	CompactionSettings,
	CompactResult,
	ExecutionEnv,
	NavigateTreeResult,
	PendingSessionWrite,
	PromptTemplate,
	Session,
	SessionContext,
	SessionTreeEntry,
	Skill,
} from "./types.ts";
import { AgentHarnessError, BranchSummaryError, CompactionError, SessionError, toError } from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────────────────
// Trigger execution chain — pie: crates/agent/src/harness/agent_harness.rs (RFC 1 / issue #20).
//
// oracle keeps trigger/promotion lifecycle events on a SEPARATE channel (`HarnessEvent` +
// `subscribe_harness`/`emit_harness_event`, agent_harness.rs:35-228,1059-1084) from the per-turn
// `AgentEvent`/hook surface that already lives in `./types.ts` (owned by another migration unit —
// this task's constraints forbid touching that file). `HarnessEvent` below is intentionally a
// second, local event union reachable only via `subscribeHarness()`, mirroring oracle's
// bifurcated design rather than shoehorning trigger events into the existing `AgentHarnessOwnEvent`
// union. oracle's `SessionStart`/`Compaction`/`Branch`/`SkillsReloaded` variants are NOT ported
// here — those concerns are already covered by base's existing `session_tree`/`session_compact`
// events (owned by other units); only the trigger-lifecycle variants that have no existing base
// counterpart are added.
// ─────────────────────────────────────────────────────────────────────────────────────────

/** pie: agent_harness.rs:58-64 (`HarnessEvent::TriggerHandlingStart`). */
export interface TriggerHandlingStartEvent {
	type: "trigger_handling_start";
	idempotencyKey: string;
	sourceKind: Trigger["source_kind"];
	sourceLabel: string;
	eventLabel: string;
	traceId: string;
}

/** pie: agent_harness.rs:84-90 (`HarnessEvent::TriggerHandled`). */
export interface TriggerHandledEvent {
	type: "trigger_handled";
	idempotencyKey: string;
	traceId: string;
	state: TriggerState;
	auditEntryId: string | undefined;
	evaluatorDecision: unknown;
}

/** pie: agent_harness.rs:98 (`HarnessEvent::TriggerPromptRequest`). */
export interface TriggerPromptRequestEvent {
	type: "trigger_prompt_request";
	request: TriggerPromptRequest;
}

/** pie: agent_harness.rs:104-113 (`HarnessEvent::PersistenceError`). */
export interface PersistenceErrorEvent {
	type: "persistence_error";
	context: string;
	message: string;
}

/** pie: agent_harness.rs:120-125 (`HarnessEvent::TriggerExecutionStarted`). */
export interface TriggerExecutionStartedEvent {
	type: "trigger_execution_started";
	traceId: string;
	sourceLabel: string;
	eventLabel: string;
	promptPreview: string;
}

/** pie: agent_harness.rs:137-142 (`HarnessEvent::TriggerCompleted`). */
export interface TriggerCompletedEvent {
	type: "trigger_completed";
	traceId: string;
	summary: string | undefined;
	costUsd: number | undefined;
	details: unknown;
}

/** pie: agent_harness.rs:148 (`HarnessEvent::TriggerFailed`). */
export interface TriggerFailedEvent {
	type: "trigger_failed";
	traceId: string;
	reason: string;
}

/** pie: agent_harness.rs:156 (`HarnessEvent::TriggerRequestsMainRun`). */
export interface TriggerRequestsMainRunEvent {
	type: "trigger_requests_main_run";
	traceId: string;
}

/** pie: agent_harness.rs:177-185 (`HarnessEvent::TriggerPromoted`). */
export interface TriggerPromotedEvent {
	type: "trigger_promoted";
	traceId: string;
	promoteKind: string;
	insertedEntryId: string;
	templateName: string | undefined;
	redactionStatus: string;
}

/** pie: agent_harness.rs:193-198 (`HarnessEvent::PromotionPending`). */
export interface PromotionPendingEvent {
	type: "promotion_pending";
	traceId: string;
	promoteKind: string;
	templateName: string | undefined;
	preview: string | undefined;
}

/**
 * pie: agent_harness.rs:199-218 (`HarnessEvent::TurnEnded`). Emitted once per prompt-cycle
 * boundary after {@link OnTurnEndHook} returns (or after the runtime decides not to invoke it
 * because the continuation cap was reached) — lets a TUI/UI render "evaluator says: keep going"
 * between continuation runs without snooping the `turn_end_decision` audit entry.
 * `continuationCount` is the *post*-decision counter (see oracle doc comment): for `stop`/`pause`
 * it equals the count of earlier `continue` decisions in the same prompt cycle.
 */
export interface TurnEndedEvent {
	type: "turn_ended";
	decision: "stop" | "pause" | "continue" | "budget_limited";
	continuationCount: number;
	reason: string | undefined;
	nextPromptPreview: string | undefined;
}

/**
 * pie: agent_harness.rs:223 (`HarnessEvent::SkillsReloaded { total: usize }`). Unlike the other
 * oracle `HarnessEvent` variants NOT ported here (`SessionStart`/`Compaction`/`Branch` — see this
 * file's header comment), `SkillsReloaded` has no existing base counterpart to fall back to
 * (base's `resources_update` own-event fires on every `setResources()` call, not specifically on
 * a disk reload), so it IS added here alongside the trigger-lifecycle variants.
 */
export interface SkillsReloadedEvent {
	type: "skills_reloaded";
	total: number;
}

export type HarnessEvent =
	| TriggerHandlingStartEvent
	| TriggerHandledEvent
	| TriggerPromptRequestEvent
	| PersistenceErrorEvent
	| TriggerExecutionStartedEvent
	| TriggerCompletedEvent
	| TriggerFailedEvent
	| TriggerRequestsMainRunEvent
	| TriggerPromotedEvent
	| PromotionPendingEvent
	| TurnEndedEvent
	| SkillsReloadedEvent;

/** pie: agent_harness.rs:228 (`HarnessListener`). Synchronous — mirrors oracle's `Fn(HarnessEvent)`. */
export type HarnessListener = (event: HarnessEvent) => void;

/** pie: agent_harness.rs:260-269 (`BeforeTriggerDecision`). Default (no hook) is `{ kind: "allow" }`. */
export type BeforeTriggerDecision =
	| { kind: "allow" }
	| { kind: "deny"; reason: string }
	| { kind: "prompt"; reason: string };

/** pie: agent_harness.rs:343-346 (`BeforeTriggerContext`). */
export interface BeforeTriggerContext {
	trigger: Trigger;
	runtime: TriggerRuntimeSnapshot;
}

/** pie: agent_harness.rs:356-364 (`BeforeTriggerHook`). */
export type BeforeTriggerHook = (ctx: BeforeTriggerContext, signal: AbortSignal) => Promise<BeforeTriggerDecision>;

/** pie: agent_harness.rs:278-296 (`TriggerPromptRequest`). */
export interface TriggerPromptRequest {
	triggerPromptId: string;
	traceId: string;
	sourceLabel: string;
	receiverAgentId: string | undefined;
	senderAgentId: string;
	actionClass: string;
	triggerSummary: string | undefined;
	payload: unknown;
	reason: string;
}

/** pie: agent_harness.rs:300-313 (`TriggerPromptDecision`). */
export type TriggerPromptDecision =
	| { kind: "allow" }
	| { kind: "deny"; reason?: string }
	| { kind: "timeout"; reason?: string };

/** pie: agent_harness.rs:328-336 (`OnTriggerPromptHook`). */
export type OnTriggerPromptHook = (
	request: TriggerPromptRequest,
	signal: AbortSignal,
) => Promise<TriggerPromptDecision>;

/** pie: agent_harness.rs:431-457 (`TriggerDelivery`). */
export type TriggerDelivery = "sub_agent" | "inject_summary" | "inject_and_run";

/**
 * pie: agent_harness.rs:499-533 (`PromoteAction`).
 *
 * `promote_summary_when_summary_contains` (agent_harness.rs:517-523, `PromoteSummaryWhenSummaryContains`)
 * is `#[deprecated]` upstream — "free-form `summary` substring matching cannot safely gate
 * promotion... prefer `PromoteSummaryWhenResultDetailsMatch`" — and was NOT ported when this file
 * first landed (phase 8), with a `TODO(port): add if a caller needs it` note. Added phase 10 by
 * `coding-agent/triggers/dynamic` (oracle `crates/coding-agent/src/triggers/dynamic.rs:557-595`
 * `before_trigger_action_hook`), which is the caller the TODO anticipated: at oracle @0a120dfd
 * dynamic triggers' `promote_to_chat` still goes through this exact deprecated variant (its own
 * comment: "Transitional... Tools-MCP's follow-up PR migrates this... once the
 * `mark_dynamic_rule_matched` tool is wired into the sub-agent. Allowed locally until then").
 * Bug-for-bug per RULEBOOK §0: the oracle at this pinned commit has NOT made that migration, so
 * `promote_to_chat` is dead without this variant — using
 * `promote_summary_when_result_details_match` instead would silently no-op forever, since the
 * sub-agent path never populates structured `details` (see `runSubAgentDelivery`'s `details:
 * undefined` — no marker-tool result-details builder is wired in this unit either).
 */
export type PromoteAction =
	| { kind: "none" }
	| { kind: "promote_summary_now"; templateBody?: string }
	| { kind: "promote_summary_when_summary_contains"; templateBody?: string; requiredSubstrings: string[] }
	| { kind: "promote_summary_when_result_details_match"; templateBody?: string; condition: PromotionCondition };

/** pie: agent_harness.rs:542-554 (`PromotionCondition::AnyOf`, the only variant). */
export interface PromotionCondition {
	jsonPointer: string;
	anyOf: string[];
}

/** pie: agent_harness.rs:595-605 (`PromotionConditionSkipReason`), string values per `as_audit_str` (line 610-616). */
export type PromotionConditionSkipReason =
	| "result_details_missing"
	| "result_details_not_array"
	| "no_matching_rule_id";

/** pie: agent_harness.rs:407-422 (`TriggerAction`). */
export interface TriggerAction {
	prompt: string;
	promote: PromoteAction;
	promoteRequiresApproval: boolean;
	delivery: TriggerDelivery;
}

/** pie: agent_harness.rs:622-625 (`BeforeTriggerActionContext`). */
export interface BeforeTriggerActionContext {
	trigger: Trigger;
	runtime: TriggerRuntimeSnapshot;
}

/** pie: agent_harness.rs:630-637 (`BeforeTriggerActionHook`). */
export type BeforeTriggerActionHook = (ctx: BeforeTriggerActionContext, signal: AbortSignal) => Promise<TriggerAction>;

/** pie: agent_harness.rs:390-397 (`RunningTriggerState`). */
export interface RunningTriggerState {
	traceId: string;
	sourceLabel: string;
	eventLabel: string;
	startedAt: string;
	promptPreview: string;
}

/** pie: agent_harness.rs:380-384 (`NotificationStatusSnapshot`). */
export interface NotificationStatusSnapshot {
	hooks: NotificationHookStatus[];
	runtime: TriggerRuntimeSnapshot;
	running: RunningTriggerState[];
}

/**
 * pie: agent_harness.rs:899-908 (`ReloadSkillsFn`). Embedder-supplied closure invoked by
 * `reloadSkillsFromDisk()` to fetch the up-to-date skill catalog. Owns source directories +
 * dedup policy — the harness stays IO-free and never touches the filesystem itself.
 */
export type ReloadSkillsFn<TSkill extends Skill = Skill> = () => Promise<{
	skills: TSkill[];
	diagnostics: SkillDiagnostic[];
}>;

// ─────────────────────────────────────────────────────────────────────────────────────────
// OnTurnEnd hook (powers `/goal` and other turn-completion-driven orchestrators) — pie:
// agent_harness.rs:640-980,1716-2018 (`OnTurnEndContext`/`TurnEndAction`/`TurnEndDecision`/
// `OnTurnEndHook`/`DEFAULT_TURN_CONTINUATION_CAP`/`EvaluatorOutput`/`EvaluatorError`/
// `prompt_with_message`/`continue_`/`run_turn_with_continuation`/`check_budget_cap`/
// `run_evaluator`). Ported per `migration/reviews/agent/gap-continuation.md` (phase 8 flagged this
// gap; phase 11 — `coding-agent/goal` — is the documented consumer, RULEBOOK §5 B4).
// ─────────────────────────────────────────────────────────────────────────────────────────

/** pie: agent_harness.rs:667-671 (`OnTurnEndContext`). `transcript` is a snapshot taken AFTER the
 * persistence listener has flushed the just-finished turn to the session (oracle: "matches what
 * `--resume` would replay"); the hook owns bounding what it forwards downstream. */
export interface OnTurnEndContext {
	transcript: readonly AgentMessage[];
	continuationCount: number;
	lastUserPrompt: string | undefined;
}

/** pie: agent_harness.rs:682-705 (`TurnEndAction`). `"noop"` writes no audit/event (agent_harness.rs:684-691);
 * `"continue"` starts another prompt cycle with `prompt` appended as a new user message. */
export type TurnEndAction =
	| { kind: "noop" }
	| { kind: "stop" }
	| { kind: "pause"; reason: string }
	| { kind: "continue"; prompt: string };

/** pie: agent_harness.rs:728-736 (`TurnEndDecision`). `payload` is merged into the persisted
 * `turn_end_decision` audit entry as `data.payload` — the runtime never inspects it. */
export interface TurnEndDecision {
	action: TurnEndAction;
	payload?: unknown;
}

/** pie: agent_harness.rs:763-770 (`OnTurnEndHook`). Fires at the boundary between two prompt
 * cycles inside {@link AgentHarness.prompt}/{@link AgentHarness.promptFromTemplate}/
 * {@link AgentHarness.continue}, with `signal` wired to {@link AgentHarness.abort} the same way
 * `resolveTriggerPrompt`'s hook is. `undefined` (no hook configured) behaves as `{ kind: "noop" }`. */
export type OnTurnEndHook = (ctx: OnTurnEndContext, signal: AbortSignal) => Promise<TurnEndDecision>;

/** pie: agent_harness.rs:776 (`DEFAULT_TURN_CONTINUATION_CAP`). */
const DEFAULT_TURN_CONTINUATION_CAP = 25;

/** pie: agent_harness.rs:778-790 (`EvaluatorOutput`). `lastAssistantText` is `undefined` when the
 * evaluator produced no assistant text (e.g. cancelled before the first token). */
export interface EvaluatorOutput {
	lastAssistantText: string | undefined;
}

/** pie: agent_harness.rs:792-801 (`EvaluatorError`). `"cancelled"` maps to oracle's
 * `EvaluatorError::Cancelled`; `"run"` maps to `EvaluatorError::Run(AgentRunError)`. Distinct from
 * `AgentHarnessError` so callers (e.g. `/goal`'s stop hook) can render policy-specific messages
 * ("evaluator failed — goal paused") without pattern-matching harness error codes. */
export class EvaluatorError extends Error {
	readonly kind: "cancelled" | "run";
	constructor(kind: "cancelled" | "run", message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.kind = kind;
		this.name = "EvaluatorError";
	}
}

/**
 * Extends the base `AgentHarnessOptions` (types.ts, owned by another migration unit — not
 * editable here) with pie's trigger/budget-cap constructor knobs. TS intersection types let this
 * unit widen the constructor's accepted shape without modifying the imported interface itself.
 * pie: `AgentHarnessOptions` fields `budget_cap_usd` / `trigger_runtime` / `before_trigger` /
 * `on_trigger_prompt` / `before_trigger_action` / `compaction` / `reload_skills_fn`
 * (agent_harness.rs:814,828-847,859).
 */
export interface AgentHarnessTriggerOptions<TSkill extends Skill = Skill> {
	/** pie: agent_harness.rs:828-830. `undefined` disables the check (oracle: `None`). */
	budgetCapUsd?: number;
	/** pie: agent_harness.rs:831-833. Defaults to `TriggerRuntimeConfig`'s own defaults. */
	triggerRuntime?: Partial<TriggerRuntimeConfig>;
	/** pie: agent_harness.rs:834-837. `undefined` behaves as `{ kind: "allow" }`. */
	beforeTrigger?: BeforeTriggerHook;
	/** pie: agent_harness.rs:838-843. `undefined` is fail-closed deny on `Prompt` decisions. */
	onTriggerPrompt?: OnTriggerPromptHook;
	/** pie: agent_harness.rs:844-847. `undefined` falls back to `defaultTriggerAction`. */
	beforeTriggerAction?: BeforeTriggerActionHook;
	/**
	 * pie: agent_harness.rs:818-826 (`AgentHarnessOptions::on_control_plane_prompt`). Routes
	 * through the bare loop's `AgentLoopConfig.onControlPlanePrompt` slot (types.ts:348,
	 * agent-loop.ts:744). `undefined` is **fail-closed deny** — any tool whose
	 * `permissionClassification` returns `{ type: "prompt" }` (and that no `beforeToolCall` hook
	 * hard-blocks) receives a synthesized deny at runtime instead of executing.
	 */
	onControlPlanePrompt?: (
		request: ControlPlanePromptRequest,
		signal?: AbortSignal,
	) => Promise<ControlPlanePromptDecision>;
	/** pie: agent_harness.rs:814 (`AgentHarnessOptions::compaction`). Per-harness auto/force
	 * compaction thresholds. `undefined` defaults to `DEFAULT_COMPACTION_SETTINGS`. */
	compaction?: CompactionSettings;
	/** pie: agent_harness.rs:848-859 (`AgentHarnessOptions::reload_skills_fn`). `undefined` makes
	 * `reloadSkillsFromDisk()` throw (oracle: `ReloadSkillsError::NotConfigured`) instead of
	 * silently no-opping. */
	reloadSkillsFn?: ReloadSkillsFn<TSkill>;
	/** pie: agent_harness.rs:860-864 (`AgentHarnessOptions::on_turn_end`). `undefined` behaves as a
	 * hook that always returns `{ kind: "noop" }` (current/legacy "one prompt cycle per call"
	 * behavior — no `turn_end_decision` audit entry, no `HarnessEvent.turn_ended`). */
	onTurnEnd?: OnTurnEndHook;
	/** pie: agent_harness.rs:865-869,776 (`AgentHarnessOptions::turn_continuation_cap` /
	 * `DEFAULT_TURN_CONTINUATION_CAP`). `undefined` uses the oracle default of 25; `0` disables
	 * continuation entirely (the hook still fires once per prompt cycle for audit/observability,
	 * but any `continue` decision is treated as `budget_limited`). */
	turnContinuationCap?: number;
}

/** pie: agent_harness.rs:2950 (`PROMOTION_BODY_CAP_BYTES`). */
const PROMOTION_BODY_CAP_BYTES = 4096;
/** pie: agent_harness.rs:2993 (`TRUNCATION_MARKER`). */
const TRUNCATION_MARKER = "…[truncated]";
/** pie: agent_harness.rs:2235 (`CONTROL_PLANE_PROMPT_LABEL_CAP_CHARS`). */
const CONTROL_PLANE_PROMPT_LABEL_CAP_CHARS = 200;
/** pie: agent_harness.rs:2336 (`TRIGGER_PROMPT_REASON_CAP_CHARS`). */
const TRIGGER_PROMPT_REASON_CAP_CHARS = 512;
/** pie: agent_harness.rs:2899-2902 (`FORBIDDEN_TEMPLATE_FIELDS`). */
const FORBIDDEN_TEMPLATE_FIELDS: readonly string[] = ["trigger.payload", "trigger.authority.allowed_source_actions"];
/** pie: agent_harness.rs:2945 (`DEFAULT_PROMOTE_SUMMARY_TEMPLATE`). */
const DEFAULT_PROMOTE_SUMMARY_TEMPLATE =
	"[Trigger {{trace_id}}] {{trigger.source_label}} fired {{trigger.event_label}}.\nResult: {{result.summary}}";

/**
 * pie: agent_harness.rs:2999-3014 (`truncate_on_char_boundary`). Truncates to fit within
 * `capBytes` **UTF-8** bytes (matching oracle's `String::len()`/byte-boundary semantics, not
 * JS's UTF-16 code-unit length), reserving room for `TRUNCATION_MARKER` and walking back to a
 * UTF-8 continuation-byte-safe cut point via `Buffer` (node builtin, no new dependency).
 */
function truncateOnCharBoundary(body: string, capBytes: number): { body: string; truncated: boolean } {
	const buf = Buffer.from(body, "utf8");
	if (buf.length <= capBytes) return { body, truncated: false };
	const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
	const budget = Math.max(0, capBytes - markerBytes);
	let cut = Math.min(budget, buf.length);
	while (cut > 0 && (buf[cut]! & 0xc0) === 0x80) cut -= 1;
	return { body: `${buf.subarray(0, cut).toString("utf8")}${TRUNCATION_MARKER}`, truncated: true };
}

/** pie: agent_harness.rs:3392-3404 (`preview_for_banner`). Code-point aware, not UTF-16-unit aware. */
function previewForBanner(text: string, maxChars: number): string {
	const chars = Array.from(text);
	if (chars.length <= maxChars) return text;
	return `${chars.slice(0, maxChars).join("")}…`;
}

/** pie: agent_harness.rs:2237-2247 (`cap_control_plane_audit_label`). */
function capControlPlaneAuditLabel(label: string): string {
	const chars = Array.from(label);
	if (chars.length <= CONTROL_PLANE_PROMPT_LABEL_CAP_CHARS) return label;
	return `${chars.slice(0, CONTROL_PLANE_PROMPT_LABEL_CAP_CHARS - 1).join("")}…`;
}

/** pie: agent_harness.rs:2338-2348 (`cap_trigger_prompt_reason`). */
function capTriggerPromptReason(reason: string): string {
	const chars = Array.from(reason);
	if (chars.length <= TRIGGER_PROMPT_REASON_CAP_CHARS) return reason;
	return `${chars.slice(0, TRIGGER_PROMPT_REASON_CAP_CHARS - 1).join("")}…`;
}

/** pie: agent_harness.rs:2973-2989 (`ensure_trigger_prefix`). */
function ensureTriggerPrefix(body: string, traceId: string): { body: string; prefixInjected: boolean } {
	const expected = `[Trigger ${traceId}] `;
	if (body.startsWith(expected)) return { body, prefixInjected: false };
	return { body: `${expected}${body}`, prefixInjected: true };
}

/** pie: agent_harness.rs:2959-2971 (`sha256_hex`). node:crypto is a builtin, not a new dependency. */
// packages/agent is inside the browser bundle surface (scripts/check-browser-smoke.mjs), so
// node:crypto is unavailable here. Web Crypto's SHA-256 is byte-identical and available in both
// Node >=18 and browsers — same substitution agent-loop.ts's computeArgsHash already uses.
async function sha256Hex(input: string): Promise<string> {
	const bytes = new TextEncoder().encode(input);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/** pie: agent_harness.rs:2312-2318 (`trigger_json_string`). */
function triggerJsonString(trigger: Trigger, path: readonly string[]): string | undefined {
	let value: unknown = trigger.payload;
	for (const key of path) {
		if (value === undefined || value === null || typeof value !== "object") return undefined;
		value = (value as Record<string, unknown>)[key];
	}
	return typeof value === "string" ? value : undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** pie: agent_harness.rs:2301-2305 (`validated_payload_agent_id`). */
function validatedPayloadAgentId(trigger: Trigger, path: readonly string[]): string | undefined {
	const value = triggerJsonString(trigger, path);
	return value !== undefined && UUID_RE.test(value) ? value : undefined;
}

/** pie: agent_harness.rs:2320-2334 (`is_valid_action_class`). */
function isValidActionClass(value: string): boolean {
	if (value.length === 0 || value.length > 64) return false;
	const lower = value.toLowerCase();
	if (lower.startsWith("sk-") || lower.includes("bearer") || lower.includes("token")) return false;
	return /^[a-z][a-z0-9_.:-]*$/.test(value);
}

/** pie: agent_harness.rs:2307-2310 (`validated_payload_action_class`). */
function validatedPayloadActionClass(trigger: Trigger, path: readonly string[]): string | undefined {
	const value = triggerJsonString(trigger, path);
	return value !== undefined && isValidActionClass(value) ? value : undefined;
}

/** pie: agent_harness.rs:2249-2299 (`build_trigger_prompt_request`). */
async function buildTriggerPromptRequest(trigger: Trigger, reason: string): Promise<TriggerPromptRequest> {
	const receiverAgentId =
		validatedPayloadAgentId(trigger, ["_meta", "receiver_agent_id"]) ??
		validatedPayloadAgentId(trigger, ["receiver_agent_id"]);
	const senderAgentId =
		validatedPayloadAgentId(trigger, ["_meta", "sender_agent_id"]) ??
		validatedPayloadAgentId(trigger, ["sender_agent_id"]) ??
		validatedPayloadAgentId(trigger, ["agent_id"]) ??
		capControlPlaneAuditLabel(trigger.authority.principal_id);
	const actionClass =
		validatedPayloadActionClass(trigger, ["_meta", "action_class"]) ??
		validatedPayloadActionClass(trigger, ["action_class"]) ??
		capControlPlaneAuditLabel(trigger.event_label);
	const triggerSummary = trigger.payload_summary
		? truncateOnCharBoundary(trigger.payload_summary, PROMOTION_BODY_CAP_BYTES).body
		: undefined;
	const payload = {
		source_kind: trigger.source_kind,
		source_label: capControlPlaneAuditLabel(trigger.source_label),
		event_label: capControlPlaneAuditLabel(trigger.event_label),
		payload_visibility: trigger.payload_visibility,
		payload_summary: triggerSummary ?? null,
		authority: {
			principal_id: trigger.authority.principal_id,
			principal_label: capControlPlaneAuditLabel(trigger.authority.principal_label),
			credential_scope: trigger.authority.credential_scope,
			allowed_source_actions: trigger.authority.allowed_source_actions,
		},
	};
	const binding = JSON.stringify([
		"trigger_prompt:v1",
		trigger.idempotency_key,
		trigger.trace_id,
		trigger.source_kind,
		trigger.source_label,
		trigger.event_label,
		receiverAgentId ?? null,
		senderAgentId,
		actionClass,
	]);
	return {
		triggerPromptId: await sha256Hex(binding),
		traceId: trigger.trace_id,
		sourceLabel: capControlPlaneAuditLabel(trigger.source_label),
		receiverAgentId,
		senderAgentId,
		actionClass,
		triggerSummary,
		payload,
		reason: capTriggerPromptReason(reason),
	};
}

/** pie: agent_harness.rs:481-488 (`TriggerAction::default_for`). */
function defaultTriggerAction(trigger: Trigger): TriggerAction {
	return {
		prompt: `${trigger.source_label} fired: ${trigger.event_label}`,
		promote: { kind: "none" },
		promoteRequiresApproval: false,
		delivery: "sub_agent",
	};
}

/** pie: agent_harness.rs:3365-3390 (`last_assistant_text`). Finds the LAST assistant message (not
 * the last assistant message WITH text) and returns `undefined` if that specific message has no
 * text content — it does not keep scanning further back for an earlier non-empty one. */
function lastAssistantText(messages: readonly AgentMessage[]): string | undefined {
	let last: AssistantMessage | undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message.role === "assistant") {
			last = message as AssistantMessage;
			break;
		}
	}
	if (!last) return undefined;
	const text = last.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	if (text.length === 0) return undefined;
	return truncateOnCharBoundary(text, 4096).body;
}

/** pie: agent_harness.rs:2821-2894 (`build_template_context`). `agent_delegate` source kind
 * intentionally contributes no extra `trigger.source.*` fields, matching oracle (only `mcp`/`local`
 * do). */
function buildTemplateContext(
	traceId: string,
	trigger: Trigger,
	success: boolean,
	summary: string | undefined,
	messageCount: number,
): Map<string, string> {
	const ctx = new Map<string, string>();
	ctx.set("trace_id", traceId);
	const source = trigger.source;
	ctx.set("trigger.source.kind", source.kind);
	if (source.kind === "mcp") {
		ctx.set("trigger.source.server_name", source.server_name);
		ctx.set("trigger.source.method", source.method);
	} else if (source.kind === "local") {
		ctx.set("trigger.source.subkind", source.subkind);
	}
	ctx.set("trigger.source_label", trigger.source_label);
	ctx.set("trigger.event_label", trigger.event_label);
	ctx.set("trigger.payload_summary", trigger.payload_summary ?? "");
	ctx.set("trigger.received_at", trigger.received_at);
	ctx.set("trigger.idempotency_key", trigger.idempotency_key);
	ctx.set("trigger.authority.principal_id", trigger.authority.principal_id);
	ctx.set("trigger.authority.principal_label", trigger.authority.principal_label);
	ctx.set("trigger.authority.credential_scope", trigger.authority.credential_scope);
	ctx.set("result.summary", summary ?? "");
	ctx.set("result.status", success ? "success" : "failed");
	ctx.set("result.message_count", String(messageCount));
	ctx.set("result.cost_usd", "null");
	ctx.set("result.branch_id", "null");
	return ctx;
}

type TemplateRenderResult =
	| { ok: true; value: string }
	| { ok: false; kind: "unknown_field" | "forbidden_field"; message: string };

/** pie: agent_harness.rs:2896-2942 (`FORBIDDEN_TEMPLATE_FIELDS` + `render_promotion_template`). */
function renderPromotionTemplate(body: string, ctx: ReadonlyMap<string, string>): TemplateRenderResult {
	let out = "";
	let rest = body;
	for (;;) {
		const openIdx = rest.indexOf("{{");
		if (openIdx === -1) {
			out += rest;
			break;
		}
		out += rest.slice(0, openIdx);
		const afterOpen = rest.slice(openIdx + 2);
		const closeIdx = afterOpen.indexOf("}}");
		if (closeIdx === -1) {
			return { ok: false, kind: "unknown_field", message: "unknown template field: unclosed `{{` placeholder" };
		}
		const name = afterOpen.slice(0, closeIdx).trim();
		if (FORBIDDEN_TEMPLATE_FIELDS.includes(name) || name.startsWith("_meta")) {
			return { ok: false, kind: "forbidden_field", message: `forbidden template field: ${name}` };
		}
		const value = ctx.get(name);
		if (value === undefined) {
			return { ok: false, kind: "unknown_field", message: `unknown template field: ${name}` };
		}
		out += value;
		rest = afterOpen.slice(closeIdx + 2);
	}
	return { ok: true, value: out };
}

/** pie: agent_harness.rs:2312-2317 conceptually reused for RFC 6901 pointer resolution inside
 * `PromotionCondition::evaluate` (agent_harness.rs:560-589) — `serde_json::Value::pointer`. */
function resolveJsonPointer(root: unknown, pointer: string): unknown {
	if (pointer === "") return root;
	const tokens = pointer
		.split("/")
		.slice(1)
		.map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
	let current: unknown = root;
	for (const token of tokens) {
		if (current === null || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[token];
	}
	return current;
}

/** pie: agent_harness.rs:556-589 (`PromotionCondition::evaluate`, `AnyOf` variant — the only
 * one). Exported (GAP fix: previously module-private, so oracle's direct pure-function unit
 * tests of `PromotionCondition::evaluate` — which construct arbitrary `details` payloads and
 * never go through `handleTrigger`/`applyPromotion` — had no way to reach it; see
 * gap-inventory #8) so callers can unit-test it the same way oracle does, independent of the
 * two `applyPromotion` call sites that currently always pass `details: undefined`. */
export function evaluatePromotionCondition(
	condition: PromotionCondition,
	details: unknown,
): { ok: true; matched: string[] } | { ok: false; reason: PromotionConditionSkipReason } {
	const value = resolveJsonPointer(details, condition.jsonPointer);
	if (value === undefined) return { ok: false, reason: "result_details_missing" };
	if (!Array.isArray(value)) return { ok: false, reason: "result_details_not_array" };
	const matched = value.filter(
		(entry): entry is string => typeof entry === "string" && condition.anyOf.includes(entry),
	);
	if (matched.length === 0) return { ok: false, reason: "no_matching_rule_id" };
	return { ok: true, matched };
}

/**
 * pie: agent_harness.rs:2161-2169 (`build_system_prompt`). Composes the base system prompt with
 * the rendered `<skills>` block: empty base yields just the skills block, empty skills block
 * yields just the base, and both non-empty are joined with a blank line — byte-for-byte, so
 * `AgentHarness::system_prompt()`/`getSystemPrompt()` stays stable across independent reloads of
 * the same skill catalog (issue #25 v3 "resume" determinism guarantee).
 */
function buildSystemPrompt(base: string, skills: Skill[]): string {
	const skillsBlock = formatSkillsForSystemPrompt(skills);
	if (base === "") return skillsBlock;
	if (skillsBlock === "") return base;
	return `${base}\n\n${skillsBlock}`;
}

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** pie: agent_harness.rs:1655 (`ctx.thinking_level.parse::<ThinkingLevel>()`). A value that fails
 * to parse (e.g. an unrecognized string) leaves the current thinking level untouched, mirroring
 * `Result::Ok(_)`-only assignment via oracle's `if let Ok(level) = ...`. */
function isThinkingLevel(value: string): value is ThinkingLevel {
	return (THINKING_LEVELS as readonly string[]).includes(value);
}

function createUserMessage(text: string, images?: ImageContent[]): UserMessage {
	const content: Array<{ type: "text"; text: string } | ImageContent> = [{ type: "text", text }];
	if (images) content.push(...images);
	return { role: "user", content, timestamp: Date.now() };
}

function createFailureMessage(model: Model<any>, error: unknown, aborted: boolean): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: aborted ? "aborted" : "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function cloneStreamOptions(streamOptions?: AgentHarnessStreamOptions): AgentHarnessStreamOptions {
	return {
		...streamOptions,
		headers: streamOptions?.headers ? { ...streamOptions.headers } : undefined,
		metadata: streamOptions?.metadata ? { ...streamOptions.metadata } : undefined,
	};
}

function mergeHeaders(...headers: Array<Record<string, string> | undefined>): Record<string, string> | undefined {
	const merged: Record<string, string> = {};
	let hasHeaders = false;
	for (const entry of headers) {
		if (!entry) continue;
		Object.assign(merged, entry);
		hasHeaders = true;
	}
	return hasHeaders ? merged : undefined;
}

function applyStreamOptionsPatch(
	base: AgentHarnessStreamOptions,
	patch?: AgentHarnessStreamOptionsPatch,
): AgentHarnessStreamOptions {
	const result = cloneStreamOptions(base);
	if (!patch) return result;

	if (Object.hasOwn(patch, "transport")) result.transport = patch.transport;
	if (Object.hasOwn(patch, "timeoutMs")) result.timeoutMs = patch.timeoutMs;
	if (Object.hasOwn(patch, "maxRetries")) result.maxRetries = patch.maxRetries;
	if (Object.hasOwn(patch, "maxRetryDelayMs")) result.maxRetryDelayMs = patch.maxRetryDelayMs;
	if (Object.hasOwn(patch, "cacheRetention")) result.cacheRetention = patch.cacheRetention;

	if (Object.hasOwn(patch, "headers")) {
		if (patch.headers === undefined) {
			result.headers = undefined;
		} else {
			const headers = { ...(result.headers ?? {}) };
			for (const [key, value] of Object.entries(patch.headers)) {
				if (value === undefined) delete headers[key];
				else headers[key] = value;
			}
			result.headers = Object.keys(headers).length > 0 ? headers : undefined;
		}
	}

	if (Object.hasOwn(patch, "metadata")) {
		if (patch.metadata === undefined) {
			result.metadata = undefined;
		} else {
			const metadata = { ...(result.metadata ?? {}) };
			for (const [key, value] of Object.entries(patch.metadata)) {
				if (value === undefined) delete metadata[key];
				else metadata[key] = value;
			}
			result.metadata = Object.keys(metadata).length > 0 ? metadata : undefined;
		}
	}

	return result;
}

const SUBSCRIBER_EVENT_TYPE = "*";

type AgentHarnessHandler = (event: any, signal?: AbortSignal) => Promise<any> | any;

function normalizeHarnessError(error: unknown, fallbackCode: AgentHarnessError["code"]): AgentHarnessError {
	if (error instanceof AgentHarnessError) return error;
	const cause = toError(error);
	if (cause instanceof SessionError) return new AgentHarnessError("session", cause.message, cause);
	if (cause instanceof CompactionError) return new AgentHarnessError("compaction", cause.message, cause);
	if (cause instanceof BranchSummaryError) return new AgentHarnessError("branch_summary", cause.message, cause);
	return new AgentHarnessError(fallbackCode, cause.message, cause);
}

function normalizeHookError(error: unknown): AgentHarnessError {
	return normalizeHarnessError(error, "hook");
}

interface AgentHarnessTurnState<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
	TTool extends AgentTool = AgentTool,
> {
	messages: AgentMessage[];
	resources: AgentHarnessResources<TSkill, TPromptTemplate>;
	streamOptions: AgentHarnessStreamOptions;
	sessionId: string;
	systemPrompt: string;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	tools: TTool[];
	activeTools: TTool[];
}

export class AgentHarness<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
	TTool extends AgentTool = AgentTool,
> {
	readonly env: ExecutionEnv;
	private session: Session;
	private phase: AgentHarnessPhase = "idle";
	private runAbortController?: AbortController;
	private runPromise?: Promise<void>;
	private pendingSessionWrites: PendingSessionWrite[] = [];
	private model: Model<any>;
	private thinkingLevel: ThinkingLevel;
	private systemPrompt: AgentHarnessOptions<TSkill, TPromptTemplate, TTool>["systemPrompt"];
	private streamOptions: AgentHarnessStreamOptions;
	private getApiKeyAndHeaders?: AgentHarnessOptions["getApiKeyAndHeaders"];
	private resources: AgentHarnessResources<TSkill, TPromptTemplate>;
	private tools = new Map<string, TTool>();
	private activeToolNames: string[];
	private steerQueue: UserMessage[] = [];
	private steeringQueueMode: QueueMode;
	private followUpQueue: UserMessage[] = [];
	private followUpQueueMode: QueueMode;
	private nextTurnQueue: AgentMessage[] = [];
	private handlers = new Map<string, Set<AgentHarnessHandler>>();
	// pie: agent_harness.rs:936 (`cost: CostTracker`). Subscribed to assistant `message_end`
	// inside `handleAgentEvent` below (mirrors oracle's `agent.subscribe(cost.as_listener())`).
	private readonly costTracker = new CostTracker();
	// pie: agent_harness.rs:937 (`budget_cap_usd: Option<f64>`).
	private budgetCapUsd: number | undefined;
	// PORT-DIVERGENCE: B4 (see `budgetCapError`). Set by the mid-loop budget gate
	// (`createLoopConfig`'s `shouldStopAfterTurn`) when it stops an in-flight run, and consumed —
	// i.e. thrown and cleared — by the `executeTurn`/`executeContinueTurn` that owns that run.
	// The gate itself must not throw (the agent loop's `shouldStopAfterTurn` contract), so the
	// error is parked here instead of raised from inside the loop.
	private pendingBudgetCapTrip?: AgentHarnessError;
	// pie: agent_harness.rs:943 (`trigger_runtime: TriggerRuntime`).
	private readonly triggerRuntime: TriggerRuntime;
	// pie: agent_harness.rs:932 (`harness_listeners`). A `Set` rather than oracle's `Vec` since
	// TS has no need for the identity-pointer unsubscribe dance oracle's `Arc` closures require.
	private readonly harnessListeners = new Set<HarnessListener>();
	// pie: agent_harness.rs:969 (`running_triggers`), keyed by `trace_id`. The `AbortController`
	// plays the role of oracle's `tokio_util::sync::CancellationToken` for `abort_trigger`.
	private readonly runningTriggers = new Map<string, { state: RunningTriggerState; abort: AbortController }>();
	// pie: agent_harness.rs:949 (`notification_hooks`).
	private readonly notificationHooks: NotificationHook[] = [];
	// pie: agent_harness.rs:952 (`before_trigger`).
	private beforeTrigger: BeforeTriggerHook | undefined;
	// pie: agent_harness.rs:954 (`on_trigger_prompt`).
	private onTriggerPrompt: OnTriggerPromptHook | undefined;
	// pie: agent_harness.rs:957 (`before_trigger_action`).
	private beforeTriggerAction: BeforeTriggerActionHook | undefined;
	// pie: agent_harness.rs:818-826 (`on_control_plane_prompt`), forwarded verbatim into every
	// loop config this harness builds (oracle hands it to the bare `Agent`'s slot the same way).
	private readonly onControlPlanePrompt:
		| ((request: ControlPlanePromptRequest, signal?: AbortSignal) => Promise<ControlPlanePromptDecision>)
		| undefined;
	// pie: agent_harness.rs:925 (`compaction_settings: Mutex<CompactionSettings>`).
	private compactionSettings: CompactionSettings;
	// pie: agent_harness.rs:979 (`active_hook_cancel: Mutex<Option<CancellationToken>>`). Set
	// while an interruptible hook future is in flight — the `onTriggerPrompt` hook inside
	// `resolveTriggerPrompt`, AND (agent_harness.rs:1818-1821, wired here per
	// migration/reviews/agent/gap-continuation.md) the `onTurnEnd` hook inside
	// `runTurnWithContinuation` — so `abort()` can cancel whichever is in flight the same way
	// oracle's `abort()` cancels `active_hook_cancel`.
	private activeHookAbortController?: AbortController;
	// pie: agent_harness.rs:938-940 (`reload_skills_fn: Option<ReloadSkillsFn>`).
	private reloadSkillsFn: ReloadSkillsFn<TSkill> | undefined;
	// pie: agent_harness.rs:970-972 (`on_turn_end: Option<OnTurnEndHook>`).
	private readonly onTurnEnd: OnTurnEndHook | undefined;
	// pie: agent_harness.rs:973-975 (`turn_continuation_cap: u32`, resolved from
	// `AgentHarnessOptions::turn_continuation_cap` at construction).
	private readonly turnContinuationCap: number;

	constructor(
		options: AgentHarnessOptions<TSkill, TPromptTemplate, TTool> & Partial<AgentHarnessTriggerOptions<TSkill>>,
	) {
		this.env = options.env;
		this.session = options.session;
		this.resources = options.resources ?? {};
		this.streamOptions = cloneStreamOptions(options.streamOptions);
		this.systemPrompt = options.systemPrompt;
		this.getApiKeyAndHeaders = options.getApiKeyAndHeaders;
		for (const tool of options.tools ?? []) {
			this.tools.set(tool.name, tool);
		}
		this.model = options.model;
		this.thinkingLevel = options.thinkingLevel ?? "off";
		this.activeToolNames = options.activeToolNames ?? (options.tools ?? []).map((tool) => tool.name);
		this.steeringQueueMode = options.steeringMode ?? "one-at-a-time";
		this.followUpQueueMode = options.followUpMode ?? "one-at-a-time";
		this.budgetCapUsd = options.budgetCapUsd;
		this.triggerRuntime = new TriggerRuntime(options.triggerRuntime);
		this.beforeTrigger = options.beforeTrigger;
		this.onTriggerPrompt = options.onTriggerPrompt;
		this.beforeTriggerAction = options.beforeTriggerAction;
		this.onControlPlanePrompt = options.onControlPlanePrompt;
		this.compactionSettings = options.compaction ?? DEFAULT_COMPACTION_SETTINGS;
		this.reloadSkillsFn = options.reloadSkillsFn;
		this.onTurnEnd = options.onTurnEnd;
		this.turnContinuationCap = options.turnContinuationCap ?? DEFAULT_TURN_CONTINUATION_CAP;
	}

	private getHandlers(type: string): Set<AgentHarnessHandler> | undefined {
		return this.handlers.get(type);
	}

	private async emitOwn(event: AgentHarnessOwnEvent<TSkill, TPromptTemplate>, signal?: AbortSignal): Promise<void> {
		for (const listener of this.getHandlers(SUBSCRIBER_EVENT_TYPE) ?? []) {
			try {
				await listener(event, signal);
			} catch (error) {
				throw normalizeHookError(error);
			}
		}
	}

	private async emitAny(event: AgentHarnessEvent<TSkill, TPromptTemplate>, signal?: AbortSignal): Promise<void> {
		for (const listener of this.getHandlers(SUBSCRIBER_EVENT_TYPE) ?? []) {
			try {
				await listener(event, signal);
			} catch (error) {
				throw normalizeHookError(error);
			}
		}
	}

	private async emitHook<TType extends keyof AgentHarnessEventResultMap>(
		event: Extract<AgentHarnessOwnEvent, { type: TType }>,
	): Promise<AgentHarnessEventResultMap[TType] | undefined> {
		const handlers = this.getHandlers(event.type as TType);
		if (!handlers || handlers.size === 0) return undefined;
		let lastResult: AgentHarnessEventResultMap[TType] | undefined;
		for (const handler of handlers) {
			try {
				const result = await handler(event);
				if (result !== undefined) {
					lastResult = result;
				}
			} catch (error) {
				throw normalizeHookError(error);
			}
		}
		return lastResult;
	}

	private async emitBeforeProviderRequest(
		model: Model<any>,
		sessionId: string,
		streamOptions: AgentHarnessStreamOptions,
	): Promise<AgentHarnessStreamOptions> {
		const handlers = this.getHandlers("before_provider_request");
		let current = cloneStreamOptions(streamOptions);
		if (!handlers || handlers.size === 0) return current;
		for (const handler of handlers) {
			try {
				const result = await handler({
					type: "before_provider_request",
					model,
					sessionId,
					streamOptions: cloneStreamOptions(current),
				});
				if (result?.streamOptions) {
					current = applyStreamOptionsPatch(current, result.streamOptions);
				}
			} catch (error) {
				throw normalizeHookError(error);
			}
		}
		return current;
	}

	private async emitBeforeProviderPayload(model: Model<any>, payload: unknown): Promise<unknown> {
		const handlers = this.getHandlers("before_provider_payload");
		let current = payload;
		if (!handlers || handlers.size === 0) return current;
		for (const handler of handlers) {
			try {
				const result = await handler({ type: "before_provider_payload", model, payload: current });
				if (result !== undefined) {
					current = result.payload;
				}
			} catch (error) {
				throw normalizeHookError(error);
			}
		}
		return current;
	}

	private async emitQueueUpdate(): Promise<void> {
		await this.emitOwn({
			type: "queue_update",
			steer: [...this.steerQueue],
			followUp: [...this.followUpQueue],
			nextTurn: [...this.nextTurnQueue],
		});
	}

	private startRunPromise(): () => void {
		let finish = () => {};
		this.runPromise = new Promise<void>((resolve) => {
			finish = resolve;
		});
		return () => {
			this.runPromise = undefined;
			finish();
		};
	}

	private async createTurnState(): Promise<AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>> {
		const context = await this.session.buildContext();
		const resources = this.getResources();
		const sessionMetadata = await this.session.getMetadata();
		const tools = [...this.tools.values()];
		const activeTools = this.activeToolNames
			.map((name) => this.tools.get(name))
			.filter((tool): tool is TTool => tool !== undefined);
		let systemPrompt = "You are a helpful assistant.";
		if (typeof this.systemPrompt === "string") {
			// pie: agent_harness.rs:1000 (`AgentState::system_prompt = build_system_prompt(...)`).
			// oracle ALWAYS composes base + the live `<skills>` block; mirrored here for the
			// plain-string form (see `buildSystemPrompt()`/`getSystemPrompt()` below).
			systemPrompt = buildSystemPrompt(this.systemPrompt, resources.skills ?? []);
		} else if (this.systemPrompt) {
			systemPrompt = await this.systemPrompt({
				env: this.env,
				session: this.session,
				model: this.model,
				thinkingLevel: this.thinkingLevel,
				activeTools,
				resources,
			});
		}
		return {
			messages: context.messages,
			resources,
			streamOptions: cloneStreamOptions(this.streamOptions),
			sessionId: sessionMetadata.id,
			systemPrompt,
			model: this.model,
			thinkingLevel: this.thinkingLevel,
			tools,
			activeTools,
		};
	}

	private createContext(
		turnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>,
		systemPrompt?: string,
	): AgentContext {
		return {
			systemPrompt: systemPrompt ?? turnState.systemPrompt,
			messages: turnState.messages.slice(),
			tools: turnState.activeTools.slice(),
		};
	}

	private createStreamFn(getTurnState: () => AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>): StreamFn {
		return async (model, context, streamOptions) => {
			const turnState = getTurnState();
			const auth = await this.getApiKeyAndHeaders?.(model);
			const snapshotOptions: AgentHarnessStreamOptions = {
				...turnState.streamOptions,
				headers: mergeHeaders(turnState.streamOptions.headers, auth?.headers),
			};
			const requestOptions = await this.emitBeforeProviderRequest(model, turnState.sessionId, snapshotOptions);
			return streamSimple(model, context, {
				cacheRetention: requestOptions.cacheRetention,
				headers: requestOptions.headers,
				maxRetries: requestOptions.maxRetries,
				maxRetryDelayMs: requestOptions.maxRetryDelayMs,
				metadata: requestOptions.metadata,
				onPayload: async (payload) => await this.emitBeforeProviderPayload(model, payload),
				onResponse: async (response) => {
					const headers = { ...(response.headers as Record<string, string>) };
					await this.emitOwn(
						{ type: "after_provider_response", status: response.status, headers },
						streamOptions?.signal,
					);
				},
				reasoning: streamOptions?.reasoning,
				signal: streamOptions?.signal,
				sessionId: turnState.sessionId,
				timeoutMs: requestOptions.timeoutMs,
				transport: requestOptions.transport,
				apiKey: auth?.apiKey,
			});
		};
	}

	private async drainQueuedMessages(queue: AgentMessage[], mode: QueueMode): Promise<AgentMessage[]> {
		const messages = mode === "all" ? queue.splice(0) : queue.splice(0, 1);
		if (messages.length === 0) return messages;
		try {
			await this.emitQueueUpdate();
			return messages;
		} catch (error) {
			queue.unshift(...messages);
			throw normalizeHookError(error);
		}
	}

	private createLoopConfig(
		getTurnState: () => AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>,
		setTurnState: (turnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>) => void,
	): AgentLoopConfig {
		const turnState = getTurnState();
		return {
			model: turnState.model,
			reasoning: turnState.thinkingLevel === "off" ? undefined : turnState.thinkingLevel,
			convertToLlm,
			transformContext: async (messages) => {
				const result = await this.emitHook({ type: "context", messages: [...messages] });
				return result?.messages ?? messages;
			},
			beforeToolCall: async ({ toolCall, args }) => {
				const result = await this.emitHook({
					type: "tool_call",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					input: args as Record<string, unknown>,
				});
				return result ? { block: result.block, reason: result.reason } : undefined;
			},
			afterToolCall: async ({ toolCall, args, result, isError }) => {
				const patch = await this.emitHook({
					type: "tool_result",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					input: args as Record<string, unknown>,
					content: result.content,
					details: result.details,
					isError,
				});
				return patch
					? { content: patch.content, details: patch.details, isError: patch.isError, terminate: patch.terminate }
					: undefined;
			},
			// PORT-DIVERGENCE: B4 — the mid-loop budget gate; see `budgetCapStopsLoop`. Oracle has
			// no `should_stop_after_turn` wiring here at all (its cap is between-cycles only).
			shouldStopAfterTurn: ({ message }) => this.budgetCapStopsLoop(message),
			prepareNextTurn: async () => {
				await this.flushPendingSessionWrites();
				const nextTurnState = await this.createTurnState();
				setTurnState(nextTurnState);
				return {
					context: this.createContext(nextTurnState),
					model: nextTurnState.model,
					thinkingLevel: nextTurnState.thinkingLevel,
				};
			},
			getSteeringMessages: async () => this.drainQueuedMessages(this.steerQueue, this.steeringQueueMode),
			getFollowUpMessages: async () => this.drainQueuedMessages(this.followUpQueue, this.followUpQueueMode),
			// pie: agent_harness.rs:818-826 -> the loop's `on_control_plane_prompt` slot. Undefined
			// here keeps the loop's fail-closed deny.
			onControlPlanePrompt: this.onControlPlanePrompt,
		};
	}

	private validateToolNames(toolNames: string[], tools: Map<string, TTool> = this.tools): void {
		const missing = toolNames.filter((name) => !tools.has(name));
		if (missing.length > 0) throw new AgentHarnessError("invalid_argument", `Unknown tool(s): ${missing.join(", ")}`);
	}

	private async flushPendingSessionWrites(): Promise<void> {
		while (this.pendingSessionWrites.length > 0) {
			const write = this.pendingSessionWrites[0]!;
			if (write.type === "message") {
				await this.session.appendMessage(write.message);
			} else if (write.type === "model_change") {
				await this.session.appendModelChange(write.provider, write.modelId);
			} else if (write.type === "thinking_level_change") {
				await this.session.appendThinkingLevelChange(write.thinkingLevel);
			} else if (write.type === "custom") {
				await this.session.appendCustomEntry(write.customType, write.data);
			} else if (write.type === "custom_message") {
				await this.session.appendCustomMessageEntry(write.customType, write.content, write.display, write.details);
			} else if (write.type === "label") {
				await this.session.appendLabel(write.targetId, write.label);
			} else if (write.type === "session_info") {
				await this.session.appendSessionName(write.name ?? "");
			} else if (write.type === "leaf") {
				await this.session.getStorage().setLeafId(write.targetId);
			}
			this.pendingSessionWrites.shift();
		}
	}

	private async handleAgentEvent(event: AgentEvent, signal?: AbortSignal): Promise<void> {
		if (event.type === "message_end") {
			// pie: agent_harness.rs:1011-1014 (`AgentHarness::new` subscribes
			// `agent.subscribe(cost.as_listener())` as a listener separate from session
			// persistence). Assistant-only per cost.ts's `asListener()` guard.
			if (event.message.role === "assistant") {
				this.costTracker.record(event.message.usage);
			}
			await this.session.appendMessage(event.message);
			await this.emitAny(event, signal);
			return;
		}
		if (event.type === "turn_end") {
			let eventError: unknown;
			try {
				await this.emitAny(event, signal);
			} catch (error) {
				eventError = error;
			}
			const hadPendingMutations = this.pendingSessionWrites.length > 0;
			await this.flushPendingSessionWrites();
			if (eventError) throw eventError;
			await this.emitOwn({ type: "save_point", hadPendingMutations });
			return;
		}
		if (event.type === "agent_end") {
			await this.flushPendingSessionWrites();
			this.phase = "idle";
			await this.emitAny(event, signal);
			await this.emitOwn({ type: "settled", nextTurnCount: this.nextTurnQueue.length }, signal);
			return;
		}
		await this.emitAny(event, signal);
	}

	private async emitRunFailure(
		model: Model<any>,
		error: unknown,
		aborted: boolean,
		signal: AbortSignal,
	): Promise<AgentMessage[]> {
		const failureMessage = createFailureMessage(model, error, aborted);
		await this.handleAgentEvent({ type: "message_start", message: failureMessage }, signal);
		await this.handleAgentEvent({ type: "message_end", message: failureMessage }, signal);
		await this.handleAgentEvent({ type: "turn_end", message: failureMessage, toolResults: [] }, signal);
		await this.handleAgentEvent({ type: "agent_end", messages: [failureMessage] }, signal);
		return [failureMessage];
	}

	private async executeTurn(
		turnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>,
		text: string,
		options?: { images?: ImageContent[] },
	): Promise<AssistantMessage> {
		let activeTurnState = turnState;
		let messages: AgentMessage[] = [createUserMessage(text, options?.images)];
		if (this.nextTurnQueue.length > 0) {
			const queuedMessages = this.nextTurnQueue.splice(0);
			try {
				await this.emitQueueUpdate();
			} catch (error) {
				this.nextTurnQueue.unshift(...queuedMessages);
				throw normalizeHookError(error);
			}
			messages = [...queuedMessages, messages[0]!];
		}
		const beforeResult = await this.emitHook({
			type: "before_agent_start",
			prompt: text,
			images: options?.images,
			systemPrompt: turnState.systemPrompt,
			resources: turnState.resources,
		});
		if (beforeResult?.messages) messages = [...messages, ...beforeResult.messages];

		const abortController = new AbortController();
		const getTurnState = () => activeTurnState;
		const setTurnState = (nextTurnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>) => {
			activeTurnState = nextTurnState;
		};
		this.runAbortController = abortController;
		// PORT-DIVERGENCE: B4 — a trip belongs to exactly one run; never let a stale one leak in.
		this.pendingBudgetCapTrip = undefined;
		const runResultPromise = (async () => {
			try {
				return await runAgentLoop(
					messages,
					this.createContext(turnState, beforeResult?.systemPrompt),
					this.createLoopConfig(getTurnState, setTurnState),
					(event) => this.handleAgentEvent(event, abortController.signal),
					abortController.signal,
					this.createStreamFn(getTurnState),
				);
			} catch (error) {
				try {
					return await this.emitRunFailure(
						activeTurnState.model,
						error,
						abortController.signal.aborted,
						abortController.signal,
					);
				} catch (failureError) {
					const cause = new AggregateError(
						[toError(error), toError(failureError)],
						"Agent run failed and failure reporting failed",
					);
					throw new AgentHarnessError("unknown", cause.message, cause);
				}
			}
		})();
		try {
			const newMessages = await runResultPromise;
			// PORT-DIVERGENCE: B4 — the loop stopped itself on a tripped cap; surface it now that
			// it has unwound (`agent_end` emitted, session writes flushed below).
			const budgetCapTrip = this.takeBudgetCapTrip();
			if (budgetCapTrip) throw budgetCapTrip;
			for (let i = newMessages.length - 1; i >= 0; i--) {
				const message = newMessages[i]!;
				if (message.role === "assistant") {
					return message;
				}
			}
			throw new AgentHarnessError("invalid_state", "AgentHarness prompt completed without an assistant message");
		} finally {
			try {
				await this.flushPendingSessionWrites();
			} finally {
				this.runAbortController = undefined;
			}
		}
	}

	/**
	 * pie: agent_harness.rs:1732-1743 (`continue_`, the `Agent::continue_()` call it drives).
	 * Sibling of {@link executeTurn} for the "no new user message" case: reuses the identical
	 * hook wiring (`before_agent_start`, `tool_call`/`tool_result`, `prepareNextTurn`) and just
	 * swaps which agent-loop entry point runs. Any messages queued via {@link nextTurn} are still
	 * drained first (base-only feature, orthogonal to oracle's bare `continue_`) — when present,
	 * they become the "new" messages for this cycle and this degrades to the same `runAgentLoop`
	 * shape {@link executeTurn} uses; only a truly-empty queue takes the `runAgentLoopContinue`
	 * path (agent-loop.ts's port of oracle's `run_agent_loop_continue`), which requires the
	 * existing context to be non-empty.
	 */
	private async executeContinueTurn(
		turnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>,
	): Promise<AssistantMessage> {
		let activeTurnState = turnState;
		let queuedMessages: AgentMessage[] = [];
		if (this.nextTurnQueue.length > 0) {
			queuedMessages = this.nextTurnQueue.splice(0);
			try {
				await this.emitQueueUpdate();
			} catch (error) {
				this.nextTurnQueue.unshift(...queuedMessages);
				throw normalizeHookError(error);
			}
		}

		const beforeResult = await this.emitHook({
			type: "before_agent_start",
			prompt: "",
			images: undefined,
			systemPrompt: turnState.systemPrompt,
			resources: turnState.resources,
		});
		const prompts = [...queuedMessages, ...(beforeResult?.messages ?? [])];

		const abortController = new AbortController();
		const getTurnState = () => activeTurnState;
		const setTurnState = (nextTurnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>) => {
			activeTurnState = nextTurnState;
		};
		this.runAbortController = abortController;
		// PORT-DIVERGENCE: B4 — see the matching reset in `executeTurn`.
		this.pendingBudgetCapTrip = undefined;
		const context = this.createContext(turnState, beforeResult?.systemPrompt);
		const loopConfig = this.createLoopConfig(getTurnState, setTurnState);
		const emitEvent = (event: AgentEvent) => this.handleAgentEvent(event, abortController.signal);
		const streamFn = this.createStreamFn(getTurnState);
		const runResultPromise = (async () => {
			try {
				return prompts.length > 0
					? await runAgentLoop(prompts, context, loopConfig, emitEvent, abortController.signal, streamFn)
					: await runAgentLoopContinue(context, loopConfig, emitEvent, abortController.signal, streamFn);
			} catch (error) {
				try {
					return await this.emitRunFailure(
						activeTurnState.model,
						error,
						abortController.signal.aborted,
						abortController.signal,
					);
				} catch (failureError) {
					const cause = new AggregateError(
						[toError(error), toError(failureError)],
						"Agent run failed and failure reporting failed",
					);
					throw new AgentHarnessError("unknown", cause.message, cause);
				}
			}
		})();
		try {
			const newMessages = await runResultPromise;
			// PORT-DIVERGENCE: B4 — see the matching consume in `executeTurn`.
			const budgetCapTrip = this.takeBudgetCapTrip();
			if (budgetCapTrip) throw budgetCapTrip;
			for (let i = newMessages.length - 1; i >= 0; i--) {
				const message = newMessages[i]!;
				if (message.role === "assistant") {
					return message;
				}
			}
			throw new AgentHarnessError("invalid_state", "AgentHarness continue completed without an assistant message");
		} finally {
			try {
				await this.flushPendingSessionWrites();
			} finally {
				this.runAbortController = undefined;
			}
		}
	}

	/** pie: agent_harness.rs:1896-1905 (`last_user_text_from_state`). Walks the transcript in
	 * reverse and returns the text of the most recent user message with text content, if any. */
	private lastUserTextFromMessages(messages: readonly AgentMessage[]): string | undefined {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i]!;
			if (message.role !== "user") continue;
			const content = (message as { content: unknown }).content;
			if (typeof content === "string") {
				if (content.length > 0) return content;
				continue;
			}
			if (!Array.isArray(content)) continue;
			const text = content
				.filter((block): block is { type: "text"; text: string } => block?.type === "text")
				.map((block) => block.text)
				.join("\n");
			if (text.length > 0) return text;
		}
		return undefined;
	}

	/**
	 * pie: agent_harness.rs:1745-1880 (`run_turn_with_continuation`). Shared driver behind
	 * {@link prompt} / {@link promptFromTemplate} / {@link continue}: runs one prompt cycle, then
	 * — while {@link onTurnEnd} is configured — repeatedly asks it whether to run another cycle in
	 * the SAME conversation. `firstTurn.kind === "continue"` mirrors oracle's `first_msg = None`
	 * branch (`agent.continue_()`); every later iteration always re-prompts with hook-supplied
	 * text, matching oracle's "Subsequent iterations always go through `agent.prompt(<new user
	 * msg>)`" comment (agent_harness.rs:1769).
	 */
	private async runTurnWithContinuation(
		turnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>,
		firstTurn: { kind: "prompt"; text: string; images?: ImageContent[] } | { kind: "continue" },
		initialLastUserPrompt: string | undefined,
	): Promise<AssistantMessage> {
		let continuationCount = 0;
		let lastUserPrompt = initialLastUserPrompt;
		let assistantMessage: AssistantMessage =
			firstTurn.kind === "prompt"
				? await this.executeTurn(turnState, firstTurn.text, { images: firstTurn.images })
				: await this.executeContinueTurn(turnState);

		for (;;) {
			const hook = this.onTurnEnd;
			if (!hook) return assistantMessage;

			// pie: agent_harness.rs:1790-1804 — cap check happens BEFORE building the hook context /
			// invoking the hook, counted on `continuationCount` (only incremented by an earlier
			// `Continue` decision), never on the raw loop-iteration count.
			if (continuationCount >= this.turnContinuationCap) {
				await this.recordTurnEndDecision(
					"budget_limited",
					continuationCount,
					`continuation cap reached: ${continuationCount} >= ${this.turnContinuationCap}`,
					undefined,
					undefined,
				);
				return assistantMessage;
			}

			// pie: agent_harness.rs:1806-1808 — transcript snapshot taken AFTER the previous turn's
			// persistence listener has flushed to the session, so it matches what `--resume` would
			// replay.
			const postTurnState = await this.createTurnState();
			const ctx: OnTurnEndContext = {
				transcript: postTurnState.messages.slice(),
				continuationCount,
				lastUserPrompt,
			};
			const hookAbort = new AbortController();
			this.activeHookAbortController = hookAbort;
			let decision: TurnEndDecision;
			try {
				decision = await hook(ctx, hookAbort.signal);
			} finally {
				this.activeHookAbortController = undefined;
			}

			if (decision.action.kind === "noop") {
				return assistantMessage;
			}
			if (decision.action.kind === "stop") {
				await this.recordTurnEndDecision("stop", continuationCount, undefined, undefined, decision.payload);
				return assistantMessage;
			}
			if (decision.action.kind === "pause") {
				await this.recordTurnEndDecision(
					"pause",
					continuationCount,
					decision.action.reason,
					undefined,
					decision.payload,
				);
				return assistantMessage;
			}

			// decision.action.kind === "continue"
			continuationCount += 1;
			const preview = previewForBanner(decision.action.prompt, 80);
			await this.recordTurnEndDecision("continue", continuationCount, undefined, preview, decision.payload);

			// pie: agent_harness.rs:1864-1869 — re-check the budget cap AND re-run auto-compaction
			// before the next iteration; a `Continue` decision cannot bypass a tripped cap. This
			// between-cycles check is oracle's and is unchanged; the mid-loop gate that phase 18
			// added alongside it is documented on `budgetCapError` (PORT-DIVERGENCE: B4).
			this.checkBudgetCap();
			await this.runAutoCompaction();
			lastUserPrompt = decision.action.prompt;
			const nextTurnState = await this.createTurnState();
			assistantMessage = await this.executeTurn(nextTurnState, decision.action.prompt);
		}
	}

	/**
	 * pie: agent_harness.rs:1907-1942 (`record_turn_end_decision`). Persists a `turn_end_decision`
	 * audit entry and emits the matching `HarnessEvent.turn_ended`. Best-effort: a persistence
	 * failure does not abort the surrounding prompt cycle (the event still fires so observers can
	 * flag the lost audit), matching the trigger-audit reflux pattern used elsewhere in this file.
	 */
	private async recordTurnEndDecision(
		decision: "stop" | "pause" | "continue" | "budget_limited",
		continuationCount: number,
		reason: string | undefined,
		nextPromptPreview: string | undefined,
		payload: unknown,
	): Promise<void> {
		const data = {
			decision,
			continuation_count: continuationCount,
			reason: reason ?? null,
			next_prompt_preview: nextPromptPreview ?? null,
			payload: payload ?? null,
		};
		try {
			await this.session.appendCustomEntry("turn_end_decision", data);
		} catch (error) {
			this.emitHarnessEvent({
				type: "persistence_error",
				context: "turn_end_decision",
				message: `turn_end_decision append failed: ${toError(error).message}`,
			});
		}
		this.emitHarnessEvent({
			type: "turn_ended",
			decision,
			continuationCount,
			reason,
			nextPromptPreview,
		});
	}

	/**
	 * pie: agent_harness.rs:1953-2018 (`run_evaluator`). Runs a tool-less, in-memory evaluator
	 * sub-agent and returns its last assistant text (capped to 4KiB by the shared
	 * {@link lastAssistantText} helper — same cap `runSubAgentDelivery` applies to trigger
	 * summaries). Used by {@link OnTurnEndHook} implementations (e.g. `/goal`'s stop hook) that
	 * need "is the condition met by this transcript?" without touching the parent session, cost
	 * tracker, or audit log.
	 *
	 * Two deviations from oracle's bare inner-`Agent` construction, both forced by base's
	 * architecture (no equivalent "raw `self.stream_fn`" slot separate from the harness's own
	 * auth-resolving stream function — see divergence-ledger.tsv `agent/harness/agent_harness-continuation`):
	 * - Auth is resolved via {@link createStreamFn}, the harness's only channel for
	 *   `getApiKeyAndHeaders` — a real network call needs it. This also fires the base-only
	 *   `before_provider_request`/`before_provider_payload` hooks, a base concept with no oracle
	 *   counterpart to bypass; a benign superset for embedders that use them.
	 * - `tool_call`/`tool_result` hooks are never wired (the loop config below omits
	 *   `beforeToolCall`/`afterToolCall` entirely) — belt-and-suspenders on top of `tools: []`,
	 *   matching oracle's explicit "Intentionally no before/after_tool_call hooks — evaluator has
	 *   no tools" comment.
	 *
	 * Cost is NOT attributed to the parent `CostTracker`: this method never calls
	 * `handleAgentEvent` (the only place `costTracker.record()` is invoked), so the evaluator's
	 * usage is silently discarded, matching oracle's "same honesty rule the
	 * `trigger_result.cost_usd: null` audit follows" comment.
	 */
	async runEvaluator(
		systemPrompt: string,
		userPrompt: string,
		model: Model<any>,
		thinkingLevel: ThinkingLevel,
		signal: AbortSignal,
	): Promise<EvaluatorOutput> {
		const evalTurnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool> = {
			messages: [],
			resources: {},
			streamOptions: cloneStreamOptions(this.streamOptions),
			sessionId: "",
			systemPrompt,
			model,
			thinkingLevel,
			tools: [],
			activeTools: [],
		};
		const context: AgentContext = { systemPrompt, messages: [], tools: [] };
		const loopConfig: AgentLoopConfig = {
			model,
			reasoning: thinkingLevel === "off" ? undefined : thinkingLevel,
			convertToLlm,
		};
		const observed: AgentMessage[] = [];
		try {
			await runAgentLoop(
				[createUserMessage(userPrompt)],
				context,
				loopConfig,
				(event) => {
					if (event.type === "message_end") observed.push(event.message);
				},
				signal,
				this.createStreamFn(() => evalTurnState),
			);
		} catch (error) {
			if (signal.aborted) throw new EvaluatorError("cancelled", "evaluator cancelled");
			throw new EvaluatorError("run", `evaluator agent failed: ${toError(error).message}`, { cause: error });
		}
		return { lastAssistantText: lastAssistantText(observed) };
	}

	/**
	 * pie: agent_harness.rs:1884-1893 (`check_budget_cap`).
	 *
	 * PORT-DIVERGENCE: B4 (RULEBOOK §5; oracle agent_harness.rs:1716-1729, 1882-1893).
	 * **Fixed in phase 18 — this no longer matches oracle.**
	 *
	 * Oracle evaluates the cap in exactly two places: once at the top of `prompt()` / `skill()` /
	 * `prompt_from_template()` / `continue_()`, and once more before each `TurnEndAction::Continue`
	 * iteration (agent_harness.rs:1868). It is never consulted from inside the agent loop's
	 * LLM→tool→LLM round trips, so a single `prompt()` keeps issuing provider requests
	 * indefinitely after the cap is already blown — the cap only blocks the *next* top-level call.
	 * A user who sets `budget_cap_usd` to bound spend on a runaway tool loop gets no protection
	 * from that loop at all, which is the only situation the setting exists for.
	 *
	 * Here the cap is additionally a **hard gate inside the loop**: `createLoopConfig`'s
	 * `shouldStopAfterTurn` re-checks it after each assistant message's usage has been folded into
	 * the cost tracker and before the loop would issue the next provider request (see
	 * {@link budgetCapStopsLoop}). Both oracle checks are kept exactly as they were — they are
	 * correct, just insufficient — so this is purely additive.
	 *
	 * Unchanged from oracle: an unset (`undefined`) cap never trips, the error kind stays
	 * `invalid_state`, and the message text is byte-identical at every gate (this method is the
	 * single source of both).
	 */
	private budgetCapError(): AgentHarnessError | undefined {
		if (this.budgetCapUsd === undefined) return undefined;
		const total = this.costTracker.snapshot().tokens.cost.total;
		if (total < this.budgetCapUsd) return undefined;
		return new AgentHarnessError(
			"invalid_state",
			`budget cap reached: $${total.toFixed(4)} >= $${this.budgetCapUsd.toFixed(4)}. Reset with resetCost() or raise budgetCapUsd.`,
		);
	}

	/**
	 * pie: agent_harness.rs:1884-1893 (`check_budget_cap`), called from
	 * agent_harness.rs:1716-1729 (`prompt_with_message`), :1732-1734 (`continue_`) and :1868
	 * (the `TurnEndAction::Continue` re-check `runTurnWithContinuation` mirrors, per
	 * migration/reviews/agent/gap-continuation.md's hand-off). The between-cycles gate, unchanged.
	 */
	private checkBudgetCap(): void {
		const error = this.budgetCapError();
		if (error) throw error;
	}

	/**
	 * PORT-DIVERGENCE: B4 — the mid-loop half of the gate (see {@link budgetCapError}). Wired as
	 * the agent loop's `shouldStopAfterTurn`, which the loop calls after `turn_end` has been
	 * emitted (so the just-finished assistant message's usage is already in `costTracker`, folded
	 * in by `handleAgentEvent`'s `message_end` branch) and before it decides whether to start
	 * another provider request.
	 *
	 * Stopping is expressed as `true` — the loop's own graceful-stop primitive — rather than a
	 * throw: `shouldStopAfterTurn`'s contract forbids throwing ("interrupts the low-level agent
	 * loop without producing a normal event sequence"), and returning `true` makes the loop emit
	 * `agent_end` and unwind normally, so the current tool batch is already finished, no tool
	 * execution is orphaned, no abort listener is left behind, and `phase` still returns to
	 * `idle`. The error itself is parked in `pendingBudgetCapTrip` and thrown by the owning
	 * `executeTurn`/`executeContinueTurn` once the loop has unwound.
	 *
	 * The gate only fires when another provider request would actually follow: a tool-use stop
	 * reason, or a queued steering/follow-up message that the loop is about to drain and inject.
	 * A turn that ends the run anyway is never converted into a failure — blowing the cap on the
	 * final message is not something a cap could have prevented. (One known false positive: a tool
	 * batch that unanimously requests `terminate` also ends the run, but `shouldStopAfterTurn`
	 * runs before that hard-stop and cannot see it — the run stops either way, and the caller gets
	 * the cap error instead of the final message.)
	 */
	private budgetCapStopsLoop(message: AssistantMessage): boolean {
		const willIssueAnotherRequest =
			message.stopReason === "toolUse" || this.steerQueue.length > 0 || this.followUpQueue.length > 0;
		if (!willIssueAnotherRequest) return false;
		const error = this.budgetCapError();
		if (!error) return false;
		this.pendingBudgetCapTrip = error;
		return true;
	}

	/** PORT-DIVERGENCE: B4 — consumes a mid-loop trip parked by {@link budgetCapStopsLoop}. */
	private takeBudgetCapTrip(): AgentHarnessError | undefined {
		const error = this.pendingBudgetCapTrip;
		this.pendingBudgetCapTrip = undefined;
		return error;
	}

	/** pie: agent_harness.rs:1046-1048 (`AgentHarness::cost`). */
	cost(): CostSnapshot {
		return this.costTracker.snapshot();
	}

	/** pie: agent_harness.rs:1050-1053 (`AgentHarness::reset_cost`). `/cost reset` and session-switch. */
	resetCost(): void {
		this.costTracker.reset();
	}

	/** pie: agent_harness.rs:1684-1692 (`prompt`) + :1716-1730 (`prompt_with_message`, the shared
	 * driver `prompt`/`prompt_with_images` funnel into). Routes through
	 * {@link runTurnWithContinuation} so a configured {@link onTurnEnd} hook (e.g. `/goal`'s stop
	 * hook) gets a chance to auto-continue the SAME prompt cycle after this turn completes. */
	async prompt(text: string, options?: { images?: ImageContent[] }): Promise<AssistantMessage> {
		if (this.phase !== "idle") throw new AgentHarnessError("busy", "AgentHarness is busy");
		this.phase = "turn";
		const finishRunPromise = this.startRunPromise();
		try {
			this.checkBudgetCap();
			await this.runAutoCompaction();
			const turnState = await this.createTurnState();
			// pie: agent_harness.rs:1727 (`extract_user_prompt_text`) — `None` for empty text; here
			// that's just "falls back to undefined" since `text` IS the already-extracted text.
			return await this.runTurnWithContinuation(
				turnState,
				{ kind: "prompt", text, images: options?.images },
				text.length > 0 ? text : undefined,
			);
		} catch (error) {
			this.phase = "idle";
			throw normalizeHarnessError(error, "unknown");
		} finally {
			finishRunPromise();
		}
	}

	async skill(name: string, additionalInstructions?: string): Promise<AssistantMessage> {
		if (this.phase !== "idle") throw new AgentHarnessError("busy", "AgentHarness is busy");
		this.phase = "turn";
		const finishRunPromise = this.startRunPromise();
		try {
			this.checkBudgetCap();
			await this.runAutoCompaction();
			const turnState = await this.createTurnState();
			const skill = (turnState.resources.skills ?? []).find((candidate) => candidate.name === name);
			if (!skill) throw new AgentHarnessError("invalid_argument", `Unknown skill: ${name}`);
			return await this.executeTurn(turnState, formatSkillInvocation(skill, additionalInstructions));
		} catch (error) {
			this.phase = "idle";
			throw normalizeHarnessError(error, "unknown");
		} finally {
			finishRunPromise();
		}
	}

	/**
	 * pie: agent_harness.rs:1662-1681 (`AgentHarness::prompt_from_template`). Looks the template
	 * up by name and interpolates NAMED `{{var}}` placeholders (`PromptTemplateRegistry.
	 * interpolate`, prompt-templates.ts) before prompting — oracle's exact mechanism. This is a
	 * DIFFERENT, coexisting mechanism from the base's own pre-existing `formatPromptTemplateInvocation`/
	 * `substituteArgs` bash-style POSITIONAL `$1`/`$@`/`${@:N}` substitution (prompt-templates.ts),
	 * which remains exported/unit-tested and untouched — this method just switches which
	 * mechanism `AgentHarness.promptFromTemplate` itself drives, matching oracle's own
	 * `prompt_from_template(name, vars)` signature (see divergence-ledger.tsv
	 * `agent/harness/prompt_templates` row: the two mechanisms are additive, not a replacement).
	 */
	async promptFromTemplate(name: string, vars: Record<string, unknown> = {}): Promise<AssistantMessage> {
		if (this.phase !== "idle") throw new AgentHarnessError("busy", "AgentHarness is busy");
		this.phase = "turn";
		const finishRunPromise = this.startRunPromise();
		try {
			this.checkBudgetCap();
			await this.runAutoCompaction();
			const turnState = await this.createTurnState();
			const template = (turnState.resources.promptTemplates ?? []).find((candidate) => candidate.name === name);
			if (!template) throw new AgentHarnessError("invalid_argument", `Unknown prompt template: ${name}`);
			const rendered = PromptTemplateRegistry.interpolate(template, vars);
			// pie: agent_harness.rs:1680 (`prompt_from_template` ends with `self.prompt(rendered).await`)
			// — oracle's own `prompt_from_template` is a thin wrapper around `prompt`, so it too goes
			// through `run_turn_with_continuation`; mirrored here via the same shared driver `prompt()`
			// uses rather than calling `executeTurn` directly.
			return await this.runTurnWithContinuation(
				turnState,
				{ kind: "prompt", text: rendered },
				rendered.length > 0 ? rendered : undefined,
			);
		} catch (error) {
			this.phase = "idle";
			throw normalizeHarnessError(error, "unknown");
		} finally {
			finishRunPromise();
		}
	}

	/**
	 * pie: agent_harness.rs:1732-1743 (`continue_`). Continues the CURRENT session context — no
	 * new user message is appended (`runAgentLoopContinue`, agent-loop.ts's port of oracle's
	 * `run_agent_loop_continue` / `Agent::continue_`) — then runs the SAME `onTurnEnd`
	 * continuation-hook loop {@link prompt} does. `lastUserPrompt` is filled from the most recent
	 * user-text message already in the session (agent_harness.rs:1896-1905
	 * `last_user_text_from_state`) so evaluators still see "what the user originally asked for" on
	 * a bare continue. Ported per migration/reviews/agent/gap-continuation.md (phase 8 gap; the
	 * CLI `--continue` flag consumer lands in phase 13).
	 */
	async continue(): Promise<AssistantMessage> {
		if (this.phase !== "idle") throw new AgentHarnessError("busy", "AgentHarness is busy");
		this.phase = "turn";
		const finishRunPromise = this.startRunPromise();
		try {
			this.checkBudgetCap();
			await this.runAutoCompaction();
			const turnState = await this.createTurnState();
			const lastUserPrompt = this.lastUserTextFromMessages(turnState.messages);
			return await this.runTurnWithContinuation(turnState, { kind: "continue" }, lastUserPrompt);
		} catch (error) {
			this.phase = "idle";
			throw normalizeHarnessError(error, "unknown");
		} finally {
			finishRunPromise();
		}
	}

	async steer(text: string, options?: { images?: ImageContent[] }): Promise<void> {
		if (this.phase === "idle") throw new AgentHarnessError("invalid_state", "Cannot steer while idle");
		this.steerQueue.push(createUserMessage(text, options?.images));
		await this.emitQueueUpdate();
	}

	async followUp(text: string, options?: { images?: ImageContent[] }): Promise<void> {
		if (this.phase === "idle") throw new AgentHarnessError("invalid_state", "Cannot follow up while idle");
		this.followUpQueue.push(createUserMessage(text, options?.images));
		await this.emitQueueUpdate();
	}

	async nextTurn(text: string, options?: { images?: ImageContent[] }): Promise<void> {
		this.nextTurnQueue.push(createUserMessage(text, options?.images));
		await this.emitQueueUpdate();
	}

	async appendMessage(message: AgentMessage): Promise<void> {
		try {
			if (this.phase === "idle") {
				await this.session.appendMessage(message);
			} else {
				this.pendingSessionWrites.push({ type: "message", message });
			}
		} catch (error) {
			throw normalizeHarnessError(error, "session");
		}
	}

	/** pie: agent_harness.rs:1565-1568 (`set_compaction_settings`). Updates the auto/force
	 * compaction thresholds used by every subsequent `compact()`/auto-compaction run. */
	setCompactionSettings(settings: CompactionSettings): void {
		this.compactionSettings = settings;
	}

	/**
	 * pie: agent_harness.rs:2043-2115 (`do_compact`, the shared implementation behind both
	 * `force_compact` and `run_auto_compaction`). Every "there was nothing to do" outcome — no
	 * model, a branch-read failure, nothing found worth compacting, or an empty/aborted
	 * summarization — resolves to `{ ran: false }` rather than throwing, mirroring oracle's
	 * `Result<bool, AgentRunError>` contract where only a genuine summarization failure
	 * propagates as an `Err`.
	 *
	 * `fromHook` is oracle's `do_compact(from_hook, ..)` parameter verbatim
	 * (agent_harness.rs:2046-2054): `true` for the explicit `force_compact` / `/compact` path
	 * (:1946-1951), `false` for threshold-driven auto-compaction (:2020-2039). It is forwarded
	 * unchanged onto `session_compact` because `coding-agent/src/hooks.ts` maps it to the
	 * `compaction_trigger` hook field ("manual" vs "auto", oracle hooks.rs:743-747). It is NOT
	 * the "did a hook supply the compaction result" flag — that orthogonal property is what the
	 * pi skeleton emitted here, which made a manual `/compact` report itself as `"auto"`.
	 */
	private async doCompact(
		fromHook: boolean,
		customInstructions: string | undefined,
	): Promise<{ ran: true; result: CompactResult } | { ran: false }> {
		const model = this.model;
		if (!model) return { ran: false };

		let branchEntries: SessionTreeEntry[];
		try {
			branchEntries = await this.session.getBranch();
		} catch {
			// pie: agent_harness.rs:2057-2069 — a branch-read failure is non-fatal: skip this
			// compaction attempt, append nothing, mutate nothing. oracle also emits a diagnostic
			// `HarnessEvent::Compaction` here; TS's `HarnessEvent` union deliberately excludes a
			// Compaction variant (this file's header comment, agent_harness.rs:59-68 mapping —
			// an already-adjudicated architecture decision to carry only trigger-lifecycle
			// events), and `./types.ts`'s own event union is off-limits to this task, so there is
			// no equivalent diagnostic channel to surface this on.
			return { ran: false };
		}

		const preparationResult = prepareCompaction(branchEntries, this.compactionSettings);
		if (!preparationResult.ok) throw preparationResult.error;
		const preparation = preparationResult.value;
		if (!preparation) return { ran: false };

		const hookResult = await this.emitHook({
			type: "session_before_compact",
			preparation,
			branchEntries,
			customInstructions,
			signal: new AbortController().signal,
		});
		if (hookResult?.cancel) throw new AgentHarnessError("compaction", "Compaction cancelled");
		const provided = hookResult?.compaction;

		let result: CompactResult;
		if (provided) {
			result = provided;
		} else {
			const auth = await this.getApiKeyAndHeaders?.(model);
			if (!auth) throw new AgentHarnessError("auth", "No auth available for compaction");
			const compactResult = await compact(
				preparation,
				model,
				auth.apiKey,
				auth.headers,
				customInstructions,
				undefined,
				this.thinkingLevel,
			);
			if (!compactResult.ok) {
				// pie: agent_harness.rs:2100-2101 (`Err(SummarizeError::Aborted) => Ok(false)`).
				if (compactResult.error.code === "aborted") return { ran: false };
				throw compactResult.error;
			}
			result = compactResult.value;
			// pie: agent_harness.rs:2098-2099 (`Ok(r) if !r.summary.is_empty()` / `Ok(_) => Ok(false)`).
			if (!result.summary) return { ran: false };
		}

		// The PERSISTED `fromHook` keeps its pi-skeleton meaning ("an extension supplied this
		// compaction's content"): `compaction/compaction.ts`'s `extractFileOperations` reads it
		// back to decide whether the previous compaction's `details` are pi-generated and safe to
		// inherit. Oracle has no `details` at all (it always passes `None`, agent_harness.rs
		// :2098-2107), so its record-level `from_hook` is write-only and carries no behavior —
		// there is nothing to be faithful to here, and reusing it for manual/auto would silently
		// drop file-operation inheritance after every `/compact`.
		const entryId = await this.session.appendCompaction(
			result.summary,
			result.firstKeptEntryId,
			result.tokensBefore,
			result.details,
			provided !== undefined,
		);
		const entry = await this.session.getEntry(entryId);
		if (entry?.type === "compaction") {
			// pie: agent_harness.rs:2109-2113 — `HarnessEvent::Compaction { from_hook, .. }` gets
			// `do_compact`'s parameter verbatim, NOT a re-derived value.
			await this.emitOwn({ type: "session_compact", compactionEntry: entry, fromHook });
		}
		return { ran: true, result };
	}

	/** pie: agent_harness.rs:1946-1950 (`force_compact`). Manually trigger compaction now,
	 * using the harness's current `compactionSettings` (constructor `compaction` option /
	 * {@link setCompactionSettings}) rather than a hardcoded default. */
	async compact(customInstructions?: string): Promise<{ ran: true; result: CompactResult } | { ran: false }> {
		if (this.phase !== "idle") throw new AgentHarnessError("busy", "compact() requires idle harness");
		this.phase = "compaction";
		try {
			// pie: agent_harness.rs:1946-1951 — `force_compact` passes `from_hook: true`.
			return await this.doCompact(true, customInstructions);
		} catch (error) {
			throw normalizeHarnessError(error, "compaction");
		} finally {
			this.phase = "idle";
		}
	}

	/**
	 * pie: agent_harness.rs:2020-2035 (`run_auto_compaction`). Called from `prompt`/`skill`/
	 * `promptFromTemplate` right after the budget-cap check and before the turn's message list
	 * is built — oracle: "This must happen before the user message is appended so the cut point
	 * doesn't risk splitting the current turn." Silently no-ops when compaction is disabled, no
	 * model is set, or the 80%-of-context-window threshold ({@link shouldCompact}) isn't
	 * crossed. Genuine compaction failures propagate to the caller's existing try/catch, the
	 * same way `checkBudgetCap()` already does.
	 */
	private async runAutoCompaction(): Promise<void> {
		if (!this.compactionSettings.enabled) return;
		const model = this.model;
		if (!model) return;
		const context = await this.session.buildContext();
		const contextTokens = estimateContextTokens(context.messages).tokens;
		if (!shouldCompact(contextTokens, model.contextWindow, this.compactionSettings)) return;
		// pie: agent_harness.rs:2020-2039 — `run_auto_compaction` passes `from_hook: false`.
		await this.doCompact(false, undefined);
	}

	async navigateTree(
		targetId: string,
		options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
	): Promise<NavigateTreeResult> {
		if (this.phase !== "idle") throw new AgentHarnessError("busy", "navigateTree() requires idle harness");
		this.phase = "branch_summary";
		try {
			const oldLeafId = await this.session.getLeafId();
			if (oldLeafId === targetId) return { cancelled: false };
			const targetEntry = await this.session.getEntry(targetId);
			if (!targetEntry) throw new AgentHarnessError("invalid_argument", `Entry ${targetId} not found`);
			const { entries, commonAncestorId } = await collectEntriesForBranchSummary(this.session, oldLeafId, targetId);
			const preparation = {
				targetId,
				oldLeafId,
				commonAncestorId,
				entriesToSummarize: entries,
				userWantsSummary: options?.summarize ?? false,
				customInstructions: options?.customInstructions,
				replaceInstructions: options?.replaceInstructions,
				label: options?.label,
			};
			const signal = new AbortController().signal;
			const hookResult = await this.emitHook({ type: "session_before_tree", preparation, signal });
			if (hookResult?.cancel) return { cancelled: true };
			let summaryEntry: NavigateTreeResult["summaryEntry"];
			let summaryText: string | undefined = hookResult?.summary?.summary;
			let summaryDetails: unknown = hookResult?.summary?.details;
			if (!summaryText && options?.summarize && entries.length > 0) {
				const model = this.model;
				if (!model) throw new AgentHarnessError("invalid_state", "No model set for branch summary");
				const auth = await this.getApiKeyAndHeaders?.(model);
				if (!auth) throw new AgentHarnessError("auth", "No auth available for branch summary");
				const branchSummary = await generateBranchSummary(entries, {
					model,
					apiKey: auth.apiKey,
					headers: auth.headers,
					signal: new AbortController().signal,
					customInstructions: hookResult?.customInstructions ?? options?.customInstructions,
					replaceInstructions: hookResult?.replaceInstructions ?? options?.replaceInstructions,
				});
				if (!branchSummary.ok) {
					if (branchSummary.error.code === "aborted") return { cancelled: true };
					throw new AgentHarnessError("branch_summary", branchSummary.error.message, branchSummary.error);
				}
				summaryText = branchSummary.value.summary;
				summaryDetails = {
					readFiles: branchSummary.value.readFiles,
					modifiedFiles: branchSummary.value.modifiedFiles,
				};
			}
			let editorText: string | undefined;
			let newLeafId: string | null;
			if (targetEntry.type === "message" && targetEntry.message.role === "user") {
				newLeafId = targetEntry.parentId;
				const content = targetEntry.message.content;
				editorText =
					typeof content === "string"
						? content
						: content
								.filter((c): c is { readonly type: "text"; readonly text: string } => c.type === "text")
								.map((c) => c.text)
								.join("");
			} else if (targetEntry.type === "custom_message") {
				newLeafId = targetEntry.parentId;
				editorText =
					typeof targetEntry.content === "string"
						? targetEntry.content
						: targetEntry.content
								.filter((c): c is { readonly type: "text"; readonly text: string } => c.type === "text")
								.map((c) => c.text)
								.join("");
			} else {
				newLeafId = targetId;
			}
			const summaryId = await this.session.moveTo(
				newLeafId,
				summaryText
					? { summary: summaryText, details: summaryDetails, fromHook: hookResult?.summary !== undefined }
					: undefined,
			);
			if (summaryId) {
				const entry = await this.session.getEntry(summaryId);
				if (entry?.type === "branch_summary") summaryEntry = entry;
			}
			// pie: agent_harness.rs:1616-1630 (`AgentHarness::move_to`) rehydrates model/thinking
			// level from the new branch's session context right after `session.move_to`, before
			// emitting the Branch/`session_tree` event — mirrored here (gap #4: `navigateTree`
			// previously never rehydrated `this.thinkingLevel`/`this.model` after a branch switch).
			await this.rehydrateFromSession();
			await this.emitOwn({
				type: "session_tree",
				newLeafId: await this.session.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromHook: hookResult?.summary !== undefined,
			});
			return { cancelled: false, editorText, summaryEntry };
		} catch (error) {
			throw normalizeHarnessError(error, "branch_summary");
		} finally {
			this.phase = "idle";
		}
	}

	/**
	 * pie: agent_harness.rs:1639-1659 (`AgentHarness::rehydrate_from_session`). Restores model +
	 * thinking level from the session's active branch (`Session::buildContext()`, TS's
	 * counterpart of oracle's `Session::build_context()`). Unlike oracle, TS's per-turn state
	 * (`messages`) is ALREADY rebuilt fresh from `session.buildContext()` on every
	 * `prompt()`/`skill()`/`promptFromTemplate()` call (see `createTurnState()`), so there is no
	 * separate persistent `state.messages` field to overwrite here — this method's job narrows to
	 * the two fields that DO persist across turns as harness instance state: `this.model` and
	 * `this.thinkingLevel`. CLI `--resume` and `navigateTree()`'s post-move rehydration both route
	 * through this one place, matching oracle's stated rationale.
	 *
	 * Mirrors oracle: the model is restored only when the `(provider, id)` pair resolves in the
	 * built-in `@pie/ai` model catalog (`getModel`); an unknown provider/model (e.g. a
	 * test's faux model, or a custom-registered model absent from the static catalog) leaves the
	 * current in-memory model untouched rather than being blown away with `undefined`.
	 */
	async rehydrateFromSession(): Promise<SessionContext> {
		const ctx = await this.session.buildContext();
		if (ctx.model) {
			const catalogModel = (getCatalogModel as (provider: string, modelId: string) => Model<any> | undefined)(
				ctx.model.provider,
				ctx.model.modelId,
			);
			if (catalogModel) this.model = catalogModel;
		}
		if (isThinkingLevel(ctx.thinkingLevel)) this.thinkingLevel = ctx.thinkingLevel;
		return ctx;
	}

	/**
	 * pie: agent_harness.rs:1511-1513 (`AgentHarness::system_prompt`). Oracle's method is a
	 * synchronous getter over a single cached `base + skills` composition maintained by the
	 * constructor/`replace_skills`/`reload_skills_from_disk`. TS's `systemPrompt` constructor
	 * option additionally supports a turn-context-dependent async function (a pre-existing base
	 * capability unrelated to this port); that form has no fixed value outside a turn, so this
	 * getter mirrors oracle only for the plain-string form — the form oracle's own composition
	 * models and the form all of oracle's `system_prompt()` callers actually use. Composing with
	 * the LIVE skill catalog (not a cached snapshot) still matches oracle: `replace_skills`/
	 * `reload_skills_from_disk` rebuild oracle's cached prompt eagerly, so reading it always
	 * reflects the current catalog either way.
	 */
	getSystemPrompt(): string {
		if (typeof this.systemPrompt !== "string") {
			throw new AgentHarnessError(
				"invalid_state",
				"getSystemPrompt() requires systemPrompt to be configured as a plain string; a turn-context function has no fixed value outside a turn",
			);
		}
		return buildSystemPrompt(this.systemPrompt, this.resources.skills ?? []);
	}

	getModel(): Model<any> {
		return this.model;
	}

	getThinkingLevel(): ThinkingLevel {
		return this.thinkingLevel;
	}

	async setModel(model: Model<any>): Promise<void> {
		try {
			const previousModel = this.model;
			if (this.phase === "idle") {
				await this.session.appendModelChange(model.provider, model.id);
			} else {
				this.pendingSessionWrites.push({ type: "model_change", provider: model.provider, modelId: model.id });
			}
			this.model = model;
			await this.emitOwn({ type: "model_select", model, previousModel, source: "set" });
		} catch (error) {
			throw normalizeHarnessError(error, "session");
		}
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		try {
			const previousLevel = this.thinkingLevel;
			if (this.phase === "idle") {
				await this.session.appendThinkingLevelChange(level);
			} else {
				this.pendingSessionWrites.push({ type: "thinking_level_change", thinkingLevel: level });
			}
			this.thinkingLevel = level;
			await this.emitOwn({ type: "thinking_level_select", level, previousLevel });
		} catch (error) {
			throw normalizeHarnessError(error, "session");
		}
	}

	async setActiveTools(toolNames: string[]): Promise<void> {
		try {
			this.validateToolNames(toolNames);
			this.activeToolNames = [...toolNames];
		} catch (error) {
			throw normalizeHarnessError(error, "invalid_argument");
		}
	}

	getSteeringMode(): QueueMode {
		return this.steeringQueueMode;
	}

	async setSteeringMode(mode: QueueMode): Promise<void> {
		this.steeringQueueMode = mode;
	}

	getFollowUpMode(): QueueMode {
		return this.followUpQueueMode;
	}

	async setFollowUpMode(mode: QueueMode): Promise<void> {
		this.followUpQueueMode = mode;
	}

	getResources(): AgentHarnessResources<TSkill, TPromptTemplate> {
		return {
			skills: this.resources.skills?.slice(),
			promptTemplates: this.resources.promptTemplates?.slice(),
		};
	}

	async setResources(resources: AgentHarnessResources<TSkill, TPromptTemplate>): Promise<void> {
		const previousResources = this.getResources();
		this.resources = {
			skills: resources.skills?.slice(),
			promptTemplates: resources.promptTemplates?.slice(),
		};
		await this.emitOwn({ type: "resources_update", resources: this.getResources(), previousResources });
	}

	/**
	 * pie: agent_harness.rs:1538-1552 (`AgentHarness::reload_skills_from_disk`). Hot-reloads the
	 * skill catalog via the embedder-supplied `reloadSkillsFn` closure (see
	 * `AgentHarnessTriggerOptions.reloadSkillsFn`) — used by `InstallSkillTool`, `/skills reload`,
	 * and any future control-plane that needs to refresh the catalog after a filesystem write.
	 * Only swaps `this.resources.skills` (and therefore what the next `getSystemPrompt()`/turn
	 * sees); does NOT touch `this.phase`, queued messages, or persisted session entries — an
	 * in-flight turn's own `createTurnState()` snapshot is unaffected mid-turn, matching oracle's
	 * "no mid-turn prompt mutation" guarantee. Throws when no loader was configured at
	 * construction (oracle: `ReloadSkillsError::NotConfigured`) instead of silently no-opping.
	 */
	async reloadSkillsFromDisk(): Promise<{ skills: TSkill[]; diagnostics: SkillDiagnostic[] }> {
		const loader = this.reloadSkillsFn;
		if (!loader) {
			throw new AgentHarnessError("invalid_state", "reloadSkillsFn was not configured at harness construction");
		}
		const result = await loader();
		this.resources = {
			skills: result.skills.slice(),
			promptTemplates: this.resources.promptTemplates?.slice(),
		};
		this.emitHarnessEvent({ type: "skills_reloaded", total: result.skills.length });
		return result;
	}

	getStreamOptions(): AgentHarnessStreamOptions {
		return cloneStreamOptions(this.streamOptions);
	}

	async setStreamOptions(streamOptions: AgentHarnessStreamOptions): Promise<void> {
		this.streamOptions = cloneStreamOptions(streamOptions);
	}

	async setTools(tools: TTool[], activeToolNames?: string[]): Promise<void> {
		try {
			const nextTools = new Map(tools.map((tool) => [tool.name, tool]));
			const nextActiveToolNames = activeToolNames ? [...activeToolNames] : this.activeToolNames;
			this.validateToolNames(nextActiveToolNames, nextTools);
			this.tools = nextTools;
			this.activeToolNames = [...nextActiveToolNames];
		} catch (error) {
			throw normalizeHarnessError(error, "invalid_argument");
		}
	}

	async abort(): Promise<AbortResult> {
		const clearedSteer = [...this.steerQueue];
		const clearedFollowUp = [...this.followUpQueue];
		this.steerQueue = [];
		this.followUpQueue = [];
		this.runAbortController?.abort();
		// pie: agent_harness.rs:1570-1577 (`abort`) — cancels `active_hook_cancel` in addition to
		// the inner agent's cancel token, so an in-flight `onTriggerPrompt` hook (see
		// `resolveTriggerPrompt`) observes the abort and can resolve promptly instead of hanging.
		this.activeHookAbortController?.abort();
		const errors: Error[] = [];
		try {
			await this.emitQueueUpdate();
		} catch (error) {
			errors.push(toError(error));
		}
		try {
			await this.waitForIdle();
		} catch (error) {
			errors.push(toError(error));
		}
		try {
			await this.emitOwn({ type: "abort", clearedSteer, clearedFollowUp });
		} catch (error) {
			errors.push(toError(error));
		}
		if (errors.length > 0) {
			const cause = errors.length === 1 ? errors[0]! : new AggregateError(errors, "Abort completed with errors");
			throw normalizeHarnessError(cause, "hook");
		}
		return { clearedSteer, clearedFollowUp };
	}

	async waitForIdle(): Promise<void> {
		await this.runPromise;
	}

	subscribe(
		listener: (event: AgentHarnessEvent<TSkill, TPromptTemplate>, signal?: AbortSignal) => Promise<void> | void,
	): () => void {
		let handlers = this.handlers.get(SUBSCRIBER_EVENT_TYPE);
		if (!handlers) {
			handlers = new Set();
			this.handlers.set(SUBSCRIBER_EVENT_TYPE, handlers);
		}
		handlers.add(listener as AgentHarnessHandler);
		return () => handlers!.delete(listener as AgentHarnessHandler);
	}

	on<TType extends keyof AgentHarnessEventResultMap>(
		type: TType,
		handler: (
			event: Extract<AgentHarnessOwnEvent, { type: TType }>,
		) => Promise<AgentHarnessEventResultMap[TType]> | AgentHarnessEventResultMap[TType],
	): () => void {
		let handlers = this.handlers.get(type);
		if (!handlers) {
			handlers = new Set();
			this.handlers.set(type, handlers);
		}
		handlers.add(handler as AgentHarnessHandler);
		return () => handlers!.delete(handler as AgentHarnessHandler);
	}

	// ─────────────────────────────────────────────────────────────────────────────────────────
	// Trigger execution chain — pie: agent_harness.rs:1103-1495 (`handle_trigger`,
	// `spawn_trigger_action`, `run_before_trigger_hook`, `resolve_trigger_prompt`,
	// `write_trigger_prompt_audit`, `notification_status_snapshot`, `abort_trigger`,
	// `abort_all_triggers`, `register_notification_hook`) + :2361-2816 (`run_trigger_action`,
	// the free function `spawn_trigger_action` detaches) + :3016-3312 (`apply_promotion`).
	// ─────────────────────────────────────────────────────────────────────────────────────────

	/** pie: agent_harness.rs:1059-1074 (`subscribe_harness`). Returns an unsubscriber. */
	subscribeHarness(listener: HarnessListener): () => void {
		this.harnessListeners.add(listener);
		return () => this.harnessListeners.delete(listener);
	}

	/** pie: agent_harness.rs:1076-1084 (`emit_harness_event`). Each listener runs isolated —
	 * one throwing listener neither poisons the others nor the caller (mirrors oracle's
	 * `catch_unwind`); the listener stays registered (oracle does not remove on panic either). */
	private emitHarnessEvent(event: HarnessEvent): void {
		for (const listener of this.harnessListeners) {
			try {
				listener(event);
			} catch {
				// isolated per oracle's contract (agent_harness.rs:31-33 doc comment).
			}
		}
	}

	/**
	 * Accept an incoming {@link Trigger}. pie: agent_harness.rs:1117-1246 (`handle_trigger`).
	 * Evaluates dedup/cycle via `TriggerRuntime`, runs the optional permission hook on `Accept`,
	 * persists a `TriggerRecord` audit entry (best-effort — persistence failure still returns
	 * the evaluator outcome and emits `persistence_error`), and — only on the policy-`Allow`
	 * `"accepted"` path — dispatches the trigger action via {@link spawnTriggerAction} (detached,
	 * does not block this call's return).
	 */
	async handleTrigger(trigger: Trigger): Promise<EvaluationOutcome> {
		this.emitHarnessEvent({
			type: "trigger_handling_start",
			idempotencyKey: trigger.idempotency_key,
			sourceKind: trigger.source_kind,
			sourceLabel: trigger.source_label,
			eventLabel: trigger.event_label,
			traceId: trigger.trace_id,
		});

		const outcome = this.triggerRuntime.evaluate(trigger);

		let state: TriggerState;
		let evaluatorDecision: unknown;
		if (outcome.type === "accept") {
			const permissionDecision = await this.runBeforeTriggerHook(trigger);
			if (permissionDecision.kind === "allow") {
				state = "accepted";
				evaluatorDecision = { outcome: "accept", permission: "allow" };
			} else if (permissionDecision.kind === "deny") {
				state = "permission_denied";
				evaluatorDecision = { outcome: "accept", permission: "deny", reason: permissionDecision.reason };
			} else {
				const resolved = await this.resolveTriggerPrompt(trigger, permissionDecision.reason);
				state = resolved.decision.kind === "allow" ? "accepted" : "needs_approval";
				const decisionReason =
					resolved.decision.kind !== "allow" && resolved.decision.reason !== undefined
						? capTriggerPromptReason(resolved.decision.reason)
						: undefined;
				evaluatorDecision = {
					outcome: "accept",
					permission: "prompt",
					trigger_prompt_id: resolved.request.triggerPromptId,
					prompt_decision: resolved.decision.kind,
					reason: resolved.request.reason,
					decision_reason: decisionReason,
				};
			}
		} else if (outcome.type === "deduped") {
			state = "deduped";
			evaluatorDecision = {
				outcome: "deduped",
				replacement_policy: outcome.replacementPolicy,
				previous_trace_id: outcome.previousTraceId,
			};
		} else {
			state = "cycle_suppressed";
			evaluatorDecision = { outcome: "cycle_suppressed", hop_count: outcome.hopCount };
		}

		const record: TriggerRecord = {
			...triggerRecordReceivedFrom(trigger),
			state,
			evaluator_decision: evaluatorDecision,
		};

		let auditEntryId: string | undefined;
		try {
			auditEntryId = await this.session.appendCustomEntry(TRIGGER_RECORD_CUSTOM_TYPE, record);
		} catch (error) {
			this.emitHarnessEvent({
				type: "persistence_error",
				context: "trigger_audit",
				message: `trigger audit append failed: ${toError(error).message}`,
			});
		}

		this.emitHarnessEvent({
			type: "trigger_handled",
			idempotencyKey: trigger.idempotency_key,
			traceId: trigger.trace_id,
			state,
			auditEntryId,
			evaluatorDecision,
		});

		// pie: agent_harness.rs:1238-1243 — sub-agent execution only fires on the policy-Allow
		// Accepted path. Other terminal states leave `handle_trigger` here with only the audit +
		// `trigger_handled` event written.
		if (state === "accepted") {
			this.spawnTriggerAction(trigger);
		}

		return outcome;
	}

	/** pie: agent_harness.rs:1313-1322 (`run_before_trigger_hook`). No hook configured ⇒ `Allow`. */
	private async runBeforeTriggerHook(trigger: Trigger): Promise<BeforeTriggerDecision> {
		if (!this.beforeTrigger) return { kind: "allow" };
		return this.beforeTrigger({ trigger, runtime: this.triggerRuntime.snapshot() }, new AbortController().signal);
	}

	/** pie: agent_harness.rs:1324-1354 (`resolve_trigger_prompt`). No hook configured ⇒
	 * fail-closed deny (issue #110 design v0.2).
	 *
	 * pie: agent_harness.rs:1337-1343 — while the `onTriggerPrompt` hook is in flight, its
	 * cancel token is published to `active_hook_cancel` (here: `activeHookAbortController`) so
	 * `abort()` can cancel it (GAP fix: previously a disconnected, never-aborted
	 * `AbortController` was passed, letting the hook hang past `abort()` — see gap-inventory #7,
	 * confirmed by a 30s test hang). Cleared unconditionally once the hook settles so `abort()`
	 * does not see a stale controller between trigger-prompt resolutions. */
	private async resolveTriggerPrompt(
		trigger: Trigger,
		reason: string,
	): Promise<{ request: TriggerPromptRequest; decision: TriggerPromptDecision }> {
		const request = await buildTriggerPromptRequest(trigger, reason);
		this.emitHarnessEvent({ type: "trigger_prompt_request", request });
		let decision: TriggerPromptDecision;
		if (this.onTriggerPrompt) {
			const controller = new AbortController();
			this.activeHookAbortController = controller;
			try {
				decision = await this.onTriggerPrompt(request, controller.signal);
			} finally {
				this.activeHookAbortController = undefined;
			}
		} else {
			decision = {
				kind: "deny",
				reason:
					"trigger prompt required but no onTriggerPrompt hook configured (fail-closed deny — see issue #110 design v0.2)",
			};
		}
		await this.writeTriggerPromptAudit(request, decision);
		return { request, decision };
	}

	/** pie: agent_harness.rs:1356-1384 (`write_trigger_prompt_audit`). */
	private async writeTriggerPromptAudit(
		request: TriggerPromptRequest,
		decision: TriggerPromptDecision,
	): Promise<void> {
		const reason =
			decision.kind !== "allow" && decision.reason !== undefined
				? capTriggerPromptReason(decision.reason)
				: undefined;
		const data = {
			schema_version: 1,
			trigger_prompt_id: request.triggerPromptId,
			trace_id: request.traceId,
			source_label: capControlPlaneAuditLabel(request.sourceLabel),
			receiver_agent_id: request.receiverAgentId ?? null,
			sender_agent_id: request.senderAgentId,
			action_class: request.actionClass,
			decision: decision.kind,
			reason: reason ?? null,
			at: new Date().toISOString(),
		};
		try {
			await this.session.appendCustomEntry("trigger_prompt", data);
		} catch (error) {
			this.emitHarnessEvent({
				type: "persistence_error",
				context: "trigger_prompt",
				message: `trigger prompt audit append failed: ${toError(error).message}`,
			});
		}
	}

	/**
	 * Detached dispatch for an accepted trigger. pie: agent_harness.rs:1259-1304
	 * (`spawn_trigger_action`, `tokio::spawn`). RULEBOOK §2.2: `detach()` is the canonical
	 * mapping — callers MUST NOT inline-await this (would turn concurrent trigger execution into
	 * serial execution blocking `handleTrigger`'s caller).
	 */
	private spawnTriggerAction(trigger: Trigger): void {
		const traceId = trigger.trace_id;
		detach(
			() => this.runTriggerAction(trigger),
			(error) => {
				// Defensive backstop: every fallible step inside runTriggerAction already routes
				// its own failure to a persistence_error/trigger_failed event; this only fires for
				// a genuinely unexpected exception that escaped that handling.
				this.emitHarnessEvent({ type: "trigger_failed", traceId, reason: toError(error).message });
			},
		);
	}

	/**
	 * pie: agent_harness.rs:2390-2816 (`run_trigger_action`). Resolves the `TriggerAction` via
	 * the optional hook (or {@link defaultTriggerAction}), then dispatches on
	 * {@link TriggerAction.delivery}:
	 * - `"inject_summary"` — no sub-agent, no model call (agent_harness.rs:2430-2497).
	 * - `"inject_and_run"` — injects into the PARENT conversation; serialized through the
	 *   existing steer/follow-up machinery rather than a detached model call
	 *   (agent_harness.rs:2508-2597).
	 * - `"sub_agent"` (default) — runs a detached, isolated sub-agent concurrently with the
	 *   parent (agent_harness.rs:2599-2816).
	 */
	private async runTriggerAction(trigger: Trigger): Promise<void> {
		const action = this.beforeTriggerAction
			? await this.beforeTriggerAction(
					{ trigger, runtime: this.triggerRuntime.snapshot() },
					new AbortController().signal,
				)
			: defaultTriggerAction(trigger);

		if (action.delivery === "inject_summary") {
			await this.runInjectSummaryDelivery(trigger, action);
			return;
		}
		if (action.delivery === "inject_and_run") {
			await this.runInjectAndRunDelivery(trigger, action);
			return;
		}
		await this.runSubAgentDelivery(trigger, action);
	}

	/**
	 * pie: agent_harness.rs:2430-2497. Skips the sub-agent entirely: `trigger.payload_summary`
	 * IS the result, at zero cost. Still writes the full `trigger_result` audit + emits the
	 * normal `trigger_execution_started`/`trigger_completed` pair so `/triggers` and jsonl
	 * readers see a uniform terminal lifecycle, then runs {@link applyPromotion} same as the
	 * sub-agent path.
	 */
	private async runInjectSummaryDelivery(trigger: Trigger, action: TriggerAction): Promise<void> {
		const traceId = trigger.trace_id;
		const summary = trigger.payload_summary ?? undefined;
		this.emitHarnessEvent({
			type: "trigger_execution_started",
			traceId,
			sourceLabel: trigger.source_label,
			eventLabel: trigger.event_label,
			promptPreview: previewForBanner(summary ?? "(no summary)", 80),
		});
		await this.writeTriggerResultAudit(traceId, {
			trace_id: traceId,
			branch_id: null,
			success: true,
			summary: summary ?? null,
			message_count: 0,
			cost_usd: 0,
			reason: null,
			details: null,
			delivery: "inject_summary",
		});
		this.emitHarnessEvent({ type: "trigger_completed", traceId, summary, costUsd: 0, details: null });
		await this.applyPromotion(trigger, {
			success: true,
			summary,
			messageCount: 0,
			details: undefined,
			promote: action.promote,
			requireApproval: action.promoteRequiresApproval,
		});
	}

	/**
	 * pie: agent_harness.rs:2508-2597. Injects {@link TriggerAction.prompt} into the PARENT
	 * conversation and asks for one parent-loop turn — never runs the single-tenant parent
	 * harness from this detached path itself. Two branches mirror oracle's
	 * `parent_agent.is_streaming()` check exactly (RULEBOOK "inject-and-run: serialized on the parent session" —
	 * serialized through the SAME queues the public `followUp()`/`appendMessage()` APIs use):
	 * - **busy** (`this.phase !== "idle"`): pushed onto `followUpQueue`, which
	 *   `createLoopConfig`'s `getFollowUpMessages` hook drains at the in-flight loop's next
	 *   boundary — the base-architecture equivalent of oracle's `enqueue_follow_up`.
	 * - **idle**: appended directly to the session (picked up by the next `createTurnState()`'s
	 *   `session.buildContext()`, since base's turn state is always rebuilt from the session
	 *   tree rather than kept in a persistent live buffer) + `trigger_requests_main_run` is
	 *   emitted so the embedder — which owns calling `prompt()`/`continue_()` — schedules the turn.
	 */
	private async runInjectAndRunDelivery(trigger: Trigger, action: TriggerAction): Promise<void> {
		const traceId = trigger.trace_id;
		const { body: cappedBody } = truncateOnCharBoundary(action.prompt, PROMOTION_BODY_CAP_BYTES);
		const { body, prefixInjected } = ensureTriggerPrefix(cappedBody, traceId);
		this.emitHarnessEvent({
			type: "trigger_execution_started",
			traceId,
			sourceLabel: trigger.source_label,
			eventLabel: trigger.event_label,
			promptPreview: previewForBanner(body, 80),
		});

		const userMessage = createUserMessage(body);
		const queuedForFollowUp = this.phase !== "idle";
		if (queuedForFollowUp) {
			this.followUpQueue.push(userMessage);
			await this.emitQueueUpdate();
		} else {
			try {
				await this.session.appendMessage(userMessage);
			} catch (error) {
				this.emitHarnessEvent({
					type: "persistence_error",
					context: "trigger_inject_and_run",
					message: `inject_and_run append failed: ${toError(error).message}`,
				});
			}
		}

		await this.writeTriggerResultAudit(traceId, {
			trace_id: traceId,
			branch_id: null,
			success: true,
			summary: body,
			message_count: 0,
			cost_usd: 0,
			reason: null,
			details: null,
			delivery: "inject_and_run",
			prefix_injected: prefixInjected,
			run_dispatch: queuedForFollowUp ? "follow_up" : "main_run_request",
		});

		this.emitHarnessEvent({ type: "trigger_completed", traceId, summary: body, costUsd: 0, details: null });

		if (!queuedForFollowUp) {
			this.emitHarnessEvent({ type: "trigger_requests_main_run", traceId });
		}
	}

	/**
	 * pie: agent_harness.rs:2599-2816. Runs a fully isolated, detached sub-agent — no parent
	 * conversation messages, but the SAME model/system-prompt/active-tools/thinking-level and
	 * the SAME `tool_call`/`tool_result` hooks the parent uses (`emitHook`), matching oracle's
	 * `before_tool_call`/`after_tool_call` inheritance (agent_harness.rs:2649-2652). Registers
	 * in `runningTriggers` so `abortTrigger`/`abortAllTriggers`/`notificationStatusSnapshot`
	 * can see and cancel it — this is the "sub-agent: detached and concurrent" half of the RULEBOOK
	 * callout: unlike `inject_and_run`, this never touches the parent's queues or blocks the
	 * parent loop; it can run fully concurrently with an in-flight parent `prompt()`.
	 */
	private async runSubAgentDelivery(trigger: Trigger, action: TriggerAction): Promise<void> {
		const traceId = trigger.trace_id;
		const cancel = new AbortController();
		const promptPreview = previewForBanner(action.prompt, 80);
		const startedAt = new Date().toISOString();
		this.runningTriggers.set(traceId, {
			state: {
				traceId,
				sourceLabel: trigger.source_label,
				eventLabel: trigger.event_label,
				startedAt,
				promptPreview,
			},
			abort: cancel,
		});
		this.emitHarnessEvent({
			type: "trigger_execution_started",
			traceId,
			sourceLabel: trigger.source_label,
			eventLabel: trigger.event_label,
			promptPreview,
		});

		// pie: agent_harness.rs:2641-2653 — sub-agent inherits parent model/system-prompt/tools/
		// thinking-level via a snapshot; parent conversation messages are NOT copied in.
		const turnState = await this.createTurnState();
		const subContext: AgentContext = {
			systemPrompt: turnState.systemPrompt,
			messages: [],
			tools: turnState.activeTools,
		};
		const subLoopConfig: AgentLoopConfig = {
			model: turnState.model,
			reasoning: turnState.thinkingLevel === "off" ? undefined : turnState.thinkingLevel,
			convertToLlm,
			beforeToolCall: async ({ toolCall, args }) => {
				const result = await this.emitHook({
					type: "tool_call",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					input: args as Record<string, unknown>,
				});
				return result ? { block: result.block, reason: result.reason } : undefined;
			},
			afterToolCall: async ({ toolCall, args, result, isError }) => {
				const patch = await this.emitHook({
					type: "tool_result",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					input: args as Record<string, unknown>,
					content: result.content,
					details: result.details,
					isError,
				});
				return patch
					? { content: patch.content, details: patch.details, isError: patch.isError, terminate: patch.terminate }
					: undefined;
			},
		};

		// Best-effort transcript accumulator: populated from `message_end` events as they fire,
		// so a partial transcript is still available for the outcome summary even when the run
		// throws mid-loop (pie: agent_harness.rs:3347-3359 `compute_sub_agent_outcome` reads
		// `sub_agent.state()` — the oracle `Agent`'s live, incrementally-built message buffer —
		// on BOTH the success and failure paths; this mirrors that on top of base's
		// event-driven, non-stateful `runAgentLoop`).
		const observedMessages: AgentMessage[] = [];
		const runSubAgent = (signal: AbortSignal): Promise<AgentMessage[]> =>
			runAgentLoop(
				[createUserMessage(action.prompt)],
				subContext,
				subLoopConfig,
				(event) => {
					if (event.type === "message_end") observedMessages.push(event.message);
				},
				signal,
				this.createStreamFn(() => turnState),
			);

		// pie: agent_harness.rs:2682-2689 (`tokio::select! { biased; ... }`) — RULEBOOK §2.2:
		// `biased` sites map to `selectBiased` (not plain `selectN`), so the cancel branch — when
		// externally ready via `abortTrigger`/`abortAllTriggers` — always wins over a
		// simultaneously-settling sub-agent completion. A SEPARATE `AbortController`
		// (`subAbortController`) drives the sub-agent's own run, mirroring oracle's explicit
		// `sub_agent.abort()` call inside the cancel arm's body rather than wiring the same
		// signal to both racers.
		const subAbortController = new AbortController();
		let runError: unknown;
		try {
			await selectBiased<AgentMessage[]>([
				{
					run: () =>
						new Promise<AgentMessage[]>((_resolve, reject) => {
							const onAbort = () => {
								subAbortController.abort();
								reject(new Error("aborted"));
							};
							if (cancel.signal.aborted) onAbort();
							else cancel.signal.addEventListener("abort", onAbort, { once: true });
						}),
				},
				{ run: () => runSubAgent(subAbortController.signal) },
			]);
		} catch (error) {
			runError = error;
		}

		// pie: agent_harness.rs:3347-3359 (`compute_sub_agent_outcome`) + :3365-3390
		// (`last_assistant_text`).
		const success = runError === undefined;
		const summary = lastAssistantText(observedMessages);
		const messageCount = observedMessages.length;
		const failureReason = success
			? undefined
			: runError instanceof Error && runError.message === "aborted"
				? "aborted"
				: toError(runError).message;

		// pie: agent_harness.rs:2710-2721 — `cost_usd`/`details` are `null` here, honestly:
		// the sub-agent has no CostTracker wrapper and no marker-tool-populated result details
		// builder wired in this unit.
		await this.writeTriggerResultAudit(traceId, {
			trace_id: traceId,
			branch_id: null,
			success,
			summary: summary ?? null,
			message_count: messageCount,
			cost_usd: null,
			reason: failureReason ?? null,
			details: null,
		});

		if (success) {
			this.emitHarnessEvent({ type: "trigger_completed", traceId, summary, costUsd: undefined, details: null });
		} else {
			this.emitHarnessEvent({ type: "trigger_failed", traceId, reason: failureReason ?? "unknown failure" });
		}

		await this.applyPromotion(trigger, {
			success,
			summary,
			messageCount,
			details: undefined,
			promote: action.promote,
			requireApproval: action.promoteRequiresApproval,
		});

		// pie: agent_harness.rs:2814-2815 — removed from the registry LAST, after promotion.
		this.runningTriggers.delete(traceId);
	}

	/** pie: agent_harness.rs:2733-2754 (`trigger_result` append, best-effort). */
	private async writeTriggerResultAudit(_traceId: string, data: Record<string, unknown>): Promise<void> {
		try {
			await this.session.appendCustomEntry("trigger_result", data);
		} catch (error) {
			this.emitHarnessEvent({
				type: "persistence_error",
				context: "trigger_result",
				message: `trigger_result append failed: ${toError(error).message}`,
			});
		}
	}

	/** pie: agent_harness.rs:2733-2754 style append for the `trigger_promotion` custom entry. */
	private async writeTriggerPromotionAudit(data: Record<string, unknown>): Promise<void> {
		try {
			await this.session.appendCustomEntry("trigger_promotion", data);
		} catch (error) {
			this.emitHarnessEvent({
				type: "persistence_error",
				context: "trigger_promotion",
				message: `trigger_promotion append failed: ${toError(error).message}`,
			});
		}
	}

	/**
	 * pie: agent_harness.rs:3022-3312 (`apply_promotion`). `PromoteAction::None` is a no-op
	 * (agent_harness.rs:3040). Idle-vs-busy injection mirrors {@link runInjectAndRunDelivery}'s
	 * doc comment — same followUp-queue-vs-direct-append split.
	 */
	private async applyPromotion(
		trigger: Trigger,
		params: {
			success: boolean;
			summary: string | undefined;
			messageCount: number;
			details: unknown;
			promote: PromoteAction;
			requireApproval: boolean;
		},
	): Promise<void> {
		const traceId = trigger.trace_id;
		if (params.promote.kind === "none") return;

		let templateBodyArg: string | undefined;
		let promoteKind: string;
		if (params.promote.kind === "promote_summary_now") {
			templateBodyArg = params.promote.templateBody;
			promoteKind = "promote_summary_now";
		} else if (params.promote.kind === "promote_summary_when_summary_contains") {
			// pie: agent_harness.rs:3044-3057 (`#[allow(deprecated)]
			// PromoteAction::PromoteSummaryWhenSummaryContains`) — see the `PromoteAction` type doc
			// for why this deprecated variant is still ported. Gate is a plain case-sensitive
			// substring search over the free-form `summary` text; ANY match (not all) is
			// sufficient. On match this re-uses the exact same `"promote_summary_now"` promote-kind
			// label oracle does (agent_harness.rs:3056) — the audit/event trail cannot distinguish
			// which of the two variants actually fired. No audit entry is written on a non-match
			// (oracle just `return`s here); contrast the structured-details variant below, which
			// DOES write a "skipped" audit on failure — the two variants are deliberately
			// inconsistent on this point, preserved bug-for-bug rather than unified.
			const summaryText = params.summary ?? "";
			const matched = params.promote.requiredSubstrings.some((needle) => summaryText.includes(needle));
			if (!matched) return;
			templateBodyArg = params.promote.templateBody;
			promoteKind = "promote_summary_now";
		} else {
			// pie: agent_harness.rs:3058-3092 — authorization gate. `summary` is NEVER consulted;
			// promotion fires only when structured `details` satisfies `condition`. Any failure
			// (pointer missing / not an array / empty intersection) fails closed: audits
			// `state: "skipped"` and returns without touching the parent transcript.
			const evalResult = evaluatePromotionCondition(params.promote.condition, params.details);
			if (!evalResult.ok) {
				await this.writeTriggerPromotionAudit({
					state: "skipped",
					trace_id: traceId,
					promote_kind: "promote_summary_when_result_details_match",
					reason: evalResult.reason,
					template_name: null,
					template_hash: null,
					inserted_entry_id: null,
					rule_id: null,
					redaction_status: "skipped",
					dedup_collapsed: false,
					prefix_injected: false,
				});
				return;
			}
			templateBodyArg = params.promote.templateBody;
			promoteKind = "promote_summary_when_result_details_match";
		}

		const ctx = buildTemplateContext(traceId, trigger, params.success, params.summary, params.messageCount);
		const bodyTemplate = templateBodyArg ?? DEFAULT_PROMOTE_SUMMARY_TEMPLATE;
		const templateHash = await sha256Hex(bodyTemplate);
		const templateName = templateBodyArg === undefined ? "default" : `inline:${templateHash.slice(0, 8)}`;

		const renderResult = renderPromotionTemplate(bodyTemplate, ctx);
		if (!renderResult.ok) {
			const redactionStatus = renderResult.kind === "unknown_field" ? "render_error" : "forbidden_field";
			await this.writeTriggerPromotionAudit({
				state: "failed",
				trace_id: traceId,
				promote_kind: promoteKind,
				template_name: templateName,
				template_hash: templateHash,
				inserted_entry_id: null,
				rule_id: null,
				redaction_status: redactionStatus,
				dedup_collapsed: false,
				prefix_injected: false,
			});
			this.emitHarnessEvent({
				type: "persistence_error",
				context: "trigger_promotion",
				message: renderResult.message,
			});
			return;
		}

		// pie: agent_harness.rs:3175-3182 — engine-enforced `[Trigger {trace_id}] ` prefix;
		// never trust the template author to include it.
		const { body: prefixedBody, prefixInjected } = ensureTriggerPrefix(renderResult.value, traceId);

		if (params.requireApproval) {
			const { body: preview } = truncateOnCharBoundary(prefixedBody, PROMOTION_BODY_CAP_BYTES);
			await this.writeTriggerPromotionAudit({
				state: "pending",
				trace_id: traceId,
				promote_kind: promoteKind,
				template_name: templateName,
				template_hash: templateHash,
				inserted_entry_id: null,
				rule_id: null,
				redaction_status: preview.length === prefixedBody.length ? "clean" : "truncated",
				dedup_collapsed: false,
				prefix_injected: prefixInjected,
			});
			this.emitHarnessEvent({
				type: "promotion_pending",
				traceId,
				promoteKind,
				templateName,
				preview,
			});
			return;
		}

		const { body: finalBody, truncated } = truncateOnCharBoundary(prefixedBody, PROMOTION_BODY_CAP_BYTES);
		const redactionStatus = truncated ? "truncated" : "clean";
		const userMessage = createUserMessage(finalBody);

		// pie: agent_harness.rs:3240-3300 — single persistence path, idle-vs-busy split (same
		// rationale as `runInjectAndRunDelivery`'s doc comment above).
		const queuedForFollowUp = this.phase !== "idle";
		let auditState: string;
		let insertedEntryId: string | null = null;
		if (queuedForFollowUp) {
			this.followUpQueue.push(userMessage);
			await this.emitQueueUpdate();
			auditState = "queued";
		} else {
			try {
				insertedEntryId = await this.session.appendMessage(userMessage);
				auditState = "success";
			} catch (error) {
				this.emitHarnessEvent({
					type: "persistence_error",
					context: "trigger_promotion",
					message: `promotion message append failed: ${toError(error).message}`,
				});
				await this.writeTriggerPromotionAudit({
					state: "failed",
					trace_id: traceId,
					promote_kind: promoteKind,
					template_name: templateName,
					template_hash: templateHash,
					inserted_entry_id: null,
					rule_id: null,
					redaction_status: "render_error",
					dedup_collapsed: false,
					prefix_injected: prefixInjected,
				});
				return;
			}
		}

		await this.writeTriggerPromotionAudit({
			state: auditState,
			trace_id: traceId,
			promote_kind: promoteKind,
			template_name: templateName,
			template_hash: templateHash,
			inserted_entry_id: insertedEntryId,
			rule_id: null,
			redaction_status: redactionStatus,
			dedup_collapsed: false,
			prefix_injected: prefixInjected,
		});

		this.emitHarnessEvent({
			type: "trigger_promoted",
			traceId,
			promoteKind,
			insertedEntryId: insertedEntryId ?? "",
			templateName,
			redactionStatus,
		});
	}

	/** pie: agent_harness.rs:1393-1413 (`notification_status_snapshot`). */
	notificationStatusSnapshot(): NotificationStatusSnapshot {
		return {
			hooks: this.notificationHooks.map((hook) => hook.status()),
			runtime: this.triggerRuntime.snapshot(),
			running: [...this.runningTriggers.values()].map((handle) => handle.state),
		};
	}

	/** pie: agent_harness.rs:1420-1424 (`abort_trigger`). No-op if not running. */
	abortTrigger(traceId: string): void {
		this.runningTriggers.get(traceId)?.abort.abort();
	}

	/** pie: agent_harness.rs:1429-1439 (`abort_all_triggers`). */
	abortAllTriggers(): void {
		for (const handle of this.runningTriggers.values()) handle.abort.abort();
	}

	/**
	 * pie: agent_harness.rs:1460-1495 (`register_notification_hook`). RULEBOOK §2.2:
	 * `AsyncQueue<Trigger>` is the canonical `mpsc::(unbounded_)channel` mapping — the queue
	 * plays both the `TriggerSink` (push side) and receiver (pump side) roles the oracle splits
	 * across `mpsc::unbounded_channel()`'s `(sink, rx)`. `detach()` is the canonical
	 * `tokio::spawn` mapping for both the driver task (drives the hook's transport) and the pump
	 * task (drains triggers into {@link handleTrigger} in order, exiting when the queue closes).
	 */
	registerNotificationHook(hook: NotificationHook): void {
		const queue = new AsyncQueue<Trigger>();
		this.notificationHooks.push(hook);

		detach(
			() => hook.run(queue),
			() => {
				// pie: agent_harness.rs:1468-1471 — driver errors are not surfaced to a
				// HarnessEvent here (RFC 1 §4 defers that to a follow-up); the hook reflects
				// failure through its own `status()`.
			},
		);

		detach(
			async () => {
				for (;;) {
					const trigger = await queue.next();
					if (trigger === undefined) return;
					await this.handleTrigger(trigger);
				}
			},
			(error) => {
				this.emitHarnessEvent({
					type: "persistence_error",
					context: "notification_hook_pump",
					message: toError(error).message,
				});
			},
		);
	}
}
