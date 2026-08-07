#!/usr/bin/env node
// Fails when a hardcoded version literal in this repo stops matching the oracle's Cargo.toml.
//
// Why this exists: a handful of TS sites must emit the ORACLE crate version (pie @ORACLE_PIE_SHA,
// 0.75.0 at that snapshot) rather than this monorepo's own package.json version (pi's 0.75.4
// lineage) — they put bytes on a wire or into a persisted artifact that oracle also writes, so
// they are behavior, not packaging. Phase 6 adjudicated exactly this question ("0.75.4 vs 0.75.0",
// CONFIRMED, migration/reviews/mcp/findings.md), and every such site carries a `TODO(port):
// version literal must track oracle Cargo.toml` marker.
//
// The literals are correct today. The hazard is silence: when oracle bumps its version, nothing in
// this repo notices, and the literals quietly start lying. migration/post-parity-backlog.md bucket
// V calls this the only class in the whole backlog that will silently start lying. This check is
// the alarm — it reads the expected version FROM the oracle (never a second hardcoded copy here,
// which would be the same disease) and compares it against every site.
//
// Degrades gracefully: a clone without the oracle checkout (fresh clone, CI) gets a SKIP + exit 0,
// because the oracle is an external read-only checkout, not a build dependency of this repo.
//
// Usage:
//   node scripts/check-oracle-version.mjs                                # dir from sources.env
//   ORACLE_PIE_DIR=/path/to/pie node scripts/check-oracle-version.mjs    # explicit override

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const label = "check:oracle-version";

/**
 * Every site whose version literal must equal an oracle crate version.
 *
 * `crate` is the oracle crate whose `CARGO_PKG_VERSION` the Rust side interpolates at that point.
 * `pattern` must have exactly one capture group holding the version substring of the literal.
 * A pattern that stops matching is itself a failure: the site was renamed or restructured, and
 * whoever did that has to re-point this check rather than let it silently cover nothing.
 */
const sites = [
	{
		file: "packages/ai/src/utils/headers.ts",
		crate: "ai",
		pattern: /return "pie-ai-rs\/([^"]*)";/,
		oracle: "crates/ai/src/utils/headers.rs — User-Agent on outbound provider requests",
	},
	{
		file: "packages/coding-agent/src/cli/help.ts",
		crate: "coding-agent",
		pattern: /^export const CLI_VERSION = "([^"]*)";$/m,
		oracle: "crates/coding-agent/src/main.rs:61 `#[command(version)]` — `pie --version`, parity S1",
	},
	{
		file: "packages/coding-agent/src/lsp.ts",
		crate: "coding-agent",
		pattern: /^const ORACLE_CRATE_VERSION = "([^"]*)";$/m,
		oracle: "crates/coding-agent/src/lsp.rs — clientInfo.version on the LSP `initialize` wire",
	},
	{
		file: "packages/coding-agent/src/otlp.ts",
		crate: "coding-agent",
		pattern: /^const ORACLE_CRATE_VERSION = "([^"]*)";$/m,
		oracle: "crates/coding-agent/src/otlp.rs — service.version resource attribute",
	},
	{
		file: "packages/coding-agent/src/session-archive.ts",
		crate: "coding-agent",
		pattern: /^const ORACLE_CRATE_VERSION = "([^"]*)";$/m,
		oracle: "crates/coding-agent/src/session_archive.rs — version in the persisted .piesession manifest",
	},
	{
		file: "packages/coding-agent/src/tools/web-fetch.ts",
		crate: "coding-agent",
		pattern: /^const USER_AGENT = "pie\/([^"]*)";$/m,
		oracle: "crates/coding-agent/src/tools/web_fetch.rs — User-Agent header",
	},
	{
		file: "packages/coding-agent/src/tools/web-search.ts",
		crate: "coding-agent",
		pattern: /^const USER_AGENT = "pie\/([^"]*)";$/m,
		oracle: "crates/coding-agent/src/tools/web_search.rs — User-Agent header",
	},
	{
		file: "packages/mcp/src/client.ts",
		crate: "mcp",
		pattern: /^const MCP_CLIENT_VERSION = "([^"]*)";$/m,
		oracle: "crates/mcp/src/client.rs:29 — clientInfo.version in the MCP `initialize` request",
	},
	{
		file: "packages/mcp/src/http.ts",
		crate: "mcp",
		pattern: /^const MCP_PACKAGE_VERSION = "([^"]*)";$/m,
		oracle: "crates/mcp/src/http.rs:27-31 — serverInfo.version reported by the HTTP transport",
	},
];

function expandVars(value) {
	return (
		value
			.trim()
			.replace(/^~(?=\/|$)/, homedir())
			.replace(/\$\{?HOME\}?/g, homedir())
			// Handles both `$VAR` and `${VAR:-default}`. The default-value form matters because
			// sources.env uses it so that `source`-ing the file under `set -u` does not abort when
			// the variable is unset. A regex that only knows `${VAR}` leaves the `:-}` behind, then
			// reports a nonsense path and skips — while the checkout is sitting right there. A skip
			// reads as "checked" to anyone scanning the output, which is the worst of both.
			.replace(/\$\{(\w+):-([^}]*)\}/g, (_, name, dflt) => process.env[name] ?? dflt)
			.replace(/\$\{?(\w+)\}?/g, (_, name) => process.env[name] ?? "")
	);
}

/**
 * Reads ORACLE_PIE_DIR out of migration/sources.env without needing a shell to source it, applying
 * the same substitutions a shell would for the forms that file actually uses: `~`, `$HOME`, and
 * `${VAR:-default}`. An ORACLE_PIE_DIR already in the environment wins, mirroring
 * `migration/parity/lib/common.sh`, which sources sources.env into the env.
 */
function resolveOracleDir() {
	if (process.env.ORACLE_PIE_DIR) {
		return { dir: expandVars(process.env.ORACLE_PIE_DIR), origin: "ORACLE_PIE_DIR environment variable" };
	}

	const sourcesEnvPath = join(repoRoot, "migration", "sources.env");
	if (!existsSync(sourcesEnvPath)) {
		return { dir: undefined, origin: `${sourcesEnvPath} is missing` };
	}

	const match = readFileSync(sourcesEnvPath, "utf8").match(/^ORACLE_PIE_DIR=(.+)$/m);
	if (!match) {
		return { dir: undefined, origin: `${sourcesEnvPath} has no ORACLE_PIE_DIR entry` };
	}

	return { dir: expandVars(match[1]), origin: "ORACLE_PIE_DIR in migration/sources.env" };
}

/** `version = "x.y.z"` under a given TOML table header, or undefined. */
function readTomlVersion(tomlText, tableHeader) {
	const header = `[${tableHeader}]`;
	const tableStart = tomlText.indexOf(header);
	if (tableStart === -1) return undefined;
	const rest = tomlText.slice(tableStart + header.length);
	const nextTable = rest.search(/^\[/m);
	const table = nextTable === -1 ? rest : rest.slice(0, nextTable);
	return table.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
}

/** True for `version.workspace = true` or `version = { workspace = true }` in a crate manifest. */
function inheritsWorkspaceVersion(tomlText) {
	return /^version(?:\.workspace\s*=\s*true|\s*=\s*\{[^}]*workspace\s*=\s*true)/m.test(tomlText);
}

function crateVersion(oracleDir, crate, workspaceVersion) {
	const cargoTomlPath = join(oracleDir, "crates", crate, "Cargo.toml");
	if (!existsSync(cargoTomlPath)) {
		throw new Error(`oracle crate manifest not found: ${cargoTomlPath}`);
	}
	const text = readFileSync(cargoTomlPath, "utf8");
	const own = readTomlVersion(text, "package");
	if (own) return own;
	if (inheritsWorkspaceVersion(text) && workspaceVersion) return workspaceVersion;
	throw new Error(`no resolvable [package] version in ${cargoTomlPath}`);
}

function lineOf(text, index) {
	return text.slice(0, index).split("\n").length;
}

function skip(reason) {
	console.log(`${label}: SKIP — ${reason}`);
	console.log(
		`${label}: the ${sites.length} oracle-pinned version literals were NOT verified. They must equal the ` +
			"pie crate versions in the oracle's Cargo.toml (migration/post-parity-backlog.md bucket V). " +
			"Re-run where the oracle checkout named in migration/sources.env exists, or point " +
			"ORACLE_PIE_DIR at it.",
	);
	process.exit(0);
}

const { dir: oracleDir, origin } = resolveOracleDir();

if (!oracleDir) skip(`no oracle checkout path available: ${origin}`);
if (!existsSync(oracleDir)) skip(`oracle checkout not found at ${oracleDir} (${origin})`);

const workspaceCargoTomlPath = join(oracleDir, "Cargo.toml");
if (!existsSync(workspaceCargoTomlPath)) {
	skip(`${oracleDir} has no Cargo.toml (${origin}) — not a pie checkout`);
}

const workspaceVersion = readTomlVersion(readFileSync(workspaceCargoTomlPath, "utf8"), "workspace.package");

const failures = [];
const expectedByCrate = new Map();

for (const site of sites) {
	if (!expectedByCrate.has(site.crate)) {
		try {
			expectedByCrate.set(site.crate, crateVersion(oracleDir, site.crate, workspaceVersion));
		} catch (error) {
			expectedByCrate.set(site.crate, undefined);
			failures.push(`crates/${site.crate}: ${error.message}`);
		}
	}
	const expected = expectedByCrate.get(site.crate);
	if (expected === undefined) continue;

	const filePath = join(repoRoot, site.file);
	if (!existsSync(filePath)) {
		failures.push(`${site.file}: file not found — re-point this check (${site.oracle})`);
		continue;
	}

	const text = readFileSync(filePath, "utf8");
	const match = text.match(site.pattern);
	if (!match) {
		failures.push(
			`${site.file}: version literal not found (pattern ${site.pattern}) — the site was renamed or ` +
				"restructured; re-point scripts/check-oracle-version.mjs at it",
		);
		continue;
	}

	if (match[1] !== expected) {
		failures.push(
			`${site.file}:${lineOf(text, match.index)}: found "${match[1]}", oracle crates/${site.crate} is ` +
				`"${expected}" — ${site.oracle}`,
		);
	}
}

if (failures.length > 0) {
	console.error(`${label}: version literals must track the oracle's Cargo.toml, not this repo's package.json.`);
	console.error(`  oracle: ${oracleDir} (${origin})`);
	for (const failure of failures) console.error(`  ${failure}`);
	console.error("  Update the literal(s) above to the oracle version, then re-run the parity suite:");
	console.error("  packages/coding-agent/src/cli/help.ts feeds `pie --version`, which scenario S1 asserts");
	console.error("  byte-for-byte, so its baseline has to be re-captured against the new oracle.");
	process.exit(1);
}

const summary = [...expectedByCrate].map(([crate, version]) => `crates/${crate}=${version}`).join(" ");
console.log(`${label}: OK — ${sites.length} version literals match the oracle (${summary})`);
console.log(`  oracle: ${oracleDir} (${origin})`);
