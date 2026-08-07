#!/usr/bin/env node
/**
 * Counts how many of the upstream inline tests have a corresponding assertion here.
 *
 * This is the third of three counts, each guarding a different layer:
 *   - the manifest check counts whether every upstream source file is enumerated — the file layer;
 *   - the surface check counts whether every public function has a same-named counterpart — the signature layer;
 *   - this one counts whether the assertions upstream wrote have counterparts — the behavior layer.
 *
 * The first two can pass while the name matches and the behavior does not, as the surface
 * check's own header admits. This one watches the expectations upstream wrote by hand,
 *
 * ## Method, and the two directions it gets wrong
 *
 * Extract the name of every test function inside upstream test blocks, normalise both
 * sides by collapsing non-alphanumerics to spaces, and look for the result as a substring
 *
 * - **False negative, overstating the gap**: tests here are named in prose, and when one
 *   does not mention the upstream name it fails to match. Measured once: searching by raw
 *   name flagged nineteen entries in one file as gaps; normalising dropped that to two.
 * - **False positive, understating the gap**: a name that happens to appear elsewhere, in
 *   a comment or another test's description, counts as a match. A name being present is
 *
 * So this is a **baseline guard**, not a proof of completeness: the number getting worse
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The converged value: of the upstream inline tests, this many are unmatched.
 * The baseline only comes down; raising it means saying what regressed.
 */
// Lowered once after porting a batch of real gaps, whose test bodies mention the upstream
// test name and therefore left the unmatched set. Entries judged covered do **not** move
// this number — they were already "name did not match but behavior is covered", which is
const BASELINE_UNMATCHED = 190;

/** Same logic as the surface-coverage gate: the values hold shell variables to expand. */
function readSourcesEnv() {
	const p = join(repoRoot, "migration/sources.env");
	if (!existsSync(p)) return { path: null, reason: `${p} does not exist` };
	const m = readFileSync(p, "utf-8").match(/^ORACLE_PIE_DIR=(.*)$/m);
	if (!m) return { path: null, reason: "sources.env has no ORACLE_PIE_DIR" };
	const expanded = m[1]
		.replace(/^["']|["']$/g, "")
		.trim()
		// Handles both `$VAR` and `${VAR:-default}`. The default-value form matters because
		// sources.env uses it so that `source`-ing the file under `set -u` does not abort when
		// the variable is unset. A regex that only knows `${VAR}` leaves the `:-}` behind and
		// then reports a nonsense path in its skip message.
		.replace(/\$\{(\w+):-([^}]*)\}/g, (_, name, dflt) => process.env[name] ?? dflt)
		.replace(/\$\{?(\w+)\}?/g, (_, name) => process.env[name] ?? "");
	return { path: expanded, reason: null };
}

function walk(dir, ext, out = []) {
	if (!existsSync(dir)) return out;
	for (const e of readdirSync(dir)) {
		if (e === "node_modules" || e === "dist" || e === "target") continue;
		const p = join(dir, e);
		if (statSync(p).isDirectory()) walk(p, ext, out);
		else if (e.endsWith(ext)) out.push(p);
	}
	return out;
}

const normalize = (s) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;

// The two kinds of skip are reported separately: no path configured, versus a path that
// points nowhere. Only the second needs someone to act.
const { path: oracle, reason } = readSourcesEnv();
if (!oracle) {
	console.log(`check:inline-test-ports: SKIP — ${reason}`);
	console.log("  Normal on a fresh clone or in CI; this check needs the upstream source present.");
	process.exit(0);
}
if (!existsSync(join(oracle, "crates"))) {
	console.log(`check:inline-test-ports: SKIP — ORACLE_PIE_DIR points at ${oracle}, which has no crates/ under it`);
	console.log("  If a local copy exists, this path is wrong and worth fixing rather than skipping past.");
	process.exit(0);
}

const names = [];
for (const crate of ["ai", "agent", "coding-agent", "mcp"]) {
	for (const f of walk(join(oracle, "crates", crate, "src"), ".rs")) {
		const src = readFileSync(f, "utf-8");
		const i = src.indexOf("#[cfg(test)]");
		if (i < 0) continue;
		for (const m of src.slice(i).matchAll(/#\[(?:tokio::)?test\][^\n]*\n\s*(?:async\s+)?fn\s+(\w+)/g)) {
			names.push({ name: m[1], file: f.replace(`${oracle}/`, "") });
		}
	}
}

const corpus = [];
for (const pkg of ["packages/ai/test", "packages/agent/test", "packages/coding-agent/test", "packages/mcp/test"]) {
	for (const f of walk(join(repoRoot, pkg), ".ts")) corpus.push(readFileSync(f, "utf-8"));
}
const blob = normalize(corpus.join("\n"));

const unmatched = names.filter(({ name }) => !blob.includes(normalize(name)));
const rate = (((names.length - unmatched.length) / names.length) * 100).toFixed(1);

if (unmatched.length > BASELINE_UNMATCHED) {
	console.error(
		`check:inline-test-ports: FAIL — ${names.length} upstream inline tests, ${unmatched.length} unmatched (ported ${rate}%)`,
	);
	console.error(`  The baseline is ${BASELINE_UNMATCHED}; this is ${unmatched.length - BASELINE_UNMATCHED} more unmatched.`);
	console.error("  Each one is either coverage that regressed, or a test renamed so that it no longer mentions the upstream name.");
	console.error("  The method and its two error directions are in this file's header.");
	for (const u of unmatched.slice(0, 40)) console.error(`    ${u.file} :: ${u.name}`);
	if (unmatched.length > 40) console.error(`    … and ${unmatched.length - 40} more`);
	process.exit(1);
}
console.log(
	`check:inline-test-ports: OK — ${names.length} upstream inline tests, ${unmatched.length} unmatched (ported ${rate}%), baseline ${BASELINE_UNMATCHED}`,
);
if (unmatched.length < BASELINE_UNMATCHED) {
	console.log(`  Below the baseline; ${BASELINE_UNMATCHED} can be tightened to ${unmatched.length}.`);
}
