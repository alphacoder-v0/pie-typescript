/**
 * Persistent input history for the REPL.
 *
 * Port of oracle `crates/coding-agent/src/history.rs` (pie @0a120dfd).
 *
 * Each submitted prompt is appended to `~/.pie/history`, capped at MAX_ENTRIES. Subsequent
 * sessions load it; `/history` exposes the list. Wiring this store into the interactive-mode
 * editor's in-memory history (up/down recall) and the `/history` slash command is left to the
 * caller -- this port unit is the standalone data-layer file oracle's own history.rs is, same
 * "wiring left to caller" convention `memory.ts`/`git.ts`/`task.ts` establish for themselves
 * (see manifest note on this unit: "WIRES INTO tui editor in-memory history").
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "./config.ts";

/** pie: history.rs:10 (`MAX_ENTRIES`). */
const MAX_ENTRIES = 1000;

/**
 * pie: history.rs:12-79 (`HistoryStore`). A thin, synchronous append-only log capped at
 * {@link MAX_ENTRIES}, deduping only against the immediately-preceding entry.
 */
export class HistoryStore {
	private readonly path: string;
	private entriesList: string[];

	private constructor(path: string, entries: string[]) {
		this.path = path;
		this.entriesList = entries;
	}

	/** pie: history.rs:22-24 (`HistoryStore::default_path`) -- `<base_dir>/history`. */
	static defaultPath(): string {
		return join(getAgentDir(), "history");
	}

	/** pie: history.rs:18-20 (`HistoryStore::load`). */
	static load(): HistoryStore {
		return HistoryStore.loadFrom(HistoryStore.defaultPath());
	}

	/**
	 * pie: history.rs:26-37 (`HistoryStore::load_from`). A missing file (or any read failure)
	 * loads empty -- oracle's `unwrap_or_default()` on `std::fs::read_to_string`.
	 */
	static loadFrom(path: string): HistoryStore {
		let text = "";
		try {
			if (existsSync(path)) {
				text = readFileSync(path, "utf8");
			}
		} catch {
			text = "";
		}
		// pie: history.rs:29-33 splits with Rust's `str::lines()`, which recognizes BOTH `\n` and
		// `\r\n` as terminators and STRIPS the `\r`. A plain `split("\n")` would leave a trailing
		// CR on every line of a CRLF-written `~/.pie/history`, leaking dirty `\r` into `/history`
		// output, breaking `append`'s adjacent-dedupe compare, and round-tripping back through
		// `save()`. `/\r?\n/` reproduces oracle's behavior.
		const entries = text.split(/\r?\n/).filter((line) => line.trim() !== "");
		return new HistoryStore(path, entries);
	}

	/** pie: history.rs:39-41 (`HistoryStore::entries`). */
	entries(): readonly string[] {
		return [...this.entriesList];
	}

	/** pie: history.rs:43-46 (`HistoryStore::len`). */
	get length(): number {
		return this.entriesList.length;
	}

	/** pie: history.rs:48-51 (`HistoryStore::is_empty`). */
	isEmpty(): boolean {
		return this.entriesList.length === 0;
	}

	/**
	 * Append a fresh entry. Deduplicates with the immediately-preceding entry so spamming the
	 * same prompt twice doesn't litter the file. Caps total entries at {@link MAX_ENTRIES}
	 * (oldest dropped). Persists synchronously to the on-disk file; a persistence failure is
	 * swallowed (in-memory history stays usable even if the disk write fails), matching oracle's
	 * `let _ = self.save();` (history.rs:69).
	 * pie: history.rs:53-70 (`HistoryStore::append`).
	 */
	append(prompt: string): void {
		const trimmed = prompt.trim();
		if (!trimmed) return;
		if (this.entriesList[this.entriesList.length - 1] === trimmed) return;
		this.entriesList.push(trimmed);
		if (this.entriesList.length > MAX_ENTRIES) {
			const overflow = this.entriesList.length - MAX_ENTRIES;
			this.entriesList.splice(0, overflow);
		}
		try {
			this.save();
		} catch {
			// pie: `let _ = self.save();` -- persistence failures are ignored on purpose.
		}
	}

	/** pie: history.rs:72-78 (`HistoryStore::save`). */
	save(): void {
		const dir = dirname(this.path);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		const body = `${this.entriesList.join("\n")}\n`;
		writeFileSync(this.path, body);
	}
}
