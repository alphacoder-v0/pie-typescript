/**
 * `@file` mention injection.
 *
 * Port of oracle crates/coding-agent/src/mentions.rs (whole file).
 *
 * When the user types a prompt containing `@<path>` tokens, the REPL resolves each path
 * against the current working directory, reads the file, and prepends a small attachment
 * block to the prompt. The agent never sees the raw `@path` token -- it sees:
 *
 * ```text
 * Files in context:
 * <file path="src/foo.rs">
 * …content…
 * </file>
 *
 * <user's original text>
 * ```
 *
 * Size cap: 64 KiB per file. Files larger than that are truncated with a "(truncated at N
 * KiB)" marker. The original `@path` token stays in the user's text so the LLM sees what
 * the user actually typed.
 *
 * Construct mapping notes:
 * - `tokio::fs::read_to_string` → `node:fs/promises` `readFile(..., "utf-8")` (RULEBOOK §2.3).
 * - `(String, Vec<PathBuf>)` tuple → named-field object; `PathBuf` → `string` (§2.1).
 * - Rust `str` byte length drives the 64 KiB cap, so the cap is measured on UTF-8 bytes here
 *   too (a JS `.length` check would count UTF-16 code units and cap multi-byte text early).
 * - `chars()` iteration → `Array.from` (code points, not UTF-16 units), and the Unicode
 *   `char::is_whitespace` / `char::is_alphanumeric` predicates are spelled out below because
 *   JavaScript's `\s` is neither a superset nor a subset of Unicode `White_Space`.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { formatOsError } from "./core/tools/os-error.ts";

/** mentions.rs:22 -- per-file cap, in UTF-8 bytes. */
export const MAX_BYTES = 64 * 1024;

/** Result of {@link expand}: the rewritten prompt plus the paths that were read successfully. */
export interface ExpandedMentions {
	/** The prompt the model sees: attachment header + the user's original text, verbatim. */
	prompt: string;
	/**
	 * mentions.rs:48 -- absolute paths of the files that were read. Unreadable mentions are
	 * omitted (they only produce an error block). All three oracle call sites
	 * (`ui/mod.rs:975,2107`, `ui/web.rs:423`) discard this list; it is kept for fidelity.
	 */
	resolvedPaths: string[];
}

/**
 * mentions.rs:26-61 -- returns `(rewritten_prompt, resolved_paths)`. If `input` has no
 * `@<path>` tokens, the rewritten prompt is the original and `resolvedPaths` is empty.
 */
export async function expand(input: string, cwd: string): Promise<ExpandedMentions> {
	const mentions = extractMentions(input);
	if (mentions.length === 0) {
		return { prompt: input, resolvedPaths: [] };
	}

	const blocks: string[] = [];
	const resolvedPaths: string[] = [];

	for (const rel of mentions) {
		// mentions.rs:34 -- Rust's `Path::join` lets an absolute `rel` replace `cwd` entirely,
		// which `node:path` `join` would not do; `isAbsolute` reproduces that. (Node normalizes
		// `.`/`..` segments where Rust keeps them verbatim -- a textual difference confined to
		// `resolvedPaths`, since the block header prints the raw mention, not the joined path.)
		const path = isAbsolute(rel) ? rel : join(cwd, rel);
		let text: string;
		try {
			// TODO(port): `read_to_string` rejects invalid UTF-8 with an error (producing the error
			// block below), while Node substitutes U+FFFD and succeeds. Reproducing the Rust
			// behaviour would mean reading bytes and validating them.
			//
			// The original justification for leaving it — "the oracle's message text is
			// unreproducible anyway" — is void as of phase 19: `formatOsError` reproduces it, and
			// the catch block below now does. What remains is a real, still-open divergence: on
			// invalid UTF-8 oracle emits an error block and this port emits the file with U+FFFD
			// substitutions. Still deferred, but no longer excused.
			text = await readFile(path, "utf-8");
		} catch (error) {
			// mentions.rs:50-56 -- unreadable mentions become a self-closing block and are absent
			// from `resolved`. The `{e}` interpolation is `std::io::Error`'s Display.
			//
			// This comment used to claim that Display was "not reproducible verbatim" from Node, and
			// emitted Node's raw `ENOENT: ... open '<path>'` instead. The claim was wrong, and it
			// mattered: this string goes into a `<file error="...">` block that is fed to the model,
			// so the model was reading a different sentence than it reads under oracle.
			// `formatOsError` (core/tools/os-error.ts, phase 19) recovers both halves -- the errno
			// from `err.errno`, the glibc sentence from a code table -- so the wording now matches.
			const message = formatOsError(error);
			blocks.push(`<file path="${rel}" error="${message}" />`);
			continue;
		}

		const { body, truncated } = truncate(text);
		blocks.push(
			truncated
				? `<file path="${rel}">\n${body}\n\n(truncated at ${MAX_BYTES / 1024} KiB)\n</file>`
				: `<file path="${rel}">\n${body}\n</file>`,
		);
		resolvedPaths.push(path);
	}

	// mentions.rs:59-60 -- the header is prepended; the user's text (including the raw `@path`
	// tokens) is preserved unchanged after it.
	const header = `Files in context:\n${blocks.join("\n")}\n\n`;
	return { prompt: `${header}${input}`, resolvedPaths };
}

/**
 * Rust's `char::is_whitespace` is exactly the Unicode `White_Space` property, so the property
 * escape is used rather than JS `\s` (which omits U+0085 NEL and adds U+FEFF).
 */
const WHITESPACE = /^\p{White_Space}$/u;

/** Rust `char::is_alphanumeric` = `is_alphabetic() || is_numeric()` = Alphabetic union general category N. */
const ALPHANUMERIC = /^[\p{Alphabetic}\p{N}]$/u;

/** mentions.rs:85 -- characters that terminate a mention path. */
const MENTION_TERMINATORS = new Set([";", ",", "(", ")", '"', "'", "`"]);

/** mentions.rs:93 -- trailing punctuation stripped from a mention (likely sentence punctuation). */
const TRAILING_PUNCTUATION = new Set([".", "!", "?", ":"]);

/**
 * mentions.rs:65-101 -- scan for `@<path>` tokens. Stops a path at whitespace, semicolon,
 * comma, parenthesis, or quote. Leading punctuation around the `@` (e.g. wrapping in parens)
 * is fine. Duplicates are not collapsed: `@a @a` yields two mentions, hence two blocks.
 */
export function extractMentions(input: string): string[] {
	const out: string[] = [];
	const chars = Array.from(input);
	let i = 0;

	while (i < chars.length) {
		if (chars[i] !== "@") {
			i += 1;
			continue;
		}

		// mentions.rs:74-81 -- `@` must be at a word boundary, not mid-email-address.
		if (i > 0) {
			const prev = chars[i - 1];
			if (ALPHANUMERIC.test(prev) || prev === "_" || prev === ".") {
				i += 1;
				continue;
			}
		}

		let j = i + 1;
		while (j < chars.length) {
			const c = chars[j];
			if (WHITESPACE.test(c) || MENTION_TERMINATORS.has(c)) {
				break;
			}
			j += 1;
		}

		if (j > i + 1) {
			// mentions.rs:93 -- `trim_end_matches` strips every trailing occurrence, not just one.
			let end = j;
			while (end > i + 1 && TRAILING_PUNCTUATION.has(chars[end - 1])) {
				end -= 1;
			}
			const path = chars.slice(i + 1, end).join("");
			if (path.length > 0) {
				out.push(path);
			}
		}

		i = j;
	}

	return out;
}

/**
 * mentions.rs:103-113 -- cap at {@link MAX_BYTES} UTF-8 bytes, backing off to a character
 * boundary (Rust's `is_char_boundary` loop; a UTF-8 continuation byte is `0b10xxxxxx`).
 */
function truncate(text: string): { body: string; truncated: boolean } {
	const bytes = new TextEncoder().encode(text);
	if (bytes.length <= MAX_BYTES) {
		return { body: text, truncated: false };
	}
	let end = MAX_BYTES;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
		end -= 1;
	}
	return { body: new TextDecoder().decode(bytes.subarray(0, end)), truncated: true };
}
