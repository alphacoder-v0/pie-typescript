# Phase 16 smoke report

Produced by `migration/smoke/run-smoke.sh`. Every item runs side by side with upstream.

How this divides with parity: parity does the byte-for-byte behavioral diff, while this report asks
**whether it runs at all** — start up, take a turn, write to disk, exit cleanly, and **leave no process behind**. Parity does not check that last one at all.

| # | side | result | note |
|---|---|---|---|
| 1 --help | oracle | PASS | exit 0 |
| 1 --help | oracle | PASS | the catalog count line is present: providers (32), models (938) |
| 2 the TUI in an empty environment | oracle | PASS | exit code 0 (0 or 124 are both acceptable) |
| 2 the TUI in an empty environment | oracle | PASS | no process left behind (0 before, 0 after) |
| 3 one turn against the fixture | oracle | PASS | the fixture received 1 request, so the model really was called |
| 3 one turn against the fixture | oracle | PASS | the session reached disk (3 lines) |
| 4 --tui forces the terminal | oracle | PASS | --tui did not start the web UI |
| 1 --help | ts | PASS | exit 0 |
| 1 --help | ts | PASS | the catalog count line is present: providers (32), models (938) |
| 2 the TUI in an empty environment | ts | PASS | exit code 0 (0 or 124 are both acceptable) |
| 2 the TUI in an empty environment | ts | PASS | no process left behind (0 before, 0 after) |
| 3 one turn against the fixture | ts | PASS | the fixture received 1 request, so the model really was called |
| 3 one turn against the fixture | ts | PASS | the session reached disk (5 lines) |
| 4 --tui forces the terminal | ts | PASS | --tui did not start the web UI |

**Total: PASS 14 / FAIL 0**

## Notes

- The exit code 124 in item 2 is `timeout` ending it, which is the normal result for a TUI waiting on input;
  what is actually asserted is **whether it left a child process behind once it was ended**.
- Item 3 uses `migration/parity/lib/sse-fixture-server.mjs`, which reaches no real network and uses no real credential
  (`OPENAI_API_KEY=dummy-fixture-key` is a literal).
- The session is written into the temporary HOME `mkhome` creates (prefixed `parityhome.*`, removed by `cleanup_home` after a strict check),
  and **the real `~/.pie` is never touched**.
- This report does no byte-for-byte comparison; that is `migration/parity/run-parity.sh`'s job.
