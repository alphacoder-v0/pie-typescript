# Capability map — pie(Rust @0a120dfd) ↔ pi(TS @4868222e)

How it is generated: `migration/scripts/gen_manifest.py`, deterministically, by normalising names for
automatic matching plus a curated override table drawn from the audit.
The classification policy is conservative (see risk 2 in THINKING.md): **anything with a TypeScript
counterpart is a diff-port**, with an empty divergence set discovered inside the phase rather than
reuse assumed up front; anything without one is a port; and reuse is limited to units already verified
as trivial, meaning workers.

## crate × classification

| crate | diff-port | port | char-tests | excluded | reuse |
|---|---|---|---|---|---|
| mcp | 0 | 7 | 2 | 0 | 0 |
| ai | 55 | 9 | 2 | 3 | 0 |
| agent | 25 | 10 | 6 | 1 | 0 |
| coding-agent | 23 | 44 | 16 | 1 | 0 |
| workers | 0 | 0 | 0 | 0 | 1 |
| **total** | 103 | 70 | 26 | 5 | 1 |

## Assignment to phases

| phase | units |
|---|---|
| 0 | 5 |
| 6 | 9 |
| 7 | 66 |
| 8 | 41 |
| 9 | 20 |
| 10 | 5 |
| 11 | 5 |
| 12 | 10 |
| 13 | 33 |
| 14 | 4 |
| 15 | 7 |

## The pie-only capabilities that matter (all of them ports; see the manifest for each rationale)

- the agent crate: TriggerRuntime, the trigger execution chain, cost and budget, permission, and
  notification_hook
- coding-agent: triggers/(cron, dynamic, mcp_notification_hook), inbox, goal, the tools/ family
  (task, memory, git, mcp_adapter, web_fetch, web_search and the skill tools), mcp_loader, lsp and its
  supervisor, hooks, skills_state, builtin_skills, local_models, model_picker, control_plane_prompt,
  session_archive, extensions (unwired, ported as-is), otlp, and the web UI under ui/
- ai crate：bedrock_anthropic、sigv4、vertex_adc/vertex_provider、utils/(abort,aws_eventstream,retry,sse)

## How cycles in the dependency map are handled

All 41 nodes inside cycles are mutual references within a crate, through Rust `crate::` paths. The
approach: land them in the skeleton's existing single-package structure on the TypeScript side, and
resolve circular imports with a type-only import or by merging into one file — the skeleton is already
organised that way, so a diff-port unit inherits it, and a port unit maps according to RULEBOOK §2.
Dependencies between packages are acyclic: mcp and ai are leaves, agent depends on ai, and
coding-agent depends on all of them.

## Recorded exclusions

- four examples (agent/debug_jsonl, ai/anthropic_hello, ai/count_models, ai/gpt55_hello): debugging
  scaffolding rather than product behavior
- coding-agent/tests/zz_audit_repro.rs: an untracked audit probe in the upstream checkout, not part of
  pie@0a120dfd

## Sampled review (phase 2)

Ten units went through a double-blind adversarial review: one confirmed error (vertex_provider), after
which every port row of the ai crate was reworked; and two disagreements adjudicated as not confirmed,
with notes recorded. Details in `migration/reviews/manifest/sample-review-2026-08-03.md`.
