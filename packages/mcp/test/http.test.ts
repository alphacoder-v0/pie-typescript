/**
 * pie: crates/mcp/src/http.rs:468-497 (`#[cfg(test)] mod tests`) — the 2 inline unit tests
 * embedded in the oracle's http.rs source file (not under `tests/`, so no dedicated manifest
 * row; counted among the 12 ported Rust tests for this unit alongside the 7 in
 * client_fixture.rs and the 3 in http_fixture.rs).
 */
import { describe, expect, it } from "vitest";
import { debugHttpMcpAuth, type HttpMcpAuth, SseParser } from "../src/http.ts";

describe("http.ts inline unit tests (pie: crates/mcp/src/http.rs #[cfg(test)] mod tests)", () => {
	it("auth_debug_redacts_token", () => {
		const auth: HttpMcpAuth = { kind: "bearer", token: "hub_agent_secret" };
		const text = debugHttpMcpAuth(auth);
		expect(text).toContain("<redacted>");
		expect(text).not.toContain("hub_agent_secret");
	});

	it("sse_parser_ignores_heartbeat_and_extracts_data", () => {
		const parser = new SseParser(1024);
		const chunk = new TextEncoder().encode(
			': connected\n\nid: abc\nevent: message\ndata: {"jsonrpc":"2.0","method":"notifications/x"}\n\n',
		);
		const events = parser.push(chunk);
		expect(events.length).toBe(1);
		expect(events[0]?.id).toBe("abc");
		expect(events[0]?.data).toBe('{"jsonrpc":"2.0","method":"notifications/x"}');
	});
});
