/**
 * Triage inbox (issue #23 — docs/issues/23-loops-inbox.md).
 *
 * Port of oracle `crates/coding-agent/src/inbox.rs` (pie @0a120dfd).
 *
 * Where loop findings land instead of interrupting the main chat or sinking into the audit log.
 * Global JSONL at `~/.pie/inbox.jsonl` (this port uses `config.ts`'s `getAgentDir()`, which is
 * phase 9's unified user-directory root — override via `PIE_DIR`/`ENV_BASE_DIR`, same override
 * oracle's `base_dir()` honors): loops run per-session, but the inbox is what you open in the
 * morning, wherever they ran.
 *
 * Concurrency (RULEBOOK §2.3 "faithful synchrony" — 2026-08-03 revision, pilot B): oracle guards every
 * write with a `parking_lot::Mutex` around synchronous `std::fs::*` calls (not `tokio::fs`),
 * the mechanical co-occurrence judgment the rule defines. This port therefore uses plain
 * synchronous `node:fs` calls with no lock wrapper — Node's single-threaded event loop makes
 * each synchronous critical section here atomic with respect to any other synchronous caller by
 * construction (same judgment already applied to `CronRegistry` in `triggers/cron.ts`). Cross-
 * process appends interleave fine (line-oriented, append-only); status rewrites are
 * last-writer-wins — acceptable for v1, matches oracle's own doc comment. Unparseable lines are
 * skipped on read, never deleted.
 *
 * The `/inbox` CLI command surface (oracle `commands.rs`) and its "inbox: empty — stateful loops
 * (/cron add --stateful) report findings here" text are a separate manifest row/phase — this
 * unit is the storage module only.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "./config.ts";

/** Cap on a single finding's text (Unicode scalar count, not bytes). oracle inbox.rs:17. */
export const MAX_ENTRY_TEXT_CHARS = 500;

/**
 * oracle inbox.rs:20-25 (`InboxStatus`, `#[serde(rename_all = "snake_case")]`). Unit-only enum
 * -> string literal union (RULEBOOK §2.1); the three Rust variants are already lowercase once
 * snake_cased, so the wire values equal the Rust identifiers lowercased verbatim.
 */
export type InboxStatus = "new" | "claimed" | "dismissed";

/**
 * oracle inbox.rs:27-36 (`InboxEntry`). Wire structure — one JSON object per line of
 * `inbox.jsonl` — so field names equal the oracle's serde output exactly (RULEBOOK §2.1), no
 * camelCase rename.
 */
export interface InboxEntry {
	id: string;
	created_at: string;
	source: string;
	text: string;
	trace_id: string;
	session_id: string;
	status: InboxStatus;
}

/** oracle inbox.rs:41-43 (`default_inbox_path`) — `base_dir()` maps to `getAgentDir()` (config.ts). */
export function defaultInboxPath(): string {
	return path.join(getAgentDir(), "inbox.jsonl");
}

/** oracle inbox.rs `uuid::Uuid::new_v4().simple()` — 32 lowercase hex chars, no dashes. */
function simpleUuid(): string {
	return randomUUID().replace(/-/g, "");
}

/**
 * Append a finding. Text is trimmed and capped at {@link MAX_ENTRY_TEXT_CHARS}. oracle
 * inbox.rs:46-77 (`append`).
 */
export function append(filePath: string, source: string, text: string, traceId: string, sessionId: string): InboxEntry {
	const trimmed = text.trim();
	const trimmedChars = [...trimmed];
	const cappedText =
		trimmedChars.length > MAX_ENTRY_TEXT_CHARS ? `${trimmedChars.slice(0, MAX_ENTRY_TEXT_CHARS).join("")}…` : trimmed;
	const entry: InboxEntry = {
		id: `inb-${simpleUuid()}`,
		created_at: new Date().toISOString(),
		source: [...source].slice(0, 80).join(""),
		text: cappedText,
		trace_id: traceId,
		session_id: sessionId,
		status: "new",
	};
	const dir = path.dirname(filePath);
	fs.mkdirSync(dir, { recursive: true });
	fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf8");
	return entry;
}

/** oracle inbox.rs:80-93 (`list`, shared read path). Missing file reads as empty. Unparseable
 * lines are skipped, never deleted. */
function readAll(filePath: string): InboxEntry[] {
	let text: string;
	try {
		text = fs.readFileSync(filePath, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}
	const out: InboxEntry[] = [];
	for (const line of text.split("\n")) {
		if (line.length === 0) continue;
		try {
			out.push(JSON.parse(line) as InboxEntry);
		} catch {
			// Unparseable lines are skipped on read, never deleted — oracle inbox.rs:88-92.
		}
	}
	return out;
}

/** All entries, oldest first. oracle inbox.rs:86-93 (`list`). */
export function list(filePath: string): InboxEntry[] {
	return readAll(filePath);
}

/** Entries with status `new`, oldest first. oracle inbox.rs:96-101 (`list_new`). */
export function listNew(filePath: string): InboxEntry[] {
	return readAll(filePath).filter((entry) => entry.status === "new");
}

/**
 * Count of `new` entries; `0` when the file is missing or unreadable (badge path — rendering
 * must never fail on inbox problems). oracle inbox.rs:104-107 (`new_count`).
 */
export function newCount(filePath: string): number {
	try {
		return listNew(filePath).length;
	} catch {
		return 0;
	}
}

/** Rewrite the full file (status changes). oracle inbox.rs:150-157 (`rewrite`). Corrupt lines
 * were already dropped by `readAll`, which is acceptable on an explicit mutation. */
function rewrite(filePath: string, entries: readonly InboxEntry[]): void {
	let out = "";
	for (const entry of entries) {
		out += `${JSON.stringify(entry)}\n`;
	}
	fs.writeFileSync(filePath, out, "utf8");
}

/**
 * Set one entry's status by id. Returns the updated entry, or `undefined` when absent. oracle
 * inbox.rs:113-129 (`set_status`). Mirrors the oracle's loop-over-all-entries shape exactly
 * (rather than stopping at the first match): if `id` were ever duplicated the last matching
 * entry's value is what gets returned, matching oracle's `for entry in &mut entries` behavior.
 */
export function setStatus(filePath: string, id: string, status: InboxStatus): InboxEntry | undefined {
	const entries = readAll(filePath);
	let updated: InboxEntry | undefined;
	for (const entry of entries) {
		if (entry.id === id) {
			entry.status = status;
			updated = { ...entry };
		}
	}
	if (updated !== undefined) {
		rewrite(filePath, entries);
	}
	return updated;
}

/** Dismiss every `new` entry; returns how many changed. oracle inbox.rs:132-142 (`dismiss_all_new`). */
export function dismissAllNew(filePath: string): number {
	const entries = readAll(filePath);
	let changed = 0;
	for (const entry of entries) {
		if (entry.status === "new") {
			entry.status = "dismissed";
			changed += 1;
		}
	}
	if (changed > 0) {
		rewrite(filePath, entries);
	}
	return changed;
}
