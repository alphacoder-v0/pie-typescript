# Translation Rulebook — Rust (pie @0a120dfd) → TypeScript (onto pi skeleton @4868222e)

> **The meta-rule: if two agents could answer a question differently, the answer goes in this file.**
> Every implementer, reviewer and fixer reads this file in full before touching code. It is read-only
> inside a loop: revisions queue up, and the orchestrator applies them at a phase boundary and records
> them in the Deviation log at the end.

## 0. Scope and posture

- This is the **redesign variant** of the migration (the kit README's "If you're redesigning"), not a
  file-by-file syntactic translation. A unit of work is one row of `migration/manifest.tsv`, at module
  or subsystem level. There are three kinds:
  - **diff-port**: start from the skeleton file at base_path and lay pie's behavioral differences on
    top. Code style, error conventions and the shape of exports **follow the base file**; change only
    what diverges, and do not reorder code that does not.
  - **port**: a capability only pie has, translated from Rust in full into out_path, with constructs
    mapped according to §2.
  - **char-tests**: translate the corresponding Rust tests into vitest or node-test characterization
    tests, asserting upstream behavior, defects included.
- **The target for behavioral alignment is bug for bug**: upstream, the Rust pie, is the only
  specification. Where its documentation and its implementation disagree, the implementation wins.
- **tsc is dissolved into the unit loop** (the kit's Step 4 dissolve): every completed unit must have
  `tsc` at zero errors. The kit's default that drafts need not compile **does not apply** to this
  migration. The full `npm test` and `npm run check` run only at phase boundaries.
- The first pass optimises for **a correct translation** rather than performance: a translation known
  to be slow but faithful gets one `PERF(port):` line sketching the fast version, and work continues.

## 1. Ecosystem adoption — what is adopted and what is banned (the dependency allowlist)

The default is **NONE without a rule here**. Every new dependency needs a row in this table.

| area | decision | reason |
|---|---|---|
| runtime | Node ≥24 with npm workspaces; product code may not use Bun-only APIs (the skeleton's bun/ directory is left exactly as it is) | matches the skeleton upstream, and the local environment |
| HTTP client | the global `fetch` (undici) plus AbortSignal; no new axios, got or similar | the skeleton already works this way; Rust's `reqwest`, at 77 sites, maps onto fetch one site at a time |
| SSE parsing | keep the skeleton's dependency on `eventsource-parser`; pie's hand-written `utils/sse.rs` is **not ported**, being absorbed by that dependency | the upstream file header says so itself: "the TS side depends on eventsource-parser". Any behavioral difference that shows up in parity is handled site by site |
| AWS signing and eventstream | keep the skeleton's SDK route; pie's hand-written `sigv4.rs`, `event_stream.rs` and `utils/aws_eventstream.rs` are **not ported** | as above, upstream says the TS side gets this from the SDK for free; Bedrock's behavioral differences are laid on top of the skeleton's provider file |
| retry | pie's `utils/retry.rs` **is ported**, landing at `packages/ai/src/utils/retry.ts` (ai is a leaf package in the dependency direction and must not import agent-core in reverse — decided 2026-08-03, resolving a contradiction between §1, §4 and the manifest): the skeleton's provider layer has **no retry at all**, so the whole retry utility is a pie addition (the retryable set is 408, **409**, 425, 429 and 5xx, where 409 is there for DS4) | it carries behavior and cannot be absorbed |
| validation | keep the skeleton's typebox (utils/typebox-helpers.ts) | skeleton convention |
| TOML (.pie/mcp.toml, lsp.toml) | add `smol-toml`, which has no dependencies of its own and ships types | the skeleton has no TOML need; a hand-written parser is not worth it |
| the MCP protocol | `@pie/mcp` uses Node built-ins (child_process and stdio, fetch and HTTP) plus hand-written JSON-RPC framing, and **does not pull in @modelcontextprotocol/sdk** | pie's Rust mcp crate is itself a lightweight hand-written 1.9k lines, and reproducing it bug for bug requires control over framing behavior |
| cron expressions | port pie's hand-written parsing and tick logic, and **do not pull in a cron library** | it carries behavior: the 30s tick, skipping overlaps, and not catching up on missed runs |
| the event bus | use the skeleton's `core/event-bus.ts` pattern; no new uses of Node's EventEmitter | one consistent skeleton convention |
| tests | vitest for ai, agent and coding-agent; node --test for tui and workers — following what each package already does | skeleton convention |
| logging | follow whatever logger each skeleton package already has; no new console.* on product paths (TUI output and CLI stdout are the exception) | cleanliness |

## 2. Constructs with no equivalent — one mapping per construct

> An implementer inventing a second mapping for a construct in these tables is in violation; a
> reviewer seeing a construct that is not in them reports it so a row can be added.
> The list of sites is in `migration/inventory.tsv` — for grepping, not for reading through.

### 2.1 Types and data

| Rust construct | the one TS mapping | notes and evidence |
|---|---|---|
| `struct` | `interface`, with a typebox schema at the wire boundary | follows the shape the base file already has |
| a data-carrying `enum` | a tagged discriminated union whose tag field matches the wire name in serde's `tag =`, at 19 sites, exactly | the wire format is law |
| a unit-only `enum` | a string literal union | |
| `#[serde(untagged)]`, 3 sites | a union, parsed candidate by candidate in the order Rust defines them | the order changes what parses |
| `Option<T>` | `T \| undefined`, except for fields that serialize as null, which keep null | the skeleton's convention is undefined |
| `Result<T,E>` | throw, catching where Rust's `match` or `?` propagation ends. A diff-port unit follows the error conventions its base file already has | see §2.4 |
| a trait | an `interface`; a trait object becomes a value of that interface type | |
| `u64`, `usize`, `i64` | `number` — token and byte counts are below 2^53 in practice | 135, 291 and 27 sites |
| `u128`, 5 sites: otlp nanosecond timestamps, oauth pid mixing, the backoff exponent | `bigint` for otlp and oauth; the backoff clamp at `agent_session.rs:215` uses `Math.min` with number, which is safe in range | site by site in the inventory |
| `f64` | `number` | |
| `Vec<u8>` and bytes | `Uint8Array`; a Node Buffer appears only at a Node API boundary and is converted immediately | |
| `PathBuf` and `Path` | `string` plus `node:path` | |
| `#[serde(rename_all)]`, 42 sites, and `skip_serializing_if`, 63 | TS object field names are wire names; an omissible field uses `undefined`, which JSON.stringify drops naturally, and **never null instead** | enforced by parity S6 |
| `format!` and `Display` | a template literal, matched character for character against upstream output; user-visible text goes into parity | |
| `{:?}` Debug output | `util.inspect` for logs; anything entering user-visible or persisted text matches upstream verbatim | |

**Case in discriminators (added 2026-08-04, phase 15)**: a serde-derived tag uses the wire name. **A
discriminator that is not serde-derived** — the `kind` of an internal tagged union, say, where either
spelling is equally faithful to upstream — **also uses snake_case**, symmetric with the switch sites.
What prompted it: `QueuedTurn.kind` in `ui/kernel.ts` has no serde derive, the rulebook said nothing,
and two agents working in parallel changed it back and forth three times in one round before each
settled. **When two agents would answer the same unstated question differently, the answer belongs in
the rulebook.**

### 2.2 Concurrency (tokio to Node's single-threaded event loop)

| Rust construct | the one TS mapping | notes |
|---|---|---|
| `tokio::spawn`, 61 detached sites | `void fn().catch(err => reportDetachedError(ctx, err))` through the single helper `detach()` at `packages/agent/src/harness/detach.ts`; **no inline await**, which would turn concurrency into serial work | keeps the detached semantics, and errors go where upstream sends them: a failed detached subagent reaches the audit and the summary |
| `tokio::spawn` with `JoinHandle.await`, 4 sites | keep the Promise and await it at the join site | |
| `tokio::task::spawn_blocking`, 11 sites | call it directly as async; mark `PERF(port):` if it is CPU-heavy | Node has no blocking pool |
| `mpsc::unbounded` and `bounded`, 72 sites | the single utility `AsyncQueue<T>` at `packages/agent/src/harness/async-queue.ts`, with `push`, `await next()` and `close`; a bounded capacity is implemented only where it carries behavior | the trigger runtime's unbounded semantics are reproduced bug for bug |
| `oneshot`, 15 sites | `Promise.withResolvers<T>()` | |
| `select!`, 36 sites | `Promise.race` with the losers cancelled through an AbortController, via the single helper `select2`/`selectN` in the same directory. Rust's random fairness in select! is not reproduced, so **order-sensitive behavior must be pinned by a characterization test** | the main area of timing risk; see risk 1 in THINKING |
| `tokio::time::timeout` (a construct outside the tables; row added in phase 12) | every timeout comes from `AbortSignal.timeout(ms)`. ① Waiting on an `AsyncQueue` or `Signal`: pass the signal straight to `next(signal)` or `wait(signal)`. ② Waiting on an ordinary Promise: use `selectN` or `select2`, where the timeout branch's `run(signal)` uses a timer and clears it when its own signal fires, and select aborts the losers. **Never hand-roll `new Promise` with `setTimeout` and `Promise.race`** — it leaks the timer, skips cancelling the loser, and sidesteps the single-helper constraint of the select! row | reviewer C in phase 12: three different mappings appeared within one batch |
| `broadcast`, 6 sites | the skeleton event-bus pattern, a listener set | |
| `Notify`, 5 sites | the `Signal` utility, a promise chain, in the same file as async-queue | |
| `Mutex<T>`, 92 sites | one criterion decides it: a critical section that **crosses an await** uses the single `AsyncMutex` utility in the same directory; one that does not cross an await uses direct field access, atomic on a single thread | the criterion is mechanically checkable site by site |
| `RwLock`, `watch`, Atomic | not applicable, 0 sites | |
| `Arc<T>` and `Arc<Mutex<T>>` | an ordinary object reference, and a shared instance | |
| `block_on`, 3 sites | make it async all the way to the call root; at a synchronous entry point such as main, use a top-level await | |

### 2.3 IO and the system

| Rust | TS | notes |
|---|---|---|
| `tokio::fs`, 112 sites, and `std::fs`, 85 | `node:fs/promises`. A synchronous API is authorised in two cases only: ① the caller is strictly synchronous (the CLI startup path); ② **faithful synchrony** — where the upstream site is a `parking_lot::Mutex` or synchronous critical section together with `std::fs` rather than `tokio::fs`, and its atomicity depends on running synchronously, the TypeScript side stays synchronous. The mechanical criterion is that `parking_lot::Mutex` and `std::fs` co-occur. The comment at the site cites this row | revised 2026-08-03, pilot B |
| `tokio::process` and `Command`, 22 sites | spawn from `node:child_process`, through the skeleton's `utils/child-process.ts` helper; **a leaf package such as mcp must not import coding-agent in reverse and instead uses node:child_process directly** (revised 2026-08-03) | |
| **Node built-ins inside `packages/ai` and `packages/agent`** | **no static import**: these two packages are inside the browser bundling surface (`scripts/check-browser-smoke.mjs` bundles with esbuild at `platform:"browser"`), and any statically visible `node:` specifier fails the bundle. Three compliant alternatives, in order of preference: ① use a web standard API instead (SHA-256 from `node:crypto` becomes `crypto.subtle.digest`, byte-identical on both sides — see agent-loop.ts and agent-harness.ts); ② use an npm package instead (the skeleton's `utils/node-http-proxy.ts` uses http-proxy-agent rather than node:http for exactly this reason); ③ a dynamic `import()` through a variable specifier (see `packages/ai/src/utils/vertex-adc.ts` — note that a literal `import("node:fs")` is still resolved statically by esbuild, so it has to go through a variable). **Neither tsgo nor vitest on a single package can find this; only the root `npm run check` catches it** (revised 2026-08-03, after phases 7 and 8 each hit it once) | |
| `SystemTime::now` | `Date.now()`; `Instant` becomes `performance.now()`; nanoseconds become `process.hrtime.bigint()` | |
| signals and TTY | follow what the skeleton's `modes/interactive` and the tui package already do | |
| environment variables | `process.env.X`, keeping the name verbatim, with the `PIE_*` and `PI_*` prefixes as upstream has them | |

### 2.4 Errors and panics (guard semantics)

| Rust | TS | guard label (the inventory column) |
|---|---|---|
| `panic!`, 77 sites; `.unwrap()`, 692; `.expect(`, 185 | the single helper `invariant(cond, msg)` in agent-core, which throws `InvariantError`; **crash that operation** and never degrade silently | allocation-guard |
| `Result::Err` propagation (`?`, across 427 Result sites) | throw, catching where the Rust match ends; the error classification is preserved, with each thiserror variant becoming an Error subclass carrying a `code` field | precondition-guard |
| `anyhow::Context`, 78 sites | a chain of `new Error(msg, { cause })` | precondition-guard |
| The two kinds of guard **must not share one catch-all**: an allocation-guard aborts the operation, while a precondition-guard records the error and returns whatever partial result upstream returns | | the kit's error-recovery rule |

## 3. The sanctioned escape hatch

A translation that cannot be expressed safely has exactly one pressure valve, and it has to be visible:
- `TODO(port): <open question>` — UNKNOWN is a legitimate answer: take the most conservative
  translation, preferring a throw over silence, mark it, and continue.
- `PERF(port): <fast version sketch>` — slow but faithful.
- `BUG(port): <ledger-id>` — see §5.
All three kinds of marker have to reconcile with `migration/parity/test-ledger.tsv` and the BUG
ledger, which the phase acceptance greps for.

## 4. Where pie's additions land (the redesign design section)

- **The one legal dependency direction**: `coding-agent → agent-core → ai`; `mcp` is a standalone
  leaf package, referenced only by coding-agent; `tui` is referenced only by coding-agent. Never the
  reverse.
- **out_path for a port unit**: mirror the Rust relative path in kebab-case under the corresponding
  package's src/. The manifest has this fixed, and curated exceptions follow the manifest.
  TriggerRuntime, cost, permission and trigger land in `packages/agent/src/harness/`; triggers,
  loops, inbox and goal land in `packages/coding-agent/src/`.
- **New shared concurrency utilities** are four files and no more: `detach.ts`, `async-queue.ts`
  (which holds Signal), `async-mutex.ts` and `select.ts`, all under
  `packages/agent/src/harness/`, imported by the other packages — a second implementation is a
  violation. **The leaf-package exception** (revised 2026-08-03, following mcp and retry): a leaf
  package upstream of agent-core in the dependency direction (ai, mcp) must not import in reverse,
  so the minimum necessary local concurrency primitive is allowed inside the package, under
  `src/internal/` or utils/. Its shape must not collide by name with the four utilities, and
  phase 19 reviews the deduplication opportunities together.
- **Discipline for diff-port changes**: lay the smallest semantic difference on top of the base file.
  Every point where pie diverges needs an inline `// pie:` comment citing the upstream file and line,
  so a reviewer can compare. That comment marks a behavioral contract; it is not explanatory noise.
- **The mandatory probe gate for wire-construct units** (revised 2026-08-03, the lesson of pilot A):
  where a diff-port unit touches a wire construct such as a request body or a persisted format,
  acceptance has to include a **deep comparison of the full shape** against a fixture — the top-level
  key set, each item's key set, the types and values, and the order, not a projection of role and
  type. Neither the implementer's own check nor two reviewers comparing statically is enough to pass
  a unit like this. The upstream baseline is the raw request body or file parity already captured.
- **What this port does not do**: do not load AGENTS.md/CLAUDE.md into the system prompt (upstream
  behavior); do not wire up the extensions loader (upstream's own extensions.rs is unwired; port it
  as-is); the TUI has no steering while a turn is running, and input waits for the turn to end.
- **Module glue** (mod.rs): a TS barrel (index.ts) is created only when the base already has one, or
  when several files need an aggregate export; never create one for a single file.

## 5. The BUG(port) ledger (reproduced bug for bug; fixes land in phase 18 only)

> For each entry: the site is marked `BUG(port): B<n>`, a characterization test **asserts the
> defective behavior**, and phase 18 flips each assertion in its own commit and re-runs parity.
> Every line number refers to upstream, pie @0a120dfd.
>
> **Phase 18 status (2026-08-04)**: B1, B2, B3, B3a, B4, B5, B6, B8, B9 and B13 are **fixed** — the
> markers at those sites now read `PORT-DIVERGENCE: B<n>`, the characterization tests are flipped,
> and each is declared in `migration/parity/intentional-divergences.md` as D1 through D6.
> **Not fixed**: B7, B10, B11, B12, B14, B15, B16 and B17, with reasons at the end of that file and
> in `migration/post-parity-backlog.md`. The ROADMAP lists only 6 deliverables for phase 18, so each
> unfixed item was argued through and handed to the backlog. Of those, **B12** (failed and cancelled
> mapped to a normal Stop) and **B17** (doubled parentheses in replay rendering, observable by the
> judge) are the two most worth taking first.

| id | site (upstream) | the defective behavior, which has to be reproduced |
|---|---|---|
| B1 | crates/ai/src/providers/openai_responses.rs:542-564 | Responses usage accounting ignores the provider's total and adds cache_read and cache_write on top of input, which already includes cached, so 100/80/20/10 is recorded as total=210 where 110 is correct |
| B2 | crates/ai/src/providers/openai_completions.rs:449-455 | Completions double-counts the same way: total = input (already including cached) + output + cache_read + cache_write |
| B3 | crates/agent/src/harness/cost.rs:58-73 | the production provider path never converts Model.cost into Usage.cost, so cost is always 0; the faux provider and a self-filled cost still work |
| B3a | crates/ai/src/providers/openai_responses.rs:542-564, where update_usage never touches cost and the file contains no cost conversion at all | the ai provider layer does not compute usage.cost — the provider-side counterpart of B3 at the harness layer. The skeleton's service-tier cost multiplication does not exist on the pie path, so the diff-port removes it and keeps cost=0 |
| B12 | crates/ai/src/providers/openai_responses.rs:531-538 | the Responses stopReason mapping distinguishes only `"incomplete" => Length`, and everything else — including the `failed` and `cancelled` the API reports explicitly — becomes `=> Stop`, so a failure or a cancellation appears in the session and the interface as a normal ending |
| B4 | crates/agent/src/harness/agent_harness.rs:1716-1729, 1882-1893 | budget_cap_usd is only a soft gate between turns: within one prompt, the agent loop goes LLM to tool to LLM without re-checking the cap, and with cost=0 even a very low cap fails to stop the second request |
| B5 | crates/coding-agent/src/mcp_loader.rs:98-139, 239-253 | a project's `.pie/mcp.toml` is read unconditionally at startup, stdio servers are spawned immediately, and a project entry overrides a user entry of the same name — with no trust gate |
| B6 | crates/coding-agent/src/triggers/cron.rs:138, 329-368 against 578, 1343 | NewCronJob defaults to Allow with enabled:true and takes effect immediately, while SetCronJob refuses to let the model re-enable a job and requires /cron enable — the two are inconsistent |
| B7 | crates/coding-agent/src/triggers/cron.rs:162, the remove_job path | `/cron remove` does not delete the corresponding loop-<id>.md state file, although the documentation says it does |
| B8 | crates/agent/src/harness/session/jsonl_storage.rs:97, load_entries | a healthy prefix with a cut-short last line makes resume and continue fail, with no salvage and no error suggesting another resume-id, while --list-sessions still works |
| B9 | crates/agent/src/harness/trigger_runtime.rs:387-394 and its implementation | LatestReplaces is in fact first-wins inside an active dedup window: the first entry takes the key and every later one with the same key is Deduped, with no replacement |
| B10 | crates/coding-agent/src/tools/task.rs:7 against 98-155 | the comment says "max 16 iterations" while the construction chain imposes no iteration limit at all |
| B14 | crates/coding-agent/src/otlp.rs:78-86 | `with_service_name` calls `clone_for_rename`, which returns an `Inner` with fresh `pending` and `open` but **never spawns a flush pumper for it** — only `new` at `otlp.rs:68-74` spawns one — so spans recorded by a renamed layer queue forever and are never exported. **Unreachable on both sides** (upstream has no caller, and neither does the TypeScript side), so parity is unaffected and the phase 18 priority is low; the same posture as porting oauth.rs faithfully even though it is dead code |
| B15 | crates/coding-agent/src/markdown.rs:77 | `bytes[i] as char` is Rust's only integer-to-char conversion, and its semantics are Latin-1 widening: every non-ASCII byte **outside** an inline span becomes its own U+0080..U+00FF scalar (`"héllo"` becomes `"hÃ©llo"`). Text **inside** a span escapes this, because what is copied there is a `&str` slice. **Unreachable on both sides**: markdown.rs:9 carries #![allow(dead_code)] and the crate has no caller |
| B16 | crates/coding-agent/src/markdown.rs:22-23 | an ATX heading swallows the space between `#` and the text, and the heading text **never goes through `render_inline`**, so `"## a **b**"` keeps the literal `**b**`. Unreachable on both sides, as with B15 |
| B17 | crates/coding-agent/src/tui.rs:493-497 | transcript replay wraps `preview(...)` in `"⚙ {}({})"`, but `preview` at tui.rs:432 **already adds parentheses**, so replay renders `⚙ read((path="/tmp/x.rs"))` with doubled parentheses while the live ToolExecutionStart at tui.rs:190 renders one layer. The same tool call looks different on the replay path and the live path. **Observable by the judge, on the first screen of --resume, unlike B14, B15 and B16 — this one is live** |
| B13 | crates/coding-agent/src/lsp_supervisor.rs:76-103 | a project's `<cwd>/.pie/lsp.toml` is read unconditionally, the project entry overrides the user's, and there is no trust gate. Its `command` is spawned the first time a write or edit matches that extension — spawned lazily rather than at startup — so opening an untrusted repository and editing a file of that type runs an arbitrary child process. The same family as B5, differing only in when the spawn happens |
| B18 | crates/coding-agent/src/tools/read.rs:58-83 | `total_lines` is incremented **before** the break on `taken_lines.len() >= limit`, so `details.totalLines` reports `skip + limit + 1` rather than the file's real line count — a 100-line file with `limit:10` reports 11. The model uses that number to decide whether there is more to read, so it misleads the decision to continue directly. Found when S9 through S12 in phase 19 first brought read's details onto the judging surface; reproduced bug for bug and pinned by a test |
| B11 | crates/coding-agent/src/tools/memory.rs:254-296 | the MEMORY.md index is kept up to date but the startup injection never reads it; every body other than MEMORY.md is concatenated into the system prompt without bound, with no cap on count, characters, relevance or project boundary |

Also, behavior is the specification — these are not bugs and not in the ledger, but reviewers get
them wrong often: dedup and cycle state live in the process only, and reset on restart; a stateful
cron job runs through a detached subagent and can run concurrently, so the README's claim of "one
serial queue" is untrue; a local TTY running the TUI outside SSH opens the web UI by default.

## 6. Deviation log

| date | deviation | reason or authorisation |
|---|---|---|
| 2026-08-03 | the kit's manual sign-off between steps is brought forward into a single supergoal plan review; rulebook revisions during a run are applied by the orchestrator and recorded here | the user chose the autonomous supergoal chain (ROADMAP Assumptions) |
| 2026-08-03 | settings.json allows tsc and vitest relative to the kit template (the Step 4 dissolve), along with git commit and checkout, since the orchestrator and the executor are the same session | PROVENANCE.md §settings |
| 2026-08-03 | the kit's "drafts don't compile" does not apply: tsc is dissolved into the unit loop | §0 |
| 2026-08-03 | pilot A: the B3 ledger entry extends to the ai provider layer, so B3a was added; sites marked `// BUG(port): B3` now read B3a and carry a line number (decisions A2-F1 and A2-F2) | §5 |
| 2026-08-03 | pilot A: the ambiguity about where retry lands (§1 against §4 against the manifest) was decided by dependency direction as packages/ai/src/utils/retry.ts, and §1's wording was corrected to match (A2-F5) | §1 and §4 |
| 2026-08-03 | pilot B: §2.3 gained the "faithful synchrony" authorisation, with the mechanical criterion of parking_lot::Mutex together with std::fs; CronRegistry's synchronous implementation was confirmed compliant after the fact (decision B2-F1) | §2.3 |
| 2026-08-03 | pilot: the ban on reviewers running long commands, over 5s, was written into the production review brief template, after two agents stalled by running the full vitest suite bare and triggering the end-to-end watchdog | process |
| 2026-08-03 | pilot A round 2: the family of request-body shape differences (an unconditional system item, and the bare shapes of assistant, reasoning and function_call) passed the implementer and both reviewers undetected and was found only by digging with a probe, so §4 gained the mandatory probe gate for wire-construct units | §4 |
| 2026-08-03 | phase 6 (mcp): §2.2 gained the leaf-package exception for local concurrency primitives, and §2.3 the exception for a leaf package spawning directly, since the dependency direction cannot be reversed; reported by the implementer and decided by the orchestrator | §2.2 and §2.3 |
| 2026-08-03 | phase 7: the ai catalog was aligned to upstream's frozen snapshot (32/938), because the skeleton's vendored snapshot (32/942) conflicted with parity S1's verbatim assertion; the generator was made offline (PROVENANCE §7) | process |
| 2026-08-03 | phase 7: a size limit for fan-out tasks was recorded — a reviewer takes at most 6 units or 4 numbered questions. Compliance items a machine can check (grep, dependency diffs, marker coverage) are scripted by the orchestrator rather than handed to an agent, after five watchdog stalls | process |
| 2026-08-05 | §2.2 gained a row for `tokio::time::timeout` | reviewer C in phase 12 found three different mappings within one batch: `AsyncQueue.next(AbortSignal.timeout)` and two hand-rolled `Promise.race` with `setTimeout`. A construct outside the tables is reported by a reviewer so a row can be added, and the orchestrator applies it at a phase boundary; the affected sites, lsp.ts:325-347 and oauth.ts:204-250, were brought onto the new rule by a fixer |
| 2026-08-05 | §5 gained B13 (lsp.toml has no trust gate) | reported by reviewer C in phase 12: an implementer declining to open an entry because it "is not in the §5 table" is circular — §5 is maintained by the orchestrator, and an implementer proposes rather than vetoes. Upstream `lsp_supervisor.rs:76-103` was checked and indeed has no gate, the same family as B5 with only the spawn timing lazy, so it was added as B13 |
| 2026-08-05 | §2.3's phrase "bundles the whole package" did not match what the gate does — **phase 20-9 decided and landed: widen the entry set** (`scripts/browser-smoke-entry.ts`, `packages/ai/src/index.ts` and `packages/agent/src/index.ts`; all three bundle for the browser today, so tightening cost nothing, and the negative control of putting `node:fs` into `ai/src/index.ts` fails the gate on the spot). It was **not** widened to the whole tree: `ai/cli.ts` and others are Node-only by design, and bundling the whole tree would only turn the gate into noise. §2.3's "whole package" wording is still imprecise and should be read as "protects the reachable graph from the public entry points" | reviewer C pointed out that `scripts/check-browser-smoke.mjs:11` bundles the single entry `scripts/browser-smoke-entry.ts` rather than the whole package tree, and that `ai/cli.ts`, `ai/utils/node-http-proxy.ts`, `ai/utils/oauth/anthropic.ts` and `agent/harness/env/nodejs.ts` carry static node: imports today and still pass. The gate is therefore weaker than §2.3 promises literally — **it protects only the reachable graph from the entry points**. Phase 19 hardening decides whether to widen the entry set or rewrite the rule |
| 2026-08-04 | §5 gained B14 (a renamed otlp layer never exports) | the implementer of batch D in phase 13 reported it and **did not assign an id themselves**, exactly the posture B13 established: the implementer proposes, the orchestrator decides. Why it was accepted: §5 defines its entries as defects that have to be reproduced, and this one already was, so without an id the phase 19 marker reconciliation would miss it |
| 2026-08-04 | the manifest row `coding-agent/spinner` was reclassified from diff-port to port | the phase 13 characterization-test unit found the original mapping, to packages/tui/src/components/loader.ts, to be wrong: Loader agrees with upstream on two trivial constants and has none of the behavioral surface spinner_e2e asserts — an injectable sink, the `\r\x1b[2K` clear, idempotence, the enabled and TTY gate, or the clone semantics. The orchestrator's grep found nothing and spinner.ts did not exist. Left unchanged, phase 14 would have done a shallow diff-port comparison and missed the whole unit |
| 2026-08-04 | the out_path of two char-test manifest rows was corrected | `tests/tools` pointed at a path that does not exist, and `tests/commands` pointed at `test/ported/commands.test.ts`, which is the test of the **source unit** `coding-agent/commands`. A collision like that lets the rule "out_path exists means done" mark a unit complete on the strength of another unit's file; found during the closing spot check |
| 2026-08-04 | §5 gained B15 and B16 (Latin-1 mangling in markdown.rs, and headings swallowing the space) | the markdown implementer in phase 14 reported both and assigned no id, the B13 and B14 posture. Both are reproduced and pinned by tests; the module is dead code upstream, so parity is unaffected and the phase 18 priority is low |
| 2026-08-04 | §5 gained B17 (doubled parentheses on transcript replay) | reported by the tui implementer in phase 14. **Unlike B14 through B16, this one is observable by the judge**, on the first screen of --resume, so a characterization test had to pin the contrast between doubled parentheses on replay and a single layer live |
| 2026-08-04 | the manifest row `coding-agent/tui` was reclassified from diff-port to port, with out_path changed to src/tui.ts | the base, interactive-mode.ts, is the skeleton's component-tree TUI and has **no line-stream path** — before this work, grepping the whole repository for renderEvent, renderHarnessEvent, renderPersisted, [thinking] or the gear glyph found nothing, which the orchestrator confirmed with git show HEAD. The hazard is the same as spinner's: the file out_path points at exists but has nothing to do with this unit, and "exists means done" misjudges it |
| 2026-08-04 | recorded: the manifest's base and out mapping was made in phase 2 by **filename similarity**, as a semantic mapping never checked against behavior | phases 13 and 14 found four queue errors between them (the spinner classification, the tests/tools path, tests/commands pointing at another unit's file, and the tui classification and path), three of which would directly produce a false green. Any row where the overlap between the base's public surface and upstream's has not been verified should be treated as unverified |
| 2026-08-04 | §2.1 gained "a discriminator that is not serde-derived also uses snake_case" | reported by the feed and kernel unit in phase 15: `QueuedTurn.kind` has no serde derive, either spelling is equally faithful, the rulebook said nothing, and two agents working in parallel changed it back and forth three times. A real gap in the rulebook, recorded and settled, with no code change needed |
| 2026-08-04 | workers/fefe-hub entered the root build and test, but **is not added to `workspaces`** | it is a Cloudflare Worker with the wrangler toolchain, and adding it to workspaces would change the npm dependency resolution graph of the whole monorepo. Explicit `build:workers` and `test:workers` scripts are chained instead, in the same shape as the phase 15 mandatory commands |
| 2026-08-04 | `copy-assets` and `copy-binary-assets` gained `web_index.html` into `dist/ui/` | demonstrated by the web UI smoke test: before the fix, `GET /` on a built version returned 500 because `indexHtml()` threw. The web unit had predicted this gap, and running it for real confirmed it |
| 2026-08-04 | phase 18: B1's breakdown of the "correct" value disagrees with this implementation (recorded; the ledger text is left as it is) | the §5 B1 row computes "110 correct" as `input(20)+output(10)+cacheRead(80)`, netting only cacheRead out of input; the implementation nets both cache buckets out and arrives at `input=0`. The total is 110 either way, and only the breakdown of `input` differs. In the OpenAI Responses family both buckets are children of `input_tokens_details`, and both have to be netted out for B3's per-bucket pricing to be right, or cacheRead would be charged once at the input price and again at the cache price. The ledger text is kept as written for the record, and the difference is declared as D1 in intentional-divergences.md |
| 2026-08-04 | phase 18: three changes to the judge — normalize expanding across lines, diff switching to LCS, and S8 really capturing the exit code — all of which **raise** sensitivity | what prompted it: the difference declared as D4 sits inside a 22KB single-line request body, which a line-by-line diff reddens permanently, making any further regression among the 25 tool schemas indistinguishable from the declared one — and that is exactly where the heaviest bug of phase 17 lived. The rule that the judge must not be changed to go green still holds; these three go the other way, and each had an orchestrator decision and a self-check re-run, with 3 of 3 mutations still detected. `diff.mjs` had no tests at all before this and gained them in the same batch |
| 2026-08-04 | phase 18: the trust gate was extended to `<cwd>/.pie/models.json`, beyond the literal text of B5 and B13 | the third file in the same family, read just as unconditionally upstream. It is not remote code execution, but a `base_url` is enough: a hostile repository can point inference silently at an attacker's endpoint. Gating two files and not the third is a fence with a gate-shaped hole beside it. **On reachability**: before phase 17 `loadAll` had no caller, so it was not yet live when the ledger was written |
| 2026-08-04 | process: on the third failure of the same kind, change the cause rather than the instance (rule 6 genuinely triggered for the first time) | the full test run produced three failures of the "a test binds a real TCP port" kind. Investigated one by one, none was environmental noise: (a) `dynamic-trigger-e2e` waited on the wrong signal — the promotion entry is written after `trigger_completed`, so the test asserted a side effect it had never waited for, and twice this was treated as a timeout flake and given more time; (b) the `EADDRINUSE` in `anthropic-oauth` was a **product defect** — `Server.close()` is asynchronous and the code did not await it, so a second login really did collide on the fixed callback port 53692; (c) `findRedirectPort` in `coding-agent/oauth` guessed ports at random while calling itself "unlikely to collide", and after a collision `fetchWhenListening` would poll a port that was never bound, reporting a message that pointed at the wrong half of the problem. All three had their cause changed |
| 2026-08-04 | FINAL AUDIT G1: the completion rule has to recognise the `dissolved:` prefix | checking all 205 manifest rows found 12 with `status=done` whose `out_path` file does not exist. Checked one by one, **none was a missing capability**: `ai/utils/abort` dissolved into the native `AbortSignal`; `ai/utils/aws_eventstream` adopted `@aws-sdk/client-bedrock-runtime`; `ai/utils/sse` is spread across the providers; eight `*/mod` entries are Rust module declaration files, re-exported from `src/index.ts` on the TypeScript side; and `ai/event_stream` was a plain path typo. The root cause is that the `out_path` column assumes every upstream unit corresponds to exactly one TypeScript file, which none of adopt, dissolve or spread-out landing satisfies. The fix: correct the typo, and record the other 11 as `dissolved:<where it went>` with the rationale saying where the capability lives. **The rule itself should read "out_path exists, or begins with `dissolved:` and the rationale says where it went"** — leaving 12 silent exceptions means the next person cannot tell "dissolved" from "never done", which is the false-green category this run has already hit five times |
