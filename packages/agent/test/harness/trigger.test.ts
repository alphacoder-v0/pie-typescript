import { describe, expect, it } from "vitest";
import {
	decodeTrigger,
	decodeTriggerRecord,
	isTriggerStateTerminal,
	TRIGGER_RECORD_CUSTOM_TYPE,
	TRIGGER_RECORD_SCHEMA_VERSION,
	type Trigger,
	type TriggerState,
	triggerRecordReceivedFrom,
} from "../../src/harness/trigger.ts";

/** oracle trigger.rs:299-323 (`sample_trigger`). */
function sampleTrigger(): Trigger {
	return {
		source: { kind: "mcp", server_name: "github-mcp-server", method: "notifications/pr.merged" },
		source_kind: "mcp",
		source_label: "MCP github-mcp-server",
		event_label: "pr merged",
		payload_visibility: "local",
		payload_summary: "PR #42 merged by alice",
		payload: undefined,
		idempotency_key: "github:repo:c4pt0r/pie:pr:42:merged",
		replacement_policy: "drop",
		trace_id: "trace-abc",
		authority: {
			principal_id: "github:user:alice",
			principal_label: "alice",
			credential_scope: "Project",
			allowed_source_actions: ["read", "comment"],
			expires_at: undefined,
		},
		received_at: new Date(1_700_000_000_000).toISOString(),
	};
}

describe("Trigger", () => {
	it("round-trips through the wire (serialize -> decode)", () => {
		const trigger = sampleTrigger();
		const json = JSON.stringify(trigger);
		const decoded = decodeTrigger(JSON.parse(json));
		expect(decoded).toEqual(trigger);
	});

	it("serializes PayloadVisibility in snake_case", () => {
		expect(JSON.stringify(sampleTrigger().payload_visibility)).toBe('"local"');
		expect(JSON.stringify("shared")).toBe('"shared"');
		expect(JSON.stringify("redacted")).toBe('"redacted"');
	});

	it("serializes CredentialScope in PascalCase (matches RFC 0 §4.4 wire shape)", () => {
		const cases: Array<[string, string]> = [
			["User", '"User"'],
			["Project", '"Project"'],
			["Team", '"Team"'],
			["Agent", '"Agent"'],
			["None", '"None"'],
		];
		for (const [variant, expected] of cases) {
			expect(JSON.stringify(variant)).toBe(expected);
		}
	});

	it("tags TriggerSource with an internally-tagged `kind` field, snake_case", () => {
		const mcp = sampleTrigger().source;
		const json = JSON.stringify(mcp);
		expect(json).toContain('"kind":"mcp"');
		const decoded = decodeTrigger({ ...sampleTrigger(), source: JSON.parse(json) }).source;
		expect(decoded).toEqual(mcp);
	});

	it("serializes ReplacementPolicy in snake_case, round-trips through decode", () => {
		const cases: Array<[string, string]> = [
			["latest_replaces", '"latest_replaces"'],
			["coalesce", '"coalesce"'],
			["drop", '"drop"'],
		];
		for (const [variant, expected] of cases) {
			expect(JSON.stringify(variant)).toBe(expected);
		}
	});

	it("rejects a wire object missing the required replacement_policy field", () => {
		const trigger = sampleTrigger();
		const raw = JSON.parse(JSON.stringify(trigger)) as Record<string, unknown>;
		delete raw.replacement_policy;
		expect(() => decodeTrigger(raw)).toThrow();
	});

	it("decodes allowed_source_actions as [] when absent (serde #[serde(default)])", () => {
		const trigger = sampleTrigger();
		const raw = JSON.parse(JSON.stringify(trigger)) as Record<string, unknown>;
		const authority = raw.authority as Record<string, unknown>;
		delete authority.allowed_source_actions;
		const decoded = decodeTrigger(raw);
		expect(decoded.authority.allowed_source_actions).toEqual([]);
	});

	it("decodes a missing payload_summary as null (always-present-on-wire field)", () => {
		const trigger = sampleTrigger();
		const raw = JSON.parse(JSON.stringify(trigger)) as Record<string, unknown>;
		delete raw.payload_summary;
		const decoded = decodeTrigger(raw);
		expect(decoded.payload_summary).toBeNull();
	});
});

describe("TriggerState.isTerminal", () => {
	it("matches the RFC 1 §2.7 terminal set", () => {
		expect(isTriggerStateTerminal("received")).toBe(false);
		expect(isTriggerStateTerminal("accepted")).toBe(false);
		expect(isTriggerStateTerminal("running")).toBe(false);
		const terminal: TriggerState[] = [
			"deduped",
			"cycle_suppressed",
			"permission_denied",
			"needs_approval",
			"failed",
			"completed",
		];
		for (const state of terminal) {
			expect(isTriggerStateTerminal(state), `${state} must report as terminal per RFC 1 §2.7`).toBe(true);
		}
	});
});

describe("TriggerRecord", () => {
	it("round-trips with optional fields omitted from the wire", () => {
		const trigger = sampleTrigger();
		const record = triggerRecordReceivedFrom(trigger);
		expect(record.schema_version).toBe(TRIGGER_RECORD_SCHEMA_VERSION);
		expect(record.state).toBe("received");
		const json = JSON.stringify(record);
		// Optional evaluator_decision/result_link/rule_name MUST be skipped when absent — RFC 1
		// §2.6 additive-only schema.
		expect(json).not.toContain('"evaluator_decision"');
		expect(json).not.toContain('"result_link"');
		expect(json).not.toContain('"rule_name"');
		// oracle trigger.rs:344-358 (`trigger_record_round_trip_with_optional_fields_omitted`):
		// `assert_eq!(record, decoded)` compares the DECODED value against the original TYPED
		// record, not two differently-produced JSON blobs against each other (that comparison is
		// vacuously true regardless of what the encoder/decoder actually do).
		const decoded = decodeTriggerRecord(JSON.parse(json));
		expect(decoded).toEqual(record);
	});

	it("tolerates unknown fields in the decoded wire object (additive-only schema)", () => {
		const trigger = sampleTrigger();
		const record = triggerRecordReceivedFrom(trigger);
		const withExtra = { ...JSON.parse(JSON.stringify(record)), future_field: { foo: "bar" } };
		// oracle trigger.rs:360-373 (`trigger_record_tolerates_unknown_fields`): decode through the
		// real wire-boundary parser (`decodeTriggerRecord`), not a plain object spread — a spread
		// never exercises any parsing/validation logic, so it can't actually verify unknown-field
		// tolerance the way the oracle test (which round-trips through `serde_json::from_value`)
		// does.
		const decoded = decodeTriggerRecord(withExtra);
		expect(decoded).toEqual(record);
	});

	it("exposes the stable custom_type tag used by the session jsonl reader", () => {
		expect(TRIGGER_RECORD_CUSTOM_TYPE).toBe("trigger");
	});

	it("preserves replacement_policy through received_from + wire round-trip", () => {
		const trigger = { ...sampleTrigger(), replacement_policy: "latest_replaces" as const };
		const record = triggerRecordReceivedFrom(trigger);
		expect(record.replacement_policy).toBe("latest_replaces");
		const json = JSON.stringify(record);
		expect(json).toContain('"replacement_policy":"latest_replaces"');
		const decoded = JSON.parse(json);
		expect(decoded.replacement_policy).toBe("latest_replaces");
	});

	it("omits payload_summary when the source trigger's payload_summary is null", () => {
		const trigger = { ...sampleTrigger(), payload_summary: null };
		const record = triggerRecordReceivedFrom(trigger);
		expect(record.payload_summary).toBeUndefined();
		expect(JSON.stringify(record)).not.toContain('"payload_summary"');
	});
});
