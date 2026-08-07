# Post-parity backlog — a full count of TODO(port) and PERF(port)

> A phase 18 acceptance item: every TODO(port) and PERF(port) is **either fixed or moved into this
> list**. This file is a complete count rather than a sample — the total matches
> `grep -rnE 'TODO\(port\)|PERF\(port\)' packages/ workers/ --include=*.ts | grep -v /dist/` one for
> one.

These markers **are not defects**. They are the trace the RULEBOOK's UNKNOWN rule leaves behind: where
no rule covers a case, take the most conservative translation, mark it, and continue rather than
stopping the queue to guess. Leaving the judgment in the code where it can be grepped is more honest
than settling it on the spot during the port.

**147** grep hits in total: 140 TODO(port) and 7 PERF(port).
(26 of them are continuation lines or cross-references within the same comment block — see bucket X —
so there are **121** independent items.)

> **2026-08-04, later the same day: all three HIGH items in G-a are fixed, along with one MEDIUM.**
> The count went from 154 to 147: four markers removed (`ai/providers/google.ts`,
> `ai/providers/google-vertex.ts`, `coding-agent/core/auth-storage.ts` and
> `coding-agent/core/slash-dispatch-session.ts`), plus three continuation lines in the same comment
> blocks. Each is described at the head of the G-a table.

| bucket | items | severity |
|---|---|---|
| V — version literals have to track upstream's Cargo.toml | 6 | **HIGH — will go wrong silently** |
| G — formerly "behavior not ported / capability gaps" (triaged 2026-08-04 into 27 port defects, 21 non-defects and 8 already fixed; 4 more fixed the same day, leaving G-a at 23) | 52 | **mixed — see G-a, G-b and G-c** |
| U — residual differences at the boundary of language semantics, not observable by the judge | 16 | **LOW — argued through; changing them is not advised** |
| W — cross-unit wiring to do, removed or repointed once another unit lands | 43 | **LOW — internal tidiness** |
| P — PERF(port), notes on performance trade-offs | 7 | **LOW — a record, not a threshold** |
| X — continuation lines or pointers back to another item, not independent work | 26 | **not applicable — counting noise** |

## V — version literals have to track upstream's Cargo.toml (6 items)

**HIGH — will go wrong silently.** These version numbers are hard-coded literals on the TypeScript
side, and nothing tells us when upstream bumps its version. They are the only class in the whole list
that **will quietly start lying one day if left alone**. The suggestion for phase 19 was a sub-check
in `npm run check` that reads the version from `$ORACLE_PIE_DIR`'s Cargo.toml and fails on a
mismatch.

> **Landed 2026-08-04**: `scripts/check-oracle-version.mjs`, wired into `npm run check` as
> `check:oracle-version`. The expected version is **read only from upstream** (the `[package] version`
> in `crates/{ai,coding-agent,mcp}/Cargo.toml`, falling back to `[workspace.package]` where it is
> written as `version.workspace = true`); this repository keeps no second hard-coded copy, which would
> be the same disease. It covers **9** sites rather than 6: the 6 marked with `TODO(port)` below, plus
> `packages/mcp/src/client.ts:62`, `packages/mcp/src/http.ts:34` and
> `packages/coding-agent/src/otlp.ts:44`, which are the same kind but unmarked. A literal the table's
> pattern no longer matches — after a rename or a refactor — also fails, so the check cannot silently
> cover nothing. **With no upstream checkout it SKIPs and exits 0**, so a fresh clone or a CI run
> without upstream does not break; the path comes from `ORACLE_PIE_DIR` in `migration/sources.env`,
> with an environment variable of the same name taking precedence. Note: when a literal really is
> changed to follow upstream, `cli/help.ts` feeds `pie --version`, which parity S1 pins byte for byte,
> so the baseline has to be retaken with it.

| site | note |
|---|---|
| `packages/ai/src/utils/headers.ts:10` | version literal must track oracle Cargo.toml, not this package.json |
| `packages/coding-agent/src/cli/help.ts:47` | version literal must track oracle Cargo.toml, not this package.json. Same repo-wide convention (and the same adjudication — `migration/reviews/mcp/findings.md`, "0.75.4 vs 0.75.0", CONFIRMED) as `ai/utils/headers.ts:12`, `mcp/client.ts:62`, `mcp/http.ts:34`, `tools/web-fetch.ts:35`, `tools/web-searc |
| `packages/coding-agent/src/lsp.ts:310` | version literal must track oracle Cargo.toml, not this package.json. Deliberately NOT `VERSION` from config.ts: that reads packages/coding-agent/package.json, whose version lineage is pi's (0.75.4) and would put bytes on the `initialize` wire that oracle never emits. Repo-wide convention for every w |
| `packages/coding-agent/src/session-archive.ts:474` | version literal must track oracle Cargo.toml, not this package.json. Deliberately NOT config.ts's `VERSION` (0.75.4, pi's lineage) -- see the repo-wide convention at ai/utils/headers.ts:12, mcp/client.ts:62, mcp/http.ts:34, tools/web-fetch.ts:35, tools/web-search.ts:30, and phase 6's adjudication of |
| `packages/coding-agent/src/tools/web-fetch.ts:33` | version literal must track oracle Cargo.toml, not this npm package's package.json (same convention as packages/ai/src/utils/headers.ts's userAgent()). |
| `packages/coding-agent/src/tools/web-search.ts:29` | must track oracle Cargo.toml, not this npm package's package.json. |

## G — formerly "behavior not ported / capability gaps" (56 items, triaged 2026-08-04)

**This bucket used to be an undifferentiated list that counted three quite different things
together.** Checked item by item against the upstream source, it splits into:

| sub-bucket | items | meaning | severity |
|---|---|---|---|
| **G-a** | **27** | **real port defects**: upstream has the behavior and this port does not | 3 HIGH, 10 MEDIUM, 14 LOW |
| **G-b** | **21** | **not defects**: additions from the skeleton that upstream never had, or pure cross-references and code hygiene | not applicable |
| **G-c** | **8** | **already fixed**: closed by a later phase, mostly 19, with the note never updated | not applicable — should be removed |

How the triage was done: for each item, open the TypeScript site and read the whole comment block,
then open the upstream Rust file the note points at and check. **The note itself is not taken on
trust** — this pass overturned the factual claims of 11 notes (see "the note itself is wrong" at the
end of this section).

> **An earlier correction, 2026-08-04, kept here**: this bucket used to say "not observable on the
> parity surface, or phase 17 would have burned it down". **That sentence is wrong** and was removed.
> The only reason it held is that the rig at the time **had never executed a single tool call** — the
> tool_call count in `sse-fixture-server.mjs` was 0. Once the rig was extended with S9 through S12,
> every conclusion resting on the old boundary had to be re-examined rather than cited again.
>
> **But that correction has itself expired.** It named `core/tools/grep.ts`, `read.ts` and `edit.ts`
> as "user-perceptible differences in tool capability, higher priority than the rest of this bucket".
> On checking, **not one of the three still holds**:
> - `read.ts`: the example it gave — upstream returning `[<path>] lines a-b\n<content>` plus
>   `details{...}` where this port had neither — **is fixed**. `readOracleText` (read.ts:240-286)
>   reproduces that format byte for byte with the details in place, wired into the text branch at
>   read.ts:404-406; upstream's `total_lines` off-by-one is copied too and marked `BUG(port): B18`.
> - `edit.ts`: the schema the model sees is **byte-identical** to upstream (edit.rs:113-129), and the
>   `edits[]` batch engine is a skeleton addition the model cannot reach, so it belongs in G-b.
> - `grep.ts`: `literal` and `context` belong to the skeleton alone, upstream's grep takes five
>   parameters (grep.rs:201-214), and they have been removed from the schema the model sees — so G-b,
>   and here this port is a superset rather than missing anything.
>
> The second-order lesson: **a correction expires too**. "The three highest-priority items" was true
> when written, and six weeks later one was fixed and two had never been defects. Any named ordering
> has to carry the date it was checked, and be re-checked before it is cited.

### G-a — real port defects (27 originally; 4 fixed on 2026-08-04, leaving 23, ordered by user impact)

Definitions of impact: **HIGH** means the user or the model sees wrong or missing bytes, loses a
capability they would have used, or silently gets a wrong result; **MEDIUM** means a clear degradation
that can be worked around, or one reachable only in a narrow configuration; **LOW** means a matter of
appearance, unreachable today, or visible only under extreme conditions.
> **Landed 2026-08-04: all three HIGH items are closed, along with the Vertex MEDIUM.** The table below
> keeps the original wording of each judgment, prefixed with `[fixed 2026-08-04]` and followed by the
> implementation points, so that "why it was fixed this way" stays traceable.
> - **Gemini and Vertex retry**: added `packages/ai/src/providers/google-retry.ts`, which fits the
>   shared `sendWithRetry` (upstream's `utils/retry.rs`) into `@google/genai`'s `ApiClient#apiCall`.
>   The SDK's own `httpOptions.retryOptions` was **not used**: it expresses only `attempts`, its
>   retryable status set is 408/429/500/502/503/504 (missing 409, 425 and the other 5xx), its backoff
>   follows p-retry's default curve (starting at 1s, no jitter, no cap), it never reads `Retry-After`,
>   and it **throws before `throwErrorIfNotOK`** — so the body of every non-2xx provider error is
>   replaced by a bare statusText. Upstream explicitly returns the response untouched for a
>   non-retryable status (retry.rs:9) so the caller can print `HTTP {status}: {body}`, which makes
>   enabling `retryOptions` a net regression. The interception point is a private SDK method, so it is
>   feature-detected and **fails loudly** — absent, it throws at construction — guarded by the tripwire
>   case in `packages/ai/test/google-retry-parity.test.ts`.
> - **Credential precedence**: `getApiKey` in `auth-storage.ts` now puts the environment variable ahead
>   of auth.json, matching `resolve_for_provider`. The three reasons given in the old note
>   ("precedence divergence, observed, NOT applied") — blast radius, upstream's OAuth refresh being
>   dead code, and no RULEBOOK authorisation — were all process reasons on review, and none said this
>   place had to work the other way; standing rule 7, the old code is the spec, already covers it. Two
>   surfaces unique to the skeleton stay where they are: the runtime override, which is highest and has
>   no upstream counterpart, and the google-vertex `<authenticated>` ADC sentinel in `getEnvApiKey`,
>   which stays **below** stored credentials — upstream reads only environment variables, and an
>   ambient gcloud ADC should not outrank `/login`, so the env-first probe is gated on `findEnvKeys`
>   being non-empty. Ledger: the `coding-agent/auth` row in
>   `migration/reviews/coding-agent-tools/divergence-ledger.tsv` moved from `none` to `applied` with
>   the review recorded.
> - **`/find`**: `session-manager.ts` gained `listSessionTranscriptPaths` and `sessionMessageTexts`, and
>   `runFindCommand` now scans **every** user and assistant body session by session, printing the file
>   stem as upstream does (not the 16-character short id from `/sessions`) and a 120-codepoint excerpt,
>   with `hits` counting **messages**. The cost is the same order as upstream's — every `/find` parses
>   every transcript in that cwd, with no index — but it is **cheaper than before**: the old
>   implementation went through `listSessionEntries`, which already parsed every transcript just to
>   take the first user message for a preview, and read two automation sidecars besides. What is new
>   is only an in-memory scan of messages that were already parsed.

> **2026-08-05, phase 20-8: all ten MEDIUM items in G-a have been handled one by one.** Four were
> aligned, one partly fixed, and five kept after being argued through; each is described in
> `migration/reviews/phase20/ga-medium.md`. The table below prefixes the corresponding rows with
> `[fixed …]` or `[partly fixed …]`; the five rows without a prefix are the ones kept, with reasons
> in that document.

| site | impact | judgment, checked against the upstream source |
|---|---|---|
| `packages/ai/src/providers/google.ts:359` | **HIGH** | **[fixed 2026-08-04]** The main Gemini path had **no retry at all**. Upstream's google.rs:146 sends every request through `send_with_retry`; here `createClient` only set headers and baseUrl, and without `retryOptions` @google/genai issues a bare `fetch`. 429 and 503 are routine on Gemini, so upstream backs off and succeeds where this port burned the turn on the spot |
| `packages/coding-agent/src/core/auth-storage.ts:687` | **HIGH** | **[fixed 2026-08-04]** Credential precedence was **the wrong way round**. Upstream's `resolve_for_provider` (auth.rs:129-143) checks the environment variable first and falls back to auth.json — "env var wins" is its own comment — while this port checked stored credentials first. Every provider lookup goes through this function, so the standard escape hatch of exporting an environment variable to override a stale or revoked stored credential **did not work at all** here. **The line number in the site has drifted**: the real position is auth-storage.ts:843 |
| `packages/coding-agent/src/core/slash-dispatch-session.ts:608` | **HIGH** | **[fixed 2026-08-04]** `/find` silently returned a strict subset. Upstream's commands.rs:2076-2120 opens every session, scans **every** user and assistant body, and prints a 120-character excerpt; this port only substring-matched `session.preview`, the first user message filled in at session-manager.ts:2137. The user got a wrong answer with no indication of it |
| `packages/mcp/src/protocol.ts:12` | MEDIUM | **[fixed 2026-08-05, phase 20-8]** Upstream refuses a malformed MCP response through serde (protocol.rs:46-53 makes `name: String` required and `ToolContent` is `#[serde(tag="type")]`; the `?` at client.rs:282 turns any shape violation into an `McpError`), while this port cast with a bare `as unknown as` at client.ts:170-195 and validated nothing. Against a non-conforming MCP server the model received a tool catalog with `name: undefined`, or a garbled tool result, rather than one clean, attributable protocol error |
| `packages/coding-agent/src/main.ts:1326` | MEDIUM | **[partly fixed 2026-08-05, phase 20-8]** **Not merely a question of order.** Checking the full startup sequence at main.rs:884-1023 showed that **six upstream startup lines have no counterpart here at all**: `loaded N local model(s)`, `loaded N skill(s)`, `loaded N template(s)`, `skills loader: N diagnostic(s)`, `hooks: loaded N hook(s)` with its diagnostics, and the automation-elsewhere hint. The user gets no confirmation that skills, templates or hooks loaded, and never sees the loader diagnostics — which is exactly the signal you look for when a skill silently has no effect |
| `packages/coding-agent/src/core/prompt-templates.ts:262` | MEDIUM | **[fixed 2026-08-05, phase 20-8]** Upstream's template directories are `<cwd>/.pie/templates/` and `<PIE_DIR or ~/.pie>/templates/` (templates.rs:16-19), while this port hard-coded `prompts/` at prompt-templates.ts:277-278. A user arriving with existing templates loaded **none of them** silently, and the slash command reported an unknown name |
| `packages/coding-agent/src/ui/terminal-driver.ts:21` | MEDIUM | Cursor position. Upstream renders tui-textarea (ui/mod.rs:1543), whose default `cursor_style` is `Modifier::REVERSED` — it **draws a reversed cell** and never moves the hardware cursor — while this port's `caretPosition` (terminal-driver.ts:258-269) parks the hardware cursor at the end of the input area's last line. During any mid-line or multi-line edit (Home, Left, Up) the cursor is in the wrong place, though keystrokes still land correctly |
| `packages/ai/src/providers/google-vertex.ts:355` | MEDIUM | **[fixed 2026-08-04]** The same as `google.ts:359`, on the Vertex path (upstream's google_vertex.rs:139 goes through `send_with_retry`). Rated MEDIUM rather than HIGH only because Vertex needs a GCP project and location configured, which narrows what can reach it |
| `packages/ai/test/ported/anthropic-sse-e2e.test.ts:187` | MEDIUM | **[fixed 2026-08-05, phase 20-8]** The SSE `event: error` frame: this port did `throw new Error(sse.data)` at anthropic.ts:400-401, so the raw JSON string reached `output.errorMessage` through :703-705, while upstream's anthropic.rs:358-371 extracts `/error/message` and falls back to `"anthropic error"`. The user saw `{"type":"error","error":{"message":"overloaded"}}` instead of `overloaded`. The corresponding ported characterization test is still an `it.skip` |
| `packages/coding-agent/src/main.ts:961` | MEDIUM | Upstream's main.rs:553-567 auto-detects **unconditionally**, in the env order of CANDIDATES (model.rs:9-18/37-60 skips a provider with neither an env var nor an auth.json entry), and upstream has no settings default model at all; this port calls `autoDetectModel` only when neither settings nor the CLI names a model. With settings pointing at a provider that has no credential while another candidate's env var is set, this port starts on the dead provider |
| `packages/coding-agent/src/main.ts:1228` | MEDIUM | Nothing pushes to `mainRunRx`, so `App.startTriggeredTurn` (ui/index.ts:1187-1198) never fires: the `running triggered turn (trace …)` status line, the busy spinner and the `triggered turn: ` error prefix are all lost, and that turn runs outside `turn.fut` — Ctrl-C hits the idle branch (ui/index.ts:953) and may exit pie in the middle of a triggered turn. The turn itself still runs (runtime.ts:268 `sendUserMessage`). Reachable only with an `inject_and_run` trigger or a cron job configured |
| `packages/coding-agent/src/tools/install-skill.ts:28` | MEDIUM | Upstream's install_skill.rs:224-231 calls `harness.reload_skills_from_disk()`, which **hot-reloads the live harness and rebuilds the system prompt** so "the new skill is visible on the next turn"; this port does not, and the skill catalog in the system prompt stays stale until `/skills reload` or a restart. There is a way around it: `tools/skill.ts` rescans the disk on every call, so a freshly installed skill is still callable. The audit half of the same note is LOW on its own |
| `packages/coding-agent/src/ui/index.ts:425` | MEDIUM | Upstream's `catalog()` (model_picker.rs:33-34 into commands.rs:941-958) checks the environment first and then `AuthStore::load()`; this port's default implementation probes only the environment, and main.ts:1406-1435 never injects `AppConfig.catalog` or `authStorage`. A provider configured through `/login` shows " · no key" in the `/model` picker and on the web badge |
| `packages/ai/src/providers/amazon-bedrock.ts:119` | LOW | Upstream's amazon_bedrock.rs:107 uses its own `send_with_retry` (408, 409, 425, 429 and 5xx, a 500ms base backoff, honouring Retry-After, with a fail-fast limit); this port leaves it to the AWS SDK's retry and aligns only the attempt count. The common 429 and 5xx are still retried within the same budget of three; what differs is the backoff curve, Retry-After, and 408, 409 and 425 |
| `packages/coding-agent/src/cli/help.ts:27` | LOW | Upstream uses clap's own printer (main.rs:394-396) without disabling the default `color` feature, so help is ANSI-coloured on a TTY; this port's hand-written renderer is always plain text. S1 captures a pipe, where upstream has no colour either, so this is visible only on an interactive pty |
| `packages/coding-agent/src/cli/session-picker.ts:290` | LOW | The IO half of upstream's picker (resume_picker.rs:157-213) was not ported, and the pure-function half that was (`pickerFrame`, `keyAction`, `applyPickerAction`) is dead code — main.ts:441-452 runs the skeleton's `SessionSelectorComponent`. Resuming still works; what remains is the visual shell plus three edge semantics: the "new session" row upstream pins, the hard error outside a TTY (main.rs:516-521), and a non-zero exit on cancel |
| `packages/coding-agent/src/config.ts:640` | LOW | Upstream's `poll_interval_secs` is a `u64` (config.rs:44-57, whose only rejection is `secs == 0`), while this port rejects anything above `Number.MAX_SAFE_INTEGER`. Only a configuration above 2^53 seconds — roughly 285 million years — diverges, and the failure is loud |
| `packages/coding-agent/src/core/tools/bash.ts:365` | LOW | **Only half of this remains.** Shell selection still diverges: upstream's bash.rs:134 is always `sh -c`, while this port's `getShellConfig` prefers `/bin/bash` and falls back to sh — a superset, pointing the right way (bash contains POSIX sh), visible only where dash and bash behave differently. The other half of the note, the split-section result body, **is fixed** |
| `packages/coding-agent/src/debug.ts:182` | LOW | Upstream's debug.rs:63-66 breaks out of the pump when `sender.is_closed()`; this port drains `inner` to the end. Reachable only under `--debug` when the consumer drops midway, and it loses and corrupts nothing — it merely does extra work |
| `packages/coding-agent/src/logging.ts:36` | LOW | The lines upstream writes to disk come from `tracing_subscriber::fmt`'s Full formatter (logging.rs:55-60); this port's hand-written `writeLine` has no span context prefix (`name{fields}:`), and the thread id is Node's. Logs are neither a wire format nor a parity judging surface, and every field a user would grep for is present |
| `packages/coding-agent/src/logging.ts:286` | LOW | The close event upstream synthesises through `FmtSpan::CLOSE` carries `time.busy` and `time.idle` (tracing-subscriber fmt_layer.rs:978-1000); this port's close line writes only `span.name`. Two diagnostic fields fewer in the log |
| `packages/coding-agent/src/tools/remove-skill.ts:25` | LOW | Upstream's remove_skill.rs:236-256 writes a `skill_control_plane` audit entry with op=remove and returns `audit_entry_id` in the details; this port always returns `undefined`. **Upstream has no reader of its own** — the TUI discards `AgentMessage::Custom`, and `/triggers audit` does not match that custom_type — so the impact stops at the forensic record in the session JSONL. One thing the note omits: after removing, upstream also calls `reload_skills_from_disk()` (remove_skill.rs:285-288) |
| `packages/coding-agent/src/tools/set-skill-state.ts:29` | LOW | As above (set_skill_state.rs:228-250, carrying the before and after `enabled` and actor=tool). This port is also inconsistent with itself: the user's `/skills enable\|disable` **does** write the same record, and only a model-driven state change does not |
| `packages/coding-agent/src/tools/skill-builder.ts:234` | LOW | Upstream's skill_builder.rs:201-219 pushes `this will shadow the builtin skill '<name>'` for a `SkillSource::Builtin`, while this port's shadow loop only tests `scope === "project"`. Unreachable today, because this port's catalog has no builtin source at all. The note's premise, "if and when a builtin-skill source is introduced", is now half met: `builtin-skills.ts` has landed, but main.ts:1265-1272 uses it only to validate `--builtin-skill` names and then discards it (`mergeWithUserProject` has no caller) |
| `packages/coding-agent/src/ui/kernel.ts:158` | LOW | Upstream's kernel.rs:88-90 reads the agent's global `is_streaming`; this port counts only the turns this kernel has in flight, so a turn started outside the kernel (a trigger's `inject_and_run` into `sendUserMessage`) is invisible to it. The only consumer, `startTriggeredTurn`, is unreachable today (see the main.ts:1228 row), and where they diverge the failure is loud rather than silent |
| `packages/coding-agent/src/ui/relay.ts:621` | LOW | The ported QR encoder caps at version 10 where the crate reaches 40 (relay.rs:155-166), and over-long input throws `qr encode: data too long`. A real URL is always `<base>/session/<40 hex>/`, about 71 bytes, which is version 5; reaching the cap needs a `relay.base_url` in config.toml longer than 190 characters, and the caller degrades to `qr render skipped: {e}` rather than failing |
| `packages/coding-agent/src/ui/web.ts:301` | LOW | Upstream's broadcast channel is bounded at 128 (web.rs:225), a lagging SSE subscriber gets `RecvError::Lagged(_)`, and `events()` (web.rs:683-701) **drops** the skipped snapshots and continues from the newest; this port's listener set is unbounded and never drops a frame. A snapshot is a full state replacement, so no viewer sees wrong data — the cost is that the server-side write buffer for a lagging browser grows without bound |

### G-b — not port defects (21 items)

Three kinds: **skeleton additions** that upstream never had, where this port is a superset;
**pure cross-references and code hygiene**, where no upstream behavior is missing; and **echoes on
the test side**, duplicating the marker on another src line.

| site | sub-kind | judgment, checked against the upstream source |
|---|---|---|
| `packages/coding-agent/src/core/tools/grep.ts:28` | skeleton addition | **The canonical example of this class.** The `DEFINITION.parameters` of upstream's grep.rs:201-214 has five entries — pattern, path, glob, case_insensitive and limit — and execute reads only those five; `literal` and `context` belong to the skeleton alone and have been removed from the schema the model sees, so this port is 1:1 with upstream |
| `packages/coding-agent/src/core/tools/edit.ts:32` | skeleton addition | Upstream's definition at edit.rs:113-129 has only path, old_string, new_string and replace_all, with no `edits`. The schema the model sees here is byte-identical to it, description strings included; the `edits[]` engine is not in `editSchema` and the model cannot reach it, and real execution goes through `executeOracleEdit` |
| `packages/coding-agent/src/core/tools/read.ts:220` | skeleton addition | The module documentation at upstream's read.rs:4-5 says plainly "text-only (no image attachments)", and read.rs:51-53 only calls `read_to_string` — the image branch (jpg, png, gif and webp into ImageContent with auto-resize) is the skeleton's. **The line number has drifted**: the comment is now at read.ts:300-301 |
| `packages/ai/src/utils/retry.ts:65` | cross-reference and hygiene | The TypeError check is a **strict superset** of reqwest's five categories (retry.rs:146-148: timeout, connect, request, body, decode) — every transport failure upstream retries during send is either a TypeError or a TimeoutError under fetch. The note calls itself "broader", which is accurate |
| `packages/ai/test/amazon-bedrock-retry-alignment.test.ts:6` | cross-reference and hygiene | A pure pointer at the TODO in `src/providers/amazon-bedrock.ts`, which is the G-a row; the test itself asserts that maxAttempts is aligned |
| `packages/coding-agent/src/control-plane-prompt.ts:42` | cross-reference and hygiene | A hypothetical TODO whose condition does not hold: the ported TUI has no "drop without resolve" site (the queue pump has a `controlPlanePrompt === undefined` guard at ui/index.ts:612-618, and cancellation already goes through cancellationCase), and the only unpaired drop is App teardown, after which the process exits. Upstream has the same shape (ui/mod.rs:440-445, 648-659) |
| `packages/coding-agent/src/core/slash-dispatch-session.ts:111` | cross-reference and hygiene | Confirmed unreachable: every branch of the goal slash command at upstream's commands.rs:1041-1088 calls only `goal::{pause,resume,clear,set,current}`, and none calls the evaluator |
| `packages/coding-agent/src/logging.ts:262` | cross-reference and hygiene | **The divergence the note describes does not exist** (see the closing section). The unified gating here is upstream's observable behavior |
| `packages/coding-agent/src/main.ts:1346` | cross-reference and hygiene | A forward-looking TODO. Upstream's `struct Cli` has no positional argument (its usage is `pie [OPTIONS] [COMMAND]`), and this port puts the skeleton's positional argument, `@file` and stdin text into the input box rather than submitting them automatically |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:2709` | skeleton addition | The site is the skeleton's own TUI, whose only production caller is the skeleton-specific `PI_STARTUP_BENCHMARK` (main.ts:1323-1330). The ported upstream REPL matches upstream exactly: ui/index.ts:1177 `promptDisplay(trimmed, …)` into :1182 `feed.pushUser(display)`, corresponding to ui/mod.rs:999-1006 |
| `packages/coding-agent/src/session-archive.ts:34` | cross-reference and hygiene | GNU (upstream's session_archive.rs:520-532 `Header::new_gnu()`) against ustar is only a flavour of header: this port's reader never reads the magic field and reads only the name, size and typeflag that both formats share at the same offsets, and the Rust `tar` crate reads ustar too. All four archive paths are 21 bytes or fewer with a 50 MiB size cap, so the GNU longname and base-256 extensions cannot be triggered. The note overstates the risk |
| `packages/coding-agent/src/session-archive.ts:36` | cross-reference and hygiene | A pure dependency-replacement TODO. The note implies the size caps are a shortcoming of the hand-written implementation — **they are not**: MAX_MANIFEST, MAX_SESSION and MAX_SIDECAR, along with "session archive file is too large", are copied byte for byte from upstream's session_archive.rs:26-28 and 549-562 |
| `packages/coding-agent/src/spinner.ts:159` | cross-reference and hygiene | Code hygiene, deduplication: `sleepUnref` has a private copy in each of spinner.ts:163 and otlp.ts:341, and they have not been merged. Upstream's spinner.rs:156 is a single `tokio::time::sleep`, so there is no shared utility to lose |
| `packages/coding-agent/src/tools/skill.ts:42` | cross-reference and hygiene | **To say plainly: do not count this as a fourth audit defect.** Upstream's own skill.rs neither writes an audit entry nor reloads (`grep append_custom skill.rs` finds nothing); it only looks up, checks whether the skill is disabled, and wraps. This port rescans the disk on every call, which is fresher than upstream's harness snapshot |
| `packages/coding-agent/src/triggers/dynamic.ts:550` | skeleton addition | `stop()` was added here for cancellation in tests; upstream's `NotificationHook` trait (notification_hook.rs:39-53) has only `label()`, `run()` and `status()` |
| `packages/coding-agent/src/ui/feed.ts:228` | cross-reference and hygiene | Code hygiene, deduplication: `rustLines` is byte-identical in feed.ts:232-238 and tui.ts:145-151, and both model Rust's `str::lines()` faithfully. Upstream calls `str::lines()` inline, so there is no helper to be missing |
| `packages/coding-agent/src/utils/clipboard-image.ts:438` | cross-reference and hygiene | Upstream's clipboard_image.rs:67-72 fails at the same layer with the same context (`encode clipboard image as PNG`) for a zero width or height too, since a PNG IHDR forbids zero dimensions. This port short-circuits to the same message and loses nothing |
| `packages/coding-agent/test/config-paths.test.ts:141` | echo on the test side | The test-side marker for `config.ts:640`, the G-a LOW row, pinning only the declared divergence |
| `packages/coding-agent/test/install-skill.test.ts:341` | echo on the test side | The test-side marker for `tools/install-skill.ts:28`, the G-a MEDIUM row. Upstream does assert `audit_entry_id` at install_skill.rs:1303-1308 |
| `packages/coding-agent/test/skill-builder.test.ts:20` | echo on the test side | Points back at `tools/skill-builder.ts:234`, the G-a LOW row, with no behavior of its own |
| `packages/mcp/src/protocol.ts:56` | cross-reference and hygiene | Points back at the TODO at :12 in the same file, and the behavior it describes **is implemented**: `normalizeMcpTool` applies serde's `default` at the parsing boundary (a missing `inputSchema` becomes `null`), corresponding to protocol.rs:51-52 |

### G-c — closed by a later phase (8 items, should be removed from the list)

**These notes are still in the source saying things that stopped being true**, which is worse than no note at all — the next person will cite them as work to do.

| site | judgment |
|---|---|
| `packages/coding-agent/src/main.ts:907` | Closed by F6 in phase 19: a malformed models.json **is now fatal** — a failing `loadLocalModels` pushes a `type:"error"` diagnostic (main.ts:1019-1023), `hasFatalDiagnostic` leads to `process.exit(1)` (main.ts:1240-1246), matching the `?` at upstream's main.rs:551. The note's description of the TypeScript side, "reported as a warning and continues", is void, and the line number has drifted too |
| `packages/coding-agent/src/main.ts:1076` | `pie session` **is wired**: `subcommands.ts`, called from main.ts:761 through `resolveSubcommandInvocation`, renders the four clap pages for `session`, `session export` and `session import` byte for byte, corresponding to main.rs:150-187, and the "top-level page stands in" fallback no longer exists. What remains open is separate and already declared as a PORT-DIVERGENCE at subcommands.ts:24-27: export and import refuse with exit 2 rather than moving data |
| `packages/coding-agent/src/model-picker.ts:31` | The "phase 14 TUI overlay" has landed: `handleModelPickerKey` (ui/index.ts:1067-1095) implements Up and `k`, Down and `j`, Enter, Esc and ctrl+c, branch for branch with upstream's ui/mod.rs:857-905; rendering is `modelPickerOverlay` at app-render.ts:442, drawn from terminal-driver.ts:246 |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:4550` | Both TODOs are closed on the **production path**: `runDiagCommand` (slash-dispatch-session.ts:341-357) prints `skills ${ctx.harness.skills().length}` and `oneLineSummary(ctx.harness.cost())`, the latter being the port of `cost_one_line_summary` (agent/harness/cost.ts:137), corresponding to commands.rs:1427-1459. What the note describes is the benchmark-only skeleton copy |
| `packages/coding-agent/src/readline.ts:87` | Ported: `skillShortcuts` (slash-dispatch-skills.ts:463, including `previewText(description, 72)`) and `resolveSkillShortcut` (:486), corresponding to commands.rs:3061-3096; `/help` renders the source and description at slash-dispatch.ts:226-256. The private helper in readline.ts is now a redundant duplicate and can simply be deleted |
| `packages/coding-agent/src/ui/app-render.ts:20` | The painter exists and is wired on the production path: `paintFrame` (terminal-driver.ts:201), reached from main.ts:1508 through `app.run(createTerminalDriver())`. terminal-driver.ts:2 says itself that it closes this TODO. Only the cursor-positioning sub-item remains, listed separately as the terminal-driver.ts:21 row in G-a |
| `packages/coding-agent/src/ui/index.ts:231` | As above. The site is `escapeSequenceDriver`, a deliberately headless test driver; the real painter is in terminal-driver.ts |
| `packages/coding-agent/test/tools.test.ts:539` | **Wrong twice**: the line number has drifted (the real site is tools.test.ts:583-584), and the sentence the note quotes says itself that it "closes the TODO that recorded the missing knob". `replace_all` is fully ported (edit.ts:402 and 433-441, corresponding to edit.rs:42-72) and asserted (tools.test.ts:585-600). This row should be deleted outright, or moved into bucket X |

### The note itself is wrong (11 items, overturned by this pass)

**This section matters more than the classification above.** This repository has recorded "the note
disagrees with the source" several times before; checking this batch, **11 of the 56 have factual
claims that do not hold**. Anyone citing this list to make a decision should re-check first.

| site | what the note says | what is actually the case |
|---|---|---|
| `packages/ai/src/providers/google.ts:359` and `google-vertex.ts:355` | "@google/genai HttpOptions has no fetch or fetcher hook … wait until the SDK adds one" | Misleading. The pinned @google/genai@1.52.0 **does have** `HttpOptions.retryOptions` (genai.d.ts:6110-6111, 6176-6180), and setting it engages pRetry (5 attempts by default, on 408, 429, 500, 502, 503 and 504). What is missing is only *fetch* injection; **this defect was fixable that day** |
| `packages/ai/src/providers/amazon-bedrock.ts:119` | "fetch injection is unavailable in AWS SDK v3 … there is nothing to wrap" | The first half is right (`FetchHttpHandlerOptions` really has no fetch override), the second overstates: `BedrockRuntimeClientConfig` accepts `retryStrategy?: RetryStrategy \| RetryStrategyV2`, which is enough to reproduce upstream's retry semantics |
| `packages/coding-agent/src/logging.ts:262` | "upstream's `Interest::always()` interacts with the global EnvFilter through interest merging, which this port does not reproduce" | **Wrong.** `Layered::pick_interest` (tracing-subscriber 0.3.23, layered.rs:435-476) propagates the **inner** value upward when there is no per-layer filter — EnvFilter's `never` — and `Layered::enabled` (:105-108) takes the conjunction across layers, so EnvFilter still vetoes. `Interest::always()` affects only the callsite cache here and changes no span or event outcome. **This row is not a defect** |
| `packages/coding-agent/src/main.ts:1326` | "every line is present and byte-identical; only the order between bundles differs" | **Wrong.** At least six upstream startup lines have no counterpart anywhere in this repository (see that row in G-a) |
| `packages/coding-agent/src/main.ts:1076` | "the `session` subcommand is not yet wired on this side" | **Wrong.** subcommands.ts already renders all four pages byte for byte |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:4550` | "`cost_one_line_summary` is not yet ported; the resource loader's catalog stands in for the skill count" | **Wrong** as far as the production `/diag` is concerned. Both are ported; what the note describes is the dead skeleton copy |
| `packages/coding-agent/src/readline.ts:87` | "the `coding-agent/commands` unit did not port it" | **Wrong.** It is ported; what remains is deleting the duplicate |
| `packages/coding-agent/test/tools.test.ts:539` | (wrong on both the line number and the content; see G-c) | That line is itself the text saying the TODO is closed |
| `packages/coding-agent/src/core/prompt-templates.ts:262` | "the production caller, resource-loader, supplies the root directory explicitly anyway" | **Wrong and misleading.** resource-loader.ts:517-522 passes only `cwd` and `agentDir`; the `prompts` subdirectory name is derived inside prompt-templates.ts, and the production path really does read `prompts/` |
| `packages/coding-agent/src/core/tools/bash.ts:365` | "both the shell selection **and** the split-section result body are outstanding" | The second half **is fixed**: `buildResultText` (bash.ts:235-259) reproduces upstream's single combined text — the `$ cmd` header, the `[stderr]` section marker and the `[exit N]` trailer. Only the shell selection remains |
| `packages/coding-agent/src/ui/terminal-driver.ts:21` | "threading `InputArea.cursor()` through `Frame` would position it exactly" | The suggested fix points the wrong way. Upstream does not move the terminal cursor at all; it draws a REVERSED cell, so aligning with upstream means drawing a reversed cursor cell rather than repositioning the hardware cursor |

**Four more sites have drifted line numbers** (a list generated by grep rots as code moves, the same
ailment as bucket V): `core/auth-storage.ts:687` → 843 · `core/tools/read.ts:220` → 300-301 ·
`main.ts:907/961/1076/1228/1326/1346` all shifted down ·
`test/tools.test.ts:539` → 583-584。
| `packages/ai/src/providers/amazon-bedrock.ts:119` | AWS SDK v3 fetch injection unavailable — attempts aligned to oracle retry budget instead. pie: crates/ai/src/providers/amazon_bedrock.rs:107 + crates/ai/src/utils/retry.rs — oracle sends every attempt through `send_with_retry` (its own retryable-status set and backoff/cap semantics), same as anthrop |
| `packages/ai/src/providers/google-vertex.ts:355` | sendWithRetry not wired — @google/genai HttpOptions exposes no fetch/fetcher hook (oracle providers/google.rs:146 calls send_with_retry). Revisit if the SDK adds the hook. |
| `packages/ai/src/providers/google.ts:359` | sendWithRetry not wired — @google/genai HttpOptions exposes no fetch/fetcher hook (oracle providers/google.rs:146 calls send_with_retry). Revisit if the SDK adds the hook. |
| `packages/ai/src/utils/retry.ts:65` | reqwest 5-way error taxonomy approximated by TypeError check (broader); revisit if false-positive retries observed. |
| `packages/ai/test/amazon-bedrock-retry-alignment.test.ts:6` | comment in src/providers/amazon-bedrock.ts next to `BedrockRuntimeClientConfig` construction. |
| `packages/ai/test/ported/anthropic-sse-e2e.test.ts:187` | base's iterateAnthropicEvents (src/providers/anthropic.ts:399-401) does `throw new Error(sse.data)` for an SSE `event: error` frame — the raw, unparsed SSE data string becomes the thrown Error's message. Oracle's anthropic.rs:358-371 instead parses the JSON payload and extracts `/error/message` (fal |
| `packages/coding-agent/src/cli/help.ts:27` | colorize headers when `process.stdout.isTTY` if a scenario ever captures a pty. |
| `packages/coding-agent/src/cli/session-picker.ts:290` | the surrounding IO half of `pick_blocking` (resume_picker.rs:157-213 -- raw mode via `RawModeGuard`, in-place repaint with `MoveUp`/`Clear(FromCursorDown)`, `\r\n` line endings, blocking `crossterm::event::read()`) belongs to the phase 14 `coding-agent/tui` unit: it needs `@pie/tui` primitives for r |
| `packages/coding-agent/src/config.ts:640` | config.rs:44-57 -- oracle's field is `Option<u64>`, so a value above Number.MAX_SAFE_INTEGER parses fine there (it arrives here as a `bigint`) while JS cannot carry it losslessly. Rejecting loudly is the conservative choice over silently rounding. |
| `packages/coding-agent/src/control-plane-prompt.ts:42` | if the TUI ever drops prompts without calling `close`, the hook waits forever instead of denying; revisit when `ui/mod.rs` is ported and the drop sites are known. |
| `packages/coding-agent/src/core/auth-storage.ts:687` | pie: crates/coding-agent/src/auth.rs:129-143 (`resolve_for_provider`) checks the env var BEFORE the stored auth.json credential ("env var wins; auth.json is the fallback") -- the reverse of this function's order. Observed, deliberately NOT applied; see this file's module-doc "Precedence divergence"  |
| `packages/coding-agent/src/core/prompt-templates.ts:262` | oracle roots the two directories at `<cwd>/.pie/templates/` and `<PIE_DIR\|~/.pie>/templates/` (templates.rs:17-18), whereas this repo names the subdirectory `prompts/` everywhere (resource-loader.ts:626,632, package-manager.ts:2200,2206, migrations.ts:141, config-selector.ts). Renaming is a repo-wi |
| `packages/coding-agent/src/core/slash-dispatch-session.ts:111` | unreachable from the slash path — only `goal.stopHook` calls this, and the REPL registers that hook against the real harness, not against this adapter. |
| `packages/coding-agent/src/core/slash-dispatch-session.ts:608` | oracle scans EVERY user/assistant message of every session (commands.rs:2082-2120); `listSessionEntries` only surfaces the first-user-message preview, so this matches a strict subset until a full-transcript scanner lands. `/find` has no ported test today. |
| `packages/coding-agent/src/core/tools/bash.ts:365` | only the definition is aligned here; the shell choice and the split-section result body are execute-path divergences left for a follow-up unit. |
| `packages/coding-agent/src/core/tools/edit.ts:32` | pi's `edits[]` batch engine (fuzzy matching, overlap detection, BOM/CRLF handling, unified diff, all of `edit-diff.ts`) has no oracle counterpart. Rather than delete it — and the ~14 tests that are about it — it is kept reachable only for in-process/SDK callers via {@link EditExecuteInput}; the mode |
| `packages/coding-agent/src/core/tools/grep.ts:28` | pi's `literal` (fixed-string mode) and `context` (surrounding lines) have no oracle counterpart and are gone from the model-visible schema. The execute path still honours them for in-process/SDK callers — see {@link GrepExecuteInput} — but the model can no longer request them. Whether to delete the  |
| `packages/coding-agent/src/core/tools/read.ts:220` | the image branch below (jpg/png/gif/webp -> ImageContent + auto-resize) has no oracle counterpart; only the *definition* is aligned here, the execute path is untouched. |
| `packages/coding-agent/src/debug.ts:182` | oracle debug.rs:64-66 breaks out of the pump when `sender.is_closed()` — i.e. the consumer dropped the receiver. `@pie/ai`'s `EventStream` exposes no `isClosed` equivalent, and a `push` after the stream finished is already a no-op there, so this port keeps draining `inner` instead. Nothing downstrea |
| `packages/coding-agent/src/logging.ts:36` | the on-disk line format is a documented approximation of `tracing_subscriber::fmt`'s `Full` formatter, not a byte-exact reproduction — the oracle cannot be run here to diff against (cargo is denied in this repo per CLAUDE.md standing rule 5), and the log file is neither a wire format nor a parity sc |
| `packages/coding-agent/src/logging.ts:262` | oracle's `OtlpLayer::register_callsite` returns `Interest::always()` (otlp.rs:148-150), which in `tracing-subscriber` interacts with the global `EnvFilter` layer through interest merging this port does not reproduce; here the filter gates span creation for every layer uniformly. Only reachable when  |
| `packages/coding-agent/src/logging.ts:286` | oracle's close event also carries `time.busy`/`time.idle` fields, which this port does not track. |
| `packages/coding-agent/src/main.ts:907` | oracle's `?` makes a malformed models.json fatal (`run_repl` returns Err and the process exits 1). This side reports it as a warning and continues, because `ModelRegistry` already reads the SAME path in pi's `{"providers":{…}}` shape and tolerates both JSON comments and schema errors there; promotin |
| `packages/coding-agent/src/main.ts:961` | env-var priority (CANDIDATES order) does not override a settings default the way oracle's unconditional auto-detect does. Reachable only when settings name a model whose provider has no credential while another candidate's env var IS set. |
| `packages/coding-agent/src/main.ts:1076` | the second case is oracle's clap rendering the *subcommand's* page (`pie session --help`, `pie session import --help`; see main.rs:150-187). The `session` subcommand is not wired on this side yet, so the top-level page stands in — the conservative answer until the `coding-agent/main` unit lands `run |
| `packages/coding-agent/src/main.ts:1228` | nothing pushes to it on this side. Oracle's `TriggerRequestsMainRun` is emitted by `AgentHarness`, which the CLI does not run; `TriggerSupervisor`'s `inject_and_run` delivery goes straight through `session.sendUserMessage`, which already serializes against user input. The channel is wired so `App`'s |
| `packages/coding-agent/src/main.ts:1326` | oracle interleaves its startup lines differently (dynamic/cron → templates → mcp → debug → poll interval → lsp → loader diagnostics). This side emits the whole trigger bundle first because that is how `loadTriggerSubsystem` returns it. Every line is present and verbatim; only the order between bundl |
| `packages/coding-agent/src/main.ts:1346` | revisit if oracle ever grows a positional message. |
| `packages/coding-agent/src/model-picker.ts:31` | the TUI overlay (key handling + rendering) is a phase 14 unit. Oracle drives this state machine from `ui/mod.rs:857-905`: Up/`k` → {@link ModelPickerState.up}, Down/`j` → {@link ModelPickerState.down}, Enter → {@link ModelPickerState.enter} (a returned spec closes the overlay and switches the model) |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:2709` | oracle also keeps the FEED display raw (`prompt_display(&trimmed, …)`, ui/mod.rs:997-1003); this TUI renders the user bubble from the persisted session message, so an expanded prompt shows its attachment block in the transcript. Closing that needs a display/prompt split in the chat renderer, which i |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:4550` | oracle's cost line is `pie_agent_core::cost_one_line_summary(&cost)`, which is not ported yet; this uses the session's own aggregated cost instead. Oracle also prints a `skills` count off `harness.skills()`; the resource loader's catalog stands in. |
| `packages/coding-agent/src/readline.ts:87` | oracle declares this in `commands.rs` and readline.rs merely imports it, but the `coding-agent/commands` unit (`src/core/slash-commands.ts`, phase 13, done) did not port it -- |
| `packages/coding-agent/src/session-archive.ts:34` | session_archive.rs:177-190 (tar::Builder, GNU headers) -- this port emits POSIX ustar; byte-level interop with oracle-produced .piesession files untested. |
| `packages/coding-agent/src/session-archive.ts:36` | session_archive.rs:179 (the `tar` crate) -- swap in the `tar` npm package if RULEBOOK §1's dependency whitelist ever grows one and this hand roll's robustness against pathological/huge/malformed archives needs to outgrow the size caps `readArchive` applies. |
| `packages/coding-agent/src/spinner.ts:159` | this is the second copy of `sleepUnref` in the package (`otlp.ts:341` is the first). Both are private; consolidating them into a shared util is a phase 19 de-duplication item, not a behavioural change. |
| `packages/coding-agent/src/tools/install-skill.ts:28` | wiring either would mean reaching into session-manager.ts / extensions-runner.ts, both outside this unit's file scope. Instead: - "hot reload" is approximated by recomputing the on-disk skill catalog immediately after the write (`reloadSkillCatalog`, below) purely to populate the tool RESULT fields  |
| `packages/coding-agent/src/tools/remove-skill.ts:25` | not written here -- `audit_entry_id` is always `undefined` -- see `./set-skill-state.ts`'s module doc for the same architectural reason (no session-append hook reachable from `ToolDefinition.execute`). |
| `packages/coding-agent/src/tools/set-skill-state.ts:29` | not written here -- `audit_entry_id` is always `undefined` -- for the same reason `install-skill.ts` documents: `ToolDefinition.execute`'s `ExtensionContext` exposes only a read-only `sessionManager`, with no append/write hook reachable from tool execution in this port's architecture. |
| `packages/coding-agent/src/tools/skill-builder.ts:234` | revisit if/when a builtin-skill source is introduced. |
| `packages/coding-agent/src/tools/skill.ts:42` | (no session-audit-write hook reachable from `ToolDefinition.execute`'s `ExtensionContext`) -- both are re-affirmed here for `SetSkillState`/`RemoveSkill` rather than re-litigated. |
| `packages/coding-agent/src/triggers/dynamic.ts:550` | test-only affordance, not present on the oracle's `NotificationHook` trait — see cron.ts's `CronNotificationHook.stop()` for the identical rationale (no ambient task-cancellation for an arbitrary infinite loop the way tokio's supervisor cancels a spawned task). |
| `packages/coding-agent/src/ui/app-render.ts:20` | terminal painter for {@link Frame}. |
| `packages/coding-agent/src/ui/feed.ts:228` | identical to the module-private `rustLines` in `src/tui.ts:145-151`, which does not export it. Deduplicating means touching `tui.ts`, which is frozen for this phase (parity S1); flagged to the orchestrator for a later consolidation into a shared string util. |
| `packages/coding-agent/src/ui/index.ts:231` | the painter — see `./app-render.ts`. |
| `packages/coding-agent/src/ui/index.ts:425` | oracle's `catalog()` also consults `AuthStore::load()`; this default probes only the environment, so a provider credentialed solely through the auth store renders `no key`. Inject `AppConfig.catalog` to close that. |
| `packages/coding-agent/src/ui/kernel.ts:158` | stand-in for oracle's `harness.agent().is_streaming()` (kernel.rs:88-90). The ported `AgentHarness` keeps its `phase` field private and exposes no accessor, and the bare `Agent` it drives is not reachable from the harness at all. Counting the turns this kernel itself has in flight reproduces the ONE |
| `packages/coding-agent/src/ui/relay.ts:621` | three details that cannot be diffed byte-for-byte against the crate in this repo (cargo is denied here): 1. Versions are capped at 10 (213 bytes at level M) instead of the crate's 40. Every URL this call site produces is `<base>/session/<40 hex>/` — 71 bytes for both the default `https://pie.0xfefe. |
| `packages/coding-agent/src/ui/terminal-driver.ts:21` | thread `InputArea.cursor()` through `Frame` to place it exactly. |
| `packages/coding-agent/src/ui/web.ts:301` | the oracle channel is bounded at 128 and a slow subscriber that falls behind gets `RecvError::Lagged(_)` — `events()` (web.rs:695) then *skips* the dropped snapshots and continues from the newest one. A listener set has no backlog and therefore never lags, so every subscriber sees every snapshot. Th |
| `packages/coding-agent/src/utils/clipboard-image.ts:438` | oracle relies on the `image` crate to reject zero-sized PNGs; the exact Rust error text is unverified, so take the most conservative branch and reuse the encode context. |
| `packages/coding-agent/test/config-paths.test.ts:141` | at parseTriggerPollIntervalSecs): oracle's own field is `u64`, so it accepts this value; JS cannot carry it losslessly, so TS rejects it loudly rather than rounding. Only pie's *own* fields are affected -- unknown keys above stay tolerated, which is the case oracle's "unknown sections and keys are i |
| `packages/coding-agent/test/install-skill.test.ts:341` | oracle also asserts `audit_entry_id` is set (persistent session audit). No session-append hook is reachable here; see module docs. Document the gap explicitly rather than silently dropping the assertion. |
| `packages/coding-agent/test/skill-builder.test.ts:20` | at that site in skill-builder.ts. |
| `packages/coding-agent/test/tools.test.ts:539` | that previously documented the missing knob. |
| `packages/mcp/src/protocol.ts:12` | if a parity gap surfaces around malformed/absent fields in a live MCP server response, add typebox validation at the `McpClient.request` deserialize site (client.ts) rather than here. |
| `packages/mcp/src/protocol.ts:56` | above), so nothing would otherwise apply that default — `McpClient` (client.ts) calls this at the response-parsing boundary (`toolsList`) so the field's static type (`unknown`, always present) matches what actually lands in memory at runtime. |

## U — residual differences at the boundary of language semantics, not observable by the judge (16 items)

**LOW — argued through; changing them is not advised.** The boundary between Rust and JS semantics: how serde prints numbers, how chrono formats, and Unicode segmentation and surrogate pairs. Not observable by the judge, and most already have a matching ED entry in `migration/parity/explained-divergences.tsv`. Changing them would only introduce fresh inconsistency.

| site | note |
|---|---|
| `packages/coding-agent/src/core/auth-storage.ts:359` | pie: crates/coding-agent/src/auth.rs:60-70 (`AuthStore { version, providers }` with a `#[serde(tag = "kind")]` tagged-union credential) -- this port keeps pi's flat `Record<provider, AuthCredential>` shape, so this parse (and `persistProviderChange`'s `JSON.stringify` below) reads/writes a different |
| `packages/coding-agent/src/core/slash-commands.ts:297` | Rust's `char::is_whitespace` is the Unicode `White_Space` property; JS's `\s` additionally matches U+FEFF. The two disagree only on that one code point, in a spec whose separators are ASCII in practice. |
| `packages/coding-agent/src/lsp.ts:483` | serde_json also rejects `0.0`/`1e2` for a `u32` (they carry f64 in the parsed `Value`, and `visit_f64` on an integer visitor is an error) whereas `JSON.parse` erases the lexical form -- both arrive here as the integer `100`. Closing that would take a form-preserving JSON parser; no LSP server emits  |
| `packages/coding-agent/src/model-picker.ts:24` | the WebUI half of oracle's "TUI overlay and web dropdown" (issue #223) is a phase 15 unit. Oracle `#[derive(Serialize)]`s {@link ModelEntry} and {@link ProviderGroup} with serde's default field naming, so the JSON the web dropdown receives uses `provider` / `has_credential` / `models` / `id` / `name |
| `packages/coding-agent/src/tools/web-search.ts:73` | no oracle test exercises malformed per-field types, so exact serde-reject-on-type-mismatch fidelity for those leaf fields is deferred. |
| `packages/coding-agent/src/triggers/cron.ts:962` | chrono AutoSi renders up to 9 ns digits; JS Date is ms-bound. |
| `packages/coding-agent/src/tui.ts:190` | two residual divergences with no observable site today. (1) serde_json prints a whole-valued `f64` as `1.0` where `JSON.stringify` prints `1` — tool arguments reach this function as parsed JSON, so integers agree, but a float literal like `1.0` would differ. (2) `undefined` has no `serde_json::Value |
| `packages/coding-agent/src/tui.ts:209` | JS reorders integer-like keys (`"0"`, `"1"`, …) ahead of string keys; an argument object keyed by numeric strings would take a different first three. No tool in this repo emits such arguments. |
| `packages/coding-agent/src/tui.ts:416` | oracle's `AgentListener` is `Arc<dyn Fn(AgentEvent, CancelToken) -> BoxFuture>`; the cancel token is ignored by this listener and the body is synchronous, so the ported shape is a plain sync callback. The unit that wires the renderer into a run loop picks the final callback type — nothing consumes t |
| `packages/coding-agent/src/ui/feed.ts:88` | oracle's `TextDelta(String)` / `ThinkingDelta(String)` are newtype variants holding a bare `String` under an *internally tagged* representation — `serde_json` errors at runtime on those ("cannot serialize tagged newtype variant containing a string"). No oracle site ever serializes a `FeedUpdate` (on |
| `packages/coding-agent/src/ui/feed.ts:194` | one residual divergence, unreachable from feed content today — Hangul jamo medial vowels / final consonants (U+1160–U+11FF) are width 0 in `unicode-width` and 1 here. |
| `packages/coding-agent/src/ui/feed.ts:272` | chrono prefixes years outside 0..=9999 with an explicit sign; `padStart` does not. Unreachable from `Local::now()` or from any session timestamp. |
| `packages/coding-agent/src/ui/web.ts:736` | JS reorders *integer-like* string keys ahead of the rest, so a payload with keys such as `"2"`/`"10"` would render in a different order than the oracle. No known payload producer emits numeric keys, so this is recorded rather than worked around. |
| `packages/coding-agent/src/ui/web.ts:893` | Rust additionally renders IPv4-compatible/-mapped addresses with a dotted tail (`::ffff:127.0.0.1`). Only reachable inside the rejection message for a non-loopback v6 host, so it is recorded rather than implemented. |
| `packages/mcp/src/client.ts:91` | JSON.parse collapses 1.0/1 — serde Float-vs-U64 distinction unreachable (ED4) |
| `packages/tui/src/components/markdown.ts:907` | a JS string can carry a lone surrogate, which a Rust `&str` cannot represent at all, so pie defines no behaviour for that input. `TextEncoder` substitutes U+FFFD for it on the way in, which is the conservative choice (lossy but never throwing); revisit if a caller ever feeds this renderer unpaired s |

## W — cross-unit wiring to do, removed or repointed once another unit lands (43 items)

**LOW — internal tidiness.** Temporary bridges between units: stub types, duplicated private helpers, and waits for some public accessor to land. No behavioral impact. The phase 19 diff review absorbs some of them.

| site | note |
|---|---|
| `packages/agent/src/harness/agent-harness.ts:267` | add if a caller needs it` note. Added phase 10 by `coding-agent/triggers/dynamic` (oracle `crates/coding-agent/src/triggers/dynamic.rs:557-595` `before_trigger_action_hook`), which is the caller the TODO anticipated: at oracle @0a120dfd dynamic triggers' `promote_to_chat` still goes through this exa |
| `packages/agent/test/ported/harness-e2e.test.ts:2706` | un-skip together with the audit-write path. |
| `packages/coding-agent/src/core/sdk.ts:170` | route the TTY branch to `interactiveHook()` once the `coding-agent/tui` unit lands a consumer for `UiControlPlanePrompt`. Until then both branches deny — the conservative side of the same fail-closed contract the agent loop already applies when no hook is configured at all (agent-loop.ts:744-751). |
| `packages/coding-agent/src/core/slash-commands.ts:86` | what remains is the REPL *wiring* — replacing `modes/interactive/interactive-mode.ts:2517-2674`'s pi-shaped `if`-chain with `slash-dispatch.ts`'s `dispatch`, and switching the editor's autocomplete off base pi's {@link BUILTIN_SLASH_COMMANDS} onto this registry. That work was originally booked under |
| `packages/coding-agent/src/core/slash-dispatch-deps.ts:33` | once `AgentHarness` grows a public `session()` accessor (tracked by the identical TODO in `triggers/cron-deps.ts` and `goal-deps.ts`) and the ported `Skill` regains `source`, collapse {@link CommandHarness} onto the real class and delete the adapters. |
| `packages/coding-agent/src/core/slash-dispatch-session.ts:761` | drop once `AgentHarness` exposes a real public `session()` and the stand-in goes away. |
| `packages/coding-agent/src/core/slash-dispatch-skills.ts:42` | drop once `ToolDefinition.execute` makes `ctx` optional. |
| `packages/coding-agent/src/core/slash-dispatch-skills.ts:236` | move back inside the tools once they can reach the harness catalog. |
| `packages/coding-agent/src/core/slash-dispatch-triggers.ts:680` | export the cron one and delete this copy when the two units next move together. |
| `packages/coding-agent/src/core/slash-dispatch.ts:12` | wiring this dispatcher into the live REPL — replacing `modes/interactive/interactive-mode.ts:2517-2674`'s pi-shaped `if`-chain, and switching the editor's autocomplete off `BUILTIN_SLASH_COMMANDS` onto {@link registryWithBuiltins} — is NOT done here and is currently unowned: it was booked under the  |
| `packages/coding-agent/src/core/tools/truncate.ts:130` | pie: crates/coding-agent/src/tools/truncate.rs:29-51 (truncate_head) never breaks its scan -- once a line doesn't fit the byte budget it is *skipped*, not treated as a stopping point, so a later shorter line can still be appended (kept_lines can be non-contiguous with respect to the original line or |
| `packages/coding-agent/src/extensions.ts:36` | replace with the real trait-shaped slash command once manifest row `coding-agent/commands` (`crates/coding-agent/src/commands.rs` → `core/slash-commands.ts`, phase 13) lands. `extensions.rs` only ever *carries* `Arc<dyn SlashCommand>` values — it stores them in `ExtensionContribution.slash_commands` |
| `packages/coding-agent/src/extensions.ts:149` | switch the panic branch to `err instanceof InvariantError` once RULEBOOK §2.4's single `invariant(cond, msg)` helper exists in `@pie/agent-core` — it does not today (no `invariant`/`InvariantError` export anywhere in `packages/agent`), so the shape heuristic above is the most faithful mapping availa |
| `packages/coding-agent/src/goal-deps.ts:18` | once a real public `session()` accessor lands on `AgentHarness` (tracked by cron-deps.ts's identical TODO), delete this file and repoint goal.ts's import at the real type. |
| `packages/coding-agent/src/local-models.ts:14` | hoist {@link registerCustomModel}/{@link unregisterCustomModel}/{@link getCustomModel} into `packages/ai` when the `ai/models` unit lands its mutable-registry design, and make `ModelRegistry` read through it. Until then callers merge {@link LoadedLocalModels.models} into `ModelRegistry` explicitly.  |
| `packages/coding-agent/src/logging.ts:224` | switch to it once it does). |
| `packages/coding-agent/src/lsp.ts:346` | this RELAXES oracle's concurrency semantics -- oracle serializes diagnostics waiters behind `diag_rx: AsyncMutex<mpsc::UnboundedReceiver<...>>` (lsp.rs:60) via `self.diag_rx.lock().await` (lsp.rs:207), so a second concurrent caller waits for the first to return and then reads the NEXT push; here bot |
| `packages/coding-agent/src/main.ts:719` | fold each into its unit as it lands; this comment is the checklist. (`--list-sessions` / `--list-all-sessions` / `--delete-session` have landed — see `runSessionCliCommands`, dispatched below once `sessionDir` is known.) |
| `packages/coding-agent/src/triggers/cron-deps.ts:60` | reconcile with @pie/ai's typebox Tool<TSchema> (tracked outside this unit; not a phase-8 concern specifically — it's a pie_ai::Tool vs @pie/ai::Tool shape mismatch). |
| `packages/coding-agent/src/triggers/cron-deps.ts:93` | reconcile with @pie/agent-core's AgentTool<TParameters, TDetails> (see file header). |
| `packages/coding-agent/src/triggers/cron-deps.ts:100` | reconcile with @pie/agent-core's AgentToolUpdateCallback<T> (see file header). |
| `packages/coding-agent/src/triggers/cron-deps.ts:103` | reconcile with @pie/agent-core's AgentToolError (see file header). Rust: enum AgentToolError { Message(String), Other(...) } |
| `packages/coding-agent/src/triggers/cron-deps.ts:110` | reconcile with @pie/agent-core's AgentTool (see file header). Rust: tokio_util::sync::CancellationToken. cron.rs's four AgentTool impls all take `_cancel: CancellationToken` but never read it — AbortSignal stands in for the (currently unused) cancellation channel per Node idiom. |
| `packages/coding-agent/src/triggers/cron-deps.ts:116` | reconcile with @pie/agent-core's AgentTool<TParameters, TDetails> (see file header). |
| `packages/coding-agent/src/triggers/cron-deps.ts:144` | once it does, delete this section and repoint `writeToolCronControlAudit` at the real export. --------------------------------------------------------------------------------------- */ |
| `packages/coding-agent/src/triggers/cron-deps.ts:148` | replace once @pie/agent-core's AgentHarness exposes a public session-append surface. Only the `session().appendCustom(...)` surface cron.rs's `write_tool_cron_control_audit` needs is modeled. |
| `packages/coding-agent/src/triggers/cron-deps.ts:156` | replace once @pie/agent-core's AgentHarness exposes a public session-append surface. |
| `packages/coding-agent/src/triggers/cron-deps.ts:166` | replace once @pie/agent-core's AgentHarness exposes a public session-append surface. |
| `packages/coding-agent/src/triggers/cron.ts:906` | route to coding-agent logging unit (phase 13, manifest coding-agent/logging) |
| `packages/coding-agent/src/triggers/cron.ts:922` | route to coding-agent logging unit (phase 13, manifest coding-agent/logging) |
| `packages/coding-agent/src/triggers/cron.ts:1025` | replace with real CancellationToken wiring once the phase-8 supervisor exists. `stop()` is a test-only affordance not present on the oracle's `NotificationHook` trait — JS has no ambient task-cancellation for an arbitrary infinite loop the way tokio's supervisor cancels the spawned task, so tests ne |
| `packages/coding-agent/src/triggers/cron.ts:1162` | route to coding-agent logging unit (phase 13, manifest coding-agent/logging) |
| `packages/coding-agent/src/triggers/dynamic-deps.ts:49` | reconcile with @pie/ai's typebox Tool<TSchema> (tracked outside this unit; not a phase-10 concern specifically — it's a pie_ai::Tool vs @pie/ai::Tool shape mismatch, same as cron-deps.ts's identical TODO). |
| `packages/coding-agent/src/triggers/dynamic-deps.ts:68` | replace with @pie/agent-core export once the pie_agent_core::AgentTool trait vs. @pie/agent-core::AgentTool object-literal design question (see file header) is resolved. |
| `packages/coding-agent/src/triggers/dynamic-deps.ts:72` | replace with @pie/agent-core export (see file header). Rust: tokio_util::sync::CancellationToken. dynamic.rs's 4 AgentTool impls all take `_cancel: CancellationToken` but never read it — AbortSignal stands in for the (currently unused) cancellation channel per Node idiom. |
| `packages/coding-agent/src/triggers/dynamic-deps.ts:82` | replace with @pie/agent-core export once the design question above resolves. |
| `packages/coding-agent/src/triggers/tool-definitions.ts:27` | delete this module once `cron.ts`/`dynamic.ts` can implement the real `@pie/agent-core` `AgentTool` shape directly. |
| `packages/coding-agent/src/triggers/tool-definitions.ts:88` | bind the cell once that public surface lands. |
| `packages/coding-agent/src/ui/app-harness.ts:102` | give `AgentSession` a `continue()` (its `Agent` has `runAgentLoopContinue` underneath) and delete this. |
| `packages/coding-agent/src/ui/web.ts:44` | when `ui/index.ts` lands, re-point {@link PanelStatus} and {@link TurnResult} at it and drop the local declarations. The wire shapes below (everything reachable from {@link WebSnapshot}) are web.rs's own and stay here regardless. |
| `packages/coding-agent/src/ui/web.ts:1060` | oracle takes each receiver out of its `Option` exactly once (`self.feed_rx.take().expect("feed_rx taken once")`, web.rs:242-260) — a Rust ownership artifact with no TS analogue, so the queues are plain fields here. `prompt_display` is a free function in `ui/mod.rs:2172`; it is a member below so this |
| `packages/coding-agent/src/utils/clipboard-image.ts:467` | dimensions unavailable without a decoder; report 0x0 rather than dropping the attachment, since oracle always produces an attachment once the bytes decode. |
| `packages/coding-agent/test/ported/dynamic-trigger-e2e.test.ts:575` | re-port once a HOME-free fixture exists for the `$HOME/helloworld` assertion. |

## P — PERF(port), notes on performance trade-offs (7 items)

**LOW — a record, not a threshold.** The audit stated plainly that there is no fair performance baseline between the two sides, so these record a trade-off and set no threshold. `packages/mcp/src/stdio.ts` is the only entry in this bucket carrying real risk — upstream has a backpressure bound of 64 where this is unbounded — and phase 19 was asked to review it.

| site | note |
|---|---|
| `packages/ai/src/utils/vertex-adc.ts:21` | every call re-exchanges a fresh token (no oracle caller exists to mirror a caching policy against — vertex_adc.rs is never wired to a call site in oracle). A per-process cache keyed off the credentials file path, refreshed near `expiresAt`, would avoid hitting Google's token endpoint on every stream |
| `packages/coding-agent/src/cli/session-picker.ts:167` | materializes the code-point array for every line; a width-bounded scan would avoid that, but menus are at most a few dozen lines per frame. |
| `packages/coding-agent/src/core/tools/bash.ts:390` | unbounded in-memory accumulation, matching oracle's `String` sink (bash.rs reads the whole stream via `read_to_string`). A bounded/streaming variant (like the old single OutputAccumulator) would cap memory for pathological high-output commands; not done here to keep parity with oracle's simple model |
| `packages/coding-agent/src/session-archive.ts:502` | session_archive.rs:177-191 wraps the whole tar build + write in `tokio::task::spawn_blocking`. RULEBOOK §2.2 maps that row to a direct call, so the CPU-heavy half runs on the event loop: the `sha256Hex` above plus the `Buffer.concat` inside `buildTarArchive`, over a transcript capped at MAX_SESSION_ |
| `packages/coding-agent/src/session-archive.ts:766` | session_archive.rs:214 runs `read_archive` under `tokio::task::spawn_blocking`. RULEBOOK §2.2 maps that row to a direct call, so the synchronous `readFileSync` + full tar decode here (archive members capped at MAX_SESSION_BYTES = 50 MiB), and the `sha256Hex` over session.jsonl below, block the event |
| `packages/coding-agent/src/utils/clipboard-image.ts:372` | filter type 0 on every scanline and a single IDAT chunk; the Rust `image` crate picks adaptive filters, so byte-for-byte output differs. Only the decoded pixels are behavioral. |
| `packages/mcp/src/stdio.ts:75` | stdio.rs:50 uses a bounded `mpsc::channel(64)` for stdout backpressure; this channel is unbounded (no consumer-side pacing). Not exercised by any of the ported tests (small fixture frames only). Fast-version sketch: pause/resume `child.stdout` once the internal buffer exceeds 64 pending lines. |

## X — continuation lines and pointers back to another item (26 items, not independent work)

**Not applicable — counting noise.** An artifact of grep matching line by line: continuation lines within one comment block, or cross-references pointing back at another TODO in the same file. They are listed so that none of the 154 hits goes unaccounted for, but they are not independent work.

| site | note |
|---|---|
| `packages/ai/src/providers/anthropic.ts:818` | `ThinkingBudgets` (types.ts) has no `xhigh` field — xhigh is clamped to "high"'s budget upstream (clampReasoning), so it still resolves to 16384 instead of oracle's 32768. Can't close without widening the shared type; low-impact (xhigh is the rarest level). |
| `packages/coding-agent/src/cli/session-picker.ts:13` | ` on {@link pickerFrame}. |
| `packages/coding-agent/src/core/auth-storage.ts:26` | ` below): oracle's `resolve_for_provider` (auth.rs:129-143) checks the provider's env var BEFORE the stored `auth.json` credential ("env var wins; auth.json is the fallback", oracle's own doc comment). This file's `getApiKey` checks the stored credential first, env var as fallback -- matching the pr |
| `packages/coding-agent/src/core/auth-storage.ts:412` | see `parseStorageData`'s `TODO(port)` above -- the `JSON.stringify` below emits pi's flat `Record<provider, AuthCredential>`, not oracle's `{version, providers}` tagged union (auth.rs:60-70). ED14, phase 19. |
| `packages/coding-agent/src/core/sdk.ts:179` | coding-agent/tui)", |
| `packages/coding-agent/src/core/tools/edit.ts:62` | at the top of this file. */ |
| `packages/coding-agent/src/core/tools/edit.ts:491` | at the top of this file). |
| `packages/coding-agent/src/core/tools/edit.ts:494` | at the top of this file. |
| `packages/coding-agent/src/logging.ts:355` | `env_filter`'s span directives (`target[span]=level`) and field predicates (`[span{field=value}]`) are not implemented; such directives are skipped rather than approximated. |
| `packages/coding-agent/src/main.ts:152` | `cli_hooks` is always `false` here — `hooks.ts` (the `HookRunner`) has no importer in this repo, so the CLI never loads user hook files. That is a wiring gap of its own, not a decision this unit makes; the flag is threaded so closing it is a one-line change. |
| `packages/coding-agent/src/mentions.ts:72` | `read_to_string` rejects invalid UTF-8 with an error (producing the error block below), while Node substitutes U+FFFD and succeeds. Reproducing the Rust behaviour would mean reading bytes and validating them; left as the more permissive path because the oracle's own message text is unreproducible an |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:4251` | `commands::model_credential_hint`'s hint TEXT is not ported (only its predicate half, `providerHasCredential` in model-picker.ts), so a credential-less provider gets this repo's own post-switch auth warning path instead of oracle's inline hint line. |
| `packages/coding-agent/src/readline.ts:89` | ` defers the whole dispatch half to the `coding-agent/tui` unit. Only the `command` field is reachable from readline, so only that is reproduced here (oracle's `SkillShortcut` also carries `source` -- absent from the TS `Skill` type -- and a `preview_text(description, 72)`, both of which exist solel |
| `packages/coding-agent/src/triggers/cron-deps.ts:34` | `: once a real counterpart lands, delete the stub here and repoint cron.ts's import at the real module. |
| `packages/coding-agent/src/triggers/runtime.ts:22` | ).** `applyPromotion` (`agent_harness.rs:3022-3312`) — promoting a sub-agent summary into the parent chat needs the approval UI and the `PromoteAction` template renderer, neither of which exists on this side yet; `writeTriggerResultAudit`, which needs the harness's `Session::append_custom` surface t |
| `packages/coding-agent/src/triggers/tool-definitions.ts:20` | ` there). This module is the minimum bridge that lets the *existing* ports reach the product registry without pre-empting that decision: a mechanical, per-method projection onto `ToolDefinition`, exactly parallel to `core/tools/tool-definition-wrapper.ts`'s `createToolDefinitionFromAgentTool` (which |
| `packages/coding-agent/src/ui/app-harness.ts:107` | )", |
| `packages/coding-agent/src/ui/index.ts:396` | ` at kernel.ts:203-218, closed: the no-image `user_prompt_turn` runs inside oracle's own retry wrapper (`./retry-prompt.ts`), which takes exactly a harness + settings. |
| `packages/coding-agent/src/ui/index.ts:1455` | `rpassword::prompt_password` has no Node counterpart; this is the raw-mode equivalent (echo suppressed by never writing the typed bytes back). |
| `packages/coding-agent/src/ui/input-area.ts:5` | `tui_textarea` is a Rust crate with no TS counterpart, and RULEBOOK §1 admits no new dependency. `packages/tui`'s `Editor` (`components/editor.ts:217`) is not usable here: it is a `Component, Focusable` in pi's component tree and its constructor needs a live `TUI` — importing it would couple this RE |
| `packages/coding-agent/src/ui/retry-prompt.ts:16` | `, because the pi-shaped `AgentSession` cannot be built from a harness. This file closes that gap by porting the wrapper oracle actually uses, at the surface oracle actually uses it on; `ReplKernel.setUserPromptRunner` is the seam `ui/index.ts` installs it through. The retryable-error pattern is **n |
| `packages/coding-agent/src/ui/terminal-driver.ts:2` | `. |
| `packages/coding-agent/src/ui/web.ts:89` | `ui/index.ts` owns `App::finish_turn` and will fix this parameter's final shape; re-point this alias at it when that unit lands. |
| `packages/coding-agent/src/ui/web.ts:962` | `packages/coding-agent/package.json`'s `copy-assets` script does NOT copy `src/ui/web_index.html` into `dist/ui/`, so a built (non-`tsx`) install would fail here. Raised to the orchestrator rather than fixed — this unit must not edit `package.json`. |
| `packages/coding-agent/test/tools.test.ts:300` | at the top of edit.ts). `AgentTool.execute`'s signature is derived from `editSchema`, which deliberately does not describe that form, so each surviving batch call site widens through `unknown`. |
| `packages/coding-agent/test/tools.test.ts:1100` | at the top of edit.ts), which is why every call below is cast to BatchEditToolInput. |

## T — a test that depends on its environment rather than on behavior (1 item)

Found while proving the CI command sequence in a fresh clone. Not a defect in the product and not a
gap in the port — a test that asserts something about the machine it runs on without saying so.

| site | problem | severity |
|---|---|---|
| `packages/coding-agent/test/tool-execution-component.test.ts:352-384` | The `outside AGENTS.md` case builds its path with `resolve(process.cwd(), "..", "AGENTS.md")`, renders it at width 120, and asserts the rendered line contains `read resource <that absolute path>`. Whether it does depends on how long the checkout path is: at 65 characters (an ordinary checkout) and 66 (a GitHub runner) the line fits; at 142 (a clone under a deeply nested temporary directory) it wraps and the assertion fails. Measured on one commit: 20 of 20 pass at 31 characters, 1 fails at 142. The test means to assert the compact rendering, and the path length is incidental to that — a fixed-length placeholder path would say the same thing without depending on where the repository sits. | **LOW** — CI is unaffected today, because runner paths are short; it fails only for someone who clones somewhere deep |

## Z — defects found while fixing things in phase 18 that are **in no ledger** (3 items)

These three were met while fixing B1 through B13. None belongs in the BUG(port) ledger, which holds
only upstream's own defects, and none belongs in the buckets above, since they carry no `TODO(port)`
marker. They are recorded here so they do not disappear.

> **All three were fixed on 2026-08-04** (the table below keeps the original text as a record of the finding):
> 1. `faux.ts`'s usage is now computed by `finalizeUsage` in `src/usage.ts`, with
>    `uncachedInput = prompt - cacheRead - cacheWrite`, so each prompt token lands in exactly one bucket. Measured:
>    a turn with a fresh cache went from `input 8 / cacheWrite 8 / total 18` to `input 0 / cacheWrite 8 / total 10`,
>    and a warm turn from `total 28` to `19`. **No test expectation needed changing** — every affected assertion
>    was a loose one such as `toBeGreaterThan(0)`, or took an uncached path with no session. Not copying the
>    formula locally again is what closed the gap the two arithmetic drifts came through.
> 2. `amazon-bedrock.ts` only had its comment changed: AWS's `inputTokens` **excludes** the cache buckets,
>    and its totalTokens is already the sum of the four (AWS's own prompt-caching example is 4 + 106 + 2349 = 2459),
>    so the arithmetic in the code was always right. The same wrong premise in
>    `test/bedrock-usage-and-stop-reason.test.ts` was corrected with it; the `210` assertion and every `expect` are
>    untouched, and `totalTokens: 110` in the fixture is now noted as **deliberately** inconsistent with the four
>    buckets, to separate "derived from the parts" from "trusting the reported field".
> 3. `CronRegistry.setJobEnabled` now builds a new entry (`{...current, enabled, running_trace_id}`) rather than mutating a clone in place.

| site | problem | severity |
|---|---|---|
| `packages/ai/src/providers/faux.ts:214-240` | The fixture provider **double-counts a fresh prompt**: with no cached prefix, `cacheWrite = promptTokens` while `input` is also `promptTokens`, giving `total = 2×prompt + output`; with a cached prefix, `input = max(0, prompt - cacheRead)` and `cacheWrite = tokens(uncached suffix)` count the same tokens twice. This is a fixture rather than an upstream API mapping, so it is not in the ledger — but it feeds a set of harness expectations, and changing it would change those with it. | **MEDIUM** — affects only how much the numbers on the fixture path can be trusted |
| `packages/ai/src/providers/amazon-bedrock.ts:477-479` | The comment **states an incorrect fact about the AWS API**: "AWS defines totalTokens as input+output only … double-counting cache tokens into the total". AWS's own prompt-caching example is `inputTokens 4 + outputTokens 106 + cacheWrite 2349 = totalTokens 2459` — `inputTokens` excludes the cache buckets, so the arithmetic here **was always correct** and is not a bug-for-bug reproduction. Correct code with a lying comment is the combination most likely to fool the next person. `packages/ai/test/bedrock-usage-and-stop-reason.test.ts:5-7,79` repeats the same wrong premise (its `210` assertion happens to still be right, for the wrong reason). | **MEDIUM** — the comment is the trap; handled in the phase 19 diff review |
| `packages/coding-agent/src/triggers/cron.ts` (`CronRegistry.setJobEnabled`) | Mutates the cloned entry in place (`next[pos].enabled = enabled`) rather than building a new object. Safe today, since `next` is a freshly cloned array, but it breaks this repository's immutability rule and would become a hidden side effect the moment someone replaced the clone with a shared reference. | **LOW** |

## Y — BUG(port) ledger rows phase 18 did **not** fix (8 items, argued one by one)

The ROADMAP lists six deliverables for phase 18, and the rows below are not among them. Each carries a
reason and a suggested priority — "not on the delivery list" is a decision about scope, not a
statement that nothing is wrong.

| id | defect | why it was not fixed this round | suggestion |
|---|---|---|---|
| **B12** | The Responses stopReason mapping distinguishes only `"incomplete" => Length`, and everything else — **including the `failed` and `cancelled` the API reports explicitly** — maps to `Stop`. A failure or a cancellation appears in the session and the interface as a normal ending | not among the six deliverables | **The one most worth fixing first.** It leaves the user, and the model itself, unable to tell "finished speaking" from "blew up", and it is written into the persistent transcript |
| **B17** | Transcript replay wraps `preview(...)`, which already adds parentheses, in `"⚙ {}({})"`, so replay renders `⚙ read((path="/tmp/x.rs"))` with doubled parentheses while the live path renders one layer. The same tool call looks different on the two paths | as above | **Second priority.** Unlike B14, B15 and B16, it is **observable by the judge** (the first screen of `--resume`) and is a live, user-visible surface |
| **B7** | `/cron remove` does not delete the corresponding `loop-<id>.md` state file, although the documentation says it does | as above; the same file as B6 but a separate behavior | Low. It leaves an orphan file, with no security impact |
| **B10** | The comment in `task.rs` says "max 16 iterations" while the construction chain imposes no iteration limit at all | as above | Medium. The comment contradicts the implementation, and "no limit" is itself worth a product decision — this is not purely a documentation matter |
| **B11** | The MEMORY.md index is kept up to date but the startup injection never reads it; **every body** other than MEMORY.md is concatenated into the system prompt **without bound**, with no cap on count, characters, relevance or project boundary | as above | Medium. It consumes context and tokens linearly as memory grows, so it gets worse over time |
| **B14** | A renamed layer in `otlp.rs` never spawns a flush pumper, so spans queue forever and are never exported | as above; **unreachable on both sides**, with no caller upstream and none here | Low. Before fixing it, establish whether it ought to have a caller at all |
| **B15** | `bytes[i] as char` in `markdown.rs` is Latin-1 widening, so each non-ASCII byte outside an inline span becomes its own U+0080..U+00FF scalar | as above; unreachable on both sides (`#![allow(dead_code)]`, with no caller in the crate) | Low |
| **B16** | An ATX heading swallows the space between `#` and the text, and the heading text never goes through `render_inline` | as above; unreachable as with B15 | Low |

## W2 — questions of scope found in phase 19 and left for the user to decide (3 items)

| matter | situation | why it was not decided here |
|---|---|---|
| whether to keep publishing the `pi-ai` CLI | `packages/ai` carries `bin: {"pi-ai": "./dist/cli.js"}`, which **upstream has no counterpart for** (`crates/ai` has no `src/bin` and no `[[bin]]`), and nothing in the repository imports or tests it. The security defect where it wrote an OAuth token into the cwd was fixed in phase 19; what remains — whether to publish an extra binary the skeleton brought along — is a question of scope | removing a declared `bin` is a product decision, not a hardening action |
| TypeScript starts in about 860ms where upstream takes about 7.5ms | Measured in `migration/reviews/phase19/perf-baseline.md`: Node itself accounts for about 4% (34ms) and the remaining 96% is the application module graph — printing a version number loads **1,608 scripts and 9.65 MiB of JS** (668 files of typebox, 193 of highlight.js, 108 of undici). `cli.ts` is a static ESM entry point with no lazy path, so even `--version` pays for the whole HTTP stack and the syntax highlighter | making the entry point lazy is a real architectural change needing regression verification of its own, and the audit states plainly that there is no fair baseline between the two sides, so no threshold is set |
| three dependencies with DoS advisories reaching the published package (`ws`, `protobufjs`, `brace-expansion`) | all pinned inside the dependencies of `@google/genai`, `openai` and `@mistralai/mistralai` | raising any one of them alone means moving a vendored SDK to a new major version, which is a change of its own and does not belong at the moment of the final audit. See §2.2 of `migration/reviews/phase19/security-sweep.md` |

## L — problems only a real provider can expose (phase 19, `npm run test:live`)

A hermetic `npm test` skips all 776 credential-gated cases. Releasing `GEMINI_API_KEY` unfroze 30 of
them, and **the first run caught two defects** — both of which hermetic mode would never expose.
Both fixed; what is recorded here is the category and what remains.

| matter | status |
|---|---|
| the skip guard in `cross-provider-handoff.test.ts` used `hasAnyApiKey()`, at least one, to guard an assertion needing at least two providers | **fixed** (`hasAtLeastTwoApiKeys()`) |
| two tests hard-coded the retired `gemini-2.0-flash`, for which Google returns 404 "no longer available" | **fixed** (moved to `gemini-2.5-flash`) |
| **`pie --list-models` still recommends the retired `gemini-2.0-flash` to users** | **Not fixed; needs a product decision.** The catalog is upstream's frozen snapshot, pinned byte for byte by parity S1 (`Supported providers (32), models (938)`). Fixing it breaks S1's byte agreement — a real conflict between reproducing upstream faithfully and being correct for the user today. The same ailment as bucket V, where hard-coded literals rot over time, except that this one **is already rotting** rather than about to |
| `context-overflow.test.ts` cannot pass on this account | **Environmental.** It has to send input larger than the model's 1M context to trigger an overflow, while the account quota is exactly 1,000,000 tokens per minute — so a quota 429 necessarily arrives before the context error. The case implicitly requires the account quota to exceed the model's context window, and it is worth separating "quota exhausted" from "overflow detection error" inside the test, or it is a false red on any quota-limited account |

## C — gaps in the CLI parser (found while fixing F9 in phase 19; not fixed)

While fixing F7 through F15, comparing surface by surface against upstream turned up four more, none
of which is a matter of changing an exit code; each needs real parser work. Reported item by item
rather than left in silence:

| matter | measured | why it was not fixed |
|---|---|---|
| **the `--long=value` form, such as `--thinking=high`, is not parsed here at all** | before the fix it was silently discarded with exit 0; after, exit 2 but with the message `unexpected argument '--thinking' found` where upstream says `invalid value 'high'` | the exit code is aligned and is strictly better than silent discard, but `--long=value` is a **gap in parser capability** rather than an exit-code site. **This is the one most worth closing first** — `--flag=value` is the standard spelling and users will type it |
| `pie --list-sessions --no-such-flag` | exit 0 here, exit 2 upstream | Structural: an unknown long flag can only be classified once the extension directory has loaded, and a session command returns before that — the same ordering upstream has. Fixing it means reordering startup |
| `pie --resume-id x --resume-id y` | upstream says `error: the argument '--resume-id <ID>' cannot be used multiple times` and exits 2; this port takes the last one | detecting a repeated option is a new parser feature |
| `pie --list-sessions extra` | upstream says `error: unrecognized subcommand 'extra'` and exits 2; this port treats it as a positional prompt | a declared skeleton superset, recorded at the head of `cli/args.ts` |

## Two kinds of thing that are not in this list

- **The BUG(port) ledger, B1 through B17** — see §5 of `migration/RULEBOOK.md` and `migration/parity/intentional-divergences.md`. Phase 18 fixed six groups; the rest are argued item by item.
- **Explained divergences ED1 through ED25** — see `migration/parity/explained-divergences.tsv`. Architectural differences not observable by the judge, argued through and closed; not work to do.
