import { describe, expect, it } from "vitest";
import { formatDurationDebug } from "../src/duration-format.ts";

/**
 * Pins Rust `std::time::Duration`'s `Debug` rendering, which two oracle error messages interpolate
 * with `{:?}` (lsp.rs:256, oauth.rs:123). These are user-visible strings compared byte-for-byte
 * against oracle output, so the format is a contract, not a convenience.
 */
describe("formatDurationDebug", () => {
	it("renders the two real oracle timeout values", () => {
		// lsp.rs DEFAULT_REQUEST_TIMEOUT: Duration::from_secs(15) -> "15s"
		expect(formatDurationDebug(15_000)).toBe("15s");
		// oauth.rs callback timeout: Duration::from_secs(120) -> "120s"
		expect(formatDurationDebug(120_000)).toBe("120s");
	});

	it("picks the largest unit that yields a value >= 1", () => {
		expect(formatDurationDebug(1_000)).toBe("1s");
		expect(formatDurationDebug(999)).toBe("999ms");
		expect(formatDurationDebug(1)).toBe("1ms");
		expect(formatDurationDebug(0.25)).toBe("250µs");
		expect(formatDurationDebug(0.000_001)).toBe("1ns");
		expect(formatDurationDebug(0)).toBe("0ns");
	});

	it("prints fractional parts without trailing zeros", () => {
		expect(formatDurationDebug(1_500)).toBe("1.5s");
		expect(formatDurationDebug(2_250)).toBe("2.25s");
		// The trailing-zero case a naive fixed-precision formatter would get wrong.
		expect(formatDurationDebug(120_000)).not.toContain(".");
		expect(formatDurationDebug(100)).toBe("100ms");
	});

	it("never emits the JS-native 'ms' suffix for a whole-second duration", () => {
		// Regression guard for B-D17: the pre-fix lsp.ts emitted "15000ms" here.
		expect(formatDurationDebug(15_000)).not.toBe("15000ms");
	});
});
