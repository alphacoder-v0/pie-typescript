/**
 * phase 21 batch A — nine inline tests from upstream `crates/coding-agent/src/commands.rs` that
 * nothing here had ever asserted.
 *
 * These are not the same tests under new names. Each covers a surface this repo **implements but
 * never asserts**:
 *
 * | upstream test | the implementation here | why it was not covered before |
 * |---|---|---|
 * | `model_credential_hint_uses_only_selected_provider_credentials` | `modelCredentialHint` | no test |
 * | `model_credential_hint_accepts_env_or_auth_store_for_selected_provider` | the same | no test |
 * | `registry_and_help_do_not_expose_removed_hub_surface` | `generalHelpText` | `commands.test.ts:61` enumerates the registry but never asserts that the removed hub surface is absent from the help text |
 * | `model_catalog_includes_custom_models_without_secret_fields` | `modelCatalogText` | no test |
 * | `unknown_model_error_lists_candidates` | `slash-dispatch-session.ts:314` | `model-detect.test.ts:47` asserts a **different message** (`model not found in catalog` at `model.ts:163`), not the one ported from upstream |
 * | `unknown_provider_error_lists_provider_candidates` | `slash-dispatch-session.ts:309` | no test |
 * | `render_triggers_status_summarizes_runtime_hooks_and_running` | `renderTriggersStatus` and two siblings | `commands-e2e.test.ts:765` asserts the `dynamic rules: 1` line, which overlaps none of the runtime, hook and running sections upstream asserts |
 * | `trigger_decision_details_explain_dedup_and_cycle_states` | `triggerDecisionDetails`, private, reached through `collectTriggerAuditRows` | no test |
 * | `skill_source_parse_error_is_fixed_and_bounded` | `parseSkillSource` | no test |
 *
 * The assertions are **upstream's**, down to the exact strings in the negative ones. Those are the
 * point: they hold the line that secrets, raw payloads and the removed hub surface stay out of
 * user-visible text.
 *
 * Hermetic: the two credential tests point `PIE_DIR` at a `mkdtemp` directory and restore it in
 * `afterEach`, so the real `~/.pie/` is never touched; the values written to the auth store are
 * synthetic and suffixed `-synthetic`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { generalHelpText, registryWithBuiltins } from "../../src/core/slash-dispatch.ts";
import { modelCatalogText, modelCredentialHint } from "../../src/core/slash-dispatch-session.ts";
import { collectTriggerAuditRows, renderTriggersStatus } from "../../src/core/slash-dispatch-triggers.ts";
import { registerCustomModel, unregisterCustomModel } from "../../src/local-models.ts";
import { parseSkillSource } from "../../src/tools/skill.ts";

// ─────────────────────────────────────────────────────────────────────────────
// modelCredentialHint —— commands.rs:3260 / :3275
// ─────────────────────────────────────────────────────────────────────────────

describe("model_credential_hint (commands.rs:941-963)", () => {
	let dir: string;
	let savedPieDir: string | undefined;
	let savedDeepseek: string | undefined;
	let savedOpenai: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pie-cred-hint-"));
		savedPieDir = process.env.PIE_DIR;
		savedDeepseek = process.env.DEEPSEEK_API_KEY;
		savedOpenai = process.env.OPENAI_API_KEY;
		// upstream: `EnvGuard::set("PIE_DIR", temp.path())` — puts the auth store in a temporary
		// directory, so the real ~/.pie/ is neither read nor written.
		process.env.PIE_DIR = dir;
	});

	afterEach(() => {
		const restore = (name: string, value: string | undefined) => {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		};
		restore("PIE_DIR", savedPieDir);
		restore("DEEPSEEK_API_KEY", savedDeepseek);
		restore("OPENAI_API_KEY", savedOpenai);
		rmSync(dir, { recursive: true, force: true });
	});

	it("names only the selected provider's env var, never another provider's key", () => {
		// pie: commands.rs:3261-3273
		//   let _deepseek = EnvGuard::remove("DEEPSEEK_API_KEY");
		//   let _openai = EnvGuard::set("OPENAI_API_KEY", "sk-openai-should-not-count");
		//   let hint = model_credential_hint("deepseek").expect("deepseek key is missing");
		//   assert!(hint.contains("DEEPSEEK_API_KEY"), "{hint}");
		//   assert!(hint.contains("/login deepseek"), "{hint}");
		//   assert!(!hint.contains("OPENAI_API_KEY"), "{hint}");
		//   assert!(!hint.contains("sk-openai-should-not-count"), "{hint}");
		delete process.env.DEEPSEEK_API_KEY;
		process.env.OPENAI_API_KEY = "sk-openai-should-not-count-synthetic";

		const hint = modelCredentialHint("deepseek");
		expect(hint, "deepseek key is missing, so a hint is expected").toBeDefined();
		expect(hint).toContain("DEEPSEEK_API_KEY");
		expect(hint).toContain("/login deepseek");
		// The two negative assertions are the point: another provider's variable name in the hint sends
		// the user to the wrong place, and its **value** in the hint is a leak outright.
		expect(hint).not.toContain("OPENAI_API_KEY");
		expect(hint).not.toContain("sk-openai-should-not-count-synthetic");
	});

	it("stays silent when the key is in the env or in the auth store", () => {
		// pie: commands.rs:3276-3293
		//   let _deepseek = EnvGuard::set("DEEPSEEK_API_KEY", "sk-deepseek-present");
		//   assert!(model_credential_hint("deepseek").is_none());
		//   drop(_deepseek);
		//   store.set("deepseek", ApiKey { value: "stored-deepseek" }); store.save().unwrap();
		//   assert!(model_credential_hint("deepseek").is_none());
		process.env.DEEPSEEK_API_KEY = "sk-deepseek-present-synthetic";
		expect(modelCredentialHint("deepseek")).toBeUndefined();

		delete process.env.DEEPSEEK_API_KEY;
		const store = AuthStorage.create(join(dir, "auth.json"));
		store.set("deepseek", { type: "api_key", key: "stored-deepseek-synthetic" });
		expect(
			modelCredentialHint("deepseek"),
			"a stored credential satisfies the check just like the env var does",
		).toBeUndefined();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// The removed hub surface — commands.rs:3306
// ─────────────────────────────────────────────────────────────────────────────

describe("removed hub surface (commands.rs:3306-3323)", () => {
	it("neither registers nor mentions the removed hub commands", () => {
		// pie: commands.rs:3307-3322
		//   for removed in ["hub", "endpoint", "config"] { assert!(r.find(removed).is_none()); }
		//   let help = help_text(&r, None);
		//   for removed in ["/hub", "/endpoint", "hub.inject", "pie.0xfefe.me"] {
		//       assert!(!help.contains(removed), ...);
		//   }
		const registry = registryWithBuiltins();
		for (const removed of ["hub", "endpoint", "config"]) {
			expect(registry.find(removed), `/${removed} should not be registered`).toBeUndefined();
		}

		// `commands.test.ts:61` enumerates the registry's 30 names, which is equivalent to the three
		// assertions above. The four negative assertions below are what this case adds — general help is
		// a separate rendering path.
		const help = generalHelpText(registry, []);
		for (const removed of ["/hub", "/endpoint", "hub.inject", "pie.0xfefe.me"]) {
			expect(help, `help should not expose removed hub surface \`${removed}\``).not.toContain(removed);
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// The model catalog and its error messages — commands.rs:3368 / :3385 / :3393
// ─────────────────────────────────────────────────────────────────────────────

describe("model catalog and unknown-spec errors (commands.rs:1297-1390)", () => {
	const PROVIDER = "help-test-provider";
	const ID = "secret-free";

	afterEach(() => {
		unregisterCustomModel(PROVIDER, ID);
	});

	it("lists a custom model without leaking its baseUrl, key, or headers", () => {
		// pie: commands.rs:3369-3383
		//   pie_ai::register_custom_model(custom_test_model(&provider.0, id));
		//   let text = model_catalog_text(Some(&provider.0)).unwrap();
		//   assert!(text.contains("help-test-provider"), "{text}");
		//   assert!(text.contains(id), "{text}");
		//   assert!(text.contains("Secret Free Model"), "{text}");
		//   assert!(!text.contains("secret-base"), "{text}");
		//   assert!(!text.contains("sk-secret"), "{text}");
		//   assert!(!text.contains("Authorization"), "{text}");
		//
		// The fixture copies upstream's `custom_test_model` (commands.rs:3196-3221): every connection
		// detail is a recognisable sentinel, so any of them appearing in the catalog is a rendering leak
		// rather than a coincidence.
		registerCustomModel({
			id: ID,
			name: "Secret Free Model",
			api: "openai-responses",
			provider: PROVIDER,
			baseUrl: "https://secret-base.example/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 4096,
			headers: { Authorization: "Bearer sk-secret-should-not-leak" },
		} as never);

		const catalog = modelCatalogText(PROVIDER);
		expect("error" in catalog ? catalog.error : undefined, "the provider should resolve").toBeUndefined();
		const text = "text" in catalog ? catalog.text : "";

		expect(text).toContain(PROVIDER);
		expect(text).toContain(ID);
		expect(text).toContain("Secret Free Model");
		// Three negative assertions: the catalog is printed for the user, and a custom model's connection
		// details do not belong in it.
		expect(text).not.toContain("secret-base");
		expect(text).not.toContain("sk-secret");
		expect(text).not.toContain("Authorization");
	});

	it("lists candidate model ids when the id is unknown", async () => {
		// pie: commands.rs:3386-3391
		//   let message = unknown_model_error("anthropic", "definitely-not-a-model");
		//   assert!(message.contains("unknown model in catalog"), "{message}");
		//   assert!(message.contains("Candidates:"), "{message}");
		//   assert!(message.contains("claude"), "{message}");
		//
		// `unknownModelError` is module-private here. Upstream's `#[cfg(test)]` module can see private
		// items; a separate test file cannot, so this reaches it through the exported `runModelCommand`.
		// That branch returns before it touches `ctx.harness`, so no real harness has to be built.
		const { runModelCommand } = await import("../../src/core/slash-dispatch-session.ts");
		const outcome = await runModelCommand(["anthropic:definitely-not-a-model"], {} as never);
		expect(outcome.kind).toBe("error");
		const message = outcome.kind === "error" ? outcome.message : "";
		expect(message).toContain("unknown model in catalog");
		expect(message).toContain("Candidates:");
		expect(message).toContain("claude");
	});

	it("lists candidate providers with their model counts when the provider is unknown", () => {
		// pie: commands.rs:3394-3400
		//   let message = unknown_provider_error("definitely-not-a-provider", &groups);
		//   assert!(message.contains("unknown provider"), "{message}");
		//   assert!(message.contains("anthropic("), "{message}");
		//   assert!(message.contains("openai("), "{message}");
		const catalog = modelCatalogText("definitely-not-a-provider");
		expect("error" in catalog, "an unknown provider filter must be an error, not an empty listing").toBe(true);
		const message = "error" in catalog ? catalog.error : "";
		expect(message).toContain("unknown provider");
		// `anthropic(` includes the opening parenthesis: the assertion is about the `provider(count)`
		// format, not merely that the name appears.
		expect(message).toContain("anthropic(");
		expect(message).toContain("openai(");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Trigger rendering — commands.rs:3402 / :3527
// ─────────────────────────────────────────────────────────────────────────────

describe("trigger status rendering (commands.rs:2700-2955)", () => {
	it("summarizes runtime counters, hook attention, and running traces", async () => {
		// pie: commands.rs:3436-3454
		//   let status = render_triggers_status(&snapshot).join("\n");
		//   assert!(status.contains("accepted=7"));   assert!(status.contains("recent_traces=6"));
		//   assert!(status.contains("1 total"));      assert!(status.contains("1 require attention"));
		//   assert!(status.contains("running=1"));
		//   assert!(status.contains("push trigger sources: 1 configured source"));
		//   let sources = render_trigger_sources(&snapshot.hooks).join("\n");
		//   assert!(sources.contains("disconnected (protocol_mismatch)"));
		//   assert!(sources.contains("queued=2"));
		//   assert!(sources.contains("subscriptions: repo c4pt0r/pie"));
		//   assert!(sources.contains("attention: upgrade hub"));
		//   let running = render_running_triggers(&snapshot.running).join("\n");
		//   assert!(running.contains("trace-1"));
		//   assert!(running.contains("mcp:github / pr_merged"));
		//   assert!(running.contains("summarize release"));
		const { renderRunningTriggers, renderTriggerSources } = await import("../../src/core/slash-dispatch-triggers.ts");
		// Field naming here is mixed: `hooks.*` keeps upstream's snake_case, because those are hub wire
		// protocol field names and renaming them would make the protocol harder to compare, while
		// `runtime.*` and `running.*` are camelCase. The fixture has to match, or renderTriggersStatus
		// crashes on `hook.subscription_labels`.
		const hooks = [
			{
				state: { kind: "disconnected", reason: "protocol_mismatch" },
				last_event_at: null,
				last_ack_at: null,
				last_error: "bad frame",
				queued_count: 2,
				dropped_count: 3,
				deduped_count: 4,
				subscription_labels: ["repo c4pt0r/pie"],
				requires_attention: "upgrade hub",
			},
		];
		const snapshot = {
			hooks,
			runtime: {
				dedupEntries: 5,
				activeTraces: 6,
				acceptedTotal: 7,
				dedupedTotal: 8,
				cycleSuppressedTotal: 9,
			},
			running: [
				{
					traceId: "trace-1",
					sourceLabel: "mcp:github",
					eventLabel: "pr_merged",
					startedAt: "2026-05-22T19:00:00Z",
					promptPreview: "summarize release",
				},
			],
		} as never;

		const status = renderTriggersStatus(snapshot).join("\n");
		expect(status).toContain("accepted=7");
		expect(status).toContain("recent_traces=6");
		expect(status).toContain("1 total");
		expect(status).toContain("1 require attention");
		expect(status).toContain("running=1");
		expect(status).toContain("push trigger sources: 1 configured source");

		const sources = renderTriggerSources(hooks as never).join("\n");
		expect(sources).toContain("disconnected (protocol_mismatch)");
		expect(sources).toContain("queued=2");
		expect(sources).toContain("subscriptions: repo c4pt0r/pie");
		expect(sources).toContain("attention: upgrade hub");

		const running = renderRunningTriggers((snapshot as { running: never }).running).join("\n");
		expect(running).toContain("trace-1");
		expect(running).toContain("mcp:github / pr_merged");
		expect(running).toContain("summarize release");
	});

	it("explains dedup and cycle-suppression decisions without echoing the raw payload", () => {
		// pie: commands.rs:3528-3553
		//   let dedup = trigger_decision_details(&json!({ "evaluator_decision": {
		//       "outcome": "deduped", "replacement_policy": "latest_replaces",
		//       "previous_trace_id": "trace-old", "raw_payload": "must-not-render" }})).join("\n");
		//   assert!(dedup.contains("decision: deduped"));
		//   assert!(dedup.contains("previous_trace_id: trace-old"));
		//   assert!(dedup.contains("replacement_policy: latest_replaces"));
		//   assert!(!dedup.contains("must-not-render"));
		//   let cycle = ... "outcome": "cycle_suppressed", "hop_count": 6 ...
		//   assert!(cycle.contains("decision: cycle_suppressed"));
		//   assert!(cycle.contains("hop_count: 6"));
		//
		// `triggerDecisionDetails` is module-private; this reaches it through the exported
		// `collectTriggerAuditRows`, which is the same path `/triggers audit` takes.
		const dedupRows = collectTriggerAuditRows(
			[
				{
					type: "custom",
					customType: "trigger",
					data: {
						state: "deduped",
						evaluator_decision: {
							outcome: "deduped",
							replacement_policy: "latest_replaces",
							previous_trace_id: "trace-old",
							raw_payload: "must-not-render",
						},
					},
				} as never,
			],
			10,
		);
		const dedup = dedupRows.flatMap((r) => r.details).join("\n");
		expect(dedup).toContain("decision: deduped");
		expect(dedup).toContain("previous_trace_id: trace-old");
		expect(dedup).toContain("replacement_policy: latest_replaces");
		// raw_payload is whatever an external system sent in, which may hold secrets or personal data.
		// It does not reach the audit rows.
		expect(dedup).not.toContain("must-not-render");

		const cycleRows = collectTriggerAuditRows(
			[
				{
					type: "custom",
					customType: "trigger",
					data: {
						state: "cycle_suppressed",
						evaluator_decision: { outcome: "cycle_suppressed", hop_count: 6 },
					},
				} as never,
			],
			10,
		);
		const cycle = cycleRows.flatMap((r) => r.details).join("\n");
		expect(cycle).toContain("decision: cycle_suppressed");
		expect(cycle).toContain("hop_count: 6");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// parseSkillSource —— commands.rs:3576
// ─────────────────────────────────────────────────────────────────────────────

describe("parse_skill_source error (set_skill_state.rs:277-289)", () => {
	it("uses a fixed message that never echoes the rejected input", () => {
		// pie: commands.rs:3577-3581
		//   let err = parse_skill_source("user-secret-token").unwrap_err();
		//   assert!(err.contains("expected one of"), "{err}");
		//   assert!(!err.contains("user-secret-token"), "{err}");
		//
		// The negative assertion is the point: `source` is a caller-supplied string, and echoing it into
		// the error message puts it into the log. Upstream's message is therefore **fixed and bounded**.
		let message = "";
		try {
			parseSkillSource("user-secret-token");
			throw new Error("parseSkillSource should have rejected an unknown source");
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain("expected one of");
		expect(message).not.toContain("user-secret-token");
	});
});
