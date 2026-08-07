import { describe, expect, it } from "vitest";
import { makeNotification, makeRequest } from "../../src/protocol.ts";

/**
 * phase 22 batch D wrap-up — the `new-test` verdicts on the mcp side.
 *
 * Constructing the JSON-RPC envelope. These two functions decide what every outgoing message looks
 * like: a missing or wrong `jsonrpc` field and the peer refuses it outright, while the only
 * difference between a request and a notification is **whether there is an `id`**. Swap them and the
 * peer waits for a response that never comes, or replies to a notification as though it were a
 * request.
 */
describe("phase 22 batch D wrap-up — the mcp JSON-RPC envelope", () => {
	// ── mcp/src/protocol.rs::make_request@144 ─────────────────────────────────
	describe("makeRequest", () => {
		it("carries jsonrpc 2.0, the id, the method and the params", () => {
			expect(makeRequest(7, "tools/call", { name: "echo" })).toEqual({
				jsonrpc: "2.0",
				id: 7,
				method: "tools/call",
				params: { name: "echo" },
			});
		});

		it("keeps the id — that is what makes it a request rather than a notification", () => {
			// Lose the id and the peer treats it as a notification, never responds, and the caller hangs.
			expect(makeRequest(1, "initialize", undefined).id).toBe(1);
		});
	});

	// ── mcp/src/protocol.rs::make_notification@157 ────────────────────────────
	describe("makeNotification", () => {
		it("carries jsonrpc 2.0, the method and the params", () => {
			const notification = makeNotification("notifications/initialized", undefined);

			expect(notification).toEqual({ jsonrpc: "2.0", method: "notifications/initialized", params: undefined });
		});

		it("has no id field at all — an id would turn it into a request the peer must answer", () => {
			expect("id" in makeNotification("notifications/cancelled", { requestId: 3 })).toBe(false);
		});
	});
});
