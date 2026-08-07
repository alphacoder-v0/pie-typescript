#!/usr/bin/env node
/**
 * Sorts the upstream public functions whose names match but whose behavior was never
 * checked into tiers, so that the expensive work goes where a mistake costs most.
 *
 * ## The problem
 *
 * The surface-coverage gate counts whether every upstream public function has a
 * same-named counterpart here. The ones that do have only had their *name* verified —
 * as that gate's own header says, a name existing is not behavior being right.
 *
 * Verifying several hundred functions one by one is not a bounded task, so they get
 * tiered first: which ones are worth the cost.
 *
 * ## The rules, four dimensions, each decidable by inspection
 *
 * | rule | test | why this dimension is worth separating |
 * |---|---|---|
 * | `credential` | the name or its file deals with keys, tokens, auth or secrets | a mistake leaks or drops credentials |
 * | `filesystem` | the body writes, creates, removes, renames or changes permissions | a mistake destroys a user's files |
 * | `user-visible` | the name renders, formats, prints, displays or summarises | a mistake shows the user something false |
 * | `parity-path` | the module lies inside the closure the parity scenarios drive | a mistake shows up as a byte difference |
 *
 * Matching any rule makes it high risk; matching none but being referenced by two or
 * more modules makes it medium; everything else is low.
 *
 * ## What this tiering cannot catch
 *
 * The rules match on literal strings, so they miss indirect paths: a function that does
 * not touch credentials itself but calls one that does. And `low` is not `safe` — it is
 * lower probability and smaller blast radius. **This is a priority order, not a proof.**
 *
 * ## Reproducible
 *
 * No randomness, no clock, no concurrency, and every directory walk is sorted. The same
 * input produces the same output twice.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(repoRoot, "migration/reviews/phase21/risk-tiers.tsv");

/** Bounds on the size of the high tier. Going outside them means explaining and adjusting
 * the rules; silently retuning would define "high risk" as "however much I feel like doing". */
const HIGH_MIN = 15;
const HIGH_MAX = 60;

function readSourcesEnv() {
	const p = join(repoRoot, "migration/sources.env");
	if (!existsSync(p)) return { path: null, reason: `${p} does not exist` };
	const m = readFileSync(p, "utf-8").match(/^ORACLE_PIE_DIR=(.*)$/m);
	if (!m) return { path: null, reason: "sources.env has no ORACLE_PIE_DIR" };
	return {
		path: m[1]
			.replace(/^["']|["']$/g, "")
			.trim()
			.replace(/\$\{?(\w+)\}?/g, (_, name) => process.env[name] ?? ""),
		reason: null,
	};
}

function walk(dir, ext, out = []) {
	if (!existsSync(dir)) return out;
	for (const e of readdirSync(dir).sort()) {
		if (e === "node_modules" || e === "dist" || e === "target") continue;
		const p = join(dir, e);
		if (statSync(p).isDirectory()) walk(p, ext, out);
		else if (e.endsWith(ext)) out.push(p);
	}
	return out;
}

const { path: oracle, reason } = readSourcesEnv();
if (!oracle) {
	console.log(`classify-surface-risk: SKIP — ${reason}`);
	console.log("  Normal on a fresh clone or in CI; tiering needs the upstream source present.");
	process.exit(0);
}
if (!existsSync(join(oracle, "crates"))) {
	console.log(`classify-surface-risk: SKIP — ORACLE_PIE_DIR points at ${oracle}, which has no crates/ under it`);
	console.log("  If a local copy exists, this path is wrong and worth fixing rather than skipping past.");
	process.exit(0);
}

// ── Same matching logic as the surface-coverage gate ─────────────────────────
// The input to tiering must be exactly the set that gate considers matched, or the two
// numbers disagree and nobody can say what is being tiered.
const tsText = walk(join(repoRoot, "packages"), ".ts")
	.filter((p) => p.includes("/src/"))
	.map((p) => readFileSync(p, "utf-8"))
	.join("\n");

const words = (s) => s.split("_").filter(Boolean);
const cap = (w) => w[0].toUpperCase() + w.slice(1);
const camel = (s) => words(s).map((w, i) => (i ? cap(w) : w)).join("");
const pascal = (s) => words(s).map(cap).join("");
const hasName = (n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(tsText);

// ── The four rules ───────────────────────────────────────────────────────────
/**
 * A bare `token` is unusable: the upstream code is full of cancellation tokens, and one
 * abort function's body binds a local named `token` that has nothing to do with
 * credentials. A bare `auth` would likewise match `author`. Only credential-specific
 */
const CREDENTIAL_RE =
	/api_key|apikey|access_token|refresh_token|id_token|token_keychain|auth_store|authorization|oauth|secret|credential|bearer|password/i;
const FILESYSTEM_RE =
	/fs::write|fs::create_dir|fs::remove|fs::rename|fs::set_permissions|write_all|OpenOptions/;
const USER_VISIBLE_FN_RE = /^(render|format|print|display|summar|preview|describe|emit|to_string|fmt)/;

/**
 * The closure of modules the parity scenarios drive.
 *
 * The scenario scripts run the binary, so there is no direct mapping from scenario to
 * module. The approximation: the CLI surfaces the scripts mention map to upstream entry
 * modules, then the dependency graph gives the transitive closure.
 *
 * The approximation errs wide, which puts more functions in the high tier rather than fewer.
 */
function parityClosure() {
	const scenarioDir = join(repoRoot, "migration/parity/scenarios");
	const scenarioText = existsSync(scenarioDir)
		? readdirSync(scenarioDir)
				.sort()
				.map((f) => readFileSync(join(scenarioDir, f), "utf-8"))
				.join("\n")
		: "";

	// CLI keywords appearing in the scenario scripts, mapped to upstream entry modules.
	// Only keywords that actually appear are listed.
	const SEEDS = [
		["--help", "coding-agent::main"],
		["session", "coding-agent::session_archive"],
		["cron", "coding-agent::triggers"],
		["--resume", "coding-agent::resume_picker"],
		["read", "coding-agent::tools"],
		["write", "coding-agent::tools"],
	];
	const seeds = new Set(["coding-agent::main"]);
	for (const [kw, mod] of SEEDS) if (scenarioText.includes(kw)) seeds.add(mod);

	const edgesPath = join(repoRoot, "migration/depmap/edges.tsv");
	const adj = new Map();
	if (existsSync(edgesPath)) {
		for (const line of readFileSync(edgesPath, "utf-8").split("\n").slice(1)) {
			const [src, dst] = line.split("\t");
			if (!src || !dst) continue;
			if (!adj.has(src)) adj.set(src, []);
			adj.get(src).push(dst);
		}
	}
	const seen = new Set();
	const stack = [...seeds].sort();
	while (stack.length) {
		const cur = stack.pop();
		if (seen.has(cur)) continue;
		seen.add(cur);
		for (const next of adj.get(cur) ?? []) stack.push(next);
	}
	return seen;
}

/** Converts a source path to the node name used in the dependency graph. */
function moduleIdOf(rel) {
	const [crate, ...rest] = rel.split("/");
	const path = rest.join("/").replace(/^src\//, "").replace(/\.rs$/, "").replace(/\/mod$/, "");
	return `${crate}::${path.split("/").join("::")}`;
}

/** How many modules reference this one, which is the medium-tier test. */
function inDegrees() {
	const edgesPath = join(repoRoot, "migration/depmap/edges.tsv");
	const deg = new Map();
	if (!existsSync(edgesPath)) return deg;
	for (const line of readFileSync(edgesPath, "utf-8").split("\n").slice(1)) {
		const [src, dst] = line.split("\t");
		if (!src || !dst) continue;
		if (!deg.has(dst)) deg.set(dst, new Set());
		deg.get(dst).add(src);
	}
	return deg;
}

const closure = parityClosure();
const degrees = inDegrees();

/** Extracts a function body by balancing braces, for the filesystem rule. */
function bodyAfter(src, fnStart) {
	const i = src.indexOf("{", fnStart);
	if (i < 0) return "";
	let depth = 0;
	for (let j = i; j < src.length; j++) {
		if (src[j] === "{") depth++;
		else if (src[j] === "}" && --depth === 0) return src.slice(i, j + 1);
	}
	return src.slice(i);
}

const rows = [];
let total = 0;
let unmatched = 0;

for (const f of walk(join(oracle, "crates"), ".rs")) {
	if (f.includes("/tests/")) continue;
	const src = readFileSync(f, "utf-8").replace(/#\[cfg\(test\)\][\s\S]*$/, "");
	const rel = f.replace(`${oracle}/crates/`, "");
	const modId = moduleIdOf(rel);
	const inParity = closure.has(modId);
	const refCount = degrees.get(modId)?.size ?? 0;

	for (const m of src.matchAll(/^\s*pub (?:async )?fn (\w+)/gm)) {
		total++;
		const name = m[1];
		if (!hasName(camel(name)) && !hasName(name) && !hasName(pascal(name))) {
			unmatched++;
			continue; // Unmatched functions belong to the coverage gate, not to tiering
		}
		const body = bodyAfter(src, m.index);
		const hits = [];
		// The granularity is the function body, not the whole file. The first version judged by
		// file: the credential rule then matched 290 functions and the high tier reached 336,
		// because one abort function was flagged merely for the word "auth" appearing somewhere
		if (CREDENTIAL_RE.test(name) || CREDENTIAL_RE.test(body)) hits.push("credential");
		if (FILESYSTEM_RE.test(body)) hits.push("filesystem");
		const userVisible = USER_VISIBLE_FN_RE.test(name);
		if (userVisible) hits.push("user-visible");
		// The parity rule originally asked only whether the module was in the closure, which made
		// every function in it high risk — 81 matches, most of them pure helpers. Tightened to
		// "in the closure **and** actually producing user-visible bytes or writing to disk":
		// the judge watches output, so a helper that produces none is not on a surface it can see.
		if (inParity && (userVisible || hits.includes("filesystem"))) hits.push("parity-path");

		const tier = hits.length > 0 ? "high" : refCount >= 2 ? "medium" : "low";
		rows.push({ rel, name, tier, hits });
	}
}

rows.sort((a, b) => (a.rel === b.rel ? a.name.localeCompare(b.name) : a.rel.localeCompare(b.rel)));

const body = rows.map((r) => [r.rel, r.name, r.tier, r.hits.join(",") || "-"].join("\t"));
writeFileSync(OUT, `${["oracle_file", "fn_name", "tier", "rule_hit"].join("\t")}\n${body.join("\n")}\n`, "utf-8");

const count = (t) => rows.filter((r) => r.tier === t).length;
const high = count("high");

console.log(`classify-surface-risk: ${total} upstream public functions, ${unmatched} unmatched (the coverage gate owns those)`);
console.log(`  tiering input, the matched ones: ${rows.length}`);
console.log(`  high ${high} · medium ${count("medium")} · low ${count("low")}`);
console.log(`  → ${OUT.replace(`${repoRoot}/`, "")}`);

for (const tier of ["high", "medium", "low"]) {
	const sample = rows.filter((r) => r.tier === tier).slice(0, 5);
	console.log(`\n  five samples from the ${tier} tier:`);
	for (const r of sample) console.log(`    ${r.rel} :: ${r.name}  [${r.hits.join(",") || "-"}]`);
}

const ruleCounts = new Map();
for (const r of rows) for (const h of r.hits) ruleCounts.set(h, (ruleCounts.get(h) ?? 0) + 1);
console.log("\n  matches per rule (a function can match more than one):");
for (const [k, v] of [...ruleCounts].sort((a, b) => b[1] - a[1])) console.log(`    ${k}: ${v}`);

if (high > HIGH_MAX) {
	console.error(`\nclassify-surface-risk: high tier has ${high}, above the upper bound of ${HIGH_MAX}`);
	console.error("  The rules are too loose. Tightening them means writing down what changed, why, and which functions left the tier.");
	process.exit(1);
}
if (high < HIGH_MIN) {
	console.error(`\nclassify-surface-risk: high tier has ${high}, below the lower bound of ${HIGH_MIN}`);
	console.error("  The rules are too tight. Loosening them needs the same explanation.");
	process.exit(1);
}
console.log(`\nclassify-surface-risk: OK — high tier has ${high}, within [${HIGH_MIN}, ${HIGH_MAX}]`);
