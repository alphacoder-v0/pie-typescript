/**
 * Local stand-ins for types/functions that `packages/coding-agent/src/triggers/cron.ts`
 * (port of oracle `crates/coding-agent/src/triggers/cron.rs`) still needs but that have no real
 * counterpart in `@pie/agent-core` yet.
 *
 * FF3 switchover (phase 10, `migration/reviews/agent/forward-flags.md`): phase 8 landed real
 * `@pie/agent-core` exports for `Trigger`/`TriggerSource`/`TriggerAuthority`/`TriggerRecord`
 * (`harness/trigger.ts`), `NotificationHook`/`NotificationHookStatus`/`HookError`/`HookState`/
 * `TriggerSink` (`harness/notification-hook.ts`), `TriggerRuntimeSnapshot`
 * (`harness/trigger-runtime.ts`), and `HarnessEvent`/`HarnessListener`/`BeforeTriggerActionHook`/
 * `BeforeTriggerActionContext`/`TriggerAction`/`PromoteAction`/`ToolExecutionMode`
 * (`harness/agent-harness.ts` + `types.ts`); phase 10 ported `crate::inbox` to
 * `packages/coding-agent/src/inbox.ts`. `cron.ts` now imports all of those from their real
 * homes — the corresponding stubs that used to live in this file were deleted here.
 *
 * What's still a local stand-in, and why:
 *
 * - `AgentTool`/`ToolDefinition`/`AgentToolResult`/`AgentToolUpdate`/`AgentToolError`/
 *   `CancellationSignal` — pie's Rust `AgentTool` trait (method-based: `definition()`, `label()`,
 *   `execute(id, params, cancel, on_update)`) does not structurally match the real
 *   `@pie/agent-core` `AgentTool<TParameters extends TSchema, TDetails>` (an object-literal shape
 *   with a typebox `parameters: TSchema` and a `label: string` *field*, not a method). Which
 *   shape pie's `AgentTool` becomes is a design decision this switchover task is not authorized
 *   to make silently (see this stub's original phase-5 note, preserved below) — reconciling the
 *   two remains open. cron.ts's four tool classes (`NewCronJobTool` etc.) keep implementing this
 *   local trait-shaped interface until that design question is resolved.
 * - `HarnessCell`/`AgentHarness` (local)/`AgentHarnessSession` — the real `@pie/agent-core`
 *   `AgentHarness` class (`harness/agent-harness.ts`) holds its `Session` in a *private* field
 *   and exposes no public method for an external tool to append a custom audit entry
 *   (`appendCustomEntry`/`appendCustomMessageEntry` are only called internally, e.g. at
 *   agent-harness.ts:1122,1956,2047,2373,2386). There is no real public surface yet for
 *   `writeToolCronControlAudit`'s `instance.session().appendCustom(...)` call to switch to.
 *
 * Every export below is still `TODO(port)`: once a real counterpart lands, delete the stub here
 * and repoint cron.ts's import at the real module.
 */

import { randomUUID } from "node:crypto";
import type { ToolExecutionMode } from "@pie/agent-core";

/* -----------------------------------------------------------------------------------------
 * Shared helpers
 * --------------------------------------------------------------------------------------- */

/** Rust `Uuid::new_v4().simple()` — 32 lowercase hex chars, no dashes. */
export function simpleUuid(): string {
	return randomUUID().replace(/-/g, "");
}

/* -----------------------------------------------------------------------------------------
 * pie_ai::{Tool, UserContentBlock}
 *
 * `@pie/ai` already exports a `Tool<TParameters extends TSchema>` (packages/ai/src/types.ts)
 * but its `parameters` is a typebox TSchema; pie_ai::Tool's `parameters` is a free-form JSON
 * Schema `serde_json::Value` (see oracle NEW_CRON_JOB_TOOL etc. built via `json!({...})`).
 * A plain-object JSON Schema literal is not structurally assignable to TSchema, so this unit
 * uses a local shape instead of forcing a typebox cast at every tool definition.
 * --------------------------------------------------------------------------------------- */

// TODO(port): reconcile with @pie/ai's typebox Tool<TSchema> (tracked outside this unit; not a
// phase-8 concern specifically — it's a pie_ai::Tool vs @pie/ai::Tool shape mismatch).
export interface ToolDefinition {
	name: string;
	description: string;
	parameters: unknown;
}

export type UserContentBlock = { type: "text"; text: string };

export function textBlock(text: string): UserContentBlock {
	return { type: "text", text };
}

/* -----------------------------------------------------------------------------------------
 * pie_agent_core::{AgentTool, AgentToolResult, AgentToolError, AgentToolUpdate} —
 * crates/agent/src/types.rs.
 *
 * pi's base `packages/agent/src/types.ts` already has an `AgentTool<TParameters, TDetails>`
 * (object-literal shape, AbortSignal-based cancellation, no `permissionClassification`); pie's
 * Rust trait is documented as "1:1 port of packages/agent/src/types.ts" PLUS pie-only additions
 * (`permission_classification`, `cancel: CancellationToken` positional). Neither existing TS
 * tool shape in this repo (pi's base AgentTool, or coding-agent's own richer
 * `core/extensions/types.ts` ToolDefinition authoring shape) matches pie's trait signature, and
 * deciding which one pie's AgentTool becomes is design work outside a mechanical stub switchover
 * (see file header). This local shape mirrors the Rust trait method-for-method so cron.ts's 4
 * tool impls port faithfully in isolation; wiring them into a real tool registry is a follow-up
 * integration task.
 *
 * `ToolExecutionMode` itself has switched to the real `@pie/agent-core` export (identical
 * `"sequential" | "parallel"` shape, zero risk) — cron.ts imports it from there now.
 * --------------------------------------------------------------------------------------- */

// TODO(port): reconcile with @pie/agent-core's AgentTool<TParameters, TDetails> (see file header).
export interface AgentToolResult {
	content: UserContentBlock[];
	details: unknown;
	terminate?: boolean;
}

// TODO(port): reconcile with @pie/agent-core's AgentToolUpdateCallback<T> (see file header).
export type AgentToolUpdate = (result: AgentToolResult) => void;

// TODO(port): reconcile with @pie/agent-core's AgentToolError (see file header). Rust: enum AgentToolError { Message(String), Other(...) }
export class AgentToolError extends Error {
	static message(text: string): AgentToolError {
		return new AgentToolError(text);
	}
}

// TODO(port): reconcile with @pie/agent-core's AgentTool (see file header). Rust:
// tokio_util::sync::CancellationToken. cron.rs's four AgentTool impls all take
// `_cancel: CancellationToken` but never read it — AbortSignal stands in for the (currently
// unused) cancellation channel per Node idiom.
export type CancellationSignal = AbortSignal;

// TODO(port): reconcile with @pie/agent-core's AgentTool<TParameters, TDetails> (see file header).
export interface AgentTool {
	definition(): ToolDefinition;
	label(): string;
	executionMode?(): ToolExecutionMode | undefined;
	execute(
		id: string,
		params: unknown,
		cancel: CancellationSignal,
		onUpdate?: AgentToolUpdate,
	): Promise<AgentToolResult>;
}

/* -----------------------------------------------------------------------------------------
 * crate::bug_report::redact — now the real port.
 *
 * Oracle's `cron.rs` calls `crate::bug_report::redact` directly, so cron gets the full
 * ten-pattern redactor, not a subset. Re-exported here (rather than repointing cron.ts's import)
 * to keep cron.ts's import list untouched — it belongs to another unit.
 * --------------------------------------------------------------------------------------- */

export { redact } from "../bug-report.ts";

/* -----------------------------------------------------------------------------------------
 * pie_agent_core::harness::agent_harness — crates/agent/src/harness/agent_harness.rs. Only the
 * `HarnessCell`/`AgentHarness`/`AgentHarnessSession` slice `writeToolCronControlAudit` needs:
 * a lazily-settable handle to the running harness's session, for appending a control-plane audit
 * entry from outside the harness. The real `AgentHarness` class exposes no such public surface
 * yet (see file header) — TODO(port): once it does, delete this section and repoint
 * `writeToolCronControlAudit` at the real export.
 * --------------------------------------------------------------------------------------- */

// TODO(port): replace once @pie/agent-core's AgentHarness exposes a public session-append surface.
// Only the `session().appendCustom(...)` surface cron.rs's `write_tool_cron_control_audit` needs
// is modeled.
export interface AgentHarnessSession {
	/** Throws on failure (Rust: `Result<String, SessionError>`). */
	appendCustom(customType: string, payload: unknown): Promise<string>;
}

// TODO(port): replace once @pie/agent-core's AgentHarness exposes a public session-append surface.
export interface AgentHarness {
	session(): AgentHarnessSession;
}

/**
 * Rust: `type HarnessCell = Arc<OnceCell<Arc<AgentHarness>>>` — a lazily-settable cell so tools
 * can be constructed before the harness they'll eventually run under exists. `get()` returns
 * `undefined` until the cell is filled.
 */
// TODO(port): replace once @pie/agent-core's AgentHarness exposes a public session-append surface.
export interface HarnessCell {
	get(): AgentHarness | undefined;
}
