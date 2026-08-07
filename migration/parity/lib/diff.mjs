#!/usr/bin/env node
// diff.mjs A B — a line-by-line diff of already-normalised input. Identical exits 0; different
// prints the diff count and the first 40 differing lines, then exits 1.
//
// phase 18: changed from **aligning by index** to aligning by LCS. The reason is that the same phase
// expanded normalize.mjs's JSON lines across several lines — and with index alignment, one
// structural insertion (one extra tool, one extra field) shifts every line after it, inflating one
// real difference into hundreds and leaving the reader nothing but noise. LCS reports only the lines
// genuinely added, removed or changed.
// This is not a loosening: under LCS, DIFF: 0 holds exactly when the two files agree line for line,
// so the strength of the judgment is unchanged.
import { readFileSync } from "node:fs";

const [a, b] = process.argv.slice(2);
const A = readFileSync(a, "utf8").split("\n");
const B = readFileSync(b, "utf8").split("\n");

// The common prefix and suffix are stripped first: normalised output usually differs only on a few
// lines in the middle, so after stripping, the LCS is typically tens of lines and there is no need
// to run an O(n*m) DP over a .norm file of tens of thousands.
let lo = 0;
while (lo < A.length && lo < B.length && A[lo] === B[lo]) lo++;
let hiA = A.length - 1;
let hiB = B.length - 1;
while (hiA >= lo && hiB >= lo && A[hiA] === B[hiB]) { hiA--; hiB--; }

const midA = A.slice(lo, hiA + 1);
const midB = B.slice(lo, hiB + 1);

const MAX_CELLS = 4_000_000;
const diffs = [];
if (midA.length * midB.length > MAX_CELLS) {
	// If the middle is too large, fall back to aligning by index — still correct, only harder to
	// read — so the DP cannot exhaust memory.
  const n = Math.max(midA.length, midB.length);
  for (let i = 0; i < n; i++) {
    if ((midA[i] ?? "<EOF>") !== (midB[i] ?? "<EOF>")) {
      diffs.push(`@${lo + i + 1}\n- ${midA[i] ?? "<EOF>"}\n+ ${midB[i] ?? "<EOF>"}`);
    }
  }
} else {
  const m = midA.length;
  const n = midB.length;
  const dp = new Int32Array((m + 1) * (n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i * (n + 1) + j] =
        midA[i] === midB[j]
          ? dp[(i + 1) * (n + 1) + (j + 1)] + 1
          : Math.max(dp[(i + 1) * (n + 1) + j], dp[i * (n + 1) + (j + 1)]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (midA[i] === midB[j]) { i++; j++; continue; }
    if (dp[(i + 1) * (n + 1) + j] >= dp[i * (n + 1) + (j + 1)]) {
      diffs.push(`@${lo + i + 1}\n- ${midA[i]}`);
      i++;
    } else {
      diffs.push(`@${lo + i + 1}\n+ ${midB[j]}`);
      j++;
    }
  }
  while (i < m) { diffs.push(`@${lo + i + 1}\n- ${midA[i]}`); i++; }
  while (j < n) { diffs.push(`@${lo + i + 1}\n+ ${midB[j]}`); j++; }
}

if (diffs.length === 0) { console.log("DIFF: 0"); process.exit(0); }
console.log(`DIFF: ${diffs.length}`);
console.log(diffs.slice(0, 40).join("\n"));
process.exit(1);
