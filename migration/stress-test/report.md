# Stress-test report (phase 5) — the kit's Step 2, redesign variant

Date: 2026-08-03. The two hardest units went through the full production topology — implementer, two
adversarial reviewers, a third-party adjudication, then a fixer — producing code plus changes to the
rules.

## How the topology ran

| role | unit A (the openai-responses diff-port plus the retry port) | unit B (the cron port) |
|---|---|---|
| implementer | finished, then stalled 600s at the gate of running the whole vitest suite bare and was killed (the artifacts were on disk, and the orchestrator re-verified all three gates hermetically, all green) | finished in one pass, 25 tests |
| reviewer 1 (against the Rust) | 5 findings, 1 of them HIGH: grouping when replaying several blocks | the first assignment stalled and was killed, then reassigned with the long-command ban added; 5 findings, 2 HIGH: RFC3339 fractional digits, and an unwrapped error |
| reviewer 2 (against the RULEBOOK) | 6 findings, 2 HIGH: the B3 ledger entry mismatched and its widening unrecorded; plus one real contradiction in the RULEBOOK | 4 findings, 2 HIGH: synchronous fs beyond what was authorised, and a missing typebox schema |
| adjudication | all filed (see migration/reviews/pilot-a/findings.md) | the same (pilot-b/findings.md; B2-F4 was upgraded after being checked against upstream) |
| fixer | round 1: 8 of 8; round 2, after the probe dug deeper: the request-body shape family plus a real bug, where the signature branch overrode compat | 9 of 9 |

## Compliance by RULEBOOK section, for both units, in their final state after the fixer

| rule | unit A | unit B |
|---|---|---|
| §0 minimal overlay for diff-port, full translation for port | pass, after round 2 | pass |
| §1 the dependency allowlist | pass, nothing added | pass, only smol-toml, pinned exactly |
| §2.1 type mapping | pass | violated in round 1 with a hand-written guard, then pass once moved to typebox |
| §2.2 concurrency mapping | pass | pass, with the synchronous criterion argued through and the rule confirmed afterwards |
| §2.4 guard semantics | pass | partly violated in round 1 with a silent catch, then pass after warnCron |
| §4 the `// pie:` markers | violated in round 1 with the B3 mismatch, then pass | pass |
| §5 the BUG markers (B1, B3a, B6, B7) | pass | pass |
| §3 TODO(port) discipline | violated in round 1, where the promise was in the report and not in the source, then pass | pass |

## Parity at the probe level (black-box binary parity was deferred to phase 13 and later)

- S3 usage: the TypeScript side equals upstream exactly — {input:100, output:10, cacheRead:80,
  cacheWrite:0, totalTokens:190, cost all zero}, reproducing the B1 and B3a defect values literally
- S4: exactly two requests (409 then retry), with finalText equal
- S5: the sequence [system, user, reasoning, assistant, user] is equal, and the **full request body
  compares deeply as PROBE-PARITY: GREEN** — key sets, order and types all equal, masking only the two
  input differences of model and system text; the comparator was self-verified by reverse mutation,
  4 of 4 detected
- Two divergences were kept deliberately and recorded in explained-divergences.tsv (ED1, the
  function_call id, and ED2, tool-result images), to be reviewed in phase 17

## RULEBOOK amendments (all applied in this phase, with entries in the Deviation log)

1. §1: the contradiction over where retry lands was decided in favour of the ai package, by dependency
   direction, and the wording was corrected ("the whole utility is a pie addition")
2. §2.3: the faithful-synchrony authorisation, with the mechanical criterion of parking_lot::Mutex
   together with std::fs
3. §5: B3a was added, the ledger entry for cost=0 at the ai provider layer
4. §4: the mandatory probe gate for wire-construct units, from the lesson of a shape-family difference
   that passed the implementer and both reviewers
5. Process: reviewers may not run commands taking more than 5s, and implementers and fixers run whole
   test suites hermetically, after two stalling incidents

## Conclusion

The pipeline works: the double-blind review and the probe gate caught 20 findings between them —
including 4 HIGH behavioral differences, 1 real bug and 1 contradiction in the RULEBOOK — and all were
closed. The fan-out of phases 6 through 15 follows this report's topology and the revised rules.
