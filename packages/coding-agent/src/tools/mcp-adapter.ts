/**
 * Adapter that wraps an MCP-server-side tool as an `@pie/agent-core` `AgentTool`.
 *
 * One `McpAgentTool` corresponds to one tool name on one server. Tool calls are dispatched
 * through the supplied `McpClient`; the result's `content` blocks are mapped to the agent's
 * `TextContent`/`ImageContent` set. Errors from the MCP server become `AgentToolError` so the
 * agent loop synthesizes a clean tool-error response.
 *
 * pie: crates/coding-agent/src/tools/mcp_adapter.rs.
 *
 * Dependency note (RULEBOOK §4: "mcp is a standalone leaf package, referenced only by coding-agent"): this is the first
 * `packages/coding-agent` source file to import `@pie/mcp`, so `@pie/mcp` was added to
 * `packages/coding-agent/package.json`'s `dependencies` (matching the version pattern already
 * used for `@pie/agent-core`/`@pie/ai`/`@pie/tui`) to make this import resolvable -- `@pie/mcp`
 * itself is untouched (phase 6, 38 tests green), only imported here.
 *
 * Construct mapping note (no ToolDefinition wrapper): unlike the filesystem/shell tools under
 * `core/tools/` and `tools/git.ts`, an MCP tool's parameter schema is a raw JSON Schema object
 * supplied by the remote server at discovery time -- there is no static TypeBox shape to give a
 * `ToolDefinition<TParams, ...>` for CLI rendering purposes, and oracle's own `McpAgentTool`
 * doesn't have one either (no `render_call`/`render_result` equivalent). This class implements
 * `AgentTool` directly (RULEBOOK §2.1: `struct` + `impl Trait` -> `class` + `implements
 * interface`), matching oracle's `struct McpAgentTool` + `impl AgentTool for McpAgentTool` 1:1,
 * the same way `packages/ai/src/utils/validation.ts`'s `validateToolArguments` already supports
 * plain (non-TypeBox-authored) JSON Schema objects as `Tool.parameters` -- see its
 * `hasTypeBoxMetadata`/`coerceWithJsonSchema` fallback path.
 */

import type { AgentTool, AgentToolResult, ToolExecutionMode } from "@pie/agent-core";
import { AgentToolError } from "@pie/agent-core";
import type { ImageContent, TextContent } from "@pie/ai";
import type { McpClient, McpTool, McpToolCallResult } from "@pie/mcp";
import { McpError } from "@pie/mcp";
import type { TSchema } from "typebox";

/** pie: mcp_adapter.rs:108-111 (`json!({ "name": ..., "isError": false })`). */
export interface McpAgentToolDetails {
	name: string;
	isError: boolean;
}

/**
 * Build an adapter for one server-side tool. Tool-name collision disambiguation across
 * multiple MCP servers (e.g. two servers both exposing a tool named `search`) is the caller's
 * responsibility -- oracle's own `McpAgentTool::new` (mcp_adapter.rs:25-37) takes the tool name
 * as given, unmodified, and does no disambiguation itself either; that policy lives in the
 * (out-of-scope) loader that constructs one `McpAgentTool` per catalog entry across all
 * configured servers (`mcp_loader.rs:233`), not in this adapter.
 */
export class McpAgentTool implements AgentTool<TSchema, McpAgentToolDetails> {
	readonly name: string;
	// pie: mcp_adapter.rs:45-47 (`fn label(&self) -> &str { &self.definition.name }`)
	readonly label: string;
	readonly description: string;
	// pie: mcp_adapter.rs:34 (`input_schema: tool.input_schema.clone()`) -- forwarded verbatim,
	// no schema transformation. `McpTool.inputSchema` is an untyped raw JSON Schema value (see
	// packages/mcp/src/protocol.ts), not a TypeBox-authored schema; that's the expected shape
	// for a dynamically-discovered MCP tool and is handled by `validateToolArguments`'s
	// non-TypeBox-metadata fallback path (packages/ai/src/utils/validation.ts).
	readonly parameters: TSchema;
	// pie: mcp_adapter.rs:48-51 (`execution_mode` -> always `Some(Parallel)`; "MCP tool calls
	// are individually cheap; let them run in parallel by default.")
	readonly executionMode: ToolExecutionMode = "parallel";

	private readonly client: McpClient;

	constructor(client: McpClient, tool: McpTool) {
		this.client = client;
		this.name = tool.name;
		this.label = tool.name;
		this.description = tool.description ?? "";
		this.parameters = (tool.inputSchema ?? {}) as TSchema;
	}

	async execute(
		_toolCallId: string,
		params: unknown,
		signal?: AbortSignal,
	): Promise<AgentToolResult<McpAgentToolDetails>> {
		// pie: mcp_adapter.rs:60-76 -- the harness cancel signal is plumbed straight into
		// `McpClient.toolsCall`'s own `signal` parameter (TS: `AbortSignal`, no separate
		// `CancellationToken` wrapper needed) so a cancelled call also releases the inflight
		// slot on the wire and sends `notifications/cancelled` to the server, rather than
		// merely abandoning the wait locally while the request keeps running server-side.
		let result: McpToolCallResult;
		try {
			result = await this.client.toolsCall(this.name, params, signal);
		} catch (error) {
			if (error instanceof McpError && error.code === "cancelled") {
				// pie: mcp_adapter.rs:72-74
				throw AgentToolError.message("cancelled");
			}
			// pie: mcp_adapter.rs:75 (`Err(e) => ... format!("mcp call: {e}")`) -- `error.message`
			// already carries the same formatted text `McpError`'s Display impl would produce
			// (each `McpError` static factory sets `.message` to that exact string).
			throw AgentToolError.message(`mcp call: ${error instanceof Error ? error.message : String(error)}`);
		}

		// pie: mcp_adapter.rs:78-95 -- map each MCP `ToolContent` variant to the agent's
		// content-block set.
		const content: (TextContent | ImageContent)[] = [];
		for (const block of result.content) {
			if (block.type === "text") {
				content.push({ type: "text", text: block.text });
			} else if (block.type === "image") {
				content.push({ type: "image", data: block.data, mimeType: block.mimeType });
			} else {
				// pie: mcp_adapter.rs:88-92 -- no first-class "resource" block on the agent side;
				// render as a JSON text snippet so the model still sees what the server
				// returned. `serde_json::to_string(resource).unwrap_or_else(|_| "(resource)")`.
				let serialized: string;
				try {
					serialized = JSON.stringify(block.resource) ?? "(resource)";
				} catch {
					serialized = "(resource)";
				}
				content.push({ type: "text", text: `<resource>${serialized}</resource>` });
			}
		}

		if (result.isError) {
			// pie: mcp_adapter.rs:96-107 -- error content is the constructed `content` array's
			// text blocks joined with "\n" (image blocks dropped; resource blocks already became
			// text above, so they're included here too).
			throw AgentToolError.message(
				content
					.filter((block): block is TextContent => block.type === "text")
					.map((block) => block.text)
					.join("\n"),
			);
		}

		return {
			content,
			details: { name: this.name, isError: false },
		};
	}
}
