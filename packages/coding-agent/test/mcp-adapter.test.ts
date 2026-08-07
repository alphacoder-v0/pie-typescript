import { AgentToolError } from "@pie/agent-core";
import type { McpTool, Transport } from "@pie/mcp";
import { McpClient } from "@pie/mcp";
import { describe, expect, it } from "vitest";
import { McpAgentTool } from "../src/tools/mcp-adapter.ts";

/**
 * pie: crates/coding-agent/src/tools/mcp_adapter.rs:116-270 (`#[cfg(test)] mod tests`) -- oracle
 * builds its own local `PipeTransport` over two `tokio::sync::mpsc::unbounded_channel`s rather
 * than reusing the `mcp` crate's shared test fixtures; mirrored here with a minimal in-process
 * queue (this package cannot import `@pie/mcp`'s internal test-only `createChannel` -- it isn't
 * part of the package's public `exports`).
 */
class SimpleQueue<T> {
	private buffer: T[] = [];
	private waiter?: (value: T | undefined) => void;
	private closed = false;

	push(value: T): void {
		if (this.closed) return;
		if (this.waiter) {
			const resolve = this.waiter;
			this.waiter = undefined;
			resolve(value);
			return;
		}
		this.buffer.push(value);
	}

	async pop(): Promise<T | undefined> {
		if (this.buffer.length > 0) return this.buffer.shift();
		if (this.closed) return undefined;
		return new Promise((resolve) => {
			this.waiter = resolve;
		});
	}

	close(): void {
		this.closed = true;
		if (this.waiter) {
			const resolve = this.waiter;
			this.waiter = undefined;
			resolve(undefined);
		}
	}
}

/** pie: mcp_adapter.rs:133-151 (`struct PipeTransport`). */
class PipeTransport implements Transport {
	// Constructor parameter-property shorthand is disallowed under `erasableSyntaxOnly` (it
	// emits runtime field-assignment code, not pure type syntax), so fields are declared here
	// and assigned explicitly in the constructor body below.
	private readonly outbox: SimpleQueue<string>;
	private readonly inbox: SimpleQueue<string>;

	constructor(outbox: SimpleQueue<string>, inbox: SimpleQueue<string>) {
		this.outbox = outbox;
		this.inbox = inbox;
	}

	async sendLine(line: string): Promise<void> {
		this.outbox.push(line);
	}

	async recvLine(): Promise<string | undefined> {
		return this.inbox.pop();
	}

	async close(): Promise<void> {}
}

/** pie: mcp_adapter.rs:153-166 (`fn pair`). */
function pair(): [PipeTransport, PipeTransport] {
	const ab = new SimpleQueue<string>();
	const ba = new SimpleQueue<string>();
	return [new PipeTransport(ab, ba), new PipeTransport(ba, ab)];
}

interface RpcFrame {
	jsonrpc: string;
	id?: number;
	method?: string;
	params?: unknown;
	result?: unknown;
}

/**
 * Generic mock server: replies to `initialize`/`tools/list` immediately, and dispatches
 * `tools/call` to a caller-supplied handler. Captures every inbound frame (used to assert the
 * `notifications/cancelled` frame reaches the server, mirroring oracle's cancel test).
 */
async function runMockServer(
	transport: PipeTransport,
	seenFrames: RpcFrame[],
	onToolsCall: (frame: RpcFrame, reply: (result: unknown) => void) => void,
): Promise<void> {
	while (true) {
		const line = await transport.recvLine();
		if (line === undefined) break;
		let frame: RpcFrame;
		try {
			frame = JSON.parse(line);
		} catch {
			continue;
		}
		seenFrames.push(frame);
		const method = frame.method ?? "";
		const id = frame.id;
		if (method === "notifications/initialized" || method === "notifications/cancelled") continue;

		if (method === "initialize") {
			await transport.sendLine(
				JSON.stringify({
					jsonrpc: "2.0",
					id,
					result: {
						protocolVersion: "2025-03-26",
						capabilities: {},
						serverInfo: { name: "mock", version: "0.0.1" },
					},
				}),
			);
		} else if (method === "tools/list") {
			await transport.sendLine(JSON.stringify({ jsonrpc: "2.0", id, result: { tools: [] } }));
		} else if (method === "tools/call") {
			onToolsCall(frame, (result) => {
				void transport.sendLine(JSON.stringify({ jsonrpc: "2.0", id, result }));
			});
		}
	}
}

async function connectedClient(
	seenFrames: RpcFrame[],
	onToolsCall: (frame: RpcFrame, reply: (result: unknown) => void) => void,
) {
	const [clientSide, serverSide] = pair();
	void runMockServer(serverSide, seenFrames, onToolsCall);
	const client = new McpClient(clientSide);
	await client.initialize("coding-agent-test");
	return client;
}

const echoTool: McpTool = {
	name: "echo",
	description: "echo text back",
	inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
};

describe("McpAgentTool", () => {
	it("should forward name/description/inputSchema verbatim and default execution mode to parallel", async () => {
		// pie: crates/coding-agent/src/tools/mcp_adapter.rs:25-51
		const [clientSide] = pair();
		const client = new McpClient(clientSide);
		const tool = new McpAgentTool(client, echoTool);
		expect(tool.name).toBe("echo");
		expect(tool.label).toBe("echo");
		expect(tool.description).toBe("echo text back");
		expect(tool.parameters).toBe(echoTool.inputSchema);
		expect(tool.executionMode).toBe("parallel");
	});

	it("should default description to empty string when the server omits it", () => {
		const [clientSide] = pair();
		const client = new McpClient(clientSide);
		const tool = new McpAgentTool(client, { name: "no-desc", inputSchema: {} });
		expect(tool.description).toBe("");
	});

	it("should map a successful text result to the agent's content shape with a plain details envelope", async () => {
		const seenFrames: RpcFrame[] = [];
		const client = await connectedClient(seenFrames, (frame, reply) => {
			const params = frame.params as { arguments?: { text?: string } };
			reply({ content: [{ type: "text", text: `echo: ${params.arguments?.text}` }], isError: false });
		});
		const tool = new McpAgentTool(client, echoTool);

		const result = await tool.execute("call-1", { text: "hi" }, undefined);
		expect(result.content).toEqual([{ type: "text", text: "echo: hi" }]);
		// pie: mcp_adapter.rs:108-111
		expect(result.details).toEqual({ name: "echo", isError: false });
	});

	it("should map an image content block through unchanged", async () => {
		const seenFrames: RpcFrame[] = [];
		const client = await connectedClient(seenFrames, (_frame, reply) => {
			reply({ content: [{ type: "image", data: "base64data", mimeType: "image/png" }], isError: false });
		});
		const tool = new McpAgentTool(client, { name: "image-tool", inputSchema: {} });

		const result = await tool.execute("call-2", {}, undefined);
		expect(result.content).toEqual([{ type: "image", data: "base64data", mimeType: "image/png" }]);
	});

	it("should render a resource content block as a <resource>...</resource> text block", async () => {
		// pie: crates/coding-agent/src/tools/mcp_adapter.rs:88-92
		const seenFrames: RpcFrame[] = [];
		const client = await connectedClient(seenFrames, (_frame, reply) => {
			reply({ content: [{ type: "resource", resource: { uri: "file:///x.md", text: "hello" } }], isError: false });
		});
		const tool = new McpAgentTool(client, { name: "resource-tool", inputSchema: {} });

		const result = await tool.execute("call-3", {}, undefined);
		expect(result.content).toHaveLength(1);
		const block = result.content[0] as { type: string; text: string };
		expect(block.type).toBe("text");
		expect(block.text).toBe(`<resource>${JSON.stringify({ uri: "file:///x.md", text: "hello" })}</resource>`);
	});

	it("should throw AgentToolError joining text content when the server reports isError:true", async () => {
		// pie: crates/coding-agent/src/tools/mcp_adapter.rs:96-107
		const seenFrames: RpcFrame[] = [];
		const client = await connectedClient(seenFrames, (_frame, reply) => {
			reply({
				content: [
					{ type: "text", text: "first line of the failure" },
					{ type: "text", text: "second line" },
				],
				isError: true,
			});
		});
		const tool = new McpAgentTool(client, echoTool);

		await expect(tool.execute("call-4", { text: "boom" }, undefined)).rejects.toMatchObject({
			message: "first line of the failure\nsecond line",
		});
	});

	it("should drop image blocks from the joined isError text (only text blocks are joined)", async () => {
		const seenFrames: RpcFrame[] = [];
		const client = await connectedClient(seenFrames, (_frame, reply) => {
			reply({
				content: [
					{ type: "text", text: "textual error" },
					{ type: "image", data: "x", mimeType: "image/png" },
				],
				isError: true,
			});
		});
		const tool = new McpAgentTool(client, echoTool);

		let caught: unknown;
		try {
			await tool.execute("call-5", { text: "boom" }, undefined);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(AgentToolError);
		expect((caught as Error).message).toBe("textual error");
	});

	it("should map a non-cancel client error to 'mcp call: ...'", async () => {
		// pie: crates/coding-agent/src/tools/mcp_adapter.rs:75
		const [clientSide] = pair();
		const client = new McpClient(clientSide);
		// Never initialized -> McpClient.toolsCall throws McpError.notInitialized() synchronously.
		const tool = new McpAgentTool(client, echoTool);
		await expect(tool.execute("call-6", { text: "x" }, undefined)).rejects.toMatchObject({
			message: expect.stringMatching(/^mcp call: /),
		});
	});

	it("should propagate an aborted signal into the MCP call and surface 'cancelled', notifying the server", async () => {
		// pie: crates/coding-agent/src/tools/mcp_adapter.rs:118-269
		// (execute_propagates_cancel_token_to_mcp_client) -- the server here intentionally never
		// replies to tools/call, so cancellation is the only way `execute` returns.
		const seenFrames: RpcFrame[] = [];
		const client = await connectedClient(seenFrames, () => {
			/* never reply */
		});
		const tool = new McpAgentTool(client, { name: "slow_tool", description: "never replies", inputSchema: {} });

		const controller = new AbortController();
		const execPromise = tool.execute("call-7", {}, controller.signal);

		await new Promise((resolve) => setTimeout(resolve, 50));
		const started = Date.now();
		controller.abort();

		let caught: unknown;
		try {
			await execPromise;
		} catch (error) {
			caught = error;
		}
		expect(Date.now() - started).toBeLessThan(1000);
		expect(caught).toBeInstanceOf(AgentToolError);
		expect((caught as Error).message).toBe("cancelled");

		// The server must have observed a notifications/cancelled frame for the original request.
		let cancelFrames: RpcFrame[] = [];
		for (let attempt = 0; attempt < 50; attempt++) {
			cancelFrames = seenFrames.filter((f) => f.method === "notifications/cancelled");
			if (cancelFrames.length > 0) break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(cancelFrames.length).toBe(1);
	});
});
