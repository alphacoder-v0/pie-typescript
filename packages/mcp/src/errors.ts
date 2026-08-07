/**
 * Error type for the MCP client.
 *
 * pie: crates/mcp/src/errors.rs — a `thiserror` enum with 7 variants. Ported per
 * RULEBOOK §2.4 (thiserror variant -> Error subclass + `code` field) using the single-class
 * pattern already established in packages/agent/src/harness/types.ts (FileError, SessionError,
 * etc.): one `McpError` class, discriminated by a `code` string-literal union, with variant
 * payload fields (`rpcCode`, `seconds`) attached optionally.
 */

/** Discriminant mirroring the `McpError` enum variant names (errors.rs:6-20). */
export type McpErrorCode =
	| "transport"
	| "protocol"
	| "server_error"
	| "timeout"
	| "not_initialized"
	| "cancelled"
	| "other";

export class McpError extends Error {
	/** Stable, backend-independent error code (mirrors the Rust enum variant). */
	public readonly code: McpErrorCode;
	/** JSON-RPC error code — set only when `code === "server_error"` (errors.rs:11-12). */
	public readonly rpcCode?: number;
	/** Requested timeout, in seconds — set only when `code === "timeout"` (errors.rs:13-14). */
	public readonly seconds?: number;

	private constructor(
		code: McpErrorCode,
		message: string,
		extra?: { rpcCode?: number; seconds?: number; cause?: unknown },
	) {
		super(message, extra?.cause === undefined ? undefined : { cause: extra.cause });
		this.name = "McpError";
		this.code = code;
		this.rpcCode = extra?.rpcCode;
		this.seconds = extra?.seconds;
	}

	/** pie: errors.rs:7-8 (`Transport(String)`) -> `"transport error: {0}"`. */
	static transport(detail: string, cause?: unknown): McpError {
		return new McpError("transport", `transport error: ${detail}`, { cause });
	}

	/** pie: errors.rs:9-10 (`Protocol(String)`) -> `"protocol error: {0}"`. */
	static protocol(detail: string, cause?: unknown): McpError {
		return new McpError("protocol", `protocol error: ${detail}`, { cause });
	}

	/** pie: errors.rs:11-12 (`ServerError { code, message }`) -> `"server returned error {code}: {message}"`. */
	static serverError(rpcCode: number, message: string): McpError {
		return new McpError("server_error", `server returned error ${rpcCode}: ${message}`, { rpcCode });
	}

	/** pie: errors.rs:13-14 (`Timeout { seconds }`) -> `"request timed out after {seconds}s"`. */
	static timeout(seconds: number): McpError {
		return new McpError("timeout", `request timed out after ${seconds}s`, { seconds });
	}

	/** pie: errors.rs:15-16 (`NotInitialized`) — fixed message, verbatim. */
	static notInitialized(): McpError {
		return new McpError("not_initialized", "client is not initialized; call `initialize` before issuing requests");
	}

	/** pie: errors.rs:17-18 (`Cancelled`) — fixed message, verbatim. */
	static cancelled(): McpError {
		return new McpError("cancelled", "request cancelled before the server responded");
	}

	/** pie: errors.rs:19-20 (`Other(String)`) -> `"{0}"` (message used verbatim, no prefix). */
	static other(message: string, cause?: unknown): McpError {
		return new McpError("other", message, { cause });
	}

	/** pie: errors.rs:23-27 (`impl From<std::io::Error> for McpError`). */
	static fromIoError(error: unknown): McpError {
		return McpError.transport(errorMessage(error), error);
	}

	/** pie: errors.rs:29-33 (`impl From<serde_json::Error> for McpError`) -> `"json: {e}"`. */
	static fromJsonError(error: unknown): McpError {
		return McpError.protocol(`json: ${errorMessage(error)}`, error);
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
