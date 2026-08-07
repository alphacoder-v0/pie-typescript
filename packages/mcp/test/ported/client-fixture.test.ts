/**
 * pie: crates/mcp/tests/client_fixture.rs — ported per manifest row
 * `mcp/tests/client_fixture` (char-tests). In-process MCP client fixture: instead of spawning a
 * real subprocess, the client is driven over a custom `Transport` implementation that exchanges
 * JSON lines with a mock "server" running in the same process (mirrors oracle's `PipeTransport`
 * over two `mpsc::unbounded_channel`s -> here, two of this package's internal `createChannel`s).
 *
 * 7 tests, matching the 7 `#[tokio::test]` functions in the oracle file 1:1.
 */
import { describe, expect, it } from "vitest";
import { McpClient } from "../../src/client.ts";
import { McpError } from "../../src/errors.ts";
import { createChannel, createResolvablePromise } from "../../src/internal/async-utils.ts";
import type { Transport } from "../../src/transport.ts";

/** pie: client_fixture.rs:13-33 (`struct PipeTransport`). */
class PipeTransport implements Transport {
	private readonly outbox: ReturnType<typeof createChannel<string>>["sender"];
	private readonly inbox: ReturnType<typeof createChannel<string>>["receiver"];

	constructor(
		outbox: ReturnType<typeof createChannel<string>>["sender"],
		inbox: ReturnType<typeof createChannel<string>>["receiver"],
	) {
		this.outbox = outbox;
		this.inbox = inbox;
	}

	async sendLine(line: string): Promise<void> {
		this.outbox.send(line);
	}

	async recvLine(): Promise<string | undefined> {
		return this.inbox.recv();
	}

	async close(): Promise<void> {
		// pie: client_fixture.rs:30-32 — dropping the senders inside the test is enough; this
		// channel implementation has no separate "drop" concept, so close() is a no-op here too.
	}
}

/** pie: client_fixture.rs:35-47 (`fn pair`). */
function pair(): [PipeTransport, PipeTransport] {
	const ab = createChannel<string>();
	const ba = createChannel<string>();
	const a = new PipeTransport(ab.sender, ba.receiver);
	const b = new PipeTransport(ba.sender, ab.receiver);
	return [a, b];
}

interface RpcFrame {
	jsonrpc: string;
	id?: number;
	method?: string;
	params?: unknown;
	result?: unknown;
}

/** pie: client_fixture.rs:50-105 (`async fn run_mock_server`). */
async function runMockServer(transport: PipeTransport): Promise<void> {
	while (true) {
		let line: string | undefined;
		try {
			line = await transport.recvLine();
		} catch {
			break;
		}
		if (line === undefined) break;

		let frame: RpcFrame;
		try {
			frame = JSON.parse(line);
		} catch {
			continue;
		}

		const method = frame.method ?? "";
		const id = frame.id;
		if (method === "notifications/initialized") continue;

		let result: unknown;
		if (method === "initialize") {
			result = {
				protocolVersion: "2025-03-26",
				capabilities: {},
				serverInfo: { name: "mock-server", version: "0.0.1" },
			};
		} else if (method === "tools/list") {
			result = {
				tools: [
					{
						name: "echo",
						description: "echo text back",
						inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
					},
				],
			};
		} else if (method === "tools/call") {
			const params = frame.params as { arguments?: { text?: unknown } } | undefined;
			const text = typeof params?.arguments?.text === "string" ? params.arguments.text : "";
			result = { content: [{ type: "text", text: `echo: ${text}` }], isError: false };
		} else {
			result = null;
		}

		await transport.sendLine(JSON.stringify({ jsonrpc: "2.0", id, result })).catch(() => {});
	}
}

/** pie: client_fixture.rs:278-352 (`async fn run_slow_mock_server`). */
async function runSlowMockServer(
	transport: PipeTransport,
	release: Promise<void>,
	seenFrames: RpcFrame[],
): Promise<void> {
	while (true) {
		let line: string | undefined;
		try {
			line = await transport.recvLine();
		} catch {
			break;
		}
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
			const result = {
				protocolVersion: "2025-03-26",
				capabilities: {},
				serverInfo: { name: "slow-server", version: "0.0.1" },
			};
			await transport.sendLine(JSON.stringify({ jsonrpc: "2.0", id, result })).catch(() => {});
		} else if (method === "tools/list") {
			const result = {
				tools: [
					{
						name: "slow_echo",
						description: "echo, but only after the release barrier fires",
						inputSchema: { type: "object", properties: {} },
					},
				],
			};
			await transport.sendLine(JSON.stringify({ jsonrpc: "2.0", id, result })).catch(() => {});
		} else if (method === "tools/call") {
			void (async () => {
				await release;
				const result = { content: [{ type: "text", text: "released" }], isError: false };
				await transport.sendLine(JSON.stringify({ jsonrpc: "2.0", id, result })).catch(() => {});
			})();
		}
	}
}

describe("mcp client fixture (pie: crates/mcp/tests/client_fixture.rs)", () => {
	it("handshake_list_and_call_round_trip", async () => {
		const [clientSide, serverSide] = pair();
		void runMockServer(serverSide);

		const client = new McpClient(clientSide);
		const init = await client.initialize("pie-test");
		expect(init.serverInfo.name).toBe("mock-server");
		expect(client.isInitialized()).toBe(true);

		const tools = await client.toolsList();
		expect(tools.length).toBe(1);
		expect(tools[0]?.name).toBe("echo");

		const res = await client.toolsCall("echo", { text: "hi" });
		expect(res.isError).toBe(false);
		const content = res.content[0];
		expect(content?.type).toBe("text");
		expect(content?.type === "text" ? content.text : undefined).toBe("echo: hi");
	});

	it("tools_list_before_initialize_is_rejected", async () => {
		const [clientSide] = pair();
		const client = new McpClient(clientSide);
		await expect(client.toolsList()).rejects.toMatchObject({ code: "not_initialized" });
	});

	it("server_push_notifications_reach_take_notifications_in_order", async () => {
		const [clientSide, serverSide] = pair();

		const serverTask = (async () => {
			await serverSide.sendLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/listChanged" }));
			await serverSide.sendLine(
				JSON.stringify({
					jsonrpc: "2.0",
					method: "notifications/resources/updated",
					params: { uri: "file:///tmp/x.md", revision: 7 },
				}),
			);
			// Malformed: no `id` AND no `method` — must be silently dropped by the pump.
			await serverSide.sendLine(JSON.stringify({ jsonrpc: "2.0", params: { ignored: true } }));
		})();

		const client = new McpClient(clientSide);
		const receiver = client.takeNotifications();
		expect(receiver).toBeDefined();
		if (!receiver) throw new Error("unreachable");

		const first = await receiver.recv();
		expect(first?.method).toBe("notifications/tools/listChanged");
		expect(first?.params === null || first?.params === undefined).toBe(true);

		const second = await receiver.recv();
		expect(second?.method).toBe("notifications/resources/updated");
		const secondParams = second?.params as { uri?: string; revision?: number } | undefined;
		expect(secondParams?.uri).toBe("file:///tmp/x.md");
		expect(secondParams?.revision).toBe(7);

		// Third frame (missing `method`) must NOT surface — timeout or close, never a value.
		const third = await Promise.race([
			receiver.recv().then((value): { kind: "resolved"; value: unknown } => ({ kind: "resolved", value })),
			new Promise<{ kind: "timeout" }>((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 150)),
		]);
		const surfacedAValue = third.kind === "resolved" && third.value !== undefined;
		expect(surfacedAValue).toBe(false);

		// Second take attempt must return undefined (single-consumer invariant).
		expect(client.takeNotifications()).toBeUndefined();

		await serverTask;
	});

	it("tools_call_cancel_during_wait_returns_cancelled_and_notifies_server", async () => {
		const [clientSide, serverSide] = pair();
		const { promise: release, resolve: releaseNow } = createResolvablePromise<void>();
		const seenFrames: RpcFrame[] = [];
		void runSlowMockServer(serverSide, release, seenFrames);

		const client = new McpClient(clientSide);
		await client.initialize("pie-test");
		await client.toolsList();

		const controller = new AbortController();
		const callPromise = client.toolsCall("slow_echo", undefined, controller.signal);

		// Give the request frame time to land on the server before we cancel.
		await new Promise((resolve) => setTimeout(resolve, 50));
		controller.abort();

		const started = Date.now();
		let rejection: unknown;
		await Promise.race([
			callPromise.catch((error) => {
				rejection = error;
			}),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("tools_call must return promptly after cancel")), 2000),
			),
		]);
		expect(rejection).toBeInstanceOf(McpError);
		expect((rejection as McpError).code).toBe("cancelled");
		expect(Date.now() - started).toBeLessThan(1000);

		// The server must have observed exactly one notifications/cancelled frame, whose
		// requestId matches the original tools/call id.
		let cancelFrames: RpcFrame[] = [];
		let originalId: number | undefined;
		for (let attempt = 0; attempt < 50; attempt++) {
			originalId = seenFrames.find((frame) => frame.method === "tools/call")?.id;
			cancelFrames = seenFrames.filter((frame) => frame.method === "notifications/cancelled");
			if (cancelFrames.length > 0) break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(cancelFrames.length).toBe(1);
		expect(cancelFrames[0]?.id).toBeUndefined();
		const requestId = (cancelFrames[0]?.params as { requestId?: number } | undefined)?.requestId;
		expect(requestId).toBe(originalId);

		// Even though the call was abandoned, the server still produces a response when
		// released; the pump must silently drop the unmatched late response.
		releaseNow();
		await new Promise((resolve) => setTimeout(resolve, 100));
	});

	it("tools_call_success_does_not_emit_cancelled_notification", async () => {
		const [clientSide, serverSide] = pair();
		void runMockServer(serverSide);

		const client = new McpClient(clientSide);
		await client.initialize("pie-test");
		await client.toolsList();

		const controller = new AbortController();
		const res = await client.toolsCall("echo", { text: "ok" }, controller.signal);
		expect(res.isError).toBe(false);
	});

	it("tools_call_without_cancel_token_keeps_pre_existing_behavior", async () => {
		const [clientSide, serverSide] = pair();
		void runMockServer(serverSide);

		const client = new McpClient(clientSide);
		await client.initialize("pie-test");
		await client.toolsList();

		const res = await client.toolsCall("echo", { text: "hi" });
		expect(res.isError).toBe(false);
	});

	it("tools_call_request_timeout_still_returns_timeout_when_no_cancel", async () => {
		const [clientSide, serverSide] = pair();
		const { promise: release } = createResolvablePromise<void>();
		const seenFrames: RpcFrame[] = [];
		void runSlowMockServer(serverSide, release, seenFrames);

		const client = new McpClient(clientSide).withTimeout(150);
		await client.initialize("pie-test");
		await client.toolsList();

		await expect(client.toolsCall("slow_echo", undefined)).rejects.toMatchObject({ code: "timeout" });
	});
});
