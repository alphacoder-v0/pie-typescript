/**
 * `/bug-report` builder. Writes a single text dump to
 * `~/.pie/bug-reports/<utc-stamp>.txt` containing:
 *
 * 1. Diagnostic snapshot (model / thinking / tools / cost).
 * 2. Tail of the active session log file (up to 200 lines).
 * 3. The session transcript (rendered via `./export.ts`).
 *
 * Everything goes through a redactor that strips well-known secret patterns. Bug reports are
 * the canonical "give me something to attach to an issue" artifact, so we trade detail for
 * safety: the redactor is conservative.
 *
 * Port of oracle crates/coding-agent/src/bug_report.rs (whole file).
 *
 * This module owns the **authoritative** {@link redact}: `debug.ts` and `triggers/cron-deps.ts`
 * import it rather than carrying their own pattern lists.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Session } from "@pie/agent-core";
import { getAgentDir } from "./config.ts";
import { formatOsError } from "./core/tools/os-error.ts";
import { render } from "./export.ts";

/** pie: bug_report.rs:22. */
const MAX_LOG_LINES = 200;

/** The oracle crate's own version, which `env!("CARGO_PKG_VERSION")` bakes into the report body
 * (bug_report.rs:51). A literal, matching the `lsp.ts` / `otlp.ts` / `session-archive.ts`
 * precedent — this is oracle's version, not this package's. */
const ORACLE_CRATE_VERSION = "0.75.0";

/**
 * `chrono::Utc::now().format("%Y%m%dT%H%M%SZ")` — e.g. `20260804T025906Z`.
 * pie: bug_report.rs:25.
 */
function utcStamp(now: Date): string {
	return `${now
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d+Z$/, "")}Z`;
}

/**
 * `chrono::DateTime::<Utc>::to_rfc3339()` — chrono renders the UTC offset as `+00:00`, not `Z`.
 * pie: bug_report.rs:50.
 * Precision note: chrono keeps sub-millisecond digits where the clock provides them, JS `Date`
 * only milliseconds. The field is human-facing text in a bug report, so the narrower precision
 * stands rather than fabricating trailing zeros.
 */
function toRfc3339(now: Date): string {
	return now.toISOString().replace(/Z$/, "+00:00");
}

/** pie: bug_report.rs:24-27 (`default_dest`). */
export function defaultDest(now: Date = new Date()): string {
	return join(getAgentDir(), "bug-reports", `${utcStamp(now)}.txt`);
}

/**
 * Snapshot of harness state that lives outside the harness itself. The caller fills it in
 * from CommandCtx so this module stays decoupled from the slash-command layer.
 *
 * pie: bug_report.rs:29-39 (`struct DiagInputs`). `Option<T>` → `T | undefined` (RULEBOOK §2.1).
 */
export interface DiagInputs {
	sessionId: string;
	model?: string;
	thinking: string;
	toolCount: number;
	skillCount: number;
	costSummary: string;
	logPath?: string;
}

/**
 * Rust `str::lines()`: split on `\n`, drop a trailing `\r` from each line, and do not yield a
 * final empty line for a trailing newline. `String.split("\n")` differs on that last point.
 */
function rustLines(text: string): string[] {
	const parts = text.split("\n");
	if (parts.length > 0 && parts[parts.length - 1] === "") {
		parts.pop();
	}
	return parts.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/**
 * pie: bug_report.rs:41-110 (`build`). Body layout is byte-for-byte oracle's, including the
 * column padding in the diagnostic block and the `(none)` / `(disabled)` placeholders.
 */
export async function build(diag: DiagInputs, session: Session, dest: string, now: Date = new Date()): Promise<string> {
	const parent = dirname(dest);
	if (parent) {
		try {
			await mkdir(parent, { recursive: true });
		} catch (cause) {
			throw new Error(`create bug-reports dir ${parent}`, { cause });
		}
	}

	let body = "";
	body += "pie bug report\n";
	body += `generated_at: ${toRfc3339(now)}\n`;
	body += `pie_version: ${ORACLE_CRATE_VERSION}\n`;
	body += "\n";

	body += "---- diagnostic ----\n";
	body += `session_id    ${diag.sessionId}\n`;
	body += `model         ${diag.model ?? "(none)"}\n`;
	body += `thinking      ${diag.thinking}\n`;
	body += `tools         ${diag.toolCount}\n`;
	body += `skills        ${diag.skillCount}\n`;
	body += `cost          ${diag.costSummary}\n`;
	body += `log_path      ${diag.logPath ?? "(disabled)"}\n`;
	body += "\n";

	if (diag.logPath !== undefined) {
		body += `---- log tail (${MAX_LOG_LINES} lines from ${diag.logPath}) ----\n`;
		try {
			const text = await readFile(diag.logPath, "utf-8");
			const lines = rustLines(text);
			const tail = lines.length > MAX_LOG_LINES ? lines.slice(lines.length - MAX_LOG_LINES) : lines;
			for (const line of tail) {
				body += `${line}\n`;
			}
		} catch (e) {
			// pie: bug_report.rs:92-94. The interpolated text is `std::io::Error`'s Display.
			//
			// This used to emit Node's raw `ENOENT: ... open '...'` on the stated grounds that the
			// two runtimes' wording "differs". They no longer have to: `formatOsError`
			// (core/tools/os-error.ts, phase 19) recovers the errno from `err.errno` and the glibc
			// sentence from a code table, so a bug report filed from this port now reads the same
			// as one filed from oracle.
			body += `(cannot read log: ${formatOsError(e)})\n`;
		}
		body += "\n";
	}

	body += "---- transcript ----\n";
	try {
		body += await render(session);
	} catch (e) {
		// pie: bug_report.rs:102.
		body += `(cannot render transcript: ${e instanceof Error ? e.message : String(e)})\n`;
	}

	const redacted = redact(body);
	try {
		await writeFile(dest, redacted);
	} catch (cause) {
		throw new Error(`write ${dest}`, { cause });
	}
	return dest;
}

/**
 * pie: bug_report.rs:125-156 (`REDACTORS`).
 *
 * Order is behaviour: the substitutions are applied sequentially over the accumulating output, so
 * an earlier pattern can consume text a later one would otherwise have matched. Keep oracle's
 * order. Every regex carries the `g` flag because Rust's `replace_all` replaces every occurrence.
 */
const REDACTORS: ReadonlyArray<readonly [label: string, pattern: RegExp]> = [
	// OpenAI / Anthropic / Stripe-style keys ("sk-..." prefix, 20+ alnum after). bug_report.rs:128.
	["openai_anthropic_key", /sk-[A-Za-z0-9_-]{20,}/g],
	// AWS access key id (always 20 chars, AKIA or ASIA prefix). bug_report.rs:130.
	["aws_access_key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
	// GitHub PATs (40 chars after `gho_` / `ghp_` / `ghu_` / `ghs_`). bug_report.rs:132.
	["github_token", /\bgh[ousp]_[A-Za-z0-9]{30,}\b/g],
	// Slack tokens. bug_report.rs:134.
	["slack_token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g],
	// Google API keys (39 chars after AIza). bug_report.rs:136.
	["google_api_key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
	// Generic Bearer tokens in HTTP-style strings. bug_report.rs:138.
	["bearer_token", /Bearer\s+[A-Za-z0-9._-]{16,}/g],
	// Hub browser login and loopback callback URLs can carry auth state or one-time codes.
	// bug_report.rs:140,142-144.
	["pie_hub_login_url", /https?:\/\/[^\s]+\/login\?[^\s]+/g],
	["pie_hub_callback_url", /http:\/\/127\.0\.0\.1:[0-9]+\/callback(?:\?[^\s]+)?/g],
	// pie hub session / agent credentials can appear as bare values in transport errors.
	// bug_report.rs:146.
	["pie_hub_token", /\bhub_(?:agent|hs)_[A-Za-z0-9._-]{8,}\b/g],
	// Hub/user-visible diagnostics should not expose raw immutable IDs. bug_report.rs:148-151.
	["uuid", /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g],
];

/**
 * Apply every secret-pattern regex to `input`. Each match is replaced with a fixed
 * placeholder that names which class of secret was caught so the user can verify which
 * rules fired without leaking detail.
 *
 * pie: bug_report.rs:112-123 (`redact`).
 */
export function redact(input: string): string {
	let out = input;
	for (const [label, pattern] of REDACTORS) {
		out = out.replace(pattern, `[REDACTED:${label}]`);
	}
	return out;
}
