import "./providers/register-builtins.ts";

import { errorStream, getApiProvider } from "./api-registry.ts";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	ProviderStreamOptions,
	SimpleStreamOptions,
	StreamOptions,
} from "./types.ts";

export { getEnvApiKey } from "./env-api-keys.ts";

function resolveApiProvider(api: Api) {
	return getApiProvider(api);
}

export function stream<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): AssistantMessageEventStream {
	const provider = resolveApiProvider(model.api);
	if (!provider) {
		// pie: crates/ai/src/stream.rs:13-17,19-28 (resolve + stream) — oracle returns
		// error_stream(msg) here instead of throwing (see api-registry.ts errorStream for the
		// shared rationale/evidence). Bug-for-bug: encode as a stream event, not a synchronous throw.
		return errorStream(`No API provider registered for api: ${model.api}`);
	}
	return provider.stream(model, context, options as StreamOptions);
}

export async function complete<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): Promise<AssistantMessage> {
	const s = stream(model, context, options);
	return s.result();
}

export function streamSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const provider = resolveApiProvider(model.api);
	if (!provider) {
		// pie: crates/ai/src/stream.rs:13-17,38-47 (resolve + stream_simple) — same divergence as
		// stream() above.
		return errorStream(`No API provider registered for api: ${model.api}`);
	}
	return provider.streamSimple(model, context, options);
}

export async function completeSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
	const s = streamSimple(model, context, options);
	return s.result();
}
