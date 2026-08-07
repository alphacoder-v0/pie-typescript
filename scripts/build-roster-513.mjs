#!/usr/bin/env node
/**
 * Merges the evidence tables into one roster covering every public function upstream.
 *
 * Earlier rounds worked through those functions in groups, leaving the evidence in two
 *
 * | source | rows | key shape | columns |
 * |---|---|---|---|
 * | the high-tier table | 45 | file and name, **no line number** | 3, no anchor |
 * | `phase22/evidence.tsv` | 282 | `<file>::<fn>@<line>` | 4 |
 * | still to do | 186 | — | — |
 *
 * This script merges all three into one roster and one seeded evidence table, which turns
 * full coverage into something a gate can decide.
 *
 * ## Why the roster is rebuilt rather than concatenated
 *
 * The tier file covers only the functions that were tiered, and misses the ones the
 * surface-coverage gate reports as unmatched — those never entered any roster.
 * Concatenating would therefore produce the smaller number. So the roster is **rescanned
 * from the upstream source**, using **exactly** the same rules as the surface-coverage
 * gate: same pattern, same exclusion of test blocks and test directories. That is what
 * keeps the two totals in agreement.
 *
 * ## Line number assignment
 *
 * Same rule as the classifier: collect every line matching a name in the file, in order,
 * and hand them out to the first, second and so on. This is what lets the key tell two
 * same-named constructors apart.
 *
 * Usage:
 *   node scripts/build-roster-513.mjs --generate   write the roster and evidence tables
 *   node scripts/build-roster-513.mjs --verify     check only, write nothing
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(repoRoot, "migration/reviews/phase23");
const ROSTER_OUT = join(OUT_DIR, "roster.tsv");
const EVIDENCE_OUT = join(OUT_DIR, "evidence.tsv");
const HIGH_IN = join(repoRoot, "migration/reviews/phase21/high-tier-evidence.tsv");
const EV22_IN = join(repoRoot, "migration/reviews/phase22/evidence.tsv");
const ROSTER22_IN = join(repoRoot, "migration/reviews/phase22/roster.tsv");
const TIERS_IN = join(repoRoot, "migration/reviews/phase21/risk-tiers.tsv");

/** The total, pinned. Must equal what the surface-coverage gate scans. */
const ROSTER_SIZE = 513;
/** How many entries already carry evidence from earlier rounds. */
const SEED_EVIDENCE = 327;

/**
 * The values in `sources.env` contain shell variables and have to be expanded.
 * Same logic as the surface-coverage gate, whose comment records that treating them as
 * literal paths made it never find anything and always skip silently.
 */
function oracleDir() {
	const env = join(repoRoot, "migration/sources.env");
	if (!existsSync(env)) return null;
	const m = readFileSync(env, "utf-8").match(/^ORACLE_PIE_DIR=(.*)$/m);
	if (!m) return null;
	const dir = m[1]
		.replace(/^["']|["']$/g, "")
		.trim()
		.replace(/\$\{?(\w+)\}?/g, (_, name) => process.env[name] ?? "");
	return existsSync(dir) ? dir : null;
}

function* walk(dir, ext) {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) yield* walk(p, ext);
		else if (e.name.endsWith(ext)) yield p;
	}
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ── Scan the upstream public surface ─────────────────────────────────────────

/**
 * **Exactly** the same rules as the surface-coverage gate: skip test directories, drop
 * everything after a test block, accept only public functions at the start of a line.
 * Any deviation makes this script's total disagree with that gate's.
 */
function scanOraclePublicFns(oracle) {
	const out = [];
	for (const f of walk(join(oracle, "crates"), ".rs")) {
		if (f.includes("/tests/")) continue;
		const raw = readFileSync(f, "utf-8");
		const src = raw.replace(/#\[cfg\(test\)\][\s\S]*$/, "");
		const rel = f.replace(`${oracle}/crates/`, "");
		// Line numbers are counted in the original text, matching the classifier: same-named
		// functions get numbers in order of appearance
		const slots = new Map();
		for (const m of src.matchAll(/^\s*pub (?:async )?fn (\w+)/gm)) {
			const name = m[1];
			if (!slots.has(name)) {
				const re = new RegExp(`\\bfn\\s+${escapeRe(name)}\\b`);
				const ls = [];
				raw.split("\n").forEach((t, i) => { if (re.test(t)) ls.push(i + 1); });
				slots.set(name, { lines: ls, used: 0 });
			}
			const slot = slots.get(name);
			const line = slot.lines[slot.used] ?? slot.lines[slot.lines.length - 1] ?? 0;
			slot.used += 1;
			out.push({ oracleFile: rel, fnName: name, oracleLine: line });
		}
	}
	// Determinism: sort explicitly rather than trusting the filesystem walk order
	out.sort((a, b) =>
		a.oracleFile.localeCompare(b.oracleFile) ||
		a.fnName.localeCompare(b.fnName) ||
		a.oracleLine - b.oracleLine);
	return out;
}

// ── Batches ──────────────────────────────────────────────────────────────────

/**
 * Four batches are added here:
 *
 * - `U` — the functions the surface-coverage gate reports as unmatched. They never entered
 *   any roster, and they differ in kind from the ones a rule failed to select: those were
 *   missed by a selection rule, these are ones the gate itself says do not match by name.
 * - `F`, `G`, `H` — the low-tier functions no rule selected, split by upstream package.
 *   agent→F · coding-agent→G · ai+mcp→H。
 */
function batchOf(entry, tier) {
	if (tier === "unmatched") return "U";
	const pkg = entry.oracleFile.split("/")[0];
	if (pkg === "agent") return "F";
	if (pkg === "coding-agent") return "G";
	return "H";
}

// ── Main ─────────────────────────────────────────────────────────────────────

const oracle = oracleDir();
if (!oracle) {
	console.error("build-roster-513: no upstream checkout (migration/sources.env is missing or its path is invalid).");
	process.exit(1);
}

const all = scanOraclePublicFns(oracle);
if (all.length !== ROSTER_SIZE) {
	console.error(`build-roster-513: scanned ${all.length} public functions, pinned at ${ROSTER_SIZE}.`);
	console.error("  Either upstream drifted or the scan rules diverged from the surface-coverage gate. Both need an explanation.");
	process.exit(1);
}

const readTsv = (p) => readFileSync(p, "utf-8").trim().split("\n").slice(1).map((l) => l.split("\t"));
const high = readTsv(HIGH_IN);
const ev22 = readTsv(EV22_IN);
const tiers = new Map(readTsv(TIERS_IN).map((r) => [`${r[0]}::${r[1]}`, r[2]]));

// The high-tier keys carry no line number, so they get one here, in order of appearance.
const byNoLine = new Map();
for (const e of all) {
	const k = `${e.oracleFile}::${e.fnName}`;
	if (!byNoLine.has(k)) byNoLine.set(k, []);
	byNoLine.get(k).push(e);
}

const seeded = new Map();
const highUsed = new Map();
const highProblems = [];
for (const [k, kind, ev] of high) {
	const cands = byNoLine.get(k);
	if (!cands?.length) {
		highProblems.push(`high-tier entry ${k} is not in the upstream public surface`);
		continue;
	}
	const idx = highUsed.get(k) ?? 0;
	highUsed.set(k, idx + 1);
	const e = cands[Math.min(idx, cands.length - 1)];
	seeded.set(`${e.oracleFile}::${e.fnName}@${e.oracleLine}`, [kind, ev, ""]);
}
for (const r of ev22) seeded.set(r[0], [r[1], r[2], r[3] ?? ""]);

// ── Roster ───────────────────────────────────────────────────────────────────

const priorBatch = new Map();
for (const r of readTsv(ROSTER22_IN)) {
	priorBatch.set(`${r[0]}::${r[1]}@${r[2]}`, { source: r[3], ruleHit: r[4], batch: r[5] });
}

const rosterLines = ["oracle_file\tfn_name\toracle_line\tsource\trule_hit\tbatch"];
let nSeeded = 0;
for (const e of all) {
	const key = `${e.oracleFile}::${e.fnName}@${e.oracleLine}`;
	if (seeded.has(key)) nSeeded += 1;
	const prior = priorBatch.get(key);
	const tier = tiers.get(`${e.oracleFile}::${e.fnName}`) ?? "unmatched";
	const source = prior?.source ?? (tier === "unmatched" ? "unmatched" : tier);
	const ruleHit = prior?.ruleHit ?? "-";
	// Entries with existing high-tier evidence keep that batch; the rest are split by package
	const batch = prior?.batch ?? (seeded.has(key) ? "HIGH" : batchOf(e, tier));
	rosterLines.push(`${e.oracleFile}\t${e.fnName}\t${e.oracleLine}\t${source}\t${ruleHit}\t${batch}`);
}

if (nSeeded !== SEED_EVIDENCE) {
	console.error(`build-roster-513: ${nSeeded} entries carried evidence, expected ${SEED_EVIDENCE}.`);
	console.error("  The two tables use different key shapes, one with a line number and one without, which is where this usually goes wrong.");
	for (const p of highProblems) console.error(`    ${p}`);
	const rosterKeys = new Set(all.map((e) => `${e.oracleFile}::${e.fnName}@${e.oracleLine}`));
	for (const k of seeded.keys()) if (!rosterKeys.has(k)) console.error(`    evidence key not in the roster: ${k}`);
	process.exit(1);
}

// ── Evidence table ───────────────────────────────────────────────────────────

const evLines = ["fn_name\tevidence_kind\tevidence\tanchor"];
for (const e of all) {
	const key = `${e.oracleFile}::${e.fnName}@${e.oracleLine}`;
	const s = seeded.get(key);
	if (s) evLines.push(`${key}\t${s[0]}\t${s[1]}\t${s[2]}`);
}

// ── Output ───────────────────────────────────────────────────────────────────

const mode = process.argv[2] ?? "--verify";
if (mode === "--generate") {
	mkdirSync(OUT_DIR, { recursive: true });
	writeFileSync(ROSTER_OUT, `${rosterLines.join("\n")}\n`);
	writeFileSync(EVIDENCE_OUT, `${evLines.join("\n")}\n`);
}

console.log(`build-roster-513: roster ${rosterLines.length - 1} entries (pinned ${ROSTER_SIZE}), evidence ${evLines.length - 1} (seed ${SEED_EVIDENCE})`);
const byBatch = new Map();
for (const l of rosterLines.slice(1)) {
	const b = l.split("\t")[5];
	byBatch.set(b, (byBatch.get(b) ?? 0) + 1);
}
console.log(`  batches: ${[...byBatch].sort().map(([b, n]) => `${b} ${n}`).join(" · ")}`);
for (const p of highProblems) console.log(`  ⚠ ${p}`);
if (mode === "--generate") console.log("  Wrote the roster and evidence tables.");
