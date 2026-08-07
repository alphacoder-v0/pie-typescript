/**
 * pie: crates/ai/src/image_models.rs:13-15 (`list_image_models`, exported at crate root by
 * lib.rs:32) — parameterless listing across every provider.
 */
import { describe, expect, it } from "vitest";
import { getImageModels, getImageProviders, listAllImageModels } from "../src/image-models.ts";

describe("listAllImageModels", () => {
	it("flattens every provider's models", () => {
		const expected = getImageProviders().flatMap((p) => getImageModels(p));
		const all = listAllImageModels();
		expect(all).toHaveLength(expected.length);
		expect(new Set(all.map((m) => m.id))).toEqual(new Set(expected.map((m) => m.id)));
	});

	it("is exported from the package root", async () => {
		const pkg = await import("../src/index.ts");
		expect(typeof pkg.listAllImageModels).toBe("function");
	});
});
