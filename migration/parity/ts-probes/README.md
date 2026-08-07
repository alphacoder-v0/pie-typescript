# ts-probes

Harness-level probes on the TypeScript side, written in vitest, corresponding one for one with
oracle-probes and enabled during the slice phases 7, 8, 10 and 12:
the black-box scenarios S1 through S8 are driven by run-parity.sh against `./pie` directly — the
TypeScript launcher at the repository root, produced in phase 13 — and need nothing from this
directory.
This directory is for the finer assertions a black-box run cannot reach, such as field-level checks
on the usage struct, or TriggerRuntime's ordering contract.
Until the TypeScript side is ready, `run-parity.sh --ts` reports "TS side not ready" and exits 2
rather than reporting a false green.
