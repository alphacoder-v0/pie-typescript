#!/usr/bin/env node
/**
 * Checks whether every public function upstream has a counterpart here.
 *
 * Why it exists: the evidence available before this was a count of completed units, a test
 * suite, and a byte comparison across twelve scenarios. All three **assume** the port is
 *   - the manifest counts whether enumerated units are finished, not whether the
 *     enumeration was exhaustive;
 *   - tests cover what someone wrote assertions for;
 *   - parity covers the code paths twelve scenarios happen to reach.
 *
 * Method: extract every public function from upstream production code, excluding test
 * blocks, and look for three spellings of its name in the source here. Anything not found
 *
 * **This method errs in both directions**, and that has to be understood before using it:
 *   - False positive: a rename reads as missing. One upstream scheduling function is
 *     spelled quite differently here. So the unmatched count is an **upper bound**, not a
 *   - False negative, which is worse: a function that was renamed **and** changed passes
 *     silently as long as the new name appears somewhere. A name existing is not behavior
 *
 * So this is a **baseline guard**, not a proof of correctness: the number going up fails
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The unmatched count after triage. Raising it means documenting why.
 *
 * Lowered once when three functions gained real counterparts. The baseline only comes
 * down, never up — pinning it after a drop is what stops those three quietly regressing.
 */
const BASELINE_UNMATCHED = 40;

/**
 * The values in `sources.env` contain shell variables and have to be expanded.
 * The first version treated them as literal paths, which meant it never found anything and
 * always skipped. A check that never runs is worse than no check, because it looks like one.
 */
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

// The two kinds of skip are reported separately: no path configured, versus a path that
// points nowhere. Conflating them hides which one needs someone to act.
const { path: oracle, reason } = readSourcesEnv();
if (!oracle) {
	console.log(`check:surface-coverage: SKIP — ${reason}`);
	console.log("  Normal on a fresh clone or in CI; the comparison needs the upstream source present.");
	process.exit(0);
}
if (!existsSync(join(oracle, "crates"))) {
	console.log(`check:surface-coverage: SKIP — ORACLE_PIE_DIR points at ${oracle}, which has no crates/ under it`);
	console.log("  If a local copy exists, this path is wrong and worth fixing rather than skipping past.");
	process.exit(0);
}

const tsText = walk(join(repoRoot, "packages"), ".ts")
	.filter((p) => p.includes("/src/"))
	.map((p) => readFileSync(p, "utf-8"))
	.join("\n");

// `filter(Boolean)`: upstream has names like `foo_` and `foo__bar`, where splitting
// produces empty segments and reading the first character would throw.
const words = (s) => s.split("_").filter(Boolean);
const cap = (w) => w[0].toUpperCase() + w.slice(1);
const camel = (s) => words(s).map((w, i) => (i ? cap(w) : w)).join("");
const pascal = (s) => words(s).map(cap).join("");
const has = (n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(tsText);

let total = 0;
const unmatched = [];
for (const f of walk(join(oracle, "crates"), ".rs")) {
	if (f.includes("/tests/")) continue;
	// Drop inline test blocks: that is how tests are organised upstream, they live in
	// separate files here, and they are not part of the public surface
	const src = readFileSync(f, "utf-8").replace(/#\[cfg\(test\)\][\s\S]*$/, "");
	const rel = f.replace(`${oracle}/crates/`, "");
	for (const m of src.matchAll(/^\s*pub (?:async )?fn (\w+)/gm)) {
		total++;
		const name = m[1];
		if (!has(camel(name)) && !has(name) && !has(pascal(name))) unmatched.push(`${rel} :: ${name}`);
	}
}

const pct = ((unmatched.length / total) * 100).toFixed(1);
if (unmatched.length > BASELINE_UNMATCHED) {
	console.error(`check:surface-coverage: FAIL — ${total} upstream public functions, ${unmatched.length} unmatched (${pct}%)`);
	console.error(`  The baseline is ${BASELINE_UNMATCHED}; this is ${unmatched.length - BASELINE_UNMATCHED} more.`);
	console.error("  Each one is either a rename, which belongs in the triage table, or a real gap.");
	console.error("  See the surface-coverage triage notes under migration/reviews/.");
	for (const u of unmatched) console.error(`    ${u}`);
	process.exit(1);
}
console.log(
	`check:surface-coverage: OK — ${total} upstream public functions, ${unmatched.length} unmatched (${pct}%), baseline ${BASELINE_UNMATCHED}`,
);
if (unmatched.length < BASELINE_UNMATCHED) {
	console.log(`  Below the baseline; ${BASELINE_UNMATCHED} can be tightened to ${unmatched.length}.`);
}
