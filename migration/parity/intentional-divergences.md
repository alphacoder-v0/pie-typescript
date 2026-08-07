# Intentional divergences — behavior this port **deliberately** stopped matching upstream on, from phase 18

> How this differs from `explained-divergences.tsv`: that file records architectural differences that
> are **not observable by the judge** and where both sides in fact behave the same. This one records
> cases where **upstream is known to be wrong and we chose not to follow it**. Each entry has its own
> commit, with parity output from before and after the fix.

At the end of phase 17 all 8 scenarios reported DIFF 0 on both sides (section 1 of
`final-report.md`). From this file onward, the parity baseline changes from "byte-identical to
upstream" to "byte-identical to upstream, **except for the items declared below**". Any difference
not listed here is still a defect.

---

## D1 — B1 and B2: usage accounting no longer double-counts cached input

**Sites** `packages/ai/src/usage.ts` (the new `finalizeUsage`) · `providers/openai-responses-shared.ts` · `providers/openai-completions.ts`
**Upstream** `crates/ai/src/providers/openai_responses.rs:542-564` · `openai_completions.rs:449-455`

Upstream's `update_usage` keeps the provider's raw `input_tokens`, which **already includes** the
cached tokens, and then adds `cache_read` and `cache_write` on top, so the cached part is counted
twice. The ledger's worked example: input=100, cacheRead=80, cacheWrite=20, output=10 is reported as
total=210, where 110 is correct.

**Changed to** a shared `finalizeUsage`: each caller normalises its own API's semantics into
"uncached input", and `totalTokens = input + cacheRead + cacheWrite + output`.

**Only the two sites that really had the defect were changed.** The comments in anthropic, bedrock,
google, google-vertex and mistral describe the same defect, but on checking, their arithmetic **was
already correct**: Anthropic's `input_tokens` and its cache buckets are mutually exclusive, AWS's
`inputTokens` excludes the cache buckets, upstream already applies a `saturating_sub` on the google
side, and mistral reports no cache fields at all. Following the comments would have broken working
code. (The bedrock comment states an **incorrect fact** about the AWS API, recorded in bucket Z of
`migration/post-parity-backlog.md`.)

**One disagreement with the RULEBOOK**: the B1 row computes "110 correct" as
`input(20)+output(10)+cacheRead(80)`, subtracting only cacheRead from input; this implementation nets
both cache buckets out and arrives at `input=0`. The total is 110 either way, and only the breakdown
of `input` differs. In this API family both cache buckets are children of `input_tokens_details`, and
both have to be netted out for D2's per-bucket pricing to be right. Recorded in the RULEBOOK's §6
Deviation log.

**Parity impact** (mixed into the same files as D2, below):
```
S3/run.norm      -   input         100   →  +   input         20
                 -   total         190   →  +   total         110
S3/session.norm  -  "input": 100         →  +  "input": 20
                 -  "totalTokens": 190   →  +  "totalTokens": 110
S6/session.norm  as above, once for each of the two assistant records
```

---

## D2 — B3, B3a and B4: cost is no longer always $0, and the budget cap is no longer a soft gate in name only

**Sites** `packages/ai/src/usage.ts` (`computeCost`) · all ten providers · `packages/agent/src/harness/{cost,agent-harness}.ts`
**Upstream** `crates/agent/src/harness/cost.rs:58-73` · `crates/ai/src/providers/openai_responses.rs:542-564` · `agent_harness.rs:1716-1729, 1882-1893`

The three ledger entries are three parts of one story:

- **B3a** — **no** provider upstream computes `usage.cost`; every field is always 0.
- **B3** — the harness's cost tracker is a plain summing fold, and its file comment claims that "the
  provider fills in `Usage::cost` from the price table", which is false on pie's real path. The
  tracker itself has no bug; the bug is one layer upstream of it, and shows up here as an emergent
  property: every amount the product shows the user is $0.
- **B4** — `budget_cap_usd` is checked only between prompts, and the LLM-to-tool-to-LLM round trips
  inside the agent loop never re-check it. So a user who sets a cap against a runaway loop gets no
  protection inside the loop, which is precisely where they wanted it — and with cost always 0, no
  cap however low would ever fire.

**Changed to**: the provider layer prices from the model catalog (`computeCost` is a pure function;
the exported `calculateCost` keeps its in-place shape and delegates to it — because
`examples/extensions/custom-provider-anthropic` calls it **for the side effect and discards the
return value**, so making it pure would pin those extensions' cost at $0 forever, which is the very
defect this phase set out to remove). The cap becomes a hard gate inside the loop.

**The cap does not use `abort()`**, which is worth recording: the repository already documents
(`harness-e2e.test.ts:397-405`) that an aborted run is caught by `executeTurn`, which synthesises an
assistant message with `stopReason: "aborted"`, **writes it into the session**, and then resolves
`prompt()` rather than rejecting. Hitting the cap that way would first push a fabricated failure
message into the transcript. Using the loop's own `shouldStopAfterTurn` instead — upstream has the
same slot in the same place — lets the in-flight tool batch finish and persist, and the session is
exactly `["user","assistant","toolResult"]`.

The faux provider, the test double, **still returns cost 0**: it fabricates messages from literals
the caller supplies, and has no `Model` in scope to price against. That is exactly the "faux and
self-filled cost path that still works" in the B3 ledger entry, and pricing it would contaminate the
fixtures that depend on it. This is a declared zero, not a silent one.

**Inherent granularity**: the cap can be exceeded by at most the cost of the one request that crossed
the threshold, because cost is only known once a request completes.

**Parity impact**:
```
S3/run.norm      -   output        $0.0000   →  +   output        $0.0001
                 -   total         $0.0000   →  +   total         $0.0002
S3/session.norm  -  "cost": {"cacheRead":0,"input":0,"output":0,"total":0}
                 +  "cost": {"cacheRead":0.000014,"input":0.000035,"output":0.00014,
                             "total":0.00018899999999999996}
S6/session.norm  as above, twice
```
The 17-digit float persisted as `total` is the real result of summing four products, not a formatting
defect; the same f64 sum in Rust prints the same shortest round-trip representation through
serde_json. The `/cost` display still goes through `toFixed(4)`.

---

## D3 — B5 and B13, plus models.json: project-level configuration needs explicit trust

**Sites** `packages/coding-agent/src/core/project-trust.ts` (new) · `mcp-loader.ts` · `lsp-supervisor.ts` · `local-models.ts` · `main.ts`
**Upstream** `crates/coding-agent/src/mcp_loader.rs:98-139, 239-253` · `lsp_supervisor.rs:76-103` · `local_models.rs:25-31`

Upstream reads the project configuration under `<cwd>/.pie/` unconditionally: the stdio servers in
`mcp.toml` are spawned at startup, and the `command` in `lsp.toml` is spawned the first time a file
with a matching extension is edited. **Cloning an untrusted repository and opening it — or merely
editing a file inside it — runs whatever commands that repository names.** This is the most serious
entry in the ledger.

**Changed to** refuse by default and allow explicitly, deterministically — with no interactive
confirmation, because this binary has to run unattended and inside the parity environment:

- The trust store `~/.pie/trust.json`, resolved through the existing `PIE_DIR` handling, with a 0600
  file in a 0700 directory, written through a temporary file and a rename, keyed by the absolute path
  after `realpath`. **The read path has no side effects** — asking once whether a directory is
  trusted does not conjure `trust.json` into existence (parity S7 snapshots the `$HOME/.pie` file
  tree, so a read that materialises anything is itself a difference).
- The `--trust-project` flag and the `PIE_TRUST_PROJECT=1` environment variable. The flag is consumed
  and stripped from argv **before** `parseArgs`, because adding it to `cli/args.ts` or `cli/help.ts`
  would change the `--help` page that parity S1 compares byte for byte. The cost is that it does not
  appear in `--help`, which is acceptable because the skip notice names it — the user sees it at
  exactly the moment they need it.
- When something is skipped, one line goes to **stderr** naming the ignored file and both ways to
  allow it. **Silence would be worse than the bug.**
- Once trusted, a project entry **still** overrides a user entry of the same name, which is what
  project overrides are for, but no longer silently. The real harm upstream is the silence: the user
  goes on believing they are running what is in their own `~/.pie/`.

**One step beyond the literal ledger, completing it rather than widening it**: `<cwd>/.pie/models.json`
is the third file in the same family, read just as unconditionally upstream. It is not remote code
execution — it holds model definitions, not commands — but a `base_url` is enough: opening a hostile
repository points inference silently at the attacker's endpoint, and every prompt, file excerpt and
tool result in that session goes there. Gating mcp.toml and lsp.toml alone is a fence with a
gate-shaped hole beside it. **On reachability**: this hole was dead code before phase 17 (`loadAll`
had no caller at all, which is what caused the S5 replay scenario difference), so it was not yet live
when the ledger was written.

**Parity impact: none.** None of the 8 scenarios has a `.pie/` directory in its cwd, so the notice
cannot fire, and the read path does not materialise the trust store.

**Phase 19 addendum (F5, measured on the state surface)**: the gate did not distinguish a **project
directory** from the **user's configuration directory**. Running `pie` from `$HOME`, it refused
`~/.pie/models.json` — the user's own configuration, which the user-scope loader is supposed to read
— as untrusted project configuration. Two things wrong, the second worse:

1. the user's own configuration is refused;
2. **the advice it gives is harmful**. Following it writes `$HOME` into `trust.json`, and `$HOME` is
   an ancestor of nearly every project the user will ever open. A security prompt that trains the
   user into granting the broadest possible permission is worse than no prompt.

The fix: when `<cwd>/.pie` resolves to the user's configuration directory itself, the gate does not
fire at all — no refusal and no notice. And in that directory `--trust-project` **actively refuses**
and explains why, without being fatal; the run continues.

A correction to the audit's reasoning: trust matches an **exact directory** (`isProjectTrusted` does
one key lookup and never walks ancestors), so granting `$HOME` never made subdirectories inherit
trust. The real harm is the misleading record left in `trust.json` and the habit it teaches. Refusing
actively removes the trap by construction, rather than relying on that lookup staying exact forever.

**The exemption launders nothing**: the only way `<cwd>/.pie` resolves to the user's configuration
directory is by **being** it, and that directory is read at user scope on every run whether trusted
or not — no file becomes readable because of it. Both sides of the comparison go through realpath, so
a symlinked `$HOME` matches and a hostile directory cannot fake one.

**2026-08-04 addendum: the harm itself has now been demonstrated, closing a regression debt.** Until
then D3's threat statement rested on reading the source. Phase 19 tried to demonstrate it, but the
injected `mcp.toml` **spawned no process on either side**, so that attempt neither confirmed nor
refuted anything. The cause is worth recording on its own: **the gate was not the problem, the fixture
was**. Upstream's deserialiser (`mcp_loader.rs:25-31`) declares

```rust
pub struct McpConfig { #[serde(default)] pub server: Vec<ServerConfig> }   // [[server]], singular
```

while the audit used `[servers.evil]`, a plural table indexed by name. `McpConfig` has **no**
`deny_unknown_fields`, so that file parsed **successfully** into an empty server list: upstream
spawned nothing, printed no diagnostic and left no trace. A demonstration that passes while asking
the wrong question is more dangerous than none, because it gets cited later as evidence that the harm
is theoretical.

Redone with real fixtures derived from the schema (`[[server]]` with `command` and `args`; on the lsp
side `[[language]]` with `id`, `extensions`, `command` and `args`, per `lsp_supervisor.rs:26-41`), the
conclusion is what the ledger says, and firmer:

- **upstream, mcp.toml**: `pie --tui` in a hostile cwd **runs the command in that file at startup**,
  and the sentinel lands on disk. The MCP handshake then fails (`mcp server 'evil' failed`) — but
  **the harm has already happened before the handshake**.
- **upstream, lsp.toml**: the user need do nothing beyond opening the project; one `edit` tool call
  landing on a `.txt` triggers the lazy spawn and the sentinel lands.
- **upstream, negative control**: phase 19's wrong shape, with no sentinel and no diagnostic —
  reproducing that non-conclusion exactly.
- **this port**: the same fixtures produce **no process side effect at all** while untrusted — not
  "zero connections", but no child process spawned — and spawn as usual after `--trust-project` or
  `PIE_TRUST_PROJECT=1`. It is a gate, not a wall.

The rig, repeatable rather than a one-off transcript:
- `migration/parity/oracle-probes/d3-trust-harm/run.sh` — both real binaries, 7/7, including the
  negative control and a self-check on whether driving `edit` really writes to disk (without it,
  "no sentinel" would only mean the tool never ran).
- `packages/coding-agent/test/project-trust-harm.test.ts` — 9 vitest cases through a temporary
  `PIE_DIR`. It **renders the same templates run.sh uses**: both sides share one fixture source, so
  that the recurrence path of "the fixture drifts into a shape upstream never executes" cannot exist
  structurally.

**The third file this demonstration did not cover**: `models.json`, the completion described above.
It is not remote code execution; its harm is a `base_url` redirect, and demonstrating that needs a rig
that can observe an outbound request, which is a different family from this probe's sentinel
criterion. The gate treats it with the same code as the other two files, but **this one remains
unverified**.

---

## D4 — B6: the model cannot bring a cron job into effect

**Site** `packages/coding-agent/src/triggers/cron.ts`
**Upstream** `crates/coding-agent/src/triggers/cron.rs:138, 375-420 against 578, 1343`

Upstream's model-callable `NewCronJob` creates a job with `enabled: true` outright, so it runs on the
next tick with no human involved, while `SetCronJobState` **refuses** a model-driven re-enable and
requires the user to type `/cron enable`. Two tools, one capability, opposite rules. The strict one is
the intent; the permissive one is the hole.

**Changed to** one invariant: **the model cannot bring a cron job into effect; only an explicit human
action can.** `NewCronJob` creates the job **disabled**. Creation still succeeds; what needs a human is
**enabling**. Both messages derive from the same module constant, and the refusal text of
`SetCronJobState` is byte-identical to upstream's.

The gate sits in the **tool handler** rather than in `CronRegistry.addJobFull`, which still defaults
to `enabled: true`, so the human `/cron add` path is byte-for-byte unchanged. Passing the flag into
`addJobFull`, rather than creating and then disabling, also avoids a window in between where a tick
could fire.

**A second, separate divergence that has to be declared on its own**: the **description string the
model sees** for `NewCronJob` was changed too. Without it the model reports a job that is not running
as "scheduled" — the tool **result** says so plainly, but nothing forces the model to write its
user-visible narration only **after** the result comes back, and one assistant message can perfectly
well say "scheduled it for 9am for you" while issuing the call. Only the channel **before** the call
can close that window, and the description string is that channel. The cost is that it lands on the
same judging surface as the heaviest bug of phase 17.

**Parity impact** (this is that description string; the runtime half is unobservable, because the
fixture server never emits a tool_call and S7 goes through the human `/cron add` path):
```
S3/requests.norm   DIFF 2 (the one description line of NewCronJob)
S5/req2body.norm   DIFF 2 (the same string)
```
That these two can be isolated to exactly one line is why this phase made normalize.mjs expand JSON
lines across several: before that they hid inside a single 22KB line, which reddened permanently, and
any further regression among the 25 tool schemas would have been indistinguishable from them.

---

## D5 — B8: a cut-short last line no longer condemns the whole session

**Sites** `packages/agent/src/harness/session/jsonl-storage.ts` · `packages/coding-agent/src/core/session-manager.ts` · `session-archive.ts`
**Upstream** `crates/agent/src/harness/session/jsonl_storage.rs:97-118`

Upstream's `load_entries` meets a healthy prefix followed by one corrupt or cut-short line and fails
the **whole** load, so `--resume` and `--continue` refuse the session outright. A cut-short last line
is the ordinary result of a process being killed mid-write, so an arbitrarily long healthy
conversation is discarded because of half a line at the end. The error offers no alternative either —
and `--list-sessions` still lists that session, so the user sees one that exists and cannot be
opened.

**Changed to**: **salvage the half-written tail and nothing else.** A parse failure on the **last
line** discards that line and returns the healthy prefix; a failure on **any earlier line** still
fails. Corruption in the middle of a file is a different fault, and skipping it silently would hide
real data loss. That distinction is the point of the whole fix, and it is decided by **position**
rather than by why the parse failed.

Three things have to be done together, or the salvage itself becomes a worse bug:
1. **Repair on disk** — after salvaging, cut the file back to the healthy prefix. Otherwise the bad
   line stays there and the next `appendEntry` pushes it into the **middle** of the file, where the
   session becomes permanently unopenable.
2. **Say so** — print one line to stderr when salvaging, naming the session, the line number and how
   many entries were kept. A silent salvage is itself a data-loss bug. Passive readers
   (`listSessionEntries`, and `open`'s look-ahead) neither repair nor print.
3. **`commitImport` turns salvage off explicitly** — it validates the transcript it has just written,
   and salvaging there would silently commit a session missing its last record.

When it still fails, the error now gives an actionable next step: `--list-sessions`, then
`--resume-id`. **`--continue` is deliberately not suggested**, because it opens the very session that
just failed.

**Parity impact**:
```
S8/resumeerr.norm   - Error: invalid entry: <PARSE-DETAIL>
                    + Warning: session <UUID>: discarded a partial final entry (line 3 of …)
                      left by an interrupted write; kept 1 complete entry and truncated the file
                      to that healthy prefix.
S8/list.norm        -   <ID>  <TS>
                    +   <ID>  <TS>  seed session      (the session reads now, so the preview appears)
S8/resumeexit.norm  - resume_exit=1  →  + resume_exit=0
```
The last of those **did not exist at all** before: `s8-bad-tail.sh` wrote `resume_exit=$?` after
`|| true`, so it read the exit code of `true`, always 0 on both sides, and the file was not a `.norm`
and never took part in the diff. That assertion had no ability to fail. Once the capture was fixed it
immediately reported a real behavioral divergence.

---

## D6 — B9: `LatestReplaces` really replaces

**commit** `a8223b3`
**Site** `packages/agent/src/harness/trigger-runtime.ts` (`TriggerRuntime.evaluate`)
**Upstream** `crates/agent/src/harness/trigger_runtime.rs:387-394`, plus the dedup branch at `:200-207`

Upstream writes the dedup map for a given `idempotency_key` **once**, on first admission. A repeat
inside the window only reads the existing entry back and never rewrites it, so
`ReplacementPolicy::LatestReplaces` is indistinguishable from `Drop` — a name promising latest-wins
that is in fact first-wins. The consequence is not a missing feature: downstream correlation is
pinned to a trace the caller believes has already been superseded.

**Changed to**: when the **governing policy** is `latest_replaces`, rewrite the existing entry's
`traceId`, so `previousTraceId` advances with each repeat.

Two upstream invariants are kept deliberately:
- The **first** arrival's policy governs the whole window (RFC 1 §5, pinned by upstream's own
  `deduped_outcome_carries_first_arrivals_replacement_policy` test). A later repeat cannot change how
  the window collapses.
- `receivedAtMs` is **not refreshed**. The window still expires from the first arrival. Refreshing it
  would let an uninterrupted stream of repeats hold a key forever — fixing one bug with a worse one.

**Parity impact: none.** S1 through S8 report DIFF 0 both before and after. Dedup's trace correlation
reaches no scenario's observable surface, since trigger runtime state exists only inside the process.

**Tests**: `packages/agent/test/harness/trigger-runtime.test.ts` went from 2 cases asserting the
defect to 4 asserting the fix, including regression guards that `Drop` and `Coalesce` stay first-wins
and that the window does not slide.

---

## D7 — `pie session export|import` refuses rather than becoming a chat prompt

**Sites** `packages/coding-agent/src/subcommands.ts` (new) · `main.ts:761-765`
**Source** F2, measured on the state surface in phase 19

`--help` advertises the `session` and `help` subcommands, but they were **never dispatched**. The
consequence is not a missing feature: those tokens fall all the way through into `messages` and
**become a chat prompt sent to a third-party API**. Mistype a subcommand and your command line leaves
the machine, and what comes back is a bare HTTP 401.

The pure help and usage surfaces (`session`, `session --help`, `session export --help`,
`session import --help`, `help`, `help session`) now **reproduce upstream byte for byte** — they are
static clap output, reproducing them is right, and the documented surface no longer lies.

The two that actually move data, `session export|import`, are **deliberately not implemented**:
upstream's `run_session_cli_command` (`main.rs:249-372`) carries session id resolution, the TTY round
trip for `--activate-triggers ask`, and the archive summary lines — that is a porting unit of its own,
not a defect fix. They fail hard with exit 2 and point at `/session export|import`
(`core/slash-dispatch-session.ts`), which **is ported and works**.

The alternative on the table was never "upstream's behavior"; it was "prompt an LLM with the word
`session`".

**Parity impact: none** — no scenario drives these subcommands.

**A correction to the audit**: §8a of the state-surface report says upstream's `pie session` prints
its help page to **stdout**. Measured, it does not — stdout is 0B, **stderr is 347B**, and the exit
code is 2, because clap's `MissingSubcommand` is an error rather than a help request. This port
matches the measured behavior.

---

## D8 — the cause text for a malformed `models.json` is V8's wording

**Sites** `packages/coding-agent/src/utils/error-chain.ts` (new) · `main.ts:988-1020`
**Source** F6, measured on the state surface in phase 19

Before: exit **0**, and one line in the feed reading `error: warning: parse /…/models.json` — no
cause, no line or column — while the custom model table was silently discarded and the session started
as usual.

Now in upstream's shape: exit 1, with stderr carrying `Error: parse …`, a blank line, `Caused by:`,
and the indented cause including the line and column.

**One thing still diverges**: the cause text is the V8 JSON parser's wording
(`Expected property name or '}' in JSON at position 2 (line 1 column 3)`) where upstream has
serde_json's (`key must be a string at line 1 column 3`). **Same position, different wording** — an
artifact of the runtime rather than pie behavior, the same family as ED15's handling of the
`invalid entry:` detail.

**Why fatal rather than continuing**: the main reason `models.json` exists is to point a provider at
a particular `baseUrl`. Continuing on failure means silently dropping that table and using a catalog
model instead — the same failure class as the `--base-url` defect of phase 16, where requests went to
an unintended endpoint, and exit 0 leaves no script able to notice. A startup error naming the file,
the cause and the position is better than a session that quietly changed endpoints.

**Parity impact: none** — no scenario writes a malformed models.json, and the M1, M2 and M3 self-check
mutations do not cover this surface either.

---

## D9 — an unknown `--model` or `--provider` fails hard rather than falling back silently

**Site** `packages/coding-agent/src/core/model-resolver.ts` (`MODEL_DISCOVERY_HINT`, both not-found branches)
**Upstream** `crates/coding-agent/src/model.rs` and `main.rs:553-567`
**Source** F8, measured on the state surface in phase 19

Measured: with `pie --model no-such-model-xyz --tui`, upstream **exits 0**, silently discards the flag
and starts on whatever `auto_detect_model` returns (Haiku). This port exits 1 and refuses to start.

**Why this is not followed**: silently switching models is exactly the failure F4 had just removed in
phase 19 — the user ends up on a model they never asked for, with no notice, at a price that can
differ by an order of magnitude. Upstream is worse here than F4 was: it does not even acknowledge the
flag.

**The pointer was corrected too**: the text used to read "Use `--list-models` to see available
models", but `--list-models` is **in neither side's `--help`** (upstream answers it with
`error: unexpected argument '--list-models' found … tip: a similar argument exists:
'--list-sessions'` and exit 2). The first suggestion is now `/model list`, which the third line of the
`Model catalog:` block in `pie --help` carries byte-identically on both sides, with `--list-models`
demoted to second.

The exit code is **1, not 2**: this is a runtime failure on the anyhow surface, not a usage error
clap could catch.

**Parity impact: none** — no scenario drives an unknown `--model`.

---

## D10 — in an empty cwd, a bare `--resume` opens the picker rather than failing

**Site** `packages/coding-agent/src/main.ts` (the `parsed.resume` branch of `createSessionManager`)
**Upstream** `crates/coding-agent/src/main.rs:509-517` (`select_resume_session`)

Measured: with no session in the cwd, upstream does `bail!("no sessions to resume in {}")` and exits
1; this port opens the picker, whose empty state reads `No sessions in current folder. Press Tab to
view all.`, and exits 0.

**Why it is kept**: the picker's empty state offers an actionable next step upstream does not — Tab
switches to the global scope, where sessions may actually exist. The phase 19 audit judged that empty
state good on its own. `-c/--continue` and `--resume-id` were aligned with upstream under F10 and
F11, so this one interactive surface is all that still diverges.

**Parity impact: none** — S8's `--resume-id` takes the branch where the session exists.

---

## D11 — `NO_PROXY` is honoured, and an invalid proxy URL raises explicitly

**Site** `packages/ai/src/utils/node-http-proxy.ts:40-48`
**Upstream** `crates/ai/src/utils/node_http_proxy.rs` (`proxy_from_env`)

The fourth line of upstream's module comment says it handles `` `HTTPS_PROXY`, and `NO_PROXY` env
vars ``, but `proxy_from_env()` reads four variables in total and **never touches `NO_PROXY`**, with
no `.no_proxy()` call anywhere:

```rust
pub fn proxy_from_env() -> Option<reqwest::Proxy> {
    let url = env::var("HTTPS_PROXY").ok()
        .or_else(|| env::var("https_proxy").ok())
        .or_else(|| env::var("HTTP_PROXY").ok())
        .or_else(|| env::var("http_proxy").ok())?;
    reqwest::Proxy::all(&url).ok()
}
```

`Proxy::all(&url).ok()` also means a **mistyped proxy URL is silently discarded** — the user believes
they are going through a proxy while the connection is direct, with no notice.

**This port** implements the full semantics: it reads `no_proxy`, supports the `*` wildcard along with
suffix and port matching, and matches entry by entry; an unsupported proxy protocol raises explicitly
rather than being ignored. Three cases in `packages/ai/test/node-http-proxy.test.ts` pin all three.

**Why it is kept**: this divergence points the way of "we do it right", and what it diverges from is a
security-relevant silent failure. `NO_PROXY` is an established de facto standard variable; inside a
corporate network it is what keeps internal hostnames from being sent to an external proxy. Following
upstream would mean deliberately deleting a correct implementation to reproduce the absence of a
feature **its own documentation promises**. The RULEBOOK's bug-for-bug principle is about the
behavioral contract, and here upstream's contract — its module documentation — contradicts its
implementation, so copying the implementation would mean choosing to violate the contract it wrote
for itself.

**Parity impact: none.** The judging environment sets no proxy variable (`grep -rn "NO_PROXY"
migration/parity/` finds nothing), so both sides take the no-proxy branch.

**History**: this was previously ED6 in `explained-divergences.tsv`, with the reason given as "not
observable by the judge, since it needs a real proxy environment". That framing was an evasion: not
observable says what the judge can see, not that there is no position to take. Phase 20-1 confirmed
the difference is real and promoted it to an explicit declaration.

---

## D12 — `ExecutionErrorCode` keeps `shell_unavailable` and `callback_error`

**Site** `packages/agent/src/harness/types.ts` (`ExecutionErrorCode`)
**Upstream** `crates/agent/src/harness/types.rs:67-73`, which has only `Timeout`, `Aborted`, `SpawnFailed` and `Unknown`

In the same review, three inconsistent `FileErrorCode` values (`not_directory`, `is_directory`,
`invalid`) and `ExecutionErrorCode`'s `spawn_error` were all renamed to upstream's serde values
(`not_a_directory`, `is_a_directory`, `invalid_path`, `spawn_failed`), and `not_supported`, which
existed only here and was never constructed, was removed. **Only these two values are kept.**

**Why they are kept**: the two situations they mark have no corresponding site upstream at all —

- `shell_unavailable` (`env/nodejs.ts:151,168`): this port looks for a shell before spawning and
  raises when it finds none. Upstream's `native.rs` has no shell discovery at all; it spawns directly
  and every failure becomes `SpawnFailed`.
- `callback_error` (`env/nodejs.ts:322,332`): a caller-supplied `onStdout` or `onStderr` callback
  throws. Rust callbacks do not throw, so this cannot happen upstream.

Folding them into `spawn_failed` and `unknown` would lose both distinctions for an alignment that is
purely formal: these codes **never enter the session record and are never sent to the model** (checked:
no path serialises the whole error object), and the two sides do not exchange this enum at runtime.
The only codes production code branches on are `not_found` and `aborted`, both already aligned.

**Parity impact: none** — the judging surface does not reach this type.

---

## D13 — an aborted turn still leaves an empty assistant entry in the session transcript

**Site** `packages/agent/src/agent-loop.ts:414-424` (the done and error branches of `streamAssistantResponse`)
**Upstream** `crates/agent/src/agent_loop.rs:315-319`

On `AssistantMessageEvent::Error`, which an abort also takes, upstream does `return Err(...)` and
clears `streaming_message`, **keeping that message out of the history**. This port pushes it into
`context.messages` and emits `message_end`, and on `message_end` the harness calls
`session.appendMessage(...)` (`agent-harness.ts:1282`) — so the transcript gains an entry.

**The other half of the same finding is aligned and is not part of this declaration**: the abort
payload itself. Each of the nine providers used to push the accumulated `output` — partial content,
accumulated tokens and **cost**, and the underlying error text — and now pushes upstream's
`push_aborted` empty message instead (see `packages/ai/src/utils/abort.ts`). So `costTracker.record()`
now receives all zeros and **an aborted turn is no longer billed** — the most harmful part of this
finding, closed and covered by a discriminating test (`abort-payload-midstream.test.ts`, where content
and usage accumulate before the abort).

**Why it is kept**: what remains is one empty entry in the transcript. Removing it means changing the
write into `context.messages`, when `message_end` is emitted, and the four chains that depend on that
event — harness, session, UI kernel and RPC. Measured, more than 20 test files and 30 assertions rest
on "an abort produces a message_end". Trading that surface of change for the visibility of one empty
entry does not pay, and the regression risk of the change exceeds the harm it removes.

**This is not "unobservable, therefore ignored"**: the difference is definite and observable, and was
judged not worth changing now. If it is aligned later, the entry point is that done and error branch
above, and the acceptance criterion is that the entry count from `--list-sessions` after an abort
matches the count without one.

**Parity impact: none** — none of the 12 scenarios triggers an abort midstream.

---

## The judging baseline after phase 18

`bash migration/parity/run-parity.sh` is now **expected to exit non-zero**. The legitimate set of
differences is exactly:

| file | DIFF | belongs to |
|---|---|---|
| `S3/requests.norm` | 2 | D4 |
| `S3/run.norm` | 8 | D1 + D2 |
| `S3/session.norm` | 12 | D1 + D2 |
| `S5/req2body.norm` | 2 | D4 |
| `S6/session.norm` | 24 | D1 + D2 |
| `S8/list.norm` | 2 | D5 |
| `S8/resumeerr.norm` | 2 | D5 |
| `S8/resumeexit.norm` | 2 | D5 |

**Everything else is 0. Any difference not in this table, or any change in a count within it, is a
defect and not a "known difference".** S1, S2, S4 and S7 must be DIFF 0 throughout. **S9, S10, S11 and
S12, the tool-execution scenarios, must be DIFF 0 throughout as well** — those four really execute
tool calls, and their `toolwire.norm` (the bytes the model actually received), `session.norm`,
`file.norm` (the bytes on disk), `exit.norm` and `err.norm` are now byte-identical.

**The S1 judging surface added in phase 19**: `s1-help.sh` used to merge both streams of `--help` and
`--version` into one file (`> raw 2>&1`), which made the whole class of "diagnostics on the wrong
stream" **structurally invisible** — and that is how F1 was missed on the state surface (outside a TTY
`pie --version` wrote the version to stderr, `$(pie --version)` came back empty, and S1 reported DIFF
0 throughout). They are now captured and compared separately as `helpout.norm`, `helperr.norm`,
`versionout.norm` and `versionerr.norm`, and **all four must be DIFF 0**. The first run after
separating them reported F1 immediately; once F1 was fixed all four went to zero.

## Phase 19 addendum: tool execution entered the judging surface, and five differences appeared at once

The fixture server's tool call count used to be **0**: across 8 scenarios and 14 smoke items, not one
tool was ever executed, and no test had the real binary change a file. The agent's core loop had only
ever been verified in-process against the faux provider.

Adding S9 through S12 revealed five previously invisible differences **immediately**, all since
aligned with upstream, none of which needed declaring as a divergence:

| # | difference | consequence |
|---|---|---|
| 1 | the bytes `read` returns to the model differ: upstream prefixes `[<path>] lines a-b\n` and carries `details{path,totalLines,keptLines,offset}`, while this port had neither and appended at the end instead | **the model receives different content from the same read**, and read's output format is exactly what the model reasons about line numbers and offsets from |
| 2 | the tool error text differs (`No such file or directory (os error 2)` against `ENOENT: …`) | reaches the model just as directly |
| 3 | `edit`'s `details` carries an extra `diff` and `firstChangedLine` | the session record's shape does not match |
| 4 | on error, `toolResult.details` is `null` upstream and `{}` here | as above |
| 5 | `write` has no `details` at all, where upstream has `{path,bytes,lines}` | as above |

**ED1 is closed**: it was filed as "not observable by the judge" on the grounds that no upstream
scenario covered replaying a history containing tools, and S9 through S12 cover exactly that. The
decision was to **align with upstream** — it never attaches an `id` to a `function_call` anywhere, and
its codex path does not even replay reasoning — so the compound `call_id|item_id` became a plain
`call_id`.

**B18 was added to the ledger**: `read`'s `details.totalLines` is an off-by-one upstream, reporting
`skip+limit+1` rather than the real line count, reproduced bug for bug and pinned by a test.

**A fourth blind spot in the judge is fixed**: `migration/parity/out/` is a shared write directory,
and every scenario begins with `find "$out" -mindepth 1 -delete` — so two concurrent parity runs
delete each other's artifacts and report **false** MISSING and DIFF results. That really happened this
round. `run-parity.sh` now holds an atomic lock at `out/.lock` and refuses loudly with exit 3 when
another run is in progress.

## Changes to the judge in phase 18, all of which **raise** sensitivity

Changing the judge requires an orchestrator decision and a self-check re-run; both were done, and
`judge-validation.md` records them:

1. **`normalize.mjs`: JSON lines expand across several lines.** A 22KB single-line request body can
   only report `DIFF: 1` under a line-by-line diff, so the difference declared as D4 reddens that line
   permanently and any regression among the 25 tool schemas on it becomes indistinguishable — and that
   is exactly where the heaviest bug of phase 17 lived. Expanded, each field takes its own line.
2. **`diff.mjs`: aligning by index became aligning by LCS.** Once lines are expanded, one structural
   insertion shifts every line after it under index alignment, inflating one real difference into
   hundreds of lines of noise. `DIFF: 0` still holds exactly when the two files agree line for line.
   `diff.mjs` had **no tests at all** before this — the judge had been judging both sides with nobody
   judging it — and `diff.test.mjs` was added.
3. **`s8-bad-tail.sh`: the exit code is really captured and included in the comparison.** See D5.

Self-check results: the upstream self-diff reports `ALL SCENARIOS: DIFF 0`, and the three injected
mutations M1, M2 and M3 are **3/3 DETECTED**.
