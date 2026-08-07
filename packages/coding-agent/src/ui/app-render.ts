/**
 * The rendering half of oracle `crates/coding-agent/src/ui/mod.rs` (pie @0a120dfd):
 * `render` / `render_model_picker` / `render_control_plane_prompt` / `render_trigger_panel` /
 * `should_show_side_panel` / `trigger_panel_lines` / `status_line` / `render_completions`
 * (:1465-2009) plus `panel_line` / `centered_rect` (:2117-2133).
 *
 * ## The one structural deviation in this unit
 *
 * Oracle paints through `ratatui`. RULEBOOK §1 admits no new dependency and there is no ratatui in
 * the TS ecosystem this repo targets, so the port keeps the layer that carries **behavior** —
 * layout arithmetic (which decides `last_feed_area`, `last_viewport_h`, the scroll clamp and the
 * side-panel threshold), the section/ordering/colour rules and every user-visible string — and
 * stops at the layer that carries **pixels**. `renderFrame` returns a {@link Frame}: the same rows
 * ratatui would have received, already wrapped to width and positioned, as `FeedLine[]` (the
 * `ratatui::text::Line` stand-in `./feed.ts` established for this port).
 *
 * A terminal writer that paints a `Frame` is the remaining adapter. It is deliberately not written
 * here: nothing in it is oracle behavior, and the TS front-end that will consume it (pi's component
 * tree vs. the phase-14 line-flow `src/tui.ts`) is a phase-16 integration decision.
 * TODO(port): terminal painter for {@link Frame}.
 */

import type { GoalState } from "../goal.ts";
import { defaultInboxPath, newCount } from "../inbox.ts";
import type { ModelPickerState } from "../model-picker.ts";
import type { SkillSource } from "../skills-state.ts";
import { globalCronRegistry, globalRegistry } from "../triggers/index.ts";
import {
	COMPLETION_POPUP_MAX,
	CONTROL_PROMPT_TEXT_WIDTH,
	MAX_INPUT_ROWS,
	panelRulePreview,
	SPINNER_FRAMES,
	safeControlPromptLabel,
	safeControlPromptPayload,
	safeControlPromptText,
	TRIGGER_PANEL_MIN_TOTAL_WIDTH,
	TRIGGER_PANEL_RULE_LIMIT,
	TRIGGER_PANEL_WIDTH,
} from "./app-text.ts";
import { type Feed, type FeedColor, type FeedLine, type FeedStyle, strWidth, truncateChars } from "./feed.ts";

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Geometry — the `ratatui::layout` slice this unit uses.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/** `ratatui::layout::Rect`. Cells, not pixels; `u16` in oracle, so every field is a non-negative
 * integer here and every subtraction below saturates at 0 exactly as `saturating_sub` does. */
export interface Rect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/** Rust `u16::saturating_sub`. */
function satSub(a: number, b: number): number {
	return Math.max(0, a - b);
}

/** Rust `Ord::clamp` on `u16`. */
function clamp(value: number, low: number, high: number): number {
	return Math.min(Math.max(value, low), high);
}

/** pie: mod.rs:2124-2133 (`centered_rect`). */
export function centeredRect(area: Rect, width: number, height: number): Rect {
	const w = Math.min(width, area.width);
	const h = Math.min(height, area.height);
	return {
		// pie: mod.rs:2128-2129 — integer division, so an odd remainder biases up/left.
		x: area.x + Math.floor(satSub(area.width, w) / 2),
		y: area.y + Math.floor(satSub(area.height, h) / 2),
		width: w,
		height: h,
	};
}

/**
 * pie: mod.rs:1468-1476 — `Layout::vertical([Min(1), Length(1), Length(input_rows + 2),
 * Length(1)])`. ratatui satisfies the fixed `Length`s and gives the rest to the single `Min`, which
 * is what pins the input box to the bottom edge. Reproduced directly rather than via a general
 * constraint solver: this is the only layout in the file, and a general solver would be a second
 * thing to keep faithful.
 */
export interface FrameLayout {
	readonly content: Rect;
	readonly status: Rect;
	readonly input: Rect;
	readonly hint: Rect;
}

export function verticalLayout(area: Rect, inputRows: number): FrameLayout {
	// pie: mod.rs:1471 — `input_rows + 2` (the box borders).
	const inputHeight = inputRows + 2;
	// Fixed rows are honoured first, then clipped against what the terminal actually has.
	const hintHeight = Math.min(1, area.height);
	const inputH = Math.min(inputHeight, satSub(area.height, hintHeight));
	const statusHeight = Math.min(1, satSub(area.height, hintHeight + inputH));
	const contentHeight = satSub(area.height, hintHeight + inputH + statusHeight);
	let y = area.y;
	const content = { x: area.x, y, width: area.width, height: contentHeight };
	y += contentHeight;
	const status = { x: area.x, y, width: area.width, height: statusHeight };
	y += statusHeight;
	const input = { x: area.x, y, width: area.width, height: inputH };
	y += inputH;
	const hint = { x: area.x, y, width: area.width, height: hintHeight };
	return { content, status, input, hint };
}

/**
 * pie: mod.rs:1479-1490 — the content row splits into feed + automation rail only when the terminal
 * is at least {@link TRIGGER_PANEL_MIN_TOTAL_WIDTH} wide **and** the rail has something to show.
 * `Layout::horizontal([Min(40), Length(TRIGGER_PANEL_WIDTH)])`.
 */
export function splitContent(content: Rect, showSidePanel: boolean): { feed: Rect; trigger?: Rect } {
	// pie: mod.rs:1479-1481.
	if (content.width < TRIGGER_PANEL_MIN_TOTAL_WIDTH || !showSidePanel) {
		return { feed: content };
	}
	const panelWidth = Math.min(TRIGGER_PANEL_WIDTH, satSub(content.width, 40));
	const feedWidth = satSub(content.width, panelWidth);
	return {
		feed: { x: content.x, y: content.y, width: feedWidth, height: content.height },
		trigger: { x: content.x + feedWidth, y: content.y, width: panelWidth, height: content.height },
	};
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Line helpers.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/** `Line::raw("")` — ratatui's unstyled blank row. */
const BLANK: FeedLine = { text: "", style: {} };

/** `Line::raw(text)`. */
function raw(text: string): FeedLine {
	return { text, style: {} };
}

/** `Line::styled(text, Style::default().fg(color))`. */
function styled(text: string, fg: FeedColor): FeedLine {
	return { text, style: { fg } };
}

/**
 * pie: mod.rs:2117-2122 (`panel_line`). Every rail row is truncated to the rail width before it is
 * handed to ratatui, so the rail can never bleed into the feed.
 *
 * `Color::Reset` (mod.rs:1821, the blank row after the inbox banner) has no `FeedColor` spelling;
 * it *is* ratatui's default foreground, so it maps to an absent `fg` — indistinguishable on the
 * blank string that is its only oracle call site.
 */
export function panelLine(text: string, color: FeedColor | "reset", width: number): FeedLine {
	const truncated = truncateChars(text, Math.max(width, 1));
	const style: FeedStyle = color === "reset" ? {} : { fg: color };
	return { text: truncated, style };
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * The `App` slice this unit reads.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/** The skill fields the rail counts (`harness.skills()` rows). */
export interface RenderSkill {
	readonly disableModelInvocation: boolean;
	readonly source: SkillSource;
}

/**
 * pie: mod.rs:82-99 (`struct PanelStatus`) — the subset the rail reads, declared structurally so
 * this module does not import `./index.ts` (which imports *it*). Field names follow `./web.ts`'s
 * `PanelStatus`, the single declaration this repo already had; a real `PanelStatus` is assignable.
 */
export interface RenderPanelStatus {
	readonly mcp_servers: number;
	readonly mcp_tools: number;
	readonly mcp_notification_hooks: number;
	readonly hook_points: readonly string[];
	readonly trigger_features: readonly string[];
}

/** The control-plane request fields the confirm card shows. */
export interface RenderPromptRequest {
	readonly toolName: string;
	readonly argsHash: string;
	readonly label: string;
	readonly payload: unknown;
	readonly reason: string;
}

/** The `App` fields `render` and its helpers touch. */
export interface RenderSource {
	readonly feed: Feed;
	readonly panelStatus: RenderPanelStatus;
	readonly latestTriggerPoll?: {
		readonly checked_at: string;
		readonly trace_id: string;
		readonly source_label: string;
		readonly event_label: string;
		readonly summary: string;
	};
	readonly latestGoal?: GoalState;
	readonly modelPicker?: ModelPickerState;
	readonly controlPlanePrompt?: { readonly request: RenderPromptRequest };
	readonly completions: readonly string[];
	readonly completionIdx: number;
	readonly queuedTurns: readonly unknown[];
	readonly busy: boolean;
	readonly spinnerFrame: number;
	readonly follow: boolean;
	skills(): readonly RenderSkill[];
	/** `harness.agent().state().model` rendered as `provider:id`, or `undefined` when unset. */
	modelSpec(): string | undefined;
	/** The input textarea's rows. */
	inputLines(): readonly string[];
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Automation rail — pie: mod.rs:1670-1932.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * pie: mod.rs:1670-1678 (`should_show_side_panel`). Reads the *global* trigger/cron registries, as
 * oracle does — the rail reflects process state, not `App` state.
 */
export function shouldShowSidePanel(app: RenderSource): boolean {
	return (
		app.skills().length > 0 ||
		globalRegistry().list().length > 0 ||
		globalCronRegistry().list().length > 0 ||
		app.latestTriggerPoll !== undefined ||
		app.latestGoal !== undefined ||
		app.panelStatus.mcp_servers > 0 ||
		app.panelStatus.mcp_notification_hooks > 0
	);
}

/** pie: mod.rs:1680-1932 (`trigger_panel_lines`). Section order is oracle's and load-bearing. */
export function triggerPanelLines(app: RenderSource, rawWidth: number, height: number): FeedLine[] {
	// pie: mod.rs:1681.
	const width = Math.max(rawWidth, 1);
	const rules = globalRegistry().list();
	const cronJobs = globalCronRegistry().list();
	const lines: FeedLine[] = [];

	// ── Skills — pie: mod.rs:1686-1717.
	const skills = app.skills();
	lines.push(panelLine("Skills", "cyan", width));
	if (skills.length === 0) {
		lines.push(panelLine("none", "darkGray", width));
	} else {
		const disabled = skills.filter((skill) => skill.disableModelInvocation).length;
		const enabled = satSub(skills.length, disabled);
		lines.push(panelLine(`enabled ${enabled} · disabled ${disabled}`, disabled === 0 ? "green" : "yellow", width));
		const sourceCount = (source: SkillSource): number => skills.filter((skill) => skill.source === source).length;
		lines.push(
			panelLine(
				`builtin ${sourceCount("builtin")} · user ${sourceCount("user")} · project ${sourceCount("project")}`,
				"darkGray",
				width,
			),
		);
	}

	// ── Triggers — pie: mod.rs:1719-1756.
	lines.push(BLANK);
	lines.push(panelLine("Triggers", "cyan", width));
	if (rules.length === 0) {
		lines.push(panelLine("none", "darkGray", width));
	} else {
		for (const rule of rules.slice(0, TRIGGER_PANEL_RULE_LIMIT)) {
			const stateFlag = rule.enabled ? "enabled" : "disabled";
			const mode = rule.fire_once ? "once" : "repeat";
			const id = truncateChars(rule.id, 12);
			const color: FeedColor = rule.enabled ? "green" : "darkGray";
			lines.push(panelLine(`${id} [${stateFlag}, ${mode}]`, color, width));
			lines.push(panelLine(`  when ${panelRulePreview(rule.condition, width)}`, "darkGray", width));
			lines.push(panelLine(`  do   ${panelRulePreview(rule.action, width)}`, "darkGray", width));
		}
		if (rules.length > TRIGGER_PANEL_RULE_LIMIT) {
			lines.push(panelLine(`… ${rules.length - TRIGGER_PANEL_RULE_LIMIT} more`, "darkGray", width));
		}
	}

	// ── Polling — pie: mod.rs:1758-1783.
	const status = app.latestTriggerPoll;
	if (status !== undefined) {
		lines.push(BLANK);
		lines.push(panelLine("Polling", "cyan", width));
		lines.push(panelLine(`${status.checked_at} · no match`, "yellow", width));
		lines.push(
			panelLine(
				`${panelRulePreview(status.source_label, width)} / ${panelRulePreview(status.event_label, width)}`,
				"darkGray",
				width,
			),
		);
		lines.push(panelLine(`trace ${panelRulePreview(status.trace_id, width)}`, "darkGray", width));
		lines.push(panelLine(`  ${panelRulePreview(status.summary, width)}`, "darkGray", width));
	}

	// ── Goal — pie: mod.rs:1785-1815.
	const goal = app.latestGoal;
	if (goal !== undefined) {
		lines.push(BLANK);
		lines.push(panelLine("Goal", "cyan", width));
		// pie: mod.rs:1788-1795 — Paused / BudgetLimited / Cleared all render dark gray.
		const color: FeedColor =
			goal.status === "pursuing" ? "yellow" : goal.status === "achieved" ? "green" : "darkGray";
		lines.push(panelLine(goal.status, color, width));
		lines.push(panelLine(panelRulePreview(goal.condition, width), "darkGray", width));
		if (goal.iterations > 0) {
			lines.push(panelLine(`checks ${goal.iterations}`, "darkGray", width));
		}
		if (goal.last_reason !== undefined) {
			lines.push(panelLine(`  ${panelRulePreview(goal.last_reason, width)}`, "darkGray", width));
		}
	}

	// ── Inbox + Cron — pie: mod.rs:1817-1872.
	lines.push(BLANK);
	const inboxNew = newCount(defaultInboxPath());
	if (inboxNew > 0) {
		lines.push(panelLine(`Inbox  ${inboxNew} new — /inbox`, "yellow", width));
		// pie: mod.rs:1821 — `panel_line(String::new(), Color::Reset, width)`, not `Line::raw("")`.
		lines.push(panelLine("", "reset", width));
	}
	lines.push(panelLine("Cron (session)", "cyan", width));
	if (cronJobs.length === 0) {
		lines.push(panelLine("none", "darkGray", width));
	} else {
		const enabled = cronJobs.filter((job) => job.enabled).length;
		const disabled = satSub(cronJobs.length, enabled);
		lines.push(panelLine(`enabled ${enabled} · disabled ${disabled}`, disabled === 0 ? "green" : "yellow", width));
		for (const job of cronJobs.slice(0, TRIGGER_PANEL_RULE_LIMIT)) {
			const stateFlag = job.enabled ? "enabled" : "disabled";
			const id = truncateChars(job.id, 12);
			const color: FeedColor = job.enabled ? "green" : "darkGray";
			lines.push(panelLine(`${id} [${stateFlag}] ${job.schedule}`, color, width));
			lines.push(panelLine(`  do ${panelRulePreview(job.action, width)}`, "darkGray", width));
			if (job.skipped_overlap_count > 0) {
				lines.push(panelLine(`  skipped overlaps ${job.skipped_overlap_count}`, "yellow", width));
			}
		}
		if (cronJobs.length > TRIGGER_PANEL_RULE_LIMIT) {
			lines.push(panelLine(`… ${cronJobs.length - TRIGGER_PANEL_RULE_LIMIT} more`, "darkGray", width));
		}
	}

	// ── Bottom-pinned static status — pie: mod.rs:1874-1931.
	// Oracle reserves rows so MCP / Hooks / Runtime survive the rail clip in ordinary terminals.
	const hookRows = Math.max(app.panelStatus.hook_points.length, 1);
	const featureRows = Math.max(app.panelStatus.trigger_features.length, 1);
	const statusRows = 2 + 2 + 2 + hookRows + 2 + featureRows;
	while (lines.length + statusRows < height) {
		lines.push(BLANK);
	}

	lines.push(BLANK);
	lines.push(panelLine("MCP", "cyan", width));
	if (app.panelStatus.mcp_servers === 0) {
		lines.push(panelLine("none", "darkGray", width));
	} else {
		lines.push(
			panelLine(`servers ${app.panelStatus.mcp_servers} · tools ${app.panelStatus.mcp_tools}`, "green", width),
		);
		lines.push(panelLine(`notification hooks ${app.panelStatus.mcp_notification_hooks}`, "darkGray", width));
	}

	lines.push(BLANK);
	lines.push(panelLine("Hooks", "cyan", width));
	if (app.panelStatus.hook_points.length === 0) {
		lines.push(panelLine("none", "darkGray", width));
	} else {
		for (const point of app.panelStatus.hook_points) {
			lines.push(panelLine(`· ${point}`, "darkGray", width));
		}
	}

	lines.push(BLANK);
	lines.push(panelLine("Runtime", "cyan", width));
	if (app.panelStatus.trigger_features.length === 0) {
		lines.push(panelLine("none", "darkGray", width));
	} else {
		for (const feature of app.panelStatus.trigger_features) {
			lines.push(panelLine(`• ${feature}`, "darkGray", width));
		}
	}
	return lines;
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Status rule / hint — pie: mod.rs:1934-1965, 1546-1559.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * pie: mod.rs:1934-1965 (`status_line`). The label, then `─` padding out to the terminal width.
 * Oracle takes `max_scroll` and immediately `let _ = max_scroll;` — a parameter kept for a future
 * scrollbar, dropped here rather than carried as an unused argument.
 */
export function statusLineText(app: RenderSource, width: number): string {
	// pie: mod.rs:1935-1942 — no active model renders the literal `no-model`.
	const model = app.modelSpec() ?? "no-model";
	// pie: mod.rs:1943-1947.
	const queue = app.queuedTurns.length === 0 ? "" : ` · ${app.queuedTurns.length} queued`;
	// pie: mod.rs:1948-1956.
	const status = app.busy
		? `${SPINNER_FRAMES[app.spinnerFrame % SPINNER_FRAMES.length]} working (Ctrl-C aborts)${queue}`
		: `ready${queue}`;
	// pie: mod.rs:1957.
	const scrolled = app.follow ? "" : " ↑scrolled";
	const label = ` pie · ${model} · ${status}${scrolled} `;
	// pie: mod.rs:1960-1963 — pad by *display width*, not code points.
	const used = strWidth(label);
	return width > used ? label + "─".repeat(width - used) : label;
}

/** pie: mod.rs:1546-1553 — the hint row under the input box. */
export function hintText(busy: boolean, width: number): string {
	const hint = busy
		? "Enter queue next · Ctrl-V paste · Alt+Enter newline · Ctrl-C abort current · empty Ctrl-U removes queued"
		: "Enter send · Ctrl-V paste · Alt+Enter newline · ↑↓ history · Wheel/PgUp scroll · Ctrl-C abort";
	// pie: mod.rs:1556.
	return truncateChars(hint, width);
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Overlays — pie: mod.rs:1567-1653, 1967-2009.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/** One overlay: the rect ratatui would `Clear` plus the bordered block's rows. */
export interface Overlay {
	readonly rect: Rect;
	readonly title: string;
	readonly borderColor: FeedColor;
	readonly lines: readonly FeedLine[];
}

/** pie: mod.rs:1567-1603 (`render_model_picker`). */
export function modelPickerOverlay(picker: ModelPickerState, area: Rect): Overlay {
	// pie: mod.rs:1571-1574.
	const width = clamp(area.width, 40, 64);
	const height = clamp(area.height, 8, 18);
	const rect = centeredRect(area, width, height);
	// pie: mod.rs:1576 — "borders (2) + title line + blank + footer = 5 rows of chrome".
	const visible = Math.max(satSub(rect.height, 5), 1);
	const view = picker.view(visible);
	const lines: FeedLine[] = [styled(view.title, "yellow"), raw("")];
	for (const row of view.rows) {
		// pie: mod.rs:1582-1590.
		lines.push(row.selected ? styled(`❯ ${row.text}`, "cyan") : raw(`  ${row.text}`));
	}
	lines.push(styled("↑↓/jk navigate · Enter select · Esc back", "darkGray"));
	return { rect, title: " Select model ", borderColor: "cyan", lines };
}

/** pie: mod.rs:1604-1653 (`render_control_plane_prompt`). Every field is redacted + bounded. */
export function controlPlanePromptOverlay(request: RenderPromptRequest, area: Rect): Overlay {
	// pie: mod.rs:1609-1611.
	const width = clamp(area.width, 40, 78);
	const height = clamp(area.height, 8, 14);
	const rect = centeredRect(area, width, height);
	const lines: FeedLine[] = [
		styled("Control-plane approval required", "yellow"),
		raw(""),
		// pie: mod.rs:1617-1620.
		raw(`Action: ${safeControlPromptLabel(request.label)}`),
		// pie: mod.rs:1621-1624 — the tool name gets a wider cap than the reason.
		raw(`Tool: ${safeControlPromptText(request.toolName, 80)}`),
		raw(`Reason: ${safeControlPromptText(request.reason, CONTROL_PROMPT_TEXT_WIDTH)}`),
		// pie: mod.rs:1629-1632 — first 12 code points of the hash, unredacted (it is a hash).
		raw(`Args hash: ${[...request.argsHash].slice(0, 12).join("")}`),
		raw(`Preview: ${safeControlPromptPayload(request.payload, CONTROL_PROMPT_TEXT_WIDTH)}`),
		raw(""),
		styled("Enter/Y approve · N/D/Esc/Ctrl-C deny", "cyan"),
	];
	return { rect, title: " Confirm ", borderColor: "yellow", lines };
}

/** pie: mod.rs:1967-2009 (`render_completions`) — the popup drawn above the status rule. */
export function completionOverlay(app: RenderSource, area: Rect, statusArea: Rect): Overlay | undefined {
	// pie: mod.rs:1968-1970.
	if (app.completions.length === 0) {
		return undefined;
	}
	const shown = Math.min(app.completions.length, COMPLETION_POPUP_MAX);
	// pie: mod.rs:1972 — `shown + 2` for the borders.
	const height = shown + 2;
	const y = Math.max(satSub(statusArea.y, height), area.y);
	const width = clamp(area.width, 10, 60);
	const rect: Rect = { x: area.x, y, width, height };
	// pie: mod.rs:1987-1995 — the selected row inverts (black on cyan); `FeedStyle` carries no
	// background, so selection is surfaced through `Frame.completionSelected` instead of a style.
	const lines: FeedLine[] = app.completions.slice(0, shown).map((candidate) => styled(candidate, "cyan"));
	return { rect, title: "commands (Tab)", borderColor: "darkGray", lines };
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Frame assembly — pie: mod.rs:1465-1564.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/** What `render` would have painted. */
export interface Frame {
	readonly layout: FrameLayout;
	readonly feedArea: Rect;
	readonly triggerArea?: Rect;
	/** The feed, pre-wrapped to `feedArea.width` and sliced to the visible viewport. */
	readonly feedLines: readonly FeedLine[];
	/** Every feed row, before the viewport slice — what `scroll`/`max_scroll` are measured on. */
	readonly feedTotal: number;
	readonly maxScroll: number;
	readonly triggerLines?: readonly FeedLine[];
	readonly statusText: string;
	readonly inputRows: readonly string[];
	readonly hintText: string;
	readonly completions?: Overlay;
	/** Index (into `completions.lines`) of the highlighted row. */
	readonly completionSelected?: number;
	readonly modelPicker?: Overlay;
	readonly controlPlanePrompt?: Overlay;
}

/** The `&mut self` half of `render`: the fields it writes back before painting. */
export interface RenderCursor {
	scroll: number;
	follow: boolean;
	lastViewportH: number;
	lastFeedArea?: Rect;
}

/**
 * pie: mod.rs:1465-1564 (`render`). Runs oracle's layout, updates the scroll bookkeeping on
 * `cursor` (oracle's `&mut self` writes) and returns the rows.
 */
export function renderFrame(app: RenderSource, cursor: RenderCursor, area: Rect): Frame {
	// pie: mod.rs:1467 — `lines().len().clamp(1, MAX_INPUT_ROWS)`.
	const inputRowCount = clamp(app.inputLines().length, 1, MAX_INPUT_ROWS);
	const layout = verticalLayout(area, inputRowCount);
	const { feed: feedArea, trigger: triggerArea } = splitContent(layout.content, shouldShowSidePanel(app));
	// pie: mod.rs:1491.
	cursor.lastFeedArea = feedArea;

	// pie: mod.rs:1494-1506 — wrap to width first so the scroll arithmetic is exact.
	const lines = app.feed.lines(feedArea.width);
	const total = lines.length;
	const viewport = feedArea.height;
	cursor.lastViewportH = viewport;
	const maxScroll = satSub(total, viewport);
	if (cursor.follow) {
		cursor.scroll = maxScroll;
	} else {
		cursor.scroll = Math.min(cursor.scroll, maxScroll);
		// pie: mod.rs:1503-1505 — scrolling back to the bottom re-arms follow.
		if (cursor.scroll >= maxScroll) {
			cursor.follow = true;
		}
	}

	const completions = completionOverlay(app, area, layout.status);
	// pie: mod.rs:1561-1563 — overlay order: completions, then picker, then the confirm card, so
	// the confirm card is painted last and wins when several are somehow live at once.
	return {
		layout,
		feedArea,
		triggerArea,
		feedLines: lines.slice(cursor.scroll, cursor.scroll + viewport),
		feedTotal: total,
		maxScroll,
		triggerLines:
			triggerArea === undefined
				? undefined
				: // pie: mod.rs:1657-1658 — the rail block has a left border + 1 left pad, so the
					// text width is `area.width - 2`.
					triggerPanelLines(app, satSub(triggerArea.width, 2), triggerArea.height),
		statusText: statusLineText(app, layout.status.width),
		inputRows: app.inputLines().slice(0, inputRowCount),
		hintText: hintText(app.busy, layout.hint.width),
		completions,
		completionSelected:
			completions === undefined ? undefined : app.completionIdx % Math.max(app.completions.length, 1),
		modelPicker: app.modelPicker === undefined ? undefined : modelPickerOverlay(app.modelPicker, area),
		controlPlanePrompt:
			app.controlPlanePrompt === undefined
				? undefined
				: controlPlanePromptOverlay(app.controlPlanePrompt.request, area),
	};
}

/**
 * Every row a {@link Frame} would put on screen, flattened to plain text — the `buffer_text` the
 * oracle render tests assert against (mod.rs:2385-2396), minus the cell grid. The `> ` prefix on
 * input rows is oracle's prompt column (mod.rs:1533-1536).
 */
export function frameText(frame: Frame): string {
	const rows: string[] = [];
	for (const line of frame.feedLines) rows.push(line.text);
	for (const line of frame.triggerLines ?? []) rows.push(line.text);
	rows.push(frame.statusText);
	for (const row of frame.inputRows) rows.push(`> ${row}`);
	rows.push(frame.hintText);
	for (const overlay of [frame.completions, frame.modelPicker, frame.controlPlanePrompt]) {
		if (overlay === undefined) continue;
		rows.push(overlay.title);
		for (const line of overlay.lines) rows.push(line.text);
	}
	return rows.join("\n");
}
