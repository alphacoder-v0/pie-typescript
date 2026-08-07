import { describe, expect, it } from "vitest";
import { parseStreamingJson } from "../src/utils/json-parse.ts";

// pie: crates/ai/src/utils/json_parse.rs — oracle's `parse_partial_json` is a hand-rolled
// bracket/string closer (fast-path full parse, else balance open `{`/`[`/open strings and
// trim a trailing comma). Base's `parseStreamingJson` solves the same "tolerant streaming
// tool-call JSON" problem with a materially richer, layered strategy (control-character/escape
// repair via `repairJson`, then the third-party `partial-json` package, then repair+partial-json,
// never throwing). Verdict for this unit: none — kept base's richer implementation; see
// migration/reviews/ai/divergence-ledger.tsv for the full comparison. These tests port the
// *behavioral intent* of oracle's json_parse.rs test cases (crates/ai/src/utils/json_parse.rs:73-107)
// onto base's actual exported surface, documenting where the two diverge (empty input, and
// oracle's ability to fail vs. base's guaranteed non-throwing fallback to `{}`).
describe("parseStreamingJson", () => {
	// pie: crates/ai/src/utils/json_parse.rs:77-82 (full_object)
	it("parses a complete object", () => {
		expect(parseStreamingJson('{"a": 1, "b": "two"}')).toEqual({ a: 1, b: "two" });
	});

	// pie: crates/ai/src/utils/json_parse.rs:84-88 (unclosed_object)
	it("closes an unclosed object", () => {
		expect(parseStreamingJson('{"a": 1')).toEqual({ a: 1 });
	});

	// pie: crates/ai/src/utils/json_parse.rs:90-94 (unclosed_string_in_value)
	it("closes an unclosed string value", () => {
		expect(parseStreamingJson('{"a": "hello')).toEqual({ a: "hello" });
	});

	// pie: crates/ai/src/utils/json_parse.rs:96-100 (trailing_comma)
	it("tolerates a trailing comma", () => {
		expect(parseStreamingJson('{"a": 1,')).toEqual({ a: 1 });
	});

	// pie: crates/ai/src/utils/json_parse.rs:102-106 (empty) — DIVERGENT default: oracle
	// returns Value::Null for empty input; base's parseStreamingJson returns {} (its own
	// documented contract: "Always returns a valid object, even if the JSON is incomplete").
	// Not treated as a divergence to port: base's `{}` default is the pre-existing, actively
	// relied-upon contract for its (out-of-scope, providers/*.ts) callers.
	it("returns an empty object (not null) for empty input, per base's own non-throwing contract", () => {
		expect(parseStreamingJson("")).toEqual({});
		expect(parseStreamingJson(undefined)).toEqual({});
	});

	it("never throws, even for irrecoverably malformed input", () => {
		expect(() => parseStreamingJson("not json at all }{[[")).not.toThrow();
	});
});
