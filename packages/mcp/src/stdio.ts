/**
 * Stdio transport. Spawns a subprocess, talks JSON-RPC over its stdin/stdout, captures
 * stderr to a buffered log accessor for diagnostics.
 *
 * pie: crates/mcp/src/stdio.rs.
 *
 * RULEBOOK §2.3 maps `tokio::process`/`Command` to `node:child_process` spawn "through the skeleton's
 * utils/child-process.ts helper" — that helper lives at packages/coding-agent/src/utils/
 * child-process.ts, but `packages/mcp` is a leaf package `coding-agent` depends ON (manifest:
 * mcp is only ever *referenced by* coding-agent, never the reverse), so importing it here would
 * be a reverse dependency. This file calls `node:child_process.spawn` directly instead. Flagged
 * alongside the async-utils.ts leaf-package note — RULEBOOK §6 Deviation log 2026-08-03 (leaf-package exception).
 */
import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { createInterface } from "node:readline";
import { McpError } from "./errors.ts";
import {
	type AsyncChannelReceiver,
	type AsyncChannelSender,
	createChannel,
	errorMessage,
} from "./internal/async-utils.ts";
import type { Transport } from "./transport.ts";

/** pie: stdio.rs:22 (`stderr_tail: Arc<Mutex<Vec<String>>>`) — capped ring buffer, oldest-drop at 200. */
const STDERR_TAIL_MAX_LINES = 200;

type LineEntry = { ok: true; line: string } | { ok: false; error: McpError };

/** Builder for spawning an MCP server subprocess. */
export class StdioTransport implements Transport {
	private readonly stdin: NodeJS.WritableStream;
	private readonly receiver: AsyncChannelReceiver<LineEntry>;
	private child: ChildProcess | undefined;
	// pie: stdio.rs:21 (`#[allow(dead_code)]`) — written for future diagnostics, never read
	// within this crate today; ported faithfully (write-only), no public accessor exists in
	// oracle either.
	private readonly stderrTail: string[] = [];

	private constructor(child: ChildProcess, stdin: NodeJS.WritableStream, receiver: AsyncChannelReceiver<LineEntry>) {
		this.child = child;
		this.stdin = stdin;
		this.receiver = receiver;
	}

	/**
	 * Spawn `cmd` with `args` and connect stdio. Returns once the child is launched (the
	 * initialize handshake is the caller's responsibility).
	 */
	static async spawn(cmd: string, args: string[]): Promise<StdioTransport> {
		const child = nodeSpawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });

		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => {
				cleanup();
				reject(McpError.transport(`spawn ${cmd}: ${error.message}`));
			};
			const onSpawn = () => {
				cleanup();
				resolve();
			};
			const cleanup = () => {
				child.removeListener("error", onError);
				child.removeListener("spawn", onSpawn);
			};
			child.once("error", onError);
			child.once("spawn", onSpawn);
		});

		if (!child.stdin) throw McpError.transport("child has no stdin");
		if (!child.stdout) throw McpError.transport("child has no stdout");
		if (!child.stderr) throw McpError.transport("child has no stderr");

		const { sender, receiver } = createChannel<LineEntry>();
		// PERF(port): stdio.rs:50 uses a bounded `mpsc::channel(64)` for stdout backpressure;
		// this channel is unbounded (no consumer-side pacing). Not exercised by any of the
		// ported tests (small fixture frames only). Fast-version sketch: pause/resume
		// `child.stdout` once the internal buffer exceeds 64 pending lines.
		const transport = new StdioTransport(child, child.stdin, receiver);

		void transport.runStdoutReader(child.stdout, sender);
		void transport.runStderrDrain(child.stderr, transport.stderrTail);

		return transport;
	}

	private async runStdoutReader(stdout: NodeJS.ReadableStream, sender: AsyncChannelSender<LineEntry>): Promise<void> {
		const rl = createInterface({ input: stdout, crlfDelay: Number.POSITIVE_INFINITY });
		try {
			for await (const line of rl) {
				sender.send({ ok: true, line });
			}
			// pie: stdio.rs:61 (`Ok(None) => break`) — clean EOF, no further sends.
		} catch (error) {
			sender.send({ ok: false, error: McpError.transport(errorMessage(error)) });
		} finally {
			sender.close();
		}
	}

	private async runStderrDrain(stderr: NodeJS.ReadableStream, tail: string[]): Promise<void> {
		const rl = createInterface({ input: stderr, crlfDelay: Number.POSITIVE_INFINITY });
		try {
			for await (const line of rl) {
				if (tail.length >= STDERR_TAIL_MAX_LINES) tail.shift();
				tail.push(line);
			}
		} catch {
			// pie: stdio.rs:75 (`while let Ok(Some(line)) = ...`) — errors silently stop the drain.
		}
	}

	async sendLine(line: string): Promise<void> {
		const withNewline = line.endsWith("\n") ? line : `${line}\n`;
		await new Promise<void>((resolve, reject) => {
			this.stdin.write(withNewline, (error) => {
				if (error) reject(McpError.transport(error.message));
				else resolve();
			});
		});
	}

	async recvLine(): Promise<string | undefined> {
		const entry = await this.receiver.recv();
		if (entry === undefined) return undefined;
		if (!entry.ok) throw entry.error;
		return entry.line;
	}

	async close(): Promise<void> {
		// pie: stdio.rs:118-123 — best-effort SIGKILL; the subprocess also observes stdin close
		// when the transport is dropped, but Node has no Drop equivalent, so the explicit kill
		// carries the whole termination responsibility here.
		if (this.child) {
			const child = this.child;
			this.child = undefined;
			child.kill("SIGKILL");
		}
	}
}
