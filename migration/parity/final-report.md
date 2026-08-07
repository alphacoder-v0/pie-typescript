# pie, Rust to TypeScript — the done-gate report (phase 17)

> The kit's Step 6 defines the done-gate as **the judge fully green plus a dual count with inherited
> recorded**. This file is the only legitimate evidence that the migration is complete.

## 1. The dual count

### (a) The referee count — the parity judge is fully green

```
bash migration/parity/run-parity.sh
[BOTH] ALL SCENARIOS: DIFF 0
PARITY: GREEN
```

**All 8 scenarios are byte-identical on both sides**: S1 help and version · S2 the TUI in an empty
environment · S3 the usage fixture · S4 retry on 409 · S5 DS4 reasoning replay · S6 the session JSONL ·
S7 the cron surface · S8 the bad tail line.

Phase 17 started from **10 differing files across 6 scenarios**, burned down to 0, and not one of them
was reached by changing the judge — `migration/parity/lib/normalize.mjs` and `scenarios/*.sh` were
untouched throughout this phase.

### (b) The upstream re-run count

```
bash migration/parity/test-oracle.sh          # new, reusing the SHA drift guard from build-oracle.sh
oracle @ 0a120dfd380fb7f009e09f2b7981b76c07b3fd95
cargo test --workspace  exit=0
test binaries=34  passed=1398  failed=0  ignored=0
```

### (c) The TypeScript count

```
npm test    exit=0
agent-core 432 + ai 427 + coding-agent 2479 + tui 612 + mcp 38 + fefe-hub 17
= 4005 passed / 0 failed / 776 skipped
```

## 2. The classification buckets (the acceptance criterion is that regression must be 0)

| bucket | count | note |
|---|---|---|
| **regression** | **0** | none |
| inherited | **0** | **structurally required to be 0**: the upstream re-run reports `failed=0 ignored=0`, so there is no failing case upstream to inherit. Without running that baseline, `inherited` becomes a convenient dustbin |
| environment | 776 skipped | 710 are live-API cases that skip themselves in hermetic mode when no provider key is present (`test.sh` unsets every provider key and sets `PI_NO_LOCAL_LLM=1`); 66 are known gaps recorded one by one (`migration/reviews/agent/gap-inventory.md`, `phase13/`, `phase14/`) |

## 3. Test reconciliation

See the final version of `migration/parity/test-ledger.tsv`. The main points:

- **rs_count totals 766**, matching the acceptance threshold: every `#[test]` and `#[tokio::test]`
  across the upstream crates (ai 92 + agent 171 + coding-agent 491 + mcp 12).
- **The two counts measure different things and must not be mixed**: 766 is the number of test
  functions in the source, while cargo's 1398 is the number of test instances executed, including
  parameterised expansions and integration test binaries counted more than once. This report records
  both.
- ts_count 4005 exceeds rs_count 766 because the TypeScript side also contains the ported upstream
  integration tests, the skeleton's existing tests, and the regression tests produced by the review
  rounds of each phase.

## 4. Explained divergences

`migration/parity/explained-divergences.tsv` holds **ED1 through ED25**, each with its site, the
difference, the reason and when to revisit. All of them are either not observable by the judge or
architectural differences already argued through; there is no unexplained difference on the judging
surface.

## 5. The BUG(port) ledger

RULEBOOK §5 holds **B1 through B17**, each site marked `BUG(port): B<n>` with a characterization test
**asserting the defective behavior**. Phase 18 flips each assertion in its own commit and re-runs
parity.

## 6. The phase 17 burndown, 10 to 0

| scenario | starting point | root cause |
|---|---|---|
| S3 requests | DIFF 1 | **Two layers**: the CLI defaulted thinking to the skeleton's `medium` where upstream's clap default is `off`; and with thinking off, this port still sent `reasoning:{effort:"none"}`, while upstream's `body["reasoning"]` exists only inside an `if let Some(effort)` branch with **no else** |
| S3 run | DIFF 15 | The provider required a `response.content_part.added` before it would accept a text delta and **discarded it silently** otherwise; upstream keeps no such mirror and always emits `TextDelta` |
| S3 session | DIFF 6 | Five differences in the session JSONL entry format, **all decided in favour of upstream**: the header shape, the extra model_change and thinking_level_change entries, the shape of the entry id, the user content array, and textSignature |
| S4 final | DIFF 1 | The same streaming defect as S3 run |
| S5 replay | DIFF 1 | `loadAll` in `local-models.ts` had **no caller**, so the DS4 provider was never registered |
| S5 req2body | DIFF 1 | **The system prompt and all 25 tool schemas were the skeleton's** — `render_base_prompt` and `build_system_prompt` had never been ported — plus the skeleton-only `strict:false` and `prompt_cache_key` |
| S6 session | DIFF 8 | Went to zero with the S3 session format alignment |
| S7 files | DIFF 3 | The session filename was `<ts>_<uuid>.jsonl` where upstream has `<uuid>.jsonl`; `auth.json` was created eagerly; and persisting the transcript was deferred to the first assistant message, so a session that ran only slash commands left an **orphan sidecar** |
| S8 list | DIFF 3 | The `--list-sessions`, `--list-all-sessions` and `--delete-session` flags were **parsed but never consumed** |
| S8 resumeerr | DIFF 1 | The same filename root cause as S7 |

**The heaviest of them**: S5 req2body exposed that the system prompt and tool contract the model
actually received **were the skeleton's throughout**. For an agent that is behavior itself — given the
same user input, the model on each side receives different instructions and differently shaped tool
arguments. And the `coding-agent/main` row was marked `done` in the manifest: the fifth accuracy
problem in the queue, where the first four were **wrong mappings** and this one was **marked done with
a whole block inside the unit never ported**.

## 7. The done-gate declaration

- [x] `bash migration/parity/run-parity.sh` exits 0 across every scenario, with **zero unexplained
      diffs**
- [x] `npm test` fully green; **4005 ≥ 766**, the rs_count threshold
- [x] upstream `cargo test --workspace` exits 0, with the count recorded (34 binaries, 1398 passed)
- [x] **the regression bucket is 0**; inherited is structurally 0; all 776 in environment are
      accounted for
- [x] the dual count is declared, in section 1 of this file

**Conclusion: the kit's Step 6 done-gate is met.** What remains is phase 18, flipping the defect
assertions of B1 through B17, and phase 19, polish and hardening. Neither affects this gate — phase 18
is where **deliberate** divergence from upstream begins, and parity will need re-explaining item by
item for whatever is flipped.
