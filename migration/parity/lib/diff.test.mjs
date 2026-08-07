// Self-tests for diff.mjs, added in phase 18 when the differ moved from aligning by index to aligning
// by LCS — and the differ itself had **no tests at all**, so the judge had been judging both sides
// with nobody judging it. Three things are pinned here: DIFF 0 holds exactly when the files agree
// line for line, so nothing is weakened; a structural insertion no longer cascades; and the exit-code
// convention.
import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

function diff(a, b) {
  const dir = mkdtempSync(join(tmpdir(), "parity-diff-"));
  try {
    const fa = join(dir, "a.txt");
    const fb = join(dir, "b.txt");
    writeFileSync(fa, a);
    writeFileSync(fb, b);
    try {
      const out = execFileSync("node", [join(here, "diff.mjs"), fa, fb]).toString();
      return { code: 0, out };
    } catch (e) {
      return { code: e.status, out: e.stdout.toString() };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("identical input gives DIFF: 0 and exit 0", () => {
  const s = "line1\nline2\nline3\n";
  const r = diff(s, s);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /^DIFF: 0/);
});

test("a one-line change gives DIFF: 2, one removal and one addition, and exit 1", () => {
  const r = diff("a\nb\nc\n", "a\nX\nc\n");
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /^DIFF: 2/);
  assert.match(r.out, /- b/);
  assert.match(r.out, /\+ X/);
});

test("a structural insertion does not cascade: inserting one line in the middle reports 1, not every line after it", () => {
	// This is the property that has to hold once JSON expands across lines. Aligning by index, the case
	// below would report 8 or more.
  const a = ["k1", "k2", "k3", "k4", "k5", "k6", "k7", "k8", "k9"].join("\n") + "\n";
  const b = ["k1", "k2", "INSERTED", "k3", "k4", "k5", "k6", "k7", "k8", "k9"].join("\n") + "\n";
  const r = diff(a, b);
  assert.strictEqual(r.code, 1);
	assert.match(r.out, /^DIFF: 1/, `an insertion should report 1; got: ${r.out.split("\n")[0]}`);
  assert.match(r.out, /\+ INSERTED/);
});

test("an expanded tool array: changing one tool's description reddens only that line, and a regression in another tool stays visible", () => {
	// This is the discriminating power that had to survive declaring an intentional divergence in phase
	// 18: the declared item occupies a fixed number of lines, any further regression in the same request
	// body takes its own, and the two can be told apart.
  const base =
    ["{", ' "tools": [', "  {", '   "description": "aaa",', '   "name": "A"', "  },",
     "  {", '   "description": "bbb",', '   "name": "B"', "  }", " ]", "}"].join("\n") + "\n";
  const declaredOnly = base.replace('"description": "aaa"', '"description": "aaa DECLARED"');
  const declaredPlusRegression = declaredOnly.replace('"description": "bbb"', '"description": "REGRESSED"');

  const r1 = diff(base, declaredOnly);
	assert.match(r1.out, /^DIFF: 2/, "the declared item alone: one removal and one addition");

  const r2 = diff(base, declaredPlusRegression);
	assert.match(r2.out, /^DIFF: 4/, "the declared item plus another regression: one more pair, and the two are distinguishable");
  assert.match(r2.out, /\+\s+"description": "REGRESSED",/);
});

test("extra lines at the end of a file are reported one by one, not swallowed", () => {
  const r = diff("a\nb\n", "a\nb\nc\nd\n");
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /\+ c/);
  assert.match(r.out, /\+ d/);
});
