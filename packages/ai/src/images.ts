import "./providers/images/register-builtins.ts";

import { getImagesApiProvider } from "./images-api-registry.ts";
import type { AssistantImages, ImagesApi, ImagesContext, ImagesModel, ProviderImagesOptions } from "./types.ts";

function resolveImagesApiProvider(api: ImagesApi) {
	const provider = getImagesApiProvider(api);
	if (!provider) {
		// pie: crates/ai/src/images.rs:12 `format!("No images API registered for: {}", model.api.0)`
		// — distinct wording from stream.ts's "No API provider registered for api: X" (that message
		// belongs to the unrelated stream provider registry, see divergence-ledger.tsv ai/stream).
		throw new Error(`No images API registered for: ${api}`);
	}
	return provider;
}

export async function generateImages<TApi extends ImagesApi>(
	model: ImagesModel<TApi>,
	context: ImagesContext,
	options?: ProviderImagesOptions,
): Promise<AssistantImages> {
	const provider = resolveImagesApiProvider(model.api);
	return provider.generateImages(model, context, options);
}
