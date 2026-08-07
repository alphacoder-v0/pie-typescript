/**
 * `task` tool -- subagent / Task delegation. Spawns a fresh in-memory `Agent` (no session
 * persistence, nothing touches disk), runs a sub-prompt to completion (its own loop), and
 * returns the final assistant text to the parent agent as a single tool result.
 *
 * v1 scope (pie: crates/coding-agent/src/tools/task.rs:5-16):
 * - One subagent spec, "general": same model as parent, read-only tools (read/grep/find/ls/
 *   web_fetch -- see `subagent_read_only_tools()` in oracle's tools/mod.rs:47-59), fresh
 *   context, no persisted session.
 * - Concurrent execution mode ("parallel") so the parent can fire multiple Task calls in one
 *   turn and they run together.
 * - Parent abort cascades: the tool listens on the parent's AbortSignal and aborts its inner
 *   sub-agent immediately.
 *
 * Out of scope (oracle's follow-ups under #11, preserved as gaps here too):
 * - User-defined subagent specs via `~/.pie/subagents/*.toml`.
 * - Recursive sub-subagents (we'd need a depth cap).
 * - Cost rollup into the parent's cost tracker (each subagent has its own tracker for now).
 *
 * Construct mapping note (RULEBOOK §4, table-absent construct -- flagged for reviewer): oracle's
 * task.rs builds a *minimal* `pie_agent_core::AgentHarness` (model + `Session` wrapping
 * `MemorySessionStorage`, `system_prompt`, `tools`, `stream_fn`). The TS port skeleton has TWO
 * harness-shaped classes: the higher-level `AgentHarness` (packages/agent/src/harness/
 * agent-harness.ts, requires an `ExecutionEnv` + `Session` the coding-agent runtime doesn't
 * construct anywhere today) and the lower-level `Agent` (packages/agent/src/agent.ts, in-memory
 * transcript only, no `ExecutionEnv`/`Session` dependency, a `streamFn` field). `Agent` is the
 * class `AgentSession` (core/agent-session.ts) actually drives for the coding-agent's own top-
 * level loop, and its shape (model + systemPrompt + tools + streamFn, transcript never
 * persisted) is the closer structural match to what oracle's stripped-down
 * `AgentHarnessOptions::new(model, session)` call needed. This port uses `Agent` for the
 * subagent.
 */

import type { AgentTool, StreamFn } from "@pie/agent-core";
import { Agent } from "@pie/agent-core";
import type { Model, TextContent } from "@pie/ai";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../core/extensions/types.ts";
import { wrapToolDefinition } from "../core/tools/tool-definition-wrapper.ts";

// pie: crates/coding-agent/src/tools/task.rs:32
const SUBAGENT_TYPES = ["general"] as const;
export type TaskSubagentType = (typeof SUBAGENT_TYPES)[number];

const taskSchema = Type.Object(
	{
		// pie: crates/coding-agent/src/tools/task.rs — oracle hand-writes
		// `{"type": "string", "enum": SUBAGENT_TYPES, "default": "general", "description": ...}`.
		// See git.ts's `subcommand` for why `Type.Union([Type.Literal ...])` is the wrong wire shape.
		subagent_type: Type.Optional(
			Type.Unsafe<TaskSubagentType>({
				type: "string",
				enum: [...SUBAGENT_TYPES],
				default: "general",
				description: "Which subagent kind to spawn. v1 ships only 'general'.",
			}),
		),
		description: Type.Optional(Type.String({ description: "Short label for the task (visible in UI logs)." })),
		prompt: Type.String({ description: "Full prompt the subagent will receive as its user message." }),
	},
	// pie: crates/coding-agent/src/tools/task.rs:198 (`"additionalProperties": false`)
	{ additionalProperties: false },
);

export type TaskToolInput = Static<typeof taskSchema>;

/**
 * pie: crates/coding-agent/src/tools/task.rs:163-168 -- oracle hand-builds this `details` object
 * with literal snake_case keys (not camelCased); `details` is logs/UI-only, never sent to the
 * model, so it's kept verbatim per the same convention established by `git.ts`'s
 * `GitToolDetails`.
 */
export interface TaskToolDetails {
	subagent_type: TaskSubagentType;
	description: string;
	/** pie: task.rs:167 (`body.len()`) is Rust's UTF-8 *byte* length, not a character count,
	 * despite the field name -- replicated via `Buffer.byteLength` rather than `body.length`
	 * (which would be the UTF-16 code unit count). */
	chars: number;
}

export interface TaskToolOptions {
	/**
	 * Model used by spawned subagents. Captured once at tool-construction time so a later
	 * `/model` switch on the parent doesn't change in-flight subagent settings.
	 * pie: task.rs:39-41, 49-55 (`TaskTool::new` captures `model.clone()`).
	 */
	model: Model<any>;
	/**
	 * Optional stream function shared with the parent's `Agent`. Omitted falls back to
	 * `Agent`'s own default (`streamSimple`), mirroring oracle's "`None` falls back to
	 * `pie_ai::stream_simple`" (task.rs:42-43).
	 */
	streamFn?: StreamFn;
	/**
	 * Factory for the subagent's tool set, built fresh for every Task call so each subagent
	 * starts with its own tool instances. Read-only by convention so subagents can't write --
	 * oracle wires this to `subagent_read_only_tools()` (tools/mod.rs:47-59): read/ls/grep/find/
	 * web_fetch/git, no bash/write/edit. That wiring is intentionally NOT hardcoded here (the
	 * caller assembling the full toolset owns it), matching how `git.ts` and this tool are both
	 * left out of `core/tools/index.ts`'s registry for the same reason.
	 * pie: task.rs:34-36, 44-45 (`SubagentToolsFn`).
	 */
	subagentTools: () => AgentTool<any>[];
}

/**
 * pie: crates/coding-agent/src/tools/task.rs:102-106 -- string built with Rust's `\`
 * line-continuation (eats the newline + leading whitespace of the next source line), so the
 * actual literal has exactly two `\n`s, none of which is a source-formatting artifact.
 */
function buildSubagentSystemPrompt(description: string): string {
	return `You are a research subagent dispatched by a coding agent.\nDescription of your task: ${description}\nStay focused on the prompt; return a concise final answer.`;
}

export function createTaskToolDefinition(options: TaskToolOptions): ToolDefinition<typeof taskSchema, TaskToolDetails> {
	const { model, streamFn, subagentTools } = options;
	return {
		name: "task",
		label: "task",
		// pie: crates/coding-agent/src/tools/task.rs:177-178 (verbatim)
		description:
			"Delegate a self-contained research task to a fresh sub-agent. The subagent gets its own context window and tool set; this tool returns a single text result from the subagent. Use this when you need to inspect a large surface area (search, file reads) without polluting the main conversation.",
		parameters: taskSchema,
		// pie: crates/coding-agent/src/tools/task.rs:66-68 (`execution_mode` -> `Some(Parallel)`)
		executionMode: "parallel",
		async execute(_toolCallId, params, signal) {
			// pie: task.rs:77-86 -- defensive re-validation even though the schema already
			// constrains `subagent_type` to the enum (same defensive idiom as git.ts).
			const subagentType = (params.subagent_type ?? "general") as TaskSubagentType;
			if (!(SUBAGENT_TYPES as readonly string[]).includes(subagentType)) {
				throw new Error(`unknown subagent_type: ${subagentType} (allowed: ${SUBAGENT_TYPES.join(", ")})`);
			}
			// pie: task.rs:87-91 -- `prompt` is schema-required, but re-checked defensively;
			// `description` defaults to "" when omitted (task.rs:92-96).
			const prompt = params.prompt;
			if (!prompt) {
				throw new Error("missing required arg: prompt");
			}
			const description = params.description ?? "";

			// pie: task.rs:98-100 -- fresh in-memory session for the subagent. `Agent` (unlike
			// `AgentHarness`) has no persistence layer of its own: its transcript lives only in
			// the instance's own state and is discarded once this call returns. Nothing touches
			// disk, matching oracle's `MemorySessionStorage`.
			const sub = new Agent({
				initialState: {
					systemPrompt: buildSubagentSystemPrompt(description),
					model,
					tools: subagentTools(),
				},
				streamFn,
			});

			// pie: task.rs:111-136 -- subscribe and keep the latest non-empty assistant text
			// seen across every `MessageEnd`/`message_end` event. When the subagent makes tool
			// calls before its final answer, multiple assistant turns fire in order; always
			// overwriting `finalText` with the newest one naturally yields the LAST turn's text
			// once the loop ends, matching oracle's `*collector.lock() = text` overwrite.
			let finalText = "";
			const unsubscribe = sub.subscribe((event) => {
				if (event.type === "message_end" && "role" in event.message && event.message.role === "assistant") {
					const text = event.message.content
						.filter((block): block is TextContent => block.type === "text")
						.map((block) => block.text)
						.join("\n");
					if (text.length > 0) {
						finalText = text;
					}
				}
			});

			// pie: task.rs:138-145 -- parent abort cascades to the subagent. Oracle spawns a
			// watcher task that waits on the parent's `CancellationToken` and calls
			// `sub.abort()` when it fires; `Agent` has no persisted session storage to worry
			// about interrupting, so an `AbortSignal` listener is the direct equivalent.
			const onAbort = () => sub.abort();
			signal?.addEventListener("abort", onAbort, { once: true });

			// pie: task.rs:147 (`let run = sub.prompt(prompt).await;`) -- `Agent.prompt()` never
			// rejects for model/runtime failures (its `StreamFn` contract requires failures to be
			// encoded into a synthesized assistant message instead, see agent.ts
			// `handleRunFailure`); failures surface via `sub.state.errorMessage` afterward,
			// checked below in place of oracle's `Result::Err`.
			//
			// BUG(port): B10 -- oracle's file header (task.rs:7) claims "max 16 iterations", but
			// the harness construction chain built here (and in oracle: task.rs:98-155) applies
			// NO iteration/turn cap whatsoever. `sub.prompt()` is allowed to run the agent loop
			// to natural completion (until the assistant stops requesting tool calls), however
			// many turns that takes. This is the comment-vs-code divergence tracked as B10 in
			// migration/RULEBOOK.md §5 -- replicated verbatim (no cap added here either).
			await sub.prompt(prompt);

			signal?.removeEventListener("abort", onAbort);
			unsubscribe();

			// pie: task.rs:150-152 -- the parent-cancelled check wins regardless of how `run`
			// resolved (oracle checks `parent_cancel.is_cancelled()` before inspecting `run`'s
			// `Result`).
			if (signal?.aborted) {
				throw new Error("cancelled");
			}
			// pie: task.rs:153-155 (`if let Err(e) = run { ... "subagent failed: {e}" }`).
			if (sub.state.errorMessage) {
				throw new Error(`subagent failed: ${sub.state.errorMessage}`);
			}

			// pie: task.rs:156-161
			const body = finalText.length === 0 ? "(subagent produced no text output)" : finalText;

			return {
				content: [{ type: "text", text: body }],
				details: {
					subagent_type: subagentType,
					description,
					chars: Buffer.byteLength(body, "utf-8"),
				},
			};
		},
	};
}

export function createTaskTool(options: TaskToolOptions): AgentTool<typeof taskSchema> {
	return wrapToolDefinition(createTaskToolDefinition(options));
}
