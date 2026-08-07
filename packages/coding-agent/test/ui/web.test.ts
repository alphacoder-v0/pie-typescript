/**
 * Ported `#[cfg(test)] mod tests` of oracle `crates/coding-agent/src/ui/web.rs:877-1200`
 * (pie @0a120dfd), plus the extra characterization the TS port's substituted plumbing needs:
 * `node:http` standing in for axum (status codes, headers, SSE framing), a strict base64 decoder
 * standing in for `base64::engine::general_purpose::STANDARD`, and a full-shape probe over
 * `WebSnapshot` (RULEBOOK §4's wire-construct probe gate).
 *
 * Hermetic: every server binds `127.0.0.1:0` (kernel-assigned port) and nothing leaves loopback.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AsyncQueue } from "@pie/agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { PIE_BUILTIN_COMMANDS } from "../../src/core/slash-commands.ts";
import { SlashCompleter } from "../../src/readline.ts";
import { globalCronRegistry, globalRegistry } from "../../src/triggers/index.ts";
import { Feed } from "../../src/ui/feed.ts";
import {
	bindAddr,
	createSnapshotBroadcast,
	createSnapshotCell,
	type HttpState,
	indexHtml,
	loadWebPromptImages,
	type PanelStatus,
	serveWeb,
	type WebCommand,
	type WebSidebarSnapshot,
	type WebSnapshot,
	type WebSnapshotSource,
	webControlPlanePromptSnapshot,
	webFeedLines,
	webSidebarSnapshot,
	webSnapshot,
} from "../../src/ui/web.ts";
import { MAX_IMAGES_PER_MESSAGE } from "../../src/utils/image-convert.ts";

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * bind_addr — oracle web.rs:884-910. THE loopback-only gate.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

describe("bindAddr", () => {
	/** pie: web.rs:884-893 (`bind_addr_rejects_remote_by_default`). */
	it("rejects remote by default", () => {
		let message = "";
		try {
			bindAddr({ host: "0.0.0.0", port: 0 });
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain("refusing non-loopback");
	});

	/** pie: web.rs:895-910 (`bind_addr_accepts_loopback_and_localhost`). */
	it("accepts loopback and localhost", () => {
		const local = bindAddr({ host: "127.0.0.1", port: 0 });
		expect(local.ip).toBe("127.0.0.1");
		expect(local.family).toBe(4);

		const named = bindAddr({ host: "localhost", port: 0 });
		// pie: web.rs:833 — `"localhost"` is aliased to `Ipv4Addr::LOCALHOST`, never DNS-resolved.
		expect(named.ip).toBe("127.0.0.1");
		expect(named.family).toBe(4);
	});

	// The remaining cases are not in oracle's test module but pin the substituted IP parser against
	// `IpAddr::is_loopback()`/`FromStr`, which is the whole security surface of this file.
	it("accepts the whole 127.0.0.0/8 loopback block, matching Ipv4Addr::is_loopback", () => {
		expect(bindAddr({ host: "127.0.0.2", port: 7777 })).toEqual({ ip: "127.0.0.2", port: 7777, family: 4 });
		expect(bindAddr({ host: "127.255.255.254", port: 1 }).ip).toBe("127.255.255.254");
	});

	it("accepts ::1 in any spelling and rejects every other v6 address", () => {
		expect(bindAddr({ host: "::1", port: 0 })).toEqual({ ip: "::1", port: 0, family: 6 });
		expect(bindAddr({ host: "0:0:0:0:0:0:0:1", port: 0 }).ip).toBe("::1");
		expect(() => bindAddr({ host: "::2", port: 0 })).toThrow(/refusing non-loopback web bind ::2/);
		expect(() => bindAddr({ host: "2001:db8::1", port: 0 })).toThrow(/refusing non-loopback web bind 2001:db8::1/);
	});

	it("rejects public v4 addresses with the verbatim oracle message", () => {
		expect(() => bindAddr({ host: "10.0.0.5", port: 0 })).toThrow(
			"refusing non-loopback web bind 10.0.0.5; Web UI is loopback-only",
		);
		// `::ffff:127.0.0.1` is an IPv4-MAPPED address; Rust's `Ipv6Addr::is_loopback` is `::1` only,
		// so a mapped loopback is still refused. Regression guard against "helpfully" unwrapping it.
		expect(() => bindAddr({ host: "::ffff:127.0.0.1", port: 0 })).toThrow(/refusing non-loopback/);
	});

	it("rejects a hostname that is not an IP literal rather than resolving it", () => {
		// pie: web.rs:835-836 — anyhow context on `.parse::<IpAddr>()`.
		expect(() => bindAddr({ host: "example.com", port: 0 })).toThrow(
			"parse --web-host `example.com` as an IP address",
		);
	});
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * web_feed_lines — oracle web.rs:912-937.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

describe("webFeedLines", () => {
	/** pie: web.rs:912-937 (`web_feed_lines_keeps_all_rows`). */
	it("keeps all rows", () => {
		const feed = new Feed();
		for (let i = 0; i < 250; i++) {
			feed.apply({ kind: "plain", text: `line ${i}`, level: "output" });
		}

		const lines = webFeedLines(feed);
		expect(lines.length).toBe(250);
		expect(lines[0]).toContain("line 0");
		expect(lines[lines.length - 1]).toContain("line 249");
		// The timestamp prefix `YYYY-MM-DD HH:MM ` — oracle asserts these four code points.
		const first = [...lines[0]];
		expect(first[4]).toBe("-");
		expect(first[7]).toBe("-");
		expect(first[10]).toBe(" ");
		expect(first[13]).toBe(":");
	});
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * load_web_prompt_images — oracle web.rs:939-964.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

const PNG_BYTES = Buffer.from("\x89PNG\r\n\x1a\npng", "latin1");
const PNG_BASE64 = PNG_BYTES.toString("base64");

describe("loadWebPromptImages", () => {
	/** pie: web.rs:939-951 (`web_prompt_images_decode_to_image_content`). */
	it("decodes to image content", () => {
		const images = loadWebPromptImages([{ data: PNG_BASE64, name: "clip.png" }]);
		expect(images.length).toBe(1);
		expect(images[0].mimeType).toBe("image/png");
		expect(images[0].data.length).toBeGreaterThan(0);
	});

	/** pie: web.rs:953-964 (`web_prompt_images_enforce_count_limit`). */
	it("enforces the count limit", () => {
		const images = new Array(MAX_IMAGES_PER_MESSAGE + 1).fill({ data: "" });
		let message = "";
		try {
			loadWebPromptImages(images);
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain("exceeds per-message cap");
		// `bail!` renders the count verbatim (web.rs:804-808).
		expect(message).toBe(`${MAX_IMAGES_PER_MESSAGE + 1} images exceeds per-message cap of ${MAX_IMAGES_PER_MESSAGE}`);
	});

	// Below: not in oracle's module, but they pin decisions the port had to make.
	it("strips a data: URL prefix at the LAST comma (rsplit_once)", () => {
		const images = loadWebPromptImages([{ data: `data:image/png;base64,${PNG_BASE64}` }]);
		expect(images[0].mimeType).toBe("image/png");
	});

	it("labels a blank or absent name by ordinal, and a present name by backtick-quoted name", () => {
		// pie: web.rs:812-817 — `filter(|name| !name.trim().is_empty())`.
		expect(() => loadWebPromptImages([{ data: "!!!!", name: "   " }])).toThrow("decode clipboard image #1");
		expect(() => loadWebPromptImages([{ data: "!!!!" }])).toThrow("decode clipboard image #1");
		expect(() => loadWebPromptImages([{ data: "!!!!", name: "shot.png" }])).toThrow(
			"decode clipboard image `shot.png`",
		);
	});

	it("decodes strictly: Rust's STANDARD engine rejects what Buffer.from would silently accept", () => {
		// Unpadded — Rust STANDARD requires canonical padding; Node would happily decode this.
		expect(() => loadWebPromptImages([{ data: PNG_BASE64.replace(/=+$/, "") }])).toThrow(/^decode /);
		// URL-safe alphabet is a different engine in Rust; STANDARD rejects `-`/`_`.
		expect(() => loadWebPromptImages([{ data: "-___" }])).toThrow(/^decode /);
		// Embedded whitespace: Node skips it, Rust does not.
		expect(() => loadWebPromptImages([{ data: "AA A=" }])).toThrow(/^decode /);
	});

	it("wraps the decode failure as a cause chain (§2.4 anyhow context)", () => {
		try {
			loadWebPromptImages([{ data: "!!!!", name: "clip.png" }]);
			expect.unreachable("expected a decode failure");
		} catch (error) {
			expect((error as Error).message).toBe("decode clipboard image `clip.png`");
			expect((error as Error).cause).toBeInstanceOf(Error);
		}
	});

	it("accepts an empty payload list without touching the decoder", () => {
		expect(loadWebPromptImages([])).toEqual([]);
	});
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Snapshot builders — RULEBOOK §4 wire-construct probe (full-shape, not a projection).
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

const EMPTY_PANEL_STATUS: PanelStatus = {
	mcp_servers: 0,
	mcp_tools: 0,
	mcp_server_names: [],
	mcp_tool_names: [],
	tool_names: [],
	mcp_notification_hooks: 0,
	hook_points: [],
	trigger_features: [],
};

function snapshotSource(overrides: Partial<WebSnapshotSource> = {}): WebSnapshotSource {
	return {
		sessionId: "sess-1",
		kernel: { harness: () => ({ getModel: () => undefined, skills: () => [] }) },
		modelCatalog: [],
		cwd: "/tmp/pie",
		busy: false,
		queuedTurns: [],
		latestTriggerPoll: undefined,
		latestGoal: undefined,
		controlPlanePrompt: undefined,
		feed: new Feed(),
		panelStatus: EMPTY_PANEL_STATUS,
		...overrides,
	};
}

/** `inbox_new` reads the real default inbox path (oracle's own fixture does too) — normalise it. */
function withZeroedInbox(sidebar: WebSidebarSnapshot): WebSidebarSnapshot {
	return { ...sidebar, inbox_new: 0 };
}

/** pie: web.rs:1161-1199 (`empty_sidebar_snapshot`) — the oracle's own zero fixture. */
const EMPTY_SIDEBAR: WebSidebarSnapshot = {
	inbox_new: 0,
	skills: { total: 0, enabled: 0, disabled: 0, builtin: 0, user: 0, project: 0, items: [] },
	triggers: { total: 0, enabled: 0, disabled: 0, rules: [] },
	cron: { total: 0, enabled: 0, disabled: 0, jobs: [] },
	mcp: { servers: 0, tools: 0, notification_hooks: 0, server_names: [], tool_names: [] },
	tools: { total: 0, names: [] },
	hooks: [],
	runtime: [],
};

describe("webSnapshot", () => {
	it("emits every wire key, with serde's null (not an omitted key) for each absent Option", () => {
		const snapshot = webSnapshot(snapshotSource());
		// Full top-level key set, in declaration order (web.rs:59-71).
		expect(Object.keys(snapshot)).toEqual([
			"session_id",
			"model",
			"model_catalog",
			"cwd",
			"busy",
			"queued_count",
			"latest_trigger_poll",
			"goal",
			"control_plane_prompt",
			"sidebar",
			"feed_blocks",
			"feed_lines",
		]);
		// `Option<T>` with no `skip_serializing_if` serializes as JSON `null`, and a round-trip
		// through JSON must keep the key present.
		const roundTripped = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
		expect(roundTripped.latest_trigger_poll).toBeNull();
		expect(roundTripped.goal).toBeNull();
		expect(roundTripped.control_plane_prompt).toBeNull();
		expect("goal" in roundTripped).toBe(true);
	});

	it("renders the no-model case as the literal `no-model` (web.rs:533)", () => {
		expect(webSnapshot(snapshotSource()).model).toBe("no-model");
	});

	it("renders an active model as provider:id (web.rs:532)", () => {
		const source = snapshotSource({
			kernel: {
				harness: () => ({
					getModel: () => ({ provider: "anthropic", id: "claude-haiku-4-5" }),
					skills: () => [],
				}),
			},
		});
		expect(webSnapshot(source).model).toBe("anthropic:claude-haiku-4-5");
	});

	it("counts queued turns and mirrors busy/cwd/session (web.rs:536-541)", () => {
		const source = snapshotSource({
			busy: true,
			queuedTurns: [
				{ kind: "compaction", display: "/compact" },
				{ kind: "compaction", display: "/compact" },
			],
		});
		const snapshot = webSnapshot(source);
		expect(snapshot.busy).toBe(true);
		expect(snapshot.queued_count).toBe(2);
		expect(snapshot.cwd).toBe("/tmp/pie");
		expect(snapshot.session_id).toBe("sess-1");
	});

	it("redacts the goal condition and reason, and keeps null for an absent reason (web.rs:543-548)", () => {
		const secret = `sk-ant-api03-${"A".repeat(48)}`;
		const source = snapshotSource({
			latestGoal: {
				condition: `ship it with ${secret}`,
				status: "pursuing",
				iterations: 3,
				updated_at: "2026-08-04T00:00:00Z",
			},
		});
		const goal = webSnapshot(source).goal;
		expect(goal).not.toBeNull();
		expect(goal?.status).toBe("pursuing");
		expect(goal?.iterations).toBe(3);
		expect(goal?.last_reason).toBeNull();
		expect(goal?.condition).not.toContain(secret);
		expect(Object.keys(goal ?? {})).toEqual(["condition", "status", "iterations", "last_reason"]);
	});

	it("carries the rendered feed into both feed_blocks and feed_lines (web.rs:554-555)", () => {
		const feed = new Feed();
		feed.pushUser("hello");
		const snapshot = webSnapshot(snapshotSource({ feed }));
		expect(snapshot.feed_blocks.length).toBe(1);
		expect(snapshot.feed_blocks[0].kind).toBe("user");
		expect(snapshot.feed_lines.join("\n")).toContain("hello");
	});
});

describe("webSidebarSnapshot", () => {
	const addedRuleIds: string[] = [];
	const addedJobIds: string[] = [];

	afterEach(() => {
		// The registries are process-global singletons with no storagePath in tests, so this is a
		// pure in-memory cleanup — nothing is written to disk (dynamic.ts:395, cron.ts:587).
		for (const id of addedRuleIds.splice(0)) globalRegistry().removeRule(id);
		for (const id of addedJobIds.splice(0)) globalCronRegistry().removeJob(id);
	});

	it("matches the oracle's empty fixture shape exactly (web.rs:1161-1199)", () => {
		expect(withZeroedInbox(webSidebarSnapshot(snapshotSource()))).toEqual(EMPTY_SIDEBAR);
	});

	it("counts skills by source and by enablement (web.rs:562-568, 600-618)", () => {
		const skills = [
			{ name: "a", description: "", filePath: "/a", disableModelInvocation: false, source: "builtin" as const },
			{ name: "b", description: "", filePath: "/b", disableModelInvocation: true, source: "user" as const },
			{ name: "c", description: "", filePath: "/c", disableModelInvocation: false, source: "project" as const },
			{ name: "d", description: "", filePath: "/d", disableModelInvocation: false, source: "user" as const },
		];
		const sidebar = webSidebarSnapshot(
			snapshotSource({ kernel: { harness: () => ({ getModel: () => undefined, skills: () => skills }) } }),
		);
		expect(sidebar.skills.total).toBe(4);
		expect(sidebar.skills.enabled).toBe(3);
		expect(sidebar.skills.disabled).toBe(1);
		expect(sidebar.skills.builtin).toBe(1);
		expect(sidebar.skills.user).toBe(2);
		expect(sidebar.skills.project).toBe(1);
		// `items` is NOT capped at ITEM_LIMIT (only triggers/cron are) and `enabled` is the inverse
		// of `disable_model_invocation`.
		expect(sidebar.skills.items).toEqual([
			{ name: "a", source: "builtin", file_path: "/a", enabled: true },
			{ name: "b", source: "user", file_path: "/b", enabled: false },
			{ name: "c", source: "project", file_path: "/c", enabled: true },
			{ name: "d", source: "user", file_path: "/d", enabled: true },
		]);
	});

	it("caps the trigger rule list at ITEM_LIMIT while total counts them all (web.rs:560, 573-583)", () => {
		for (let i = 0; i < 10; i++) {
			addedRuleIds.push(globalRegistry().addRule(`condition ${i}`, `action ${i}`).id);
		}
		const sidebar = webSidebarSnapshot(snapshotSource());
		expect(sidebar.triggers.total).toBe(10);
		expect(sidebar.triggers.enabled).toBe(10);
		expect(sidebar.triggers.disabled).toBe(0);
		expect(sidebar.triggers.rules.length).toBe(8);
		// `id` is truncated to 18 code points while `full_id` keeps the whole thing (web.rs:576-577).
		const row = sidebar.triggers.rules[0];
		expect(row.full_id).toBe(addedRuleIds[0]);
		expect([...row.id].length).toBeLessThanOrEqual(19); // 18 + the appended ellipsis
		expect(row.full_id.startsWith(row.id.replace(/…$/, ""))).toBe(true);
		// `fire_once` renders as "once" — `addRule` sets it (dynamic.ts:356).
		expect(row.mode).toBe("once");
		expect(row.action).toBe("action 0");
	});

	it("caps the cron job list at ITEM_LIMIT and previews the action (web.rs:585-598)", () => {
		for (let i = 0; i < 9; i++) {
			addedJobIds.push(globalCronRegistry().addJob("*/5 * * * *", `cron action ${i}`).id);
		}
		const sidebar = webSidebarSnapshot(snapshotSource());
		expect(sidebar.cron.total).toBe(9);
		expect(sidebar.cron.jobs.length).toBe(8);
		expect(sidebar.cron.jobs[0].schedule).toBe("*/5 * * * *");
		expect(sidebar.cron.jobs[0].action).toBe("cron action 0");
		expect(sidebar.cron.jobs[0].skipped_overlap_count).toBe(0);
		// `Option<String>` with no skip ⇒ serde null, so an absent last_error is null not omitted.
		expect(sidebar.cron.jobs[0].last_error).toBeNull();
		expect("last_error" in sidebar.cron.jobs[0]).toBe(true);
	});

	it("copies the panel status through unchanged (web.rs:631-643)", () => {
		const sidebar = webSidebarSnapshot(
			snapshotSource({
				panelStatus: {
					mcp_servers: 2,
					mcp_tools: 7,
					mcp_server_names: ["fs", "git"],
					mcp_tool_names: ["read", "write"],
					tool_names: ["bash", "edit", "read"],
					mcp_notification_hooks: 1,
					hook_points: ["before_tool_call"],
					trigger_features: ["dedup", "cycle"],
				},
			}),
		);
		expect(sidebar.mcp).toEqual({
			servers: 2,
			tools: 7,
			notification_hooks: 1,
			server_names: ["fs", "git"],
			tool_names: ["read", "write"],
		});
		// `tools.total` is the TOOL name count, not `mcp.tools` (web.rs:638-641).
		expect(sidebar.tools).toEqual({ total: 3, names: ["bash", "edit", "read"] });
		expect(sidebar.hooks).toEqual(["before_tool_call"]);
		expect(sidebar.runtime).toEqual(["dedup", "cycle"]);
	});
});

describe("webControlPlanePromptSnapshot", () => {
	/** pie: web.rs:784-796. */
	it("truncates each field at its own cap and takes 12 code points of the hash", () => {
		const snapshot = webControlPlanePromptSnapshot({
			toolCallId: "call-1",
			toolName: "T".repeat(200),
			label: "L".repeat(400),
			argsHash: "0123456789abcdef0123",
			payload: { b: 1, a: [2, 3] },
			reason: "R".repeat(400),
		});
		// `truncate_chars` appends an ellipsis when it shortens, so cap + 1 code points.
		expect([...snapshot.tool_name].length).toBe(81);
		expect([...snapshot.label].length).toBe(161);
		expect([...snapshot.reason].length).toBe(181);
		// `chars().take(12)` — no ellipsis on args_hash (web.rs:793).
		expect(snapshot.args_hash).toBe("0123456789ab");
	});

	it("pretty-prints the payload with 2-space indent and insertion order (serde preserve_order)", () => {
		const snapshot = webControlPlanePromptSnapshot({
			toolCallId: "call-1",
			toolName: "InstallSkill",
			argsHash: "abc",
			label: "install",
			payload: { b: 1, a: [2, 3] },
			reason: "policy",
		});
		expect(snapshot.payload).toBe('{\n  "b": 1,\n  "a": [\n    2,\n    3\n  ]\n}');
		expect(snapshot.args_hash).toBe("abc");
	});
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * HTTP surface — oracle web.rs:966-1159
 * (`endpoints_return_state_accept_commands_and_stream_snapshots`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

function baseSnapshot(overrides: Partial<WebSnapshot> = {}): WebSnapshot {
	// pie: web.rs:970-983 — the oracle's literal fixture.
	return {
		session_id: "sess-1",
		model: "provider:model",
		model_catalog: [],
		cwd: "/tmp/pie",
		busy: false,
		queued_count: 0,
		latest_trigger_poll: null,
		goal: null,
		control_plane_prompt: null,
		sidebar: EMPTY_SIDEBAR,
		feed_blocks: [],
		feed_lines: ["ready"],
		...overrides,
	};
}

interface Harness {
	base: string;
	commands: AsyncQueue<WebCommand>;
	state: HttpState;
	close(): Promise<void>;
}

async function startHarness(): Promise<Harness> {
	const commands = new AsyncQueue<WebCommand>();
	const state: HttpState = {
		commands,
		snapshots: createSnapshotBroadcast(),
		latest: createSnapshotCell(baseSnapshot()),
		// pie: web.rs:988 — `SlashCompleter::from_registry(&Registry::with_builtins())`.
		completer: SlashCompleter.fromRegistry(PIE_BUILTIN_COMMANDS),
	};
	// pie: web.rs:990 — `TcpListener::bind("127.0.0.1:0")`.
	const handle = await serveWeb({ host: "127.0.0.1", port: 0 }, state);
	return { base: handle.url, commands, state, close: () => handle.close() };
}

function postJson(url: string, body: unknown): Promise<Response> {
	return fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("web endpoints", () => {
	/** pie: web.rs:966-1159 — one test, walked endpoint by endpoint, same order and assertions. */
	it("return state, accept commands and stream snapshots", async () => {
		const h = await startHarness();
		try {
			// pie: web.rs:1000-1010 — GET /state.
			const state = (await (await fetch(`${h.base}/state`)).json()) as Record<string, unknown>;
			expect(state.session_id).toBe("sess-1");
			expect(state.cwd).toBe("/tmp/pie");
			expect((state.feed_lines as string[])[0]).toBe("ready");

			// pie: web.rs:1012-1028 — POST /prompt, text only.
			let accepted = (await (await postJson(`${h.base}/prompt`, { text: "hello" })).json()) as {
				accepted: boolean;
			};
			expect(accepted.accepted).toBe(true);
			let command = await h.commands.next();
			expect(command).toEqual({ kind: "submit", text: "hello", images: [] });

			// pie: web.rs:1030-1053 — POST /prompt with one image.
			accepted = (await (
				await postJson(`${h.base}/prompt`, {
					text: "describe",
					images: [{ name: "clip.png", data: PNG_BASE64 }],
				})
			).json()) as { accepted: boolean };
			expect(accepted.accepted).toBe(true);
			command = await h.commands.next();
			if (command?.kind !== "submit") throw new Error("unexpected command");
			expect(command.text).toBe("describe");
			expect(command.images.length).toBe(1);
			expect(command.images[0].name).toBe("clip.png");

			// pie: web.rs:1055-1067 — POST /abort (no body).
			accepted = (await (await fetch(`${h.base}/abort`, { method: "POST" })).json()) as { accepted: boolean };
			expect(accepted.accepted).toBe(true);
			expect(await h.commands.next()).toEqual({ kind: "abort" });

			// pie: web.rs:1069-1082 — POST /trigger/immediate.
			accepted = (await (await postJson(`${h.base}/trigger/immediate`, { id: "rule-123" })).json()) as {
				accepted: boolean;
			};
			expect(accepted.accepted).toBe(true);
			expect(await h.commands.next()).toEqual({ kind: "trigger_rule_now", id: "rule-123" });

			// pie: web.rs:1084-1097 — POST /control-plane/resolve.
			accepted = (await (await postJson(`${h.base}/control-plane/resolve`, { approve: true })).json()) as {
				accepted: boolean;
			};
			expect(accepted.accepted).toBe(true);
			expect(await h.commands.next()).toEqual({ kind: "resolve_control_plane", approve: true });

			// pie: web.rs:1099-1112 — POST /model; the wire field is `model`, the command is `spec`.
			accepted = (await (await postJson(`${h.base}/model`, { model: "anthropic:claude-haiku-4-5" })).json()) as {
				accepted: boolean;
			};
			expect(accepted.accepted).toBe(true);
			expect(await h.commands.next()).toEqual({ kind: "set_model", spec: "anthropic:claude-haiku-4-5" });

			// pie: web.rs:1114-1128 — POST /complete.
			const completions = (await (await postJson(`${h.base}/complete`, { text: "/he" })).json()) as {
				completions: string[];
			};
			expect(completions.completions).toContain("/help");

			// pie: web.rs:1130-1156 — GET /events, then broadcast one snapshot and read the frame.
			const response = await fetch(`${h.base}/events`);
			expect(response.ok).toBe(true);
			const reader = (response.body as ReadableStream<Uint8Array>).getReader();
			h.state.snapshots.send(baseSnapshot({ busy: true, queued_count: 1, feed_lines: ["streamed"] }));
			const chunk = await reader.read();
			const text = new TextDecoder().decode(chunk.value);
			expect(text).toContain("event: snapshot");
			expect(text).toContain("streamed");
			await reader.cancel();
		} finally {
			await h.close();
		}
	});

	it("frames each SSE event exactly as axum's Event::default().event(..).data(..)", async () => {
		const h = await startHarness();
		try {
			const response = await fetch(`${h.base}/events`);
			// axum's `Sse` response sets exactly these two headers.
			expect(response.headers.get("content-type")).toBe("text/event-stream");
			expect(response.headers.get("cache-control")).toBe("no-cache");
			const reader = (response.body as ReadableStream<Uint8Array>).getReader();
			const snapshot = baseSnapshot({ feed_lines: ["one"] });
			h.state.snapshots.send(snapshot);
			const chunk = await reader.read();
			expect(new TextDecoder().decode(chunk.value)).toBe(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
			await reader.cancel();
		} finally {
			await h.close();
		}
	});

	it("serves the embedded index byte-for-byte as text/html", async () => {
		const h = await startHarness();
		try {
			const response = await fetch(`${h.base}/`);
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
			const body = Buffer.from(await response.arrayBuffer());
			const onDisk = readFileSync(fileURLToPath(new URL("../../src/ui/web_index.html", import.meta.url)));
			// pie: web.rs:875 — `include_str!` embeds the file verbatim.
			expect(body.equals(onDisk)).toBe(true);
			expect(indexHtml()).toBe(onDisk.toString("utf8"));
		} finally {
			await h.close();
		}
	});

	it("reproduces axum's routing and Json-extractor rejections", async () => {
		const h = await startHarness();
		try {
			// Unknown route ⇒ axum's default 404 fallback. A trailing slash is NOT redirected.
			expect((await fetch(`${h.base}/nope`)).status).toBe(404);
			expect((await fetch(`${h.base}/state/`)).status).toBe(404);
			// Known route, wrong method ⇒ 405 + Allow.
			const wrongMethod = await fetch(`${h.base}/state`, { method: "POST" });
			expect(wrongMethod.status).toBe(405);
			expect(wrongMethod.headers.get("allow")).toBe("GET");
			// Query strings are ignored when matching.
			expect((await fetch(`${h.base}/state?x=1`)).status).toBe(200);

			// Missing `Content-Type: application/json` ⇒ 415.
			const noContentType = await fetch(`${h.base}/prompt`, { method: "POST", body: '{"text":"hi"}' });
			expect(noContentType.status).toBe(415);
			// Malformed JSON ⇒ 400.
			const badJson = await fetch(`${h.base}/prompt`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{",
			});
			expect(badJson.status).toBe(400);
			// Well-formed JSON that does not match the struct ⇒ 422.
			expect((await postJson(`${h.base}/prompt`, { texts: "hi" })).status).toBe(422);
			expect((await postJson(`${h.base}/trigger/immediate`, {})).status).toBe(422);
			expect((await postJson(`${h.base}/control-plane/resolve`, { approve: "yes" })).status).toBe(422);
			// No command may have been enqueued by any rejected request.
			expect(h.commands.size).toBe(0);
		} finally {
			await h.close();
		}
	});

	it("defaults PromptRequest.images to [] (serde default) and treats a missing name as None", async () => {
		const h = await startHarness();
		try {
			await postJson(`${h.base}/prompt`, { text: "no images" });
			expect(await h.commands.next()).toEqual({ kind: "submit", text: "no images", images: [] });

			await postJson(`${h.base}/prompt`, { text: "x", images: [{ data: PNG_BASE64 }] });
			const command = await h.commands.next();
			if (command?.kind !== "submit") throw new Error("unexpected command");
			expect(command.images[0].name).toBeUndefined();
		} finally {
			await h.close();
		}
	});

	it("reports accepted:false once the command queue is closed (mpsc SendError)", async () => {
		const h = await startHarness();
		try {
			h.commands.close();
			const accepted = (await (await fetch(`${h.base}/abort`, { method: "POST" })).json()) as {
				accepted: boolean;
			};
			// pie: web.rs:727 — `.send(..).is_ok()`; a dropped receiver makes the send fail.
			expect(accepted.accepted).toBe(false);
		} finally {
			await h.close();
		}
	});

	it("serves /state from the latest cell, so a republish is visible to the next request", async () => {
		const h = await startHarness();
		try {
			h.state.latest.set(baseSnapshot({ session_id: "sess-2", busy: true }));
			const state = (await (await fetch(`${h.base}/state`)).json()) as Record<string, unknown>;
			expect(state.session_id).toBe("sess-2");
			expect(state.busy).toBe(true);
			expect((await fetch(`${h.base}/state`)).headers.get("content-type")).toBe("application/json");
		} finally {
			await h.close();
		}
	});
});

describe("snapshot broadcast", () => {
	it("fans out to every subscriber and stops after unsubscribe", () => {
		const bus = createSnapshotBroadcast();
		const a: string[] = [];
		const b: string[] = [];
		const stopA = bus.subscribe((snapshot) => a.push(snapshot.session_id));
		bus.subscribe((snapshot) => b.push(snapshot.session_id));
		expect(bus.send(baseSnapshot({ session_id: "one" }))).toBe(2);
		stopA();
		expect(bus.send(baseSnapshot({ session_id: "two" }))).toBe(1);
		expect(a).toEqual(["one"]);
		expect(b).toEqual(["one", "two"]);
	});

	it("tolerates a listener that unsubscribes during delivery", () => {
		const bus = createSnapshotBroadcast();
		const seen: string[] = [];
		const stop = bus.subscribe(() => stop());
		bus.subscribe((snapshot) => seen.push(snapshot.session_id));
		bus.send(baseSnapshot({ session_id: "one" }));
		expect(seen).toEqual(["one"]);
	});
});
