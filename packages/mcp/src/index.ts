/**
 * pie-mcp — minimal MCP (Model Context Protocol) stdio client.
 *
 * pie: crates/mcp/src/lib.rs.
 *
 * Scope: subprocess-based stdio transport plus Streamable HTTP transport, JSON-RPC 2.0 framing
 * over the shared `Transport` line abstraction, initialize handshake, tools/list, tools/call,
 * and server-pushed notifications. Out of scope for v1: sampling, resource subscriptions, and
 * server-side mode.
 *
 * The package intentionally does not depend on `@pie/agent-core` so it can be reused from
 * places that don't carry the harness — `@pie/coding-agent` provides the adapter that wraps
 * MCP tools as agent tools (phase 12).
 */

export type { ClientCapabilities, McpServerNotification, NotificationReceiver } from "./client.ts";
export { McpClient } from "./client.ts";
export type { McpErrorCode } from "./errors.ts";
export { McpError } from "./errors.ts";
export type { HttpMcpAuth, HttpMcpTransportOptions, ReconnectPolicy } from "./http.ts";
export { createHttpMcpTransportOptions, debugHttpMcpAuth, HttpMcpTransport, withBearerAuth } from "./http.ts";
export type {
	CancelledNotificationParams,
	ClientCapabilitiesSpec,
	ClientInfo,
	InitializeParams,
	InitializeResult,
	McpTool,
	McpToolCallResult,
	RpcError,
	RpcNotification,
	RpcRequest,
	RpcResponse,
	ServerInfo,
	ToolContent,
	ToolsCallParams,
	ToolsListResult,
} from "./protocol.ts";
export { makeNotification, makeRequest, PROTOCOL_VERSION } from "./protocol.ts";
export { StdioTransport } from "./stdio.ts";
export type { Transport } from "./transport.ts";
