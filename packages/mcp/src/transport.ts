/**
 * Transport abstraction. Stdio and Streamable HTTP both adapt to one JSON object per line.
 *
 * pie: crates/mcp/src/transport.rs — `#[async_trait] trait Transport: Send + Sync`. Ported per
 * RULEBOOK §2.1 (`trait` -> `interface`; trait object -> value of that interface type).
 */

/**
 * A bidirectional newline-delimited JSON channel. Implementations send one JSON object per
 * line in each direction.
 */
export interface Transport {
	/** Write one JSON object (caller-supplied serialized string, no trailing newline). */
	sendLine(line: string): Promise<void>;
	/**
	 * Read the next JSON line from the peer. Returns the trimmed line (no trailing newline).
	 * Returns `undefined` on clean EOF (pie: `Ok(None)`, transport.rs:14 — `Option<T>` without a
	 * wire role maps to `T | undefined` per RULEBOOK §2.1).
	 */
	recvLine(): Promise<string | undefined>;
	/** Best-effort shutdown — drop transports, terminate subprocesses, etc. */
	close(): Promise<void>;
}
