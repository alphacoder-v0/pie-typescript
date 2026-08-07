# pie documentation

User documentation for the TypeScript rewrite of `pie`. Start at the repository
[README](../README.md) for install, usage, the full CLI surface and the list of intentional
divergences from Rust pie.

| Page | Subject |
|---|---|
| [loops.md](loops.md) | Stateful cron jobs and the triage inbox |
| [ds4.md](ds4.md) | Local OpenAI-compatible models and DS4 KV prefix-cache behaviour |
| [project-trust.md](project-trust.md) | The trust gate on project-local `.pie/` config — new in this port |
| [web-ui.md](web-ui.md) | The local browser UI |
| [hooks.md](hooks.md) | Lifecycle hooks — **ported and tested, but not yet wired into the CLI** |

Every page here has been checked against the code in this repository rather than carried over from
the Rust project's documentation. Where the two disagree, the page says so explicitly.

## Elsewhere in the repo

- [CHANGELOG.md](../CHANGELOG.md) — what changed in this release
- [PROVENANCE.md](../PROVENANCE.md) — upstream lineage and pinned SHAs
- `migration/parity/intentional-divergences.md` — the six deliberate behaviour changes, in full
- `migration/post-parity-backlog.md` — the complete inventory of known gaps
- `migration/RULEBOOK.md` — the translation rules the rewrite was executed under

## Pages that were deliberately not ported

Rust pie's `docs/` also contains two pages that are not reproduced here:

- **`endpoints.md`** — a tombstone. Upstream it says only that the experimental public webhook relay
  was archived along with the removed cross-agent service, and that no new work should be started
  from it. There is nothing to document.
- **`web-ui-parity.md`** — an internal per-release checklist for the Rust project's own Web UI
  development, not user documentation. [web-ui.md](web-ui.md) covers the browser UI from a user's
  point of view instead.
