import { describe, expect, it } from "vitest";
import { shortHash } from "../src/utils/hash.ts";

// pie: crates/ai/src/utils/hash.rs — "1:1 port ... Uses cjk-friendly UTF-16 code units to keep
// wire-compatible output with the JS version." Ported oracle's `produces_deterministic_output`
// test (crates/ai/src/utils/hash.rs:44-50) plus fixed expected outputs computed from this exact
// implementation, to lock the cross-language algorithm in place (constants/shift amounts/base36
// encoding must never drift, since it feeds cache-key shortening).
describe("shortHash", () => {
	it("is deterministic for the same input", () => {
		expect(shortHash("hello")).toBe(shortHash("hello"));
	});

	it("differs for different input", () => {
		expect(shortHash("hello")).not.toBe(shortHash("hellp"));
	});

	it("matches the oracle's fixed cyrb128-style output for known inputs", () => {
		expect(shortHash("hello")).toBe("1h6qa0qrowduu");
		expect(shortHash("")).toBe("k4n83c7h0j2b");
		expect(shortHash("hellp")).toBe("zx5mh01t8rho");
	});

	it("handles multi-byte (CJK) characters via UTF-16 code units", () => {
		const h1 = shortHash("你好世界");
		const h2 = shortHash("你好世界");
		expect(h1).toBe(h2);
		expect(h1).not.toBe(shortHash("你好世畍"));
	});
});
