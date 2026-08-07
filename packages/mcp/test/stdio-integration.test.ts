/**
 * Real child-process integration test for `StdioTransport`, required by RULEBOOK §4's wire
 * construct probe gate: "the stdio transport gets at least one integration test driven by a real
 * child process fixture, an echo server script run through node -e". The ported
 * `client-fixture.test.ts` only drives `McpClient` over an
 * in-memory `Transport` double (mirroring oracle's own `PipeTransport` fixture) and never
 * exercises `node:child_process.spawn`/stdin-stdout framing itself — this file closes that gap.
 *
 * Not a port of any single oracle test — implementer-added per the RULEBOOK §4 gate.
 */
import { describe, expect, it } from "vitest";
import { McpClient } from "../src/client.ts";
import { StdioTransport } from "../src/stdio.ts";

/**
 * Minimal MCP server, framed exactly like the fixtures in client_fixture.rs, run as a real
 * subprocess via `node -e`. Reads newline-delimited JSON-RPC requests from stdin, writes
 * newline-delimited JSON-RPC responses to stdout.
 */
const ECHO_SERVER_SCRIPT = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
	let msg;
	try {
		msg = JSON.parse(line);
	} catch {
		return;
	}
	const { id, method, params } = msg;
	if (method === "notifications/initialized") return;
	let result;
	if (method === "initialize") {
		result = { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "node-echo-server", version: "1.0.0" } };
	} else if (method === "tools/list") {
		result = { tools: [{ name: "echo", description: "echo text back", inputSchema: { type: "object" } }] };
	} else if (method === "tools/call") {
		const text = (params && params.arguments && params.arguments.text) || "";
		result = { content: [{ type: "text", text: "echo: " + text }], isError: false };
	} else {
		return;
	}
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
});
`;

describe("mcp stdio transport — real child process fixture", () => {
	it("drives a full handshake, tools/list, and tools/call over a real node child process", async () => {
		const transport = await StdioTransport.spawn(process.execPath, ["-e", ECHO_SERVER_SCRIPT]);
		const client = new McpClient(transport);
		try {
			const init = await client.initialize("pie-test");
			expect(init.serverInfo.name).toBe("node-echo-server");
			expect(client.isInitialized()).toBe(true);

			const tools = await client.toolsList();
			expect(tools.map((tool) => tool.name)).toEqual(["echo"]);

			const result = await client.toolsCall("echo", { text: "hello from stdio" });
			expect(result.isError).toBe(false);
			expect(result.content).toEqual([{ type: "text", text: "echo: hello from stdio" }]);
		} finally {
			await client.close();
		}
	});

	it("spawn failure (missing binary) rejects with a transport McpError", async () => {
		await expect(StdioTransport.spawn("pie-mcp-definitely-does-not-exist-binary", [])).rejects.toMatchObject({
			code: "transport",
		});
	});
});
