/**
 * phase 20-8: a malformed MCP response has to be rejected, not passed through to the model.
 *
 * pie: `protocol.rs:47-53`, where `McpTool.name` is a `String` with no `Option` and no `default`,
 * and `ToolContent` is `#[serde(tag = "type")]`; the `?` at `client.rs:282` turns any shape
 * violation into an `McpError`.
 *
 * This side used a bare `as` cast with no validation. An MCP server is **a third-party process
 * anyone can write**: let a tool with `name: undefined` into the catalog and the failure when it is
 * later called gets attributed somewhere else.
 * The cost of missing validation is not one less safety net; it is turning an attributable protocol
 * error into an unattributable behavioral one.
 *
 * The assertions use `code === "protocol"` rather than `toThrow(McpError)`: `McpError`'s constructor
 * is private and vitest's class matching needs a public one. Asserting the code is also stronger
 * than asserting the type — it pins **which kind** of protocol error.
 */
import { describe, expect, it } from "vitest";
import { normalizeMcpTool, normalizeMcpToolCallResult } from "../src/protocol.ts";

/** What is thrown has to be a protocol-class error, not some passing TypeError. */
function expectProtocolError(fn: () => unknown, messageMatch?: RegExp): void {
	try {
		fn();
	} catch (error) {
		expect((error as { code?: string }).code).toBe("protocol");
		if (messageMatch) expect((error as Error).message).toMatch(messageMatch);
		return;
	}
	throw new Error("expected a protocol error, but nothing was thrown");
}

describe("tool entries in tools/list", () => {
	it("a missing name raises a protocol error rather than yielding name: undefined", () => {
		expectProtocolError(() => normalizeMcpTool({ description: "d", inputSchema: {} }));
		expectProtocolError(() => normalizeMcpTool({ description: "d" }), /missing a string "name"/);
	});

	it("a name that is not a string, or is empty, is rejected too", () => {
		expectProtocolError(() => normalizeMcpTool({ name: 42 }));
		expectProtocolError(() => normalizeMcpTool({ name: "" }));
		expectProtocolError(() => normalizeMcpTool({ name: null }));
	});

	it("a description that is present but not a string is rejected", () => {
		expectProtocolError(() => normalizeMcpTool({ name: "t", description: 7 }), /non-string "description"/);
	});

	// Negative control: valid input still passes, and upstream's `#[serde(default)]` semantics — a
	// missing inputSchema becoming null — are unchanged.
	it("negative control: a valid entry still passes, and a missing inputSchema still defaults to null", () => {
		expect(normalizeMcpTool({ name: "t" })).toEqual({ name: "t", inputSchema: null });
		expect(normalizeMcpTool({ name: "t", description: "d", inputSchema: { type: "object" } })).toEqual({
			name: "t",
			description: "d",
			inputSchema: { type: "object" },
		});
	});
});

describe("the result of tools/call", () => {
	it("content that is not an array is rejected", () => {
		expectProtocolError(() => normalizeMcpToolCallResult({ content: "oops" }), /"content" must be an array/);
		expectProtocolError(() => normalizeMcpToolCallResult({}));
	});

	it("a content block with no type is rejected, and the message says which one", () => {
		expectProtocolError(() => normalizeMcpToolCallResult({ content: [{ text: "hi" }] }), /content\[0\]/);
		expectProtocolError(
			() => normalizeMcpToolCallResult({ content: [{ type: "text", text: "ok" }, { text: "bad" }] }),
			/content\[1\]/,
		);
	});

	it("a content block whose type is not a string is rejected", () => {
		expectProtocolError(() => normalizeMcpToolCallResult({ content: [{ type: 1 }] }));
		expectProtocolError(() => normalizeMcpToolCallResult({ content: [null] }));
	});

	// Negative control: a valid result still passes, and upstream's default for `isError` — a missing
	// key becoming false — is unchanged.
	it("negative control: a valid result still passes, and a missing isError still defaults to false", () => {
		expect(normalizeMcpToolCallResult({ content: [{ type: "text", text: "ok" }] })).toEqual({
			content: [{ type: "text", text: "ok" }],
			isError: false,
		});
		expect(normalizeMcpToolCallResult({ content: [], isError: true })).toEqual({ content: [], isError: true });
	});
});
