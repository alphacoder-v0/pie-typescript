/**
 * MCP protocol types — a hand-picked subset of the 2025-03-26 spec, just enough for the
 * initialize handshake and tools list/call. Everything serializes to camelCase JSON-RPC.
 *
 * pie: crates/mcp/src/protocol.rs. Field names below are wire names (RULEBOOK §2.1:
 * `#[serde(rename_all)]`/`rename` -> TS field name = wire name). Optional fields that Rust
 * marks `skip_serializing_if = "Option::is_none"` are typed `?:` here; omitting the key (via
 * `undefined`, never `null`) reproduces that on `JSON.stringify` for free.
 *
 * **Inbound frames are validated at the parsing boundary.**
 *
 * This previously read "no runtime validation, consistent with the providers" — but that
 * comparison does not hold. Provider responses come from a handful of vendors under a
 * contract; a tool server is **a third-party process anyone can write**. Upstream rejects
 * malformed frames right here, through its deserialiser (`protocol.rs:47-53` makes `name` a
 * required `String`, and `ToolContent` is `#[serde(tag="type")]`), and the `?` at
 * `client.rs:282` turns the rejection into a protocol error.
 *
 * Validation is applied only where that deserialiser would fail, which is the two
 * normalisation functions below. Every other field keeps the permissive handling inherited
 * from the skeleton; this change covers only what upstream explicitly rejects.
 */

import { McpError } from "./errors.ts";

export const PROTOCOL_VERSION = "2025-03-26";

export interface InitializeParams {
	protocolVersion: string;
	capabilities: ClientCapabilitiesSpec;
	clientInfo: ClientInfo;
}

export interface ClientCapabilitiesSpec {
	roots?: unknown;
	sampling?: unknown;
}

export interface ClientInfo {
	name: string;
	version: string;
}

export interface InitializeResult {
	protocolVersion: string;
	capabilities: unknown;
	serverInfo: ServerInfo;
}

export interface ServerInfo {
	name: string;
	version: string;
}

export interface McpTool {
	name: string;
	description?: string;
	inputSchema: unknown;
}

/**
 * pie: protocol.rs:51-52 (`#[serde(rename = "inputSchema", default)] pub input_schema:
 * serde_json::Value`) — serde's `default` on a `serde_json::Value` field fills in `Value::Null`
 * when the wire object omits the key entirely; it is not a parse error. This module applies no
 * runtime schema validation to inbound frames (see the file-level TODO(port) above), so nothing
 * would otherwise apply that default — `McpClient` (client.ts) calls this at the response-parsing
 * boundary (`toolsList`) so the field's static type (`unknown`, always present) matches what
 * actually lands in memory at runtime.
 */
export function normalizeMcpTool(raw: Record<string, unknown>): McpTool {
	// pie: `protocol.rs:47-53` — upstream declares the tool name as a required string with no
	// `Option` and no default, so deserialisation fails outright when the field is missing or the
	// wrong type, and the `?` at `client.rs:282` surfaces that failure as a protocol error.
	//
	// This side previously cast the raw value across unchecked: whatever a non-conforming
	// server sent is what the model received. A tool with an undefined name entered the catalog,
	// and the failure when calling it later was attributed somewhere else entirely.
	//
	// The cost of skipping validation is not one less safety net. It is **turning an
	// attributable protocol error into an unattributable behavioral anomaly.**
	if (typeof raw.name !== "string" || raw.name.length === 0) {
		throw McpError.protocol(`tool entry missing a string "name" (got ${JSON.stringify(raw.name)})`);
	}
	if (raw.description !== undefined && typeof raw.description !== "string") {
		throw McpError.protocol(`tool "${raw.name}" has a non-string "description"`);
	}
	return {
		name: raw.name,
		...(raw.description !== undefined ? { description: raw.description } : {}),
		inputSchema: "inputSchema" in raw ? raw.inputSchema : null,
	};
}

export interface ToolsListResult {
	tools: McpTool[];
	nextCursor?: string;
}

export interface ToolsCallParams {
	name: string;
	arguments?: unknown;
}

/**
 * `params` for the MCP `notifications/cancelled` frame (spec 2025-03-26
 * §basic/utilities/cancellation). Sent by the client when a previously issued request id is no
 * longer needed; the server SHOULD stop work for that id. `requestId` matches the original
 * JSON-RPC request id.
 */
export interface CancelledNotificationParams {
	requestId: number;
	reason?: string;
}

export interface McpToolCallResult {
	content: ToolContent[];
	isError: boolean;
}

/**
 * pie: protocol.rs:87-88 (`#[serde(rename = "isError", default)] pub is_error: bool`) — a missing
 * `isError` key deserializes to `false`, not a parse error; `content` has no such attribute and
 * stays whatever the raw frame provided (oracle would fail to deserialize a response missing
 * `content` outright — untouched here, out of scope for this default). Applied at the
 * response-parsing boundary in `McpClient` (client.ts `toolsCall`), matching the site where serde
 * would apply it during deserialize.
 */
export function normalizeMcpToolCallResult(raw: Record<string, unknown>): McpToolCallResult {
	// Upstream models tool content as a tagged union, so a missing or unrecognised type makes
	// deserialisation fail outright. This side previously cast the raw content straight across,
	// which meant a malformed tool result reached the model verbatim: the model saw garbage
	// rather than an error.
	if (!Array.isArray(raw.content)) {
		throw McpError.protocol(`tool call result "content" must be an array (got ${typeof raw.content})`);
	}
	for (const [i, block] of raw.content.entries()) {
		if (typeof block !== "object" || block === null || typeof (block as { type?: unknown }).type !== "string") {
			throw McpError.protocol(`tool call result content[${i}] is missing a string "type"`);
		}
	}
	return {
		content: raw.content as ToolContent[],
		isError: typeof raw.isError === "boolean" ? raw.isError : false,
	};
}

/** pie: protocol.rs:91-104 (`#[serde(tag = "type")] enum ToolContent`). */
export type ToolContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string }
	| { type: "resource"; resource: unknown };

/** JSON-RPC 2.0 envelope. Generic over the params/result payloads. */
export interface RpcRequest<P> {
	jsonrpc: "2.0";
	id: number;
	method: string;
	params?: P;
}

export interface RpcResponse<R> {
	jsonrpc?: string;
	id?: number;
	result?: R;
	error?: RpcError;
}

export interface RpcError {
	code: number;
	message: string;
	data?: unknown;
}

export interface RpcNotification<P> {
	jsonrpc: "2.0";
	method: string;
	params?: P;
}

export function makeRequest<P>(id: number, method: string, params: P | undefined): RpcRequest<P> {
	return { jsonrpc: "2.0", id, method, params };
}

export function makeNotification<P>(method: string, params: P | undefined): RpcNotification<P> {
	return { jsonrpc: "2.0", method, params };
}
