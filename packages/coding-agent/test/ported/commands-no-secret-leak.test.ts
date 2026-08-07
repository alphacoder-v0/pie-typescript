/**
 * phase 20-5: ports the two **must not leak** assertions from upstream
 * `crates/coding-agent/src/commands.rs`.
 *
 * - `model_help_summary_lists_builtin_providers_without_secrets`
 * - `collect_trigger_audit_rows_uses_preview_safe_fields_only`
 *
 * Neither had coverage here: both `cliModelHelpText` and `collectTriggerAuditRows` exist, but no
 * test asserted that they **do not render** sensitive fields. `model-picker.test.ts` tests whether
 * a credential exists, not whether rendering leaks — a different question.
 *
 * The assertions are **upstream's**, down to the exact strings in the negative ones.
 */
import { describe, expect, it } from "vitest";
import { cliModelHelpText } from "../../src/cli/help.ts";
import { collectTriggerAuditRows } from "../../src/core/slash-dispatch-triggers.ts";

describe("commands: user-facing rendering must not leak secrets", () => {
	// pie: commands.rs `model_help_summary_lists_builtin_providers_without_secrets`
	// Four positive assertions and two negative ones. The negatives are the point: `API_KEY` or
	// `auth.json` in the help text exposes where credentials come from to anyone who runs `--help`,
	// including CI logs.
	it("/model help lists providers and custom model paths, but shows neither API_KEY nor auth.json", () => {
		const text = cliModelHelpText().join("\n");

		expect(text).toContain("Supported providers");
		expect(text).toContain("anthropic(");
		expect(text).toContain("openai(");
		expect(text).toContain("~/.pie/models.json");
		expect(text).toContain("<cwd>/.pie/models.json");

		expect(text).not.toContain("API_KEY");
		expect(text).not.toContain("auth.json");
	});

	// pie: commands.rs `collect_trigger_audit_rows_uses_preview_safe_fields_only`
	// Audit rows render preview-safe fields only. `evaluator_decision.raw_payload` is whatever an
	// external system sent in, which may hold secrets or personal data, and it does not reach the audit
	// rows. Custom entries that are not triggers are skipped entirely.
	it("trigger audit rows take preview-safe fields only; raw_payload must not appear", () => {
		const entries = [
			{
				type: "custom",
				id: "ignored",
				parentId: null,
				timestamp: "2026-05-22T19:00:00Z",
				customType: "not_trigger",
				data: { trace_id: "ignored" },
			},
			{
				type: "custom",
				id: "t1",
				parentId: null,
				timestamp: "2026-05-22T19:01:00Z",
				customType: "trigger",
				data: {
					trace_id: "trace-a",
					state: "permission_denied",
					source_label: "mcp:github",
					event_label: "pr_merged",
					payload_summary: "safe summary",
					evaluator_decision: {
						outcome: "accept",
						permission: "deny",
						reason: "policy says no",
						raw_payload: "must-not-render",
					},
				},
			},
		] as unknown as Parameters<typeof collectTriggerAuditRows>[0];

		const rows = collectTriggerAuditRows(entries, 10);

		// A custom entry that is not a trigger is skipped entirely.
		expect(rows).toHaveLength(1);
		expect(rows[0].traceId).toBe("trace-a");
		expect(rows[0].state).toBe("permission_denied");
		expect(rows[0].sourceLabel).toBe("mcp:github");
		expect(rows[0].eventLabel).toBe("pr_merged");
		expect(rows[0].summary).toBe("safe summary");

		// The serialised row must not contain the raw payload, whichever field it was put in.
		const serialized = JSON.stringify(rows);
		expect(serialized).not.toContain("must-not-render");
		expect(serialized).not.toContain("raw_payload");
	});

	// Negative control: put the same sentinel into a **preview-safe** field and it has to appear, or
	// the negative assertion above might be passing only because `collectTriggerAuditRows` renders
	// nothing at all.
	it("negative control: content in the preview-safe fields does get rendered", () => {
		const entries = [
			{
				type: "custom",
				id: "t2",
				parentId: null,
				timestamp: "2026-05-22T19:02:00Z",
				customType: "trigger",
				data: {
					trace_id: "trace-b",
					state: "accepted",
					source_label: "mcp:github",
					event_label: "pr_merged",
					payload_summary: "must-not-render",
				},
			},
		] as unknown as Parameters<typeof collectTriggerAuditRows>[0];

		const serialized = JSON.stringify(collectTriggerAuditRows(entries, 10));
		expect(serialized).toContain("must-not-render");
	});
});
