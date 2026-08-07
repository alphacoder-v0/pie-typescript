/**
 * Port of oracle `crates/agent/src/harness/trigger.rs` (pie @0a120dfd).
 *
 * RFC 1 (issue #20) trigger envelope, source taxonomy, authority, state machine, and the
 * `TriggerRecord` persisted as `SessionTreeEntry::Custom { custom_type: "trigger" }`.
 *
 * This module is the runtime type surface for external-event-driven agent invocation. It
 * deliberately knows nothing about specific transports (MCP push, cron, file-watch, etc.).
 * Transport adapters live in `packages/coding-agent` and consume the `NotificationHook`
 * interface (./notification-hook.ts) next door.
 *
 * Wire shape is law (RULEBOOK §2.1): every field below on `TriggerSource`, `TriggerAuthority`,
 * `Trigger`, `TriggerState`, and `TriggerRecord` is named exactly as the oracle's serde output —
 * snake_case, `kind` as the `TriggerSource` tag discriminant (oracle: `#[serde(tag = "kind",
 * rename_all = "snake_case")]`, trigger.rs:73), `PascalCase` string values for
 * `CredentialScope` (oracle: `#[serde(rename_all = "PascalCase")]`, trigger.rs:169). Do not
 * camelCase any of these — a downstream consumer branches on `kind`/field names directly and a
 * previous phase-5 unit shipped a `type` tag where `kind` was required, caught only in review.
 */

import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";

/* -------------------------------------------------------------------------------------------
 * TriggerSource — oracle trigger.rs:74-88. Internally tagged on `kind` (not `type`: the enum is
 * `serde(tag = "kind")` and `Local`'s own field is named `subkind` specifically to avoid
 * colliding with the reserved discriminator name).
 * ----------------------------------------------------------------------------------------- */

export type TriggerSource =
	| { kind: "mcp"; server_name: string; method: string }
	| { kind: "local"; subkind: string }
	| { kind: "agent_delegate"; agent_id: string; delegation_id: string };

/** UI grouping dimension. oracle trigger.rs:93-96. */
export type SourceKind = "local" | "mcp";

/** Privacy tier for the carried payload. oracle trigger.rs:102-110. */
export type PayloadVisibility = "local" | "shared" | "redacted";

/**
 * How the runtime dedup window collapses repeat events sharing an `idempotency_key`. oracle
 * trigger.rs:152-163. Required on the wire (see `Trigger.replacement_policy` below) — the
 * runtime does NOT default a missing field to `Drop`, so adapters that forgot to set it fail
 * loud rather than silently dropping real events.
 */
export type ReplacementPolicy = "latest_replaces" | "coalesce" | "drop";

/** oracle trigger.rs:170-176. `rename_all = "PascalCase"` on already-PascalCase Rust
 * identifiers — the wire values are the literal variant spellings. */
export type CredentialScope = "User" | "Project" | "Team" | "Agent" | "None";

/** oracle trigger.rs:117-131. */
export interface TriggerAuthority {
	principal_id: string;
	principal_label: string;
	credential_scope: CredentialScope;
	/** `#[serde(default)]` (no `skip_serializing_if`): defaults to `[]` when absent on decode;
	 * always emitted (even empty) on encode. */
	allowed_source_actions: string[];
	/** `#[serde(default, skip_serializing_if = "Option::is_none")]`: omitted when absent. */
	expires_at?: string;
}

/**
 * Runtime-facing envelope for a single external event. oracle trigger.rs:26-65.
 *
 * `payload_summary` has NO `skip_serializing_if` on the oracle field (trigger.rs:40-41) — unlike
 * every other optional field in this module, it is ALWAYS present on the wire and serializes as
 * `null` when absent (RULEBOOK §2.1: "except for fields that serialize as null, which keep null"). `payload`, one field
 * below it, DOES have `#[serde(default, skip_serializing_if = "Option::is_none")]` and is
 * omitted (`undefined`) when absent — the two fields deliberately differ.
 */
export interface Trigger {
	source: TriggerSource;
	source_kind: SourceKind;
	source_label: string;
	event_label: string;
	payload_visibility: PayloadVisibility;
	payload_summary: string | null;
	payload?: unknown;
	idempotency_key: string;
	replacement_policy: ReplacementPolicy;
	trace_id: string;
	authority: TriggerAuthority;
	/** ISO-8601 (oracle: `chrono::DateTime<Utc>`). */
	received_at: string;
}

/**
 * Lifecycle state of a single trigger. oracle trigger.rs:187-221. `received`, `accepted`, and
 * `running` are transitional; the rest are terminal — see `isTriggerStateTerminal`.
 */
export type TriggerState =
	| "received"
	| "accepted"
	| "deduped"
	| "cycle_suppressed"
	| "permission_denied"
	| "needs_approval"
	| "running"
	| "failed"
	| "completed";

const TERMINAL_TRIGGER_STATES: ReadonlySet<TriggerState> = new Set<TriggerState>([
	"deduped",
	"cycle_suppressed",
	"permission_denied",
	"needs_approval",
	"failed",
	"completed",
]);

/** oracle trigger.rs:208-221 (`TriggerState::is_terminal`). */
export function isTriggerStateTerminal(state: TriggerState): boolean {
	return TERMINAL_TRIGGER_STATES.has(state);
}

/**
 * Persistent audit record written under `SessionTreeEntry::Custom { custom_type: "trigger" }`.
 * oracle trigger.rs:230-260. Unlike `Trigger.payload_summary` above, this field DOES have
 * `skip_serializing_if` (trigger.rs:245-246) and is omitted when absent — confirmed by the
 * ported `trigger_record_round_trip_with_optional_fields_omitted` test.
 */
export interface TriggerRecord {
	schema_version: number;
	source: TriggerSource;
	source_kind: SourceKind;
	source_label: string;
	event_label: string;
	trace_id: string;
	authority: TriggerAuthority;
	idempotency_key: string;
	replacement_policy: ReplacementPolicy;
	received_at: string;
	state: TriggerState;
	payload_visibility: PayloadVisibility;
	payload_summary?: string;
	evaluator_decision?: unknown;
	result_link?: string;
	rule_name?: string;
}

/** oracle trigger.rs:264 (`TriggerRecord::SCHEMA_VERSION`). Bump only on breaking changes. */
export const TRIGGER_RECORD_SCHEMA_VERSION = 1;

/** oracle trigger.rs:292 (`TriggerRecord::CUSTOM_TYPE`). */
export const TRIGGER_RECORD_CUSTOM_TYPE = "trigger";

/**
 * Construct an in-progress record from a `Trigger`. oracle trigger.rs:269-288
 * (`TriggerRecord::received_from`). Note the `payload_summary` conversion: `Trigger`'s field is
 * `string | null` (always present on the wire); `TriggerRecord`'s field is `string | undefined`
 * (omitted on the wire) — `null` collapses to `undefined` here, not because the two Rust
 * `Option<String>`s differ, but because each struct's own (independent) `skip_serializing_if`
 * attribute determines whether `None` prints as `null` or is omitted.
 */
export function triggerRecordReceivedFrom(trigger: Trigger): TriggerRecord {
	return {
		schema_version: TRIGGER_RECORD_SCHEMA_VERSION,
		source: trigger.source,
		source_kind: trigger.source_kind,
		source_label: trigger.source_label,
		event_label: trigger.event_label,
		trace_id: trigger.trace_id,
		authority: trigger.authority,
		idempotency_key: trigger.idempotency_key,
		replacement_policy: trigger.replacement_policy,
		received_at: trigger.received_at,
		state: "received",
		payload_visibility: trigger.payload_visibility,
		payload_summary: trigger.payload_summary ?? undefined,
		evaluator_decision: undefined,
		result_link: undefined,
		rule_name: undefined,
	};
}

/* -------------------------------------------------------------------------------------------
 * Wire-boundary schema (RULEBOOK §2.1: "struct → interface, with a typebox schema at the wire boundary"),
 * following the `Type.Object` + `Compile` precedent already established by
 * packages/coding-agent/src/triggers/cron.ts's `CronJobSchema`. `Trigger`'s schema is the one
 * the oracle test suite requires to REJECT malformed input (missing `replacement_policy` must
 * throw — trigger.rs:449-462, `trigger_envelope_replacement_policy_is_required_field`).
 * `TriggerRecord` also gets a schema + `decodeTriggerRecord` below so its ported
 * round-trip / unknown-field-tolerance tests exercise a real decode path (TypeBox `Type.Object`
 * tolerates unrecognized keys by default — verified via `Compile(...).Check`) rather than plain
 * object spreads, mirroring oracle's `trigger_record_tolerates_unknown_fields` test, which goes
 * through `serde_json::from_value` (trigger.rs:360-373).
 * ----------------------------------------------------------------------------------------- */

const TriggerSourceSchema = Type.Union([
	Type.Object({ kind: Type.Literal("mcp"), server_name: Type.String(), method: Type.String() }),
	Type.Object({ kind: Type.Literal("local"), subkind: Type.String() }),
	Type.Object({ kind: Type.Literal("agent_delegate"), agent_id: Type.String(), delegation_id: Type.String() }),
]);

const CredentialScopeSchema = Type.Union([
	Type.Literal("User"),
	Type.Literal("Project"),
	Type.Literal("Team"),
	Type.Literal("Agent"),
	Type.Literal("None"),
]);

const TriggerAuthoritySchema = Type.Object({
	principal_id: Type.String(),
	principal_label: Type.String(),
	credential_scope: CredentialScopeSchema,
	allowed_source_actions: Type.Optional(Type.Array(Type.String())),
	expires_at: Type.Optional(Type.String()),
});

const TriggerSchema = Type.Object({
	source: TriggerSourceSchema,
	source_kind: Type.Union([Type.Literal("local"), Type.Literal("mcp")]),
	source_label: Type.String(),
	event_label: Type.String(),
	payload_visibility: Type.Union([Type.Literal("local"), Type.Literal("shared"), Type.Literal("redacted")]),
	payload_summary: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	payload: Type.Optional(Type.Unknown()),
	idempotency_key: Type.String(),
	replacement_policy: Type.Union([Type.Literal("latest_replaces"), Type.Literal("coalesce"), Type.Literal("drop")]),
	trace_id: Type.String(),
	authority: TriggerAuthoritySchema,
	received_at: Type.String(),
});

const validateTrigger = Compile(TriggerSchema);

/**
 * Decode + validate a wire-shaped `Trigger` envelope. Mirrors serde's derived `Deserialize` for
 * every field except the two `Option<T>` fields (`payload_summary`, `payload`), which serde
 * defaults to absent/`None` when missing from the JSON regardless of `#[serde(default)]`.
 * `replacement_policy` has no such default (trigger.rs:49-54 doc comment: adapters that want
 * "no replacement" semantics must set `Drop` explicitly) — a missing key MUST throw.
 */
export function decodeTrigger(raw: unknown): Trigger {
	if (!validateTrigger.Check(raw)) {
		const [first] = validateTrigger.Errors(raw);
		const where = first !== undefined ? first.instancePath.replace(/^\//, "") || "root" : "root";
		const reason = first !== undefined ? first.message : "trigger envelope must be an object";
		throw new Error(`invalid trigger envelope at \`${where}\`: ${reason}`);
	}
	const parsed = raw as Static<typeof TriggerSchema>;
	return {
		source: parsed.source,
		source_kind: parsed.source_kind,
		source_label: parsed.source_label,
		event_label: parsed.event_label,
		payload_visibility: parsed.payload_visibility,
		payload_summary: parsed.payload_summary ?? null,
		payload: parsed.payload,
		idempotency_key: parsed.idempotency_key,
		replacement_policy: parsed.replacement_policy,
		trace_id: parsed.trace_id,
		authority: {
			principal_id: parsed.authority.principal_id,
			principal_label: parsed.authority.principal_label,
			credential_scope: parsed.authority.credential_scope,
			allowed_source_actions: parsed.authority.allowed_source_actions ?? [],
			expires_at: parsed.authority.expires_at,
		},
		received_at: parsed.received_at,
	};
}

const TriggerStateSchema = Type.Union([
	Type.Literal("received"),
	Type.Literal("accepted"),
	Type.Literal("deduped"),
	Type.Literal("cycle_suppressed"),
	Type.Literal("permission_denied"),
	Type.Literal("needs_approval"),
	Type.Literal("running"),
	Type.Literal("failed"),
	Type.Literal("completed"),
]);

/** oracle trigger.rs:230-260 (`TriggerRecord`). See §2.1 doc-comments on the `TriggerRecord`
 * interface above for the per-field skip_serializing_if judgment this schema encodes. */
const TriggerRecordSchema = Type.Object({
	schema_version: Type.Number(),
	source: TriggerSourceSchema,
	source_kind: Type.Union([Type.Literal("local"), Type.Literal("mcp")]),
	source_label: Type.String(),
	event_label: Type.String(),
	trace_id: Type.String(),
	authority: TriggerAuthoritySchema,
	idempotency_key: Type.String(),
	replacement_policy: Type.Union([Type.Literal("latest_replaces"), Type.Literal("coalesce"), Type.Literal("drop")]),
	received_at: Type.String(),
	state: TriggerStateSchema,
	payload_visibility: Type.Union([Type.Literal("local"), Type.Literal("shared"), Type.Literal("redacted")]),
	payload_summary: Type.Optional(Type.String()),
	evaluator_decision: Type.Optional(Type.Unknown()),
	result_link: Type.Optional(Type.String()),
	rule_name: Type.Optional(Type.String()),
});

const validateTriggerRecord = Compile(TriggerRecordSchema);

/**
 * Decode + validate a wire-shaped `TriggerRecord` audit entry. Mirrors serde's derived
 * `Deserialize`: unknown keys are ignored (TypeBox `Type.Object` tolerates unrecognized
 * properties by default, matching serde's default "ignore unknown fields" behavior — RFC 1 §2.6
 * additive-only schema), and the four `skip_serializing_if`-omitted optional fields
 * (`payload_summary`, `evaluator_decision`, `result_link`, `rule_name`) stay `undefined` when
 * absent from the input, matching oracle's `#[serde(default, skip_serializing_if = ...)]`.
 */
export function decodeTriggerRecord(raw: unknown): TriggerRecord {
	if (!validateTriggerRecord.Check(raw)) {
		const [first] = validateTriggerRecord.Errors(raw);
		const where = first !== undefined ? first.instancePath.replace(/^\//, "") || "root" : "root";
		const reason = first !== undefined ? first.message : "trigger record must be an object";
		throw new Error(`invalid trigger record at \`${where}\`: ${reason}`);
	}
	const parsed = raw as Static<typeof TriggerRecordSchema>;
	return {
		schema_version: parsed.schema_version,
		source: parsed.source,
		source_kind: parsed.source_kind,
		source_label: parsed.source_label,
		event_label: parsed.event_label,
		trace_id: parsed.trace_id,
		authority: {
			principal_id: parsed.authority.principal_id,
			principal_label: parsed.authority.principal_label,
			credential_scope: parsed.authority.credential_scope,
			allowed_source_actions: parsed.authority.allowed_source_actions ?? [],
			expires_at: parsed.authority.expires_at,
		},
		idempotency_key: parsed.idempotency_key,
		replacement_policy: parsed.replacement_policy,
		received_at: parsed.received_at,
		state: parsed.state,
		payload_visibility: parsed.payload_visibility,
		payload_summary: parsed.payload_summary,
		evaluator_decision: parsed.evaluator_decision,
		result_link: parsed.result_link,
		rule_name: parsed.rule_name,
	};
}
