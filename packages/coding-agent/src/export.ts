/**
 * Session-to-Markdown export. Port of oracle `crates/coding-agent/src/export.rs` (pie
 * @0a120dfd). Walks the session's active branch (via `Session.buildContext()`, the same
 * `@pie/agent-core` harness abstraction oracle's own `pie_agent_core::{Session, SessionContext}`
 * imports 1:1) and renders a human-readable transcript: one heading per message kind,
 * code-fenced tool I/O, model and thinking-level annotated inline.
 *
 * Used by `/save` and (in a follow-up) `/share` once a paste backend is added -- same as
 * oracle. NOT wired into `core/slash-commands.ts`/`modes/interactive/interactive-mode.ts` here
 * (both out of this unit's scope).
 *
 * diff-port note (manifest `coding-agent/export`, curated semantic map to pi counterpart): the
 * manifest's base_path is `core/export-html/` -- pi's pre-existing session-to-**HTML** exporter
 * (theme colors, `AgentState`/`SessionEntry` from `core/session-manager.ts`'s bespoke JSONL
 * format). That exporter has no code worth sharing here: different output format (HTML vs.
 * Markdown), different session data model (session-manager.ts's own format vs. the
 * `@pie/agent-core` harness `Session`/`SessionContext` oracle's `export.rs` actually imports).
 * "Curated" means "nearest pi precedent for the general concept of exporting a session to a
 * file", not "diff against this file's code" -- this unit is therefore closer to a fresh port of
 * oracle's rendering logic than a literal diff overlay, built against the harness `Session` type
 * (the same abstraction level oracle's own crate boundary uses) rather than session-manager.ts's
 * separate, out-of-scope format.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentMessage, Session, SessionContext } from "@pie/agent-core";
import type { AssistantMessage, ImageContent, TextContent, ToolCall } from "@pie/ai";
import { getAgentDir } from "./config.ts";

/** pie: export.rs:14-17 (`render`). */
export async function render(session: Session): Promise<string> {
	const ctx = await session.buildContext();
	return renderContext(ctx);
}

/** pie: export.rs:19-83 (`render_context`). */
export function renderContext(ctx: SessionContext): string {
	let out = "# Session Transcript\n\n";
	if (ctx.model) {
		out += `- Model: \`${ctx.model.provider}:${ctx.model.modelId}\`\n`;
	}
	out += `- Thinking level: \`${ctx.thinkingLevel}\`\n`;
	out += `- Messages: ${ctx.messages.length}\n`;
	out += "\n";

	ctx.messages.forEach((m, i) => {
		out += renderMessage(i, m);
	});
	return out;
}

/** pie: export.rs:32-80 (the `for (i, m) in ctx.messages.iter().enumerate()` match arms). */
function renderMessage(i: number, m: AgentMessage): string {
	switch (m.role) {
		case "user":
			return `## ${i}. User\n\n${renderUserContent(m.content)}\n\n`;
		case "assistant":
			return `## ${i}. Assistant\n\n${renderAssistantContent(m)}`;
		case "toolResult":
			return `### tool result \`${m.toolCallId}\`\n\n${renderUserContent(m.content)}\n\n`;
		default:
			// pie: export.rs:73-79 (`AgentMessage::Custom(c)`) -- oracle's `AgentMessage` enum has
			// exactly two variants, `Llm(Message)` and a generic `Custom` catch-all rendered as
			// `### custom: {role}` + pretty-printed JSON payload. TS's `AgentMessage` union
			// (`Message | CustomAgentMessages[...]`) instead gives each pi-only custom kind
			// (`bashExecution`, `custom`, `branchSummary`, `compactionSummary`) its own typed
			// shape with no single oracle-shaped "payload" field -- all four are rendered with
			// oracle's generic Custom-message pattern, using the message's own `role` tag as the
			// label and the whole message object (JSON-pretty-printed, matching oracle's
			// `serde_json::to_string_pretty`) as the payload.
			return `### custom: ${m.role}\n\n\`\`\`json\n${JSON.stringify(m, null, 2)}\n\`\`\`\n\n`;
	}
}

/** pie: export.rs:39-65 (the `AgentMessage::Llm(Message::Assistant(a))` arm). */
function renderAssistantContent(a: AssistantMessage): string {
	let out = "";
	for (const block of a.content) {
		if (block.type === "text") {
			out += `${block.text}\n\n`;
		} else if (block.type === "thinking") {
			out += "<details><summary>thinking</summary>\n\n";
			out += `\`\`\`\n${block.thinking}\n\`\`\`\n`;
			out += "\n</details>\n\n";
		} else if (block.type === "toolCall") {
			out += renderToolCall(block);
		}
		// pie: export.rs:60-62 (`ContentBlock::Image(_) => "\`[image]\`\n\n"`) -- no TS analog
		// reachable here: `AssistantMessage.content` is typed `(TextContent | ThinkingContent |
		// ToolCall)[]` (no `ImageContent` variant), so this arm is unreachable by construction,
		// not silently dropped.
	}
	return out;
}

/** pie: export.rs:52-58 (`ContentBlock::ToolCall(c)` arm). `format!("{}", serde_json::Value::
 * Object(...))` uses `Display` (compact JSON, no pretty-printing) -- distinct from the "custom"
 * message arm below, which DOES pretty-print. `JSON.stringify(x)` (no indent arg) matches. */
function renderToolCall(c: ToolCall): string {
	return `**tool call** \`${c.name}\` \`${c.id}\`:\n\`\`\`json\n${JSON.stringify(c.arguments)}\n\`\`\`\n\n`;
}

/** pie: export.rs:85-97 (`render_user_content`). `UserMessage.content`/`ToolResultMessage.
 * content` are the TS shape of oracle's `UserContent::Text(String) | UserContent::Blocks(Vec<
 * UserContentBlock>)` untagged union (RULEBOOK §2.1: `string | array`). */
function renderUserContent(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return content.map((b) => (b.type === "text" ? b.text : "`[image]`")).join("\n\n");
}

/** pie: export.rs:99-101 (`default_export_path`). */
export function defaultExportPath(sessionId: string): string {
	return join(getAgentDir(), "exports", `${sessionId}.md`);
}

/** pie: export.rs:103-114 (`save`). */
export async function save(session: Session, dest: string): Promise<string> {
	await mkdir(dirname(dest), { recursive: true });
	const body = await render(session);
	await writeFile(dest, body, "utf-8");
	return dest;
}
