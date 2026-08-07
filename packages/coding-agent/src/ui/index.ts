/**
 * The pie REPL — port of oracle `crates/coding-agent/src/ui/mod.rs` (pie @0a120dfd).
 *
 * `App` owns the whole interactive session: the turn state machine, the queue, slash dispatch,
 * clipboard/image attachment, the control-plane confirm surface, the model picker, the web relay,
 * and the non-TTY headless fallback. `./web.ts`'s `runWeb` drives this same object through the
 * `WebApp` interface — which this class implements structurally, with no adapter, exactly as
 * `web.ts:1056` anticipated.
 *
 * ## What lives where
 *
 * | oracle `ui/mod.rs` | here |
 * |---|---|
 * | `struct App` + `impl App` (:118-2115) | this file |
 * | free fns + constants (:71-79, :2117-2298) | `./app-text.ts` |
 * | `render*` + `*_panel_lines` + `status_line` (:1465-2009, :2117-2133) | `./app-render.ts` |
 * | `input: TextArea` (:126) | `./input-area.ts` |
 * | `resolve_ui_mode` (main.rs:1071-1105) | `./ui-mode.ts` |
 * | the retry wrapper `user_prompt_turn` runs in (agent_session.rs) | `./retry-prompt.ts` |
 *
 * ## Two seams oracle does not have
 *
 * 1. **`harness` vs `commandHarness`.** Oracle threads one `Arc<AgentHarness>` everywhere. Here the
 *    turn-running slice ({@link KernelHarness}) and the `commands.rs` slice ({@link AppHarness}) are
 *    separate structural interfaces, because the ported `@pie/agent-core` `AgentHarness` has no
 *    public `session()` / `skills()` / `templates()` (the gap `core/slash-dispatch-deps.ts:12-35`
 *    documents) — and, more decisively, because that class is not what the CLI runs at all
 *    (`migration/reviews/phase13/reachability-audit.md` §1). `./app-harness.ts` satisfies BOTH from
 *    one live `core/agent-session.ts` `AgentSession`, which is what `main.ts` passes. They must be
 *    the same underlying object; nothing here can check that, hence the loud name.
 * 2. **`TerminalDriver`.** Oracle talks to crossterm/ratatui directly. Here the terminal is an
 *    interface, so the event loop is drivable without a TTY — which is the only way any of this is
 *    testable in CI. See `./app-render.ts` for why painting stops at a `Frame`.
 */

import {
	type AgentMessage,
	AsyncQueue,
	type ControlPlanePromptDecision,
	type ControlPlanePromptRequest,
	type SelectCase,
	selectBiased,
} from "@pie/agent-core";
import { type AssistantMessage, type ImageContent, listModels, type Model, type UserMessage } from "@pie/ai";
import { relayBaseUrl } from "../config.ts";
import type { UiControlPlanePrompt } from "../control-plane-prompt.ts";
import { parseModelSpec } from "../core/slash-commands.ts";
import { dispatch, type Registry } from "../core/slash-dispatch.ts";
import type { CommandHarness, CommandOutcome, CommandSession, WebRelayAction } from "../core/slash-dispatch-deps.ts";
import { modelCredentialHint, saveApiKey } from "../core/slash-dispatch-session.ts";
import { attachSkillPrompt } from "../core/slash-dispatch-skills.ts";
import type { GoalState } from "../goal.ts";
import * as goal from "../goal.ts";
import type { HistoryStore } from "../history.ts";
import { expand as expandMentions } from "../mentions.ts";
import { catalog, ModelPickerState, type ProviderGroup } from "../model-picker.ts";
import { SlashCompleter } from "../readline.ts";
import { activateImported } from "../session-archive.ts";
import { type ClipboardImageAttachment, readClipboard } from "../utils/clipboard-image.ts";
import { loadAllImages, MAX_IMAGES_PER_MESSAGE } from "../utils/image-convert.ts";
import { sleep } from "../utils/sleep.ts";
import {
	type Frame,
	type Rect,
	type RenderSkill,
	type RenderSource,
	renderFrame,
	shouldShowSidePanel,
	statusLineText,
	triggerPanelLines,
} from "./app-render.ts";
import {
	CONTROL_PROMPT_TEXT_WIDTH,
	enterTuiCommands,
	type HeadlessCursor,
	type HeadlessOut,
	humanBytes,
	IDLE_CTRLC_WINDOW_MS,
	IMPORT_ACTIVATION_PROMPT_ID,
	leaveTuiCommands,
	printHeadlessUpdate,
	promptDisplay,
	queuePreview,
	SCROLL_STEP,
	safeControlPromptLabel,
	safeControlPromptText,
	TICK_INTERVAL_MS,
	userFacingRunError,
} from "./app-text.ts";
import {
	compactToolContentBlocks,
	Feed,
	type FeedLine,
	type FeedUpdate,
	preview,
	type TriggerPollStatus,
} from "./feed.ts";
import { type InputArea, type InputKey, newInputArea } from "./input-area.ts";
import {
	type KernelHarness,
	newTurnState,
	pollTurn,
	type QueuedTurn,
	queuedTurnDisplay,
	ReplKernel,
	type TurnFut,
	type TurnState,
} from "./kernel.ts";
import * as relay from "./relay.ts";
import {
	promptWithRetry,
	type RetryDeps,
	type RetryPolicy,
	type RetrySession,
	retryPolicyFrom,
} from "./retry-prompt.ts";
import type { PanelStatus, RelayHandleLike, TurnResult, WebApp, WebKernel } from "./web.ts";
import { webSnapshot } from "./web.ts";

export type { PanelStatus } from "./web.ts";

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Harness views — see this file's header, seam 1.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * The `Session` slice this REPL's three consumers need, unioned: `commands.rs`'s
 * {@link CommandSession}, `goal.rs`'s entry read/append (a subset of it), and
 * `agent_session.rs`'s rewind ({@link RetrySession}).
 *
 * Declared structurally rather than as `@pie/agent-core`'s `Session` class for the same reason
 * {@link KernelHarness} is: the CLI's session store is `core/session-manager.ts`, not that class
 * (`migration/reviews/phase13/reachability-audit.md` §1), and the class's `private storage` field
 * would make the product adapter un-passable. A real `Session` still satisfies every member.
 */
export interface AppSession extends CommandSession, RetrySession {}

/**
 * The `commands.rs` slice, widened with the members `ui/mod.rs` itself reaches for. Every name is
 * the real `AgentHarness` method it stands for, so a thin delegating adapter over one harness — or
 * over the product `AgentSession`, which is what `./app-harness.ts` supplies — satisfies the whole
 * interface.
 *
 * Narrowing `getModel()` to a non-optional `Model` (oracle's `state().model` is `Option<Model>`,
 * but the ported harness always has one) is what lets this double as `goal.ts`'s `GoalHarness`.
 */
export interface AppHarness extends CommandHarness, KernelHarness {
	session(): AppSession;
	getModel(): Model<any>;
	prompt(text: string, options?: { images?: ImageContent[] }): Promise<AssistantMessage>;
	continue(): Promise<AssistantMessage>;
	/** pie: the evaluator call `goal.rs` makes — the third member of `GoalHarness`. */
	runEvaluator(...args: any[]): Promise<any>;
}

/** pie: `self.kernel` (mod.rs:119). Satisfies `./web.ts`'s `WebKernel`. */
export interface AppKernel extends WebKernel {
	harness(): AppHarness;
	abort(): void;
	isStreaming(): boolean;
	currentModelAcceptsImages(): boolean;
	promptTurn(prompt: string): TurnFut;
	userPromptTurn(promptText: string, loadedImages: ImageContent[]): TurnFut;
	templateTurn(name: string, vars: Record<string, unknown>): TurnFut;
	compactionTurn(custom: string | undefined): TurnFut;
	continueTurn(): TurnFut;
}

/**
 * Wraps the delivered {@link ReplKernel} so `kernel.harness()` yields the `commands.rs` view.
 * `ReplKernel` itself keeps driving the real `AgentHarness` it was constructed with, so turn
 * bookkeeping ({@link ReplKernel.isStreaming}) stays accurate.
 */
function appKernel(kernel: ReplKernel, harness: AppHarness): AppKernel {
	return {
		harness: () => harness,
		abort: () => kernel.abort(),
		isStreaming: () => kernel.isStreaming(),
		currentModelAcceptsImages: () => kernel.currentModelAcceptsImages(),
		promptTurn: (prompt) => kernel.promptTurn(prompt),
		userPromptTurn: (text, images) => kernel.userPromptTurn(text, images),
		templateTurn: (name, vars) => kernel.templateTurn(name, vars),
		compactionTurn: (custom) => kernel.compactionTurn(custom),
		continueTurn: () => kernel.continueTurn(),
	};
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Terminal driver — see this file's header, seam 2.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/** `crossterm::event::KeyEvent` — {@link InputKey} plus the press/repeat/release discriminator. */
export interface TuiKey extends InputKey {
	/** pie: `key.kind != KeyEventKind::Release` (mod.rs:704). */
	readonly kind: "press" | "repeat" | "release";
}

/** `crossterm::event::Event`, narrowed to the arms `handle_event` matches (mod.rs:702-722). */
export type TuiEvent =
	| { readonly type: "key"; readonly key: TuiKey }
	| {
			readonly type: "mouse";
			readonly kind: "scrollUp" | "scrollDown" | "other";
			readonly column: number;
			readonly row: number;
	  }
	| { readonly type: "paste"; readonly text: string }
	| { readonly type: "resize" };

/** The crossterm + ratatui surface the event loop needs. */
export interface TerminalDriver {
	/** pie: `EventStream::new()` (mod.rs:371). Closing it ends the loop (`None => self.quit = true`). */
	readonly events: AsyncQueue<TuiEvent>;
	/** pie: `frame.area()`. */
	size(): Rect;
	/** pie: `terminal.draw(|f| self.render(f))`. */
	draw(frame: Frame): void;
	/** pie: `enter_tui()` (mod.rs:2227-2231). */
	enter(): void;
	/** pie: `leave_tui()` (mod.rs:2233-2237). */
	leave(): void;
	/** pie: `terminal.clear()` (mod.rs:1291). */
	clear(): void;
	/** pie: `terminal.show_cursor()` (mod.rs:365). */
	showCursor(): void;
}

/**
 * A {@link TerminalDriver} over a raw byte sink: the escape sequences of `enter_tui`/`leave_tui`
 * are real, painting is a no-op that just retains the latest {@link Frame}.
 * TODO(port): the painter — see `./app-render.ts`.
 */
export function escapeSequenceDriver(
	out: HeadlessOut,
	events: AsyncQueue<TuiEvent>,
	size: () => Rect,
): TerminalDriver & { latest(): Frame | undefined } {
	let latest: Frame | undefined;
	return {
		events,
		size,
		latest: () => latest,
		draw: (frame) => {
			latest = frame;
		},
		enter: () => out.write(enterTuiCommands()),
		leave: () => out.write(leaveTuiCommands()),
		clear: () => {
			latest = undefined;
		},
		showCursor: () => {},
	};
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Config — pie: mod.rs:100-116 (`struct AppConfig`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/** pie: mod.rs:180-184 (`struct PendingImportActivation`). */
interface PendingImportActivation {
	readonly sessionPath: string;
	readonly triggerIds: string[];
	readonly cronIds: string[];
}

/** pie: mod.rs:100-116 — "Everything the app needs to run a session, assembled by `main.rs`". */
export interface AppConfig {
	/** pie: `harness: Arc<AgentHarness>` — the object {@link ReplKernel} drives. */
	harness: KernelHarness;
	/** The SAME harness, seen through `commands.rs`'s slice. See this file's header, seam 1. */
	commandHarness: AppHarness;
	/** pie: `retry: RetrySettings`. */
	retry?: {
		enabled?: boolean;
		maxRetries?: number;
		baseDelayMs?: number;
		fallbackModel?: readonly [string, string];
	};
	registry: Registry;
	cwd: string;
	sessionId: string;
	logPath?: string;
	toolCount: number;
	history: HistoryStore;
	/** pie: "`--image` payloads attached to the first prompt only." */
	pendingImages?: string[];
	feedRx: AsyncQueue<FeedUpdate>;
	mainRunRx: AsyncQueue<string>;
	controlPlanePromptRx?: AsyncQueue<UiControlPlanePrompt>;
	panelStatus: PanelStatus;

	// ── seams with no oracle counterpart ────────────────────────────────────────────────────
	/** pie: `crate::model_picker::catalog()`. Injected so tests need no credential probe. */
	catalog?: () => ProviderGroup[];
	/** pie: `crate::prompt_for_api_key` (main.rs:1138-1149). */
	promptForApiKey?: (provider: string) => Promise<string>;
	/** Clock + model lookup for the retry loop. */
	retryDeps?: RetryDeps;
	/** stdout for headless mode (oracle's `println!` / `print_headless_update`). */
	out?: HeadlessOut;
	/** stderr for headless mode (oracle's `eprintln!`). */
	errOut?: HeadlessOut;
	/** stdin lines for headless mode. */
	stdinLines?: () => AsyncIterable<string>;
	/** pie: `std::io::stdin().is_terminal() && std::io::stdout().is_terminal()` (mod.rs:355). */
	isTty?: () => boolean;
}

/**
 * pie: main.rs:1151-1158 (`login_requires_tty_message`). Ported here because pi's `main.ts` — the
 * `coding-agent/main` diff-port base — has no `/login` REPL command to hang it on.
 */
export function loginRequiresTtyMessage(provider: string, recoveryCommand?: string): string {
	// pie: main.rs:1152-1154 — the recovery command defaults to the `/login` the user just typed.
	const command = recoveryCommand ?? `/login ${provider}`;
	return `/login requires an interactive terminal so the API key is not echoed; run pie in a TTY and use \`${command}\``;
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * App — pie: mod.rs:118-2115.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

export class App implements WebApp, RenderSource {
	// ── pie: mod.rs:119-125.
	readonly kernel: AppKernel;
	readonly registry: Registry;
	completer: SlashCompleter;
	readonly cwd: string;
	readonly sessionId: string;
	readonly logPath?: string;
	readonly toolCount: number;

	// ── pie: mod.rs:127-132.
	readonly history: HistoryStore;
	private historyIdx?: number;
	private draft = "";
	pendingSkill?: string;
	pendingImages: string[];
	pendingPastedImages: ImageContent[] = [];

	// ── pie: mod.rs:134-142.
	readonly feed = new Feed();
	latestTriggerPoll?: TriggerPollStatus;
	latestGoal?: GoalState;
	readonly feedRx: AsyncQueue<FeedUpdate>;
	readonly mainRunRx: AsyncQueue<string>;
	readonly controlPlanePromptRx?: AsyncQueue<UiControlPlanePrompt>;
	controlPlanePrompt?: UiControlPlanePrompt;
	modelPicker?: ModelPickerState;
	/** pie: mod.rs:141-142 — "Cached for web snapshots; refreshed on picker open and model switch." */
	modelCatalog: ProviderGroup[];
	panelStatus: PanelStatus;

	// ── pie: mod.rs:145-147.
	input: InputArea = newInputArea();
	completions: string[] = [];
	completionIdx = 0;

	// ── pie: mod.rs:149-152.
	scroll = 0;
	follow = true;
	lastViewportH = 1;
	lastFeedArea?: Rect;

	// ── pie: mod.rs:154-158.
	busy = false;
	/** pie: `VecDeque<QueuedTurn>` — `push_back`/`pop_front`/`pop_back` map to push/shift/pop. */
	readonly queuedTurns: QueuedTurn[] = [];
	spinnerFrame = 0;
	private lastCtrlc?: number;
	quit = false;

	// ── pie: mod.rs:160-178 — the relay channels exist from construction so the loops can always
	// select on them; they only carry traffic while a relay is connected.
	relay?: relay.RelayHandle;
	/** pie: mod.rs:165-167 — QR art is only useful where a real terminal shows the feed. */
	private relayQrInFeed = false;
	readonly relayPromptRx = new AsyncQueue<string>();
	readonly relayAbortRx = new AsyncQueue<void>();
	readonly relayResolveRx = new AsyncQueue<boolean>();
	readonly relayModelRx = new AsyncQueue<string>();
	private pendingImportActivation?: PendingImportActivation;

	private readonly config: AppConfig;
	private readonly retryPolicy: RetryPolicy;

	/** pie: mod.rs:189-247 (`App::new`). */
	constructor(config: AppConfig) {
		this.config = config;
		const kernel = new ReplKernel(config.harness, {
			enabled: config.retry?.enabled,
			maxRetries: config.retry?.maxRetries,
			baseDelayMs: config.retry?.baseDelayMs,
		});
		this.retryPolicy = retryPolicyFrom(config.retry ?? {});
		// The `TODO(port)` at kernel.ts:203-218, closed: the no-image `user_prompt_turn` runs inside
		// oracle's own retry wrapper (`./retry-prompt.ts`), which takes exactly a harness + settings.
		kernel.setUserPromptRunner((text) =>
			promptWithRetry(config.commandHarness, this.retryPolicy, text, config.retryDeps),
		);
		this.kernel = appKernel(kernel, config.commandHarness);
		this.registry = config.registry;
		// pie: mod.rs:190-191.
		this.completer = SlashCompleter.fromRegistryAndSkills(
			config.registry.commands(),
			completerSkills(config.commandHarness),
		);
		this.cwd = config.cwd;
		this.sessionId = config.sessionId;
		this.logPath = config.logPath;
		this.toolCount = config.toolCount;
		this.history = config.history;
		this.pendingImages = [...(config.pendingImages ?? [])];
		this.feedRx = config.feedRx;
		this.mainRunRx = config.mainRunRx;
		this.controlPlanePromptRx = config.controlPlanePromptRx;
		// pie: mod.rs:226 — the catalog is built once at construction.
		this.modelCatalog = this.catalog();
		this.panelStatus = config.panelStatus;
	}

	/** pie: `crate::model_picker::catalog()`. */
	private catalog(): ProviderGroup[] {
		if (this.config.catalog !== undefined) return this.config.catalog();
		// TODO(port): oracle's `catalog()` also consults `AuthStore::load()`; this default probes only
		// the environment, so a provider credentialed solely through the auth store renders `no key`.
		// Inject `AppConfig.catalog` to close that.
		return catalog({ modelRegistry: { getAll: () => listModels() } });
	}

	/* ── startup feed seeding — pie: mod.rs:248-352 ─────────────────────────────────────────── */

	/** pie: mod.rs:248-282 (`banner`). */
	banner(
		model: { name: string; provider: string; id: string },
		sessionId: string,
		resumed: boolean,
		tools: readonly string[],
	): void {
		this.feed.pushPlainUntimed("──────── pie-coding-agent ────────", "header");
		this.feed.pushPlainUntimed(`model:   ${model.name} (${model.provider}/${model.id})`, "output");
		this.feed.pushPlainUntimed(`session: ${sessionId}${resumed ? "  [resumed]" : ""}`, "output");
		// pie: mod.rs:272-276.
		const toolText = tools.length === 0 ? "(none)" : tools.join(", ");
		this.feed.pushPlainUntimed(`tools:   ${toolText}`, "output");
		this.feed.pushPlainUntimed("Enter send · Ctrl-V paste text/images · Ctrl-C abort/exit · /help", "system");
	}

	/** pie: mod.rs:284-286 (`system_line`). */
	systemLine(text: string): void {
		this.feed.pushPlain(text, "system");
	}

	/** pie: mod.rs:288-292 (`error_line`). */
	errorLine(text: string): void {
		this.feed.pushPlain(`error: ${text}`, "error");
	}

	/** pie: mod.rs:294-302 (`replay`) — a `--resume` transcript, pushed as finished blocks. */
	replay(messages: readonly AgentMessage[]): void {
		if (messages.length === 0) return;
		this.systemLine(`resumed — replaying ${messages.length} messages`);
		for (const message of messages) this.replayMessage(message);
	}

	/** pie: mod.rs:304-352 (`replay_message`). */
	replayMessage(message: AgentMessage): void {
		if (message.role === "user") {
			const user = message as UserMessage;
			// pie: mod.rs:306-320 — `UserContent::Text` vs `Blocks`; an image block renders as its
			// mime type, never its bytes.
			const content = user.content;
			const text =
				typeof content === "string"
					? content
					: content.map((block) => (block.type === "image" ? `<image ${block.mimeType}>` : block.text)).join("\n");
			this.feed.pushUserAt(text, user.timestamp ?? 0);
			return;
		}
		if (message.role === "assistant") {
			const assistant = message as AssistantMessage;
			const timestamp = assistant.timestamp ?? 0;
			// pie: mod.rs:322-341.
			for (const block of assistant.content) {
				if (block.type === "text") {
					this.feed.pushAssistantAt(block.text, timestamp);
				} else if (block.type === "thinking") {
					this.feed.pushThinkingAt(block.thinking, timestamp);
				} else if (block.type === "toolCall") {
					this.feed.pushToolAt(block.name, preview(block.arguments), timestamp);
				}
				// pie: mod.rs:340 — `ContentBlock::Image(_) => {}`.
			}
			return;
		}
		if (message.role === "toolResult") {
			// pie: mod.rs:342-350.
			const result = message as unknown as {
				toolCallId: string;
				content: any[];
				isError: boolean;
				timestamp?: number;
			};
			this.feed.pushToolResultAt(
				result.toolCallId,
				compactToolContentBlocks(result.content, result.isError),
				result.isError,
				result.timestamp ?? 0,
			);
		}
		// pie: mod.rs:351 — `AgentMessage::Custom(_) => {}`.
	}

	/* ── main entry — pie: mod.rs:354-456 ───────────────────────────────────────────────────── */

	/** pie: mod.rs:354-366 (`run`). */
	async run(driver: TerminalDriver): Promise<void> {
		// pie: mod.rs:355-357 — either stream not a terminal drops to the line-based fallback.
		const isTty = this.config.isTty ?? (() => process.stdin.isTTY === true && process.stdout.isTTY === true);
		if (!isTty()) {
			return this.runHeadless();
		}
		this.relayQrInFeed = true;
		driver.enter();
		try {
			await this.eventLoop(driver);
		} finally {
			// pie: mod.rs:363-364 — both are best-effort (`.ok()`), and both run even on error.
			driver.leave();
			driver.showCursor();
		}
	}

	/**
	 * pie: mod.rs:368-455 (`event_loop`).
	 *
	 * The `select!` is `biased`, so branch order is load-bearing and {@link selectBiased} is the
	 * required helper (RULEBOOK §2.2). Guarded branches (`, if cond`) are omitted from the case
	 * array on the iterations where the guard is false, exactly as tokio skips a disabled branch;
	 * a branch whose channel has closed is retired for good, since `Some(x) = rx.recv()` yielding
	 * `None` does not match and tokio disables that branch permanently.
	 */
	async eventLoop(driver: TerminalDriver): Promise<void> {
		const turn = newTurnState();
		// pie: mod.rs:393.
		await this.refreshGoalState();
		const closed = new Set<LoopBranch>();

		for (;;) {
			// pie: mod.rs:396-400 — draw, publish, THEN check quit, so the final frame is painted.
			driver.draw(this.render(driver.size()));
			this.pushRelaySnapshot();
			if (this.quit) return;

			const cases: SelectCase<LoopEvent>[] = [];
			const add = (branch: LoopBranch, selectCase: SelectCase<LoopEvent>): void => {
				if (!closed.has(branch)) cases.push(selectCase);
			};

			// pie: mod.rs:402-404 — re-awaiting the same promise each iteration is the TS analogue of
			// `&mut turn.fut`: losing the race does not lose progress, the promise keeps running.
			if (turn.fut !== undefined) {
				const pending = pollTurn(turn.fut);
				cases.push({
					run: async (): Promise<LoopEvent> => {
						try {
							return { branch: "turn", result: { ok: true, value: await pending } };
						} catch (error) {
							return { branch: "turn", result: { ok: false, error } };
						}
					},
				});
			}
			// pie: mod.rs:405-411.
			add(
				"event",
				queueCase(driver.events, (event) => ({ branch: "event", event })),
			);
			// pie: mod.rs:412-417.
			add(
				"feed",
				queueCase(this.feedRx, (update) => ({ branch: "feed", update })),
			);
			// pie: mod.rs:418-420 — guarded on `turn.fut.is_none()`.
			if (turn.fut === undefined) {
				add(
					"main_run",
					queueCase(this.mainRunRx, (traceId) => ({ branch: "main_run", traceId })),
				);
			}
			// pie: mod.rs:421-423.
			add(
				"relay_prompt",
				queueCase(this.relayPromptRx, (text) => ({ branch: "relay_prompt", text })),
			);
			// pie: mod.rs:424-429 — payload is `()`, so "closed" is the only distinguishable state.
			add(
				"relay_abort",
				queueCase(this.relayAbortRx, (value) => ({ branch: "relay_abort", closed: value === undefined })),
			);
			// pie: mod.rs:430-432.
			add(
				"relay_resolve",
				queueCase(this.relayResolveRx, (approve) => ({ branch: "relay_resolve", approve })),
			);
			// pie: mod.rs:433-436.
			add(
				"relay_model",
				queueCase(this.relayModelRx, (spec) => ({ branch: "relay_model", spec })),
			);
			// pie: mod.rs:437-444 — guarded on `control_plane_prompt.is_none() && rx.is_some()`.
			const promptRx = this.controlPlanePromptRx;
			if (promptRx !== undefined && this.controlPlanePrompt === undefined) {
				add(
					"control_plane",
					queueCase(promptRx, (prompt) => ({ branch: "control_plane", prompt })),
				);
			}
			// pie: mod.rs:445-449 (`tick.tick()`) — RULEBOOK §2.2's timeout row: an `AbortSignal`-driven
			// timer inside a select case, cleared when the branch loses.
			cases.push(tickCase(TICK_INTERVAL_MS));

			const { value } = await selectBiased(cases);
			switch (value.branch) {
				case "turn":
					await this.finishTurn(turn, value.result);
					break;
				case "event":
					// pie: mod.rs:408-410 — a closed event stream means the terminal went away.
					if (value.event === undefined) {
						closed.add("event");
						this.quit = true;
						break;
					}
					await this.handleEvent(value.event, turn, driver);
					break;
				case "feed": {
					if (value.update === undefined) {
						closed.add("feed");
						break;
					}
					this.applyFeedUpdate(value.update);
					// pie: mod.rs:414-416 — `while let Ok(update) = feed_rx.try_recv()`: drain what is
					// already buffered before repainting. `try_recv` is non-blocking, hence the `size`
					// guard rather than an unguarded `await next()`.
					while (this.feedRx.size > 0) {
						const extra = await this.feedRx.next();
						if (extra === undefined) break;
						this.applyFeedUpdate(extra);
					}
					break;
				}
				case "main_run":
					if (value.traceId === undefined) {
						closed.add("main_run");
						break;
					}
					this.startTriggeredTurn(value.traceId, turn);
					break;
				case "relay_prompt":
					if (value.text === undefined) {
						closed.add("relay_prompt");
						break;
					}
					this.submitRemoteText(value.text, turn);
					break;
				case "relay_abort":
					if (value.closed) {
						closed.add("relay_abort");
						break;
					}
					// pie: mod.rs:425-428 — an abort with no turn in flight is silently ignored.
					if (turn.fut !== undefined) {
						this.systemLine("[web] abort requested");
						this.requestAbort(turn);
					}
					break;
				case "relay_resolve":
					if (value.approve === undefined) {
						closed.add("relay_resolve");
						break;
					}
					this.resolveFromRelay(value.approve);
					break;
				case "relay_model":
					if (value.spec === undefined) {
						closed.add("relay_model");
						break;
					}
					this.systemLine(`[web] set model: ${value.spec}`);
					await this.setModelFromSpec(value.spec);
					break;
				case "control_plane":
					if (value.prompt === undefined) {
						closed.add("control_plane");
						break;
					}
					this.showControlPlanePrompt(value.prompt);
					break;
				case "tick":
					// pie: mod.rs:446-448 — the spinner only advances while a turn is in flight.
					if (turn.fut !== undefined) {
						this.spinnerFrame = (this.spinnerFrame + 1) >>> 0;
					}
					break;
			}
		}
	}

	/** pie: mod.rs:457-483 (`finish_turn`) — "clear the busy state and surface an aborted/error line". */
	async finishTurn(turn: TurnState, result: TurnResult): Promise<void> {
		turn.fut = undefined;
		this.busy = false;
		this.spinnerFrame = 0;
		if (turn.aborted) {
			this.systemLine("[aborted]");
		} else if (result.ok) {
			// pie: mod.rs:467-468 — `Ok(None)` prints nothing.
			if (result.value !== undefined) this.systemLine(result.value);
		} else {
			// pie: mod.rs:469-473.
			this.errorLine(`${turn.prefix}${userFacingRunError(errorText(result.error))}`);
		}
		turn.aborted = false;
		turn.prefix = "";
		await this.refreshGoalState();
		this.startNextQueuedTurn(turn);
	}

	/* ── relay + confirm surface — pie: mod.rs:485-700 ──────────────────────────────────────── */

	/** pie: mod.rs:485-549 (`handle_web_relay`). Shared by the TUI and web event loops. */
	async handleWebRelay(action: WebRelayAction): Promise<void> {
		if (action === "connect") {
			// pie: mod.rs:489-492.
			if (this.relay !== undefined) {
				this.systemLine(`web relay already active: ${this.relay.url}`);
				return;
			}
			let base: string;
			try {
				base = await relayBaseUrl();
			} catch (error) {
				this.errorLine(`web-connect: ${errorText(error)}`);
				return;
			}
			let handle: relay.RelayHandle;
			try {
				// pie: mod.rs:501-507 — oracle passes four positional senders; `./relay.ts` takes the
				// same four as a named `RelaySinks`.
				handle = relay.start(base, {
					prompt: this.relayPromptRx,
					abort: this.relayAbortRx,
					resolve: this.relayResolveRx,
					model: this.relayModelRx,
				});
			} catch (error) {
				this.errorLine(`web-connect: ${errorText(error)}`);
				return;
			}
			this.systemLine(`web relay: ${handle.url}`);
			this.systemLine(
				"warning: anyone with this URL can watch the full conversation, send prompts, AND approve permission requests until /web-disconnect",
			);
			// pie: mod.rs:515-531.
			if (this.relayQrInFeed) {
				try {
					const lines = relay.qrLines(handle.url);
					this.feed.pushPlainUntimed("", "qr");
					for (const line of lines) this.feed.pushPlainUntimed(line, "qr");
					this.feed.pushPlainUntimed("scan with your phone to open the session", "system");
				} catch (error) {
					this.systemLine(`qr render skipped: ${errorText(error)}`);
				}
			}
			this.relay = handle;
			this.pushRelaySnapshot();
			return;
		}
		if (action === "status") {
			// pie: mod.rs:536-539.
			this.systemLine(
				this.relay === undefined ? "web relay is off — start one with /web-connect" : this.relay.statusLine(),
			);
			return;
		}
		// pie: mod.rs:540-547 — `self.relay.take()`, so a disconnect always clears the field.
		const active = this.relay;
		this.relay = undefined;
		if (active === undefined) {
			this.systemLine("web relay is not active");
			return;
		}
		active.shutdown();
		this.systemLine("web relay disconnected; the session URL is now invalid");
	}

	/** pie: mod.rs:549-557 (`push_relay_snapshot`) — "cheap when off; the relay task debounces". */
	pushRelaySnapshot(): void {
		(this.relay as RelayHandleLike | undefined)?.pushSnapshot(webSnapshot(this));
	}

	/** pie: mod.rs:559-601 (`prompt_import_activation`). */
	promptImportActivation(sessionPath: string, triggerIds: string[], cronIds: string[]): void {
		// pie: mod.rs:565-573 — a real tool prompt is pending; don't fight over the surface.
		if (this.controlPlanePrompt !== undefined) {
			this.systemLine(
				"imported automation left disabled (another approval is pending); enable via /triggers enable and /cron enable",
			);
			return;
		}
		const label = `activate imported automation? (${triggerIds.length} trigger(s), ${cronIds.length} cron job(s) were enabled at the source)`;
		const request: ControlPlanePromptRequest = {
			toolCallId: IMPORT_ACTIVATION_PROMPT_ID,
			toolName: "SessionImport",
			argsHash: "",
			label,
			// pie: mod.rs:589-592 — the two keys are oracle's literal `json!` keys.
			payload: { triggers: triggerIds, cron_jobs: cronIds },
			reason: "re-enable automation imported from a session archive",
		};
		// pie: mod.rs:585 — `let (responder, _discarded) = oneshot::channel();`: the receiver is
		// dropped immediately, so this prompt's decision goes nowhere but the branch below.
		const prompt: UiControlPlanePrompt = { request, resolve: () => {}, close: () => {} };
		this.pendingImportActivation = { sessionPath, triggerIds, cronIds };
		this.showControlPlanePrompt(prompt);
	}

	/** pie: mod.rs:603-618 (`resolve_from_relay`) — "first-class, identical to a local confirmation". */
	resolveFromRelay(approve: boolean): void {
		if (this.controlPlanePrompt === undefined) return;
		this.resolveControlPlanePrompt(approve ? { type: "allow" } : { type: "deny", reason: "denied via web relay" });
	}

	/**
	 * pie: mod.rs:620-637 (`submit_remote_text`). Remote slash commands are refused — the capability
	 * URL grants prompting, not REPL control.
	 */
	submitRemoteText(text: string, turn: TurnState): void {
		const trimmed = text.trim();
		if (trimmed === "") return;
		if (trimmed.startsWith("/")) {
			this.systemLine("[web] remote slash command refused");
			return;
		}
		const display = `[web] ${trimmed}`;
		this.follow = true;
		if (turn.fut !== undefined) {
			this.queueUserPrompt(display, trimmed, []);
		} else {
			this.feed.pushUser(display);
			this.startUserPromptTurn(trimmed, [], turn);
		}
	}

	/** pie: mod.rs:639-646 (`apply_feed_update`) — the poll status is panel state, not a feed block. */
	applyFeedUpdate(update: FeedUpdate): void {
		if (update.kind === "trigger_poll_status") {
			const { kind: _kind, ...status } = update;
			this.latestTriggerPoll = status;
			return;
		}
		this.feed.apply(update);
	}

	/** pie: mod.rs:648-653 (`show_control_plane_prompt`). */
	showControlPlanePrompt(prompt: UiControlPlanePrompt): void {
		const label = safeControlPromptLabel(prompt.request.label);
		this.controlPlanePrompt = prompt;
		this.systemLine(`approval required: ${label}`);
		this.follow = true;
	}

	/** pie: mod.rs:655-700 (`resolve_control_plane_prompt`). */
	resolveControlPlanePrompt(decision: ControlPlanePromptDecision): void {
		const prompt = this.controlPlanePrompt;
		if (prompt === undefined) return;
		this.controlPlanePrompt = undefined;
		const label = safeControlPromptLabel(prompt.request.label);
		// pie: mod.rs:660-676.
		let message: string;
		if (decision.type === "allow") {
			message = `approved control-plane action: ${label}`;
		} else if (decision.type === "deny") {
			const reason = safeControlPromptText(decision.reason ?? "denied by user", CONTROL_PROMPT_TEXT_WIDTH);
			message = `denied control-plane action: ${label} (${reason})`;
		} else {
			message = `control-plane action timed out: ${label}`;
		}
		const isImportActivation = prompt.request.toolCallId === IMPORT_ACTIVATION_PROMPT_ID;
		const approved = decision.type === "allow";
		// pie: mod.rs:679-680 — resolve BEFORE the message, so the waiting tool is unblocked first.
		prompt.resolve(decision);
		this.systemLine(message);
		if (!isImportActivation) return;
		const pending = this.pendingImportActivation;
		this.pendingImportActivation = undefined;
		if (pending === undefined) return;
		if (!approved) {
			// pie: mod.rs:694-697.
			this.systemLine("imported automation stays disabled; enable later via /triggers enable and /cron enable");
			return;
		}
		try {
			// pie: mod.rs:683-692.
			const { triggersEnabled, cronEnabled } = activateImported(
				pending.sessionPath,
				pending.triggerIds,
				pending.cronIds,
			);
			this.systemLine(
				`activated imported automation: ${triggersEnabled} trigger(s), ${cronEnabled} cron job(s) re-enabled`,
			);
		} catch (error) {
			this.errorLine(`activate imported automation: ${errorText(error)}`);
		}
	}

	/* ── event handling — pie: mod.rs:702-935 ───────────────────────────────────────────────── */

	/** pie: mod.rs:702-724 (`handle_event`). */
	async handleEvent(event: TuiEvent, turn: TurnState, driver: TerminalDriver): Promise<void> {
		switch (event.type) {
			// pie: mod.rs:704-706 — release events are dropped before any handler sees them.
			case "key":
				if (event.key.kind !== "release") await this.handleKey(event.key, turn, driver);
				return;
			// pie: mod.rs:707-711.
			case "mouse":
				if (event.kind === "scrollUp") this.handleMouseScroll(event.column, event.row, true);
				else if (event.kind === "scrollDown") this.handleMouseScroll(event.column, event.row, false);
				return;
			// pie: mod.rs:712-715.
			case "paste":
				this.input.insertStr(event.text);
				this.refreshCompletions();
				return;
			default:
				return;
		}
	}

	/** pie: mod.rs:726-797 (`handle_key`). */
	async handleKey(key: TuiKey, turn: TurnState, driver: TerminalDriver): Promise<void> {
		// pie: mod.rs:732-737 — the two modal surfaces swallow keys before anything else.
		if (this.handleControlPlanePromptKey(key)) return;
		if (await this.handleModelPickerKey(key)) return;
		const { ctrl, alt, shift } = key;
		const code = key.code;
		const char = code.kind === "char" ? code.char : undefined;
		// pie: mod.rs:741-748.
		if (char === "c" && ctrl) {
			if (turn.fut !== undefined) this.requestAbort(turn);
			else if (this.onIdleCtrlc()) this.quit = true;
			return;
		}
		// pie: mod.rs:749-759.
		if (char === "d" && ctrl) {
			if (this.handleCtrlD(turn)) return;
			if (this.inputText() === "") {
				this.systemLine("eof — exiting");
				this.quit = true;
			} else {
				this.input.input(key);
				this.refreshCompletions();
			}
			return;
		}
		// pie: mod.rs:760-768 — Esc clears completions first, then aborts, then clears the input.
		if (code.kind === "esc") {
			if (this.completions.length > 0) this.completions = [];
			else if (turn.fut !== undefined) this.requestAbort(turn);
			else this.clearInput();
			return;
		}
		// pie: mod.rs:769-772.
		if (code.kind === "enter" && (alt || shift)) {
			this.input.insertNewline();
			this.refreshCompletions();
			return;
		}
		// pie: mod.rs:773-775.
		if (code.kind === "enter") {
			await this.submit(turn, driver);
			return;
		}
		// pie: mod.rs:776-778.
		if (char === "v" && ctrl) {
			await this.pasteClipboard();
			return;
		}
		// pie: mod.rs:779.
		if (code.kind === "tab") {
			this.cycleCompletion();
			return;
		}
		// pie: mod.rs:780-781.
		if (code.kind === "pageUp") {
			this.scrollUp(Math.max(this.lastViewportH, 1));
			return;
		}
		if (code.kind === "pageDown") {
			this.scrollDown(Math.max(this.lastViewportH, 1));
			return;
		}
		// pie: mod.rs:782-783 — history only takes the arrows while the input is one line.
		if (code.kind === "up" && this.inputIsSingleLine()) {
			this.historyPrev();
			return;
		}
		if (code.kind === "down" && this.inputIsSingleLine()) {
			this.historyNext();
			return;
		}
		// pie: mod.rs:784-790 — empty Ctrl-U while busy drops the last queued message.
		if (char === "u" && ctrl) {
			if (this.inputText() === "" && turn.fut !== undefined) this.cancelLastQueuedTurn();
			else this.clearInput();
			return;
		}
		// pie: mod.rs:791-795.
		this.input.input(key);
		this.lastCtrlc = undefined;
		this.refreshCompletions();
	}

	/** pie: mod.rs:801-833 (`handle_control_plane_prompt_key`). True when the key was eaten. */
	handleControlPlanePromptKey(key: TuiKey): boolean {
		// pie: mod.rs:802-804.
		if (this.controlPlanePrompt === undefined) return false;
		// pie: mod.rs:805-807 — while the card is up, even a release is swallowed.
		if (key.kind === "release") return true;
		const code = key.code;
		const char = code.kind === "char" ? code.char : undefined;
		// pie: mod.rs:809-816.
		const allow = code.kind === "enter" || char === "y" || char === "Y" || char === "a" || char === "A";
		// pie: mod.rs:817-825.
		const deny =
			code.kind === "esc" ||
			char === "n" ||
			char === "N" ||
			char === "d" ||
			char === "D" ||
			(key.ctrl && char === "c");
		if (allow) {
			this.resolveControlPlanePrompt({ type: "allow" });
		} else if (deny) {
			this.resolveControlPlanePrompt({ type: "deny", reason: "denied by user" });
		}
		return true;
	}

	/** pie: mod.rs:835-855 (`open_model_picker`). */
	openModelPicker(): void {
		this.modelCatalog = this.catalog();
		if (this.modelCatalog.length === 0) {
			this.systemLine("no openai/anthropic-compatible models registered; use /model <provider:model-id>");
			return;
		}
		const active = this.kernel.harness().getModel();
		this.modelPicker = new ModelPickerState(
			[...this.modelCatalog],
			active === undefined ? undefined : { provider: active.provider, id: active.id },
		);
	}

	/** pie: mod.rs:857-908 (`handle_model_picker_key`) — modal: every key is consumed while open. */
	async handleModelPickerKey(key: TuiKey): Promise<boolean> {
		const picker = this.modelPicker;
		if (picker === undefined) return false;
		if (key.kind === "release") return true;
		const code = key.code;
		const char = code.kind === "char" ? code.char : undefined;
		// pie: mod.rs:864-897 — the action is computed under the borrow, then applied after it ends.
		let action: { kind: "none" } | { kind: "close" } | { kind: "select"; spec: string } = { kind: "none" };
		if (code.kind === "up" || char === "k") {
			picker.up();
		} else if (code.kind === "down" || char === "j") {
			picker.down();
		} else if (code.kind === "enter") {
			const spec = picker.enter();
			if (spec !== undefined) action = { kind: "select", spec };
		} else if (code.kind === "esc") {
			// pie: mod.rs:882-888 — `back()` true means "already at the top level", i.e. close.
			if (picker.back()) action = { kind: "close" };
		} else if (char === "c" && key.ctrl) {
			action = { kind: "close" };
		}
		if (action.kind === "close") {
			this.modelPicker = undefined;
		} else if (action.kind === "select") {
			this.modelPicker = undefined;
			await this.setModelFromSpec(action.spec);
		}
		return true;
	}

	/** pie: mod.rs:910-935 (`set_model_from_spec`). */
	async setModelFromSpec(spec: string): Promise<void> {
		const parsed = parseModelSpec(spec);
		if (parsed === undefined) {
			this.errorLine(`invalid model spec: ${spec}`);
			return;
		}
		const { provider, id } = parsed;
		const model = listModels().find((candidate) => candidate.provider === provider && candidate.id === id);
		if (model === undefined) {
			this.errorLine(`unknown model: ${provider}:${id}`);
			return;
		}
		try {
			await this.kernel.harness().setModel(model);
		} catch (error) {
			// pie: mod.rs:934.
			this.errorLine(`set_model failed: ${errorText(error)}`);
			return;
		}
		// pie: mod.rs:923-931.
		const hint = modelCredentialHint(provider);
		if (hint !== undefined) this.systemLine(`selected ${provider}:${id}, but login is required: ${hint}`);
		else this.systemLine(`switched to ${provider}:${id}`);
		this.modelCatalog = this.catalog();
	}

	/* ── submit / dispatch — pie: mod.rs:937-1330 ───────────────────────────────────────────── */

	/** pie: mod.rs:937-1007 (`submit`). */
	async submit(turn: TurnState, driver: TerminalDriver): Promise<void> {
		const trimmed = this.inputText().trim();
		const hasPendingImages = this.pendingImages.length > 0 || this.pendingPastedImages.length > 0;
		// pie: mod.rs:945-947.
		if (trimmed === "" && !hasPendingImages) return;
		// pie: mod.rs:948-957 — a slash command is echoed and dispatched; it never touches images.
		if (trimmed.startsWith("/")) {
			this.clearInput();
			this.historyIdx = undefined;
			this.lastCtrlc = undefined;
			this.history.append(trimmed);
			this.follow = true;
			this.feed.pushUser(trimmed);
			await this.dispatchSlash(trimmed, driver, turn);
			return;
		}
		// pie: mod.rs:959-961.
		if (!this.validatePendingImageSupport()) return;

		this.clearInput();
		this.historyIdx = undefined;
		this.lastCtrlc = undefined;
		// pie: mod.rs:968-970 — an image-only prompt appends nothing to history.
		if (trimmed !== "") this.history.append(trimmed);
		this.follow = true;

		// pie: mod.rs:973-979.
		const expanded = trimmed === "" ? "" : (await expandMentions(trimmed, this.cwd)).prompt;
		const skill = this.pendingSkill;
		this.pendingSkill = undefined;
		const promptText = attachSkillPrompt(expanded, skill);

		// pie: mod.rs:981-994 — `--image` payloads attach to the FIRST prompt only.
		const imagePaths = this.pendingImages;
		this.pendingImages = [];
		let loadedImages: ImageContent[] = [];
		if (imagePaths.length > 0) {
			try {
				loadedImages = await loadAllImages(imagePaths);
			} catch (error) {
				this.errorLine(`--image: ${errorText(error)}`);
				loadedImages = [];
			}
		}
		loadedImages = [...loadedImages, ...this.pendingPastedImages];
		this.pendingPastedImages = [];
		// pie: mod.rs:995-997.
		if (promptText.trim() === "" && loadedImages.length === 0) return;

		const display = this.promptDisplay(trimmed, loadedImages.length);
		// pie: mod.rs:1001-1006.
		if (turn.fut !== undefined) {
			this.queueUserPrompt(display, promptText, loadedImages);
		} else {
			this.feed.pushUser(display);
			this.startUserPromptTurn(promptText, loadedImages, turn);
		}
	}

	/** pie: mod.rs:1009-1022 (`start_triggered_turn`). */
	startTriggeredTurn(traceId: string, turn: TurnState): void {
		// pie: mod.rs:1010-1013 — "a user prompt may have started in the gap; `continue_` would
		// return AlreadyStreaming. Skip rather than error."
		if (this.kernel.isStreaming()) return;
		const short = [...traceId].slice(0, 8).join("");
		this.systemLine(`running triggered turn (trace ${short})`);
		this.follow = true;
		turn.fut = this.kernel.continueTurn();
		turn.aborted = false;
		turn.prefix = "triggered turn: ";
		this.busy = true;
	}

	/** pie: mod.rs:1024-1040 (`paste_clipboard`). */
	async pasteClipboard(): Promise<void> {
		let paste: Awaited<ReturnType<typeof readClipboard>>;
		try {
			paste = await readClipboard();
		} catch (error) {
			this.errorLine(`clipboard paste failed: ${errorText(error)}`);
			return;
		}
		if (paste.kind === "image") {
			this.attachClipboardImage(paste.image);
		} else if (paste.kind === "text") {
			this.input.insertStr(paste.text);
			this.refreshCompletions();
		} else {
			this.systemLine("clipboard is empty");
		}
	}

	/** pie: mod.rs:1042-1065 (`attach_clipboard_image`) — never echoes the blob. */
	attachClipboardImage(image: ClipboardImageAttachment): void {
		// pie: mod.rs:1043-1046.
		if (!this.currentModelAcceptsImages()) {
			this.errorLine(
				"current model does not support image input; switch to a vision-capable model before pasting an image",
			);
			return;
		}
		// pie: mod.rs:1047-1055.
		if (this.pendingPastedImages.length + this.pendingImages.length >= MAX_IMAGES_PER_MESSAGE) {
			this.errorLine(`image attachment limit reached (max ${MAX_IMAGES_PER_MESSAGE} per message)`);
			return;
		}
		const size = humanBytes(image.encodedBytes);
		const index = this.pendingPastedImages.length + 1;
		const label = `attached clipboard image #${index} (${image.width}x${image.height}, ${size}); it will be sent with your next prompt`;
		this.pendingPastedImages.push(image.image);
		this.systemLine(label);
	}

	/** pie: mod.rs:1067-1069 (`current_model_accepts_images`). */
	currentModelAcceptsImages(): boolean {
		return this.kernel.currentModelAcceptsImages();
	}

	/**
	 * pie: mod.rs:1071-1080 (`validate_pending_image_support`) — refuses WITHOUT dropping the
	 * attachments, so switching model and re-sending works.
	 */
	validatePendingImageSupport(): boolean {
		const count = this.pendingImages.length + this.pendingPastedImages.length;
		if (count === 0 || this.currentModelAcceptsImages()) return true;
		this.errorLine(
			`current model does not support image input; switch to a vision-capable model before sending ${count} image attachment(s)`,
		);
		return false;
	}

	/** pie: mod.rs:1082-1088 (`queue_user_prompt`). */
	queueUserPrompt(display: string, prompt: string, images: ImageContent[]): void {
		this.enqueueTurn({ kind: "user_prompt", display, prompt, images });
	}

	/** pie: mod.rs:1090-1097 (`enqueue_turn`). */
	enqueueTurn(job: QueuedTurn): void {
		const text = queuePreview(queuedTurnDisplay(job));
		this.queuedTurns.push(job);
		this.systemLine(`queued next message #${this.queuedTurns.length}: ${text}`);
	}

	/** pie: mod.rs:1099-1106 (`cancel_last_queued_turn`) — LIFO, and never touches the live turn. */
	cancelLastQueuedTurn(): void {
		const job = this.queuedTurns.pop();
		if (job === undefined) {
			this.systemLine("queue is empty");
			return;
		}
		this.systemLine(`removed queued message: ${queuePreview(queuedTurnDisplay(job))}`);
	}

	/** pie: mod.rs:1108-1152 (`start_next_queued_turn`) — FIFO. */
	startNextQueuedTurn(turn: TurnState): boolean {
		if (turn.fut !== undefined) return true;
		const job = this.queuedTurns.shift();
		if (job === undefined) return false;
		const remaining = this.queuedTurns.length;
		this.systemLine(
			remaining === 0 ? "running queued message" : `running queued message (${remaining} still queued)`,
		);
		this.feed.pushUser(job.display);
		switch (job.kind) {
			case "user_prompt":
				this.startUserPromptTurn(job.prompt, job.images, turn);
				break;
			case "agent_prompt":
				this.startPromptTurn(job.prompt, job.errorContext, turn);
				break;
			case "prompt_template":
				this.startTemplateTurn(job.name, job.vars, turn);
				break;
			case "compaction":
				this.startCompactionTurn(job.custom, turn);
				break;
		}
		return true;
	}

	/** pie: mod.rs:1154-1156 (`refresh_goal_state`). */
	async refreshGoalState(): Promise<void> {
		this.latestGoal = await goal.current(this.kernel.harness());
	}

	/** pie: mod.rs:1158-1238 (`dispatch_slash`). */
	async dispatchSlash(input: string, driver: TerminalDriver, turn: TurnState): Promise<void> {
		const outcome: CommandOutcome = await dispatch(input, this.registry, {
			harness: this.kernel.harness(),
			sessionId: this.sessionId,
			logPath: this.logPath,
			toolCount: this.toolCount,
			cwd: this.cwd,
		});
		switch (outcome.kind) {
			case "quit":
				this.quit = true;
				break;
			// pie: mod.rs:1176-1179.
			case "clear_screen":
				this.feed.clear();
				this.follow = true;
				break;
			case "error":
				this.errorLine(outcome.message);
				break;
			case "attach_skill":
				this.pendingSkill = outcome.name;
				break;
			// pie: mod.rs:1184-1219 — every runnable outcome queues instead of racing the live turn.
			case "run_agent_prompt":
				if (turn.fut !== undefined) {
					this.enqueueTurn({
						kind: "agent_prompt",
						display: input,
						prompt: outcome.prompt,
						errorContext: outcome.errorContext,
					});
				} else {
					this.startPromptTurn(outcome.prompt, outcome.errorContext, turn);
				}
				break;
			case "run_prompt_template":
				if (turn.fut !== undefined) {
					this.enqueueTurn({ kind: "prompt_template", display: input, name: outcome.name, vars: outcome.vars });
				} else {
					this.startTemplateTurn(outcome.name, outcome.vars, turn);
				}
				break;
			case "run_compaction":
				if (turn.fut !== undefined) {
					this.enqueueTurn({ kind: "compaction", display: input, custom: outcome.custom });
				} else {
					this.startCompactionTurn(outcome.custom, turn);
				}
				break;
			case "web_relay":
				await this.handleWebRelay(outcome.action);
				break;
			case "session_import_activation":
				this.promptImportActivation(outcome.sessionPath, outcome.triggerIds, outcome.cronIds);
				break;
			// pie: mod.rs:1224-1232 — `recovery_command` is deliberately unused on the TUI path.
			case "login_secret":
				await this.login(outcome.provider, outcome.storageKey, driver);
				break;
			case "open_model_picker":
				this.openModelPicker();
				break;
			case "handled":
				break;
		}
		// pie: mod.rs:1235-1237 — `/goal` mutates panel state, so re-read it after any `/goal*`.
		if (input.trimStart().startsWith("/goal")) {
			await this.refreshGoalState();
		}
	}

	/** pie: mod.rs:1241-1251 (`start_prompt_turn`). */
	startPromptTurn(prompt: string, errorContext: string, turn: TurnState): void {
		turn.fut = this.kernel.promptTurn(prompt);
		turn.aborted = false;
		turn.prefix = errorContext;
		this.busy = true;
	}

	/** pie: mod.rs:1253-1263 (`start_user_prompt_turn`). */
	startUserPromptTurn(promptText: string, loadedImages: ImageContent[], turn: TurnState): void {
		turn.fut = this.kernel.userPromptTurn(promptText, loadedImages);
		turn.aborted = false;
		turn.prefix = "";
		this.busy = true;
	}

	/** pie: mod.rs:1265-1275 (`start_template_turn`). */
	startTemplateTurn(name: string, vars: Record<string, unknown>, turn: TurnState): void {
		turn.fut = this.kernel.templateTurn(name, vars);
		turn.aborted = false;
		turn.prefix = "template run failed: ";
		this.busy = true;
	}

	/** pie: mod.rs:1277-1282 (`start_compaction_turn`). */
	startCompactionTurn(custom: string | undefined, turn: TurnState): void {
		turn.fut = this.kernel.compactionTurn(custom);
		turn.aborted = false;
		turn.prefix = "compaction failed: ";
		this.busy = true;
	}

	/**
	 * pie: mod.rs:1284-1309 (`login`). "rpassword needs a cooked terminal with echo control, so drop
	 * out of the full-screen UI for the prompt, then restore."
	 */
	async login(provider: string, storageKey: string | undefined, driver: TerminalDriver): Promise<void> {
		driver.leave();
		let token: string;
		try {
			token = await this.promptForApiKey(provider);
		} catch (error) {
			// pie: mod.rs:1290-1291 — restore the UI BEFORE reporting, on every path.
			driver.enter();
			driver.clear();
			this.errorLine(errorText(error));
			return;
		}
		driver.enter();
		driver.clear();
		// pie: mod.rs:1293-1295.
		if (token.trim() === "") {
			this.errorLine("empty api key; login cancelled");
			return;
		}
		try {
			// pie: mod.rs:1297-1303 — the storage key falls back to the provider name.
			const path = saveApiKey(storageKey ?? provider, token);
			this.systemLine(`saved api key for \`${provider}\` to ${path}`);
		} catch (error) {
			this.errorLine(errorText(error));
		}
	}

	/** pie: main.rs:1138-1149 (`prompt_for_api_key`) — a no-echo read, refused outside a TTY. */
	private async promptForApiKey(provider: string): Promise<string> {
		if (this.config.promptForApiKey !== undefined) return this.config.promptForApiKey(provider);
		// pie: main.rs:1141-1143.
		if (process.stdin.isTTY !== true) throw new Error(loginRequiresTtyMessage(provider));
		// TODO(port): `rpassword::prompt_password` has no Node counterpart; this is the raw-mode
		// equivalent (echo suppressed by never writing the typed bytes back).
		return readPasswordFromTty(`api key for \`${provider}\`: `);
	}

	/** pie: mod.rs:1311-1317 (`request_abort`). */
	requestAbort(turn: TurnState): void {
		if (turn.fut === undefined) return;
		turn.aborted = true;
		this.kernel.abort();
		this.systemLine("aborting current turn…");
	}

	/** pie: mod.rs:1319-1326 (`handle_ctrl_d`) — Ctrl-D during work aborts, it does not exit. */
	handleCtrlD(turn: TurnState): boolean {
		if (turn.fut === undefined) return false;
		this.requestAbort(turn);
		return true;
	}

	/** pie: mod.rs:1328-1341 (`on_idle_ctrlc`) — the 1.5s double-tap window. */
	onIdleCtrlc(now: number = Date.now()): boolean {
		if (this.lastCtrlc !== undefined && now - this.lastCtrlc < IDLE_CTRLC_WINDOW_MS) return true;
		this.lastCtrlc = now;
		this.systemLine("press Ctrl-C again within 1.5s to exit, or type /quit");
		return false;
	}

	/* ── input helpers — pie: mod.rs:1344-1463 ──────────────────────────────────────────────── */

	/** pie: mod.rs:1344-1346 (`input_text`). */
	inputText(): string {
		return this.input.text();
	}

	/** pie: mod.rs:1348-1350 (`input_is_single_line`). */
	inputIsSingleLine(): boolean {
		return this.input.isSingleLine();
	}

	/** pie: mod.rs:1352-1356 (`clear_input`). */
	clearInput(): void {
		this.input = newInputArea();
		this.completions = [];
		this.completionIdx = 0;
	}

	/** pie: mod.rs:1358-1363 (`set_input`). */
	setInput(text: string): void {
		const input = newInputArea();
		input.insertStr(text);
		this.input = input;
		this.refreshCompletions();
	}

	/**
	 * pie: mod.rs:1365-1376 (`refresh_completions`) — the completer is rebuilt on every keystroke so
	 * a hot skill reload shows up without a restart.
	 */
	refreshCompletions(): void {
		this.completer = SlashCompleter.fromRegistryAndSkills(
			this.registry.commands(),
			completerSkills(this.kernel.harness()),
		);
		this.completions = this.inputIsSingleLine() ? this.completer.matches(this.inputText()) : [];
		this.completionIdx = 0;
	}

	/** pie: mod.rs:1378-1396 (`cycle_completion`). */
	cycleCompletion(): void {
		if (this.completions.length === 0) return;
		const options = [...this.completions];
		const pick = this.completions[this.completionIdx % this.completions.length];
		this.completionIdx = (this.completionIdx + 1) % this.completions.length;
		// pie: mod.rs:1385-1388 — replace just the slash token (the whole single-line input here).
		const input = newInputArea();
		input.insertStr(pick);
		this.input = input;
		if (options.length > 1) {
			// pie: mod.rs:1390-1392 — keep the candidate set so repeated Tab cycles the visible list.
			this.completions = options;
		} else {
			this.completions = [];
			this.completionIdx = 0;
		}
	}

	/** pie: mod.rs:1398-1414 (`history_prev`). */
	historyPrev(): void {
		const entries = this.history.entries();
		if (entries.length === 0) return;
		let idx: number;
		if (this.historyIdx === undefined) {
			// pie: mod.rs:1404-1407 — the in-progress line is stashed on first Up.
			this.draft = this.inputText();
			idx = entries.length - 1;
		} else {
			idx = this.historyIdx === 0 ? 0 : this.historyIdx - 1;
		}
		this.historyIdx = idx;
		this.setInput(entries[idx]);
	}

	/** pie: mod.rs:1416-1430 (`history_next`) — walking past the newest entry restores the draft. */
	historyNext(): void {
		const idx = this.historyIdx;
		if (idx === undefined) return;
		const entries = this.history.entries();
		if (idx + 1 < entries.length) {
			this.historyIdx = idx + 1;
			this.setInput(entries[idx + 1]);
		} else {
			this.historyIdx = undefined;
			this.setInput(this.draft);
		}
	}

	/** pie: mod.rs:1432-1435 (`scroll_up`) — scrolling up always breaks follow. */
	scrollUp(n: number): void {
		this.follow = false;
		this.scroll = Math.max(0, this.scroll - n);
	}

	/** pie: mod.rs:1437-1440 (`scroll_down`) — "render() clamps and re-enables follow at the bottom". */
	scrollDown(n: number): void {
		this.scroll = this.scroll + n;
	}

	/** pie: mod.rs:1442-1451 (`handle_mouse_scroll`). */
	handleMouseScroll(column: number, row: number, up: boolean): void {
		if (!this.mouseInFeed(column, row)) return;
		if (up) this.scrollUp(SCROLL_STEP);
		else this.scrollDown(SCROLL_STEP);
	}

	/** pie: mod.rs:1453-1463 (`mouse_in_feed`). */
	mouseInFeed(column: number, row: number): boolean {
		const area = this.lastFeedArea;
		if (area === undefined) return false;
		return column >= area.x && column < area.x + area.width && row >= area.y && row < area.y + area.height;
	}

	/* ── rendering — delegates to ./app-render.ts ───────────────────────────────────────────── */

	/** pie: mod.rs:1465-1564 (`render`). */
	render(area: Rect): Frame {
		return renderFrame(this, this, area);
	}

	/** pie: mod.rs:1670-1678. */
	shouldShowSidePanel(): boolean {
		return shouldShowSidePanel(this);
	}

	/** pie: mod.rs:1680-1932. */
	triggerPanelLines(width: number, height: number): FeedLine[] {
		return triggerPanelLines(this, width, height);
	}

	/** pie: mod.rs:1934-1965. */
	statusLine(width: number): string {
		return statusLineText(this, width);
	}

	// ── the `RenderSource` reads ────────────────────────────────────────────────────────────
	skills(): readonly RenderSkill[] {
		return this.kernel.harness().skills();
	}

	modelSpec(): string | undefined {
		const model = this.kernel.harness().getModel();
		return model === undefined ? undefined : `${model.provider}:${model.id}`;
	}

	inputLines(): readonly string[] {
		return this.input.lines();
	}

	/** pie: mod.rs:2172 (`prompt_display`) — a member so `./web.ts` need not re-implement it. */
	promptDisplay(text: string, imageCount: number): string {
		return promptDisplay(text, imageCount);
	}

	/* ── non-interactive fallback — pie: mod.rs:2011-2113 ───────────────────────────────────── */

	/**
	 * pie: mod.rs:2011-2113 (`run_headless`). "Line-based fallback for non-TTY stdin/stdout (e.g.
	 * `echo prompt | pie`). No fixed input box — just read prompts from stdin and stream feed updates
	 * to stdout." RULEBOOK §1 sanctions `console.*` on this path; the sink is injectable so tests
	 * capture it instead.
	 */
	async runHeadless(): Promise<void> {
		const out: HeadlessOut = this.config.out ?? { write: (text) => void process.stdout.write(text) };
		// pie: every diagnostic in `run_headless` is an `eprintln!` (mod.rs:2047, 2050-2057, 2063,
		// 2076, 2083, 2087, 2110) while the feed printer and the three status lines are `println!`.
		// The two sinks are therefore distinct here as well — folding them into stdout put oracle's
		// stderr text on the wrong stream.
		const errOut: HeadlessOut = this.config.errOut ?? { write: (text) => void process.stderr.write(text) };
		// pie: mod.rs:2016-2021 — flush the startup feed (banner/diagnostics) first.
		for (const line of this.feed.lines(100)) {
			out.write(`${line.text}\n`);
		}
		// pie: mod.rs:2022-2028 — a background printer drains feed updates to stdout.
		const cursor: HeadlessCursor = { atLineStart: true };
		const printer = (async () => {
			for (;;) {
				const update = await this.feedRx.next();
				if (update === undefined) return;
				printHeadlessUpdate(update, cursor, out);
			}
		})();
		// The detached printer must not surface its own rejection: oracle's `tokio::spawn`ed loop
		// simply ends when the channel closes.
		void printer.catch(() => {});

		try {
			for await (const line of this.readStdinLines()) {
				const input = line.trim();
				// pie: mod.rs:2033-2035.
				if (input === "") continue;
				if (input.startsWith("/")) {
					const outcome = await dispatch(input, this.registry, {
						harness: this.kernel.harness(),
						sessionId: this.sessionId,
						logPath: this.logPath,
						toolCount: this.toolCount,
						cwd: this.cwd,
					});
					if (await this.handleHeadlessOutcome(outcome, out, errOut)) return;
					continue;
				}
				// pie: mod.rs:2106-2111 — no skill attachment on this path (`None`).
				const expanded = (await expandMentions(input, this.cwd)).prompt;
				const prompt = attachSkillPrompt(expanded, undefined);
				try {
					await this.kernel.userPromptTurn(prompt, []);
				} catch (error) {
					// pie: mod.rs:2110 — `eprintln!`, i.e. stderr.
					errOut.write(`error: ${errorText(error)}\n`);
				}
			}
		} finally {
			this.feedRx.close();
		}
	}

	/**
	 * pie: mod.rs:2043-2102 — the headless arm of each `CommandOutcome`. True means "break".
	 *
	 * `out` is oracle's `println!` (stdout), `errOut` its `eprintln!` (stderr); the split is
	 * per-arm and follows oracle's macro choice exactly.
	 */
	private async handleHeadlessOutcome(
		outcome: CommandOutcome,
		out: HeadlessOut,
		errOut: HeadlessOut,
	): Promise<boolean> {
		switch (outcome.kind) {
			// pie: mod.rs:2044.
			case "quit":
				return true;
			// pie: mod.rs:2045.
			case "error":
				errOut.write(`error: ${outcome.message}\n`);
				return false;
			// pie: mod.rs:2046-2058.
			case "login_secret":
				errOut.write(`error: ${loginRequiresTtyMessage(outcome.provider, outcome.recoveryCommand)}\n`);
				return false;
			// pie: mod.rs:2059-2066.
			case "run_agent_prompt":
				try {
					await this.kernel.harness().prompt(outcome.prompt);
				} catch (error) {
					errOut.write(`error: ${outcome.errorContext}${errorText(error)}\n`);
				}
				return false;
			// pie: mod.rs:2067-2077.
			case "run_prompt_template":
				try {
					await this.kernel.templateTurn(outcome.name, outcome.vars);
				} catch (error) {
					errOut.write(`error: template run failed: ${errorText(error)}\n`);
				}
				return false;
			// pie: mod.rs:2078-2084 — the two status strings come from `compaction_turn`.
			case "run_compaction":
				try {
					const status = await this.kernel.compactionTurn(outcome.custom);
					if (status !== undefined) out.write(`${status}\n`);
				} catch (error) {
					errOut.write(`error: compaction failed: ${errorText(error)}\n`);
				}
				return false;
			// pie: mod.rs:2085-2087.
			case "web_relay":
				errOut.write("error: /web-connect requires the interactive TUI or --web mode\n");
				return false;
			// pie: mod.rs:2088-2092.
			case "session_import_activation":
				out.write(
					"imported automation left disabled (no interactive confirm in this mode); re-import with `pie session import --activate-triggers=on` or enable via /triggers enable and /cron enable\n",
				);
				return false;
			// pie: mod.rs:2093-2101.
			case "open_model_picker": {
				const model = this.kernel.harness().getModel();
				out.write(model === undefined ? "(no model active)\n" : `active model: ${model.provider}:${model.id}\n`);
				out.write("interactive picker needs the TUI; use /model <provider:model-id> or /model list\n");
				return false;
			}
			// pie: mod.rs:2102 — `_ => {}` swallows Handled / ClearScreen / AttachSkill.
			default:
				return false;
		}
	}

	/** pie: mod.rs:2030-2031 (`BufReader::new(tokio::io::stdin()).lines()`). */
	private readStdinLines(): AsyncIterable<string> {
		if (this.config.stdinLines !== undefined) return this.config.stdinLines();
		return stdinLines();
	}
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Loop plumbing.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

type LoopBranch =
	| "turn"
	| "event"
	| "feed"
	| "main_run"
	| "relay_prompt"
	| "relay_abort"
	| "relay_resolve"
	| "relay_model"
	| "control_plane"
	| "tick";

type LoopEvent =
	| { branch: "turn"; result: TurnResult }
	| { branch: "event"; event: TuiEvent | undefined }
	| { branch: "feed"; update: FeedUpdate | undefined }
	| { branch: "main_run"; traceId: string | undefined }
	| { branch: "relay_prompt"; text: string | undefined }
	| { branch: "relay_abort"; closed: boolean }
	| { branch: "relay_resolve"; approve: boolean | undefined }
	| { branch: "relay_model"; spec: string | undefined }
	| { branch: "control_plane"; prompt: UiControlPlanePrompt | undefined }
	| { branch: "tick" };

function queueCase<T>(queue: AsyncQueue<T>, wrap: (value: T | undefined) => LoopEvent): SelectCase<LoopEvent> {
	return { run: (signal) => queue.next(signal).then(wrap) };
}

/**
 * pie: mod.rs:445-449 (`tokio::time::interval`). RULEBOOK §2.2's `tokio::time::timeout` row: the
 * timer is driven by an `AbortSignal` and cleared when this branch loses the race, so no stray
 * `setTimeout` survives an iteration.
 */
function tickCase(ms: number): SelectCase<LoopEvent> {
	return {
		run: async (loserSignal): Promise<LoopEvent> => {
			try {
				await sleep(ms, loserSignal);
			} catch {
				// Lost the race: `sleep` rejected on the loser signal after clearing its timer.
			}
			return { branch: "tick" };
		},
	};
}

/**
 * `harness.skills()` yields `CommandSkill` (no `content`), while `SlashCompleter` takes the
 * `@pie/agent-core` `Skill`. Only `name` and `disableModelInvocation` are read
 * (`readline.ts:96-108`), so the missing field is supplied as the empty string rather than widening
 * the completer's parameter — deliberately keeping SKILL.md bodies out of every path that could
 * echo them (`core/slash-dispatch-deps.ts:28-31`).
 */
function completerSkills(harness: AppHarness): {
	name: string;
	description: string;
	content: string;
	filePath: string;
	disableModelInvocation: boolean;
}[] {
	return harness.skills().map((skill) => ({
		name: skill.name,
		description: skill.description,
		content: "",
		filePath: skill.filePath,
		disableModelInvocation: skill.disableModelInvocation,
	}));
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** `BufReader::new(tokio::io::stdin()).lines()`. */
async function* stdinLines(): AsyncIterable<string> {
	const readline = await import("node:readline");
	const rl = readline.createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
	try {
		for await (const line of rl) yield line;
	} finally {
		rl.close();
	}
}

/** `rpassword::prompt_password` — raw mode, echo suppressed by never writing the bytes back. */
function readPasswordFromTty(prompt: string): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const stdin = process.stdin;
		process.stdout.write(prompt);
		const wasRaw = stdin.isRaw === true;
		stdin.setRawMode(true);
		stdin.resume();
		stdin.setEncoding("utf8");
		let buffer = "";
		const finish = (value: string | undefined, error?: unknown): void => {
			stdin.removeListener("data", onData);
			stdin.setRawMode(wasRaw);
			stdin.pause();
			process.stdout.write("\n");
			if (error !== undefined) reject(error);
			else resolve(value ?? "");
		};
		const onData = (chunk: string): void => {
			for (const char of chunk) {
				if (char === "\r" || char === "\n") {
					finish(buffer);
					return;
				}
				// Ctrl-C (0x03) / Ctrl-D (0x04) cancel the prompt, as rpassword's does.
				if (char === "" || char === "") {
					finish(undefined, new Error("login cancelled"));
					return;
				}
				if (char === "" || char === "\b") buffer = buffer.slice(0, -1);
				else buffer += char;
			}
		};
		stdin.on("data", onData);
	});
}
