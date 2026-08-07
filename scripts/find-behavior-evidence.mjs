#!/usr/bin/env node
/**
 * Finds candidate evidence. This is not a gate; it is a tool that saves a person time.
 *
 * ## Why it exists
 *
 * Calibration tried six different strategies for finding which assertion here covers a
 * given upstream function, and every one of them traded false positives for false
 * negatives. Thirty verdicts took roughly forty-five rounds of manual searching; the
 * remaining two hundred and fifty would have taken several hundred more.
 *
 * This script encodes what those six attempts taught, produces candidates for a whole
 * batch at once, and leaves a person only the verification. It deliberately does **not**
 * write the evidence table: deciding which candidate is real is the part that needs
 * judgement.
 *
 * ## What it does
 *
 * For each function in a batch that has no verdict yet:
 *
 * 1. Map the upstream file to the implementation file here.
 * 2. Read the **real** exported symbol name out of that file. Deriving the name by
 *    converting the case failed on more than five of thirty samples, so it is read,
 *    not guessed.
 * 3. Search the whole test corpus for a call to that symbol, then take the nearest
 *    assertion after it. Real tests call on one line and assert on another, so
 *    searching a single line misses most of them.
 * 4. Accept both assertion styles used here. An earlier filter accepted only one and
 *    nearly caused a redundant test to be written for something already covered.
 * 5. Compute an anchor for each candidate and note whether it is unique in the file.
 *    Line numbers drift when the formatter runs or when content is added; the anchor
 *    is what lets the gate relocate the assertion.
 *
 * ## Usage
 *
 *   node scripts/find-behavior-evidence.mjs A            # human-readable
 *   node scripts/find-behavior-evidence.mjs A --tsv      # rows to paste after verifying
 *
 * **Nothing from `--tsv` may be committed unverified.** It offers the most likely
 * candidate, and calibration produced real false positives: one matched a constructor
 * mentioned in a comment, another matched a same-named method on an unrelated object.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROSTER = join(repoRoot, "migration/reviews/phase22/roster.tsv");
const EVIDENCE = join(repoRoot, "migration/reviews/phase22/evidence.tsv");
const MANIFEST = join(repoRoot, "migration/manifest.tsv");

const TEST_DIRS = [
	"packages/ai/test",
	"packages/agent/test",
	"packages/coding-agent/test",
	"packages/mcp/test",
	"packages/tui/test",
];

/** Accepts both assertion styles used in this repository. */
const ASSERTION = /\bexpect\(|\bassert\b/;

/** How many lines may sit between the call and the assertion. Twelve was enough in practice. */
const ASSERTION_WINDOW = 12;

function walk(dir, ext, acc = []) {
	let entries = [];
	try {
		entries = readdirSync(dir).sort();
	} catch {
		return acc;
	}
	for (const name of entries) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) walk(p, ext, acc);
		else if (p.endsWith(ext)) acc.push(p);
	}
	return acc;
}

function escapeRe(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function camel(snake) {
	const parts = snake.replace(/_+$/, "").split("_");
	return (
		parts[0] +
		parts
			.slice(1)
			.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
			.join("")
	);
}

// ── Load ──────────────────────────────────────────────────────────────────────

const batch = process.argv[2];
if (!batch) {
	console.error("usage: node scripts/find-behavior-evidence.mjs <A|B|C|D|E1|E2> [--tsv]");
	process.exit(1);
}
const asTsv = process.argv.includes("--tsv");

const roster = readFileSync(ROSTER, "utf-8")
	.trim()
	.split("\n")
	.slice(1)
	.map((l) => l.split("\t"))
	.map(([oracleFile, fnName, oracleLine, source, ruleHit, b]) => ({
		oracleFile,
		fnName,
		oracleLine,
		source,
		ruleHit,
		batch: b,
		key: `${oracleFile}::${fnName}@${oracleLine}`,
	}));

const adjudicated = new Set(
	existsSync(EVIDENCE)
		? readFileSync(EVIDENCE, "utf-8")
				.trim()
				.split("\n")
				.slice(1)
				.map((l) => l.split("\t")[0])
		: [],
);

const pending = roster.filter((r) => r.batch === batch && !adjudicated.has(r.key));

// upstream file to implementation file
const implByOracle = new Map();
for (const line of readFileSync(MANIFEST, "utf-8").trim().split("\n").slice(1)) {
	const f = line.split("\t");
	const src = f[1]?.replace("crates/", "");
	if (f[3] && f[3] !== "-") {
		if (!implByOracle.has(src)) implByOracle.set(src, []);
		implByOracle.get(src).push(f[3]);
	}
}

const corpus = [];
for (const d of TEST_DIRS) {
	for (const p of walk(join(repoRoot, d), ".ts")) {
		corpus.push({ path: p.replace(`${repoRoot}/`, ""), lines: readFileSync(p, "utf-8").split("\n") });
	}
}

/**
 * The real exported symbol name. Looks for a definition in the implementation file and
 * falls back to a derived name marked DERIVED, as a reminder that it is a guess and often
 * wrong — case conversion failed on more than five of thirty samples.
 */
function resolveSymbol(oracleFile, fnName) {
	const candidates = [camel(fnName), fnName];
	for (const impl of implByOracle.get(oracleFile) ?? []) {
		const abs = join(repoRoot, impl);
		if (!existsSync(abs)) continue;
		const text = readFileSync(abs, "utf-8");
		for (const c of candidates) {
			if (new RegExp(`\\b(?:export\\s+)?(?:async\\s+)?(?:function|class|const)\\s+${escapeRe(c)}\\b`).test(text)) {
				return { symbol: c, impl, confident: true };
			}
			if (new RegExp(`^\\s*(?:async\\s+)?${escapeRe(c)}\\s*[(<]`, "m").test(text)) {
				return { symbol: c, impl, confident: true }; // a class method
			}
		}
	}
	return { symbol: camel(fnName), impl: (implByOracle.get(oracleFile) ?? [])[0] ?? "?", confident: false };
}

/** A call site plus the nearest assertion after it. A line holding both counts directly. */
function findCandidates(symbol, implPath) {
	const callPat = new RegExp(`(?:\\.|\\b)${escapeRe(symbol)}\\s*\\(`);
	const implStem = implPath && implPath !== "?" ? basename(implPath, ".ts") : "";
	const out = [];
	for (const { path, lines } of corpus) {
		const importsImpl =
			implStem !== "" && new RegExp(`from\\s+["'][^"']*${escapeRe(implStem)}(\\.ts)?["']`).test(lines.join("\n"));
		for (let i = 0; i < lines.length; i++) {
			if (!callPat.test(lines[i])) continue;
			if (ASSERTION.test(lines[i])) {
				out.push({ path, line: i + 1, text: lines[i].trim(), via: "same-line", importsImpl });
				continue;
			}
			for (let j = i + 1; j < Math.min(i + 1 + ASSERTION_WINDOW, lines.length); j++) {
				if (/^\s*(it|test|describe)\s*\(/.test(lines[j])) break;
				if (ASSERTION.test(lines[j])) {
					out.push({ path, line: j + 1, text: lines[j].trim(), via: `call@${i + 1}`, importsImpl });
					break;
				}
			}
		}
	}
	// Files that import the implementation come first: they are the most likely to test it
	out.sort((a, b) => Number(b.importsImpl) - Number(a.importsImpl));
	return out;
}

function anchorUniqueness(path, anchorText) {
	const file = corpus.find((c) => c.path === path);
	if (!file) return 0;
	return file.lines.filter((t) => t.includes(anchorText) && ASSERTION.test(t)).length;
}

// ── Output ────────────────────────────────────────────────────────────────────

let withCandidates = 0;
const tsvLines = [];

for (const r of pending) {
	const { symbol, impl, confident } = resolveSymbol(r.oracleFile, r.fnName);
	const cands = findCandidates(symbol, impl);
	if (cands.length > 0) withCandidates++;

	if (asTsv) {
		const best = cands[0];
		if (best) {
			const anchor = best.text.slice(0, 60);
			const uniq = anchorUniqueness(best.path, anchor);
			tsvLines.push(
				`${r.key}\texisting-test\t${best.path}:${best.line}\t${anchor}\t# ${symbol}${confident ? "" : " (DERIVED)"} · ${cands.length} candidates`,
			);
		} else {
			tsvLines.push(`${r.key}\t?\t?\t?\t# ${symbol}${confident ? "" : " (DERIVED)"} · no candidate, needs new-test or not-portable`);
		}
		continue;
	}

	const flag = confident ? "" : "  (name is derived)";
	console.log(`\n${cands.length > 0 ? "✓" : "—"} ${r.key}`);
	console.log(`    symbol: ${symbol}${flag}   implementation: ${impl}   [${r.source}/${r.ruleHit}]`);
	for (const c of cands.slice(0, 3)) {
		const uniq = anchorUniqueness(c.path, c.text.slice(0, 60));
		console.log(`      ${c.path}:${c.line} [${c.via}]${c.importsImpl ? " (imports the implementation)" : ""} anchor x${uniq}`);
		console.log(`        ${c.text.slice(0, 110)}`);
	}
	if (cands.length > 3) console.log(`      … ${cands.length - 3} more candidates`);
}

if (asTsv) {
	console.log(tsvLines.join("\n"));
} else {
	console.log(
		`\nbatch ${batch}: ${pending.length} awaiting a verdict — ${withCandidates} with a candidate, ${pending.length - withCandidates} without`,
	);
	console.log("Every candidate needs checking by hand. Calibration produced real false positives.");
}
