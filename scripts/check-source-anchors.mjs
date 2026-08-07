#!/usr/bin/env node
/**
 * Fails when a source anchor disappears from the ported code.
 *
 * ## What an anchor is
 *
 * Two kinds of text in this repository are load-bearing even though both sit inside comments:
 *
 *   - **`rs-line`** — `session_archive.rs:777-806` and friends. Each one says which lines of the
 *     upstream Rust a piece of TypeScript was ported from. This is the provenance link, and the
 *     only way a reader can check a port against its source.
 *   - **`oracle-test`** — the name of an upstream inline test, e.g.
 *     `export_manifest_uses_last_entry_as_leaf_without_explicit_leaf_row`.
 *     `check:inline-test-ports` counts an upstream test as covered when its name appears anywhere
 *     in the test corpus, including inside a comment. Delete the comment and the coverage number
 *     moves for a reason that has nothing to do with coverage.
 *
 * ## Why this is a separate check
 *
 * Anchors live inside comments, so anything that rewrites a comment block wholesale — translating
 * it, shortening it, reflowing it — can take them with it. That is not hypothetical: one
 * translation pass through the product source destroyed 37 `rs-line` anchors across 20 files. The
 * only signal was `check:surface-coverage` reading 42 unmatched instead of 40. It reported a
 * number, not a name, so nothing pointed at the cause.
 *
 * This check reports names: which anchor went missing, and from which file.
 *
 * It also runs without the upstream checkout, because the roster is on disk. That matters — the
 * two checks that would otherwise notice this damage both skip on a fresh clone and in CI.
 *
 * ## Usage
 *
 *   node scripts/check-source-anchors.mjs              verify against migration/source-anchors.tsv
 *   node scripts/check-source-anchors.mjs --rebuild    rewrite the roster from the working tree
 *
 * `--rebuild` is for when an anchor is deliberately added or removed. It declares the new state as
 * intended, so it belongs in the same commit as the change that motivated it, where the roster
 * diff can be reviewed on its own.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROSTER = join(repoRoot, "migration/source-anchors.tsv");
const label = "check:source-anchors";

/** `foo.rs:12` or `crates/ai/src/foo.rs:12-34`. */
const RS_LINE = /[A-Za-z0-9_/.-]+\.rs:\d+(?:-\d+)?/g;

/**
 * Upstream test names are snake_case with at least two underscores. The floor on underscores keeps
 * ordinary Rust identifiers mentioned in passing (`stream_fn`, `parking_lot`) out of the roster: a
 * roster full of common words would pass trivially and protect nothing.
 */
const ORACLE_TEST = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+){2,}\b/g;

/** The same normalization `check:inline-test-ports` uses, so both agree on what "present" means. */
const normalize = (s) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;

function sourceFiles() {
	const globs = [
		"packages/*/src/*.ts",
		"packages/*/src/**/*.ts",
		"packages/*/test/*.ts",
		"packages/*/test/**/*.ts",
	];
	const out = execSync(
		`git ls-files --cached --others --exclude-standard ${globs.map((g) => `'${g}'`).join(" ")}`,
		{ cwd: repoRoot, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
	);
	return [...new Set(out.split("\n").filter(Boolean))].filter((f) => existsSync(join(repoRoot, f)));
}

/**
 * `rs-line` anchors are counted per file, because "this TS file came from that Rust location" is a
 * per-file claim, and because a count catches the case where one of two identical anchors in the
 * same file is dropped — a set would not.
 *
 * `oracle-test` names are collected repo-wide, matching how `check:inline-test-ports` searches.
 */
function scan(files) {
	const rsLines = new Map(); // `${file}\t${anchor}` -> count
	const oracleTests = new Set();
	for (const rel of files) {
		const text = readFileSync(join(repoRoot, rel), "utf-8");
		for (const m of text.match(RS_LINE) ?? []) {
			const key = `${rel}\t${m}`;
			rsLines.set(key, (rsLines.get(key) ?? 0) + 1);
		}
		for (const m of text.match(ORACLE_TEST) ?? []) oracleTests.add(m);
	}
	return { rsLines, oracleTests };
}

function readRoster() {
	if (!existsSync(ROSTER)) {
		console.error(`${label}: ${ROSTER} is missing. Run with --rebuild to create it.`);
		process.exit(1);
	}
	const rows = readFileSync(ROSTER, "utf-8").trim().split("\n").slice(1);
	const rsLines = new Map();
	const oracleTests = [];
	for (const row of rows) {
		const [kind, anchor, scope, count] = row.split("\t");
		if (kind === "rs-line") rsLines.set(`${scope}\t${anchor}`, Number(count));
		else if (kind === "oracle-test") oracleTests.push(anchor);
	}
	return { rsLines, oracleTests };
}

const files = sourceFiles();
const found = scan(files);

if (process.argv.includes("--rebuild")) {
	const lines = ["kind\tanchor\tscope\tcount"];
	for (const [key, count] of [...found.rsLines.entries()].sort()) {
		const [file, anchor] = key.split("\t");
		lines.push(`rs-line\t${anchor}\t${file}\t${count}`);
	}
	for (const name of [...found.oracleTests].sort()) lines.push(`oracle-test\t${name}\t*\t1`);
	writeFileSync(ROSTER, `${lines.join("\n")}\n`);
	console.log(
		`${label}: roster rebuilt — ${found.rsLines.size} rs-line rows, ${found.oracleTests.size} oracle-test rows`,
	);
	process.exit(0);
}

const roster = readRoster();
const missing = [];

for (const [key, want] of roster.rsLines) {
	const have = found.rsLines.get(key) ?? 0;
	if (have < want) {
		const [file, anchor] = key.split("\t");
		missing.push(`rs-line      ${anchor}  in ${file}  (expected ${want}, found ${have})`);
	}
}

// One blob for the whole corpus: an upstream test name counts as present wherever it appears,
// which is exactly the rule `check:inline-test-ports` applies when it decides coverage.
const blob = normalize(files.map((f) => readFileSync(join(repoRoot, f), "utf-8")).join("\n"));
for (const name of roster.oracleTests) {
	if (!blob.includes(normalize(name))) missing.push(`oracle-test  ${name}`);
}

const total = roster.rsLines.size + roster.oracleTests.length;
if (missing.length > 0) {
	console.error(`${label}: FAIL — ${missing.length} of ${total} anchors are gone`);
	for (const m of missing.slice(0, 30)) console.error(`    ${m}`);
	if (missing.length > 30) console.error(`    … ${missing.length - 30} more`);
	console.error("  An anchor usually disappears because a comment block was rewritten around it.");
	console.error("  Put it back. If the removal is intended, say so with --rebuild in the same commit.");
	process.exit(1);
}

console.log(
	`${label}: OK — ${roster.rsLines.size} rs-line anchors and ${roster.oracleTests.length} upstream test names all present`,
);
