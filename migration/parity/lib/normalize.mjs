#!/usr/bin/env node
// normalize.mjs — reduces the output of both sides to a comparable form. stdin to stdout.
// What it masks: UUIDs and UUIDv7s, ISO timestamps, epoch numbers, durations, absolute paths, ANSI
// sequences, port numbers, and version-dependent noise.
// JSON lines (NDJSON and JSONL) are normalised structurally: key order is made stable, and NaN and
// ±Infinity are stringified explicitly, because JSON.stringify turns them into null, which would
// make the referee report a false green or a false red.
import { createInterface } from "node:readline";

const HOME = process.env.PARITY_HOME_A || "";
const HOME2 = process.env.PARITY_HOME_B || "";
const PORT = process.env.PARITY_PORT || "";

function normScalar(v) {
  if (typeof v === "number") {
    if (Number.isNaN(v)) return "__NaN__";
    if (v === Infinity) return "__Inf__";
    if (v === -Infinity) return "__-Inf__";
    if ((v >= 1.6e9 && v < 2.1e9) || (v >= 1.6e12 && v < 2.1e12)) return "<EPOCH>"; // unix s/ms 2020s-2030s
    return v;
  }
  if (typeof v === "string") return normText(v);
  return v;
}
function sortKeys(x) {
  if (Array.isArray(x)) return x.map(sortKeys);
  if (x && typeof x === "object") {
    const o = {};
    for (const k of Object.keys(x).sort()) o[k] = sortKeys(normScalar(x[k]));
    return o;
  }
  return normScalar(x);
}
function normText(s) {
  let t = s;
  t = t.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");           // ANSI CSI
  t = t.replace(/\x1b\][^\x07]*\x07/g, "");                 // OSC
  t = t.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<UUID>");
  t = t.replace(/\b0[0-9a-z]{24,31}\b/g, "<ID>");           // uuidv7-ish base36/hex ids
  t = t.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, "<TS>");
  t = t.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}\b/g, "<TS>");                 // minute-precision TUI logs
  t = t.replace(/\bcron-[0-9a-f]{32}\b/g, "cron-<ID>");
  t = t.replace(/\btrigger-[0-9a-f]{16,32}\b/g, "trigger-<ID>");
  t = t.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{2,4}\b(?!-)/g, "<ID>");          // uuidv7 short prefixes (log names, session list)
  t = t.replace(/\b1[6-9]\d{8,11}\b/g, "<EPOCH>");          // epoch s/ms 2020s-2030s
  t = t.replace(/\b\d+(\.\d+)?\s*(ms|s|secs?|seconds)\b/g, "<DUR>");
	// The details in a JSON parser's own error are an artifact of the runtime rather than pie behavior:
	// serde_json says "EOF while parsing a string at line 1 column 528" where V8's JSON.parse says
	// "Unterminated string in JSON at position 527". The two can never agree verbatim.
	// Only the detail after the colon is collapsed; the "invalid entry: " prefix and the "Error: "
	// before it are kept, so nothing is lost: raising no error at all, getting the prefix wrong, or an
	// empty detail all still go red. See ED15.
  t = t.replace(/(invalid entry: ).+$/, "$1<PARSE-DETAIL>");
  if (HOME) t = t.split(HOME).join("<HOME>");
  if (HOME2) t = t.split(HOME2).join("<HOME>");
  t = t.replace(/\/tmp\/[A-Za-z0-9._\/-]*parity[A-Za-z0-9._\/-]*/g, "<TMP>");
  if (PORT) t = t.replace(new RegExp("\\b" + PORT + "\\b", "g"), "<PORT>");
  t = t.replace(/127\.0\.0\.1:\d{4,5}/g, "127.0.0.1:<PORT>");
  return t;
}
// A JSON line is **expanded across several lines** on output (phase 18). The motive is not
// readability but discriminating power: a 22KB single-line request body can only report "DIFF: 1"
// under a line-by-line diff, so the intentional divergence declared in phase 18 would redden that
// line permanently — and any further regression on the same line (the 25 tool schemas and the
// system prompt, exactly where the heaviest bug of phase 17 lived) would be indistinguishable from
// the declared one. Expanded, each field takes a line of its own: the declared item occupies one
// line, and any other regression takes its own. This **raises** sensitivity rather than lowering it,
// and the evidence is the accompanying `run-parity.sh --self-check`, which re-runs the M1, M2 and M3
// mutation detections. Key order is already normalised by sortKeys, so expanding introduces no new
// order sensitivity.
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const out = [];
for await (const line of rl) {
  const s = line;
  let handled = false;
  const trimmed = s.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const obj = JSON.parse(trimmed);
      for (const l of JSON.stringify(sortKeys(obj), null, 1).split("\n")) out.push(l);
      handled = true;
    } catch { /* not json */ }
  }
  if (!handled) out.push(normText(s).replace(/[ \t]+$/, ""));
}
process.stdout.write(out.join("\n") + "\n");
