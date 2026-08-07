import type { FileSystem, JsonlSessionMetadata, LeafEntry, SessionStorage, SessionTreeEntry } from "../types.ts";
import { SessionError, toError } from "../types.ts";
import { getFileSystemResultOrThrow } from "./repo-utils.ts";
import { uuidv7 } from "./uuid.ts";

type JsonlSessionStorageFileSystem = Pick<FileSystem, "readTextFile" | "readTextLines" | "writeFile" | "appendFile">;

interface SessionHeader {
	type: "session";
	version: 3;
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
}

function updateLabelCache(labelsById: Map<string, string>, entry: SessionTreeEntry): void {
	if (entry.type !== "label") return;
	const label = entry.label?.trim();
	if (label) {
		labelsById.set(entry.targetId, label);
	} else {
		labelsById.delete(entry.targetId);
	}
}

function buildLabelsById(entries: SessionTreeEntry[]): Map<string, string> {
	const labelsById = new Map<string, string>();
	for (const entry of entries) {
		updateLabelCache(labelsById, entry);
	}
	return labelsById;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function invalidSession(filePath: string, message: string, cause?: Error): SessionError {
	return new SessionError("invalid_session", `Invalid JSONL session file ${filePath}: ${message}`, cause);
}

function invalidEntry(filePath: string, lineNumber: number, message: string, cause?: Error): SessionError {
	return new SessionError(
		"invalid_entry",
		`Invalid JSONL session file ${filePath}: line ${lineNumber} ${message}`,
		cause,
	);
}

function parseHeaderLine(line: string, filePath: string): SessionHeader {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		throw invalidSession(filePath, "first line is not a valid session header", toError(error));
	}
	if (!isRecord(parsed)) throw invalidSession(filePath, "first line is not a valid session header");
	if (parsed.type !== "session") throw invalidSession(filePath, "first line is not a valid session header");
	if (parsed.version !== 3) throw invalidSession(filePath, "unsupported session version");
	if (typeof parsed.id !== "string" || !parsed.id) throw invalidSession(filePath, "session header is missing id");
	if (typeof parsed.timestamp !== "string" || !parsed.timestamp) {
		throw invalidSession(filePath, "session header is missing timestamp");
	}
	if (typeof parsed.cwd !== "string" || !parsed.cwd) throw invalidSession(filePath, "session header is missing cwd");
	if (parsed.parentSession !== undefined && typeof parsed.parentSession !== "string") {
		throw invalidSession(filePath, "session header parentSession must be a string");
	}
	return {
		type: "session",
		version: 3,
		id: parsed.id,
		timestamp: parsed.timestamp,
		cwd: parsed.cwd,
		parentSession: parsed.parentSession,
	};
}

function parseEntryLine(line: string, filePath: string, lineNumber: number): SessionTreeEntry {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		throw invalidEntry(filePath, lineNumber, "is not valid JSON", toError(error));
	}
	if (!isRecord(parsed)) throw invalidEntry(filePath, lineNumber, "is not a valid session entry");
	if (typeof parsed.type !== "string") throw invalidEntry(filePath, lineNumber, "is missing entry type");
	if (typeof parsed.id !== "string" || !parsed.id) throw invalidEntry(filePath, lineNumber, "is missing entry id");
	if (parsed.parentId !== null && typeof parsed.parentId !== "string") {
		throw invalidEntry(filePath, lineNumber, "has invalid parentId");
	}
	if (typeof parsed.timestamp !== "string" || !parsed.timestamp) {
		throw invalidEntry(filePath, lineNumber, "is missing timestamp");
	}
	if (parsed.type === "leaf" && parsed.targetId !== null && typeof parsed.targetId !== "string") {
		throw invalidEntry(filePath, lineNumber, "has invalid targetId");
	}
	return parsed as unknown as SessionTreeEntry;
}

function leafIdAfterEntry(entry: SessionTreeEntry): string | null {
	return entry.type === "leaf" ? entry.targetId : entry.id;
}

/**
 * What a load that still genuinely fails should tell the user to do instead. Flags verified
 * against packages/coding-agent/src/cli/help.ts:122-129 (`--resume`, `-c`/`--continue`,
 * `--resume-id <ID>`, `--list-sessions`) — do not name a flag that is not in that table.
 * `--continue` is deliberately not suggested: it opens the *most recent* session, which is
 * exactly the one that just failed to load.
 */
const SESSION_RECOVERY_HINT =
	"Run `pie --list-sessions` to see the sessions for this directory, then `pie --resume-id <ID>` to open the newest one that still loads. Plain `pie` starts a fresh session.";

function withRecoveryHint(error: unknown): unknown {
	if (!(error instanceof SessionError)) return error;
	return new SessionError(error.code, `${error.message}\n${SESSION_RECOVERY_HINT}`, error);
}

/**
 * A trailing partial line that was dropped so the healthy prefix before it could load — the
 * normal shape of a transcript whose writer died mid-append. Deliberately module-private: the twin
 * in packages/coding-agent/src/core/session-manager.ts is a separate copy, because that package is
 * consumed through this one's built `dist/` and the CLI must not need a fresh sibling build to
 * start. Both copies are pinned by exact-string assertions in their own tests, so drift is caught.
 */
interface SalvagedSessionTail {
	filePath: string;
	sessionId: string;
	/** 1-based line number in the file as written (blank lines counted). */
	lineNumber: number;
	/** Complete entries kept from the healthy prefix (header excluded). */
	keptEntries: number;
	/** Parser detail for the dropped line, kept for callers that want to log it. */
	reason: string;
}

/**
 * One short line on **stderr** — never stdout, which in TUI mode belongs to the renderer and in
 * `--list-sessions` mode is machine-read output. A salvage the user is not told about is a
 * data-loss bug of its own, so this is not optional and not debug-gated.
 */
function formatSalvagedTailNotice(salvage: SalvagedSessionTail): string {
	const kept = `${salvage.keptEntries} complete ${salvage.keptEntries === 1 ? "entry" : "entries"}`;
	return `Warning: session ${salvage.sessionId}: discarded a partial final entry (line ${salvage.lineNumber} of ${salvage.filePath}) left by an interrupted write; kept ${kept} and truncated the file to that healthy prefix.`;
}

function headerToSessionMetadata(header: SessionHeader, path: string): JsonlSessionMetadata {
	return {
		id: header.id,
		createdAt: header.timestamp,
		cwd: header.cwd,
		path,
		parentSessionPath: header.parentSession,
	};
}

export async function loadJsonlSessionMetadata(
	fs: JsonlSessionStorageFileSystem,
	filePath: string,
): Promise<JsonlSessionMetadata> {
	const lines = getFileSystemResultOrThrow(
		await fs.readTextLines(filePath, { maxLines: 1 }),
		`Failed to read session header ${filePath}`,
	);
	const line = lines[0];
	if (line?.trim()) return headerToSessionMetadata(parseHeaderLine(line, filePath), filePath);
	throw invalidSession(filePath, "missing session header");
}

async function loadJsonlStorage(
	fs: JsonlSessionStorageFileSystem,
	filePath: string,
): Promise<{
	header: SessionHeader;
	entries: SessionTreeEntry[];
	leafId: string | null;
	salvagedTail?: SalvagedSessionTail;
	/** Byte-verbatim healthy prefix, present only when `salvagedTail` is. */
	repairedContent?: string;
}> {
	const content = getFileSystemResultOrThrow(await fs.readTextFile(filePath), `Failed to read session ${filePath}`);
	// Raw lines, not a filtered copy: the salvage rule below turns on a line's *position in the
	// file*, so the index must survive blank lines.
	const rawLines = content.split("\n");
	const firstContentIndex = rawLines.findIndex((line) => line.trim() !== "");
	if (firstContentIndex === -1) {
		// Edge case: empty (or all-whitespace) file. Nothing to salvage — there is no header and
		// therefore no session identity — so this stays a hard failure, as in the oracle.
		throw withRecoveryHint(invalidSession(filePath, "missing session header"));
	}
	let lastContentIndex = firstContentIndex;
	for (let i = rawLines.length - 1; i > firstContentIndex; i--) {
		if (rawLines[i]!.trim() !== "") {
			lastContentIndex = i;
			break;
		}
	}

	// Edge case: a file that is a single partial line. That line is the *header*, and the header
	// is never salvageable — dropping it would leave a session with no id, no cwd and no healthy
	// prefix to keep. It fails, with the recovery hint attached.
	let header: SessionHeader;
	try {
		header = parseHeaderLine(rawLines[firstContentIndex]!, filePath);
	} catch (error) {
		throw withRecoveryHint(error);
	}

	const entries: SessionTreeEntry[] = [];
	let leafId: string | null = null;
	let salvagedTail: SalvagedSessionTail | undefined;
	// pie: crates/agent/src/harness/session/jsonl_storage.rs:97-118 (load_entries).
	//
	// PORT-DIVERGENCE: B8 (RULEBOOK §5). **Fixed in phase 18 — this no longer matches oracle.**
	//
	// Oracle's loop is `serde_json::from_str(line).map_err(...)?` per line, so *any* unparseable
	// line fails the entire load and `--resume`/`--continue` refuse the session outright. A
	// truncated final line is the ordinary result of a process dying mid-append, so oracle throws
	// away an arbitrarily long healthy conversation over the last partial write — while
	// `--list-sessions` (header-only, jsonl_storage.rs:68-84) keeps listing the session happily.
	// The user is shown a session that exists and cannot be opened.
	//
	// Here a parse failure on the **last** content line of the file drops that one line and
	// returns the healthy prefix; a parse failure on any **earlier** line still fails the whole
	// load. That discrimination is the point: only the tail can be a torn append, so mid-file
	// corruption is a different fault, and skipping it would silently drop every entry after it.
	// "Last line" is judged by position, not by *why* the line failed — a torn write cannot be
	// told apart from a complete-but-invalid final record with any reliability, the blast radius
	// is one trailing entry either way, and the stderr notice reports both identically rather
	// than hiding either.
	for (let i = firstContentIndex + 1; i <= lastContentIndex; i++) {
		const line = rawLines[i]!;
		if (line.trim() === "") continue;
		let entry: SessionTreeEntry;
		try {
			entry = parseEntryLine(line, filePath, i + 1);
		} catch (error) {
			if (i !== lastContentIndex) throw withRecoveryHint(error);
			salvagedTail = {
				filePath,
				sessionId: header.id,
				lineNumber: i + 1,
				keptEntries: entries.length,
				reason: error instanceof Error ? error.message : String(error),
			};
			break;
		}
		entries.push(entry);
		leafId = leafIdAfterEntry(entry);
	}
	if (salvagedTail) {
		return {
			header,
			entries,
			leafId,
			salvagedTail,
			repairedContent: `${rawLines.slice(0, lastContentIndex).join("\n")}\n`,
		};
	}
	return { header, entries, leafId };
}

export class JsonlSessionStorage implements SessionStorage<JsonlSessionMetadata> {
	private readonly fs: JsonlSessionStorageFileSystem;
	private readonly filePath: string;
	private readonly metadata: JsonlSessionMetadata;
	private entries: SessionTreeEntry[];
	private byId: Map<string, SessionTreeEntry>;
	private labelsById: Map<string, string>;
	private currentLeafId: string | null;

	private constructor(
		fs: JsonlSessionStorageFileSystem,
		filePath: string,
		header: SessionHeader,
		entries: SessionTreeEntry[],
		leafId: string | null,
	) {
		this.fs = fs;
		this.filePath = filePath;
		this.metadata = headerToSessionMetadata(header, this.filePath);
		this.entries = entries;
		this.byId = new Map(entries.map((entry) => [entry.id, entry]));
		this.labelsById = buildLabelsById(entries);
		this.currentLeafId = leafId;
	}

	static async open(fs: JsonlSessionStorageFileSystem, filePath: string): Promise<JsonlSessionStorage> {
		const loaded = await loadJsonlStorage(fs, filePath);
		if (loaded.salvagedTail && loaded.repairedContent !== undefined) {
			// Repair before narrating, and before this handle can append. Without the truncation the
			// dropped tail line would still be on disk, so the very next `appendEntry` would push it
			// into the *middle* of the file and the session would become permanently unloadable —
			// salvage without repair is a worse bug than the one being fixed. Byte-verbatim prefix,
			// not a re-serialization, so nothing but the torn line changes.
			getFileSystemResultOrThrow(
				await fs.writeFile(filePath, loaded.repairedContent),
				`Failed to repair session ${filePath} after dropping its partial final entry`,
			);
			process.stderr.write(`${formatSalvagedTailNotice(loaded.salvagedTail)}\n`);
		}
		return new JsonlSessionStorage(fs, filePath, loaded.header, loaded.entries, loaded.leafId);
	}

	static async create(
		fs: JsonlSessionStorageFileSystem,
		filePath: string,
		options: {
			cwd: string;
			sessionId: string;
			parentSessionPath?: string;
		},
	): Promise<JsonlSessionStorage> {
		const header: SessionHeader = {
			type: "session",
			version: 3,
			id: options.sessionId,
			timestamp: new Date().toISOString(),
			cwd: options.cwd,
			parentSession: options.parentSessionPath,
		};
		getFileSystemResultOrThrow(
			await fs.writeFile(filePath, `${JSON.stringify(header)}\n`),
			`Failed to create session ${filePath}`,
		);
		return new JsonlSessionStorage(fs, filePath, header, [], null);
	}

	async getMetadata(): Promise<JsonlSessionMetadata> {
		return this.metadata;
	}

	async getLeafId(): Promise<string | null> {
		if (this.currentLeafId !== null && !this.byId.has(this.currentLeafId)) {
			throw new SessionError("invalid_session", `Entry ${this.currentLeafId} not found`);
		}
		return this.currentLeafId;
	}

	async setLeafId(leafId: string | null): Promise<void> {
		if (leafId !== null && !this.byId.has(leafId)) {
			throw new SessionError("not_found", `Entry ${leafId} not found`);
		}
		// pie: crates/agent/src/harness/session/jsonl_storage.rs:167-176 (set_leaf_id) — entry id
		// is a plain uuidv7(), not a truncated/collision-retried slice (see createEntryId below).
		const entry: LeafEntry = {
			type: "leaf",
			id: uuidv7(),
			parentId: this.currentLeafId,
			timestamp: new Date().toISOString(),
			targetId: leafId,
		};
		getFileSystemResultOrThrow(
			await this.fs.appendFile(this.filePath, `${JSON.stringify(entry)}\n`),
			`Failed to append session leaf ${entry.id}`,
		);
		this.entries.push(entry);
		this.byId.set(entry.id, entry);
		this.currentLeafId = leafId;
	}

	async createEntryId(): Promise<string> {
		// pie: crates/agent/src/harness/session/jsonl_storage.rs:178-180 (create_entry_id) —
		// oracle always returns the full uuidv7(), never a truncated/shortened id.
		return uuidv7();
	}

	async appendEntry(entry: SessionTreeEntry): Promise<void> {
		getFileSystemResultOrThrow(
			await this.fs.appendFile(this.filePath, `${JSON.stringify(entry)}\n`),
			`Failed to append session entry ${entry.id}`,
		);
		this.entries.push(entry);
		this.byId.set(entry.id, entry);
		updateLabelCache(this.labelsById, entry);
		this.currentLeafId = leafIdAfterEntry(entry);
	}

	async getEntry(id: string): Promise<SessionTreeEntry | undefined> {
		return this.byId.get(id);
	}

	async findEntries<TType extends SessionTreeEntry["type"]>(
		type: TType,
	): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>> {
		return this.entries.filter((entry): entry is Extract<SessionTreeEntry, { type: TType }> => entry.type === type);
	}

	async getLabel(id: string): Promise<string | undefined> {
		return this.labelsById.get(id);
	}

	async getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]> {
		if (leafId === null) return [];
		// pie: crates/agent/src/harness/session/jsonl_storage.rs:207-236 (get_path_to_root).
		// Oracle walks the chain by id and treats the starting leaf the same as any ancestor: a
		// missing id anywhere (including the start) throws the same Corrupted "parent {id} not
		// found", and a repeated id (corrupted cyclic parent chain) throws "cycle in parent chain
		// at {id}" instead of looping forever — the base implementation had neither guard.
		const path: SessionTreeEntry[] = [];
		const seen = new Set<string>();
		let currentId: string | null = leafId;
		while (currentId !== null) {
			if (seen.has(currentId)) {
				throw new SessionError("invalid_session", `cycle in parent chain at ${currentId}`);
			}
			seen.add(currentId);
			const current: SessionTreeEntry | undefined = this.byId.get(currentId);
			if (!current) throw new SessionError("invalid_session", `parent ${currentId} not found`);
			path.unshift(current);
			currentId = current.parentId;
		}
		return path;
	}

	async getEntries(): Promise<SessionTreeEntry[]> {
		return [...this.entries];
	}
}
