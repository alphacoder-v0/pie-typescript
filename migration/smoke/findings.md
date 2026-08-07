# Phase 16 smoke findings

> `report.md` is emptied and rewritten by `run-smoke.sh` on every run and carries results only. This
> file records **attribution and disposition**, and survives across runs.

## F1 (blocking, phase 16 criterion 2) — with no credential the TypeScript side does not start the TUI, while upstream does

**Measured side by side** (`migration/smoke/out/{oracle,ts}-tui.out`):

| | upstream | TypeScript |
|---|---|---|
| `--tui` with no credential | **the TUI starts normally**: banner, model line (`Claude Haiku 4.5 (latest)`, the credential-less default), session id, the list of 24 tools, and the shortcut hints, with the no-key warning shown as a **feed line inside the running TUI**. exit **0** | prints the warning, then `No API key found for anthropic.` with the /login guidance, and **exits 1**. The TUI never starts |

**A consequence**: the same root cause left the single-turn fixture item with zero requests on the
TypeScript side — the process exited before making any model call at all, where upstream's fixture
received one request.

**The root cause** (located in batch A of phase 13, judged then as "needs the ai side" and carried
forward):
- upstream's `stream_fn_with_auth_store` at `main.rs:1225-1258` does
  `if let Some(api_key) = resolve_api_key(&model.provider.0).filter(|k| !k.trim().is_empty())` — with
  no key it simply **does not set one and continues**, letting the provider produce the error when a
  request is really made.
- `packages/coding-agent/src/core/model-registry.ts:704` returns
  `{ ok: false, error: 'No API key found for "..."' }`, which `core/auth-guidance.ts:24` turns into a
  fatal message that ends startup **before the provider ever runs**.

**Why this one matters**: it turns an acceptance criterion that both phase 13 and phase 14 had marked
PARTIAL — "the TUI starts in an empty environment, says there is no model, and reports no key when a
prompt is sent" — into something **reproducible with upstream running beside it**. Twice before, the
only thing that could be said was "the text comes from the ai side and is out of reach"; what is
demonstrated now is a **product-level symptom**: with no credential this port cannot get in at all,
and upstream can.

**Disposition**: make the credential-less startup path non-fatal — start the TUI and defer the no-key
failure to the moment a turn is really made. **Not** by removing the error message, but by moving it
from "fatal before startup" to "surfaced when the turn fails", matching upstream's layering.

**What not to do along the way**: do not delete the guidance text in `auth-guidance.ts` to make this
item green — upstream shows an equivalent warning in the feed too, it just does not block startup.

## F1 disposition — **fixed**

Found and fixed independently by the `main.ts` switching unit in phase 16, which ran alongside this
record. Its diagnosis goes **one layer deeper** than this file's original attribution: this is not one
gap but **three stacked**, and without any one of them upstream's line would not appear:

1. `core/agent-session.ts:1144` had a skeleton pre-check, `hasConfiguredAuth`, that threw **before any
   stream started**. Upstream has **no pre-check at all** — `main.rs:1225-1258` finds no key, leaves
   `api_key = None`, and calls `stream_simple` anyway.
2. The provider **threw synchronously** rather than sending the error **into the stream**. Upstream's
   `run()` uses `push_error(...)`, letting the failure travel along the stream and become
   `AgentRunError::Other` at `agent_loop.rs:317-319`.
3. Headless mode wrote **every diagnostic to stdout**. All seven of upstream's error branches are
   `eprintln!` to stderr, and only the feed printer and three status lines use `println!`.

**What the orchestrator got wrong earlier**: the first version of this file attributed it to "the text
comes from the ai side and is out of reach" — which saw only the symptom beneath layer 1, compressed a
three-layer problem into one, and so was reasonably deferred twice, in phases 13 and 14.

## F2 (fixed) — `--base-url` was parsed and never applied

Item 3 of the smoke run had zero requests on the TypeScript side, and tracing it showed the prompt had
gone to **the real OpenAI API** — the error receipt came from `platform.openai.com` — while the local
fixture named by `--base-url` was never used at all.

Upstream consumes it at `main.rs:568-573`, where the override is applied, and at `main.rs:1164-1185`,
`validate_base_url_override`. **The second is a safety guard**, and its own error message says why:
without an explicit `--provider`, automatic model detection picks a provider from the environment and
then points its credential at the overridden endpoint. Both are now reproduced as upstream has them,
with the text matching verbatim.

**Why only the smoke run found it**: `--base-url` sat on phase 13's T5-b list of "parsed but not
consumed", and that list was honest — but only actually running a turn with it shows the prompt going
somewhere it should not.

## F3 (fixed) — an uncancellable sleep pinned the process

The `sleep()` in `CronNotificationHook` and `DynamicTriggerCheckHook`: `stop()` only set a flag while
the pending `setTimeout` remained, so after the REPL returned the process was pinned for 30s or 600s
and **never exited**. Upstream's hooks die with the tokio runtime and do not have this problem. Both
`sleep` sites gained `.unref?.()`, and the REPL teardown gained the missing `runtime.dispose()`.

## Observations (not defects)

- **`--help` agrees exactly on both sides**: exit 0, with the catalog count line reading
  `providers (32), models (938)` — corroborating parity S1's byte-for-byte conclusion.
- **No process left behind**: after `timeout` ended `--tui`, neither side left a child process (0
  before, 0 after). **Parity does not check this at all.**
- **The session line counts differ** (3 upstream, 5 here): **not treated as a smoke defect, and not
  adjudicated by the smoke run.** Retested after the F1 fix, the difference remains. But the smoke run
  only asserts that a session was written and never compares its content; and this script cleans up
  the temporary HOME (`cleanup_home` removes it after a strict check), so the two files cannot be
  retrieved afterwards for comparison. **Diffing the session content item by item is parity S6's job**
  (`scenarios/s6-session-jsonl.sh`, a structured JSONL diff), and belongs to the phase 17 burndown. The
  line-count difference may well be a legitimate difference in entry granularity — upstream's first
  line is a header and the rest are messages — and a count alone cannot decide a defect.
- **`--tui` does not start the web UI**: the same on both sides.
