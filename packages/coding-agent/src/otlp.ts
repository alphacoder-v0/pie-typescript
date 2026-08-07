/**
 * OTLP HTTP/JSON span exporter. Hand-rolled {@link SpanLayer} that buffers spans on close and
 * POSTs OTLP-shaped JSON to `${OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces` in batches.
 *
 * Port of oracle `crates/coding-agent/src/otlp.rs` (pie @0a120dfd).
 *
 * Closes the OTLP slot of c4pt0r/pie#15. Activates automatically when
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is set; silent no-op otherwise.
 *
 * Why hand-rolled (oracle otlp.rs:7-10): the official `opentelemetry` + `tracing-opentelemetry`
 * crates have a version-churn history that complicates pinning. The OTLP/JSON wire format is
 * small enough to encode by hand, and a coding agent does not need the full OTel SDK (metrics,
 * log signal, propagators).
 *
 * **Dependency allowlist (RULEBOOK §1).** That hand-rolling is what makes this unit portable
 * inside the allowlist with no new package at all: oracle already reaches for no OTel crate, only
 * `reqwest` + `serde_json`, which map onto the allowlist's "HTTP client = the global `fetch`
 * (undici) + AbortSignal" row and `JSON.stringify` respectively. No `@opentelemetry/*` package is
 * added, `package.json` is untouched, and the transport encoded here is OTLP/**HTTP+JSON** — the
 * same one oracle emits (`client.post(...).json(&payload)`, otlp.rs:116), never OTLP/gRPC or
 * protobuf, so no protobuf codec is needed either.
 *
 * Oracle carries `#![allow(dead_code)]` (otlp.rs:12); the only live entry point is
 * {@link tryLayer}, which `logging.ts` calls (oracle logging.rs:64).
 */

import { inspect } from "node:util";
import { detach } from "@pie/agent-core";
import type { SpanAttributes, SpanLayer } from "./logging.ts";

/** oracle otlp.rs:25. */
const BATCH_SIZE = 64;
/** oracle otlp.rs:26. */
const FLUSH_INTERVAL_MS = 2_000;
/** oracle otlp.rs:113 — `reqwest::Client::builder().timeout(Duration::from_secs(5))`. */
const REQUEST_TIMEOUT_MS = 5_000;

/**
 * oracle otlp.rs:101 — `env!("CARGO_PKG_VERSION")`, resolving to the ORACLE crate's version
 * (`crates/coding-agent/Cargo.toml` version = "0.75.0"). Deliberately NOT `config.ts`'s `VERSION`,
 * which reads this repo's `package.json` (pi's lineage) — same reasoning and same literal already
 * used by `lsp.ts:164` and `session-archive.ts:62`.
 */
const ORACLE_CRATE_VERSION = "0.75.0";

/** An OTLP/JSON document fragment. `serde_json::Value` → a plain JSON-serialisable value. */
type JsonValue = unknown;

/**
 * Try to build an OTLP layer from `OTEL_EXPORTER_OTLP_ENDPOINT`. Returns `undefined` when the env
 * var isn't set so the caller can skip installation cleanly.
 *
 * oracle otlp.rs:30-36 (`try_layer`).
 */
export function tryLayer(): OtlpLayer | undefined {
	// oracle otlp.rs:31 — `std::env::var(...).ok()?`: absent (or non-unicode) yields None.
	const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
	if (endpoint === undefined) return undefined;
	// oracle otlp.rs:32-34.
	if (endpoint.trim() === "") return undefined;
	return new OtlpLayer(endpoint);
}

/** oracle otlp.rs:53-58 (`struct OpenSpan`). */
interface OpenSpan {
	name: string;
	target: string;
	/** `u128` nanoseconds → `bigint` (RULEBOOK §2.1, which names otlp's ns timestamps explicitly). */
	startNs: bigint;
	attributes: Map<string, string>;
}

/**
 * oracle otlp.rs:43-51 (`struct Inner`).
 *
 * Oracle wraps `pending` and `open` in `parking_lot::Mutex`. RULEBOOK §2.2's `Mutex` row makes
 * the mapping mechanical: a critical section that does **not** cross an `await` becomes plain
 * field access (single-threaded event loop = atomic by construction). None here does — the two
 * layer callbacks are wholly synchronous, and `flush_once` drops its guard (`std::mem::take`,
 * otlp.rs:89-95) before it ever awaits.
 */
class Inner {
	/** In-memory ring of finished spans waiting for the next batch flush. */
	pending: JsonValue[] = [];
	/**
	 * Per-span lookaside that holds opened-but-not-yet-closed spans so we can compute their
	 * duration on close. Keyed by tracing span id.
	 */
	readonly open = new Map<number, OpenSpan>();

	readonly endpoint: string;
	serviceName: string;

	constructor(endpoint: string, serviceName: string) {
		this.endpoint = endpoint;
		this.serviceName = serviceName;
	}

	/**
	 * Re-bind the service name without poisoning the existing inner's queue. Used only by
	 * {@link OtlpLayer.withServiceName}. oracle otlp.rs:127-134 (`clone_for_rename`).
	 */
	cloneForRename(): Inner {
		return new Inner(this.endpoint, this.serviceName);
	}
}

/** oracle otlp.rs:38-41 (`struct OtlpLayer`), `#[derive(Clone)]` over the shared `Arc<Inner>`. */
export class OtlpLayer implements SpanLayer {
	private inner: Inner;

	/** oracle otlp.rs:61-76 (`OtlpLayer::new`). */
	constructor(endpoint: string) {
		// oracle otlp.rs:63-64 — trailing slashes are stripped so `/v1/traces` concatenates cleanly.
		this.inner = new Inner(endpoint.replace(/\/+$/, ""), "pie");

		const pumper = this.inner;
		// oracle otlp.rs:68-74 — a detached `tokio::spawn` running `loop { sleep; flush_once }`.
		// RULEBOOK §2.2 maps detached spawns onto the single `detach()` helper.
		detach(
			async () => {
				for (;;) {
					await sleepUnref(FLUSH_INTERVAL_MS);
					await OtlpLayer.flushOnce(pumper);
				}
			},
			(error) => {
				// Defensive only: `flushOnce` swallows every transport failure itself (see there),
				// so nothing here can reject in practice. RULEBOOK §2.4 forbids a silent catch, and
				// `console.error` is this package's established stand-in for an oracle
				// `tracing::warn!` (goal.ts:339) — which is also the only sink available, since
				// routing back into `logging.ts` would close an import cycle.
				console.error(`(otlp pump stopped: ${error instanceof Error ? error.message : String(error)})`);
			},
		);
	}

	/**
	 * oracle otlp.rs:78-86 (`with_service_name`).
	 *
	 * Faithful reproduction of a real oracle wart: `clone_for_rename` hands back an `Inner` with a
	 * *fresh, empty* `pending`/`open` and **no flush pumper is spawned for it** (only `new` at
	 * otlp.rs:68-74 ever spawns one). Spans recorded through the renamed layer therefore queue
	 * forever and are never exported. Reproduced rather than fixed, per RULEBOOK §0's bug-for-bug
	 * rule; it is unreachable in oracle today — `with_service_name` has no caller anywhere in the
	 * crate, which is part of why the module carries `#![allow(dead_code)]`.
	 */
	withServiceName(name: string): OtlpLayer {
		const renamed = Object.create(OtlpLayer.prototype) as OtlpLayer;
		const inner = this.inner.cloneForRename();
		inner.serviceName = name;
		renamed.inner = inner;
		return renamed;
	}

	/**
	 * oracle otlp.rs:88-121 (`async fn flush_once`). An associated function on `OtlpLayer`,
	 * private in Rust; exposed here because TypeScript has no crate-private visibility and the
	 * flush is the only deterministic seam a test can drive without waiting out
	 * {@link FLUSH_INTERVAL_MS}.
	 */
	static async flushOnce(inner: Inner): Promise<void> {
		// oracle otlp.rs:89-95 — bail before building anything when there is nothing to send, then
		// `std::mem::take` the queue so concurrent pushes land in the fresh one.
		if (inner.pending.length === 0) return;
		const drained = inner.pending;
		inner.pending = [];

		// oracle otlp.rs:96-109.
		const payload = {
			resourceSpans: [
				{
					resource: {
						attributes: [
							{ key: "service.name", value: { stringValue: inner.serviceName } },
							{ key: "service.version", value: { stringValue: ORACLE_CRATE_VERSION } },
						],
					},
					scopeSpans: [{ scope: { name: "pie" }, spans: drained }],
				},
			],
		};
		// oracle otlp.rs:110.
		const endpoint = `${inner.endpoint}/v1/traces`;

		// oracle otlp.rs:111-120. Fire and forget — OTLP collectors are advisory, never
		// load-bearing for the agent, so oracle discards the result outright (`let _ = req.send()`
		// inside a detached spawn). Swallowing here is therefore the *faithful* behaviour, not a
		// §2.4 violation: surfacing a failed export would emit diagnostics oracle never emits.
		detach(
			async () => {
				await fetch(endpoint, {
					method: "POST",
					// `reqwest`'s `.json(&payload)` sets this header and serialises the body.
					headers: { "content-type": "application/json" },
					body: JSON.stringify(payload),
					// oracle otlp.rs:112-115 — the client's 5s timeout. RULEBOOK §2.2 fixes
					// `AbortSignal.timeout(ms)` as the single timeout source.
					signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				});
			},
			() => {
				/* see above: oracle discards transport errors */
			},
		);
	}

	/** Instance-side convenience over {@link OtlpLayer.flushOnce}; same semantics. */
	flush(): Promise<void> {
		return OtlpLayer.flushOnce(this.inner);
	}

	/** oracle otlp.rs:152-164 (`Layer::on_new_span`). */
	onNewSpan(id: number, attrs: SpanAttributes): void {
		this.inner.open.set(id, {
			name: attrs.name,
			target: attrs.target,
			startNs: nowNs(),
			// oracle otlp.rs:153-154 — the `AttrCollector` visitor runs here, inside the layer.
			attributes: collectAttributes(attrs.fields),
		});
	}

	/** oracle otlp.rs:166-199 (`Layer::on_close`). */
	onClose(id: number): void {
		const span = this.inner.open.get(id);
		// oracle otlp.rs:167-168 — unknown id (never opened, or already closed) is a no-op.
		if (span === undefined) return;
		this.inner.open.delete(id);

		const endNs = nowNs();
		// oracle otlp.rs:170-174. Note: Rust iterates a `HashMap`, whose order is unspecified;
		// a JS `Map` is insertion-ordered. Nothing may depend on Rust's order, and OTLP attribute
		// order carries no meaning — the divergence is toward determinism.
		const attrsJson: JsonValue[] = [...span.attributes].map(([k, v]) => ({
			key: k,
			value: { stringValue: v },
		}));
		// oracle otlp.rs:175-182. OTLP span id / trace id are 8 / 16 hex bytes. There is no
		// propagation source, so they are synthesised per span: queryable, but not yet linked into
		// a distributed trace.
		const allAttrs: JsonValue[] = [{ key: "tracing.target", value: { stringValue: span.target } }, ...attrsJson];
		// oracle otlp.rs:183-192.
		this.inner.pending.push({
			traceId: hexRandom(16),
			spanId: hexRandom(8),
			name: span.name,
			kind: 1,
			startTimeUnixNano: span.startNs.toString(),
			endTimeUnixNano: endNs.toString(),
			attributes: allAttrs,
			status: { code: 1 },
		});
		if (this.inner.pending.length >= BATCH_SIZE) {
			// oracle otlp.rs:195-198: deliberately empty. The actual POST is deferred; `flush_once`
			// runs on the next tick. (No spawn here — oracle is inside a sync trait method.)
		}
	}
}

/**
 * oracle otlp.rs:137-142 (`now_ns`) — `SystemTime::now().duration_since(UNIX_EPOCH).as_nanos()`,
 * a `u128` → `bigint` (RULEBOOK §2.1). §2.3 maps `SystemTime::now` onto `Date.now()`, whose
 * resolution is milliseconds; the sub-millisecond digits oracle would carry are therefore zeroes.
 * `process.hrtime.bigint()` has the resolution but is monotonic-since-boot, not Unix-epoch, so it
 * cannot supply `startTimeUnixNano` on its own.
 */
function nowNs(): bigint {
	return BigInt(Date.now()) * 1_000_000n;
}

/** 2^64 - 1; Rust's `u64` wrapping arithmetic is modular in this ring. */
const U64_MASK = 0xffff_ffff_ffff_ffffn;

/** oracle otlp.rs:204 — `static SEED: AtomicU64`. */
let seed = 0x9e37_79b9_7f4a_7c15n;

/**
 * oracle otlp.rs:202-214 (`hex_random`).
 *
 * `u64` normally maps to `number` (RULEBOOK §2.1), but this site is *wrapping* 64-bit LCG
 * arithmetic: `wrapping_mul`/`wrapping_add` overflow past 2^53 on every step, so `number` cannot
 * reproduce the output. `bigint` masked to 64 bits is the only mapping that does — the same
 * reasoning §2.1 already applies to otlp's `u128` timestamps.
 */
export function hexRandom(bytes: number): string {
	// `fetch_add` returns the value *before* the add.
	const s0 = seed;
	seed = (seed + 0x6364_1362_2384_6793n) & U64_MASK;
	let s = s0;
	let out = "";
	for (let i = 0; i < bytes; i++) {
		s = (s * 6_364_136_223_846_793_005n + 1_442_695_040_888_963_407n) & U64_MASK;
		// `(s >> 56) as u8` — the top byte.
		out += ((s >> 56n) & 0xffn).toString(16).padStart(2, "0");
	}
	return out;
}

/**
 * oracle otlp.rs:216-242 (`struct AttrCollector` + its `tracing::field::Visit` impl): every
 * recorded field is flattened to a string, keyed by field name.
 *
 * The Rust visitor dispatches on the field's static type; TypeScript has one dynamic value, so
 * the branches are recovered by `typeof`, preserving each `record_*` arm's formatting:
 * `record_str` passes the string through, the integer/bool arms use `to_string()`, and everything
 * else lands in `record_debug`'s `format!("{value:?}")` — which RULEBOOK §2.1 maps to
 * `util.inspect`.
 */
export function collectAttributes(fields: Record<string, unknown>): Map<string, string> {
	const attrs = new Map<string, string>();
	for (const [key, value] of Object.entries(fields)) {
		attrs.set(key, displayFieldValue(value));
	}
	return attrs;
}

function displayFieldValue(value: unknown): string {
	// oracle otlp.rs:226-229 (`record_str`).
	if (typeof value === "string") return value;
	// oracle otlp.rs:238-241 (`record_bool`).
	if (typeof value === "boolean") return String(value);
	// oracle otlp.rs:230-237 (`record_i64` / `record_u64`).
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "number" && Number.isInteger(value)) return String(value);
	// oracle otlp.rs:222-225 (`record_debug`), the fallback every other `Visit` method defers to.
	return inspect(value);
}

/**
 * `tokio::time::sleep` (oracle otlp.rs:71) inside the detached pump loop.
 *
 * `utils/sleep.ts` cannot be reused: its timer is not `unref`'d, so the never-ending pump loop
 * would hold the Node event loop open and the CLI would never exit — whereas oracle's task simply
 * dies with the tokio runtime. `unref()` restores that.
 *
 * RULEBOOK §2.2's ban on hand-rolled `new Promise` + `setTimeout` governs the
 * `tokio::time::timeout` row (a *race* whose loser must be aborted); this is a plain `sleep` with
 * no race and no loser.
 */
function sleepUnref(ms: number): Promise<void> {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, ms).unref();
	});
}
