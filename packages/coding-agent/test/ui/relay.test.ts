/**
 * Tests for the port of oracle `crates/coding-agent/src/ui/relay.rs` (pie @0a120dfd).
 *
 * The first block is the oracle's own `#[cfg(test)] mod tests` (relay.rs:341-435), ported test for
 * test with the same names and the same assertions. The blocks after it cover surface the oracle's
 * tests reach through the Rust type system (serde decoding, the `qrcode` crate) or leave to
 * integration, which the TS port implements by hand and therefore has to lock down itself.
 *
 * No test touches the network: the relay task is driven through `RelayDeps.connect` with an
 * in-process socket double.
 */

import { AsyncQueue } from "@pie/agent-core";
import { describe, expect, it } from "vitest";
import {
	agentWsUrl,
	newToken,
	parseWorkerFrame,
	qrEncodeByteMode,
	qrFormatInfo,
	qrGeneratorPolynomial,
	qrLines,
	qrVersionInfo,
	type RelaySinks,
	type RelaySocket,
	snapshotFrame,
	start,
	viewerUrl,
} from "../../src/ui/relay.ts";
import type { WebSnapshot } from "../../src/ui/web.ts";

// ── oracle relay.rs:341-435 (`mod tests`) ─────────────────────────────────────────────────────

describe("relay (ported oracle tests)", () => {
	/** relay.rs:345-356. */
	it("tokens_are_long_random_and_url_safe", () => {
		const a = newToken();
		const b = newToken();
		expect(a).not.toBe(b); // tokens must be random
		expect(a.length).toBe(40);
		expect(/^[a-z0-9]+$/.test(a)).toBe(true); // token must be URL-safe
	});

	/** relay.rs:358-369. */
	it("ws_url_derives_scheme_and_path_from_base", () => {
		expect(agentWsUrl("https://pie.0xfefe.me", "tok123")).toBe("wss://pie.0xfefe.me/relay/agent?token=tok123");
		expect(agentWsUrl("http://127.0.0.1:8787/", "tok123")).toBe("ws://127.0.0.1:8787/relay/agent?token=tok123");
		expect(() => agentWsUrl("ftp://nope", "t")).toThrow();
	});

	/** relay.rs:371-383. */
	it("viewer_url_is_session_path_with_trailing_slash", () => {
		// The trailing slash matters: the shared HTML uses relative fetch paths, so
		// /session/<token> (no slash) would resolve them against /session/.
		expect(viewerUrl("https://pie.0xfefe.me", "tok123")).toBe("https://pie.0xfefe.me/session/tok123/");
		expect(viewerUrl("http://127.0.0.1:8787/", "tok123")).toBe("http://127.0.0.1:8787/session/tok123/");
	});

	/** relay.rs:385-406. */
	it("qr_lines_render_a_scannable_block_grid", () => {
		const lines = qrLines("https://pie.0xfefe.me/session/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/");
		expect(lines.length).toBeGreaterThan(10); // expected a QR-sized grid
		const width = [...lines[0]].length;
		expect(width).toBeGreaterThan(10);
		expect(lines.every((line) => [...line].length === width)).toBe(true); // all QR lines must be equal width
		const blocks = lines.reduce((sum, line) => sum + [...line].filter((c) => "█▀▄".includes(c)).length, 0);
		expect(blocks).toBeGreaterThan(50); // expected block characters
	});

	/** relay.rs:408-434. */
	it("frames_round_trip_as_tagged_json", () => {
		const hello = JSON.stringify({ type: "hello", agent_key: "k" });
		expect(hello).toContain('"type":"hello"');

		expect(parseWorkerFrame('{"type":"prompt","text":"hi"}')).toEqual({ type: "prompt", text: "hi" });
		expect(parseWorkerFrame('{"type":"viewers","count":3}')).toEqual({ type: "viewers", count: 3 });
		expect(parseWorkerFrame('{"type":"abort"}')).toEqual({ type: "abort" });
		expect(parseWorkerFrame('{"type":"control_plane_resolve","approve":true}')).toEqual({
			type: "control_plane_resolve",
			approve: true,
		});
		expect(parseWorkerFrame('{"type":"set_model","model":"anthropic:claude-haiku-4-5"}')).toEqual({
			type: "set_model",
			model: "anthropic:claude-haiku-4-5",
		});
	});
});

// ── port-specific: hand-written decoding that serde did for the oracle ────────────────────────

describe("parseWorkerFrame (relay.rs:298 `serde_json::from_str::<WorkerFrame>`)", () => {
	it("rejects malformed json, unknown tags and missing/mistyped fields", () => {
		expect(parseWorkerFrame("not json")).toBeUndefined();
		expect(parseWorkerFrame('"a string"')).toBeUndefined();
		expect(parseWorkerFrame("[1,2,3]")).toBeUndefined();
		expect(parseWorkerFrame('{"type":"nope"}')).toBeUndefined();
		expect(parseWorkerFrame("{}")).toBeUndefined();
		expect(parseWorkerFrame('{"type":"prompt"}')).toBeUndefined();
		expect(parseWorkerFrame('{"type":"prompt","text":42}')).toBeUndefined();
		expect(parseWorkerFrame('{"type":"control_plane_resolve","approve":"yes"}')).toBeUndefined();
		expect(parseWorkerFrame('{"type":"set_model","model":null}')).toBeUndefined();
	});

	it("rejects viewer counts outside u64 (fractional / negative), accepts extra fields", () => {
		expect(parseWorkerFrame('{"type":"viewers","count":-1}')).toBeUndefined();
		expect(parseWorkerFrame('{"type":"viewers","count":1.5}')).toBeUndefined();
		expect(parseWorkerFrame('{"type":"viewers","count":0}')).toEqual({ type: "viewers", count: 0 });
		// serde ignores unknown fields by default.
		expect(parseWorkerFrame('{"type":"abort","extra":true}')).toEqual({ type: "abort" });
	});
});

describe("snapshotFrame (relay.rs:334-339)", () => {
	it("wraps the snapshot in a tagged frame", () => {
		const frame = snapshotFrame({ session_id: "s1" } as unknown as WebSnapshot);
		expect(frame).toBe('{"type":"snapshot","data":{"session_id":"s1"}}');
	});

	it("drops frames above 1 MiB, measured in utf-8 bytes not utf-16 code units", () => {
		// 600k astral-plane characters: under the cap by `String.length` (UTF-16 code units), but
		// 2.4 MB on the wire. Rust's `String::len()` is the byte length, so oracle drops it.
		const huge = { session_id: "\u{1f600}".repeat(600_000) } as unknown as WebSnapshot;
		expect(JSON.stringify(huge).length).toBeLessThan(1024 * 1024 * 2);
		expect(snapshotFrame(huge)).toBeUndefined();
	});

	it("returns undefined instead of throwing when the snapshot is not serializable", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(snapshotFrame(cyclic as unknown as WebSnapshot)).toBeUndefined();
	});
});

// ── port-specific: the QR encoder that replaces the `qrcode` crate ────────────────────────────

describe("qr encoder (relay.rs:155-165, `qrcode` crate replacement)", () => {
	it("matches the published Reed-Solomon and BCH constants", () => {
		// ISO/IEC 18004 Annex A generator polynomial for 10 EC codewords.
		expect([...qrGeneratorPolynomial(10)]).toEqual([1, 216, 194, 159, 111, 199, 94, 95, 113, 157, 193]);
		// Table 25: level M + mask 0 is the bare XOR mask; level L + mask 0 is 0x77c4.
		expect(qrFormatInfo(0b00, 0)).toBe(0b101010000010010);
		expect(qrFormatInfo(0b01, 0)).toBe(0x77c4);
		// Table 26: version information for versions 7 and 10.
		expect(qrVersionInfo(7)).toBe(0x07c94);
		expect(qrVersionInfo(10)).toBe(0x0a4d3);
	});

	it("picks the smallest fitting version and lays out the mandatory function patterns", () => {
		const url = "https://pie.0xfefe.me/session/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/";
		expect(new TextEncoder().encode(url).length).toBe(71);
		const { size, modules } = qrEncodeByteMode(url);
		expect(size).toBe(37); // version 5 => 4*5+17

		// Finder patterns: dark ring, light ring, dark 3x3 core, at all three corners.
		for (const [r0, c0] of [
			[0, 0],
			[0, size - 7],
			[size - 7, 0],
		]) {
			for (let dr = 0; dr < 7; dr++) {
				for (let dc = 0; dc < 7; dc++) {
					const ring = dr === 0 || dr === 6 || dc === 0 || dc === 6;
					const core = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
					expect(modules[r0 + dr][c0 + dc]).toBe(ring || core ? 1 : 0);
				}
			}
		}
		// Timing patterns alternate along row/column 6.
		for (let i = 8; i < size - 8; i++) {
			expect(modules[6][i]).toBe(i % 2 === 0 ? 1 : 0);
			expect(modules[i][6]).toBe(i % 2 === 0 ? 1 : 0);
		}
		// The always-dark module below the top-left finder.
		expect(modules[size - 8][8]).toBe(1);
	});

	it("grows the symbol with the payload and refuses payloads past version 10", () => {
		// Level-M byte-mode capacities: v1 holds 14 bytes, v2 26, v6 106, v10 213.
		expect(qrEncodeByteMode("a".repeat(14)).size).toBe(21); // version 1
		expect(qrEncodeByteMode("a".repeat(15)).size).toBe(25); // version 2
		expect(qrEncodeByteMode("a".repeat(100)).size).toBe(41); // version 6
		expect(qrEncodeByteMode("a".repeat(213)).size).toBe(57); // version 10
		expect(() => qrEncodeByteMode("a".repeat(214))).toThrow(/qr encode: data too long/);
	});

	it("renders a quiet zone of solid ink around the inverted symbol", () => {
		const lines = qrLines("https://pie.0xfefe.me/session/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/");
		// 37 modules + 4 quiet-zone modules per side = 45 rows => 23 half-block lines of width 45.
		expect(lines.length).toBe(23);
		expect([...lines[0]].length).toBe(45);
		// The first two rows are entirely quiet zone (light), which inverts to solid ink.
		expect(lines[0]).toBe("█".repeat(45));
		// A dark module renders as a gap, so the symbol body is not solid.
		expect(lines.slice(2, 20).some((line) => /[ ▀▄]/.test(line))).toBe(true);
	});
});

// ── port-specific: the relay task loop (relay.rs:210-332) ─────────────────────────────────────

/** In-process `RelaySocket` double. No network, no `ws` dependency. */
class FakeSocket implements RelaySocket {
	readonly sent: string[] = [];
	closed = false;
	private readonly listeners = new Map<string, Array<{ listener: (event: any) => void; once: boolean }>>();

	send(data: string): void {
		if (this.closed) throw new Error("socket closed");
		this.sent.push(data);
	}

	close(): void {
		this.closed = true;
	}

	addEventListener(type: string, listener: (event: any) => void, options?: { once?: boolean }): void {
		const entries = this.listeners.get(type) ?? [];
		entries.push({ listener, once: options?.once === true });
		this.listeners.set(type, entries);
	}

	removeEventListener(type: string, listener: (event: any) => void): void {
		const entries = this.listeners.get(type);
		if (!entries) return;
		this.listeners.set(
			type,
			entries.filter((entry) => entry.listener !== listener),
		);
	}

	emit(type: string, event: unknown = {}): void {
		const entries = this.listeners.get(type) ?? [];
		this.listeners.set(
			type,
			entries.filter((entry) => !entry.once),
		);
		for (const entry of entries) entry.listener(event);
	}

	/** Frames the agent sent, decoded. */
	frames(): Array<Record<string, unknown>> {
		return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
	}
}

function makeSinks(): RelaySinks {
	return {
		prompt: new AsyncQueue<string>(),
		abort: new AsyncQueue<void>(),
		resolve: new AsyncQueue<boolean>(),
		model: new AsyncQueue<string>(),
	};
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** Starts a relay whose sockets open on the next microtask, unless `failConnect` is set. */
function startRelay(options: { failConnect?: boolean } = {}) {
	const sockets: FakeSocket[] = [];
	const sinks = makeSinks();
	const errors: unknown[] = [];
	const handle = start("http://127.0.0.1:8787", sinks, {
		connect: () => {
			const socket = new FakeSocket();
			sockets.push(socket);
			queueMicrotask(() => {
				if (options.failConnect === true) socket.emit("error", { type: "error" });
				else socket.emit("open");
			});
			return socket;
		},
		onError: (error) => errors.push(error),
	});
	return { handle, sockets, sinks, errors };
}

describe("relay task", () => {
	it("sends hello as the first frame and reports connected state", async () => {
		const { handle, sockets, errors } = startRelay();
		try {
			await waitFor(() => sockets.length === 1 && sockets[0].sent.length === 1, "hello frame");
			const hello = sockets[0].frames()[0];
			expect(hello.type).toBe("hello");
			expect(typeof hello.agent_key).toBe("string");
			expect((hello.agent_key as string).length).toBe(40);
			expect(handle.statusLine()).toBe(`relay connected — ${handle.url} (viewers: 0)`);
			expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:8787\/session\/[0-9a-f]{40}\/$/);
		} finally {
			handle.shutdown();
		}
		expect(errors).toEqual([]);
	});

	it("coalesces a burst of snapshots into one debounced frame carrying the newest state", async () => {
		const { handle, sockets } = startRelay();
		try {
			await waitFor(() => sockets.length === 1 && sockets[0].sent.length === 1, "hello frame");
			handle.pushSnapshot({ session_id: "a" } as unknown as WebSnapshot);
			handle.pushSnapshot({ session_id: "b" } as unknown as WebSnapshot);
			handle.pushSnapshot({ session_id: "c" } as unknown as WebSnapshot);
			await waitFor(() => sockets[0].sent.length === 2, "snapshot frame");
			// 250 ms of debounce with nothing else pushed: still exactly one snapshot frame.
			await new Promise((resolve) => setTimeout(resolve, 400));
			const frames = sockets[0].frames();
			expect(frames.length).toBe(2);
			expect(frames[1]).toEqual({ type: "snapshot", data: { session_id: "c" } });
		} finally {
			handle.shutdown();
		}
	});

	it("counts oversized snapshots instead of sending them (relay.rs:291)", async () => {
		const { handle, sockets } = startRelay();
		try {
			await waitFor(() => sockets[0]?.sent.length === 1, "hello frame");
			handle.pushSnapshot({ session_id: "x".repeat(1024 * 1024 + 10) } as unknown as WebSnapshot);
			await waitFor(() => handle.statusLine().includes("dropped"), "dropped counter");
			expect(handle.statusLine()).toBe(
				`relay connected — ${handle.url} (viewers: 0), 1 oversized snapshot(s) dropped`,
			);
			expect(sockets[0].frames().filter((frame) => frame.type === "snapshot")).toEqual([]);
		} finally {
			handle.shutdown();
		}
	});

	it("routes worker frames to their sinks and ignores unrecognized ones", async () => {
		const { handle, sockets, sinks } = startRelay();
		try {
			await waitFor(() => sockets[0]?.sent.length === 1, "hello frame");
			const socket = sockets[0];
			socket.emit("message", { data: '{"type":"nonsense"}' });
			socket.emit("message", { data: "not even json" });
			socket.emit("message", { data: JSON.stringify({ type: "prompt", text: "remote hi" }) });
			socket.emit("message", { data: JSON.stringify({ type: "abort" }) });
			socket.emit("message", { data: JSON.stringify({ type: "control_plane_resolve", approve: true }) });
			socket.emit("message", { data: JSON.stringify({ type: "set_model", model: "anthropic:x" }) });
			socket.emit("message", { data: JSON.stringify({ type: "viewers", count: 4 }) });
			// Binary/ping frames never reach the decoder (relay.rs:320).
			socket.emit("message", { data: new Uint8Array([1, 2, 3]) });

			await waitFor(() => handle.statusLine().includes("viewers: 4"), "viewer count");
			expect(await sinks.prompt.next()).toBe("remote hi");
			expect(sinks.abort.size).toBe(1);
			expect(await sinks.resolve.next()).toBe(true);
			expect(await sinks.model.next()).toBe("anthropic:x");
			expect(sinks.prompt.size).toBe(0);
		} finally {
			handle.shutdown();
		}
	});

	it("sends a shutdown frame, closes the socket and stops (relay.rs:263-270)", async () => {
		const { handle, sockets } = startRelay();
		await waitFor(() => sockets[0]?.sent.length === 1, "hello frame");
		handle.shutdown();
		await waitFor(() => handle.statusLine().includes("relay stopped"), "stopped state");
		expect(sockets[0].frames().at(-1)).toEqual({ type: "shutdown" });
		expect(sockets[0].closed).toBe(true);
		expect(sockets.length).toBe(1); // no reconnect after an explicit shutdown
	});

	it("reconnects after the worker closes the socket (relay.rs:319, 329)", async () => {
		const { handle, sockets } = startRelay();
		try {
			await waitFor(() => sockets[0]?.sent.length === 1, "first hello");
			sockets[0].emit("close");
			await waitFor(() => sockets.length === 2 && sockets[1].sent.length === 1, "second hello");
			expect(sockets[1].frames()[0].type).toBe("hello");
			// The agent key is pinned per process (TOFU on the worker side), so it must not change.
			expect(sockets[1].frames()[0].agent_key).toBe(sockets[0].frames()[0].agent_key);
		} finally {
			handle.shutdown();
		}
	});

	it("backs off after a failed handshake and stops when cancelled mid-backoff (relay.rs:233-242)", async () => {
		const { handle, sockets } = startRelay({ failConnect: true });
		await waitFor(() => handle.statusLine().includes("relay reconnecting"), "reconnecting state");
		expect(sockets.length).toBe(1); // still inside the 1s backoff, not hammering the worker
		handle.shutdown();
		await waitFor(() => handle.statusLine().includes("relay stopped"), "stopped state");
		expect(sockets.length).toBe(1);
	});
});
