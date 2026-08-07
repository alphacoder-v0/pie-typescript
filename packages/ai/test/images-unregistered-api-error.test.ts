// Locks in a wording fix applied to packages/ai/src/images.ts for manifest unit `ai/images`
// (see migration/reviews/ai/divergence-ledger.tsv).
//
// oracle crates/ai/src/images.rs:12 — `.ok_or_else(|| format!("No images API registered for:
// {}", model.api.0))?` — is the throw-equivalent (RULEBOOK §2.4: Result<T,E> -> throw) for an
// unregistered images api. images.ts previously threw a verbatim copy of stream.ts's DIFFERENT
// message ("No API provider registered for api: X", the correct wording for the unrelated
// stream/chat provider registry — see crates/ai/src/stream.rs and divergence-ledger.tsv unit
// ai/stream) instead of images.rs's own distinct wording. This test is hermetic — no network
// access, no API keys required, only exercises the api-registry-miss branch of
// resolveImagesApiProvider.
import { describe, expect, it } from "vitest";
import { generateImages } from "../src/images.ts";
import type { ImagesContext, ImagesModel } from "../src/types.ts";

function unregisteredApiModel(api: string): ImagesModel<string> {
	return {
		id: "does-not-matter",
		name: "Unregistered Images Model",
		api,
		provider: "test-images-provider",
		baseUrl: "",
		input: ["text"],
		output: ["image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

describe("images.ts unregistered-api error message (oracle parity)", () => {
	it("throws oracle's exact wording, not stream.ts's wording", async () => {
		const model = unregisteredApiModel("nonexistent-images-api-xyz");
		const context: ImagesContext = { input: [{ type: "text", text: "hi" }] };

		await expect(generateImages(model, context)).rejects.toThrow(
			"No images API registered for: nonexistent-images-api-xyz",
		);
	});

	it("does not use stream.ts's distinct message text", async () => {
		const model = unregisteredApiModel("nonexistent-images-api-xyz");
		const context: ImagesContext = { input: [{ type: "text", text: "hi" }] };

		try {
			await generateImages(model, context);
			throw new Error("expected generateImages to throw");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			expect(message).not.toContain("No API provider registered for api:");
		}
	});
});
