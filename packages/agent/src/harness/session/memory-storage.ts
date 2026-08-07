import { SessionError, type SessionMetadata, type SessionStorage, type SessionTreeEntry } from "../types.ts";
import { uuidv7 } from "./uuid.ts";

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

function generateEntryId(byId: { has(id: string): boolean }): string {
	for (let i = 0; i < 100; i++) {
		const id = uuidv7().slice(0, 8);
		if (!byId.has(id)) return id;
	}
	return uuidv7();
}

function leafIdAfterEntry(entry: SessionTreeEntry): string | null {
	return entry.type === "leaf" ? entry.targetId : entry.id;
}

export class InMemorySessionStorage<TMetadata extends SessionMetadata = SessionMetadata>
	implements SessionStorage<TMetadata>
{
	private readonly metadata: TMetadata;
	private entries: SessionTreeEntry[];
	private byId: Map<string, SessionTreeEntry>;
	private labelsById: Map<string, string>;
	private leafId: string | null;

	constructor(options?: { entries?: SessionTreeEntry[]; metadata?: TMetadata }) {
		this.entries = options?.entries ? [...options.entries] : [];
		this.byId = new Map(this.entries.map((entry) => [entry.id, entry]));
		this.labelsById = buildLabelsById(this.entries);
		this.leafId = null;
		for (const entry of this.entries) this.leafId = leafIdAfterEntry(entry);
		if (this.leafId !== null && !this.byId.has(this.leafId)) {
			throw new SessionError("invalid_session", `Entry ${this.leafId} not found`);
		}
		this.metadata = options?.metadata ?? ({ id: uuidv7(), createdAt: new Date().toISOString() } as TMetadata);
	}

	async getMetadata(): Promise<TMetadata> {
		return this.metadata;
	}

	async getLeafId(): Promise<string | null> {
		// pie: crates/agent/src/harness/session/memory_storage.rs:60-62 (get_leaf_id) — plain
		// field read, unlike JsonlSessionStorage's replay-derived lookup; no existence check
		// against the entry table.
		return this.leafId;
	}

	async setLeafId(leafId: string | null): Promise<void> {
		// pie: crates/agent/src/harness/session/memory_storage.rs:64-67 (set_leaf_id) — oracle's
		// in-memory backend does NOT mirror JsonlSessionStorage's append-only `leaf` marker entry
		// (see jsonl-storage.ts setLeafId): it is a bare field assignment, with no `leaf` entry
		// created and no validation that `leafId` corresponds to a known entry. Bug-for-bug: a
		// caller can point the leaf at an id that does not exist.
		this.leafId = leafId;
	}

	async createEntryId(): Promise<string> {
		return generateEntryId(this.byId);
	}

	async appendEntry(entry: SessionTreeEntry): Promise<void> {
		this.entries.push(entry);
		this.byId.set(entry.id, entry);
		updateLabelCache(this.labelsById, entry);
		// pie: crates/agent/src/harness/session/memory_storage.rs:73-78 (append_entry) — always
		// moves the leaf pointer to the appended entry's own id, unlike JsonlSessionStorage's
		// leaf-type-aware replay (jsonl-storage.ts leafIdAfterEntry). A `leaf`-typed entry
		// appended directly through this method (not via setLeafId) does NOT redirect the leaf
		// pointer to its `targetId`.
		this.leafId = entry.id;
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
		// pie: crates/agent/src/harness/session/memory_storage.rs:88-117 (get_path_to_root).
		// Oracle walks the chain by id and treats the starting leaf the same as any ancestor: a
		// missing id anywhere (including the start) throws the same Corrupted "parent {id} not
		// found", and a repeated id (corrupted cyclic parent chain) throws "cycle in parent chain
		// at {id}" instead of looping forever. Mirrors the same fix already applied to
		// jsonl-storage.ts's getPathToRoot (jsonl_storage.rs:207-236).
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
