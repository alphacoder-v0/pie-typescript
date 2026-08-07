/**
 * Trigger module glue — barrel for `packages/coding-agent/src/triggers/`.
 *
 * Port of oracle `crates/coding-agent/src/triggers/mod.rs` (pie @0a120dfd).
 *
 * §4 barrel judgment: oracle `mod.rs` is NOT a pure module-declaration file — it re-exports a
 * curated subset of each adapter's public surface (`pub use cron::{...}`, `pub use
 * dynamic::{...}`, `pub use mcp_notification_hook::McpNotificationHook`) for consumers that want
 * "the triggers module" without reaching into each file. That is exactly RULEBOOK §4's "several files
 * need an aggregate export" case, so this barrel is warranted (not the "no barrel for a single file" case).
 *
 * The re-export list below mirrors oracle's three curated `pub use` blocks one-for-one (TS names
 * are the existing camelCase identifiers `cron.ts`/`dynamic.ts`/`mcp-notification-hook.ts`
 * already export — Rust `snake_case` function names become idiomatic TS `camelCase`, which is a
 * naming-convention translation, not a wire-format concern per RULEBOOK §2.1). `triggers/dynamic.ts`
 * (manifest `coding-agent/triggers/dynamic`, phase 10) is another agent's concurrent unit in this
 * phase — this barrel only re-exports its already-landed public surface, it does not modify
 * `dynamic.ts` itself.
 */

export type { CronJob } from "./cron.ts";
export {
	CronNotificationHook,
	cronActionHook,
	cronHarnessListener,
	globalCronRegistry,
	ListCronJobsTool,
	NewCronJobTool,
	RemoveCronJobTool,
	SetCronJobStateTool,
} from "./cron.ts";
export {
	beforeTriggerActionHook,
	DynamicTriggerCheckHook,
	directInjectActionHook,
	fireOnceHarnessListener,
	globalRegistry,
	ListTriggersTool,
	NewTriggerTool,
	RemoveTriggerTool,
	SetTriggerStateTool,
} from "./dynamic.ts";
export { McpNotificationHook } from "./mcp-notification-hook.ts";
