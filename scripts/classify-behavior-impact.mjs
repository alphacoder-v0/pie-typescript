#!/usr/bin/env node
/**
 * Decides which of the lower-risk functions are worth writing behavioral evidence for.
 *
 * ## Why it exists
 *
 * An earlier classifier sorted every function whose name merely matched into three tiers:
 * anything touching credentials, the network, file writes or a parity path became `high`;
 * anything else referenced by two or more modules became `medium`; the rest became `low`.
 * The `high` tier was then covered completely.
 *
 * The problem was the definition of `low`: it meant "referenced by fewer than two
 * modules", which has nothing to do with how much a mistake would cost. Sampling that tier
 * by line number turns up context-window estimation (wrong, and the model silently loses
 * history), a language-server protocol handler, and a function that writes to the session
 * log. The earlier classifier's own header admits that a `low` mistake still hurts.
 *
 * So this script re-selects from that tier using three rules that ignore how often a
 * function is referenced. Each rule has to justify why a mistake in that kind of function
 * hurts; a rule that cannot is padding, and padding turns the roster into busywork.
 *
 * ## The three rules
 *
 * | rule | definition | why a mistake here hurts |
 * |---|---|---|
 * | `B` oracle-tested | the function is called inside its own file's test block | upstream thought it was worth testing |
 * | `C` mutating | the name starts with a verb that changes state | a mistake corrupts or loses persisted data |
 * | `D` fallible | the upstream signature returns a fallible type | it has a failure path, and failure paths are the easiest thing to get wrong in a port |
 *
 * ## An implementation trap in rule B
 *
 * The first version matched the function name against upstream *test names*. That found
 * only seventeen functions and missed a hashing helper whose upstream test is called
 * something else entirely but calls the function in its body. Matching against the body of
 * the test block is what makes the rule work. **Do not go back to matching names.**
 *
 * ## What these rules cannot catch
 *
 * A function that is pure, cannot fail, and that upstream never tested slips through all
 * three. The hashing helper above came close to being exactly that; it was caught only
 * because upstream happened to test it.
 *
 * ## Usage
 *
 *   node scripts/classify-behavior-impact.mjs             # report only
 *   node scripts/classify-behavior-impact.mjs --generate  # write the roster
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const TIERS = join(repoRoot, "migration/reviews/phase21/risk-tiers.tsv");
const OUT = join(repoRoot, "migration/reviews/phase22/roster.tsv");

/** The roster size, pinned. A change means either the rules or upstream moved, and that
 * has to surface immediately rather than be absorbed silently. */
export const ROSTER_SIZE = 282;

/**
 * Verbs that indicate a state change. Deliberately conservative: only verbs that clearly
 * write something, never readers, and never vague ones like `handle` or `process`.
 */
const MUTATING_VERB =
	/^(save|write|append|delete|remove|set|apply|merge|persist|flush|insert|update|clear|store|commit|rename|move|create)(_|$)/;

function oracleDir() {
	const out = execSync("bash -c 'source migration/sources.env && echo $ORACLE_PIE_DIR'", {
		cwd: repoRoot,
		encoding: "utf-8",
	}).trim();
	if (!out || !existsSync(out)) {
		console.error(`no upstream checkout at ${out || "(empty)"} — see migration/sources.env`);
		process.exit(0); // Same as the other gates: skip when there is no checkout, do not fail
	}
	return out;
}

/** Directory walk with an explicit sort. Determinism depends on it: the raw read order is
 * not guaranteed to be the same across filesystems. */
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

const srcCache = new Map();

/**
 * One source file can define several functions with the same name — constructors in
 * different impl blocks are the common case. Two real examples exist: one file has two
 * constructors named `new` on different error types, another has two named `text`.
 *
 * Those are distinct functions, not duplicated rows, so the roster needs one line each.
 * The key therefore includes the upstream line number, which also saves a search later.
 *
 * Assignment: collect every line matching that name in order and hand them out in turn.
 * The earlier tier file was built by the same ordered scan, so the two agree.
 */
const fnLineCache = new Map();
function fnLines(oracle, relPath, fnName) {
	const key = `${relPath}::${fnName}`;
	if (!fnLineCache.has(key)) {
		const src = oracleSource(oracle, relPath);
		const lines = [];
		if (src !== null) {
			const re = new RegExp(`\\bfn\\s+${escapeRe(fnName)}\\b`);
			src.split("\n").forEach((text, i) => {
				if (re.test(text)) lines.push(i + 1);
			});
		}
		fnLineCache.set(key, lines);
	}
	return fnLineCache.get(key);
}

function oracleSource(oracle, relPath) {
	if (!srcCache.has(relPath)) {
		const p = join(oracle, "crates", relPath);
		srcCache.set(relPath, existsSync(p) ? readFileSync(p, "utf-8") : null);
	}
	return srcCache.get(relPath);
}

function escapeRe(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Which rules matched, always in the same order. Fixed order is part of determinism. */
function ruleHits(oracle, relPath, fnName) {
	const src = oracleSource(oracle, relPath);
	if (src === null) return [];
	const hits = [];

	// B — called inside the body of the test block. Not "the test name contains the function name".
	const testBlockStart = src.indexOf("#[cfg(test)]");
	if (testBlockStart >= 0 && new RegExp(`\\b${escapeRe(fnName)}\\s*\\(`).test(src.slice(testBlockStart))) {
		hits.push("B");
	}

	// C — starts with a verb that changes state.
	if (MUTATING_VERB.test(fnName)) hits.push("C");

	// D — the signature returns a fallible type. Stops at the brace or semicolon so a
	//     mention inside the body does not count.
	const sig = new RegExp(`\\bfn\\s+${escapeRe(fnName)}\\s*(<[^>]*>)?\\s*\\([^)]*\\)[^{;]*->\\s*([^{;]+)`).exec(src);
	if (sig && sig[2].includes("Result")) hits.push("D");

	return hits;
}

/**
 * Batch assignment, grouped by package and topic so that everything in one batch shares
 * context and a reviewer is not switching subjects constantly. The largest batch is split
 * in half by roster order, with the split point computed rather than typed.
 */
function themeBatch(relPath) {
	if (/session|agent_session|history/.test(relPath)) return "A";
	if (/trigger|cron|goal|inbox/.test(relPath)) return "B";
	if (relPath.startsWith("agent/")) return "C";
	if (relPath.startsWith("ai/") || relPath.startsWith("mcp/")) return "D";
	return "E";
}

// ── Main ──────────────────────────────────────────────────────────────────────

const oracle = oracleDir();

const tierRows = readFileSync(TIERS, "utf-8")
	.trim()
	.split("\n")
	.slice(1)
	.map((line) => {
		const [oracleFile, fnName, tier] = line.split("\t");
		return { oracleFile, fnName, tier };
	});

const roster = [];

// The medium tier enters whole; its reason is the earlier rule about module references,
// being referenced by two or more modules, so the three rules below do not apply to it.
const seenSoFar = new Map();
function nextLine(r) {
	const key = `${r.oracleFile}::${r.fnName}`;
	const n = seenSoFar.get(key) ?? 0;
	seenSoFar.set(key, n + 1);
	const lines = fnLines(oracle, r.oracleFile, r.fnName);
	return lines[n] ?? lines[lines.length - 1] ?? 0;
}

for (const r of tierRows.filter((r) => r.tier === "medium")) {
	roster.push({ ...r, source: "medium", ruleHit: "-", oracleLine: nextLine(r) });
}

// Apply B, C and D to the low tier
const lowRows = tierRows.filter((r) => r.tier === "low");
const ruleCount = { B: 0, C: 0, D: 0 };
const samples = { B: [], C: [], D: [] };
for (const r of lowRows) {
	const hits = ruleHits(oracle, r.oracleFile, r.fnName);
	if (hits.length === 0) continue;
	for (const h of hits) {
		ruleCount[h]++;
		if (samples[h].length < 3) samples[h].push(`${r.oracleFile}::${r.fnName}`);
	}
	roster.push({ ...r, source: "low", ruleHit: hits.join(","), oracleLine: nextLine(r) });
}

// Batches: assign by topic first, then split the largest in half. The sort keeps this
// deterministic: by file name, then by function name.
roster.sort(
	(a, b) => a.oracleFile.localeCompare(b.oracleFile) || a.fnName.localeCompare(b.fnName) || a.oracleLine - b.oracleLine,
);
const eTotal = roster.filter((r) => themeBatch(r.oracleFile) === "E").length;
const eSplit = Math.ceil(eTotal / 2);
let eSeen = 0;
for (const r of roster) {
	const t = themeBatch(r.oracleFile);
	if (t !== "E") {
		r.batch = t;
	} else {
		r.batch = eSeen < eSplit ? "E1" : "E2";
		eSeen++;
	}
}

// ── Report ────────────────────────────────────────────────────────────────────

const medium = roster.filter((r) => r.source === "medium").length;
const low = roster.filter((r) => r.source === "low").length;
console.log(`classify-behavior-impact: roster ${roster.length} entries — medium ${medium} · low selected ${low}`);
console.log(`  low tier has ${lowRows.length} in total; ${lowRows.length - low} were not selected`);
console.log("  rule matches (a function can match more than one):");
for (const k of ["B", "C", "D"]) {
	const label = { B: "oracle-tested", C: "mutating", D: "fallible" }[k];
	console.log(`    ${k} ${label.padEnd(14)} ${String(ruleCount[k]).padStart(3)}   e.g. ${samples[k].join(" · ")}`);
}

const byBatch = {};
for (const r of roster) byBatch[r.batch] = (byBatch[r.batch] ?? 0) + 1;
console.log(`  batch sizes: ${["A", "B", "C", "D", "E1", "E2"].map((b) => `${b} ${byBatch[b] ?? 0}`).join(" · ")}`);

if (roster.length !== ROSTER_SIZE) {
	console.error(`\nRoster has ${roster.length} entries, pinned at ${ROSTER_SIZE}.`);
	console.error("Either the rules changed or upstream drifted. Both need an explanation.");
	process.exit(1);
}

const emptyRule = roster.filter((r) => r.source === "low" && !r.ruleHit);
if (emptyRule.length > 0) {
	console.error(`\n${emptyRule.length} low-tier rows record no rule. Every one must be selected by a rule.`);
	process.exit(1);
}

const keys = new Set();
for (const r of roster) {
	const k = `${r.oracleFile}::${r.fnName}@${r.oracleLine}`;
	if (keys.has(k)) {
		console.error(`\nDuplicate roster key ${k}: the line number failed to separate two same-named functions.`);
		process.exit(1);
	}
	keys.add(k);
}

if (process.argv.includes("--generate")) {
	const lines = ["oracle_file\tfn_name\toracle_line\tsource\trule_hit\tbatch"];
	for (const r of roster) lines.push([r.oracleFile, r.fnName, r.oracleLine, r.source, r.ruleHit, r.batch].join("\t"));
	writeFileSync(OUT, `${lines.join("\n")}\n`);
	console.log(`\nWrote ${OUT} (${lines.length} lines)`);
}
