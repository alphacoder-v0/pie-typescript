# pie (TypeScript)

## What this is

`pie` is a terminal- and browser-based AI coding agent: run it inside a project and ask it to
inspect files, make edits, run shell commands, remember preferences, schedule recurring work, and
resume previous sessions. It reaches 32 model providers through one interface.

**This repository is a complete TypeScript rewrite of [pie](https://github.com/c4pt0r/pie), which
is written in Rust.** It is not a wrapper, a binding, or a partial port: every Rust module in the
behavioural scope was translated, and the result was verified byte-for-byte against the Rust
binary before this repository was considered done.

## Two upstreams

This repository has two ancestors, and they play different roles.

| Upstream | SHA | Role |
|---|---|---|
| [c4pt0r/pie](https://github.com/c4pt0r/pie) (Rust) | `0a120dfd` | **The behavioural contract.** Every observable behaviour here was aligned against this binary — bug for bug, byte for byte. It is referred to throughout the migration notes as "the oracle". |
| [earendil-works/pi](https://github.com/earendil-works/pi) (TypeScript) | `4868222e` | **The skeleton.** `packages/{ai,agent,coding-agent,tui}` were vendored from pi and then had pie's behaviour layered onto them. pie was itself a Rust rewrite of pi, so this closes the loop. |

`workers/fefe-hub` was copied straight from pie — that directory was already TypeScript upstream.
Full lineage, pinned SHAs and the licence chain are in [PROVENANCE.md](PROVENANCE.md) and
[NOTICE](NOTICE).

## Status

The migration reached its done-gate in phase 17 and was then deliberately taken *past* the oracle
in phase 18. Recorded in [`migration/parity/final-report.md`](migration/parity/final-report.md):

- All 8 differential scenarios ran byte-identical against the Rust binary (`DIFF 0`).
- Rust side: `cargo test --workspace` — 34 binaries, 1398 passed, 0 failed.
- TypeScript side: `npm test` — 4005 passed, 0 failed, 776 skipped (710 of those skip themselves
  when no provider key is present; 66 are individually documented gaps).

After phase 18 the parity baseline is "byte-identical to the oracle **except** for the declared
divergences below", so `run-parity.sh` now exits non-zero on purpose. Thirteen divergences are
declared, of which eight are visible to the differential harness; the exact expected diff counts are
pinned in
[`migration/parity/intentional-divergences.md`](migration/parity/intentional-divergences.md).

## Install

There is no published npm package for this rewrite. Build from source:

```bash
git clone <this repository>
cd pie_typescript
npm install
npm run build
```

That produces `packages/coding-agent/dist/cli.js`. The repo-root `./pie` script is a thin launcher
for it and works from any directory:

```bash
./pie --help
./pie --version          # prints "pie 0.75.0" — the ORACLE crate version, not this package's
```

To run straight from TypeScript sources without building, use `./pi-test.sh` (kept from the pi
skeleton, which is why it still has pi's name):

```bash
./pi-test.sh --help
./pi-test.sh --no-env    # same, with every provider API key unset
```

Node >= 22.19 is required (see `engines` in `package.json`).

## Configure a model

`pie` auto-detects the first available provider credential. The lookup order is fixed and the
first environment variable that is set wins:

```
ANTHROPIC_API_KEY  ->  anthropic / claude-haiku-4-5
OPENAI_API_KEY     ->  openai / gpt-4o-mini
DS4_API_KEY        ->  ds4 / deepseek-v4-flash
OPENROUTER_API_KEY ->  openrouter / openai/gpt-4o-mini
GROQ_API_KEY       ->  groq / llama-3.3-70b-versatile
MISTRAL_API_KEY    ->  mistral / mistral-large-latest
GEMINI_API_KEY     ->  google / gemini-2.0-flash
GOOGLE_API_KEY     ->  google / gemini-2.0-flash
```

Or pick explicitly:

```bash
./pie --provider anthropic --model claude-haiku-4-5
```

You can also store a key from inside the REPL with `/login <provider>`; it is written to
`~/.pie/auth.json`.

The built-in catalog carries 32 providers and 938 models — `./pie --help` prints the counts, and
`/model list [provider]` lists them.

### Local OpenAI-compatible models

Add a model definition to `~/.pie/models.json` (user-global) or `<project>/.pie/models.json`
(project-local — see [Project trust](#project-trust-a-new-security-gate), this file is gated), then
select it with `--provider` / `--model`. For [DS4](https://github.com/antirez/ds4) specifically,
setting `DS4_BASE_URL` (or `DS4_URL`), or passing `--base-url`, registers the conventional
`ds4` / `deepseek-v4-flash` descriptor without any `models.json` at all.

See [docs/ds4.md](docs/ds4.md) for the prefix-cache work that makes long local-model sessions
cheap, and how to verify it.

Note: `--base-url` requires an explicit `--provider`. Without one, model auto-detection could aim
whatever credential happens to be in your environment at the overridden endpoint, so `pie` refuses.

## Run

```bash
# Start in the current project
./pie

# Pick a model
./pie --provider anthropic --model claude-haiku-4-5

# Extended thinking where the model supports it
./pie --thinking high

# Resume: bare --resume opens a picker, --continue takes the most recent session
./pie --resume
./pie --continue
```

Then type a request:

```text
summarize this repository
fix the failing tests
when ~/build.done appears, run npm test and show me the result
```

### Which UI you get

This surprises people, so it is worth stating up front — the rule is inherited from Rust pie:

| Situation | UI |
|---|---|
| Local terminal (no SSH) | **Browser UI**, bound to loopback. `pie` prints `pie web listening on <url>` and tries to open your browser. |
| Remote terminal (`SSH_CONNECTION` / `SSH_CLIENT` / `SSH_TTY` / `MOSH_CONNECTION` set) | Full-screen terminal UI |
| stdin/stdout not a TTY (pipes, CI) | Line-based headless mode |

`--tui` forces the terminal UI on a local TTY; `--web` forces the browser UI anywhere. The browser
UI **refuses to bind a non-loopback address** — `--web-host` is validated and a non-loopback value
is a hard error, not a warning.

## Slash commands

Inside the REPL:

| Command | What it does |
|---|---|
| `/help [models\|<command>]` | Show available commands and model catalog help |
| `/clear` | Clear screen (keeps conversation history) |
| `/model [provider:model-id\|list [provider]]` | Show or switch the active model |
| `/thinking [level]` | Show or set the thinking level |
| `/cost [reset]` | Running token / USD totals for this session |
| `/diag` | Diagnostic info (model, thinking, cost, log path) |
| `/compact ["instructions"]` | Force a context compaction now |
| `/undo` | Remove the most recent user+assistant turn from the active branch |
| `/save [path]` | Export the transcript to Markdown |
| `/share [--public]` | Upload the transcript as a Gist via `gh` |
| `/session export [path] [--exclude-triggers] \| import <path>` | Replayable `.piesession` backups |
| `/sessions` | List sessions for this cwd |
| `/name [slug]` | Show or set the current session's name |
| `/find <query>` | Search every session in this cwd |
| `/history [N]` | Recent submitted prompts from `~/.pie/history` |
| `/login <provider>` / `/logout <provider>` | Manage stored credentials |
| `/skills […]` / `/skill <name>` | List/install/inspect skills; attach one to the next prompt |
| `/template [name] [k=v …]` | List or run a prompt template |
| `/goal […]` / `/goal-start <prompt>` | Session goal stop-hook |
| `/triggers […]` / `/new-trigger <request>` | Dynamic natural-language triggers |
| `/cron [list\|add\|enable\|disable\|remove]` | Local scheduled agent jobs |
| `/inbox [all\|claim <n>\|dismiss <n>\|clear]` | Triage findings from stateful loops |
| `/bug-report` | Redacted diagnostic dump |
| `/web-connect [status]` / `/web-disconnect` | Mount/unmount this session at the public relay |
| `/quit` (`/exit`, `/q`) | Exit |

## CLI flags

Every flag below is in `./pie --help`. The help page is byte-identical to the Rust binary's, which
is one of the parity scenarios — so it is reproduced by hand rather than generated, and adding a
flag to it is a deliberate act (see [Project trust](#project-trust-a-new-security-gate)).

| Flag | Notes |
|---|---|
| `--provider <PROVIDER>` / `--model <MODEL>` | Explicit model selection |
| `--base-url <URL>` | Override the model's base URL for this run; requires `--provider` |
| `--thinking <off\|minimal\|low\|medium\|high\|xhigh>` | Default `off` |
| `--resume [<ID>]` / `--resume-id <ID>` / `-c`, `--continue` | Session selection |
| `--list-sessions` / `--list-all-sessions` / `--delete-session <ID>` | Session management, then exit |
| `--image <PATH>` | Attach an image to the first prompt; repeatable |
| `--trigger-poll-secs <SECONDS>` | Dynamic trigger poll interval; default 600 |
| `--debug` | LLM call debug logs in the feed |
| `--yes` / `--always-allow` | Auto-approve control-plane prompts / every approval prompt |
| `--web` / `--tui` | Force the browser or terminal UI |
| `--web-host <HOST>` / `--web-port <PORT>` | Default `127.0.0.1` / `0`; loopback enforced |
| `--builtin-skill <NAME>` | **Parsed but currently inert in this port** — see [Limits](#limits-what-is-not-here-yet) |
| `-h`, `--help` / `-V`, `--version` | |

Two flags are *not* in `--help`, on purpose:

- `--trust-project` — see below. It is stripped from `argv` before the argument parser runs, so
  that the byte-exact help page stays untouched.
- `--offline` (plus `PI_OFFLINE=1`) — a skeleton-inherited flag that suppresses network version
  checks.

## Intentional divergences from Rust pie

Everything else in this port reproduces the Rust original faithfully, **including its bugs** — that
was the migration rule, because a port that quietly "improves" things cannot be verified against
anything. Six behaviours were then deliberately changed after the parity gate was met. Each has its
own commit, its own before/after differential output, and a full write-up in
[`migration/parity/intentional-divergences.md`](migration/parity/intentional-divergences.md).

Four of these you will actually feel:

**D2 — Cost figures are real instead of always `$0`.** In Rust pie no provider ever computed
`usage.cost`, so every dollar amount the product showed a user — `/cost`, session records,
everything — was `0`. This port prices usage against the model catalog. The knock-on effect is that
`budget_cap_usd` finally does something: it used to be checked only between prompts (and against a
number that was always zero), so a runaway agent loop was exactly the case it failed to stop. It is
now a hard gate inside the loop. The cap can still be exceeded by the cost of the single request
that crosses it — cost is only known once a request completes.

**D3 — A project-local `.pie/` config is no longer executed without explicit trust.** Rust pie read
`<cwd>/.pie/mcp.toml` and `<cwd>/.pie/lsp.toml` unconditionally and spawned the commands they name
— eagerly for MCP stdio servers, lazily on the first matching edit for LSP. Cloning an untrusted
repository and merely opening it, or merely editing a file in it, ran arbitrary commands from
inside that repository. This port defaults to deny. See the next section.

**D5 — A session with a truncated final line now opens instead of failing.** A half-written last
line is the normal result of a process being killed mid-write. Rust pie failed the *entire* load,
so `--resume` and `--continue` refused an arbitrarily long healthy conversation because of the last
half line — while `--list-sessions` kept listing it, leaving you with a session you could see but
not open. This port salvages the truncated tail (and only the tail: corruption in the middle of a
file still fails, because that is a different fault and skipping it would hide real data loss),
truncates the file back to the healthy prefix so the damage cannot migrate into the middle, and
says so on stderr.

**D4 — A model-created cron job starts disabled.** Rust pie's model-callable `NewCronJob` tool
created jobs that were live on the next tick with no human involved, while its `SetCronJobState`
tool *refused* a model-driven enable and told the user to run `/cron enable`. Two tools, one
capability, opposite rules. This port picks the strict one: the model can create a job, only a
person can bring it into effect. `/cron add` — a human action — is unchanged. The tool description
the model sees was changed too, so it tells you the job needs enabling instead of reporting it as
scheduled.

The remaining two are quieter:

**D1 — Usage accounting no longer double-counts cached input.** Two OpenAI-family providers kept the
provider's raw `input_tokens` (which already includes cached tokens) and then added the cache
buckets on top, so 100 input / 80 cache-read / 20 cache-write / 10 output was reported as 210
instead of 110. Only the two providers that actually had the bug were changed; several others carry
comments describing the same bug but their arithmetic was already correct.

**D6 — `LatestReplaces` actually replaces.** The trigger runtime's deduplication map was only ever
written once per key, so a replacement policy named latest-wins behaved as first-wins and downstream
correlation pinned itself to a trace the caller believed had been superseded.

## Project trust: a new security gate

Three project-local files can change what code runs or where your prompts go:

| File | Risk |
|---|---|
| `<cwd>/.pie/mcp.toml` | stdio MCP servers are spawned at startup |
| `<cwd>/.pie/lsp.toml` | the configured `command` is spawned on the first matching edit |
| `<cwd>/.pie/models.json` | not code execution, but one `baseUrl` silently points inference at someone else's endpoint — every prompt, file excerpt and tool result in the session goes there |

None of them are read unless the directory is trusted. Trust is granted by any of:

```bash
# Persist trust for the current directory and use it immediately for this run
./pie --trust-project

# Run-scoped, never persisted — the CI / headless escape hatch
PIE_TRUST_PROJECT=1 ./pie
```

or by an existing entry in the trust store at `~/.pie/trust.json` (`PIE_DIR` overrides apply).

Details that matter:

- **The gate is deterministic, never interactive.** There is no confirmation prompt: this binary has
  to work headless and inside the differential harness.
- **Skipping is never silent.** An existing but untrusted config produces one stderr line naming the
  exact file that was ignored and both ways to allow it. Silence would be worse than the original
  bug. All trust notices go to stderr, never stdout — stdout is the machine-readable surface.
- **`--trust-project` trusts `process.cwd()`**, the directory you are standing in when you type it.
  Resuming a session that was recorded elsewhere stays gated on *its* own directory.
- **Trust keys on the symlink-resolved absolute path**, so a symlink farm cannot launder an
  untrusted directory into a trusted one.
- **Reading the gate has no side effects.** Asking "is this directory trusted?" never creates
  `~/.pie/` and never creates `trust.json`.
- **Trusting does not restore silent overrides.** A trusted project entry still wins over a
  same-named user entry — that is what a project override is for — but the substitution is now
  announced on stderr. Rust pie's real harm here was the silence.
- The store is written 0600 inside a 0700 directory, via a temp file and an atomic rename. If it
  cannot be written (read-only `$HOME`, full disk), `--trust-project` still grants trust for the
  current run and tells you it could not remember the decision.

Full reference: [docs/project-trust.md](docs/project-trust.md).

Separately, and inherited unchanged from Rust pie: project hooks at `<cwd>/.pie/hooks.toml` are
ignored unless `allow_project_hooks = true` is set in your user `~/.pie/hooks.toml`, or
`PIE_ALLOW_PROJECT_HOOKS=1` is in the environment.

## Automation

- **Dynamic triggers** — describe an automation in chat ("when `$HOME/helloworld` exists, print its
  contents") and `pie` creates a rule. Rules are stored next to the active session, so a new session
  starts clean and `--resume` brings that session's rules back. Local checks poll every 600 seconds
  by default (`--trigger-poll-secs`, or `[triggers] poll_interval_secs` in `~/.pie/config.toml`),
  and only while at least one enabled rule exists.
- **Cron jobs** — `/cron add "*/30 * * * *" summarize the repo state`. Standard 5-field expressions,
  local time. Missed ticks after downtime are not backfilled. If a job is still running when its
  next tick arrives, that tick is skipped and counted in the job's status.
- **Loops** — `/cron add --stateful …` turns a cron job into a recurring job with a memory file and
  a triage inbox. Full guide: [docs/loops.md](docs/loops.md).
- **MCP notifications** — configured MCP servers can push notification frames, which are normalized
  into the same trigger runtime (dedup, audit, action queue) as local checks.
- **Lifecycle hooks** — `~/.pie/hooks.toml` can run commands or POST webhooks on agent lifecycle
  events. Ported, tested, **but not yet wired into the CLI in this port** — see
  [docs/hooks.md](docs/hooks.md).

## Files and storage

`pie` stores local state under `~/.pie` (override the base directory with `PIE_DIR`):

| Path | What |
|---|---|
| `~/.pie/sessions/<cwd-hash>/<uuidv7>.jsonl` | Session history for each project |
| `~/.pie/sessions/<cwd-hash>/<uuidv7>.triggers.json` | Session-scoped dynamic trigger rules |
| `~/.pie/sessions/<cwd-hash>/<uuidv7>.cron.toml` | Session-scoped cron jobs |
| `~/.pie/sessions/<cwd-hash>/<uuidv7>.loop-cron-<8 hex>.md` | Loop state kept by a stateful cron job |
| `~/.pie/inbox.jsonl` | Global triage inbox written by stateful loops |
| `~/.pie/memory/*.md` | Cross-session memory injected into future sessions |
| `~/.pie/auth.json` | Stored credentials from `/login` |
| `~/.pie/trust.json` | **New in this port.** Trusted project directories |
| `~/.pie/models.json` | User-global local/custom model definitions |
| `~/.pie/history` | Prompt history |
| `~/.pie/mcp.toml` | User-global MCP server config |
| `~/.pie/hooks.toml` | Lifecycle hooks (see the note above about wiring) |
| `~/.pie/config.toml` | Optional user config, including the trigger poll interval |
| `~/.pie/prompts/` | Prompt templates. **Rust pie calls this directory `templates/`** — the rename is inherited from the pi skeleton and is a known, recorded divergence |

`<cwd-hash>` is the first 6 bytes of the SHA-256 of the cwd string, hex-encoded.

## What the coverage figures do not establish

The gates report 513 of 513 functions decided, 4412 tests passing, and eight declared parity
divergences. Those numbers are worth reading precisely, because each is narrower than it sounds.

- **Function-level evidence is not behavior-level evidence.** `check:behavior-evidence` requires every
  one of the 513 upstream public functions to carry a verdict with evidence attached. A verdict of
  `existing-test` means some assertion touches that function's behavior — not that every branch, edge
  case or interaction is covered. Of the 513, **144 are adjudicated `not-portable`**: the counterpart
  here is named differently, structured differently, or genuinely absent. Each carries a written
  reason in `migration/reviews/phase23/evidence.tsv`, and none of them is a test.
- **The AWS Bedrock provider is a placeholder of six lines.** `packages/ai/src/bedrock-provider.ts`
  exports a stub and nothing else. The binary `vnd.amazon.eventstream` frame path, crc32 frame
  validation and the Converse streaming invocation were never ported. If you need Bedrock, it is not
  here — and the 513/513 figure does not tell you that, because those functions are among the 144.
- **Live providers are not gated.** Everything `npm run check` and `npm test` exercise runs against
  fixtures. What a real Anthropic, OpenAI or Gemini endpoint does — its rate limiting, its error
  shapes, its billing — is exercised only by `npm run test:live`, which no gate runs and which costs
  real money. `migration/parity/unverified.md` lists every surface the differential harness cannot see.
- **Performance is not gated.** This starts in roughly 860ms where the Rust binary takes roughly 7.5ms,
  and about 96% of that is the module graph rather than Node itself. It is measured in
  `migration/reviews/phase19/perf-baseline.md`, and deliberately has no threshold: there is no fair
  comparison to draw between a Rust binary and a Node module graph.
- **One platform.** Verified on Linux. macOS and Windows are out of scope.

## Where the evidence lives

Every claim above is checkable from the repository. The migration record is not a narrative; it is the
data the gates read.

| Path | What it is |
|---|---|
| [`migration/RULEBOOK.md`](migration/RULEBOOK.md) | The translation rules — the single source of truth for how each Rust construct maps, and the ledger of upstream defects reproduced on purpose |
| [`migration/manifest.tsv`](migration/manifest.tsv) | The work queue: every upstream source file, its classification, and where it landed |
| [`migration/reviews/phase23/evidence.tsv`](migration/reviews/phase23/evidence.tsv) | The verdict and the evidence for each of the 513 functions |
| [`migration/parity/`](migration/parity/) | The differential harness: the scenarios, the judge, and the judge's own self-validation |
| [`migration/parity/intentional-divergences.md`](migration/parity/intentional-divergences.md) | Where this port deliberately does not match upstream, and the reasoning for each |
| [`migration/post-parity-backlog.md`](migration/post-parity-backlog.md) | Every `TODO(port)` and `PERF(port)`, triaged and individually argued |
| [`MIGRATION-REPORT.md`](MIGRATION-REPORT.md) | The summary, including what is still open |

## Limits: what is not here yet

These are honest gaps, not bugs to file. The complete inventory — 147 `TODO(port)` and `PERF(port)`
markers, bucketed and individually justified — is
[`migration/post-parity-backlog.md`](migration/post-parity-backlog.md).

- **`~/.pie/hooks.toml` is never loaded.** `src/hooks.ts` is a complete, tested port of the hook
  runner, but nothing in the CLI imports it, so no hook fires. One wiring change away.
- **`--builtin-skill` is inert.** The flag parses and `src/builtin-skills.ts` is ported; the
  skill-loader wiring is not.
- **`pie session export` / `pie session import` as a *CLI subcommand* is not wired.** The row appears
  in `--help` because that page reproduces the Rust binary's byte-for-byte; typing it today is
  treated as a prompt. The `/session export|import` **slash command** does work.
- **`/cron remove` leaves the loop state file behind.** Rust pie's own documentation claims it is
  deleted; the code never deleted it, and this port reproduces that faithfully. Ledger row B7.
- **Some tool capabilities differ.** `grep`'s fixed-string and context modes, `edit`'s batch engine,
  and `read`'s image branch exist in the skeleton but are no longer in the model-visible schema
  because the Rust original has no counterpart. They remain reachable to in-process/SDK callers.
- **Eight known upstream defects were reproduced but not fixed.** They are listed with reasoning in
  the backlog's Y section. The two worth knowing about: a failed or cancelled model response is
  recorded as a normal stop (B12), and replayed tool calls render with doubled parentheses that live
  ones do not (B17).

## Development

```bash
npm install          # Install all dependencies
npm run build        # Build every package, then workers/fefe-hub
```

## Test

```bash
npm test             # Hermetic: backs up ~/.pie/auth.json, unsets every provider key, PI_NO_LOCAL_LLM=1
npm run test:raw     # Same tests without the hermetic wrapper (will use real credentials)
npm run test:live    # Only the tests that need a real provider. Costs money. No gate runs it
```

`npm test` runs `bash test.sh`, and it is hermetic on purpose: a machine with real credentials and a
local model server would otherwise bill real providers and pull a 13 GB model when the suite runs
bare. 4412 tests pass and none fail; 776 skip themselves for want of a credential.

## Gates

```bash
npm run check
```

That runs biome, four dependency and import checks, `tsgo --noEmit`, a browser-bundling smoke test,
and these migration gates:

| Gate | What it holds |
|---|---|
| `check:oracle-version` | Nine version literals still equal the upstream crate versions |
| `check:surface-coverage` | How many upstream public functions have no counterpart here (baseline 40 of 513) |
| `check:inline-test-ports` | How many upstream inline tests are unported (baseline 190 of 541) |
| `check:source-anchors` | Every `pie: <file>.rs:NNN` anchor and every upstream test name is still present |
| `check:english-prose` | No Chinese prose outside the recorded allowlist of behavioral literals |
| `check:triage-ledger` | Every roster row is adjudicated |
| `check:behavior-evidence` | All 513 roster functions carry behavioral evidence |
| `check:manifest` | The manifest covers every upstream source file |

Five of them need a checkout of the Rust original to mean anything. Without one they print SKIP and
exit 0, so a fresh clone with no configuration passes. To run them fully:

```bash
export UPSTREAM_ORACLE_DIR=/path/to/pie
export UPSTREAM_SKELETON_DIR=/path/to/pi
npm run check
```

Differential testing against the Rust binary:

```bash
bash migration/parity/run-parity.sh                     # all 8 scenarios
bash migration/parity/run-parity.sh --scenarios S1,S3   # a subset
```

It is expected to exit non-zero — the legal diff set is exactly eight files, enumerated with their
counts in `migration/parity/intentional-divergences.md`. Any difference not in that table, or a change
in the counts, is a defect.

```bash
bash migration/parity/run-parity.sh --self-check       # the judge validates itself
```

That diffs the Rust binary against itself, expecting zero, then injects three behavioral mutations and
expects all three to be caught. A judge that cannot fail is not a judge.

Never run `cargo` in this repository; it is denied by configuration. All oracle operations go
through the wrapper scripts in `migration/parity/`.

## Repository layout

| Path | What |
|---|---|
| `packages/coding-agent` | The `pie` CLI, REPL, browser UI, triggers, cron, loops, inbox |
| `packages/agent` | `@pie/agent-core` — agent runtime, tool calling, session state, harness |
| `packages/ai` | `@pie/ai` — unified multi-provider LLM API |
| `packages/tui` | `@pie/tui` — terminal UI library with differential rendering |
| `packages/mcp` | `@pie/mcp` — MCP client, new in this port (pie-only crate, no pi counterpart) |
| `workers/fefe-hub` | Cloudflare Worker, reused from pie |
| `migration/` | The migration record: rulebook, work queue, differential harness, reviews |
| `docs/` | User documentation |

The dependency direction is fixed by the migration rulebook: `coding-agent -> agent-core -> ai`, with
`mcp` and `tui` as leaves that only `coding-agent` imports. Reverse imports are not permitted.

## Documentation

- [docs/loops.md](docs/loops.md) — stateful cron jobs and the triage inbox
- [docs/ds4.md](docs/ds4.md) — KV prefix-cache optimizations for local models
- [docs/hooks.md](docs/hooks.md) — lifecycle hooks (ported; not wired to the CLI yet)
- [docs/project-trust.md](docs/project-trust.md) — the trust gate in full
- [docs/web-ui.md](docs/web-ui.md) — the browser UI
- [CHANGELOG.md](CHANGELOG.md) — what changed in this release
- [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) — inherited from the pi skeleton

For how the rewrite itself was run, start at [CLAUDE.md](CLAUDE.md) and
[`migration/RULEBOOK.md`](migration/RULEBOOK.md).

## Supply-chain hardening

Inherited from the pi skeleton and kept:

- Direct external dependencies are pinned to exact versions; internal workspace packages stay
  version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2`.
- `package-lock.json` is the dependency ground truth; pre-commit blocks accidental lockfile commits
  unless `PI_ALLOW_LOCKFILE_CHANGE=1`.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and the
  generated coding-agent shrinkwrap.
- Shrinkwrap generation has an explicit allowlist for dependency lifecycle scripts; new
  lifecycle-script dependencies fail checks until reviewed.

## License

MIT — see [LICENSE](LICENSE). Three copyright holders are involved: pi (Mario Zechner), pie
(c4pt0r/dongxu), and this rewrite. The attribution for each, and the derivation of every file, is in
[NOTICE](NOTICE) and [PROVENANCE.md](PROVENANCE.md).
