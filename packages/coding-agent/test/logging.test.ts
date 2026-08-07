/**
 * Characterization tests for `packages/coding-agent/src/logging.ts`
 * (port of oracle `crates/coding-agent/src/logging.rs`, pie @0a120dfd).
 *
 * Oracle has no `#[cfg(test)]` module for `logging.rs`, so these assert the behaviours its doc
 * comment and code make contract: the log directory + filename (`logging.rs:28,33-34,88-92`), the
 * `short()` truncation (`logging.rs:82-86`), the tolerant IO-failure path (`logging.rs:29-32,
 * 44-50`), `init`'s idempotency (`logging.rs:25-26,71-74`), the `RUST_LOG`/`info` filter
 * (`logging.rs:54`) and the optional OTLP layer wiring (`logging.rs:62-70`).
 *
 * `tryLayer` is mocked throughout so this file tests the *wiring*; the env-var logic behind it is
 * covered by `otlp.test.ts`.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	emit,
	filterEnabled,
	init,
	type LoggingHandle,
	logsDir,
	parseEnvFilter,
	type SpanLayer,
	short,
	span,
} from "../src/logging.ts";

const tryLayerMock = vi.hoisted(() => vi.fn());
vi.mock("../src/otlp.ts", () => ({ tryLayer: tryLayerMock }));

const SESSION = "0198fe23-1111-4a22-8b33-123456789abc";
/** oracle logging.rs:84 — `session_id.len().min(16)`. */
const SESSION_SHORT = "0198fe23-1111-4a";

let base: string;
let handles: LoggingHandle[];
const savedEnv = { PIE_DIR: process.env.PIE_DIR, RUST_LOG: process.env.RUST_LOG };

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "pie-logging-"));
	process.env.PIE_DIR = base;
	delete process.env.RUST_LOG;
	handles = [];
	tryLayerMock.mockReset();
	tryLayerMock.mockReturnValue(undefined);
});

afterEach(async () => {
	for (const h of handles) await h.close();
	rmSync(base, { recursive: true, force: true });
	for (const [k, v] of Object.entries(savedEnv)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

function initTracked(sessionId = SESSION): LoggingHandle | undefined {
	const handle = init(sessionId);
	if (handle) handles.push(handle);
	return handle;
}

describe("short (oracle logging.rs:82-86)", () => {
	it("truncates to the first 16 bytes of a UUID session id", () => {
		expect(short(SESSION)).toBe(SESSION_SHORT);
		expect(short(SESSION)).toHaveLength(16);
	});

	it("passes shorter ids through unchanged", () => {
		expect(short("abc")).toBe("abc");
		expect(short("")).toBe("");
	});

	it("keeps exactly 16 when the id is exactly 16", () => {
		expect(short("0123456789abcdef")).toBe("0123456789abcdef");
	});

	it("measures bytes, not UTF-16 units (oracle slices a byte range)", () => {
		// 8 x 2-byte characters = 16 bytes exactly, so the whole string survives.
		expect(short("øøøøøøøø")).toBe("øøøøøøøø");
	});

	it("cuts on a character boundary when one falls exactly on byte 16", () => {
		// 9 x 2-byte characters = 18 bytes; byte 16 starts the 9th character, so the cut is clean.
		expect(short("øøøøøøøøø")).toBe("øøøøøøøø");
	});

	it("throws where oracle panics: the 16-byte cut lands mid-character", () => {
		// 6 x 3-byte characters = 18 bytes; the 6th occupies bytes 15-17, so byte 16 is a
		// continuation byte and Rust's `&session_id[..16]` panics.
		expect(() => short("。。。。。。")).toThrow(/byte index 16 is not a char boundary/);
	});
});

describe("logsDir (oracle logging.rs:88-92)", () => {
	it("is <base_dir>/logs and follows PIE_DIR", () => {
		expect(logsDir()).toBe(join(base, "logs"));
	});
});

describe("init (oracle logging.rs:27-80)", () => {
	it("creates the logs dir and returns the session log path", () => {
		const handle = initTracked();
		expect(handle).toBeDefined();
		expect(handle?.logPath).toBe(join(base, "logs", `${SESSION_SHORT}.log`));
	});

	it("is idempotent: a second init while one is installed returns undefined", () => {
		expect(initTracked()).toBeDefined();
		expect(init("another-session-id")).toBeUndefined();
	});

	it("appends to an existing log rather than truncating it (oracle uses .append(true))", async () => {
		const first = initTracked();
		emit("info", "pie::demo", "first");
		await first?.close();
		handles = [];

		const second = initTracked();
		emit("info", "pie::demo", "second");
		await second?.close();
		handles = [];

		const contents = readFileSync(join(base, "logs", `${SESSION_SHORT}.log`), "utf8");
		expect(contents).toContain("first");
		expect(contents).toContain("second");
	});

	it("returns undefined and reports to stderr when the logs dir cannot be created", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		const blocker = join(base, "blocker");
		writeFileSync(blocker, "not a directory");
		process.env.PIE_DIR = join(blocker, "nested");

		expect(initTracked()).toBeUndefined();
		expect(spy).toHaveBeenCalledTimes(1);
		// oracle logging.rs:30 — `"(logging disabled: cannot create {}: {e})"`.
		expect(spy.mock.calls[0]?.[0]).toMatch(/^\(logging disabled: cannot create .*blocker\/nested\/logs: /);
		spy.mockRestore();
	});

	it("returns undefined and reports to stderr when the log file cannot be opened", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		// Occupy the target path with a directory so `open(..., "a")` fails with EISDIR.
		mkdirSync(join(base, "logs", `${SESSION_SHORT}.log`), { recursive: true });

		expect(initTracked()).toBeUndefined();
		expect(spy).toHaveBeenCalledTimes(1);
		// oracle logging.rs:45-48 — `"(logging disabled: cannot open {}: {e})"`.
		expect(spy.mock.calls[0]?.[0]).toMatch(/^\(logging disabled: cannot open .*\.log: /);
		spy.mockRestore();
	});
});

describe("fmt layer output (oracle logging.rs:55-60)", () => {
	it("writes level, thread id, target and message, with no ANSI escapes", async () => {
		const handle = initTracked();
		emit("warn", "pie::demo", "hello", { count: 1 });
		await handle?.close();
		handles = [];

		const line = readFileSync(join(base, "logs", `${SESSION_SHORT}.log`), "utf8").trim();
		expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z /);
		// `.with_ansi(false)` (logging.rs:57): no escape sequences anywhere in the line.
		expect(line.includes("")).toBe(false);
		// Level right-aligned in 5 columns, as `tracing-subscriber` formats it.
		expect(line).toContain(" WARN ");
		// `.with_thread_ids(true)` (logging.rs:59) and `.with_target(true)` (logging.rs:58).
		expect(line).toMatch(/ThreadId\(\d{2}\) pie::demo: hello count=1$/);
	});

	it("drops events the filter rejects", async () => {
		process.env.RUST_LOG = "warn";
		const handle = initTracked();
		emit("info", "pie::demo", "suppressed");
		emit("error", "pie::demo", "kept");
		await handle?.close();
		handles = [];

		const contents = readFileSync(join(base, "logs", `${SESSION_SHORT}.log`), "utf8");
		expect(contents).not.toContain("suppressed");
		expect(contents).toContain("kept");
	});

	it("drops events entirely when no subscriber is installed", () => {
		expect(() => emit("error", "pie::demo", "nowhere")).not.toThrow();
	});
});

describe("OTLP layer wiring (oracle logging.rs:62-70)", () => {
	function fakeLayer(): SpanLayer & { opened: Array<[number, string]>; closed: number[] } {
		const opened: Array<[number, string]> = [];
		const closed: number[] = [];
		return {
			opened,
			closed,
			onNewSpan: (id, attrs) => {
				opened.push([id, attrs.name]);
			},
			onClose: (id) => {
				closed.push(id);
			},
		};
	}

	it("installs the layer returned by tryLayer and drives it from span lifecycle", () => {
		const layer = fakeLayer();
		tryLayerMock.mockReturnValue(layer);
		initTracked();

		const s = span("info", "pie::demo", "work", { attempt: 2 });
		expect(layer.opened).toEqual([[1, "work"]]);
		expect(layer.closed).toEqual([]);

		s.close();
		expect(layer.closed).toEqual([1]);
	});

	it("passes recorded fields to the layer untouched (stringification is the layer's job)", () => {
		const seen: Array<Record<string, unknown>> = [];
		tryLayerMock.mockReturnValue({
			onNewSpan: (_id: number, attrs: { fields: Record<string, unknown> }) => {
				seen.push(attrs.fields);
			},
			onClose: () => {},
		});
		initTracked();

		span("info", "pie::demo", "work", { n: 7, flag: true }).close();
		expect(seen).toEqual([{ n: 7, flag: true }]);
	});

	it("is a silent no-op when tryLayer returns undefined", () => {
		tryLayerMock.mockReturnValue(undefined);
		initTracked();
		expect(() => span("info", "pie::demo", "work").close()).not.toThrow();
	});

	it("does not notify the layer for spans the filter rejects", () => {
		process.env.RUST_LOG = "warn";
		const layer = fakeLayer();
		tryLayerMock.mockReturnValue(layer);
		initTracked();

		span("info", "pie::demo", "work").close();
		expect(layer.opened).toEqual([]);
	});

	it("closes a span at most once", () => {
		const layer = fakeLayer();
		tryLayerMock.mockReturnValue(layer);
		initTracked();

		const s = span("info", "pie::demo", "work");
		s.close();
		s.close();
		expect(layer.closed).toEqual([1]);
	});

	it("emits a `close` line for the span (oracle logging.rs:60, FmtSpan::CLOSE)", async () => {
		const handle = initTracked();
		span("info", "pie::demo", "work").close();
		await handle?.close();
		handles = [];

		const contents = readFileSync(join(base, "logs", `${SESSION_SHORT}.log`), "utf8");
		expect(contents).toContain("pie::demo: close span.name=work");
	});
});

describe("parseEnvFilter (oracle logging.rs:54)", () => {
	it("defaults to info when RUST_LOG is unset, blank or unparseable", () => {
		expect(parseEnvFilter(undefined)).toEqual({ global: "info", targets: [] });
		expect(parseEnvFilter("   ")).toEqual({ global: "info", targets: [] });
		expect(parseEnvFilter("not-a-level")).toEqual({ global: "info", targets: [] });
	});

	it("accepts a bare global level", () => {
		expect(parseEnvFilter("debug")).toEqual({ global: "debug", targets: [] });
		expect(parseEnvFilter("TRACE")).toEqual({ global: "trace", targets: [] });
	});

	it("accepts target=level directives alongside a global level", () => {
		expect(parseEnvFilter("warn,pie::otlp=trace")).toEqual({
			global: "warn",
			targets: [{ target: "pie::otlp", level: "trace" }],
		});
	});

	it("orders directives most-specific first", () => {
		const filter = parseEnvFilter("pie=warn,pie::otlp::export=trace,pie::otlp=debug");
		expect(filter.targets.map((t) => t.target)).toEqual(["pie::otlp::export", "pie::otlp", "pie"]);
	});

	it("leaves unmatched targets off when no bare level is given", () => {
		expect(parseEnvFilter("pie::otlp=debug").global).toBe("error");
	});

	it("skips span/field predicates rather than approximating them", () => {
		expect(parseEnvFilter("info,pie[work]=debug")).toEqual({ global: "info", targets: [] });
	});

	it("skips unrecognised individual directives but keeps the rest", () => {
		expect(parseEnvFilter("debug,pie=nonsense,pie::otlp=trace")).toEqual({
			global: "debug",
			targets: [{ target: "pie::otlp", level: "trace" }],
		});
	});
});

describe("filterEnabled", () => {
	const info = parseEnvFilter("info");

	it("enables levels at or above the filter's severity", () => {
		expect(filterEnabled(info, "pie", "error")).toBe(true);
		expect(filterEnabled(info, "pie", "warn")).toBe(true);
		expect(filterEnabled(info, "pie", "info")).toBe(true);
		expect(filterEnabled(info, "pie", "debug")).toBe(false);
		expect(filterEnabled(info, "pie", "trace")).toBe(false);
	});

	it("applies a target directive to the target and its module descendants", () => {
		const filter = parseEnvFilter("warn,pie::otlp=trace");
		expect(filterEnabled(filter, "pie::otlp", "trace")).toBe(true);
		expect(filterEnabled(filter, "pie::otlp::export", "trace")).toBe(true);
		expect(filterEnabled(filter, "pie::otlpx", "trace")).toBe(false);
		expect(filterEnabled(filter, "pie::lsp", "info")).toBe(false);
	});

	it("prefers the longest matching directive", () => {
		const filter = parseEnvFilter("pie=error,pie::otlp=trace");
		expect(filterEnabled(filter, "pie::otlp", "trace")).toBe(true);
		expect(filterEnabled(filter, "pie::lsp", "trace")).toBe(false);
	});
});
