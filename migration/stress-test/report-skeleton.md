# Stress-test report (phase 5) — the skeleton (renamed to report.md once filled in)

## How the topology ran
- implementer A (the openai-responses diff-port plus the retry port): <to fill in>
- implementer B (the cron port): <to fill in>
- reviewer A1 (against the Rust source) and A2 (against the RULEBOOK): <to fill in>
- reviewer B1 and B2: <to fill in>
- third-party adjudication (the orchestrator): <to fill in>
- fixer: <to fill in>

## Compliance rule by rule (RULEBOOK section against each of the two units)
| rule | unit A | unit B | note |
|---|---|---|---|
| §0 minimal overlay for diff-port, full translation for port | | | |
| §1 the dependency allowlist (smol-toml only) | | | |
| §2.1 type mapping | | | |
| §2.2 concurrency mapping (detach, AsyncQueue, the Mutex criterion, select) | | | |
| §2.4 guard semantics (invariant against a typed error) | | | |
| §4 the `// pie:` divergence markers | | | |
| §5 the BUG(port) markers (B1, B3, B6, B7) | | | |
| §3 TODO(port) discipline | | | |

## S3, S4 and S5 parity at the probe level (black-box binary parity is deferred to phase 13 and later; this is harness-probe alignment)
- S3, the usage numbers: upstream {input:100, output:10, cacheRead:80, cacheWrite:0, totalTokens:190, cost:0} against TypeScript: <to fill in>
- S4, the request sequence: upstream [n1,n2] plus the final text against TypeScript: <to fill in>
- S5, the second request's input sequence: upstream [system,user,reasoning,assistant,user] against TypeScript: <to fill in>

## Defects found in the RULEBOOK, and the amendments
<to fill in — a self-assessment that finds nothing counts as a failure; there has to be a substantive
finding, or a sufficient argument for why there is none>

## Conclusion
<to fill in>
