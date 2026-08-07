import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
function norm(input, env = {}) {
  return execFileSync("node", [join(here, "normalize.mjs")], { input, env: { ...process.env, ...env } }).toString();
}
// From phase 18 a JSON line is expanded across several lines; normalize.mjs's comment explains what
// that buys in discriminating power. These cases assert the **normalisation semantics** — key order
// and scalar substitution — rather than the layout, so the output is folded back to a compact form
// before comparing.
function normCompact(input, env = {}) {
  return JSON.stringify(JSON.parse(norm(input, env)));
}
test("NaN/Infinity survive JSON normalization distinctly (referee-bug guard)", () => {
	// JSON.parse never produces NaN, but if something upstream writes an invalid JSON line it is handled
	// as text; numbers inside an object keep their order through sortKeys
  const out = normCompact('{"b":1,"a":{"y":2,"x":3}}\n');
  assert.strictEqual(out, '{"a":{"x":3,"y":2},"b":1}');
});
test("null stays null, not confused with missing/NaN", () => {
  const out = normCompact('{"a":null}\n');
  assert.strictEqual(out, '{"a":null}');
});
test("timestamps, uuids, ansi, durations normalized in text", () => {
  const out = norm("\x1b[31m2026-08-03T05:00:00Z id=0198a3f2-1111-7abc-9def-0123456789ab took 12ms\x1b[0m\n");
  assert.match(out, /<TS> id=<UUID> took <DUR>/);
});
test("home paths normalized", () => {
  const out = norm("saved /x/parityhome/a.json\n", { PARITY_HOME_A: "/x/parityhome" });
  assert.match(out, /<HOME>\/a\.json/);
});
test("epoch numbers inside JSON normalized", () => {
  const out = normCompact('{"t":1785742226251,"small":190,"s":1785742226}\n');
  assert.strictEqual(out, '{"s":"<EPOCH>","small":190,"t":"<EPOCH>"}');
});
test("minute-precision timestamps, cron ids, uuid7 short prefixes, trailing ws", () => {
  const out = norm("2026-08-03 07:30 x cron-de51bea13b0a4c38ba77595916d38a10 019fc688-9f2c-77  \n");
  assert.strictEqual(out.trim(), "<TS> x cron-<ID> <ID>");
});
test("json key order is canonicalized (deep)", () => {
  const a = norm('{"z":{"b":1,"a":2},"m":[{"d":4,"c":3}]}\n');
  const b = norm('{"m":[{"c":3,"d":4}],"z":{"a":2,"b":1}}\n');
  assert.strictEqual(a, b);
});
test("invalid-entry parser detail collapses across runtimes but keeps discriminating power", () => {
	// The real wording on each side: serde_json upstream against V8's JSON.parse here
  const rust = norm("Error: invalid entry: EOF while parsing a string at line 1 column 528\n");
  const v8 = norm("Error: invalid entry: Unterminated string in JSON at position 527\n");
	assert.strictEqual(rust, v8, "the same failure mode has to normalise to the same line on both runtimes");
  assert.strictEqual(rust.trim(), "Error: invalid entry: <PARSE-DETAIL>");
	// Discriminating power: these three real regressions still have to show up in the diff
	assert.notStrictEqual(norm("Error: corrupted entry: whatever\n"), rust, "a wrong prefix has to go red");
	assert.notStrictEqual(norm("invalid entry: EOF while parsing\n"), rust, "losing 'Error: ' has to go red");
	assert.notStrictEqual(norm("\n"), rust, "raising no error at all has to go red");
	// An empty detail, with nothing after "invalid entry: ", must not collapse onto the same line
	assert.notStrictEqual(norm("Error: invalid entry: \n"), rust, "an empty detail has to go red");
});

test("a JSON line expands across lines: one field per line, so the granularity is no longer the whole line (phase 18)", () => {
	// The motive is discriminating power rather than readability: a 22KB single-line request body can
	// only report DIFF 1 under a line-by-line diff, the declared intentional divergence reddens that
	// line permanently, and any other regression on it becomes invisible.
  const body = '{"model":"gpt-5.2","tools":[{"name":"A","description":"aaa"},{"name":"B","description":"bbb"}]}';
  const out = norm(body + "\n");
  const lines = out.trimEnd().split("\n");
	assert.ok(lines.length > 5, `expected several lines, got ${lines.length}`);
	// The two tools' descriptions have to land on **different** lines — that is the mechanism by which
	// changing A does not mask a regression in B.
  const aLine = lines.findIndex((l) => l.includes('"aaa"'));
  const bLine = lines.findIndex((l) => l.includes('"bbb"'));
	assert.ok(aLine >= 0 && bLine >= 0 && aLine !== bLine, "each description has to occupy its own line");
	// Expanding must not change the semantics: folded back to a compact form it is exactly what sortKeys
	// produces, with key order normalised and therefore different from the original.
  assert.strictEqual(
    JSON.stringify(JSON.parse(out)),
    '{"model":"gpt-5.2","tools":[{"description":"aaa","name":"A"},{"description":"bbb","name":"B"}]}',
  );
});

test("a non-JSON line is unaffected by the expansion", () => {
  const out = norm("plain text line\nanother\n");
  assert.strictEqual(out.trimEnd(), "plain text line\nanother");
});
