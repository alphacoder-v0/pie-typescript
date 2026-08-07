/**
 * RULEBOOK §4 wire-construct probe gate: full-shape deep-equal assertions for every JSON-RPC
 * frame `McpClient` produces, and every response shape it parses back — not field projections.
 * Expected literals below are hand-derived from `crates/mcp/src/protocol.rs`'s serde field
 * names/`skip_serializing_if` attributes (read in full while porting this unit), exercising the
 * real `McpClient` production code against a recording `Transport` test double (not a
 * reimplementation of the shape in parallel).
 *
 * Not a port of any single oracle test — this is the implementer-added fixture the RULEBOOK
 * mandates for any unit that constructs wire frames.
 */
import { describe, expect, it } from "vitest";
import { McpClient } from "../src/client.ts";
import { createChannel } from "../src/internal/async-utils.ts";
import type { Transport } from "../src/transport.ts";

class RecordingTransport implements Transport {
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

	lastSent(): unknown {
		return JSON.parse(this.sentLines[this.sentLines.length - 1] ?? "null");
	}
}

const CANNED_INIT_RESULT = {
	protocolVersion: "2025-03-26",
	capabilities: {},
	serverInfo: { name: "wire-shape-server", version: "1.2.3" },
};

async function initializedClient(transport: RecordingTransport): Promise<McpClient> {
	const client = new McpClient(transport);
	const initPromise = client.initialize("pie-test");
	transport.feed(JSON.stringify({ jsonrpc: "2.0", id: 1, result: CANNED_INIT_RESULT }));
	await initPromise;
	return client;
}

describe("mcp wire-shape probe (RULEBOOK §4)", () => {
	it("initialize request frame matches the oracle wire shape exactly", async () => {
		const transport = new RecordingTransport();
		const client = new McpClient(transport);
		const initPromise = client.initialize("pie-test");

		// pie: protocol.rs's InitializeParams/RpcRequest field order + skip_serializing_if.
		expect(JSON.parse(transport.sentLines[0] ?? "null")).toEqual({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-03-26",
				capabilities: {},
				clientInfo: { name: "pie-test", version: "0.75.0" },
			},
		});

		transport.feed(JSON.stringify({ jsonrpc: "2.0", id: 1, result: CANNED_INIT_RESULT }));
		await initPromise;
	});

	it("notifications/initialized frame has no params key (skip_serializing_if omits it)", async () => {
		const transport = new RecordingTransport();
		await initializedClient(transport);

		expect(transport.sentLines.length).toBe(2);
		expect(JSON.parse(transport.sentLines[1] ?? "null")).toEqual({
			jsonrpc: "2.0",
			method: "notifications/initialized",
		});
	});

	it("tools/list request frame matches the oracle wire shape exactly (no params key)", async () => {
		const transport = new RecordingTransport();
		const client = await initializedClient(transport);

		const listPromise = client.toolsList();
		expect(transport.lastSent()).toEqual({ jsonrpc: "2.0", id: 2, method: "tools/list" });

		transport.feed(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } }));
		await listPromise;
	});

	it("tools/call request frame matches the oracle wire shape exactly (with arguments)", async () => {
		const transport = new RecordingTransport();
		const client = await initializedClient(transport);

		const listPromise = client.toolsList();
		transport.feed(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } }));
		await listPromise;

		const callPromise = client.toolsCall("multi", { a: 1, nested: { b: "x" } });
		expect(transport.lastSent()).toEqual({
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: { name: "multi", arguments: { a: 1, nested: { b: "x" } } },
		});

		transport.feed(JSON.stringify({ jsonrpc: "2.0", id: 3, result: { content: [], isError: false } }));
		await callPromise;
	});

	it("tools/call response shape round-trips every ToolContent variant exactly", async () => {
		const transport = new RecordingTransport();
		const client = await initializedClient(transport);

		const listPromise = client.toolsList();
		transport.feed(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } }));
		await listPromise;

		const callPromise = client.toolsCall("multi", undefined);
		const canned = {
			content: [
				{ type: "text", text: "hello" },
				{ type: "image", data: "base64==", mimeType: "image/png" },
				{ type: "resource", resource: { uri: "file:///x", text: "body" } },
			],
			isError: false,
		};
		transport.feed(JSON.stringify({ jsonrpc: "2.0", id: 3, result: canned }));

		const result = await callPromise;
		expect(result).toEqual(canned);
	});

	it("notifications/cancelled frame matches the oracle wire shape exactly", async () => {
		const transport = new RecordingTransport();
		const client = await initializedClient(transport);

		const listPromise = client.toolsList();
		transport.feed(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } }));
		await listPromise;

		const controller = new AbortController();
		const callPromise = client.toolsCall("slow", undefined, controller.signal);
		controller.abort();
		await expect(callPromise).rejects.toMatchObject({ code: "cancelled" });

		expect(transport.lastSent()).toEqual({
			jsonrpc: "2.0",
			method: "notifications/cancelled",
			params: { requestId: 3, reason: "client cancelled" },
		});
	});

	it("a JSON-RPC error response surfaces the exact rpc code + message (no data key when absent)", async () => {
		const transport = new RecordingTransport();
		const client = await initializedClient(transport);

		const listPromise = client.toolsList();
		transport.feed(JSON.stringify({ jsonrpc: "2.0", id: 2, error: { code: -32601, message: "Method not found" } }));

		await expect(listPromise).rejects.toMatchObject({
			code: "server_error",
			rpcCode: -32601,
			message: "server returned error -32601: Method not found",
		});
	});
});
