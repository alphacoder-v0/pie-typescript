import { afterEach, describe, expect, it, vi } from "vitest";
import { uuidv7 } from "../../src/harness/session/uuid.ts";

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIMESTAMP = 0x0123456789ab;

function parseTimestamp(uuid: string): number {
	return Number.parseInt(uuid.replaceAll("-", "").slice(0, 12), 16);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("uuidv7", () => {
	it("uses the RFC 9562 layout and preserves monotonic order", () => {
		const randomValues = [
			new Uint8Array([0, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xfe, 0x01, 0x11, 0x22, 0x33, 0x44, 0x55]),
			new Uint8Array(16),
			new Uint8Array(16),
		];
		const getRandomValues = vi.fn((bytes: Uint8Array) => {
			bytes.set(randomValues.shift() ?? new Uint8Array(bytes.length));
			return bytes;
		});
		vi.stubGlobal("crypto", { getRandomValues });
		const dateNow = vi.spyOn(Date, "now").mockReturnValue(TIMESTAMP);

		try {
			const first = uuidv7();
			const second = uuidv7();
			const third = uuidv7();

			expect(first).toBe("01234567-89ab-7fff-bfff-f91122334455");
			expect(second).toBe("01234567-89ab-7fff-bfff-fc0000000000");
			expect(third).toBe("01234567-89ac-7000-8000-000000000000");
			expect(first).toMatch(UUID_V7_RE);
			expect(second).toMatch(UUID_V7_RE);
			expect(third).toMatch(UUID_V7_RE);
			expect(parseTimestamp(first)).toBe(TIMESTAMP);
			expect(parseTimestamp(second)).toBe(TIMESTAMP);
			expect(parseTimestamp(third)).toBe(TIMESTAMP + 1);
			expect(first < second).toBe(true);
			expect(second < third).toBe(true);
			expect(getRandomValues).toHaveBeenCalledTimes(3);
		} finally {
			dateNow.mockRestore();
		}
	});

	// pie: crates/agent/src/harness/session/uuid.rs:14-21 (produces_time_ordered_ids) -- ported
	// 1:1 using real timers/randomness (no mocking): the oracle's own smoke test just checks that
	// two calls separated by a small real delay are distinct and lexicographically ordered.
	// Verdict for this unit is "none": oracle's `Uuid::now_v7()` (uuid crate v1.24.0, verified
	// against the vendored source at
	// ~/.cargo/registry/src/index.crates.io-*/uuid-1.24.0/src/timestamp.rs's ContextV7) also
	// maintains a reseeding, monotonic per-process counter (42 usable bits, reseeded each new ms,
	// incremented within a ms, bumping the timestamp forward on overflow) -- the same contract as
	// this file's `lastTimestamp`/`sequence` scheme above, just with a different (also
	// spec-legal) counter width. Both satisfy the property this test and the RFC 9562 layout test
	// above actually rely on: same-process monotonic ordering, which is what --list-sessions'
	// ascending filename sort (jsonl_repo.rs:55-71, already ported) depends on.
	it("produces time-ordered ids across real calls (ported from uuid.rs)", async () => {
		const a = uuidv7();
		await new Promise((resolve) => setTimeout(resolve, 2));
		const b = uuidv7();
		expect(a).not.toBe(b);
		expect(a < b).toBe(true);
	});
});
