#!/usr/bin/env node
/**
 * Reports facts about the counterpart on this side of a port. It draws no conclusions.
 *
 * ## The mistake it exists to prevent
 *
 * A verdict once marked a fully ported web UI as having no counterpart, on the grounds
 * that a same-named symbol had zero hits. That was wrong: the implementation is over a
 * thousand lines long and its entry point is simply named differently, with a doc comment
 * pointing straight at the upstream line range.
 *
 * The flaw was inferring "the whole path is missing" from "the symbol name is not found".
 * In the same review, a six-line placeholder module and a seventeen-hundred-line
 * implementation produced **identical** signals, because the only thing being looked at
 * was a name.
 *
 * So this script looks at files and their length, never at symbol names. Names are used
 * only as a hint within the export list, never to decide whether something was ported.
 *
 * ## The three steps to take before writing off a function
 *
 * 1. Is there a file here that plays the same role? Decide by mapping the path, not the name.
 * 2. If there is, which of its exports carries the responsibility of that function?
 * 3. If there really is none, is that a missing capability or a structural difference?
 *
 * This script gathers the evidence for steps 1 and 2. Step 3 is a judgement and stays a
 * person's job.
 *
 * ## How this differs from the evidence locator
 *
 * The locator searches tests for the assertion that covers a function and returns a path
 * and line. This searches source for whether an implementation exists at all, and returns
 * the file, its length, and its exports.
 *
 * ## Usage
 *   node scripts/probe-ts-counterpart.mjs --calibrate
 *   node scripts/probe-ts-counterpart.mjs --batch <notportable|unmatched40|U|F|G|H>
 *   node scripts/probe-ts-counterpart.mjs --one 'coding-agent/src/ui/web.rs::run_web'
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const PHASE23 = join(repoRoot, "migration/reviews/phase23");
const ROSTER = join(PHASE23, "roster.tsv");
const EVIDENCE = join(PHASE23, "evidence.tsv");

/** A file shorter than this is treated as a placeholder. Having a file is not having an implementation. */
const STUB_MAX_LINES = 12;

/**
 * The values in `sources.env` contain shell variables and have to be expanded.
 * Same logic as the coverage gates.
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
	if (!existsSync(dir)) return;
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (e.name === "node_modules" || e.name === "dist") continue;
		const p = join(dir, e.name);
		if (e.isDirectory()) yield* walk(p, ext);
		else if (e.name.endsWith(ext)) yield p;
	}
}

// ── Path mapping ─────────────────────────────────────────────────────────────

/**
 * Maps an upstream source path to the corresponding path here.
 *
 * - Underscores in path segments become hyphens, matching the two naming conventions.
 * - A module file is tried as the directory's index, and as a file named after the directory.
 * - When all of those miss, falls back to searching the whole tree for the same basename,
 *   which covers directories that were reorganised.
 *
 * Returns every hit, with direct path matches first: they are far more trustworthy than
 * the whole-tree search.
 */
function mapToTs(oracleFile) {
	const [pkg, ...rest] = oracleFile.split("/");
	const relParts = rest.slice(1); // drop "src"
	if (relParts.length === 0) return [];
	const kebab = (s) => s.replace(/_/g, "-");
	const base = relParts[relParts.length - 1].replace(/\.rs$/, "");
	const dirParts = relParts.slice(0, -1).map(kebab);
	const pkgRoot = join(repoRoot, "packages", pkg, "src");

	const candidates = [];
	const push = (p, how) => {
		if (existsSync(p) && statSync(p).isFile()) candidates.push({ path: p, how });
	};

	if (base === "mod") {
		push(join(pkgRoot, ...dirParts, "index.ts"), "mod→index");
		if (dirParts.length) {
			const last = dirParts[dirParts.length - 1];
			push(join(pkgRoot, ...dirParts.slice(0, -1), `${last}.ts`), "module as same-named file");
		}
	} else {
		push(join(pkgRoot, ...dirParts, `${kebab(base)}.ts`), "path mapping");
		push(join(pkgRoot, ...dirParts, kebab(base), "index.ts"), "path mapping to directory index");
		push(join(pkgRoot, `${kebab(base)}.ts`), "package root");
	}

	if (candidates.length === 0) {
		const want = `${kebab(base)}.ts`;
		for (const f of walk(join(repoRoot, "packages"), ".ts")) {
			if (f.includes("/test/") || f.endsWith(".test.ts") || f.endsWith(".d.ts")) continue;
			if (basename(f) === want) candidates.push({ path: f, how: "whole-tree basename search" });
		}
	}

	const seen = new Set();
	return candidates.filter((c) => (seen.has(c.path) ? false : (seen.add(c.path), true)));
}

/** The names a file exports: functions, classes, constants and types. */
function exportsOf(tsPath) {
	const src = readFileSync(tsPath, "utf-8");
	const names = [];
	for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function|class|const|let|type|interface)\s+(\w+)/gm)) {
		names.push(m[1]);
	}
	for (const m of src.matchAll(/^export\s*\{([^}]+)\}/gm)) {
		for (const part of m[1].split(",")) {
			const n = part.trim().split(/\s+as\s+/)[0].trim();
			if (/^\w+$/.test(n)) names.push(n);
		}
	}
	return [...new Set(names)];
}

// ── The probe ────────────────────────────────────────────────────────────────

function probe(oracle, oracleFile, fnName) {
	// Step 0: does this function exist upstream at all? This is what the negative control guards.
	const op = join(oracle, "crates", oracleFile);
	if (!existsSync(op)) return { error: `no such file upstream — ${oracleFile}` };
	const osrc = readFileSync(op, "utf-8");
	const esc = fnName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	if (!new RegExp(`\\bfn\\s+${esc}\\b`).test(osrc)) {
		return { error: `no such function upstream — ${oracleFile}::${fnName}` };
	}

	// Step 1: is there a file here that plays the same role?
	const cands = mapToTs(oracleFile);
	if (cands.length === 0) return { tsFile: "", lines: 0, exports: [], near: [], hint: "no-file", how: "", alts: [] };

	const best = cands[0];
	const lines = readFileSync(best.path, "utf-8").split("\n").length;
	const exps = exportsOf(best.path);

	// Step 2: which export carries that responsibility. A hint only, never a decision.
	const lower = fnName.replace(/_/g, "").toLowerCase();
	const near = exps.filter((e) => e.toLowerCase().includes(lower) || lower.includes(e.toLowerCase()));

	const hint = lines <= STUB_MAX_LINES ? "stub" : near.length ? "substantial+named" : "substantial";
	return {
		tsFile: best.path.replace(`${repoRoot}/`, ""),
		lines,
		exports: exps,
		near,
		hint,
		how: best.how,
		alts: cands.slice(1, 4).map((c) => c.path.replace(`${repoRoot}/`, "")),
	};
}

// ── Entry point ──────────────────────────────────────────────────────────────

const oracle = oracleDir();
if (!oracle) {
	console.error("probe-ts-counterpart: no upstream checkout (migration/sources.env is missing or its path is invalid).");
	process.exit(1);
}

const readTsv = (p) => readFileSync(p, "utf-8").trim().split("\n").slice(1).map((l) => l.split("\t"));
const splitKey = (key) => {
	const m = key.match(/^(.+?)::(\w+)(?:@(\d+))?$/);
	return m ? { file: m[1], fn: m[2], line: m[3] ?? "" } : null;
};

function report(key, r) {
	if (r.error) {
		console.log(`  ${key}\n      ✗ ${r.error}`);
		return;
	}
	if (!r.tsFile) {
		console.log(`  ${key}\n      file: none — path mapping and the whole-tree basename search both missed`);
		return;
	}
	console.log(`  ${key}`);
	console.log(`      file: ${r.tsFile}  (${r.lines} lines, ${r.how})  [${r.hint}]`);
	console.log(`      exports: ${r.exports.slice(0, 8).join(", ")}${r.exports.length > 8 ? ` … ${r.exports.length} total` : ""}`);
	if (r.near?.length) console.log(`      similar names: ${r.near.join(", ")}`);
	if (r.alts?.length) console.log(`      other candidates: ${r.alts.join(" · ")}`);
}

const mode = process.argv[2];

if (mode === "--calibrate") {
	/**
	 * Three calibration probes. Their expected results were written down before this
	 * script existed; otherwise calibration degenerates into restating whatever the code
	 * happens to output.
	 *
	 * The first two are a pair: identical signals by name (both miss), opposite signals by
	 * file (seventeen hundred lines against six). The probe has to tell them apart.
	 */
	const PROBES = [
		{ key: "coding-agent/src/ui/web.rs::run_web", want: "at least 1700 lines, exports include serveWeb" },
		{ key: "ai/src/bedrock_provider.rs::invoke_stream", want: "at most 10 lines, a placeholder" },
		{ key: "ai/src/utils/oauth/pkce.rs::generate_pkce", want: "more than 10 lines, exports include generatePKCE" },
	];
	let bad = 0;
	console.log("probe-ts-counterpart --calibrate\n");
	for (const p of PROBES) {
		const k = splitKey(p.key);
		const r = probe(oracle, k.file, k.fn);
		console.log(`expected: ${p.want}`);
		report(p.key, r);
		console.log("");
		if (r.error) bad += 1;
	}
	console.log("negative control (an entry that does not exist upstream):");
	const neg = probe(oracle, "foo/bar.rs", "nope");
	report("foo/bar.rs::nope", neg);
	if (!neg.error) {
		console.error("\nNegative control failed: a nonexistent entry produced no error, which would let a mistyped name pass as a missing capability");
		process.exit(1);
	}
	console.log("\nNegative control passed: the nonexistent entry was rejected");
	process.exit(bad ? 1 : 0);
}

if (mode === "--one") {
	const k = splitKey(process.argv[3] ?? "");
	if (!k) {
		console.error("usage: --one '<file>::<fn>'");
		process.exit(2);
	}
	const r = probe(oracle, k.file, k.fn);
	report(process.argv[3], r);
	process.exit(r.error ? 1 : 0);
}

if (mode === "--batch") {
	const which = process.argv[3] ?? "";
	const roster = readTsv(ROSTER);
	const evidence = readTsv(EVIDENCE);

	let keys;
	if (which === "notportable") {
		keys = evidence.filter((r) => r[1] === "not-portable").map((r) => r[0]);
	} else if (which === "unmatched40") {
		keys = roster.filter((r) => r[5] === "U").map((r) => `${r[0]}::${r[1]}@${r[2]}`);
	} else {
		keys = roster.filter((r) => r[5] === which).map((r) => `${r[0]}::${r[1]}@${r[2]}`);
	}
	if (keys.length === 0) {
		console.error(`--batch ${which}: no entries. Is the batch name right? Valid: notportable / unmatched40 / U / F / G / H`);
		process.exit(1);
	}

	const rows = ["oracle_key\tts_file\tts_lines\texports\thint"];
	const tally = new Map();
	for (const key of keys) {
		const k = splitKey(key);
		const r = probe(oracle, k.file, k.fn);
		const hint = r.error ? "oracle-missing" : r.hint;
		tally.set(hint, (tally.get(hint) ?? 0) + 1);
		rows.push([key, r.tsFile ?? "", r.lines ?? 0, (r.exports ?? []).join(","), hint].join("\t"));
	}
	const out = join(PHASE23, `probe-${which}.tsv`);
	writeFileSync(out, `${rows.join("\n")}\n`);
	console.log(`probe-ts-counterpart --batch ${which}: ${keys.length} entries → ${out.replace(`${repoRoot}/`, "")} (${rows.length} lines)`);
	console.log(`  distribution: ${[...tally].sort().map(([h, n]) => `${h} ${n}`).join(" · ")}`);
	console.log("");
	console.log("  what each hint means. All of these are facts, not judgements:");
	console.log(`    stub              a file exists but has at most ${STUB_MAX_LINES} lines, so it is a placeholder`);
	console.log("    substantial       a real file exists, but nothing in its exports has a similar name");
	console.log("    substantial+named a real file exists and one of its exports has a similar name");
	console.log("    no-file           path mapping and the whole-tree basename search both missed");
	process.exit(0);
}

console.error("usage: --calibrate | --batch <notportable|unmatched40|U|F|G|H> | --one '<file>::<fn>'");
process.exit(2);
