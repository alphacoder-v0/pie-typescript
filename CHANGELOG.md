# Changelog

All notable changes to the TypeScript rewrite of `pie`. Entries are grouped by what a user would
notice, not by how the work was scheduled.

## Initial TypeScript release — 2026-08-04

Monorepo version `0.0.3`. `pie --version` reports `0.75.0`, which is the **Rust crate's** version,
not this package's — the version string is part of the byte-compared surface and deliberately
tracks the oracle.

### The rewrite

`pie` — previously a Rust agent runtime — is now TypeScript, end to end. The route was: fork the
[pi](https://github.com/earendil-works/pi) TypeScript skeleton (`4868222e`), then layer every
behavioural difference of Rust [pie](https://github.com/c4pt0r/pie) (`0a120dfd`) onto it, module by
module, verifying against the Rust binary the whole way.

What that means in practice:

- **The Rust binary was the specification, bugs included.** Where the Rust original was wrong, this
  port was made wrong in the same way, on purpose, and the defect was recorded — so that "different
  from the original" always meant "defect in the port" and never "improvement we forgot to write
  down". The list of deliberate exceptions is below and is the whole list.
- **Verified, not asserted.** Eight scenarios run the Rust binary and this one side by side and
  compare their output byte for byte: `--help` / `--version`, an empty-environment REPL start,
  streaming usage accounting, HTTP 409 retry, local-model reasoning replay, session JSONL on disk,
  the cron surface, and a session file with a truncated tail. All eight were byte-identical at the
  point the migration was declared done.
- **Same storage, same files.** Sessions, trigger sidecars, cron sidecars, loop state, the inbox,
  credentials and history all keep the Rust layout under `~/.pie`, down to filenames.
- **Build and test are npm, not cargo.** `npm run build`, `npm run check`, `npm test`. Node >= 22.19.

### Deliberately different from Rust pie

Six behaviours diverge from the Rust original on purpose. Every one has an individual write-up,
commit and before/after differential output in `migration/parity/intentional-divergences.md`.
Anything *not* in this list that differs from Rust pie is a bug.

- **Cost figures are real.** Rust pie never computed `usage.cost` in any provider, so every dollar
  amount the product showed — `/cost`, session records, budget checks — was `$0.00`. Usage is now
  priced against the model catalog. Consequently `budget_cap_usd` is a hard gate *inside* the agent
  loop, where it was previously only checked between prompts and against a number that was always
  zero. The cap can still be overshot by the cost of the one request that crosses it; cost is only
  known after a request completes. Test-double (`faux`) provider usage still reports `$0` by design.
- **Project-local `.pie/` config now requires explicit trust.** Rust pie read `<cwd>/.pie/mcp.toml`
  and `<cwd>/.pie/lsp.toml` unconditionally and spawned the commands inside them — at startup for
  MCP stdio servers, on your first matching file edit for LSP. Cloning an untrusted repository and
  opening it was enough to execute code from it. Default is now deny. Grant with
  `pie --trust-project`, `PIE_TRUST_PROJECT=1`, or an entry in `~/.pie/trust.json`. A skipped config
  prints one stderr line naming the file and both ways to allow it. `<cwd>/.pie/models.json` was
  added to the same gate: it is not code execution, but a single `baseUrl` silently redirects every
  prompt, file excerpt and tool result of the session to someone else's endpoint.
- **A session with a truncated final line opens instead of failing.** A half-written last line is
  what a killed process leaves behind. Rust pie failed the entire load, so `--resume` /
  `--continue` refused an arbitrarily long healthy conversation over the last half line — while
  `--list-sessions` kept listing it. The truncated tail is now discarded, the file is truncated back
  to its healthy prefix (so the bad line cannot end up mid-file on the next append), and a warning
  naming the session and line number goes to stderr. Corruption anywhere *other* than the final line
  still fails: that is a different fault and skipping it would hide real data loss.
- **A cron job the model creates starts disabled.** Rust pie's model-callable `NewCronJob` put a job
  live on the next tick with no human involved, while `SetCronJobState` refused a model-driven
  enable and demanded `/cron enable`. The strict rule now applies to both: a model can create a job,
  only a person can bring it into effect. The human `/cron add` path is unchanged. The tool
  description the model reads was updated too, so it reports the job as needing enabling rather than
  as scheduled.
- **Usage no longer double-counts cached input.** Two OpenAI-family providers added the cache buckets
  on top of a raw `input_tokens` that already contained them — 100 input / 80 cache-read / 20
  cache-write / 10 output was reported as 210 rather than 110. Only the two providers with the
  actual defect were changed; several others carry comments describing the same defect but their
  arithmetic was already correct.
- **`LatestReplaces` replaces.** The trigger runtime wrote a deduplication entry once per key and
  never rewrote it, so a policy named latest-wins behaved as first-wins and downstream correlation
  stayed pinned to a trace the caller believed had been superseded. First-arrival policy dominance
  and the non-sliding dedup window are unchanged.

### Security

- New trust store at `~/.pie/trust.json`: 0600 file inside a 0700 directory, written via temp file
  and atomic rename, keyed by symlink-resolved absolute path. Reads are strictly side-effect free —
  asking whether a directory is trusted never creates the store.
- `--trust-project` grants and persists trust for `process.cwd()` and applies immediately to the
  same run. If the store cannot be written, trust still holds for that run and you are told it was
  not remembered. The flag is intentionally absent from `--help` (adding it would change a
  byte-compared page); the skip notice names it at the moment you need it.
- `PIE_TRUST_PROJECT=1` is the headless/CI escape hatch — run-scoped, never persisted.
- A trusted project entry still overrides a same-named user entry, but the substitution is now
  announced on stderr instead of happening silently.
- The browser UI refuses to bind any non-loopback address; `--web-host` validation is a hard error.

### Known gaps

Complete, individually justified inventory in `migration/post-parity-backlog.md`.

- `~/.pie/hooks.toml` is never loaded. The hook runner is fully ported and tested, but no CLI code
  imports it, so no hook fires.
- `--builtin-skill` parses but does nothing: the built-in skill module is ported, the loader wiring
  is not.
- `pie session export` / `pie session import` as a **CLI subcommand** is not dispatched — the row is
  in `--help` only because that page reproduces the Rust binary's byte for byte. The
  `/session export|import` **slash command** works.
- `grep`'s fixed-string and context modes, `edit`'s batch engine, and `read`'s image branch were
  removed from the model-visible schema because the Rust original has no counterpart. They remain
  reachable to in-process/SDK callers.
- Prompt templates live in `~/.pie/prompts/`; Rust pie calls that directory `templates/`.
- Six hardcoded version literals track the Rust crate version rather than any `package.json`, and
  nothing yet fails the build when the two drift.

### Reproduced defects that were not fixed

Kept bug-for-bug and individually argued in `migration/post-parity-backlog.md`. The two most likely
to be noticed:

- A response the API reports as `failed` or `cancelled` is recorded as a normal stop, in the session
  and in the UI.
- A replayed tool call renders with doubled parentheses — `read((path="…"))` — where the live path
  renders one set.

Also inherited: `/cron remove` deletes the job but leaves its `loop-<id>.md` state file behind, even
though Rust pie's documentation says otherwise.

### Build and tooling

- `npm test` runs a hermetic wrapper that moves `~/.pie/auth.json` aside, unsets every provider
  credential and sets `PI_NO_LOCAL_LLM=1`, so the suite cannot bill a real provider or pull a local
  model. `npm run test:raw` is the unwrapped form.
- The `@pie/ai` model catalog is generated offline from the Rust snapshot rather than fetched at
  build time, so builds are reproducible and the catalog cannot drift under the test suite.
- `packages/mcp` is new: a hand-written MCP client with no external protocol SDK, matching the Rust
  crate's own hand-rolled framing.
- `cargo` is denied in this repository. Everything that touches the Rust original goes through the
  wrapper scripts in `migration/parity/`.
