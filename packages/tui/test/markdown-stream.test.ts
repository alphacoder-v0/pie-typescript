import assert from "node:assert";
import { describe, it } from "node:test";
import { renderMarkdownLine, STREAM_ANSI, StreamingMarkdownRenderer } from "../src/components/markdown.ts";

// Ported from the oracle's own `#[cfg(test)] mod tests`
// (pie crates/coding-agent/src/markdown.rs:142-196), plus characterization tests that pin the
// module's undocumented edges. Assertions from the six oracle tests are reproduced at their
// original strength; the extra tests only add pins, they never relax one.

const { RESET, BOLD, ITALIC, DIM, CODE, HEADING } = STREAM_ANSI;

describe("markdown.rs streaming renderer (oracle #[cfg(test)] ports)", () => {
	// pie: markdown.rs:146-154
	it("bold_inline_emits_ansi", () => {
		const s = renderMarkdownLine("hello **world**!");
		assert.ok(s.includes("\x1b[1m"));
		assert.ok(s.includes("world"));
		assert.ok(s.includes("\x1b[0m"));
		// No raw `**` left.
		assert.ok(!s.includes("**"));
	});

	// pie: markdown.rs:156-161
	it("italic_inline_emits_ansi", () => {
		const s = renderMarkdownLine("an *italic* word");
		assert.ok(s.includes("\x1b[3m"));
		assert.ok(s.includes("italic"));
	});

	// pie: markdown.rs:163-169
	it("code_inline_emits_ansi", () => {
		const s = renderMarkdownLine("call `foo()`");
		assert.ok(s.includes(CODE));
		assert.ok(s.includes("foo()"));
		assert.ok(!s.includes("`"));
	});

	// pie: markdown.rs:171-176
	it("heading_marked", () => {
		const s = renderMarkdownLine("## Section");
		assert.ok(s.includes(HEADING));
		assert.ok(s.includes("Section"));
	});

	// pie: markdown.rs:178-189
	it("renderer_tracks_fence_across_lines", () => {
		const r = new StreamingMarkdownRenderer();
		const open = r.renderLine("```rust");
		assert.ok(open.includes(DIM));
		const body = r.renderLine("let x = 1;");
		assert.ok(body.includes(CODE));
		const close = r.renderLine("```");
		assert.ok(close.includes(DIM));
		const after = r.renderLine("plain text");
		assert.ok(!after.includes(CODE), `should exit fence: ${after}`);
	});

	// pie: markdown.rs:191-195
	it("unclosed_backtick_is_left_alone", () => {
		const s = renderMarkdownLine("partial `code");
		assert.strictEqual(s, "partial `code");
	});
});

describe("renderMarkdownLine — exact output (pie markdown.rs:20-81)", () => {
	it("emits the oracle's exact byte sequence for bold, italic and code spans", () => {
		assert.strictEqual(renderMarkdownLine("hello **world**!"), `hello ${BOLD}world${RESET}!`);
		assert.strictEqual(renderMarkdownLine("an *italic* word"), `an ${ITALIC}italic${RESET} word`);
		assert.strictEqual(renderMarkdownLine("call `foo()`"), `call ${CODE}foo()${RESET}`);
	});

	it("uses the oracle's SGR literals verbatim", () => {
		assert.strictEqual(RESET, "\x1b[0m");
		assert.strictEqual(BOLD, "\x1b[1m");
		assert.strictEqual(ITALIC, "\x1b[3m");
		assert.strictEqual(DIM, "\x1b[2m");
		assert.strictEqual(CODE, "\x1b[2;36m"); // dim cyan
		assert.strictEqual(HEADING, "\x1b[1;34m"); // bold blue
	});

	it("passes plain text through unchanged", () => {
		assert.strictEqual(renderMarkdownLine("just some text"), "just some text");
	});

	it("returns an empty string for an empty line", () => {
		assert.strictEqual(renderMarkdownLine(""), "");
	});

	it("leaves a whitespace-only line untouched", () => {
		assert.strictEqual(renderMarkdownLine("   "), "   ");
	});

	// pie: markdown.rs:47-56 — the code pass runs before the bold and italic passes.
	it("gives code spans priority over emphasis inside them", () => {
		assert.strictEqual(renderMarkdownLine("`**x**`"), `${CODE}**x**${RESET}`);
	});

	// pie: markdown.rs:5-6 — "no nested emphasis precedence". The bold body is copied verbatim.
	it("does not render inline spans nested inside bold", () => {
		assert.strictEqual(renderMarkdownLine("**a `b` c**"), `${BOLD}a \`b\` c${RESET}`);
	});

	// pie: markdown.rs:49 — `find_byte` matches the immediately following backtick.
	it("renders an empty code span for a bare double backtick", () => {
		assert.strictEqual(renderMarkdownLine("``"), `${CODE}${RESET}`);
	});

	// pie: markdown.rs:68 — the `bytes[i + 1] != b' '` guard keeps list bullets literal.
	it("does not treat a list bullet as the start of an italic span", () => {
		assert.strictEqual(renderMarkdownLine("* item"), "* item");
		assert.strictEqual(renderMarkdownLine("* a * b"), "* a * b");
	});

	// pie: markdown.rs:58-76 — both star passes need a follower byte, so a trailing `*` is literal.
	it("leaves unmatched stars alone", () => {
		assert.strictEqual(renderMarkdownLine("a*"), "a*");
		assert.strictEqual(renderMarkdownLine("**"), "**");
		assert.strictEqual(renderMarkdownLine("**bold"), "**bold");
		assert.strictEqual(renderMarkdownLine("*ital"), "*ital");
	});

	// pie: markdown.rs:98-112 — `find_single_star` skips over `**` pairs while hunting a lone `*`.
	it("skips `**` pairs when closing an italic span", () => {
		assert.strictEqual(renderMarkdownLine("*a**b*"), `${ITALIC}a**b${RESET}`);
	});
});

describe("renderMarkdownLine — headings (pie markdown.rs:20-40)", () => {
	// BUG-ish oracle behaviour, reproduced per RULEBOOK §0: markdown.rs:22-23 re-emits
	// `"#".repeat(level)` and then the body from byte `level + 1`, so the separating space is
	// swallowed. Asserted, not fixed.
	it("swallows the space between the hashes and the heading body", () => {
		assert.strictEqual(renderMarkdownLine("## Section"), `${HEADING}##Section${RESET}`);
		assert.strictEqual(renderMarkdownLine("# Title"), `${HEADING}#Title${RESET}`);
		assert.strictEqual(renderMarkdownLine("###### h6"), `${HEADING}######h6${RESET}`);
	});

	// pie: markdown.rs:21-24 — the heading body never reaches `render_inline`.
	it("leaves inline markup in a heading body unrendered", () => {
		assert.strictEqual(renderMarkdownLine("## a **b**"), `${HEADING}##a **b**${RESET}`);
	});

	it("renders an empty body for a hash run followed by nothing", () => {
		assert.strictEqual(renderMarkdownLine("# "), `${HEADING}#${RESET}`);
	});

	// pie: markdown.rs:33 — the `level <= 6` guard falls through to the `else` arm, returning None.
	it("does not treat seven or more hashes as a heading", () => {
		assert.strictEqual(renderMarkdownLine("####### x"), "####### x");
	});

	// pie: markdown.rs:30-38 — a hash run needs a following space, and the loop ending without one
	// returns None.
	it("does not treat a hash run without a following space as a heading", () => {
		assert.strictEqual(renderMarkdownLine("#Section"), "#Section");
		assert.strictEqual(renderMarkdownLine("#"), "#");
		assert.strictEqual(renderMarkdownLine("###"), "###");
	});

	// pie: markdown.rs:33 — `level > 0` rejects a leading space.
	it("does not treat an indented hash run as a heading", () => {
		assert.strictEqual(renderMarkdownLine(" # x"), " # x");
	});
});

describe("renderMarkdownLine — code point vs byte semantics", () => {
	// pie: markdown.rs:30 iterates `line.chars()` (Unicode scalars). Indexing UTF-16 code units
	// would split this astral character in half and mis-slice the body.
	it("counts heading hashes by code point, not UTF-16 code unit", () => {
		assert.strictEqual(renderMarkdownLine("# 😀 x"), `${HEADING}#😀 x${RESET}`);
	});

	// Faithful reproduction of the oracle wart at markdown.rs:77: `bytes[i] as char` is Rust's only
	// integer-to-char cast and widens Latin-1, so every non-ASCII UTF-8 byte outside an inline span
	// is re-encoded as its own scalar. Reproduced, not fixed, per RULEBOOK §0.
	it("mangles non-ASCII text outside inline spans into Latin-1 mojibake", () => {
		// "héllo" is 0x68 0xC3 0xA9 0x6C 0x6C 0x6F; each of 0xC3/0xA9 becomes its own scalar.
		assert.strictEqual(renderMarkdownLine("héllo"), "hÃ©llo");
		// "中" is 0xE4 0xB8 0xAD.
		assert.strictEqual(renderMarkdownLine("中"), "ä¸­");
	});

	// pie copies span bodies as `&str` slices (markdown.rs:51, 61, 71), so they escape the wart.
	it("preserves non-ASCII text inside code, bold and italic spans", () => {
		assert.strictEqual(renderMarkdownLine("`héllo`"), `${CODE}héllo${RESET}`);
		assert.strictEqual(renderMarkdownLine("**中文**"), `${BOLD}中文${RESET}`);
		assert.strictEqual(renderMarkdownLine("*中文*"), `${ITALIC}中文${RESET}`);
	});

	// pie: markdown.rs:22 slices the body by byte offset, bypassing the byte-by-byte push loop.
	it("preserves non-ASCII text in a heading body", () => {
		assert.strictEqual(renderMarkdownLine("## 中文"), `${HEADING}##中文${RESET}`);
	});
});

describe("StreamingMarkdownRenderer (pie markdown.rs:114-140)", () => {
	it("emits the oracle's exact byte sequences across a fenced block", () => {
		const r = new StreamingMarkdownRenderer();
		assert.strictEqual(r.renderLine("```rust"), `${DIM}\`\`\`rust${RESET}`);
		assert.strictEqual(r.renderLine("let x = 1;"), `${CODE}let x = 1;${RESET}`);
		assert.strictEqual(r.renderLine("```"), `${DIM}\`\`\`${RESET}`);
		assert.strictEqual(r.renderLine("plain text"), "plain text");
	});

	it("starts outside a fence", () => {
		const r = new StreamingMarkdownRenderer();
		assert.strictEqual(r.renderLine("**bold**"), `${BOLD}bold${RESET}`);
	});

	// pie: markdown.rs:129-131 — fence bodies bypass `render_line` entirely.
	it("does not render markdown inside a fence", () => {
		const r = new StreamingMarkdownRenderer();
		r.renderLine("```");
		assert.strictEqual(r.renderLine("# not a heading"), `${CODE}# not a heading${RESET}`);
		assert.strictEqual(r.renderLine("**not bold**"), `${CODE}**not bold**${RESET}`);
		assert.strictEqual(r.renderLine(""), `${CODE}${RESET}`);
	});

	// pie: markdown.rs:125-128 — the toggle is unconditional, so a "closing" fence carrying an info
	// string still flips state, and two fenced blocks in a row work out.
	it("toggles on any line starting with three backticks", () => {
		const r = new StreamingMarkdownRenderer();
		assert.strictEqual(r.renderLine("```a"), `${DIM}\`\`\`a${RESET}`);
		assert.strictEqual(r.renderLine("```b"), `${DIM}\`\`\`b${RESET}`);
		// Back outside the fence: markdown is rendered again.
		assert.strictEqual(r.renderLine("**bold**"), `${BOLD}bold${RESET}`);
	});

	// pie: markdown.rs:125 uses `starts_with` with no trimming.
	it("does not toggle on an indented fence", () => {
		const r = new StreamingMarkdownRenderer();
		// The indented fence falls through to the inline renderer instead of opening a block.
		assert.strictEqual(r.renderLine("  ```"), `  ${CODE}${RESET}\``);
		assert.strictEqual(r.renderLine("**bold**"), `${BOLD}bold${RESET}`);
	});

	it("keeps fence state per instance", () => {
		const a = new StreamingMarkdownRenderer();
		const b = new StreamingMarkdownRenderer();
		a.renderLine("```");
		assert.strictEqual(a.renderLine("x"), `${CODE}x${RESET}`);
		assert.strictEqual(b.renderLine("x"), "x");
	});
});
