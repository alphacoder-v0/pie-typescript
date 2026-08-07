/**
 * Regression coverage for two phase-6 fixer findings that live at the `McpClient` <-> `protocol.ts`
 * boundary, driven over an in-memory `Transport` double (same technique as
 * `test/ported/client-fixture.test.ts`'s `PipeTransport`/`RecordingTransport` and
 * `test/wire-shapes.test.ts`'s `RecordingTransport`):
 *  - finding #6 (client.rs:264-266 `serde_json::to_string(&req)?`): a `JSON.stringify` failure
 *    while serializing an outbound request must surface as `McpError` (`code: "protocol"`), not a
 *    raw `TypeError` — exercised via a circular-reference `tools/call` argument, the only
 *    caller-reachable way to make serialization fail in this API surface.
 *  - finding #7 (protocol.rs:51-52,87-88 `#[serde(default)]`): `McpTool.inputSchema` and
 *    `McpToolCallResult.isError` must default (to `null`/`false`) when the wire frame omits the
 *    key, applied at the real `McpClient.toolsList`/`toolsCall` parsing boundary — not just at the
 *    standalone `normalizeMcpTool`/`normalizeMcpToolCallResult` function level.
 *
 * Not a port of any single oracle test — implementer-added regression coverage per the fixer
 * task, in the same spirit as `wire-shapes.test.ts`'s RULEBOOK §4 self-declared "not a port"
 * fixtures.
 */
import { describe, expect, it } from "vitest";
import { McpClient } from "../src/client.ts";
import { McpError } from "../src/errors.ts";
import { createChannel } from "../src/internal/async-utils.ts";
import { normalizeMcpTool, normalizeMcpToolCallResult } from "../src/protocol.ts";
import type { Transport } from "../src/transport.ts";

/** Minimal in-memory `Transport` double, matching the pattern used by the other test files. */
class StubTransport implements Transport {
	readonly sentLines: string[] = [];
	private readonly channel = createChannel<string>();

	async sendLine(line: string): Promise<void> {
		this.sentLines.push(line);
	}

	async recvLine(): Promise<string | undefined> {
		return this.channel.receiver.recv();
	}

	async close(): Promise<void> {
		this.channel.sender.close();
	}

	/** Test helper: feed a canned line as if the server sent it. */
	feed(line: string): void {
		this.channel.sender.send(line);
	}
}

const CANNED_INIT_RESULT = {
	protocolVersion: "2025-03-26",
	capabilities: {},
	serverInfo: { name: "stub-server", version: "0.0.1" },
};

async function initializedClient(transport: StubTransport): Promise<McpClient> {
	const client = new McpClient(transport);
	const initPromise = client.initialize("pie-test");
	transport.feed(JSON.stringify({ jsonrpc: "2.0", id: 1, result: CANNED_INIT_RESULT }));
	await initPromise;
	return client;
}

describe("McpClient JSON.stringify failure handling (finding #6)", () => {
	it("toolsCall with a circular-reference argument rejects with McpError protocol code, not a raw TypeError", async () => {
		const transport = new StubTransport();
		const client = await initializedClient(transport);

		const circular: Record<string, unknown> = {};
		circular.self = circular;

		let caught: unknown;
		try {
			await client.toolsCall("whatever", circular);
			throw new Error("expected toolsCall to reject");
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(McpError);
		expect((caught as McpError).code).toBe("protocol");

		// No request line was sent for the failed call — only the two handshake frames from
		// initialize() (the "initialize" request + "notifications/initialized").
		expect(transport.sentLines.length).toBe(2);

		// The client remains healthy afterward: the request id was still consumed (oracle:
		// `next_id.fetch_add` runs before the fallible serialize), but no `inflight` entry leaked,
		// so a subsequent call resolves normally against the next id.
		const listPromise = client.toolsList();
		expect(transport.sentLines.length).toBe(3);
		const sentId = (JSON.parse(transport.sentLines[2] ?? "null") as { id?: number }).id;
		transport.feed(JSON.stringify({ jsonrpc: "2.0", id: sentId, result: { tools: [] } }));
		await expect(listPromise).resolves.toEqual([]);
	});
});

describe("McpClient response default-value normalization (finding #7)", () => {
	it("McpTool.inputSchema defaults to null (and description is omitted) when the wire frame omits both keys", async () => {
		const transport = new StubTransport();
		const client = await initializedClient(transport);

		const listPromise = client.toolsList();
		// Wire frame deliberately omits `inputSchema` and `description` entirely.
		transport.feed(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "bare" }] } }));

		const tools = await listPromise;
		expect(tools).toEqual([{ name: "bare", inputSchema: null }]);
		expect(client.getCatalog()).toEqual([{ name: "bare", inputSchema: null }]);
	});

	it("McpToolCallResult.isError defaults to false when the wire frame omits the key", async () => {
		const transport = new StubTransport();
		const client = await initializedClient(transport);

		const listPromise = client.toolsList();
		transport.feed(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } }));
		await listPromise;

		const callPromise = client.toolsCall("whatever", undefined);
		// Wire frame deliberately omits `isError`.
		transport.feed(JSON.stringify({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "ok" }] } }));

		const result = await callPromise;
		expect(result).toEqual({ content: [{ type: "text", text: "ok" }], isError: false });
	});
});

describe("protocol.ts normalizeMcpTool / normalizeMcpToolCallResult — direct unit checks (finding #7)", () => {
	it("normalizeMcpTool preserves inputSchema/description when the wire object provides them", () => {
		expect(normalizeMcpTool({ name: "echo", description: "d", inputSchema: { type: "object" } })).toEqual({
			name: "echo",
			description: "d",
			inputSchema: { type: "object" },
		});
	});

	it("normalizeMcpTool defaults inputSchema to null and omits description when absent", () => {
		expect(normalizeMcpTool({ name: "bare" })).toEqual({ name: "bare", inputSchema: null });
	});

	it("normalizeMcpToolCallResult preserves an explicit isError: true", () => {
		expect(normalizeMcpToolCallResult({ content: [], isError: true })).toEqual({ content: [], isError: true });
	});

	it("normalizeMcpToolCallResult defaults isError to false when absent", () => {
		expect(normalizeMcpToolCallResult({ content: [] })).toEqual({ content: [], isError: false });
	});
});
