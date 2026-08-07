/**
 * Registration face for the eight cron / dynamic-trigger tools.
 *
 * pie: `crates/coding-agent/src/main.rs:648-655` — oracle pushes `new_cron_job_tool`,
 * `list_cron_jobs_tool`, `remove_cron_job_tool`, `set_cron_job_state_tool`, `new_trigger_tool`,
 * `list_triggers_tool`, `remove_trigger_tool` and `set_trigger_state_tool` onto the same
 * `Vec<Arc<dyn AgentTool>>` the coding agent hands to `AgentHarness::new`, immediately after the
 * skill family (`tools/index.ts`'s `defaultToolDefinitions` covers that prefix) and immediately
 * before the MCP tools (`main.rs:672`, appended by `core/agent-session-services.ts`).
 * Registration ORDER is user-visible — it is the order tools appear in the model-facing tool
 * list — so this module preserves oracle's exactly.
 *
 * ## Why an adapter rather than direct registration
 *
 * `cron.ts` / `dynamic.ts` implement the *Rust trait* shape of `AgentTool` (method-based:
 * `definition()`, `label()`, `execute(id, params, cancel, onUpdate)`, with `parameters` a free-form
 * JSON Schema literal) that `cron-deps.ts` / `dynamic-deps.ts` model, because pie's
 * `pie_agent_core::AgentTool` trait does not structurally match `@pie/agent-core`'s object-literal
 * `AgentTool<TParameters extends TSchema, TDetails>`. Reconciling those two shapes is open design
 * work those files' headers deliberately deferred (`TODO(port)` there). This module is the
 * minimum bridge that lets the *existing* ports reach the product registry without pre-empting
 * that decision: a mechanical, per-method projection onto `ToolDefinition`, exactly parallel to
 * `core/tools/tool-definition-wrapper.ts`'s `createToolDefinitionFromAgentTool` (which does the
 * same job for MCP tools, including the same `parameters as any` widening — the JSON Schema
 * literal is not a typebox `TSchema`).
 *
 * TODO(port): delete this module once `cron.ts`/`dynamic.ts` can implement the real
 * `@pie/agent-core` `AgentTool` shape directly.
 */

import type { AgentToolResult, AgentToolUpdateCallback, PermissionClassification } from "@pie/agent-core";
import type { ToolDefinition } from "../core/extensions/types.ts";
import { ListCronJobsTool, NewCronJobTool, RemoveCronJobTool, SetCronJobStateTool } from "./cron.ts";
import { ListTriggersTool, NewTriggerTool, RemoveTriggerTool, SetTriggerStateTool } from "./dynamic.ts";

/**
 * The trait-shaped surface both `cron-deps.ts` and `dynamic-deps.ts` declare. Structurally the
 * union of the two (cron's has no `permissionClassification`; dynamic's does), so a value of
 * either local `AgentTool` type satisfies it.
 */
interface TriggerAgentTool {
	definition(): { name: string; description: string; parameters: unknown };
	label(): string;
	executionMode?(): "sequential" | "parallel" | undefined;
	permissionClassification?(preparedArgs: unknown): PermissionClassification;
	execute(
		id: string,
		params: unknown,
		cancel: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<any>,
	): Promise<AgentToolResult<any>>;
}

/**
 * Project one trait-shaped trigger tool onto the definition-first shape AgentSession's registry
 * speaks. `permissionClassification` is forwarded only when the source tool declares one, so cron's
 * four tools stay classifier-free (oracle: `AgentTool::permission_classification`'s default is
 * `Allow`) while dynamic's three classified tools keep their `Prompt` gates.
 */
function toToolDefinition(tool: TriggerAgentTool): ToolDefinition<any, any> {
	const { name, description, parameters } = tool.definition();
	const classifier = tool.permissionClassification?.bind(tool);
	const definition: ToolDefinition<any, any> = {
		name,
		label: tool.label(),
		description,
		parameters: parameters as any,
		executionMode: tool.executionMode?.(),
		execute: async (toolCallId, params, signal, onUpdate) =>
			// `cancel: CancellationToken` is positional and non-optional on the Rust trait; none of
			// the eight impls ever reads it, but a never-aborting signal is the faithful stand-in
			// when the registry hands us `undefined`.
			tool.execute(toolCallId, params, signal ?? new AbortController().signal, onUpdate),
	};
	if (classifier) {
		definition.permissionClassification = classifier;
	}
	return definition;
}

/**
 * pie: main.rs:648-655, in oracle's push order.
 *
 * The four cron tools are constructed without a `HarnessCell`: oracle threads one so
 * `write_tool_cron_control_audit` can append a control-plane audit entry to the live harness
 * session, and `cron-deps.ts`'s header records that `@pie/agent-core`'s `AgentHarness` exposes no
 * public session-append surface to bind it to. Passing nothing is the already-ported best-effort
 * path inside `cron.ts` (audit skipped, tool result unchanged) — TODO(port): bind the cell once
 * that public surface lands.
 */
export function triggerToolDefinitions(): ToolDefinition<any, any>[] {
	return [
		toToolDefinition(new NewCronJobTool()),
		toToolDefinition(new ListCronJobsTool()),
		toToolDefinition(new RemoveCronJobTool()),
		toToolDefinition(new SetCronJobStateTool()),
		toToolDefinition(new NewTriggerTool()),
		toToolDefinition(new ListTriggersTool()),
		toToolDefinition(new RemoveTriggerTool()),
		toToolDefinition(new SetTriggerStateTool()),
	];
}
