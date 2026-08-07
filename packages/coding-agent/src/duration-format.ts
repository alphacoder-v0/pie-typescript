/**
 * Rust `std::time::Duration`'s `Debug` formatting, for error messages oracle builds with `{:?}`.
 *
 * Two oracle sites interpolate a `Duration` into a user-visible string, and both must match
 * byte-for-byte:
 *   - `crates/coding-agent/src/lsp.rs:256`   — "LSP request {method} timed out after {:?}"
 *   - `crates/coding-agent/src/oauth.rs:123` — "OAuth callback timed out after {:?}"
 *
 * Extracted to one module rather than reimplemented per call site: this is a *user-visible string
 * format* pinned to oracle, and two copies would drift silently.
 *
 * Rust's algorithm picks the largest unit that yields a value >= 1 — `120s`, `1.5s`, `100ms`,
 * `250µs`, `7ns` — prints the fractional part without trailing zeros, and renders a zero duration
 * as `0ns`. The TS side carries timeouts as plain millisecond numbers, so the formatting happens
 * here instead of in the type.
 */
export function formatDurationDebug(ms: number): string {
	const nanos = Math.round(ms * 1_000_000);
	if (nanos >= 1_000_000_000) return `${nanos / 1_000_000_000}s`;
	if (nanos >= 1_000_000) return `${nanos / 1_000_000}ms`;
	if (nanos >= 1_000) return `${nanos / 1_000}µs`;
	return `${nanos}ns`;
}
