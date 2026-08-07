/**
 * Tracing subscriber bootstrap for the CLI.
 *
 * Port of oracle `crates/coding-agent/src/logging.rs` (pie @0a120dfd).
 *
 * Writes structured logs to `~/.pie/logs/<session-id>.log`. Default filter is `info` with
 * `RUST_LOG` override. The returned {@link LoggingHandle} MUST be kept alive for the lifetime of
 * the process — closing it stops the background writer and queued events get lost (oracle:
 * dropping the `WorkerGuard`).
 *
 * {@link init} is intentionally tolerant: any IO failure here logs to stderr and returns
 * `undefined` rather than blowing up the CLI. Logging is observability, not load-bearing.
 *
 * ## What this port had to supply itself
 *
 * Oracle delegates almost everything to two crates that have no counterpart in this repo, and
 * RULEBOOK §1's dependency allowlist has no row for either (its "logging" row says *"follow whatever logger
 * each skeleton package already has; no new console.\* on product paths"* — and a repo-wide grep finds **no** logger module in any
 * package: every prior port that hit a `tracing::warn!` recorded "this port has no logger
 * reachable here", e.g. `hooks.ts:422`, `skills-state.ts:123`, `goal.ts:339`,
 * `tools/remove-skill.ts:218`). So the three pieces `logging.rs` composes are implemented
 * in-file rather than pulled in as new dependencies:
 *
 * - `tracing_appender::non_blocking` → a `node:fs` append stream (buffered, off the hot path;
 *   {@link LoggingHandle.close} flushes it — the analogue of the `WorkerGuard`'s `Drop`).
 * - `tracing_subscriber::EnvFilter` → {@link parseEnvFilter} (the `RUST_LOG` directive subset
 *   documented there).
 * - `tracing_subscriber::registry()` + the `fmt` layer → {@link emit} / {@link span} plus the
 *   module-level installed-subscriber slot that gives `init` its idempotency.
 *
 * The `tracing::{info,warn,...}` macro surface itself lives in the `tracing` crate, not in
 * `logging.rs`; {@link emit} and {@link span} are the minimum of it this subscriber has to
 * consume in order to be a subscriber at all, and are the sink those "no logger reachable"
 * sites can be repointed at in a later phase.
 *
 * TODO(port): the on-disk line format is a documented approximation of
 * `tracing_subscriber::fmt`'s `Full` formatter, not a byte-exact reproduction — the oracle
 * cannot be run here to diff against (cargo is denied in this repo per CLAUDE.md standing rule
 * 5), and the log file is neither a wire format nor a parity scenario. What *is* contract in
 * this port, and is tested: the log directory + filename, the tolerance behaviour on IO failure,
 * `init`'s idempotency, the `RUST_LOG`/`info` filter semantics, and the OTLP layer wiring.
 */

import { closeSync, createWriteStream, mkdirSync, openSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { threadId } from "node:worker_threads";
import { getAgentDir } from "./config.ts";
import { tryLayer } from "./otlp.ts";

/**
 * `tracing::Level`. Ordered most- to least-severe, matching Rust's `Level` ordering semantics:
 * a filter of `info` enables `error`, `warn` and `info`.
 */
export type LogLevel = "error" | "warn" | "info" | "debug" | "trace";

/** Verbosity rank; an event passes a filter when its rank is <= the filter's rank. */
const LEVEL_RANK: Record<LogLevel, number> = { error: 1, warn: 2, info: 3, debug: 4, trace: 5 };

/** `tracing::Metadata` + recorded fields, as handed to a layer on span creation. */
export interface SpanAttributes {
	/** oracle otlp.rs:158 — `attrs.metadata().name()`. */
	name: string;
	/** oracle otlp.rs:159 — `attrs.metadata().target()`. */
	target: string;
	/**
	 * Raw recorded field values. Stringification is the *layer's* job — oracle runs its own
	 * `AttrCollector` visitor inside `on_new_span` (otlp.rs:153-154), so values arrive here
	 * untouched.
	 */
	fields: Record<string, unknown>;
}

/**
 * `tracing_subscriber::layer::Layer<S>`, narrowed to the two callbacks `otlp.rs` implements
 * (`on_new_span` / `on_close`, otlp.rs:152-199).
 *
 * The trait belongs to the subscriber side in oracle too (it comes from `tracing-subscriber`,
 * which `logging.rs` — not `otlp.rs` — is the consumer of), so it is declared here and
 * `otlp.ts` type-imports it. That keeps the runtime import edge one-directional
 * (`logging.ts` → `otlp.ts`, mirroring oracle's `crate::otlp::try_layer()` call at
 * logging.rs:64).
 */
export interface SpanLayer {
	/** oracle otlp.rs:152 — `span::Id` is a `u64` (RULEBOOK §2.1 → `number`). */
	onNewSpan(id: number, attrs: SpanAttributes): void;
	/** oracle otlp.rs:166. */
	onClose(id: number): void;
}

/** oracle logging.rs:18-23 (`struct LoggingHandle`). */
export interface LoggingHandle {
	/** Path written for this session — surfaced by `/diag`. oracle logging.rs:22. */
	readonly logPath: string;
	/**
	 * Flush and stop the background writer, then uninstall the subscriber.
	 *
	 * Oracle has no equivalent *method*: the `WorkerGuard` (logging.rs:20) does this on `Drop`,
	 * and Rust's global subscriber can never be uninstalled at all. TypeScript has no `Drop`, so
	 * the flush has to be an explicit call; uninstalling alongside it is a deliberate, documented
	 * divergence that makes the module testable. It is unobservable in the CLI, which calls
	 * `init` exactly once and holds the handle until process exit (oracle logging.rs:5-6).
	 */
	close(): Promise<void>;
}

interface InstalledSubscriber {
	readonly filter: EnvFilter;
	readonly stream: WriteStream;
	readonly layers: SpanLayer[];
	nextSpanId: number;
}

/**
 * The process-global subscriber slot. Oracle's counterpart is `tracing`'s global default
 * subscriber, which `try_init` (logging.rs:67,69) refuses to overwrite — that refusal is exactly
 * what makes `init` idempotent (logging.rs:25-26,71-74).
 */
let installed: InstalledSubscriber | undefined;

/**
 * Install a subscriber tied to the supplied session id. Idempotent: if a subscriber is already
 * set (e.g. by a test harness), the function returns `undefined`.
 *
 * oracle logging.rs:27-80 (`init`).
 */
export function init(sessionId: string): LoggingHandle | undefined {
	// oracle logging.rs:28-32. `std::fs::create_dir_all` is synchronous on the CLI startup path,
	// which RULEBOOK §2.3 authorises as case ① ("the caller is strictly synchronous (CLI startup path)").
	const dir = join(getAgentDir(), "logs");
	try {
		mkdirSync(dir, { recursive: true });
	} catch (e) {
		// oracle logging.rs:30 — `eprintln!`. stderr, and the one console.* the RULEBOOK §1 "logging"
		// row's product-path ban has to yield to: it is oracle's own user-visible diagnostic, and
		// the logger it would otherwise route through is the very thing that just failed.
		console.error(`(logging disabled: cannot create ${dir}: ${errorDisplay(e)})`);
		return undefined;
	}

	// oracle logging.rs:33-34.
	const filename = `${short(sessionId)}.log`;
	const logPath = join(dir, filename);

	// oracle logging.rs:38-51 — `OpenOptions::new().create(true).append(true).open(&log_path)`.
	// Opened synchronously so an open failure is reported through the same tolerant path oracle
	// uses, before any writer exists (RULEBOOK §2.3 case ①, as above).
	let fd: number;
	try {
		fd = openSync(logPath, "a");
	} catch (e) {
		// oracle logging.rs:45-48.
		console.error(`(logging disabled: cannot open ${logPath}: ${errorDisplay(e)})`);
		return undefined;
	}

	// oracle logging.rs:71-74: another subscriber is already installed (tests usually) —
	// `try_init` returns Err and we bail silently. The fd opened just above is released first;
	// oracle drops its `File` on the same path when `try_init` fails.
	if (installed !== undefined) {
		closeSync(fd);
		return undefined;
	}

	// oracle logging.rs:52 — `tracing_appender::non_blocking(file)`. A `WriteStream` is the
	// node-side non-blocking writer: writes are queued and drained by the event loop rather than
	// blocking the caller, and pending data is flushed when the stream is ended (see `close`).
	// (`logPath` is ignored while `fd` is set; it is passed for readable stream diagnostics.)
	const stream = createWriteStream(logPath, { fd, autoClose: true });
	// Never let a writer failure take down the CLI (oracle logging.rs:8-9); an unhandled 'error'
	// event on a stream is a process-level throw in Node.
	stream.on("error", (err) => {
		console.error(`(logging write failed: ${errorDisplay(err)})`);
	});

	// oracle logging.rs:54 —
	// `EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"))`.
	const filter = parseEnvFilter(process.env.RUST_LOG);

	// oracle logging.rs:62-70. Optional OTLP layer (issue #15): activates only when
	// OTEL_EXPORTER_OTLP_ENDPOINT is set — silent no-op otherwise.
	const otlp = tryLayer();
	const layers: SpanLayer[] = otlp ? [otlp] : [];

	installed = { filter, stream, layers, nextSpanId: 1 };

	// oracle logging.rs:76-79.
	return {
		logPath,
		close: () =>
			new Promise<void>((resolve) => {
				if (installed?.stream !== stream) {
					resolve();
					return;
				}
				installed = undefined;
				stream.end(() => resolve());
			}),
	};
}

/**
 * Helper for the `/diag` command — returns the canonical logs dir for display.
 * oracle logging.rs:88-92 (`logs_dir`), `#[allow(dead_code)]`.
 */
export function logsDir(): string {
	return join(getAgentDir(), "logs");
}

/**
 * Used in the log filename: keep just enough of the UUIDv7 to disambiguate within a day.
 * oracle logging.rs:82-86 (`short`).
 *
 * Oracle slices **bytes** (`session_id.len()` is the UTF-8 byte length and `&session_id[..cap]`
 * is a byte slice), so this port measures in bytes too. Rust panics when the cut lands inside a
 * multi-byte character; session ids are ASCII UUIDs, so that branch is unreachable in practice,
 * but it is reproduced rather than silently replaced with a replacement character.
 */
export function short(sessionId: string): string {
	const bytes = Buffer.from(sessionId, "utf8");
	const cap = Math.min(bytes.length, 16);
	if (cap < bytes.length && (bytes[cap] & 0xc0) === 0x80) {
		// oracle: `&session_id[..cap]` panics with "byte index N is not a char boundary".
		// RULEBOOK §2.4 maps `panic!` onto a throw (the `invariant` helper it names does not exist
		// in `@pie/agent-core` yet — TODO(port): switch to it once it does).
		throw new Error(`byte index ${cap} is not a char boundary`);
	}
	return bytes.subarray(0, cap).toString("utf8");
}

/* -------------------------------------------------------------------------------------------
 * The `tracing` macro surface this subscriber consumes.
 *
 * Not part of oracle `logging.rs` (in Rust these are `tracing::{trace,debug,info,warn,error}!`
 * and `tracing::span!`, from the `tracing` crate). Declared here because a subscriber with no
 * event source is inert, and because `otlp.rs`'s layer is driven entirely by span lifecycle
 * callbacks that something has to raise.
 * ----------------------------------------------------------------------------------------- */

/** A live span. Closing it is the analogue of dropping `tracing`'s span guard. */
export interface SpanHandle {
	close(): void;
}

/** No-op handle handed back when no subscriber is installed or the filter rejected the span. */
const NOOP_SPAN: SpanHandle = { close: () => {} };

/**
 * Record one event. Silently drops when no subscriber is installed — the same posture as
 * `tracing`'s macros before `init` runs.
 */
export function emit(level: LogLevel, target: string, message: string, fields?: Record<string, unknown>): void {
	const sub = installed;
	if (!sub || !filterEnabled(sub.filter, target, level)) return;
	writeLine(sub, level, target, message, fields);
}

/**
 * Open a span. Notifies every installed layer (`Layer::on_new_span`), and again on
 * {@link SpanHandle.close} (`Layer::on_close`), which is also when the `fmt` layer emits its
 * line — oracle configures `FmtSpan::CLOSE` (logging.rs:60).
 *
 * TODO(port): oracle's `OtlpLayer::register_callsite` returns `Interest::always()`
 * (otlp.rs:148-150), which in `tracing-subscriber` interacts with the global `EnvFilter` layer
 * through interest merging this port does not reproduce; here the filter gates span creation for
 * every layer uniformly. Only reachable when `RUST_LOG` lowers the filter below the span's level
 * *and* an OTLP endpoint is configured.
 */
export function span(level: LogLevel, target: string, name: string, fields?: Record<string, unknown>): SpanHandle {
	const sub = installed;
	if (!sub || !filterEnabled(sub.filter, target, level)) return NOOP_SPAN;

	const id = sub.nextSpanId++;
	for (const layer of sub.layers) {
		layer.onNewSpan(id, { name, target, fields: fields ?? {} });
	}

	let closed = false;
	return {
		close: () => {
			if (closed) return;
			closed = true;
			if (installed !== sub) return;
			for (const layer of sub.layers) {
				layer.onClose(id);
			}
			// oracle logging.rs:60 — `FmtSpan::CLOSE`. TODO(port): oracle's close event also
			// carries `time.busy`/`time.idle` fields, which this port does not track.
			writeLine(sub, level, target, "close", { "span.name": name });
		},
	};
}

/* -------------------------------------------------------------------------------------------
 * fmt layer
 * ----------------------------------------------------------------------------------------- */

function writeLine(
	sub: InstalledSubscriber,
	level: LogLevel,
	target: string,
	message: string,
	fields?: Record<string, unknown>,
): void {
	const parts = [formatTimestamp(new Date()), level.toUpperCase().padStart(5, " ")];
	// oracle logging.rs:59 — `.with_thread_ids(true)`. Node's main thread is 0; worker threads
	// get their own id. Rust numbers its main thread 1, so the values are not comparable — only
	// the "which thread" distinction is.
	parts.push(`ThreadId(${String(threadId).padStart(2, "0")})`);
	// oracle logging.rs:58 — `.with_target(true)`.
	parts.push(`${target}:`);
	parts.push(message);
	for (const [key, value] of Object.entries(fields ?? {})) {
		parts.push(`${key}=${displayField(value)}`);
	}
	// oracle logging.rs:57 — `.with_ansi(false)`: the line carries no escape sequences.
	sub.stream.write(`${parts.join(" ")}\n`);
}

/** RFC 3339 with 6 fractional digits and a `Z` suffix, matching `tracing-subscriber`'s default. */
function formatTimestamp(now: Date): string {
	return `${now.toISOString().replace(/Z$/, "")}000Z`;
}

function displayField(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "bigint") return value.toString();
	return JSON.stringify(value) ?? String(value);
}

/** `std::io::Error`'s `Display`, for the two `eprintln!`s above. */
function errorDisplay(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/* -------------------------------------------------------------------------------------------
 * EnvFilter
 * ----------------------------------------------------------------------------------------- */

export interface EnvFilter {
	/** Level applied to targets no directive matches. */
	readonly global: LogLevel;
	/** `target=level` directives, longest target first so the first match is the most specific. */
	readonly targets: ReadonlyArray<{ target: string; level: LogLevel }>;
}

/**
 * `EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"))`
 * (oracle logging.rs:54).
 *
 * Supported directive subset — comma-separated, each either a bare `level` (global) or
 * `target=level` (longest matching target prefix wins, as in `env_filter`). An unset, empty or
 * wholly unparseable `RUST_LOG` yields the `info` default, and individual unrecognised
 * directives are skipped — `EnvFilter` is lenient about those too.
 *
 * TODO(port): `env_filter`'s span directives (`target[span]=level`) and field predicates
 * (`[span{field=value}]`) are not implemented; such directives are skipped rather than
 * approximated.
 */
export function parseEnvFilter(raw: string | undefined): EnvFilter {
	const fallback: EnvFilter = { global: "info", targets: [] };
	if (raw === undefined || raw.trim() === "") return fallback;

	let global: LogLevel | undefined;
	const targets: Array<{ target: string; level: LogLevel }> = [];
	for (const rawDirective of raw.split(",")) {
		const directive = rawDirective.trim();
		if (directive === "") continue;
		// Skip span/field predicates rather than mis-approximating them (see TODO above).
		if (directive.includes("[")) continue;
		const eq = directive.indexOf("=");
		if (eq === -1) {
			const level = parseLevel(directive);
			if (level) global = level;
			continue;
		}
		const target = directive.slice(0, eq).trim();
		const level = parseLevel(directive.slice(eq + 1));
		if (target !== "" && level) targets.push({ target, level });
	}

	if (global === undefined && targets.length === 0) return fallback;
	// Most specific first: `env_filter` picks the longest matching target.
	targets.sort((a, b) => b.target.length - a.target.length);
	// `RUST_LOG=my_crate=debug` leaves everything else off, not at `info` — a directive list with
	// no bare level has no global default. "error" is the least permissive real level; nothing
	// below it exists, so it stands in for "off" for the unmatched-target case.
	return { global: global ?? "error", targets };
}

function parseLevel(raw: string): LogLevel | undefined {
	const level = raw.trim().toLowerCase();
	return level in LEVEL_RANK ? (level as LogLevel) : undefined;
}

/** True when an event at `level` on `target` passes `filter`. */
export function filterEnabled(filter: EnvFilter, target: string, level: LogLevel): boolean {
	const directive = filter.targets.find((t) => target === t.target || target.startsWith(`${t.target}::`));
	return LEVEL_RANK[level] <= LEVEL_RANK[directive?.level ?? filter.global];
}

/* -------------------------------------------------------------------------------------------
 * oracle logging.rs:94-95 declares `fn _path_check(_p: &Path) {}` — a dead, empty,
 * `#[allow(dead_code)]` no-op with no callers and no observable behaviour. Nothing to port; it is
 * recorded here so its absence reads as deliberate rather than as an omission.
 * ----------------------------------------------------------------------------------------- */
