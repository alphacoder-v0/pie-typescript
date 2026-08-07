import { basename, dirname, isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import type { AgentTool } from "@pie/agent-core";
import type { Api, ImageContent, Model, TextContent } from "@pie/ai";
import { Text } from "@pie/tui";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile } from "fs/promises";
import { type Static, Type } from "typebox";
import { getReadmePath } from "../../config.ts";
import { keyHint, keyText } from "../../modes/interactive/components/keybinding-hints.ts";
import { getLanguageFromPath, highlightCode, type Theme } from "../../modes/interactive/theme/theme.ts";
import { formatDimensionNote, resizeImage } from "../../utils/image-resize.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import { formatPathRelativeToCwdOrAbsolute } from "../../utils/paths.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { formatOsError } from "./os-error.ts";
import { resolveReadPath } from "./path-utils.ts";
import { getTextOutput, invalidArgText, replaceTabs, shortenPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatInclusiveTruncationNote,
	splitLinesInclusive,
	truncateHeadInclusive,
} from "./truncate.ts";

const readSchema = Type.Object({
	// pie: crates/coding-agent/src/tools/read.rs (DEFINITION.parameters) — descriptions verbatim,
	// and oracle declares the two counters as JSON Schema `integer`, not pi's `number`.
	path: Type.String({ description: "Path to the file (relative or absolute)" }),
	offset: Type.Optional(Type.Integer({ description: "Line to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Integer({ description: "Max lines to read" })),
});

export type ReadToolInput = Static<typeof readSchema>;

/**
 * pie: crates/coding-agent/src/tools/read.rs:78-84 (`details: json!({...})`) — key set and key
 * names verbatim, and nothing beyond them. `details` is persisted into the session transcript, so
 * an extra key here is a real divergence on the judged surface, not a private UI detail.
 *
 * `path` is the *raw* `path` argument, not the cwd-resolved absolute one — oracle interpolates the
 * argument it was handed (read.rs:41-43 feeds the same `path` to the header and to `details`).
 */
export interface ReadToolDetails {
	path: string;
	/** Lines the scan walked, NOT the file's line count — see `readOracleText`'s note. */
	totalLines: number;
	keptLines: number;
	/** The 1-indexed `offset` argument as oracle resolved it (absent -> 1). */
	offset: number;
}

interface CompactReadClassification {
	kind: "docs" | "resource" | "skill";
	label: string;
}

const COMPACT_RESOURCE_FILE_NAMES = new Set(["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);

/**
 * Pluggable operations for the read tool.
 * Override these to delegate file reading to remote systems (for example SSH).
 */
export interface ReadOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Check if file is readable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
	/** Detect image MIME type, return null or undefined for non-images */
	detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}

const defaultReadOperations: ReadOperations = {
	readFile: (path) => fsReadFile(path),
	access: (path) => fsAccess(path, constants.R_OK),
	detectImageMimeType: detectSupportedImageMimeTypeFromFile,
};

export interface ReadToolOptions {
	/** Whether to auto-resize images to 2000x2000 max. Default: true */
	autoResizeImages?: boolean;
	/** Custom operations for file reading. Default: local filesystem */
	operations?: ReadOperations;
}

type ReadRenderArgs = { path?: string; file_path?: string; offset?: number; limit?: number };

function formatReadLineRange(args: ReadRenderArgs | undefined, theme: Theme): string {
	if (args?.offset === undefined && args?.limit === undefined) return "";
	const startLine = args.offset ?? 1;
	const endLine = args.limit !== undefined ? startLine + args.limit - 1 : "";
	return theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
}

function formatReadCall(args: ReadRenderArgs | undefined, theme: Theme): string {
	const rawPath = str(args?.file_path ?? args?.path);
	const path = rawPath !== null ? shortenPath(rawPath) : null;
	const invalidArg = invalidArgText(theme);
	const pathDisplay = path === null ? invalidArg : path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");
	return `${theme.fg("toolTitle", theme.bold("read"))} ${pathDisplay}${formatReadLineRange(args, theme)}`;
}

function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") {
		end--;
	}
	return lines.slice(0, end);
}

function getNonVisionImageNote(model: Model<Api> | undefined): string | undefined {
	if (!model || model.input.includes("image")) {
		return undefined;
	}
	return "[Current model does not support images. The image will be omitted from this request.]";
}

function toPosixPath(filePath: string): string {
	return filePath.split(sep).join("/");
}

function getPiDocsClassification(absolutePath: string): CompactReadClassification | undefined {
	const packageRoot = dirname(getReadmePath());
	const relativePath = relative(resolvePath(packageRoot), resolvePath(absolutePath));
	if (
		relativePath === "" ||
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(relativePath)
	) {
		return undefined;
	}

	const label = toPosixPath(relativePath);
	if (label === "README.md" || label.startsWith("docs/") || label.startsWith("examples/")) {
		return { kind: "docs", label };
	}
	return undefined;
}

function getCompactReadClassification(
	args: ReadRenderArgs | undefined,
	cwd: string,
): CompactReadClassification | undefined {
	const rawPath = str(args?.file_path ?? args?.path);
	if (!rawPath) return undefined;

	const absolutePath = resolveReadPath(rawPath, cwd);
	const fileName = basename(absolutePath);
	if (fileName === "SKILL.md") {
		return { kind: "skill", label: basename(dirname(absolutePath)) || fileName };
	}

	const docsClassification = getPiDocsClassification(absolutePath);
	if (docsClassification) return docsClassification;

	if (COMPACT_RESOURCE_FILE_NAMES.has(fileName)) {
		return { kind: "resource", label: formatPathRelativeToCwdOrAbsolute(absolutePath, cwd) };
	}

	return undefined;
}

function formatCompactReadCall(
	classification: CompactReadClassification,
	args: ReadRenderArgs | undefined,
	theme: Theme,
): string {
	const expandHint = theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`);
	if (classification.kind === "skill") {
		return (
			theme.fg("customMessageLabel", `\x1b[1m[skill]\x1b[22m `) +
			theme.fg("customMessageText", classification.label) +
			formatReadLineRange(args, theme) +
			expandHint
		);
	}

	return (
		theme.fg("toolTitle", theme.bold(`read ${classification.kind}`)) +
		" " +
		theme.fg("accent", classification.label) +
		formatReadLineRange(args, theme) +
		expandHint
	);
}

function formatReadResult(
	args: ReadRenderArgs | undefined,
	result: { content: (TextContent | ImageContent)[]; details?: ReadToolDetails },
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
	cwd: string,
	isError: boolean,
): string {
	if (!options.expanded && !isError && getCompactReadClassification(args, cwd)) {
		return "";
	}

	const rawPath = str(args?.file_path ?? args?.path);
	const output = getTextOutput(result, showImages);
	const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
	const renderedLines = lang ? highlightCode(replaceTabs(output), lang) : output.split("\n");
	const lines = trimTrailingEmptyLines(renderedLines);
	const maxLines = options.expanded ? lines.length : 10;
	const displayLines = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	let text = `\n${displayLines.map((line) => (lang ? replaceTabs(line) : theme.fg("toolOutput", replaceTabs(line)))).join("\n")}`;
	if (remaining > 0) {
		text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
	}

	// No separate truncation banner: oracle puts its `[truncated: kept K/N lines, X of Y bytes]`
	// note *inside* the tool output (read.rs:72-77), so it is already part of `output` above.
	// Re-deriving a second, differently-worded banner from `details` would render it twice.
	return text;
}

/**
 * Mirror `serde_json::Value::as_u64()`: `undefined` unless the value is a non-negative integer,
 * so negative and fractional arguments fall back to oracle's default exactly as they do there.
 */
function asU64(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isInteger(value) || value < 0) {
		return undefined;
	}
	return value;
}

/**
 * pie: crates/coding-agent/src/tools/read.rs:44-85 (`ReadTool::execute`, text path), 1:1.
 *
 * The whole point of this shape is that it is the model's input contract: the `[path] lines a-b`
 * header is how the model knows which absolute line numbers it is looking at, and therefore what
 * `offset` to pass next. Oracle emits it *before* the slice, with the truncation note (when there
 * is one) on its own line between the two.
 */
function readOracleText(
	rawPath: string,
	raw: string,
	offsetArg: number | undefined,
	limitArg: number | undefined,
): { text: string; details: ReadToolDetails } {
	// pie: read.rs:44-50 — `as_u64()` returns None for a missing key and for anything that is not
	// a non-negative integer, and both fall back to the default.
	const offset = asU64(offsetArg) ?? 1;
	const limit = asU64(limitArg) ?? DEFAULT_MAX_LINES;
	// pie: read.rs:56 (`offset.saturating_sub(1)`).
	const skip = Math.max(0, offset - 1);

	// pie: read.rs:57-68.
	//
	// BUG(port): B18 (RULEBOOK §5) — `total_lines` is incremented *before* the `taken_lines.len() >= limit` break, so
	// once the scan stops early the counter reads `skip + limit + 1` — one past what was consumed
	// — and NOT the file's line count. `details.totalLines` therefore under-reports every file
	// longer than `offset + limit`. Replicated bug-for-bug; a fix belongs in a post-parity phase.
	const takenLines: string[] = [];
	let totalLines = 0;
	for (const line of splitLinesInclusive(raw)) {
		totalLines++;
		if (totalLines <= skip) {
			continue;
		}
		if (takenLines.length >= limit) {
			break;
		}
		takenLines.push(line);
	}

	const trunc = truncateHeadInclusive(takenLines.join(""), limit, DEFAULT_MAX_BYTES);

	// pie: read.rs:71-77 — header, then the optional note on its own line, then the slice. An
	// offset past the end of the file is not an error in oracle: the slice is empty, so the header
	// reads `lines {skip+1}-{skip}` (an inverted range) and the tool call still succeeds.
	let text = `[${rawPath}] lines ${skip + 1}-${skip + trunc.keptLines}\n`;
	const note = formatInclusiveTruncationNote(trunc);
	if (note !== undefined) {
		text += `${note}\n`;
	}
	text += trunc.content;

	// pie: read.rs:78-84 — exactly these four keys.
	return { text, details: { path: rawPath, totalLines, keptLines: trunc.keptLines, offset } };
}

export function createReadToolDefinition(
	cwd: string,
	options?: ReadToolOptions,
): ToolDefinition<typeof readSchema, ReadToolDetails | undefined> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const ops = options?.operations ?? defaultReadOperations;
	return {
		name: "read",
		label: "read",
		// pie: crates/coding-agent/src/tools/read.rs (DEFINITION.description) — verbatim. Oracle's
		// `read` is text-only, so the sentence about image attachments is gone even though this
		// implementation still returns images when handed one.
		// TODO(port): the image branch below (jpg/png/gif/webp -> ImageContent + auto-resize) has no
		// oracle counterpart; only the *definition* is aligned here, the execute path is untouched.
		description: `Read the contents of a UTF-8 text file. Use offset/limit for large files; output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024} KiB (whichever first).`,
		promptSnippet: "Read file contents",
		promptGuidelines: ["Use read to examine files instead of cat or sed."],
		parameters: readSchema,
		async execute(
			_toolCallId,
			{ path, offset, limit }: { path: string; offset?: number; limit?: number },
			signal?: AbortSignal,
			_onUpdate?,
			ctx?,
		) {
			const absolutePath = resolveReadPath(path, cwd);
			return new Promise<{ content: (TextContent | ImageContent)[]; details: ReadToolDetails | undefined }>(
				(resolve, reject) => {
					if (signal?.aborted) {
						reject(new Error("Operation aborted"));
						return;
					}
					let aborted = false;
					const onAbort = () => {
						aborted = true;
						reject(new Error("Operation aborted"));
					};
					signal?.addEventListener("abort", onAbort, { once: true });

					(async () => {
						try {
							// Check if file exists and is readable.
							// pie: read.rs:51-53 — oracle has no access precheck; it opens straight away and
							// wraps whatever `std::io::Error` comes back as `read {path}: {e}`. The precheck
							// stays (it is how the image branch below decides it can sniff), but its failures
							// now carry oracle's wording instead of Node's.
							try {
								await ops.access(absolutePath);
							} catch (error: unknown) {
								throw new Error(`read ${path}: ${formatOsError(error)}`);
							}
							if (aborted) return;
							let mimeType: string | null | undefined;
							try {
								mimeType = ops.detectImageMimeType ? await ops.detectImageMimeType(absolutePath) : undefined;
							} catch (error: unknown) {
								// Sniffing opens and reads the file, so this is the path a directory argument
								// takes (access(R_OK) succeeds on a directory, the read returns EISDIR) — the
								// same condition oracle's `read_to_string` reports as
								// `read {path}: Is a directory (os error 21)`.
								throw new Error(`read ${path}: ${formatOsError(error)}`);
							}
							let content: (TextContent | ImageContent)[];
							let details: ReadToolDetails | undefined;
							const nonVisionImageNote = getNonVisionImageNote(ctx?.model);
							if (mimeType) {
								// Read image as binary.
								const buffer = await ops.readFile(absolutePath);
								const base64 = buffer.toString("base64");
								if (autoResizeImages) {
									// Resize image if needed before sending it back to the model.
									const resized = await resizeImage({ type: "image", data: base64, mimeType });
									if (!resized) {
										let textNote = `Read image file [${mimeType}]\n[Image omitted: could not be resized below the inline image size limit.]`;
										if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
										content = [{ type: "text", text: textNote }];
									} else {
										const dimensionNote = formatDimensionNote(resized);
										let textNote = `Read image file [${resized.mimeType}]`;
										if (dimensionNote) textNote += `\n${dimensionNote}`;
										if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
										content = [
											{ type: "text", text: textNote },
											{ type: "image", data: resized.data, mimeType: resized.mimeType },
										];
									}
								} else {
									let textNote = `Read image file [${mimeType}]`;
									if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
									content = [
										{ type: "text", text: textNote },
										{ type: "image", data: base64, mimeType },
									];
								}
							} else {
								// Read text content.
								let buffer: Buffer;
								try {
									buffer = await ops.readFile(absolutePath);
								} catch (error: unknown) {
									// pie: read.rs:51-53 (`read {path}: {e}`).
									throw new Error(`read ${path}: ${formatOsError(error)}`);
								}
								let textContent: string;
								try {
									// pie: crates/coding-agent/src/tools/read.rs:51-53 -- oracle reads via
									// `tokio::fs::read_to_string`, which errors the tool call on invalid
									// UTF-8 ("stream did not contain valid UTF-8"). Node's Buffer#toString
									// ("utf-8") never throws -- it silently replaces bad bytes with U+FFFD
									// -- so validate explicitly to match oracle's error behavior.
									textContent = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
								} catch {
									throw new Error(`read ${path}: stream did not contain valid UTF-8`);
								}
								// pie: read.rs:55-84. `path` (the raw argument), not `absolutePath`, is what
								// oracle interpolates into both the header and `details`.
								const oracleRead = readOracleText(path, textContent, offset, limit);
								content = [{ type: "text", text: oracleRead.text }];
								details = oracleRead.details;
							}

							if (aborted) return;
							signal?.removeEventListener("abort", onAbort);
							resolve({ content, details });
						} catch (error: any) {
							signal?.removeEventListener("abort", onAbort);
							if (!aborted) reject(error);
						}
					})();
				},
			);
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const classification = !context.expanded ? getCompactReadClassification(args, context.cwd) : undefined;
			text.setText(
				classification ? formatCompactReadCall(classification, args, theme) : formatReadCall(args, theme),
			);
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				formatReadResult(context.args, result, options, theme, context.showImages, context.cwd, context.isError),
			);
			return text;
		},
	};
}

export function createReadTool(cwd: string, options?: ReadToolOptions): AgentTool<typeof readSchema> {
	return wrapToolDefinition(createReadToolDefinition(cwd, options));
}
