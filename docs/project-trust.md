# Project trust

**This feature does not exist in Rust pie.** It was added in this TypeScript port as divergence D3;
the full rationale, the parity evidence and the reasoning about scope are in
`migration/parity/intentional-divergences.md`.

## The problem it fixes

Rust pie read three project-local files unconditionally, straight out of whatever directory you
happened to be standing in:

| File | What reading it does |
|---|---|
| `<cwd>/.pie/mcp.toml` | stdio MCP servers named in it are **spawned at startup** |
| `<cwd>/.pie/lsp.toml` | the `command` named in it is **spawned on your first matching file edit** |
| `<cwd>/.pie/models.json` | not execution — but one `baseUrl` points inference at an arbitrary endpoint |

Cloning an untrusted repository and merely opening it — or merely editing a file in it — ran
arbitrary commands from a file inside that repository. That was the most serious defect on the
migration's ledger.

`models.json` is not remote code execution, but it is not benign either: a hostile `baseUrl` sends
every prompt, every file excerpt and every tool result of the session to someone else's server,
silently. Gating two of the three files would have been a fence with a door-shaped hole next to it.

## The design

Default deny, explicit allow, and **deterministic** — there is no confirmation prompt. This binary
has to work headless, in CI, and inside the differential test harness, so an interactive question
was not an option.

A project-local config is not read at all unless its directory is trusted. Trust is granted by any
one of:

1. a persisted entry in `~/.pie/trust.json`;
2. `pie --trust-project`, which records that entry for the current directory and takes effect
   immediately for the same run;
3. `PIE_TRUST_PROJECT=1` (or a case-insensitive `true`) in the environment — the CI/headless escape
   hatch, run-scoped only, never persisted.

`~/.pie/` here means whatever `getAgentDir()` resolves to, so `PIE_DIR` and `PI_CODING_AGENT_DIR`
overrides apply, exactly as they do for `auth.json`.

## Granting trust

```bash
# Persist for this directory and use it immediately
./pie --trust-project

# One run only, nothing written to disk
PIE_TRUST_PROJECT=1 ./pie
```

On success `--trust-project` prints, on **stderr**:

```text
pie: trusted project /home/you/src/example (recorded in /home/you/.pie/trust.json)
```

If the store cannot be written (read-only `$HOME`, full disk, …), trust still holds for the current
run and you are told the decision was not remembered:

```text
pie: trusted project /home/you/src/example for this run only; could not write /home/you/.pie/trust.json: <reason>
```

### Why `--trust-project` is not in `--help`

`pie --help` is byte-compared against the Rust binary's help page — it is one of the eight
differential scenarios. Adding a row would break that comparison. So the flag is consumed *before*
the argument parser runs and stripped from `argv`.

Stripping it early has a second benefit: the argument parser's unknown-flag fallback treats a
following non-flag token as the flag's value, so `pie --trust-project "fix the bug"` would otherwise
swallow your prompt.

The cost is that the flag is invisible in `--help`. That is acceptable because the skip notice names
it — you see the flag at exactly the moment you need it.

## What a blocked config looks like

An existing but untrusted project config is skipped with one line on stderr, naming the exact file
and both ways to allow it:

```text
pie: ignored untrusted project config /home/you/src/example/.pie/mcp.toml; run `pie --trust-project` in /home/you/src/example or set PIE_TRUST_PROJECT=1 to load it
```

One notice per skipped file. **Silence would be worse than the original bug** — a user who does not
know their config was ignored will spend the session confused about why their MCP server is missing.

## Semantics worth knowing

- **Scope is `process.cwd()`.** `--trust-project` trusts the directory you are standing in when you
  type it. A session whose effective directory differs — resuming a session recorded elsewhere —
  stays gated on *its* own directory. A flag typed in directory A must not silently authorize
  directory B.
- **Keys are symlink-resolved.** The store is keyed by the `realpath` of the absolute directory
  path, so a symlink farm cannot launder an untrusted directory into a trusted one. If a path cannot
  be resolved (it may not exist yet), the plain absolute path is used — which simply never matches a
  resolved stored key, and therefore fails closed.
- **Reads have no side effects.** Asking "is this directory trusted?" never creates `~/.pie/` and
  never creates `trust.json`. This is not incidental: the differential harness snapshots the entire
  `$HOME/.pie` tree, so a store that materialized itself on read would show up as a difference.
- **Trust is an exact directory match.** Trusting `/src/example` does not trust `/src/example/sub`.
  There is no inheritance by descendants.
- **Running from `$HOME` is not gated at all.** When `<cwd>/.pie` resolves to your *own* config
  directory — you started `pie` in `$HOME`, or in the parent of whatever `PIE_DIR` names — there is
  no project config in play, only the user config every loader reads unconditionally. The gate does
  not fire and no notice is printed. This cannot be used to launder a hostile project: the only way
  for `<cwd>/.pie` to resolve onto the user config directory is for it to *be* that directory.
- **An unreadable or malformed store grants nothing.** Any read, parse or shape failure yields an
  empty store rather than an error — fail closed.
- **Trusting is not a licence to be silent.** A trusted project entry still wins over a same-named
  user entry — that is what a project override is *for* — but the substitution is announced:

  ```text
  pie: project mcp.toml server 'github' overrides the same-named entry in /home/you/.pie/mcp.toml
  ```

  Rust pie made this substitution silently, and the silence was the real harm: you kept believing
  your own `~/.pie/` server was the one running.
- **Every notice goes to stderr, never stdout.** stdout is the machine-readable surface — `--print`,
  `--mode json`, and the byte-compared scenarios.

## The store on disk

`~/.pie/trust.json`, written 0600 inside a 0700 directory via a temp file and an atomic rename. It
names directories whose contents are allowed to spawn processes, so it must never be world-readable,
not even briefly.

```json
{
  "version": 1,
  "projects": {
    "/home/you/src/example": {
      "trustedAt": "2026-08-04T09:15:00.000Z"
    }
  }
}
```

`trustedAt` is informational only; nothing expires.

Writes are read-modify-write without a lock. Two concurrent grants of *different* directories can
lose one of the two entries. The failure mode is "you have to run `--trust-project` again", never
"a directory became trusted that you did not trust" — which is why the heavier locking machinery
`auth.json` uses was deliberately not pulled in here.

## Revoking trust

There is **no CLI command to revoke trust today.** The revoke and list functions exist in the module
and are covered by tests, but nothing in the CLI calls them. To untrust a directory, edit or delete
`~/.pie/trust.json` by hand.

## What is not gated

- `~/.pie/mcp.toml`, `~/.pie/lsp.toml` and `~/.pie/models.json` — your own user-scope config is
  never gated.
- `<cwd>/.pie/hooks.toml` — project hooks have their own, older opt-in switch inherited from Rust
  pie: `allow_project_hooks = true` in your user `hooks.toml`, or `PIE_ALLOW_PROJECT_HOOKS=1`. See
  [hooks.md](hooks.md). (Hooks are not currently wired into the CLI at all.)
- Anything the agent does *after* it starts. Trust governs which config files are read; it is not a
  sandbox and does not restrict tool use.
