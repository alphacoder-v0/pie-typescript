/**
 * Port of oracle `crates/coding-agent/src/ui/mod.rs`'s `#[cfg(test)] mod tests` (pie @0a120dfd,
 * :2300-3409) — the REPL's own suite.
 *
 * ## The one deviation, and why it is not a weakened assertion
 *
 * Oracle's render tests paint into a `ratatui::backend::TestBackend` and assert against
 * `buffer_text(...)`: the flattened character grid. There is no ratatui here (RULEBOOK §1 admits no
 * new dependency), so `App.render()` returns a `Frame` — the same rows ratatui would have received
 * — and `frameText(frame)` is the direct analogue of oracle's `buffer_text`. Every string those
 * tests look for is asserted against it unchanged; what is *not* asserted is cell-level placement,
 * which no TS surface produces. Where oracle asserted placement (`renders_feed_above_pinned_input_
 * box`'s "the status rule lives in the bottom five rows") the assertion is re-expressed against the
 * layout rects, which is what actually decides it.
 *
 * Two oracle tests are deliberately NOT ported here because they belong to another unit:
 * `headless_control_plane_prompt_hook_denies_with_recovery` and
 * `headless_yes_control_plane_prompt_hook_allows_without_rendering_payload` exercise
 * `control_plane_prompt.rs`'s `deny_hook` / `allow_hook`, not `App`.
 */

import { AsyncQueue } from "@pie/agent-core";
import type { ImageContent, Model } from "@pie/ai";
import { afterEach, describe, expect, it } from "vitest";
import { registryWithBuiltins } from "../../src/core/slash-dispatch.ts";
import type { CommandSkill } from "../../src/core/slash-dispatch-deps.ts";
import { HistoryStore } from "../../src/history.ts";
import { ModelPickerState, type ProviderGroup } from "../../src/model-picker.ts";
import type { SkillSource } from "../../src/skills-state.ts";
import { globalCronRegistry, globalRegistry } from "../../src/triggers/index.ts";
import { frameText, type Rect } from "../../src/ui/app-render.ts";
import {
	enterTuiCommands,
	leaveTuiCommands,
	printHeadlessUpdate,
	promptDisplay,
	userFacingRunError,
} from "../../src/ui/app-text.ts";
import type { FeedUpdate } from "../../src/ui/feed.ts";
import { App, type AppHarness, loginRequiresTtyMessage, type TuiKey } from "../../src/ui/index.ts";
import { newTurnState, type TurnState } from "../../src/ui/kernel.ts";
import type { PanelStatus } from "../../src/ui/web.ts";
import { encodeRgbaClipboardImage } from "../../src/utils/clipboard-image.ts";

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Fixtures — pie: mod.rs:2308-2383.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/** pie: mod.rs:2308-2324 (`faux_model`). */
function fauxModel(input: ("text" | "image")[] = []): Model<any> {
	return {
		id: "faux",
		name: "Faux",
		api: "faux",
		provider: "faux",
		baseUrl: "",
		reasoning: false,
		input,
		contextWindow: 0,
		maxTokens: 0,
	} as unknown as Model<any>;
}

/** pie: mod.rs:2326-2332 (`faux_vision_model`). */
function fauxVisionModel(): Model<any> {
	return fauxModel(["text", "image"]);
}

/**
 * pie: mod.rs:2366-2379 (`ui_skill`). Oracle's fixture carries `content: "SECRET SKILL BODY"`; the
 * ported `CommandSkill` has no `content` field at all, which is a stronger guarantee than the
 * assertion oracle writes against it.
 */
function uiSkill(name: string, source: SkillSource, disabled: boolean): CommandSkill {
	return {
		name,
		description: `description for ${name}`,
		filePath: `/tmp/${name}/SKILL.md`,
		disableModelInvocation: disabled,
		source,
	};
}

/** pie: mod.rs:2381-2383 (`one_pixel_clipboard_image`). */
function onePixelClipboardImage() {
	return encodeRgbaClipboardImage(1, 1, new Uint8Array([255, 0, 0, 255]));
}

/** pie: mod.rs:2361 (`PanelStatus::default()`). */
function emptyPanelStatus(): PanelStatus {
	return {
		mcp_servers: 0,
		mcp_tools: 0,
		mcp_server_names: [],
		mcp_tool_names: [],
		tool_names: [],
		mcp_notification_hooks: 0,
		hook_points: [],
		trigger_features: [],
	};
}

interface TestHarness extends AppHarness {
	promptCalls: { text: string; images?: ImageContent[] }[];
	continueCalls: number;
	aborts: number;
	replaceSkills(skills: CommandSkill[]): void;
}

/**
 * The `Arc<AgentHarness>` oracle threads everywhere, as a stub — the posture
 * `test/ui/kernel.test.ts` established for this family: every method `ui/mod.rs` touches is a thin
 * delegation, so a live harness would only put network and session machinery between the assertion
 * and the fact.
 */
function testHarness(model: Model<any> = fauxModel()): TestHarness {
	let current = model;
	let skills: CommandSkill[] = [];
	const harness = {
		promptCalls: [] as { text: string; images?: ImageContent[] }[],
		continueCalls: 0,
		aborts: 0,
		skills: () => skills.slice(),
		replaceSkills: (next: CommandSkill[]) => {
			skills = next;
		},
		reloadSkillsFromDisk: async () => ({ skills: skills.slice(), diagnostics: [] }),
		session: () =>
			({
				getEntries: async () => [],
				appendCustomEntry: async () => "id",
				getLeafId: async () => null,
				getEntry: async () => undefined,
				moveTo: async () => undefined,
			}) as never,
		getThinkingLevel: () => "off" as const,
		setThinkingLevel: async () => {},
		getModel: () => current,
		setModel: async (next: Model<any>) => {
			current = next;
		},
		templates: () => [],
		cost: () => ({}) as never,
		resetCost: () => {},
		notificationStatusSnapshot: () => ({}) as never,
		abortTrigger: () => {},
		abortAllTriggers: () => {},
		async prompt(text: string, options?: { images?: ImageContent[] }) {
			harness.promptCalls.push({ text, images: options?.images });
			return undefined as never;
		},
		async continue() {
			harness.continueCalls += 1;
			return undefined as never;
		},
		async compact() {
			return { ran: false as const };
		},
		async promptFromTemplate() {
			return undefined as never;
		},
		async abort() {
			harness.aborts += 1;
			return { clearedSteer: [], clearedFollowUp: [] };
		},
		runEvaluator: async () => ({}) as never,
	};
	return harness as unknown as TestHarness;
}

interface TestApp {
	app: App;
	harness: TestHarness;
	feedRx: AsyncQueue<FeedUpdate>;
}

/** pie: mod.rs:2334-2364 (`test_app` / `test_app_with_model` / `test_app_with_options`). */
function testApp(
	options: { model?: Model<any>; panelStatus?: PanelStatus; catalog?: () => ProviderGroup[] } = {},
): TestApp {
	const harness = testHarness(options.model ?? fauxModel());
	const feedRx = new AsyncQueue<FeedUpdate>();
	const app = new App({
		harness: harness as never,
		commandHarness: harness,
		registry: registryWithBuiltins(),
		cwd: ".",
		sessionId: "test",
		toolCount: 0,
		// pie: mod.rs:2358 — oracle loads history from a path that does not exist.
		history: HistoryStore.loadFrom("/nonexistent-pie-history"),
		pendingImages: [],
		feedRx,
		mainRunRx: new AsyncQueue<string>(),
		panelStatus: options.panelStatus ?? emptyPanelStatus(),
		// Hermetic: never probe the live model registry or the environment for credentials.
		catalog: options.catalog ?? (() => []),
	});
	return { app, harness, feedRx };
}

/** pie: mod.rs:2398-2410 (`feed_text`). */
function feedText(app: App): string {
	return app.feed
		.lines(100)
		.map((line) => line.text)
		.join("\n");
}

/** A staged, never-settling turn — oracle's `Box::pin(std::future::pending())`. */
function pendingTurn(prefix = ""): TurnState {
	return { fut: new Promise<string | undefined>(() => {}), aborted: false, prefix };
}

const WIDE: Rect = { x: 0, y: 0, width: 120, height: 30 };

/** pie: mod.rs:3322-3325 (`key`). */
function key(code: TuiKey["code"], modifiers: Partial<Pick<TuiKey, "ctrl" | "alt" | "shift">> = {}): TuiKey {
	return { code, ctrl: false, alt: false, shift: false, kind: "press", ...modifiers };
}

const char = (c: string): TuiKey["code"] => ({ kind: "char", char: c });

/** A `TerminalDriver` that records nothing — the key handlers below never paint. */
function driverStub() {
	return {
		events: new AsyncQueue<never>() as never,
		size: () => WIDE,
		draw: () => {},
		enter: () => {},
		leave: () => {},
		clear: () => {},
		showCursor: () => {},
	};
}

/** Both global registries are process state; every test that touches them cleans up after itself. */
afterEach(() => {
	globalRegistry().clearRules();
	for (const job of globalCronRegistry().list()) globalCronRegistry().removeJob(job.id);
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Layout — pie: mod.rs:2429-2487.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

describe("render layout — mod.rs:1465-1564", () => {
	it("renders the feed above a pinned input box (mod.rs:2429-2467)", () => {
		const { app } = testApp();
		app.feed.pushUser("hello world");
		app.feed.pushAssistant("hi there, the box is pinned");

		const frame = app.render({ x: 0, y: 0, width: 50, height: 12 });
		const text = frameText(frame);

		expect(text, text).toContain("you ▸ hello world");
		expect(text, text).toContain("ai ▸ hi there, the box is pinned");
		// pie: mod.rs:2447-2452 — the status rule carries the model and the run state.
		expect(text, text).toContain("pie ·");
		expect(text, text).toContain("ready");

		// pie: mod.rs:2455-2466 — "the status rule and the hint line live in the bottom five rows —
		// the bordered input box is between them, pinned to the bottom". Asserted against the rects,
		// which is what decides it.
		expect(frame.layout.status.y).toBeGreaterThanOrEqual(12 - 5);
		expect(frame.layout.hint.y).toBe(11);
		expect(frame.layout.input.y).toBeGreaterThan(frame.layout.status.y);
		expect(frame.layout.input.y + frame.layout.input.height).toBe(frame.layout.hint.y);
	});

	it("gives the input box breathing room and a prompt column (mod.rs:2469-2487)", () => {
		const { app } = testApp();
		const frame = app.render({ x: 0, y: 0, width: 50, height: 8 });
		const text = frameText(frame);

		// pie: mod.rs:2475-2479 — oracle asserts the border glyphs plus `│>  <placeholder>`; the
		// prompt column and the placeholder are this port's surface for the same fact.
		expect(frame.inputRows).toEqual([""]);
		expect(text, text).toContain("> ");
		expect(app.input.placeholder).toBe("type a message, or /help");
		// pie: mod.rs:2480-2484 — the idle hint advertises paste support.
		expect(text, text).toContain("Ctrl-V paste");
	});

	it("uses the busy hint while a turn is in flight (mod.rs:1546-1553)", () => {
		const { app } = testApp();
		app.busy = true;
		expect(frameText(app.render(WIDE))).toContain("empty Ctrl-U removes queued");
	});
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Automation rail — pie: mod.rs:2489-2757.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

describe("automation rail — mod.rs:1656-1932", () => {
	it("renders the trigger panel on a wide terminal (mod.rs:2489-2556)", () => {
		const { app } = testApp({
			panelStatus: {
				...emptyPanelStatus(),
				mcp_servers: 1,
				mcp_tools: 2,
				mcp_notification_hooks: 1,
				hook_points: ["before_tool_call", "after_tool_call"],
				trigger_features: ["dedup", "cycle suppress"],
			},
		});
		globalRegistry().addRule("a build finishes", "summarize the result");

		const text = frameText(app.render(WIDE));

		expect(text, text).toContain("Triggers");
		expect(text, text).toContain("[enabled, once]");
		expect(text, text).toContain("when a build finishes");
		expect(text, text).toContain("MCP");
		expect(text, text).toContain("servers 1 · tools 2");
		expect(text, text).toContain("notification hooks 1");
		expect(text, text).toContain("Hooks");
		expect(text, text).toContain("before_tool_call");
		// pie: mod.rs:2538-2541 — hook rows must not use success checkmarks.
		expect(text, text).not.toContain("✓ before_tool_call");
		// pie: mod.rs:2544-2554 — runtime features are their OWN section, so `dedup` cannot be
		// mistaken for a pluggable callback.
		expect(text, text).toContain("Runtime");
		expect(text, text).toContain("dedup");
	});

	it("hides an empty static trigger panel even when wide (mod.rs:2557-2589)", () => {
		const { app } = testApp({
			panelStatus: {
				...emptyPanelStatus(),
				hook_points: ["before_tool_call", "after_tool_call"],
				trigger_features: ["dedup", "cycle suppress"],
			},
		});

		const frame = app.render({ x: 0, y: 0, width: 120, height: 20 });
		const text = frameText(frame);

		expect(frame.triggerArea).toBeUndefined();
		expect(text, text).not.toContain("Triggers");
		// pie: mod.rs:2578-2588 — static hook / runtime rows belong in /triggers status.
		expect(text, text).not.toContain("before_tool_call");
		expect(text, text).not.toContain("cycle suppress");
	});

	it("shows the latest poll status without appending a feed line (mod.rs:2593-2634)", () => {
		const { app } = testApp();
		app.latestTriggerPoll = {
			checked_at: "11:22:33",
			trace_id: "trace-chrome-check",
			source_label: "local:dynamic",
			event_label: "dynamic periodic check",
			summary: "Checked Chrome tabs; no matching rule found.",
		};

		const text = frameText(app.render({ x: 0, y: 0, width: 120, height: 20 }));

		expect(text, text).toContain("Polling");
		expect(text, text).toContain("11:22:33 · no match");
		expect(text, text).toContain("local:dynamic / dynamic periodic c");
		expect(text, text).toContain("trace trace-chrome-check");
		expect(text, text).toContain("no matching");
		// pie: mod.rs:2629-2633 — the poll status is panel state, never a feed block.
		expect(feedText(app)).toBe("");
	});

	it("renders a compact skills summary without the skill body (mod.rs:2636-2671)", () => {
		const { app, harness } = testApp();
		harness.replaceSkills([
			uiSkill("builtin-review", "builtin", false),
			uiSkill("user-format", "user", true),
			uiSkill("project-plan", "project", false),
		]);

		const text = frameText(app.render({ x: 0, y: 0, width: 120, height: 20 }));

		expect(text, text).toContain("Skills");
		expect(text, text).toContain("enabled 2 · disabled 1");
		expect(text, text).toContain("builtin 1 · user 1 · project 1");
		// pie: mod.rs:2666-2670 — the panel must never render a skill body.
		expect(text, text).not.toContain("SECRET SKILL BODY");
	});

	it("redacts secrets in rule previews (mod.rs:2673-2700)", () => {
		const { app } = testApp();
		const secret = "sk-panel-secret-should-not-render-1234567890";
		globalRegistry().addRule(`when header is Bearer ${secret}`, `call API with ${secret}`);

		const text = frameText(app.render(WIDE));

		expect(text, text).not.toContain(secret);
		expect(text, text).toContain("[REDACTED:");
	});

	it("hides the trigger panel on a narrow terminal (mod.rs:2702-2721)", () => {
		const { app } = testApp();
		globalRegistry().addRule("a build finishes", "summarize the result");

		const frame = app.render({ x: 0, y: 0, width: 80, height: 10 });

		expect(frame.triggerArea).toBeUndefined();
		expect(frameText(frame)).not.toContain("Triggers");
	});

	it("renders cron jobs, redacted, in the automation panel (mod.rs:2723-2757)", () => {
		const { app } = testApp();
		const secret = "sk-cron-panel-secret-12345678901234567890";
		globalCronRegistry().addJob("*/10 * * * *", `call API with ${secret}`);

		const text = frameText(app.render({ x: 0, y: 0, width: 120, height: 26 }));

		expect(text, text).toContain("Cron (session)");
		expect(text, text).toContain("enabled 1 · disabled 0");
		expect(text, text).toContain("*/10 * * *");
		expect(text, text).not.toContain(secret);
		expect(text, text).toContain("[REDACTED:");
	});
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Completions — pie: mod.rs:2759-2794.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

describe("slash completions — mod.rs:1365-1396", () => {
	it("Tab cycles slash-command completions (mod.rs:2759-2777)", () => {
		const { app } = testApp();
		app.setInput("/");
		const options = [...app.completions];
		expect(options.length, "slash prefix should expose multiple command completions").toBeGreaterThan(1);

		app.cycleCompletion();
		const first = app.inputText();
		app.cycleCompletion();
		const second = app.inputText();

		expect(first).toBe(options[0]);
		expect(second).toBe(options[1]);
		expect(first).not.toBe(second);
	});

	it("includes hot-loaded skill commands (mod.rs:2779-2794)", () => {
		const { app, harness } = testApp();
		harness.replaceSkills([uiSkill("db9", "user", false)]);

		app.setInput("/d");

		expect(app.completions, JSON.stringify(app.completions)).toContain("/db9");
	});
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Keys, scrolling, status — pie: mod.rs:2796-2846, 2901-2914.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

describe("keys and scrolling — mod.rs:1311-1451", () => {
	it("Ctrl-D aborts an active turn before exiting (mod.rs:2796-2810)", () => {
		const { app } = testApp();
		const turn = pendingTurn();

		expect(app.handleCtrlD(turn)).toBe(true);

		expect(turn.aborted).toBe(true);
		expect(app.quit, "Ctrl-D during work should abort, not exit").toBe(false);
	});

	it("Ctrl-D on an idle empty input exits (mod.rs:749-758)", async () => {
		const { app } = testApp();
		await app.handleKey(key(char("d"), { ctrl: true }), newTurnState(), driverStub());
		expect(app.quit).toBe(true);
		expect(feedText(app)).toContain("eof — exiting");
	});

	it("idle Ctrl-C needs a double tap inside 1.5s (mod.rs:1328-1341)", () => {
		const { app } = testApp();
		expect(app.onIdleCtrlc(1_000)).toBe(false);
		expect(feedText(app)).toContain("press Ctrl-C again within 1.5s to exit, or type /quit");
		expect(app.onIdleCtrlc(2_400)).toBe(true);

		const later = testApp().app;
		expect(later.onIdleCtrlc(1_000)).toBe(false);
		expect(later.onIdleCtrlc(2_600), "outside the window, the second tap only re-arms").toBe(false);
	});

	it("the mouse wheel scrolls only inside the feed area (mod.rs:2812-2831)", () => {
		const { app } = testApp();
		app.lastFeedArea = { x: 2, y: 1, width: 20, height: 6 };
		app.scroll = 10;
		app.follow = true;

		app.handleMouseScroll(5, 3, true);
		expect(app.scroll).toBe(7);
		expect(app.follow).toBe(false);

		app.handleMouseScroll(5, 8, true);
		expect(app.scroll, "wheel events outside the feed should not move the conversation scroll").toBe(7);

		app.handleMouseScroll(5, 3, false);
		expect(app.scroll).toBe(10);
	});

	it("the status rule shows the working spinner when busy (mod.rs:2833-2846)", () => {
		const { app } = testApp();
		app.busy = true;
		app.spinnerFrame = 2;
		expect(frameText(app.render({ x: 0, y: 0, width: 60, height: 6 }))).toContain("working");
	});

	it("the status rule shows the queued count while busy (mod.rs:2901-2914)", () => {
		const { app } = testApp();
		app.busy = true;
		app.queueUserPrompt("queued one", "queued one", []);

		const text = frameText(app.render({ x: 0, y: 0, width: 80, height: 6 }));
		expect(text, text).toContain("working");
		expect(text, text).toContain("1 queued");
	});

	it("marks the status rule scrolled once follow is broken (mod.rs:1957)", () => {
		const { app } = testApp();
		for (let i = 0; i < 40; i++) app.feed.pushAssistant(`line ${i}`);
		app.render({ x: 0, y: 0, width: 60, height: 12 });
		app.scrollUp(3);
		expect(app.statusLine(60)).toContain("↑scrolled");
	});
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Queue — pie: mod.rs:2848-2941.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

describe("turn queue — mod.rs:1082-1152", () => {
	it("a finished turn starts the next queued prompt, FIFO (mod.rs:2848-2871)", async () => {
		const { app } = testApp();
		const turn = pendingTurn();

		app.queueUserPrompt("next question", "next question", []);
		expect(app.queuedTurns.length).toBe(1);

		await app.finishTurn(turn, { ok: true, value: undefined });

		expect(turn.fut, "queued prompt should start immediately").toBeDefined();
		expect(app.busy, "starting a queued prompt should mark the UI busy").toBe(true);
		expect(app.queuedTurns).toEqual([]);
		const text = feedText(app);
		expect(text, text).toContain("queued next message #1: next question");
		expect(text, text).toContain("running queued message");
		expect(text, text).toContain("you ▸ next question");
	});

	it("empty Ctrl-U removes the LAST queued prompt while busy (mod.rs:2916-2941)", () => {
		const { app } = testApp();
		const turn = pendingTurn();
		app.queueUserPrompt("first", "first", []);
		app.queueUserPrompt("second", "second", []);

		app.cancelLastQueuedTurn();

		expect(app.queuedTurns.length).toBe(1);
		expect(app.queuedTurns[0].display).toBe("first");
		expect(feedText(app), "feed should explain queue cancellation").toContain("removed queued message: second");
		expect(turn.fut, "cancelling a queued item must not abort the current turn").toBeDefined();
	});

	it("reports an empty queue rather than throwing (mod.rs:1100-1103)", () => {
		const { app } = testApp();
		app.cancelLastQueuedTurn();
		expect(feedText(app)).toContain("queue is empty");
	});

	it("counts what is still queued when a turn finishes (mod.rs:1113-1117)", async () => {
		const { app } = testApp();
		app.queueUserPrompt("a", "a", []);
		app.queueUserPrompt("b", "b", []);
		await app.finishTurn(pendingTurn(), { ok: true, value: undefined });
		expect(feedText(app)).toContain("running queued message (1 still queued)");
	});

	it("surfaces an aborted turn, and clears the abort flag (mod.rs:461-481)", async () => {
		const { app } = testApp();
		const turn: TurnState = { fut: undefined, aborted: true, prefix: "triggered turn: " };
		await app.finishTurn(turn, { ok: false, error: new Error("cancelled") });
		expect(feedText(app)).toContain("[aborted]");
		expect(turn.aborted).toBe(false);
		expect(turn.prefix).toBe("");
	});

	it("prefixes a failed turn with the turn's error context (mod.rs:469-473)", async () => {
		const { app } = testApp();
		const turn: TurnState = { fut: undefined, aborted: false, prefix: "template run failed: " };
		await app.finishTurn(turn, { ok: false, error: new Error("boom") });
		expect(feedText(app)).toContain("error: template run failed: boom");
	});

	it("prints a status string only when the turn produced one (mod.rs:466-468)", async () => {
		const { app } = testApp();
		await app.finishTurn(newTurnState(), { ok: true, value: "compaction ran" });
		expect(feedText(app)).toContain("compaction ran");

		const other = testApp().app;
		await other.finishTurn(newTurnState(), { ok: true, value: undefined });
		expect(feedText(other)).toBe("");
	});
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Images — pie: mod.rs:2943-3045.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

describe("image attachments — mod.rs:1042-1088", () => {
	it("attaching a clipboard image requires a vision model (mod.rs:2943-2954)", () => {
		const { app } = testApp();
		app.attachClipboardImage(onePixelClipboardImage());

		expect(app.pendingPastedImages).toEqual([]);
		expect(feedText(app)).toContain("current model does not support image input");
	});

	it("a pending path image is refused WITHOUT being dropped (mod.rs:2956-2974)", () => {
		const { app } = testApp();
		app.pendingImages.push("/tmp/screenshot.png");

		expect(app.validatePendingImageSupport()).toBe(false);

		expect(app.pendingImages.length, "the attachment must survive the refusal").toBe(1);
		const text = feedText(app);
		expect(text, text).toContain("current model does not support image input");
		expect(text, text).toContain("1 image attachment");
	});

	it("a pending path image is allowed for a vision model (mod.rs:2976-2984)", () => {
		const { app } = testApp({ model: fauxVisionModel() });
		app.pendingImages.push("/tmp/screenshot.png");

		expect(app.validatePendingImageSupport()).toBe(true);
		expect(feedText(app)).toBe("");
	});

	it("attaching a clipboard image never echoes the blob (mod.rs:2997-3010)", () => {
		const { app } = testApp({ model: fauxVisionModel() });
		app.attachClipboardImage(onePixelClipboardImage());

		expect(app.pendingPastedImages.length).toBe(1);
		const text = feedText(app);
		expect(text, text).toContain("attached clipboard image #1");
		expect(text, text).toContain("1x1");
		expect(text, "clipboard image base64 leaked into feed").not.toContain(app.pendingPastedImages[0].data);
	});

	it("a queued prompt carries the pending clipboard image (mod.rs:3012-3032)", () => {
		const { app } = testApp({ model: fauxVisionModel() });
		app.attachClipboardImage(onePixelClipboardImage());
		const data = app.pendingPastedImages[0].data;
		const images = app.pendingPastedImages;
		app.pendingPastedImages = [];

		app.queueUserPrompt("describe this image", "describe this image", images);

		expect(app.pendingPastedImages).toEqual([]);
		const queued = app.queuedTurns[0];
		if (queued.kind !== "user_prompt") throw new Error("expected queued user prompt");
		expect(queued.images.length).toBe(1);
		expect(queued.images[0].mimeType).toBe("image/png");
		expect(queued.images[0].data).toBe(data);
	});

	it("refuses past the per-message attachment cap (mod.rs:1047-1055)", () => {
		const { app } = testApp({ model: fauxVisionModel() });
		for (let i = 0; i < 10; i++) app.attachClipboardImage(onePixelClipboardImage());
		expect(app.pendingPastedImages.length).toBe(10);
		app.attachClipboardImage(onePixelClipboardImage());
		expect(app.pendingPastedImages.length).toBe(10);
		expect(feedText(app)).toContain("image attachment limit reached (max 10 per message)");
	});

	it("prompt_display surfaces an image-only attachment without the blob (mod.rs:3034-3045)", () => {
		expect(promptDisplay("", 1), "image-only prompts need a visible feed label").toBe("[1 image attachment]");
		expect(promptDisplay("describe this", 2)).toBe("describe this\n[2 image attachments]");
	});
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Redaction and errors — pie: mod.rs:2986-2995, 3047-3062, 3201-3208.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

describe("redaction and error text — mod.rs:2162-2218", () => {
	it("a queued prompt preview redacts token-like text (mod.rs:3047-3062)", () => {
		const { app } = testApp();
		app.queueUserPrompt("use sk-abcdefghijklmnopqrstuvwxyz123456", "use sk-abcdefghijklmnopqrstuvwxyz123456", []);

		const text = feedText(app);
		expect(text, text).toContain("[REDACTED:openai_anthropic_key]");
		expect(text, text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
	});

	it("a missing api key error uses the CLI recovery action (mod.rs:2986-2995)", () => {
		const text = userFacingRunError(
			"no API key for provider: deepseek; set DEEPSEEK_API_KEY or pass options.api_key",
		);

		expect(text, text).toContain("/login deepseek");
		expect(text, text).toContain("DEEPSEEK_API_KEY");
		expect(text, text).not.toContain("options.api_key");
	});

	it("leaves an unrelated error untouched (mod.rs:2204-2206)", () => {
		expect(userFacingRunError("connection reset")).toBe("connection reset");
	});

	it("the login-requires-tty message is bounded and secret free (mod.rs:3201-3208)", () => {
		const msg = loginRequiresTtyMessage("ds4");
		expect(msg, msg).toContain("interactive terminal");
		expect(msg, msg).toContain("/login ds4");
		expect(msg, msg).not.toContain("api key for");
		expect(msg, msg).not.toContain("sk-");
	});
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Control-plane confirm surface — pie: mod.rs:3063-3153.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

describe("control-plane prompt — mod.rs:648-700, 801-833", () => {
	function promptFixture(overrides: Record<string, unknown> = {}) {
		const decisions: unknown[] = [];
		return {
			decisions,
			prompt: {
				request: {
					toolCallId: "call_1",
					toolName: "InstallSkill",
					argsHash: "abcdef1234567890".repeat(4),
					label: "Install https://example.com/?token=SECRET_TOKEN",
					payload: { url: "https://example.com/?token=SECRET_TOKEN", args_hash: "abcdef1234567890" },
					reason: "writes skill files with password=SECRET_TOKEN",
					...overrides,
				},
				resolve: (decision: unknown) => void decisions.push(decision),
				close: () => {},
			},
		};
	}

	it("redacts the payload and denies without clearing the queue (mod.rs:3063-3120)", () => {
		const { app } = testApp();
		app.queueUserPrompt("queued secret=should-redact", "queued", []);
		const { prompt, decisions } = promptFixture();
		app.showControlPlanePrompt(prompt as never);

		const rendered = frameText(app.render({ x: 0, y: 0, width: 90, height: 24 }));
		expect(rendered, rendered).toContain("Control-plane approval required");
		expect(rendered, "prompt card must redact token-like payloads").not.toContain("SECRET_TOKEN");

		expect(app.handleControlPlanePromptKey(key({ kind: "esc" }))).toBe(true);
		expect(app.controlPlanePrompt).toBeUndefined();
		expect(decisions).toEqual([{ type: "deny", reason: "denied by user" }]);
		expect(app.queuedTurns.length, "denying a prompt must not clear unrelated queued user input").toBe(1);
	});

	it("Enter sends an allow decision (mod.rs:3121-3153)", () => {
		const { app } = testApp();
		const { prompt, decisions } = promptFixture({ label: "Install skill", reason: "writes skill files" });
		app.showControlPlanePrompt(prompt as never);

		expect(app.handleControlPlanePromptKey(key({ kind: "enter" }))).toBe(true);
		expect(app.controlPlanePrompt).toBeUndefined();
		expect(decisions).toEqual([{ type: "allow" }]);
	});

	it("accepts every allow key oracle lists (mod.rs:809-816)", () => {
		for (const code of [{ kind: "enter" } as const, char("y"), char("Y"), char("a"), char("A")]) {
			const { app } = testApp();
			const { prompt, decisions } = promptFixture();
			app.showControlPlanePrompt(prompt as never);
			app.handleControlPlanePromptKey(key(code));
			expect(decisions, JSON.stringify(code)).toEqual([{ type: "allow" }]);
		}
	});

	it("accepts every deny key oracle lists, including Ctrl-C (mod.rs:817-825)", () => {
		const denyKeys: TuiKey[] = [
			key({ kind: "esc" }),
			key(char("n")),
			key(char("N")),
			key(char("d")),
			key(char("D")),
			key(char("c"), { ctrl: true }),
		];
		for (const k of denyKeys) {
			const { app } = testApp();
			const { prompt, decisions } = promptFixture();
			app.showControlPlanePrompt(prompt as never);
			app.handleControlPlanePromptKey(k);
			expect(decisions, JSON.stringify(k.code)).toEqual([{ type: "deny", reason: "denied by user" }]);
		}
	});

	it("swallows every other key while the card is up, resolving nothing (mod.rs:826-832)", () => {
		const { app } = testApp();
		const { prompt, decisions } = promptFixture();
		app.showControlPlanePrompt(prompt as never);
		expect(app.handleControlPlanePromptKey(key(char("q")))).toBe(true);
		expect(decisions).toEqual([]);
		expect(app.controlPlanePrompt).toBeDefined();
	});

	it("passes keys through when no card is up (mod.rs:802-804)", () => {
		const { app } = testApp();
		expect(app.handleControlPlanePromptKey(key({ kind: "enter" }))).toBe(false);
	});

	it("relay approval is first-class, identical to a local one (mod.rs:603-618)", () => {
		const { app } = testApp();
		const { prompt, decisions } = promptFixture();
		app.showControlPlanePrompt(prompt as never);
		app.resolveFromRelay(false);
		expect(decisions).toEqual([{ type: "deny", reason: "denied via web relay" }]);
	});

	it("refuses to raise the import-activation card over a live prompt (mod.rs:565-573)", () => {
		const { app } = testApp();
		app.showControlPlanePrompt(promptFixture().prompt as never);
		app.promptImportActivation("/tmp/archive.piesession", ["t1"], ["c1"]);
		expect(feedText(app)).toContain("imported automation left disabled (another approval is pending)");
	});

	it("leaves imported automation disabled when the user denies (mod.rs:694-697)", () => {
		const { app } = testApp();
		app.promptImportActivation("/tmp/archive.piesession", ["t1"], ["c1"]);
		expect(feedText(app)).toContain("activate imported automation? (1 trigger(s), 1 cron job(s)");
		app.resolveControlPlanePrompt({ type: "deny", reason: "denied by user" });
		expect(feedText(app)).toContain("imported automation stays disabled");
	});
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Terminal mode + replay — pie: mod.rs:3210-3309.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

describe("terminal mode escapes — mod.rs:2239-2255", () => {
	it("enter/leave enable and restore mouse capture for feed wheel scroll (mod.rs:3210-3231)", () => {
		const enter = enterTuiCommands();
		expect(enter).toContain("\x1b[?1049h");
		expect(enter).toContain("\x1b[?2004h");
		expect(
			enter.includes("\x1b[?1000h") && enter.includes("\x1b[?1006h"),
			`TUI must capture mouse events so wheel scroll reaches the feed: ${JSON.stringify(enter)}`,
		).toBe(true);

		const leave = leaveTuiCommands();
		expect(leave).toContain("\x1b[?2004l");
		expect(leave).toContain("\x1b[?1049l");
		expect(
			leave.includes("\x1b[?1000l") && leave.includes("\x1b[?1006l"),
			`leave path should restore terminal mouse handling: ${JSON.stringify(leave)}`,
		).toBe(true);
	});
});

describe("transcript replay — mod.rs:294-352", () => {
	it("compacts replayed tool results for display (mod.rs:3233-3260)", () => {
		const { app } = testApp();
		const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
		app.replayMessage({
			role: "toolResult",
			toolCallId: "tool-1",
			toolName: "bash",
			content: [{ type: "text", text }],
			isError: false,
			timestamp: 0,
		} as never);

		const rendered = app.feed
			.lines(120)
			.map((line) => line.text)
			.join("\n");
		expect(rendered, rendered).toContain("line 0");
		expect(rendered, rendered).toContain("line 49");
		expect(rendered, rendered).toContain("truncated");
		expect(rendered, "middle of long tool output should be hidden in replay display").not.toContain("line 25");
	});

	it("renders replayed messages with message timestamps (mod.rs:3262-3302)", () => {
		const { app } = testApp();
		const timestamp = Date.now();
		app.replayMessage({ role: "user", content: "historical question", timestamp } as never);
		app.replayMessage({
			role: "assistant",
			content: [{ type: "text", text: "historical answer" }],
			timestamp,
		} as never);

		const rendered = app.feed
			.lines(120)
			.map((line) => line.text)
			.join("\n");
		const userRow = rendered.split("\n").find((line) => line.includes("you ▸ historical question"));
		const assistantRow = rendered.split("\n").find((line) => line.includes("ai ▸ historical answer"));
		expect(userRow, rendered).toBeDefined();
		expect(assistantRow, rendered).toBeDefined();
		// pie: mod.rs:3304-3309 (`assert_full_timestamp_prefix`) — `YYYY-MM-DD HH:`.
		for (const row of [userRow as string, assistantRow as string]) {
			expect([...row][4], rendered).toBe("-");
			expect([...row][7], rendered).toBe("-");
			expect([...row][10], rendered).toBe(" ");
			expect([...row][13], rendered).toBe(":");
		}
	});

	it("renders an image block as its mime type, never its bytes (mod.rs:313-316)", () => {
		const { app } = testApp();
		app.replayMessage({
			role: "user",
			content: [{ type: "image", mimeType: "image/png", data: "AAAABBBBCCCC" }],
			timestamp: Date.now(),
		} as never);
		const rendered = feedText(app);
		expect(rendered, rendered).toContain("<image image/png>");
		expect(rendered, rendered).not.toContain("AAAABBBBCCCC");
	});

	it("announces a replay and does nothing for an empty transcript (mod.rs:294-302)", () => {
		const { app } = testApp();
		app.replay([]);
		expect(feedText(app)).toBe("");
		app.replay([{ role: "user", content: "hi", timestamp: Date.now() } as never]);
		expect(feedText(app)).toContain("resumed — replaying 1 messages");
	});
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Model picker — pie: mod.rs:3311-3409.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

describe("model picker — mod.rs:835-935", () => {
	/** pie: mod.rs:3311-3320 (`picker_groups`). */
	function pickerGroups(): ProviderGroup[] {
		return [
			{
				provider: "anthropic",
				hasCredential: true,
				models: [{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5" }],
			},
		];
	}

	it("keys are modal and navigate (mod.rs:3327-3341)", async () => {
		const { app } = testApp();
		app.modelPicker = new ModelPickerState(pickerGroups());
		// Modal: keys are consumed while open.
		expect(await app.handleModelPickerKey(key({ kind: "down" }))).toBe(true);
		// Esc at the top level closes.
		expect(await app.handleModelPickerKey(key({ kind: "esc" }))).toBe(true);
		expect(app.modelPicker).toBeUndefined();
		// Closed: keys pass through.
		expect(await app.handleModelPickerKey(key({ kind: "down" }))).toBe(false);
	});

	it("Esc at model level returns to provider level (mod.rs:3343-3367)", async () => {
		const { app } = testApp();
		app.modelPicker = new ModelPickerState(pickerGroups());
		expect(await app.handleModelPickerKey(key({ kind: "enter" }))).toBe(true);
		expect(app.modelPicker?.level.kind).toBe("models");
		expect(await app.handleModelPickerKey(key({ kind: "esc" }))).toBe(true);
		expect(app.modelPicker, "picker should still be open after Esc at model level").toBeDefined();
		expect(app.modelPicker?.level).toEqual({ kind: "providers" });
	});

	it("Ctrl-C closes the picker outright (mod.rs:889-891)", async () => {
		const { app } = testApp();
		app.modelPicker = new ModelPickerState(pickerGroups());
		expect(await app.handleModelPickerKey(key(char("c"), { ctrl: true }))).toBe(true);
		expect(app.modelPicker).toBeUndefined();
	});

	it("j/k navigate as well as the arrows (mod.rs:869-877)", async () => {
		const { app } = testApp();
		app.modelPicker = new ModelPickerState([
			pickerGroups()[0],
			{ provider: "openai", hasCredential: false, models: [{ id: "gpt", name: "GPT" }] },
		]);
		await app.handleModelPickerKey(key(char("j")));
		expect(app.modelPicker?.cursor).toBe(1);
		await app.handleModelPickerKey(key(char("k")));
		expect(app.modelPicker?.cursor).toBe(0);
	});

	it("renders a centered overlay (mod.rs:3396-3408)", () => {
		const { app } = testApp();
		app.modelPicker = new ModelPickerState(pickerGroups());
		const frame = app.render({ x: 0, y: 0, width: 80, height: 20 });
		const text = frameText(frame);
		expect(text, text).toContain("Select provider");
		expect(text, text).toContain("anthropic (1)");
		// Centered: equal-ish margins on both axes.
		const overlay = frame.modelPicker;
		expect(overlay).toBeDefined();
		expect(overlay?.rect.x).toBe(Math.floor((80 - (overlay?.rect.width ?? 0)) / 2));
		expect(overlay?.rect.y).toBe(Math.floor((20 - (overlay?.rect.height ?? 0)) / 2));
	});

	it("refuses to open an empty catalog (mod.rs:837-843)", () => {
		const { app } = testApp({ catalog: () => [] });
		app.openModelPicker();
		expect(app.modelPicker).toBeUndefined();
		expect(feedText(app)).toContain("no openai/anthropic-compatible models registered");
	});

	it("reports an invalid or unknown model spec (mod.rs:911-921)", async () => {
		const { app } = testApp();
		await app.setModelFromSpec("nonsense");
		expect(feedText(app)).toContain("invalid model spec: nonsense");
		await app.setModelFromSpec("nowhere:nothing");
		expect(feedText(app)).toContain("unknown model: nowhere:nothing");
	});
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Relay + triggered turns — pie: mod.rs:620-637, 1009-1022.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

describe("relay input — mod.rs:620-637", () => {
	it("refuses a remote slash command (mod.rs:625-628)", () => {
		const { app } = testApp();
		const turn = newTurnState();
		app.submitRemoteText("/quit", turn);
		expect(feedText(app)).toContain("[web] remote slash command refused");
		expect(turn.fut).toBeUndefined();
	});

	it("ignores empty remote text (mod.rs:622-624)", () => {
		const { app } = testApp();
		app.submitRemoteText("   ", newTurnState());
		expect(feedText(app)).toBe("");
	});

	it("starts a turn when idle and labels it [web] (mod.rs:630-636)", () => {
		const { app } = testApp();
		const turn = newTurnState();
		app.submitRemoteText("hello there", turn);
		expect(turn.fut).toBeDefined();
		expect(feedText(app)).toContain("you ▸ [web] hello there");
	});

	it("queues remote text while a turn is in flight (mod.rs:632-633)", () => {
		const { app } = testApp();
		app.submitRemoteText("hello there", pendingTurn());
		expect(app.queuedTurns.length).toBe(1);
		expect(app.queuedTurns[0].display).toBe("[web] hello there");
	});

	it("reports relay status when none is connected (mod.rs:536-547)", async () => {
		const { app } = testApp();
		await app.handleWebRelay("status");
		expect(feedText(app)).toContain("web relay is off — start one with /web-connect");
		await app.handleWebRelay("disconnect");
		expect(feedText(app)).toContain("web relay is not active");
	});
});

describe("triggered turns — mod.rs:1009-1022", () => {
	it("skips when the kernel is already streaming (mod.rs:1010-1013)", () => {
		const { app } = testApp();
		// A live user turn makes the kernel streaming; the triggered turn must skip, not error.
		app.startUserPromptTurn("busy", [], newTurnState());
		const turn = newTurnState();
		app.startTriggeredTurn("trace-abcdef123456", turn);
		expect(turn.fut).toBeUndefined();
		expect(feedText(app)).not.toContain("running triggered turn");
	});

	it("announces the first 8 code points of the trace id (mod.rs:1015-1021)", () => {
		const { app } = testApp();
		const turn = newTurnState();
		app.startTriggeredTurn("trace-abcdef123456", turn);
		expect(feedText(app)).toContain("running triggered turn (trace trace-ab)");
		expect(turn.prefix).toBe("triggered turn: ");
		expect(app.busy).toBe(true);
	});
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Headless printer — pie: mod.rs:2257-2298.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

describe("headless printer — mod.rs:2257-2298", () => {
	function capture(updates: FeedUpdate[]): string {
		const chunks: string[] = [];
		const cursor = { atLineStart: true };
		const out = {
			write: (chunk: string) => {
				chunks.push(chunk);
			},
		};
		for (const update of updates) printHeadlessUpdate(update, cursor, out);
		return chunks.join("");
	}

	it("streams text deltas without adding newlines (mod.rs:2261-2264)", () => {
		expect(
			capture([
				{ kind: "text_delta", delta: "hel" },
				{ kind: "text_delta", delta: "lo" },
			]),
		).toBe("hello");
	});

	it("breaks the line before a tool start when mid-line (mod.rs:2266-2272)", () => {
		expect(
			capture([
				{ kind: "text_delta", delta: "thinking" },
				{ kind: "tool_start", name: "read", args: '(path="/x")' },
			]),
		).toBe('thinking\n⚙ read(path="/x")\n');
	});

	it("indents tool output by four spaces (mod.rs:2274-2279)", () => {
		expect(capture([{ kind: "tool_end", tool_call_id: "t", lines: ["a", "b"], is_error: false }])).toBe(
			"    a\n    b\n",
		);
	});

	it("drops thinking, progress, poll status and skill reloads (mod.rs:2265, 2273, 2287-2289)", () => {
		expect(
			capture([
				{ kind: "thinking_delta", delta: "hmm" },
				{ kind: "tool_progress", tool_call_id: "t", lines: ["x"], is_error: false },
				{ kind: "skills_reloaded", total: 3 },
				{ kind: "turn_start" },
			]),
		).toBe("");
	});

	it("closes a dangling line at turn end, once (mod.rs:2290-2295)", () => {
		expect(capture([{ kind: "text_delta", delta: "tail" }, { kind: "turn_end" }, { kind: "turn_end" }])).toBe(
			"tail\n",
		);
	});
});
