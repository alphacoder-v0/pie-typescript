#!/usr/bin/env node
/**
 * CLI entry point for the refactored coding agent.
 * Uses main.ts with AgentSession and new mode modules.
 *
 * Test with: npx tsx src/cli-new.ts [args...]
 */
import { writeSync } from "node:fs";
import { APP_NAME } from "./config.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { restoreStdout } from "./core/output-guard.ts";
import { main } from "./main.ts";
import { describeErrorChain } from "./utils/error-chain.ts";

process.title = APP_NAME;
process.env.PI_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

// Configure undici's global dispatcher before provider SDKs issue requests.
// Runtime settings are applied once SettingsManager has loaded global/project settings.
configureHttpDispatcher();

/**
 * pie: oracle's entry is `#[tokio::main] async fn main() -> Result<()>` (main.rs:217). Anything it
 * returns as `Err` is printed by anyhow's `Termination` impl — `Error: {msg}` on stderr, plus the
 * `Caused by:` chain, exit 1 — and nothing else. There is no stack, no path, no runtime version.
 *
 * Node's default for a rejected top-level promise is the opposite: phase 19's F7 measured
 * `pie --web --web-host 10.1.2.3` answering with four absolute
 * `file:///…/packages/coding-agent/dist/…` paths, the offending source line, frame line numbers and
 * `Node.js v22.22.1` — with oracle's actual one-line message buried in the middle of it. Every
 * error inside `main` that is not caught closer to where it happened lands here, so this is the one
 * place that has to turn a rejection back into oracle's shape.
 *
 * `restoreStdout` first: `takeOverStdout()` (core/output-guard.ts) may be installed, and the guard
 * has to come off before the process ends. `writeSync` because `process.exit` does not flush an
 * async pipe write. `describeErrorChain` is the same anyhow layout the malformed-`models.json` path
 * uses (F6), so a wrapped error keeps its `Caused by:` lines here too.
 */
main(process.argv.slice(2)).catch((error: unknown) => {
	restoreStdout();
	writeSync(2, `Error: ${describeErrorChain(error)}\n`);
	process.exit(1);
});
