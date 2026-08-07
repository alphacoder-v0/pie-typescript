import type { Message } from "@pie/ai";
import type { AgentMessage } from "../../types.ts";

/** File paths touched by a session branch or compaction range. */
export interface FileOperations {
	/** Files read but not necessarily modified. */
	read: Set<string>;
	/** Files written by full-file write operations. */
	written: Set<string>;
	/** Files modified by edit operations. */
	edited: Set<string>;
}

/** Create an empty file-operation accumulator. */
export function createFileOps(): FileOperations {
	return {
		read: new Set(),
		written: new Set(),
		edited: new Set(),
	};
}

/** Add file operations from assistant tool calls to an accumulator. */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
	if (message.role !== "assistant") return;
	if (!("content" in message) || !Array.isArray(message.content)) return;

	for (const block of message.content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "toolCall") continue;
		if (!("arguments" in block) || !("name" in block)) continue;

		const args = block.arguments as Record<string, unknown> | undefined;
		if (!args) continue;

		const path = typeof args.path === "string" ? args.path : undefined;
		if (!path) continue;

		switch (block.name) {
			case "read":
				fileOps.read.add(path);
				break;
			case "write":
				fileOps.written.add(path);
				break;
			case "edit":
				fileOps.edited.add(path);
				break;
		}
	}
}

/** Compute sorted read-only and modified file lists from accumulated operations. */
export function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles: readOnly, modifiedFiles };
}

/** Format file lists as summary metadata tags. */
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	if (readFiles.length > 0) {
		sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	}
	if (modifiedFiles.length > 0) {
		sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	}
	if (sections.length === 0) return "";
	return `\n\n${sections.join("\n\n")}`;
}

/**
 * Safe JSON stringify for tool-call arguments. `arguments` is always a plain JSON-shaped object
 * in practice (parsed from a provider tool-call payload), so this should never throw — the catch
 * is a defensive fallback, mirroring the equivalent local helper in compaction.ts.
 */
function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "{}";
	} catch {
		return "[unserializable]";
	}
}

/**
 * Serialize LLM messages to a raw text dump for the summarizer prompt. Byte-for-byte port of
 * oracle's `serialize_conversation`: role-prefixed sections in original message order, content
 * blocks concatenated in original order with no separators beyond each block's own markup, and
 * no truncation of any kind (the base's prior per-tool-result truncation at 2000 chars was a
 * base-only divergence and has been removed — see compaction.ts's `shrinkMessagesForOverflowRetry`
 * for how provider context-overflow is actually handled, upstream of this function).
 * pie: crates/agent/src/harness/compaction/compaction.rs:286-342
 */
export function serializeConversation(messages: Message[]): string {
	let out = "";

	for (const msg of messages) {
		switch (msg.role) {
			case "user": {
				// pie: crates/agent/src/harness/compaction/compaction.rs:290-304
				out += "USER:\n";
				if (typeof msg.content === "string") {
					out += msg.content;
				} else {
					for (const block of msg.content) {
						if (block.type === "text") {
							out += block.text;
						} else if (block.type === "image") {
							out += "<image>";
						}
					}
				}
				out += "\n\n";
				break;
			}
			case "assistant": {
				// pie: crates/agent/src/harness/compaction/compaction.rs:305-326 — oracle's
				// ContentBlock::Image arm renders "<image>" here too, but @pie/ai's
				// AssistantMessage.content type (text | thinking | toolCall) structurally can't
				// carry an image block, so there's nothing to overlay (same observation as
				// compaction.ts:260-264 for estimateTokens).
				out += "ASSISTANT:\n";
				for (const block of msg.content) {
					if (block.type === "text") {
						out += block.text;
					} else if (block.type === "thinking") {
						out += `<thinking>${block.thinking}</thinking>`;
					} else if (block.type === "toolCall") {
						out += `<tool_call name="${block.name}">${safeJsonStringify(block.arguments)}</tool_call>`;
					}
				}
				out += "\n\n";
				break;
			}
			case "toolResult": {
				// pie: crates/agent/src/harness/compaction/compaction.rs:327-335 — only text blocks
				// contribute; image blocks in tool results are silently dropped here (unlike the
				// USER branch above, which renders them as "<image>").
				out += `TOOL_RESULT[${msg.toolName}]:\n`;
				for (const block of msg.content) {
					if (block.type === "text") {
						out += block.text;
					}
				}
				out += "\n\n";
				break;
			}
		}
	}

	return out;
}
