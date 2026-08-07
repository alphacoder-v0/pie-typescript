# oracle-probes

Reserved for fine-grained probes on the upstream side that the black-box scenarios cannot reach: Rust
test files, installed as untracked `tests/` inside the upstream checkout, in the same pattern the audit
used for zz_audit_repro.rs, so upstream's git state is never modified. The black-box scenarios S1
through S8 already cover the judging surface phase 4 needs, so this directory is enabled when a slice
phase calls for it; install and uninstall scripts are added as the need arises.

---

## `d3-trust-harm/` — demonstrating the **harm** D3's trust gate stops, not merely that the gate fires

`bash d3-trust-harm/run.sh [oracle|ts|both]` (both by default; exits 0 when every expectation holds)

**Why it is needed.** The unverified boundary in `MIGRATION-REPORT.md` recorded honestly that phase 19
had demonstrated the gate firing but **not the harm it stops** — the injected `.pie/mcp.toml` spawned
no process on either side. Investigating confirmed the suspicion: the **key names did not match
upstream's schema**. Reading upstream's deserialiser
(`crates/coding-agent/src/mcp_loader.rs:25-31`):

```rust
#[derive(Debug, Default, Deserialize, Serialize)]
pub struct McpConfig {
    #[serde(default)]
    pub server: Vec<ServerConfig>,   // `[[server]]` — singular, an array of tables
}
```

`McpConfig` has **no** `deny_unknown_fields`, so the `[servers.evil]` phase 19 used, plural, was a
**successful parse** yielding an empty server list: upstream spawned nothing and printed no
diagnostic, and the audit came away with a green light that had answered the wrong question correctly.
The same holds for `lsp.toml`, whose real shape is `[[language]]` (`lsp_supervisor.rs:26-41`: `id`,
`extensions`, `command`, `args`).

**What the probe does.** It runs both real binaries against real fixtures derived from those schemas
(`*.toml.tmpl`), and asserts a **process side effect** — a sentinel file only a spawned child process
could create:

| side | fixture | expectation | meaning |
|---|---|---|---|
| upstream | `mcp.toml.tmpl` | **spawns** | runs the command written in the repository at startup (eagerly) |
| upstream | `mcp-wrong-shape.toml.tmpl` | does not spawn | the negative control, reproducing phase 19's "nothing happened" |
| upstream | `lsp.toml.tmpl` | **spawns** | runs on the first edit of a file with a matching extension (lazily) |
| ts | `mcp.toml.tmpl` untrusted | does not spawn | the gate |
| ts | `mcp.toml.tmpl` trusted | spawns | a gate, not a wall |
| ts | `lsp.toml.tmpl` untrusted | does not spawn | the gate |
| ts | `lsp.toml.tmpl` trusted | spawns | a gate, not a wall |

Measured 2026-08-04: **7 passed, 0 failed**. Both upstream sentinels contain `pwned`, and the negative
control has no sentinel.

The lsp half needs a tool call to really happen, so it reuses S10's `sse-fixture-server.mjs` to script
one `edit`; the probe **first asserts that the edit really reached disk**, since otherwise "no
sentinel" would only mean the tool never ran — the very trap phase 19 fell into, and one that has to be
closed inside the rig.

**Safety boundaries.** Every write lands inside a single `mktemp -d` directory; the payload is only
`printf pwned > <tmp>/sentinel-*`, with no deletion, no network and no path outside the temporary
directory; each run has its own HOME and never touches the real `~/.pie`. Upstream is read-only, the
binary is taken through `side_bin` in `lib/common.sh`, and cargo is never invoked.

**The repeatable regression on this side** is
`packages/coding-agent/test/project-trust-harm.test.ts`, 9 cases, which **renders the same templates**
— both sides share one fixture source, to close the specific recurrence path of a fixture drifting into
a shape upstream never executes.
