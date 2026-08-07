export function headersToRecord(headers: Headers): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of headers.entries()) {
		result[key] = value;
	}
	return result;
}

// pie: crates/ai/src/utils/headers.rs:5-7
// TODO(port): version literal must track oracle Cargo.toml, not this package.json
export function userAgent(): string {
	return "pie-ai-rs/0.75.0";
}
