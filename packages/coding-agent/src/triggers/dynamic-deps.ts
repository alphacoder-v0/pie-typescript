/**
 * Local stand-ins for types/functions that `packages/coding-agent/src/triggers/dynamic.ts` (port
 * of oracle `crates/coding-agent/src/triggers/dynamic.rs`) needs but that live in units which have
 * not been ported yet:
 *
 * - `pie_agent_core::{AgentTool, ToolExecutionMode}` — the pie Rust `AgentTool` trait shape
 *   (`fn definition(&self) -> &Tool`, `fn label(&self) -> &str`, `fn execution_mode(&self) ->
 *   Option<ToolExecutionMode>`, `fn permission_classification(&self, ...) ->
 *   PermissionClassification`, `async fn execute(...)`). Neither of the two `AgentTool` shapes
 *   already in this repo matches this trait method-for-method: `@pie/agent-core`'s own
 *   `AgentTool<TParameters, TDetails>` (packages/agent/src/types.ts) is an object-literal shape
 *   with `parameters` typed as a typebox `TSchema` — pie's `pie_ai::Tool.parameters` is a
 *   free-form `serde_json::Value` JSON Schema (see `NEW_TRIGGER_TOOL` etc., built via `json!({...})`
 *   in the oracle), which is not structurally assignable to `TSchema`; and
 *   `packages/coding-agent/src/triggers/cron-deps.ts`'s own local `AgentTool` stand-in (same
 *   judgment call, cron.rs's 4 tools) has no `permissionClassification` hook at all, because none
 *   of cron.rs's tools override `permission_classification` — dynamic.rs's `NewTriggerTool`,
 *   `RemoveTriggerTool`, and `SetTriggerStateTool` all do (issue #110 sub-PR 3 classifiers), so
 *   this unit needs a strictly wider shape and defines its own copy rather than importing
 *   cron-deps.ts's narrower one (deciding which shape pie's `AgentTool` ultimately becomes is
 *   still open cross-unit design work, per cron-deps.ts's own header note).
 * - `pie_agent_core::PermissionClassification`, `AgentToolResult`, `AgentToolUpdate`,
 *   `AgentToolError` ARE already real in `@pie/agent-core` (packages/agent/src/types.ts) and are
 *   re-exported here rather than duplicated — their shapes are generic pie tool infrastructure,
 *   unrelated to the `AgentTool`/`Tool` parameters-schema mismatch above.
 *
 * Field-naming note: matches cron-deps.ts's own convention — idiomatic TS camelCase throughout;
 * none of these are wire structures this unit itself serializes (`DynamicTriggerRule`, the actual
 * wire structure, lives in dynamic.ts with oracle-exact snake_case field names per RULEBOOK §2.1).
 */

import { randomUUID } from "node:crypto";
import {
	AgentToolError,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type PermissionClassification,
} from "@pie/agent-core";

/** Rust `Uuid::new_v4().simple()` — 32 lowercase hex chars, no dashes. */
export function simpleUuid(): string {
	return randomUUID().replace(/-/g, "");
}

/* -----------------------------------------------------------------------------------------
 * pie_ai::{Tool, UserContentBlock} — see cron-deps.ts's identical judgment call.
 * --------------------------------------------------------------------------------------- */

// TODO(port): reconcile with @pie/ai's typebox Tool<TSchema> (tracked outside this unit; not a
// phase-10 concern specifically — it's a pie_ai::Tool vs @pie/ai::Tool shape mismatch, same as
// cron-deps.ts's identical TODO).
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
 * pie_agent_core::{AgentTool, ToolExecutionMode} — crates/agent/src/types.rs.
 * --------------------------------------------------------------------------------------- */

// TODO(port): replace with @pie/agent-core export once the pie_agent_core::AgentTool trait vs.
// @pie/agent-core::AgentTool object-literal design question (see file header) is resolved.
export type ToolExecutionMode = "sequential" | "parallel";

// TODO(port): replace with @pie/agent-core export (see file header). Rust:
// tokio_util::sync::CancellationToken. dynamic.rs's 4 AgentTool impls all take
// `_cancel: CancellationToken` but never read it — AbortSignal stands in for the (currently
// unused) cancellation channel per Node idiom.
export type CancellationSignal = AbortSignal;

// Re-exported (not duplicated) real @pie/agent-core infrastructure this unit's tools also need.
export { AgentToolError };
export type { AgentToolResult, AgentToolUpdateCallback as AgentToolUpdate, PermissionClassification };

// TODO(port): replace with @pie/agent-core export once the design question above resolves.
export interface AgentTool {
	definition(): ToolDefinition;
	label(): string;
	executionMode?(): ToolExecutionMode | undefined;
	/**
	 * Issue #110 sub-PR 3 classifier hook. Evaluated before `beforeToolCall`; omitted behaves as
	 * `{ type: "allow" }` (pie_agent_core::AgentTool::permission_classification's default).
	 */
	permissionClassification?(preparedArgs: unknown): PermissionClassification;
	execute(
		id: string,
		params: unknown,
		cancel: CancellationSignal,
		onUpdate?: AgentToolUpdateCallback<unknown>,
	): Promise<AgentToolResult<unknown>>;
}
