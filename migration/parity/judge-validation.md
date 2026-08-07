# Judge self-validation record (kit 00b: validated against the original AND deliberately broken code)

Date: 2026-08-03 · judge version: the first from phase 4 (black-box scenarios S1 through S8, plus
normalize, diff and the SSE fixture server)

## The scenarios

| scenario | what drives it | judging artifacts |
|---|---|---|
| S1 --help, --version and the catalog counts | the CLI directly | help.norm / version.norm |
| S2 an empty environment in the TUI (the no-key warning and stderr) | the TUI fed through a pipe on stdin | tui.norm / tuierr.norm |
| S3 usage and cost accounting against the fixture | the TUI plus the SSE fixture plus the session file | session.norm / run.norm (/cost) / requests.norm |
| S4 retry on HTTP 409 | the fixture in http409-once mode plus the request log | reqseq.norm (both requests, n=1 and n=2) / final.norm |
| S5 DS4 reasoning replay | DS4_BASE_URL registered plus the reasoning fixture | replay.norm (the second request carries type:"reasoning") / req2body.norm |
| S6 the session JSONL structure | a scripted session over two turns | session.norm / dirs.norm |
| S7 the cron, trigger and inbox surface | /cron add --stateful, then /cron, then /inbox | run.norm / files.norm / cron.norm (the sidecar toml) |
| S8 resuming a session with a bad tail line (B8) | build a healthy session, cut it short, then resume and list | resumeerr.norm / list.norm |

## Self-validation, part one: upstream against itself (determinism and sufficient normalisation)

First round: **failed**, with 8 artifacts showing a non-zero diff. Five gaps in normalisation were
fixed: minute-precision timestamps, epoch milliseconds inside JSON numbers, the 32-hex cron id, the
short uuidv7 prefix in log names and session lists, and trailing whitespace. The normalize unit tests
grew to 7 cases at the same time, including the NaN, Infinity and key-order referee traps the source
material warns about explicitly.

Second round: **ALL SCENARIOS: DIFF 0** ✓

## Self-validation, part two: deliberate breakage, 3 of 3 detected

These are behavioral mutations, so each has to travel the whole chain from driver through normalize to
diff.

| mutation | how it was injected | result |
|---|---|---|
| M1, usage | the fixture's cached count changed from 80 to 0, changing server behavior | DETECTED ✓ |
| M2, the catalog | openrouter filtered out of the --help output | DETECTED ✓ |
| M3, the corruption switch | S8 skips cutting the file short, flipping resume behavior | DETECTED ✓ |

## Guarding against a false green while the TypeScript side is not ready

`run-parity.sh --ts` reports "TS side not ready (no executable at <repo>/pie)" and exits 2 — non-zero,
not green. ✓

## Evidence of upstream defects already captured (samples of the bug-for-bug baseline)

- S3 session: `totalTokens:190` (100+10+80, the double count of the B1 and B2 family) with `cost` all
  zero (B3)
- S8: `Error: invalid entry: EOF while parsing a string at line 1 column 528` on a failed resume, while
  --list-sessions still works (B8)
- S4: the second request arrives after the 409, so the retry exists — a pie feature rather than a
  defect
- S5: the second request's input sequence carries a `{"type":"reasoning"}` replay item, the DS4
  adaptation

## Boundaries

The surfaces the judge does not cover are in `unverified.md`.

## Re-validated 2026-08-05, after normalize.mjs began collapsing the `invalid entry:` detail in phase 12

The reason for the change is in ED15: the detail in a JSON parser's error is an artifact of the
runtime — serde_json against V8 — and the two can never agree verbatim. Normalisation collapses only
what follows `invalid entry: `, keeping that prefix and the `Error: ` before it.

**When it was changed**: the TypeScript launcher (`<repo>/pie`, a phase 13 deliverable) did not yet
exist and the two sides had never been diffed, so this adjustment to the judge cannot have been made
to turn a known red green.

| check | result |
|---|---|
| upstream against itself, S1 through S8 | ALL SCENARIOS: DIFF 0 ✓ |
| M1, usage | DETECTED ✓ |
| M2, the catalog | DETECTED ✓ |
| M3, the corruption switch (S8, the same scenario this change touches) | DETECTED ✓ |
| lib/normalize.test.mjs | 8/8 pass, including the new discriminating cases: a wrong prefix, a missing `Error: `, no error at all, and an empty detail all still go red |

`SELF-CHECK PASSED`

## Re-validated 2026-08-04, after phase 18 raised the granularity, switched the differ to LCS, and made S8 really capture the exit code

Three changes, all of which **raise** sensitivity; none loosens anything:

| change | motive |
|---|---|
| `normalize.mjs` expands a JSON line across several | the intentional divergence declared in phase 18 sits inside a 22KB single-line request body; under a line-by-line diff that line reddens permanently, and any regression among the 25 tool schemas on it becomes indistinguishable from the declared item. Expanded, each field takes its own line |
| `diff.mjs` moves from aligning by index to aligning by LCS | once lines are expanded, one structural insertion shifts every line after it under index alignment, inflating one real difference into hundreds of lines of noise. The meaning of `DIFF: 0` is unchanged |
| the exit code in `s8-bad-tail.sh` | `resume_exit=$?` came after `|| true`, so it read the exit code of `true` — **always 0** — and `resume.exitcode` was not a `.norm` file and never took part in the diff. That assertion had no ability to fail |

The evidence:

| item | result |
|---|---|
| `bash run-parity.sh --self-check`, step 1 of 2 (upstream against itself) | `[SELF] ALL SCENARIOS: DIFF 0` — the expansion is deterministic and normalisation is still sufficient |
| step 2 of 2 (three injected mutations) | `MUTATIONS DETECTED: 3/3` · `SELF-CHECK PASSED` |
| `node --test lib/normalize.test.mjs` | 10/10 pass, including the new cases: after expansion each tool's description occupies its own line, and a non-JSON line is unaffected |
| `node --test lib/diff.test.mjs` | **a new file**, 5/5 pass. `diff.mjs` had no tests at all before this — the judge had been judging both sides with nobody judging it. One case pins the motive directly: changing tool A's description does not mask a regression in tool B (`DIFF: 2` against `DIFF: 4`) |
| the immediate return on fixing the S8 exit code | the first real capture reported `resume_exit=1` upstream against `0` here — a real behavioral divergence that had been entirely invisible |
