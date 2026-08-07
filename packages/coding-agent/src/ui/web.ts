/**
 * Local browser UI for the coding-agent REPL.
 *
 * Port of oracle `crates/coding-agent/src/ui/web.rs` (pie @0a120dfd, whole file). Oracle module
 * doc, verbatim: "This is intentionally a small loopback-only surface. The browser layer sends
 * commands into the same single-turn event loop used by the TUI and receives full feed snapshots
 * over SSE."
 *
 * ## Construct mapping (RULEBOOK §2.2 / §2.3), site by site
 *
 * | oracle site | Rust construct | TS mapping |
 * |---|---|---|
 * | `web.rs:224` `command_tx/command_rx` | `mpsc::unbounded_channel` | shared {@link AsyncQueue} |
 * | `web.rs:225` `snapshot_tx` | `broadcast::channel(128)` | listener set ({@link createSnapshotBroadcast}), the rulebook's "skeleton event-bus pattern" |
 * | `web.rs:226` `Arc<Mutex<WebSnapshot>>` | `tokio::sync::Mutex` | plain cell ({@link createSnapshotCell}) — the critical section (`*latest.lock().await = …`, `latest.lock().await.clone()`) never crosses an `await`, so §2.2's mechanical criterion says direct field access |
 * | `web.rs:235` `tokio::spawn(server)` | detached task | the `node:http` server's own lifetime promise, joined by the `select!` below (oracle joins it too — `server_result = &mut server_task`), so this is §2.2's "spawn + JoinHandle.await" row, NOT the detached row |
 * | `web.rs:266-331` `tokio::select! { biased; … }` | `select!` | shared {@link selectBiased} |
 * | `web.rs:316` `tokio::signal::ctrl_c()` | signal future | `process.on("SIGINT")` inside a {@link SelectCase} that unregisters on abort |
 * | `web.rs:844-873` `std::process::Command` | `Command::spawn` | `utils/child-process.ts` `spawnProcess` (§2.3) |
 * | `web.rs:219` `tokio::net::TcpListener::bind` + `axum::serve` | axum server | `node:http` `createServer` (§1 whitelists NO express/fastify; `node:http` is the only sanctioned server) |
 *
 * There is no `tokio::time::timeout` site in this file, so §2.2's `AbortSignal.timeout` row does
 * not apply here; the SSE keep-alive is a repeating interval (axum `KeepAlive::default()`), not a
 * timeout, and is modelled as a self-rescheduling timer that resets on every real event exactly
 * as axum's `Sleep` does.
 *
 * ## Cross-unit type dependencies
 *
 * `web.rs` reaches into three sibling modules ported by their own manifest units. `ui/feed.ts`
 * (`Feed`, `WebFeedBlock`, `TriggerPollStatus`, `truncateChars`) and `ui/kernel.ts` (`TurnState`,
 * `QueuedTurn`, `pollTurn`, `newTurnState`) are imported directly — they are the single source of
 * truth for those shapes. Two remain structural stand-ins:
 *
 *  1. `ui/index.ts` (oracle `ui/mod.rs`: `App`, `PanelStatus`, `prompt_display`) has not landed;
 *     {@link WebApp}/{@link PanelStatus} below declare exactly the slice `web.rs` touches. Same
 *     technique, same reason, as `core/slash-dispatch-deps.ts`'s `CommandHarness`/`CommandSkill`.
 *     TypeScript is structural, so a real `App` whose member names match is assignable with no
 *     adapter.
 *  2. `ui/relay.ts`'s `RelayHandle` is *deliberately* not imported: `relay.ts:36` already does
 *     `import type { WebSnapshot } from "./web.ts"`, so importing it back would make the two
 *     modules mutually dependent. {@link RelayHandleLike} is the one method (`pushSnapshot`) that
 *     `web.rs:655` calls, which `RelayHandle` satisfies structurally.
 *
 * TODO(port): when `ui/index.ts` lands, re-point {@link PanelStatus} and {@link TurnResult} at it
 * and drop the local declarations. The wire shapes below (everything reachable from
 * {@link WebSnapshot}) are web.rs's own and stay here regardless.
 */

import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIPv4, isIPv6 } from "node:net";
import { fileURLToPath } from "node:url";
import {
	AsyncQueue,
	type ControlPlanePromptDecision,
	type ControlPlanePromptRequest,
	type SelectCase,
	selectBiased,
} from "@pie/agent-core";
import type { ImageContent } from "@pie/ai";
import { redact } from "../bug-report.ts";
// pie: `feed::truncate_chars` (feed.rs:775, used at web.rs:373/781/799) — `ui/feed.ts` re-exports
// it for exactly these call sites, so the oracle import path translates unchanged.
import type { UiControlPlanePrompt } from "../control-plane-prompt.ts";
import { dispatch, type Registry } from "../core/slash-dispatch.ts";
import type { CommandCtx, CommandOutcome, CommandSkill } from "../core/slash-dispatch-deps.ts";
import { attachSkillPrompt } from "../core/slash-dispatch-skills.ts";
import type { GoalState } from "../goal.ts";
import { defaultInboxPath, newCount } from "../inbox.ts";
import { expand as expandMentions } from "../mentions.ts";
import type { ProviderGroup } from "../model-picker.ts";
import type { SlashCompleter } from "../readline.ts";
import { skillSourceLabel } from "../skills-state.ts";
import { globalCronRegistry, globalRegistry } from "../triggers/index.ts";
import { spawnProcess } from "../utils/child-process.ts";
import { loadImageBytes, MAX_IMAGES_PER_MESSAGE } from "../utils/image-convert.ts";
import { type Feed, type FeedUpdate, type TriggerPollStatus, truncateChars, type WebFeedBlock } from "./feed.ts";
import { newTurnState, pollTurn, type QueuedTurn, type TurnState } from "./kernel.ts";

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Structural stand-ins for `ui/index.ts` and `ui/relay.ts` (see module doc).
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * pie: kernel.rs:21 (`TurnFut = Pin<Box<dyn Future<Output = Result<Option<String>, AgentRunError>>>>`)
 * as `finish_turn` receives it. Rust `Result` maps to throw (§2.4), but this value is *passed* to
 * `finish_turn` (web.rs:269) rather than propagated, so the caught error has to be reified into a
 * value — hence the tagged union rather than a bare re-throw.
 * TODO(port): `ui/index.ts` owns `App::finish_turn` and will fix this parameter's final shape;
 * re-point this alias at it when that unit lands.
 */
export type TurnResult = { ok: true; value: string | undefined } | { ok: false; error: unknown };

/** pie: mod.rs:82-98 (`struct PanelStatus`). */
export interface PanelStatus {
	mcp_servers: number;
	mcp_tools: number;
	mcp_server_names: string[];
	mcp_tool_names: string[];
	tool_names: string[];
	mcp_notification_hooks: number;
	hook_points: string[];
	trigger_features: string[];
}

/** pie: mod.rs:140 (`control_plane_prompt: Option<UiControlPlanePrompt>`) — only `.request` is read here. */
export interface UiControlPlanePromptLike {
	readonly request: ControlPlanePromptRequest;
}

/** pie: mod.rs:163 (`relay: Option<relay::RelayHandle>`) — only `push_snapshot` is called here. */
export interface RelayHandleLike {
	/** pie: web.rs:655 (`active.push_snapshot(snapshot.clone())`). */
	pushSnapshot(snapshot: WebSnapshot): void;
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Options and wire types — pie: web.rs:26-214.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/** pie: web.rs:26-30 (`struct WebOptions`). */
export interface WebOptions {
	host: string;
	port: number;
}

/**
 * pie: web.rs:58-72 (`struct WebSnapshot`, `#[derive(Serialize)]` with no `rename_all`), so every
 * field name below is the literal JSON key. `Option<T>` fields carry no `skip_serializing_if` and
 * therefore serialize as `null` when absent — see {@link WebFeedBlock}'s note.
 */
export interface WebSnapshot {
	session_id: string;
	model: string;
	model_catalog: ProviderGroup[];
	cwd: string;
	busy: boolean;
	queued_count: number;
	latest_trigger_poll: TriggerPollStatus | null;
	goal: WebGoalSnapshot | null;
	control_plane_prompt: WebControlPlanePromptSnapshot | null;
	sidebar: WebSidebarSnapshot;
	feed_blocks: WebFeedBlock[];
	feed_lines: string[];
}

/** pie: web.rs:74-80 (`struct WebGoalSnapshot`). */
export interface WebGoalSnapshot {
	condition: string;
	status: string;
	iterations: number;
	last_reason: string | null;
}

/** pie: web.rs:82-89 (`struct WebControlPlanePromptSnapshot`). */
export interface WebControlPlanePromptSnapshot {
	tool_name: string;
	label: string;
	reason: string;
	args_hash: string;
	payload: string;
}

/** pie: web.rs:91-101 (`struct WebSidebarSnapshot`). */
export interface WebSidebarSnapshot {
	inbox_new: number;
	skills: WebSkillsSnapshot;
	triggers: WebTriggersSnapshot;
	cron: WebCronSnapshot;
	mcp: WebMcpSnapshot;
	tools: WebToolsSnapshot;
	hooks: string[];
	runtime: string[];
}

/** pie: web.rs:103-112 (`struct WebSkillsSnapshot`). */
export interface WebSkillsSnapshot {
	total: number;
	enabled: number;
	disabled: number;
	builtin: number;
	user: number;
	project: number;
	items: WebSkillSnapshot[];
}

/** pie: web.rs:114-120 (`struct WebSkillSnapshot`). */
export interface WebSkillSnapshot {
	name: string;
	source: string;
	file_path: string;
	enabled: boolean;
}

/** pie: web.rs:122-128 (`struct WebTriggersSnapshot`). */
export interface WebTriggersSnapshot {
	total: number;
	enabled: number;
	disabled: number;
	rules: WebTriggerRuleSnapshot[];
}

/** pie: web.rs:130-138 (`struct WebTriggerRuleSnapshot`). */
export interface WebTriggerRuleSnapshot {
	id: string;
	full_id: string;
	enabled: boolean;
	mode: string;
	condition: string;
	action: string;
}

/** pie: web.rs:140-146 (`struct WebCronSnapshot`). */
export interface WebCronSnapshot {
	total: number;
	enabled: number;
	disabled: number;
	jobs: WebCronJobSnapshot[];
}

/** pie: web.rs:148-156 (`struct WebCronJobSnapshot`). */
export interface WebCronJobSnapshot {
	id: string;
	enabled: boolean;
	schedule: string;
	action: string;
	skipped_overlap_count: number;
	last_error: string | null;
}

/** pie: web.rs:158-165 (`struct WebMcpSnapshot`). */
export interface WebMcpSnapshot {
	servers: number;
	tools: number;
	notification_hooks: number;
	server_names: string[];
	tool_names: string[];
}

/** pie: web.rs:167-171 (`struct WebToolsSnapshot`). */
export interface WebToolsSnapshot {
	total: number;
	names: string[];
}

/**
 * pie: web.rs:180-184 (`struct WebPromptImage`, `Deserialize`). `name: Option<String>` — serde
 * treats a missing `Option` field as `None`, so `undefined` is correct here (inbound only).
 */
export interface WebPromptImage {
	data: string;
	name?: string;
}

/** pie: web.rs:173-178 (`struct PromptRequest`) — `images` carries `#[serde(default)]`. */
interface PromptRequest {
	text: string;
	images: WebPromptImage[];
}

/** pie: web.rs:186-189 (`struct CompleteRequest`). */
interface CompleteRequest {
	text: string;
}

/** pie: web.rs:201-204 (`struct ControlPlaneDecisionRequest`). */
interface ControlPlaneDecisionRequest {
	approve: boolean;
}

/** pie: web.rs:206-209 (`struct SetModelRequest`). */
interface SetModelRequest {
	model: string;
}

/** pie: web.rs:211-214 (`struct TriggerRuleRequest`). */
interface TriggerRuleRequest {
	id: string;
}

/**
 * pie: web.rs:40-56 (`enum WebCommand`). Not a wire type (no serde derive), so the tag values are
 * this port's choice; RULEBOOK §2.1 maps a data-carrying enum to a tagged union.
 */
export type WebCommand =
	| { kind: "submit"; text: string; images: WebPromptImage[] }
	| { kind: "trigger_rule_now"; id: string }
	| { kind: "abort" }
	| { kind: "resolve_control_plane"; approve: boolean }
	| { kind: "set_model"; spec: string };

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Shared server state — pie: web.rs:32-38 (`struct HttpState`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * pie: web.rs:225 (`broadcast::Sender<WebSnapshot>`). RULEBOOK §2.2 maps `broadcast` to the
 * skeleton's event-bus *pattern* (a listener set); this is that pattern specialised to one
 * message type, not a second copy of one of §4's four shared concurrency utils.
 *
 * BEHAVIOUR NOTE / TODO(port): the oracle channel is bounded at 128 and a slow subscriber that
 * falls behind gets `RecvError::Lagged(_)` — `events()` (web.rs:695) then *skips* the dropped
 * snapshots and continues from the newest one. A listener set has no backlog and therefore never
 * lags, so every subscriber sees every snapshot. That is strictly more data, never less, and each
 * snapshot is a complete state replacement (not a delta), so a viewer cannot end up inconsistent;
 * it only means a very slow browser receives a longer catch-up burst than the oracle would send.
 */
export interface SnapshotBroadcast {
	/** pie: `broadcast::Sender::subscribe`. Returns the unsubscribe handle (Rust drops the receiver). */
	subscribe(listener: (snapshot: WebSnapshot) => void): () => void;
	/** pie: `broadcast::Sender::send` — returns the receiver count; oracle discards it (`let _ =`). */
	send(snapshot: WebSnapshot): number;
}

export function createSnapshotBroadcast(): SnapshotBroadcast {
	const listeners = new Set<(snapshot: WebSnapshot) => void>();
	return {
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		send(snapshot) {
			// Snapshot the set first: a listener that unsubscribes during delivery must not perturb
			// the iteration (`Set` iteration is insertion order, matching per-receiver fan-out).
			for (const listener of [...listeners]) listener(snapshot);
			return listeners.size;
		},
	};
}

/**
 * pie: web.rs:36 (`latest: Arc<Mutex<WebSnapshot>>`). RULEBOOK §2.2's mechanical criterion for
 * `Mutex<T>`: the critical section is `*latest.lock().await = snapshot.clone()` (web.rs:653) and
 * `state.latest.lock().await.clone()` (web.rs:680) — neither holds the guard across an `await`, so
 * the lock collapses to direct field access on a single-threaded runtime.
 */
export interface SnapshotCell {
	get(): WebSnapshot;
	set(snapshot: WebSnapshot): void;
}

export function createSnapshotCell(initial: WebSnapshot): SnapshotCell {
	let current = initial;
	return {
		get: () => current,
		set: (snapshot) => {
			current = snapshot;
		},
	};
}

/** pie: web.rs:32-38 (`struct HttpState`). */
export interface HttpState {
	/** pie: `commands: mpsc::UnboundedSender<WebCommand>` (§2.2 → the shared `AsyncQueue`). */
	commands: AsyncQueue<WebCommand>;
	snapshots: SnapshotBroadcast;
	latest: SnapshotCell;
	completer: SlashCompleter;
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * HTTP plumbing. RULEBOOK §1 whitelists no HTTP server framework, so this is `node:http` shaped
 * to reproduce axum 0.8.9's observable behaviour for the nine routes web.rs registers.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * axum's `DefaultBodyLimit` (2 MiB, applied by `Router` since 0.6) — an oversized body is rejected
 * with `413 Payload Too Large` before the `Json` extractor runs. Reachable in practice: a pasted
 * image arrives base64-encoded in `POST /prompt`.
 */
const AXUM_DEFAULT_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

/** axum `KeepAlive::default()` — a `:\n\n` comment frame every 15s, timer reset by each real event. */
const SSE_KEEP_ALIVE_INTERVAL_MS = 15_000;
const SSE_KEEP_ALIVE_FRAME = ":\n\n";

type RouteHandler = (state: HttpState, req: IncomingMessage, res: ServerResponse) => Promise<void>;

export interface Route {
	method: "GET" | "POST";
	path: string;
	handler: RouteHandler;
}

/** pie: web.rs:661-673 (`web_router`). Route table order matches the oracle's `.route(...)` chain. */
export function webRoutes(): Route[] {
	return [
		{ method: "GET", path: "/", handler: index },
		{ method: "GET", path: "/state", handler: stateSnapshot },
		{ method: "GET", path: "/events", handler: events },
		{ method: "POST", path: "/prompt", handler: prompt },
		{ method: "POST", path: "/model", handler: setModel },
		{ method: "POST", path: "/complete", handler: complete },
		{ method: "POST", path: "/abort", handler: abort },
		{ method: "POST", path: "/trigger/immediate", handler: triggerImmediate },
		{ method: "POST", path: "/control-plane/resolve", handler: resolveControlPlane },
	];
}

/**
 * pie: web.rs:661-673 (`web_router`) + `router.into_make_service()` (web.rs:234). Returns the
 * `node:http` request listener; {@link serveWeb} binds it.
 */
export function webRouter(state: HttpState): (req: IncomingMessage, res: ServerResponse) => void {
	const routes = webRoutes();
	return (req, res) => {
		// Route on the path only — axum ignores the query string when matching, and does NOT
		// redirect a trailing slash (`/state/` is a 404, not a 307).
		const path = requestPath(req);
		const matches = routes.filter((route) => route.path === path);
		if (matches.length === 0) {
			// axum's default fallback: 404 with an empty body.
			res.writeHead(404).end();
			return;
		}
		// axum serves HEAD from a GET route by running the handler and discarding the body.
		const method = req.method === "HEAD" ? "GET" : req.method;
		const route = matches.find((candidate) => candidate.method === method);
		if (route === undefined) {
			// axum's `MethodRouter` fallback: 405 with an `Allow` header.
			res.writeHead(405, { allow: matches.map((candidate) => candidate.method).join(", ") }).end();
			return;
		}
		void route.handler(state, req, res).catch((error: unknown) => {
			// A handler throwing is a bug, not an oracle-modelled path (every one of web.rs's
			// handlers returns `impl IntoResponse` and is infallible). Fail loudly rather than
			// leaving the socket hanging — §2.4 forbids swallowing errors.
			if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
			res.end(errorMessage(error));
		});
	};
}

function requestPath(req: IncomingMessage): string {
	const raw = req.url ?? "/";
	const queryAt = raw.indexOf("?");
	return queryAt === -1 ? raw : raw.slice(0, queryAt);
}

/** axum `Json<T>` as a response: `content-type: application/json` + the serialized body. */
function respondJson(res: ServerResponse, value: unknown): void {
	const body = Buffer.from(JSON.stringify(value) ?? "null", "utf8");
	res.writeHead(200, { "content-type": "application/json", "content-length": String(body.byteLength) });
	res.end(body);
}

/** axum `Html<&'static str>`: `content-type: text/html; charset=utf-8`. */
function respondHtml(res: ServerResponse, html: string): void {
	const body = Buffer.from(html, "utf8");
	res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": String(body.byteLength) });
	res.end(body);
}

/** Rejection statuses of axum 0.8's `Json` extractor, reproduced for the five POST bodies. */
type JsonRejectionStatus = 413 | 415 | 400 | 422;

class JsonExtractorRejection extends Error {
	readonly status: JsonRejectionStatus;
	constructor(status: JsonRejectionStatus, message: string) {
		super(message);
		this.name = "JsonExtractorRejection";
		this.status = status;
	}
}

function isJsonContentType(req: IncomingMessage): boolean {
	const header = req.headers["content-type"];
	if (typeof header !== "string") return false;
	const mime = header.split(";", 1)[0].trim().toLowerCase();
	if (mime === "application/json") return true;
	// axum also accepts any `*/*+json` suffix type.
	return mime.endsWith("+json");
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.byteLength;
			if (size > limit) {
				reject(new JsonExtractorRejection(413, "length limit exceeded"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

/**
 * axum `Json<T>` as an extractor. Status mapping (axum 0.8 `JsonRejection`): missing/incorrect
 * `Content-Type` → 415, body over the limit → 413, unparseable JSON → 400, parseable but not
 * matching `T` → 422.
 */
async function extractJson<T>(req: IncomingMessage, parse: (value: unknown) => T): Promise<T> {
	if (!isJsonContentType(req)) {
		throw new JsonExtractorRejection(415, "Expected request with `Content-Type: application/json`");
	}
	const raw = await readBody(req, AXUM_DEFAULT_BODY_LIMIT_BYTES);
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.toString("utf8"));
	} catch (error) {
		throw new JsonExtractorRejection(400, `Failed to parse the request body as JSON: ${errorMessage(error)}`);
	}
	try {
		return parse(parsed);
	} catch (error) {
		throw new JsonExtractorRejection(422, errorMessage(error));
	}
}

/** Runs `handler` with the extracted body, mapping an extractor rejection to its axum status. */
async function withJsonBody<T>(
	req: IncomingMessage,
	res: ServerResponse,
	parse: (value: unknown) => T,
	handler: (body: T) => void,
): Promise<void> {
	let body: T;
	try {
		body = await extractJson(req, parse);
	} catch (error) {
		if (error instanceof JsonExtractorRejection) {
			const message = Buffer.from(error.message, "utf8");
			res.writeHead(error.status, {
				"content-type": "text/plain; charset=utf-8",
				"content-length": String(message.byteLength),
			});
			res.end(message);
			return;
		}
		throw error;
	}
	handler(body);
}

/* ── body parsers: serde's "missing/mismatched field ⇒ 422" contract, field by field ────────── */

function asRecord(value: unknown, what: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`invalid type: expected ${what}`);
	}
	return value as Record<string, unknown>;
}

function requireString(source: Record<string, unknown>, field: string): string {
	const value = source[field];
	if (typeof value !== "string") throw new Error(`missing field \`${field}\``);
	return value;
}

function requireBoolean(source: Record<string, unknown>, field: string): boolean {
	const value = source[field];
	if (typeof value !== "boolean") throw new Error(`missing field \`${field}\``);
	return value;
}

/** pie: web.rs:180-184. `data` is required; `name` is `Option<String>` (absent ⇒ `None`). */
function parseWebPromptImage(value: unknown): WebPromptImage {
	const source = asRecord(value, "struct WebPromptImage");
	const name = source.name;
	if (name !== undefined && name !== null && typeof name !== "string") {
		throw new Error("invalid type: expected a string for `name`");
	}
	return { data: requireString(source, "data"), name: typeof name === "string" ? name : undefined };
}

/** pie: web.rs:173-178 (`PromptRequest`). `#[serde(default)]` on `images` ⇒ absent means `[]`. */
function parsePromptRequest(value: unknown): PromptRequest {
	const source = asRecord(value, "struct PromptRequest");
	const rawImages = source.images;
	if (rawImages !== undefined && !Array.isArray(rawImages)) {
		throw new Error("invalid type: expected a sequence for `images`");
	}
	return {
		text: requireString(source, "text"),
		images: (rawImages ?? []).map(parseWebPromptImage),
	};
}

function parseCompleteRequest(value: unknown): CompleteRequest {
	return { text: requireString(asRecord(value, "struct CompleteRequest"), "text") };
}

function parseSetModelRequest(value: unknown): SetModelRequest {
	return { model: requireString(asRecord(value, "struct SetModelRequest"), "model") };
}

function parseTriggerRuleRequest(value: unknown): TriggerRuleRequest {
	return { id: requireString(asRecord(value, "struct TriggerRuleRequest"), "id") };
}

function parseControlPlaneDecisionRequest(value: unknown): ControlPlaneDecisionRequest {
	return { approve: requireBoolean(asRecord(value, "struct ControlPlaneDecisionRequest"), "approve") };
}

/* ── route handlers — pie: web.rs:675-766 ──────────────────────────────────────────────────── */

/** pie: web.rs:675-677 (`index`). */
async function index(_state: HttpState, _req: IncomingMessage, res: ServerResponse): Promise<void> {
	respondHtml(res, indexHtml());
}

/** pie: web.rs:679-681 (`state_snapshot`). */
async function stateSnapshot(state: HttpState, _req: IncomingMessage, res: ServerResponse): Promise<void> {
	respondJson(res, state.latest.get());
}

/**
 * pie: web.rs:683-701 (`events`). axum's `Sse` response sets exactly two headers —
 * `content-type: text/event-stream` and `cache-control: no-cache` — and its `Event` serializer
 * emits fields in builder order, so `Event::default().event("snapshot").data(data)` is the byte
 * sequence `event: snapshot\ndata: <json>\n\n`. `data` is single-line here (`serde_json::to_string`,
 * never `to_string_pretty`), so axum's multi-line `data:` splitting never triggers.
 */
async function events(state: HttpState, req: IncomingMessage, res: ServerResponse): Promise<void> {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	// Flush the head immediately: the oracle's own test asserts the response is successful before
	// any snapshot has been broadcast, which only holds if the headers are already on the wire.
	res.flushHeaders();

	let keepAlive: NodeJS.Timeout | undefined;
	const armKeepAlive = (): void => {
		if (keepAlive !== undefined) clearTimeout(keepAlive);
		keepAlive = setTimeout(() => {
			res.write(SSE_KEEP_ALIVE_FRAME);
			armKeepAlive();
		}, SSE_KEEP_ALIVE_INTERVAL_MS);
		keepAlive.unref();
	};
	armKeepAlive();

	const unsubscribe = state.snapshots.subscribe((snapshot) => {
		// pie: web.rs:691-692 — a serialization failure degrades to this exact literal rather than
		// dropping the frame. `JSON.stringify` can both throw (cycles) and return `undefined`, so
		// both shapes funnel to the same fallback.
		let data: string;
		try {
			data = JSON.stringify(snapshot) ?? '{"error":"serialize"}';
		} catch {
			data = '{"error":"serialize"}';
		}
		res.write(`event: snapshot\ndata: ${data}\n\n`);
		armKeepAlive();
	});

	const stop = (): void => {
		unsubscribe();
		if (keepAlive !== undefined) clearTimeout(keepAlive);
		keepAlive = undefined;
	};
	res.on("close", stop);
	req.on("aborted", stop);
}

/** pie: web.rs:703-715 (`prompt`). */
async function prompt(state: HttpState, req: IncomingMessage, res: ServerResponse): Promise<void> {
	await withJsonBody(req, res, parsePromptRequest, (body) => {
		const accepted = state.commands.push({ kind: "submit", text: body.text, images: body.images });
		respondJson(res, { accepted });
	});
}

/** pie: web.rs:717-724 (`complete`). */
async function complete(state: HttpState, req: IncomingMessage, res: ServerResponse): Promise<void> {
	await withJsonBody(req, res, parseCompleteRequest, (body) => {
		respondJson(res, { completions: state.completer.matches(body.text) });
	});
}

/** pie: web.rs:726-729 (`abort`) — no `Json` extractor, so the body is never read or validated. */
async function abort(state: HttpState, _req: IncomingMessage, res: ServerResponse): Promise<void> {
	respondJson(res, { accepted: state.commands.push({ kind: "abort" }) });
}

/** pie: web.rs:731-740 (`trigger_immediate`). */
async function triggerImmediate(state: HttpState, req: IncomingMessage, res: ServerResponse): Promise<void> {
	await withJsonBody(req, res, parseTriggerRuleRequest, (body) => {
		respondJson(res, { accepted: state.commands.push({ kind: "trigger_rule_now", id: body.id }) });
	});
}

/** pie: web.rs:742-753 (`set_model`) — note the wire field is `model`, the command field is `spec`. */
async function setModel(state: HttpState, req: IncomingMessage, res: ServerResponse): Promise<void> {
	await withJsonBody(req, res, parseSetModelRequest, (body) => {
		respondJson(res, { accepted: state.commands.push({ kind: "set_model", spec: body.model }) });
	});
}

/** pie: web.rs:755-766 (`resolve_control_plane`). */
async function resolveControlPlane(state: HttpState, req: IncomingMessage, res: ServerResponse): Promise<void> {
	await withJsonBody(req, res, parseControlPlaneDecisionRequest, (body) => {
		respondJson(res, { accepted: state.commands.push({ kind: "resolve_control_plane", approve: body.approve }) });
	});
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Free helpers — pie: web.rs:768-875.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * pie: web.rs:768-778 (`web_feed_lines`). The `100` is `Feed::lines`'s *wrap width*, not a row cap —
 * every rendered row survives.
 *
 * Oracle flattens each row's styled spans back into one plain string
 * (`line.spans.into_iter().map(|span| span.content.into_owned()).collect::<String>()`); the ported
 * `Feed` emits ratatui's single-span `Line` as `{ text, style }` (feed.ts:154-157), so the
 * concatenation of a one-element span list is just `line.text`.
 */
export function webFeedLines(feed: Pick<Feed, "lines">): string[] {
	return feed.lines(100).map((line) => line.text);
}

/** pie: web.rs:780-782 (`web_preview`). */
export function webPreview(text: string): string {
	return truncateChars(redact(text), 120);
}

/** pie: web.rs:798-800 (`web_prompt_text`). */
export function webPromptText(text: string, cap: number): string {
	return truncateChars(redact(text), cap);
}

/**
 * pie: web.rs:784-796 (`web_control_plane_prompt_snapshot`).
 *
 * `serde_json::to_string_pretty` is 2-space indent, and pie's workspace `Cargo.toml:28` enables
 * serde_json's `preserve_order`, so object keys keep insertion order — which is what
 * `JSON.stringify(value, null, 2)` does too.
 * TODO(port): JS reorders *integer-like* string keys ahead of the rest, so a payload with keys such
 * as `"2"`/`"10"` would render in a different order than the oracle. No known payload producer
 * emits numeric keys, so this is recorded rather than worked around.
 */
export function webControlPlanePromptSnapshot(request: ControlPlanePromptRequest): WebControlPlanePromptSnapshot {
	// pie: web.rs:787-788 — a `to_string_pretty` failure falls back to `payload.to_string()`.
	let payload: string;
	try {
		payload = JSON.stringify(request.payload, null, 2) ?? String(request.payload);
	} catch {
		payload = String(request.payload);
	}
	return {
		tool_name: webPromptText(request.toolName, 80),
		label: webPromptText(request.label, 160),
		reason: webPromptText(request.reason, 180),
		// pie: web.rs:793 — `chars().take(12)`: code points, not UTF-16 units, and NO ellipsis
		// (unlike `truncate_chars`).
		args_hash: [...request.argsHash].slice(0, 12).join(""),
		payload: webPromptText(payload, 800),
	};
}

const BASE64_ALPHABET = /^[A-Za-z0-9+/]*={0,2}$/;

const BASE64_VALUES: ReadonlyMap<string, number> = new Map(
	[..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"].map((char, i) => [char, i] as const),
);

/**
 * pie: web.rs:823-825 (`base64::engine::general_purpose::STANDARD.decode`). Rust's STANDARD engine
 * is canonical and strict: it rejects characters outside the alphabet (including whitespace and
 * URL-safe `-`/`_`), requires the length to be a multiple of 4 with correct padding, and rejects
 * non-zero trailing bits in the final quantum. `Buffer.from(s, "base64")` is the opposite — it
 * silently skips anything it does not recognise and tolerates missing padding — so decoding through
 * it alone would accept payloads the oracle rejects. The validation below restores strictness
 * before handing the bytes to Node.
 */
function decodeBase64Strict(input: string): Uint8Array {
	if (input.length % 4 !== 0 || !BASE64_ALPHABET.test(input)) {
		throw new Error("Invalid symbol, offset unknown.");
	}
	const padding = input.endsWith("==") ? 2 : input.endsWith("=") ? 1 : 0;
	if (padding > 0) {
		// Trailing-bit canonicality: with one padding char the last symbol carries 2 unused low
		// bits, with two padding chars it carries 4 — both must be zero.
		const lastSymbol = input[input.length - 1 - padding];
		const value = BASE64_VALUES.get(lastSymbol);
		if (value === undefined || (value & (padding === 1 ? 0b11 : 0b1111)) !== 0) {
			throw new Error("Invalid last symbol, offset unknown.");
		}
	}
	return new Uint8Array(Buffer.from(input, "base64"));
}

/**
 * pie: web.rs:802-829 (`load_web_prompt_images`).
 *
 * §2.4: `bail!` and the `?` on a `with_context` both map to `throw`; the context wraps the cause
 * (`new Error(msg, { cause })`). Rust `anyhow` renders only the outermost context in `to_string()`,
 * which is what the oracle's own count-limit test asserts against.
 */
export function loadWebPromptImages(images: readonly WebPromptImage[]): ImageContent[] {
	if (images.length > MAX_IMAGES_PER_MESSAGE) {
		// pie: web.rs:804-808 — message reproduced verbatim.
		throw new Error(`${images.length} images exceeds per-message cap of ${MAX_IMAGES_PER_MESSAGE}`);
	}
	const out: ImageContent[] = [];
	for (const [idx, image] of images.entries()) {
		// pie: web.rs:812-817 — a present-but-blank `name` falls through to the ordinal label.
		const name = image.name;
		const label =
			name !== undefined && name.trim() !== "" ? `clipboard image \`${name}\`` : `clipboard image #${idx + 1}`;
		// pie: web.rs:818-822 — `rsplit_once(',')` strips a `data:image/png;base64,` prefix; with no
		// comma the whole string is the payload.
		const comma = image.data.lastIndexOf(",");
		const data = comma === -1 ? image.data : image.data.slice(comma + 1);
		let bytes: Uint8Array;
		try {
			bytes = decodeBase64Strict(data);
		} catch (error) {
			throw new Error(`decode ${label}`, { cause: error });
		}
		// pie: web.rs:826 — `crate::images::load_bytes`, already ported as `loadImageBytes`.
		out.push(loadImageBytes(label, bytes));
	}
	return out;
}

/** A parsed, validated bind address. pie: `std::net::SocketAddr`. */
export interface BindAddr {
	/** Rust `IpAddr`'s `Display` form — dotted quad for v4, RFC 5952 compressed for v6. */
	ip: string;
	port: number;
	family: 4 | 6;
}

/**
 * pie: web.rs:831-842 (`bind_addr`). THE loopback gate: the Web UI refuses to bind anything that is
 * not a loopback address, and `--web-host`'s help text says "Must be a loopback address". Both the
 * `"localhost"` alias and the rejection message are reproduced verbatim.
 *
 * Rust's `IpAddr::is_loopback()` is `127.0.0.0/8` for v4 and `::1` only for v6.
 */
export function bindAddr(options: WebOptions): BindAddr {
	// pie: web.rs:833 — the ONLY hostname the oracle resolves; anything else must parse as a
	// literal IP (no DNS lookup, so `example.com` is a parse error, not a resolution).
	if (options.host === "localhost") {
		return { ip: "127.0.0.1", port: options.port, family: 4 };
	}
	if (isIPv4(options.host)) {
		const octets = options.host.split(".").map(Number);
		if (octets[0] !== 127) {
			throw new Error(`refusing non-loopback web bind ${options.host}; Web UI is loopback-only`);
		}
		return { ip: options.host, port: options.port, family: 4 };
	}
	if (isIPv6(options.host)) {
		const groups = expandIpv6(options.host);
		const display = formatIpv6(groups);
		const isLoopback = groups.every((group, i) => (i === 7 ? group === 1 : group === 0));
		if (!isLoopback) {
			throw new Error(`refusing non-loopback web bind ${display}; Web UI is loopback-only`);
		}
		return { ip: display, port: options.port, family: 6 };
	}
	// pie: web.rs:835-836 — `.parse::<IpAddr>()` failure, wrapped with anyhow context.
	throw new Error(`parse --web-host \`${options.host}\` as an IP address`);
}

/** Expand any textual IPv6 form (already validated by `node:net`) to its eight 16-bit groups. */
function expandIpv6(host: string): number[] {
	const zone = host.indexOf("%");
	const bare = zone === -1 ? host : host.slice(0, zone);
	const [head, tail] = bare.includes("::") ? bare.split("::", 2) : [bare, undefined];
	const parseGroups = (part: string): number[] => {
		if (part === "") return [];
		const out: number[] = [];
		for (const piece of part.split(":")) {
			if (piece.includes(".")) {
				// Embedded IPv4 tail (`::ffff:127.0.0.1`) occupies two groups.
				const octets = piece.split(".").map(Number);
				out.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
				continue;
			}
			out.push(Number.parseInt(piece, 16));
		}
		return out;
	};
	const left = parseGroups(head);
	const right = tail === undefined ? [] : parseGroups(tail);
	return [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
}

/**
 * Rust `Ipv6Addr: Display` (RFC 5952): lowercase hex, no leading zeros, and the single longest run
 * of two-or-more zero groups collapsed to `::` (leftmost wins on a tie).
 * TODO(port): Rust additionally renders IPv4-compatible/-mapped addresses with a dotted tail
 * (`::ffff:127.0.0.1`). Only reachable inside the rejection message for a non-loopback v6 host, so
 * it is recorded rather than implemented.
 */
function formatIpv6(groups: readonly number[]): string {
	let bestStart = -1;
	let bestLen = 0;
	let runStart = -1;
	for (let i = 0; i <= groups.length; i++) {
		if (i < groups.length && groups[i] === 0) {
			if (runStart === -1) runStart = i;
			continue;
		}
		if (runStart !== -1) {
			const len = i - runStart;
			if (len > bestLen) {
				bestLen = len;
				bestStart = runStart;
			}
			runStart = -1;
		}
	}
	const hex = groups.map((group) => group.toString(16));
	if (bestLen < 2) return hex.join(":");
	return `${hex.slice(0, bestStart).join(":")}::${hex.slice(bestStart + bestLen).join(":")}`;
}

/** Rust `SocketAddr: Display` — v6 addresses are bracketed. */
export function formatSocketAddr(addr: BindAddr): string {
	return addr.family === 6 ? `[${addr.ip}]:${addr.port}` : `${addr.ip}:${addr.port}`;
}

/**
 * pie: web.rs:854-873 (`open_browser_command`). The three `#[cfg(target_os = ...)]` arms become a
 * runtime `process.platform` switch.
 */
export function openBrowserCommand(url: string): { command: string; args: string[] } {
	if (process.platform === "darwin") return { command: "open", args: [url] };
	if (process.platform === "win32") return { command: "cmd", args: ["/C", "start", "", url] };
	return { command: "xdg-open", args: [url] };
}

/**
 * pie: web.rs:844-852 (`open_web_browser`). All three stdio handles are nulled so the browser
 * launcher cannot scribble on the terminal the TUI shares; a spawn failure is an error (the caller
 * downgrades it to a warning).
 */
export function openWebBrowser(url: string): void {
	const { command, args } = openBrowserCommand(url);
	try {
		const child = spawnProcess(command, args, { stdio: ["ignore", "ignore", "ignore"] });
		// `Command::spawn` reports "no such binary" synchronously through its `Result`; Node reports
		// it asynchronously on the child's `error` event, which would become an unhandled exception
		// with no listener attached. The oracle's caller only prints a warning, so match that reach.
		child.on("error", () => {});
		child.unref();
	} catch (error) {
		// pie: web.rs:850 — `.context("spawn system browser")`.
		throw new Error("spawn system browser", { cause: error });
	}
}

/**
 * pie: web.rs:875 (`const INDEX_HTML: &str = include_str!("web_index.html")`).
 *
 * Rust embeds the file at compile time; TS has no `include_str!`, so the byte-identical
 * `web_index.html` sitting next to this module is read once, lazily, and memoised — lazily so that
 * merely importing this module performs no IO (tests import it for the pure helpers).
 *
 * TODO(port): `packages/coding-agent/package.json`'s `copy-assets` script does NOT copy
 * `src/ui/web_index.html` into `dist/ui/`, so a built (non-`tsx`) install would fail here. Raised
 * to the orchestrator rather than fixed — this unit must not edit `package.json`.
 */
let indexHtmlCache: string | undefined;

export function indexHtml(): string {
	if (indexHtmlCache === undefined) {
		indexHtmlCache = readFileSync(fileURLToPath(new URL("./web_index.html", import.meta.url)), "utf8");
	}
	return indexHtmlCache;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Server lifecycle — the half of `run_web` that does not touch `App`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

export interface WebServerHandle {
	/** The address actually bound — port 0 resolves to the kernel-assigned port. pie: web.rs:222. */
	addr: BindAddr;
	/** pie: web.rs:236 (`format!("http://{actual}")`). */
	url: string;
	server: Server;
	/**
	 * pie: web.rs:235 (`tokio::spawn(async move { server.await })`) joined at web.rs:323. Resolves
	 * when the server stops cleanly, rejects on a listener error.
	 */
	finished: Promise<void>;
	close(): Promise<void>;
}

/**
 * pie: web.rs:218-236 — bind, build the router, start serving, compute the announce URL. A
 * `tokio::net::TcpListener::bind` failure carries the context `bind web ui on {addr}`.
 */
export async function serveWeb(options: WebOptions, state: HttpState): Promise<WebServerHandle> {
	const addr = bindAddr(options);
	const server = createServer(webRouter(state));
	let onFinished: (() => void) | undefined;
	let onFailed: ((error: unknown) => void) | undefined;
	const finished = new Promise<void>((resolve, reject) => {
		onFinished = resolve;
		onFailed = reject;
	});

	await new Promise<void>((resolve, reject) => {
		const onListenError = (error: unknown): void => {
			// pie: web.rs:221 — `.with_context(|| format!("bind web ui on {addr}"))`.
			reject(new Error(`bind web ui on ${formatSocketAddr(addr)}`, { cause: error }));
		};
		server.once("error", onListenError);
		server.listen(addr.port, addr.ip, () => {
			server.removeListener("error", onListenError);
			// Post-bind errors belong to the long-lived "server task", not to the bind step.
			server.on("error", (error) => onFailed?.(error));
			server.on("close", () => onFinished?.());
			resolve();
		});
	});

	const bound = server.address();
	const actual: BindAddr = bound !== null && typeof bound === "object" ? { ...addr, port: bound.port } : addr;
	return {
		addr: actual,
		url: `http://${formatSocketAddr(actual)}`,
		server,
		finished,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * The `impl App` half — pie: web.rs:216-659.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/** The `kernel`/`harness` slice `web.rs` reaches through (`self.kernel.harness().…`). */
export interface WebKernel {
	harness(): {
		/** pie: web.rs:511, 528 (`harness.agent().state().model`). */
		getModel(): { provider: string; id: string } | undefined;
		/** pie: web.rs:562 (`harness.skills()`). */
		skills(): CommandSkill[];
	};
}

/**
 * The `App` slice `web.rs` uses (oracle `ui/mod.rs:118-178` fields plus the `impl App` methods it
 * calls). Declared structurally so this unit type-checks before `ui/index.ts` exists; a real `App`
 * whose member names match is assignable with no adapter. See the module doc.
 *
 * TODO(port): oracle takes each receiver out of its `Option` exactly once
 * (`self.feed_rx.take().expect("feed_rx taken once")`, web.rs:242-260) — a Rust ownership artifact
 * with no TS analogue, so the queues are plain fields here. `prompt_display` is a free function in
 * `ui/mod.rs:2172`; it is a member below so this file does not re-implement it.
 */
export interface WebApp {
	// ── plain fields ────────────────────────────────────────────────────────────────────────
	completer: SlashCompleter;
	registry: Registry;
	kernel: WebKernel;
	cwd: string;
	sessionId: string;
	logPath?: string;
	toolCount: number;
	history: { append(text: string): void };
	pendingSkill?: string;
	follow: boolean;
	busy: boolean;
	queuedTurns: QueuedTurn[];
	feed: Feed;
	latestTriggerPoll?: TriggerPollStatus;
	latestGoal?: GoalState;
	controlPlanePrompt?: UiControlPlanePromptLike;
	modelCatalog: ProviderGroup[];
	panelStatus: PanelStatus;
	relay?: RelayHandleLike;

	// ── receivers the web loop selects over (pie: web.rs:242-260) ───────────────────────────
	// `AsyncQueue<T>` is invariant (its public `waiters` array puts `T` in both positions), so these
	// carry the concrete element types `ui/index.ts` supplies rather than the widened stand-ins this
	// file declared before that unit landed. The consumers below are unaffected: `applyFeedUpdate`
	// takes `unknown` and `showControlPlanePrompt` takes {@link UiControlPlanePromptLike}, both of
	// which accept the narrower element.
	feedRx: AsyncQueue<FeedUpdate>;
	mainRunRx: AsyncQueue<string>;
	controlPlanePromptRx?: AsyncQueue<UiControlPlanePrompt>;
	relayPromptRx: AsyncQueue<string>;
	relayAbortRx: AsyncQueue<void>;
	relayResolveRx: AsyncQueue<boolean>;
	relayModelRx: AsyncQueue<string>;

	// ── methods ─────────────────────────────────────────────────────────────────────────────
	refreshGoalState(): Promise<void>;
	finishTurn(turn: TurnState, result: TurnResult): Promise<void>;
	applyFeedUpdate(update: unknown): void;
	startTriggeredTurn(traceId: string, turn: TurnState): void;
	submitRemoteText(text: string, turn: TurnState): void;
	systemLine(text: string): void;
	errorLine(text: string): void;
	requestAbort(turn: TurnState): void;
	resolveFromRelay(approve: boolean): void;
	setModelFromSpec(spec: string): Promise<void>;
	showControlPlanePrompt(prompt: UiControlPlanePromptLike): void;
	resolveControlPlanePrompt(decision: ControlPlanePromptDecision): void;
	currentModelAcceptsImages(): boolean;
	queueUserPrompt(display: string, prompt: string, images: ImageContent[]): void;
	startUserPromptTurn(prompt: string, images: ImageContent[], turn: TurnState): void;
	enqueueTurn(queued: QueuedTurn): void;
	startPromptTurn(prompt: string, errorContext: string, turn: TurnState): void;
	startTemplateTurn(name: string, vars: Record<string, unknown>, turn: TurnState): void;
	startCompactionTurn(custom: string | undefined, turn: TurnState): void;
	handleWebRelay(action: "connect" | "status" | "disconnect"): Promise<void>;
	promptImportActivation(sessionPath: string, triggerIds: string[], cronIds: string[]): void;
	/** pie: `super::prompt_display` (mod.rs:2172). */
	promptDisplay(text: string, imageCount: number): string;
}

/** The narrower slice {@link webSnapshot}/{@link webSidebarSnapshot} need — testable on its own. */
export type WebSnapshotSource = Pick<
	WebApp,
	| "sessionId"
	| "kernel"
	| "modelCatalog"
	| "cwd"
	| "busy"
	| "queuedTurns"
	| "latestTriggerPoll"
	| "latestGoal"
	| "controlPlanePrompt"
	| "feed"
	| "panelStatus"
>;

/** pie: web.rs:560 (`const ITEM_LIMIT: usize = 8`). */
const ITEM_LIMIT = 8;

/** pie: web.rs:526-557 (`App::web_snapshot`). */
export function webSnapshot(app: WebSnapshotSource): WebSnapshot {
	// pie: web.rs:527-534 — no active model renders as the literal `"no-model"`.
	const active = app.kernel.harness().getModel();
	const model = active === undefined ? "no-model" : `${active.provider}:${active.id}`;
	const goal = app.latestGoal;
	const prompt = app.controlPlanePrompt;
	return {
		session_id: app.sessionId,
		model,
		model_catalog: [...app.modelCatalog],
		cwd: app.cwd,
		busy: app.busy,
		queued_count: app.queuedTurns.length,
		latest_trigger_poll: app.latestTriggerPoll ?? null,
		// pie: web.rs:543-548 — both goal strings run through `bug_report::redact`.
		goal:
			goal === undefined
				? null
				: {
						condition: redact(goal.condition),
						status: goal.status,
						iterations: goal.iterations,
						last_reason: goal.last_reason === undefined ? null : redact(goal.last_reason),
					},
		control_plane_prompt: prompt === undefined ? null : webControlPlanePromptSnapshot(prompt.request),
		sidebar: webSidebarSnapshot(app),
		feed_blocks: app.feed.webBlocks(),
		feed_lines: webFeedLines(app.feed),
	};
}

/** pie: web.rs:559-645 (`App::web_sidebar_snapshot`). */
export function webSidebarSnapshot(app: WebSnapshotSource): WebSidebarSnapshot {
	const skills = app.kernel.harness().skills();
	const disabled = skills.filter((skill) => skill.disableModelInvocation).length;
	// pie: web.rs:567 — `saturating_sub`; both operands are non-negative counts, so a plain
	// subtraction cannot underflow here.
	const enabled = skills.length - disabled;
	const sourceCount = (source: CommandSkill["source"]): number =>
		skills.filter((skill) => skill.source === source).length;

	const rules = globalRegistry().list();
	const triggerEnabled = rules.filter((rule) => rule.enabled).length;
	const triggerRules: WebTriggerRuleSnapshot[] = rules.slice(0, ITEM_LIMIT).map((rule) => ({
		id: truncateChars(rule.id, 18),
		full_id: rule.id,
		enabled: rule.enabled,
		// pie: web.rs:579 — `fire_once` reads as "once", otherwise "repeat".
		mode: rule.fire_once ? "once" : "repeat",
		condition: webPreview(rule.condition),
		action: webPreview(rule.action),
	}));

	const cronJobs = globalCronRegistry().list();
	const cronEnabled = cronJobs.filter((job) => job.enabled).length;
	const cronJobRows: WebCronJobSnapshot[] = cronJobs.slice(0, ITEM_LIMIT).map((job) => ({
		id: truncateChars(job.id, 18),
		enabled: job.enabled,
		schedule: job.schedule,
		action: webPreview(job.action),
		skipped_overlap_count: job.skipped_overlap_count,
		last_error: job.last_error === undefined ? null : webPreview(job.last_error),
	}));

	return {
		inbox_new: newCount(defaultInboxPath()),
		skills: {
			// pie: web.rs:603-617 — `total` counts ALL skills and `items` is uncapped; only the
			// trigger and cron lists are truncated to ITEM_LIMIT.
			total: skills.length,
			enabled,
			disabled,
			builtin: sourceCount("builtin"),
			user: sourceCount("user"),
			project: sourceCount("project"),
			items: skills.map((skill) => ({
				name: skill.name,
				source: skillSourceLabel(skill.source),
				file_path: skill.filePath,
				enabled: !skill.disableModelInvocation,
			})),
		},
		triggers: {
			total: rules.length,
			enabled: triggerEnabled,
			disabled: rules.length - triggerEnabled,
			rules: triggerRules,
		},
		cron: {
			total: cronJobs.length,
			enabled: cronEnabled,
			disabled: cronJobs.length - cronEnabled,
			jobs: cronJobRows,
		},
		mcp: {
			servers: app.panelStatus.mcp_servers,
			tools: app.panelStatus.mcp_tools,
			notification_hooks: app.panelStatus.mcp_notification_hooks,
			server_names: [...app.panelStatus.mcp_server_names],
			tool_names: [...app.panelStatus.mcp_tool_names],
		},
		tools: {
			total: app.panelStatus.tool_names.length,
			names: [...app.panelStatus.tool_names],
		},
		hooks: [...app.panelStatus.hook_points],
		runtime: [...app.panelStatus.trigger_features],
	};
}

/** pie: web.rs:647-658 (`App::publish_snapshot`). */
export function publishSnapshot(app: WebApp, latest: SnapshotCell, snapshots: SnapshotBroadcast): void {
	const snapshot = webSnapshot(app);
	latest.set(snapshot);
	// pie: web.rs:654-656 — the relay viewer gets the same snapshot the browser does.
	app.relay?.pushSnapshot(snapshot);
	snapshots.send(snapshot);
}

/** pie: web.rs:355-383 (`App::trigger_web_rule_now`). */
export function triggerWebRuleNow(app: WebApp, rawId: string, turn: TurnState): void {
	const id = rawId.trim();
	if (id === "") {
		app.errorLine("trigger: missing rule id");
		return;
	}
	const rule = globalRegistry()
		.list()
		.find((candidate) => candidate.id === id);
	if (rule === undefined) {
		app.errorLine(`trigger: no dynamic trigger rule with id \`${id}\``);
		return;
	}
	const display = `trigger now ${truncateChars(rule.id, 18)}: ${webPreview(rule.action)}`;
	app.follow = true;
	if (turn.fut !== undefined) {
		app.queueUserPrompt(display, rule.action, []);
	} else {
		app.feed.pushUser(display);
		app.startUserPromptTurn(rule.action, [], turn);
	}
}

/** pie: web.rs:385-434 (`App::submit_web_text`). */
export async function submitWebText(
	app: WebApp,
	text: string,
	images: readonly WebPromptImage[],
	turn: TurnState,
): Promise<void> {
	const trimmed = text.trim();
	if (trimmed === "" && images.length === 0) {
		return;
	}
	let loadedImages: ImageContent[];
	try {
		loadedImages = loadWebPromptImages(images);
	} catch (error) {
		// pie: web.rs:397-400 — a decode failure is reported and the submit is abandoned.
		app.errorLine(`pasted image: ${errorMessage(error)}`);
		return;
	}
	if (loadedImages.length > 0 && !app.currentModelAcceptsImages()) {
		app.errorLine(
			`current model does not support image input; switch to a vision-capable model before sending ${loadedImages.length} image attachment(s)`,
		);
		return;
	}
	if (trimmed !== "") {
		app.history.append(trimmed);
	}
	app.follow = true;

	// pie: web.rs:414-418 — a slash command only dispatches when NO images are attached.
	if (trimmed.startsWith("/") && loadedImages.length === 0) {
		app.feed.pushUser(trimmed);
		await dispatchWebSlash(app, trimmed, turn);
		return;
	}

	const expanded = trimmed === "" ? "" : (await expandMentions(trimmed, app.cwd)).prompt;
	// pie: web.rs:426 — `self.pending_skill.take()`: read AND clear.
	const pendingSkill = app.pendingSkill;
	app.pendingSkill = undefined;
	const promptText = attachSkillPrompt(expanded, pendingSkill);
	const display = app.promptDisplay(trimmed, loadedImages.length);
	if (turn.fut !== undefined) {
		app.queueUserPrompt(display, promptText, loadedImages);
	} else {
		app.feed.pushUser(display);
		app.startUserPromptTurn(promptText, loadedImages, turn);
	}
}

/** pie: web.rs:436-524 (`App::dispatch_web_slash`). */
export async function dispatchWebSlash(app: WebApp, input: string, turn: TurnState): Promise<void> {
	const ctx: CommandCtx = {
		harness: app.kernel.harness() as unknown as CommandCtx["harness"],
		sessionId: app.sessionId,
		logPath: app.logPath,
		toolCount: app.toolCount,
		cwd: app.cwd,
	};
	const outcome: CommandOutcome = await dispatch(input, app.registry, ctx);
	switch (outcome.kind) {
		case "quit":
			// pie: web.rs:448-450 — /quit does NOT stop the web server.
			app.systemLine(
				"web ui stays running; close the browser tab or press Ctrl-C in the terminal to stop the server",
			);
			break;
		case "clear_screen":
			app.feed.clear();
			app.follow = true;
			break;
		case "error":
			app.errorLine(outcome.message);
			break;
		case "attach_skill":
			app.pendingSkill = outcome.name;
			break;
		case "run_agent_prompt":
			if (turn.fut !== undefined) {
				app.enqueueTurn({
					kind: "agent_prompt",
					display: input,
					prompt: outcome.prompt,
					errorContext: outcome.errorContext,
				});
			} else {
				app.startPromptTurn(outcome.prompt, outcome.errorContext, turn);
			}
			break;
		case "run_prompt_template":
			if (turn.fut !== undefined) {
				app.enqueueTurn({ kind: "prompt_template", display: input, name: outcome.name, vars: outcome.vars });
			} else {
				app.startTemplateTurn(outcome.name, outcome.vars, turn);
			}
			break;
		case "run_compaction":
			if (turn.fut !== undefined) {
				app.enqueueTurn({ kind: "compaction", display: input, custom: outcome.custom });
			} else {
				app.startCompactionTurn(outcome.custom, turn);
			}
			break;
		case "web_relay":
			await app.handleWebRelay(outcome.action);
			break;
		case "session_import_activation":
			app.promptImportActivation(outcome.sessionPath, outcome.triggerIds, outcome.cronIds);
			break;
		case "login_secret": {
			// pie: web.rs:500-509 — web login is unimplemented; point the user at the terminal.
			const command = outcome.recoveryCommand ?? `/login ${outcome.provider}`;
			app.errorLine(`web login is not implemented yet; run \`${command}\` from the terminal UI`);
			break;
		}
		case "open_model_picker": {
			const model = app.kernel.harness().getModel();
			const activeLine = model === undefined ? "(no model active)" : `active model: ${model.provider}:${model.id}`;
			app.systemLine(`${activeLine} — click the model name in the header to switch`);
			break;
		}
		case "handled":
			break;
	}
	// pie: web.rs:521-523 — `/goal …` (after leading whitespace) refreshes the cached goal state.
	if (input.trimStart().startsWith("/goal")) {
		await app.refreshGoalState();
	}
}

/** pie: web.rs:336-353 (`App::handle_web_command`). */
export async function handleWebCommand(app: WebApp, command: WebCommand, turn: TurnState): Promise<void> {
	switch (command.kind) {
		case "submit":
			await submitWebText(app, command.text, command.images, turn);
			break;
		case "trigger_rule_now":
			triggerWebRuleNow(app, command.id, turn);
			break;
		case "abort":
			app.requestAbort(turn);
			break;
		case "resolve_control_plane":
			// pie: web.rs:341-350 — a denial carries the fixed reason "denied by user".
			app.resolveControlPlanePrompt(
				command.approve ? { type: "allow" } : { type: "deny", reason: "denied by user" },
			);
			break;
		case "set_model":
			await app.setModelFromSpec(command.spec);
			break;
	}
}

/* ── the event loop — pie: web.rs:217-334 (`App::run_web`) ─────────────────────────────────── */

/** One settled `selectBiased` branch of the web event loop. */
type LoopEvent =
	| { branch: "turn"; result: TurnResult }
	| { branch: "command"; command: WebCommand | undefined }
	| { branch: "feed"; update: unknown }
	| { branch: "main_run"; traceId: string | undefined }
	| { branch: "relay_prompt"; text: string | undefined }
	| { branch: "relay_abort"; closed: boolean }
	| { branch: "relay_resolve"; approve: boolean | undefined }
	| { branch: "relay_model"; spec: string | undefined }
	| { branch: "control_plane"; prompt: UiControlPlanePromptLike | undefined }
	| { branch: "ctrl_c" }
	| { branch: "server" };

/** pie: web.rs:316 (`tokio::signal::ctrl_c()`). Unregisters itself when this branch loses. */
function ctrlCCase(): SelectCase<LoopEvent> {
	return {
		run: (signal) =>
			new Promise<LoopEvent>((resolve) => {
				const onSigint = (): void => {
					signal.removeEventListener("abort", onLose);
					resolve({ branch: "ctrl_c" });
				};
				const onLose = (): void => {
					process.removeListener("SIGINT", onSigint);
				};
				process.on("SIGINT", onSigint);
				signal.addEventListener("abort", onLose, { once: true });
			}),
	};
}

/** A `Some(x) = rx.recv()` branch: `AsyncQueue.next(signal)` releases its waiter when it loses. */
function queueCase<T>(queue: AsyncQueue<T>, wrap: (value: T | undefined) => LoopEvent): SelectCase<LoopEvent> {
	return { run: (signal) => queue.next(signal).then(wrap) };
}

/**
 * pie: web.rs:217-334 (`App::run_web`).
 *
 * The `select!` is `biased`, so branch order is load-bearing and {@link selectBiased} — not
 * {@link selectN} — is the required helper (RULEBOOK §2.2). Guarded branches (`, if cond`) are
 * omitted from the case array on the iterations where the guard is false, exactly as tokio skips a
 * disabled branch.
 *
 * A `Some(x) = rx.recv()` pattern that yields `None` (channel closed) does not match, so tokio
 * disables that branch permanently. TS equivalent: a branch resolving `undefined` performs no work,
 * and because `AsyncQueue.next` on a closed queue resolves `undefined` *immediately* (which would
 * spin the loop), the branch is dropped from the case array for the remaining iterations.
 */
export async function runWeb(app: WebApp, options: WebOptions): Promise<void> {
	const commands = new AsyncQueue<WebCommand>();
	const snapshots = createSnapshotBroadcast();
	const latest = createSnapshotCell(webSnapshot(app));
	const handle = await serveWeb(options, { commands, snapshots, latest, completer: app.completer });

	// pie: web.rs:235 — the server future is joined by the loop below, so this is §2.2's
	// "spawn + JoinHandle.await" row: keep the promise, await it at the join site (the branch).
	let serverFailure: unknown;
	const serverTask = handle.finished.then(
		() => undefined,
		(error: unknown) => {
			serverFailure = error;
		},
	);

	// pie: web.rs:236-240. RULEBOOK §1 sanctions `console.*` on the CLI stdout path.
	console.log(`pie web listening on ${handle.url}`);
	try {
		openWebBrowser(handle.url);
	} catch (error) {
		console.error(`web browser auto-open skipped: ${errorMessage(error)}`);
	}

	// pie: web.rs:261-263 (`TurnState::default()` then refresh + publish).
	const turn: TurnState = newTurnState();
	await app.refreshGoalState();
	publishSnapshot(app, latest, snapshots);

	/** Branches permanently disabled by a closed channel (see this function's doc). */
	const closed = new Set<LoopEvent["branch"]>();

	try {
		for (;;) {
			const cases: SelectCase<LoopEvent>[] = [];
			const add = (branch: LoopEvent["branch"], selectCase: SelectCase<LoopEvent>): void => {
				if (closed.has(branch)) return;
				cases.push(selectCase);
			};

			// pie: web.rs:268-271 — `result = poll_turn(&mut turn.fut), if turn.fut.is_some()`.
			// Re-awaiting the same promise each iteration is the TS analogue of `&mut turn.fut`:
			// progress is not lost when this branch loses, because the promise itself keeps running.
			if (turn.fut !== undefined) {
				const pending = pollTurn(turn.fut);
				add("turn", {
					run: async (): Promise<LoopEvent> => {
						try {
							return { branch: "turn", result: { ok: true, value: await pending } };
						} catch (error) {
							return { branch: "turn", result: { ok: false, error } };
						}
					},
				});
			}
			// pie: web.rs:272-275.
			add(
				"command",
				queueCase(commands, (command) => ({ branch: "command", command })),
			);
			// pie: web.rs:276-282.
			add(
				"feed",
				queueCase(app.feedRx, (update) => ({ branch: "feed", update })),
			);
			// pie: web.rs:283-286 — guarded on `turn.fut.is_none()`.
			if (turn.fut === undefined) {
				add(
					"main_run",
					queueCase(app.mainRunRx, (traceId) => ({ branch: "main_run", traceId })),
				);
			}
			// pie: web.rs:287-290.
			add(
				"relay_prompt",
				queueCase(app.relayPromptRx, (text) => ({ branch: "relay_prompt", text })),
			);
			// pie: web.rs:291-297 — the payload is `()`, so "closed" is the only distinguishable state.
			add(
				"relay_abort",
				queueCase(app.relayAbortRx, (value) => ({ branch: "relay_abort", closed: value === undefined })),
			);
			// pie: web.rs:298-301.
			add(
				"relay_resolve",
				queueCase(app.relayResolveRx, (approve) => ({ branch: "relay_resolve", approve })),
			);
			// pie: web.rs:302-306.
			add(
				"relay_model",
				queueCase(app.relayModelRx, (spec) => ({ branch: "relay_model", spec })),
			);
			// pie: web.rs:307-315 — guarded on `control_plane_prompt.is_none() && rx.is_some()`.
			const promptRx = app.controlPlanePromptRx;
			if (promptRx !== undefined && app.controlPlanePrompt === undefined) {
				add(
					"control_plane",
					queueCase(promptRx, (prompt) => ({ branch: "control_plane", prompt })),
				);
			}
			// pie: web.rs:316-322.
			add("ctrl_c", ctrlCCase());
			// pie: web.rs:323-330.
			add("server", {
				run: async (): Promise<LoopEvent> => {
					await serverTask;
					return { branch: "server" };
				},
			});

			const { value } = await selectBiased(cases);

			switch (value.branch) {
				case "turn":
					await app.finishTurn(turn, value.result);
					publishSnapshot(app, latest, snapshots);
					break;
				case "command":
					if (value.command === undefined) {
						closed.add("command");
						break;
					}
					await handleWebCommand(app, value.command, turn);
					publishSnapshot(app, latest, snapshots);
					break;
				case "feed": {
					if (value.update === undefined) {
						closed.add("feed");
						break;
					}
					app.applyFeedUpdate(value.update);
					// pie: web.rs:278-280 — `while let Ok(update) = feed_rx.try_recv()`: drain what
					// is already buffered before republishing, so a burst of feed updates costs one
					// snapshot instead of one per update. `try_recv` is non-blocking, hence the
					// `size` guard rather than an unguarded `await next()`.
					while (app.feedRx.size > 0) {
						const extra = await app.feedRx.next();
						if (extra === undefined) break;
						app.applyFeedUpdate(extra);
					}
					publishSnapshot(app, latest, snapshots);
					break;
				}
				case "main_run":
					if (value.traceId === undefined) {
						closed.add("main_run");
						break;
					}
					app.startTriggeredTurn(value.traceId, turn);
					publishSnapshot(app, latest, snapshots);
					break;
				case "relay_prompt":
					if (value.text === undefined) {
						closed.add("relay_prompt");
						break;
					}
					app.submitRemoteText(value.text, turn);
					publishSnapshot(app, latest, snapshots);
					break;
				case "relay_abort":
					if (value.closed) {
						closed.add("relay_abort");
						break;
					}
					// pie: web.rs:292-296 — an abort with no turn in flight is silently ignored.
					if (turn.fut !== undefined) {
						app.systemLine("[web] abort requested");
						app.requestAbort(turn);
						publishSnapshot(app, latest, snapshots);
					}
					break;
				case "relay_resolve":
					if (value.approve === undefined) {
						closed.add("relay_resolve");
						break;
					}
					app.resolveFromRelay(value.approve);
					publishSnapshot(app, latest, snapshots);
					break;
				case "relay_model":
					if (value.spec === undefined) {
						closed.add("relay_model");
						break;
					}
					app.systemLine(`[web] set model: ${value.spec}`);
					await app.setModelFromSpec(value.spec);
					publishSnapshot(app, latest, snapshots);
					break;
				case "control_plane":
					if (value.prompt === undefined) {
						closed.add("control_plane");
						break;
					}
					app.showControlPlanePrompt(value.prompt);
					publishSnapshot(app, latest, snapshots);
					break;
				case "ctrl_c":
					// pie: web.rs:316-322 — Ctrl-C aborts an in-flight turn AND leaves the loop.
					if (turn.fut !== undefined) {
						app.requestAbort(turn);
						publishSnapshot(app, latest, snapshots);
					}
					return;
				case "server":
					// pie: web.rs:323-330 — a serve error is reported on the feed, then the loop ends
					// either way. Oracle distinguishes `Ok(Err(e))` (serve error) from `Err(e)` (join
					// error); Node has no join-handle layer, so only the serve error exists.
					if (serverFailure !== undefined) {
						app.errorLine(`web server: ${errorMessage(serverFailure)}`);
					}
					return;
			}
		}
	} finally {
		commands.close();
		await handle.close();
	}
}
