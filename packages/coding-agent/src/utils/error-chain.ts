/**
 * Render an error and its `cause` chain the way `anyhow` prints one.
 *
 * RULEBOOK §2.4 maps oracle's `anyhow::Context` onto `new Error(msg, { cause })`, which preserves
 * the chain but says nothing about printing it — and `Error.message` alone shows only the
 * outermost context. Phase 19's F6 is the bill for that: `local_models::load_file`'s
 * `.context(format!("parse {path}"))` reached the user as the bare string
 * `parse /home/u/.pie/models.json`, while oracle printed
 *
 * ```
 * Error: parse /home/u/.pie/models.json
 *
 * Caused by:
 *     key must be a string at line 1 column 3
 * ```
 *
 * i.e. the half of the message that says what is actually wrong and where. This restores it in
 * anyhow's layout: the outermost message first, then every distinct cause under a `Caused by:`
 * header indented four spaces, outermost-first. anyhow numbers the entries (`0: …`) only when
 * there are two or more, and so does this.
 *
 * The cause TEXT is the runtime's, not serde's — `JSON.parse` says "Expected property name or '}'
 * in JSON at position 2 (line 1 column 3)" where serde_json says "key must be a string at line 1
 * column 3". Same fact, same position, different words: a declared, unavoidable divergence (the
 * wording belongs to V8's parser).
 */

/** Longest chain we will walk, so a self-referential `cause` cannot spin forever. */
const MAX_CAUSE_DEPTH = 8;

function messageOf(value: unknown): string {
	if (value instanceof Error) return value.message;
	if (typeof value === "string") return value;
	return String(value);
}

export function describeErrorChain(error: unknown): string {
	const head = messageOf(error);

	const causes: string[] = [];
	let current: unknown = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
		if (!(current instanceof Error) || current.cause === undefined || current.cause === null) break;
		const text = messageOf(current.cause);
		// Skip a link that only repeats what has already been printed: a context wrapper carrying
		// the same string as its cause adds a line and no information.
		if (text.length > 0 && text !== causes[causes.length - 1] && text !== head) causes.push(text);
		current = current.cause;
	}

	if (causes.length === 0) return head;
	if (causes.length === 1) return `${head}\n\nCaused by:\n    ${causes[0]}`;
	return `${head}\n\nCaused by:\n${causes.map((text, index) => `    ${index}: ${text}`).join("\n")}`;
}
