# Phase 19 — Perf 底线 (startup time & resident memory)

**This is a record, not a gate.** No threshold is set or implied by this document, and the
Rust numbers below are **not** a target the TypeScript side is being scored against. There is
no fair basis for comparing a statically-linked Rust binary against a Node process, and this
file does not attempt to construct one. What it does is capture, honestly and reproducibly,
where the two sides actually sit today, so a future phase can compare *this repo against its
own past self* rather than against Rust.

Measured 2026-08-04. Oracle = Rust `pie` @ `0a120dfd` (`ORACLE_PIE_SHA`, verified matching).
TS = this repo, `npm run build` immediately before measurement.

---

## 1. Machine / build context

| | |
|---|---|
| CPU | Intel(R) Xeon(R) W-2245 @ 3.90 GHz, 16 logical cores |
| RAM | 251 GiB total, **198 GiB in use** at measurement time |
| Kernel / OS | Linux 6.8.0-117-generic x86_64, Ubuntu 24.04 |
| Filesystem | Both sides on the **same** local ext4 partition (`/dev/nvme0n1p2`). `SynologyDrive` is a locally-synced folder, not a network mount; its sync daemon was at 0.6 % CPU. No filesystem asymmetry between sides. |
| Load average | 6–13 across the session (16 cores). **The machine was never idle** — see §6. |
| Node (measured) | **v22.22.1** (`/usr/bin/node`, what the hermetic `PATH=/usr/bin:/bin` resolves to, and what `./pie` deliberately targets) |
| Node (dev shell) | v24.14.1 — *not* used for these numbers |
| **Oracle build profile** | **RELEASE — not debug.** |

### Oracle build profile — checked, stated prominently

The oracle binary measured is `$ORACLE_PIE_DIR/target/release/pie`, which is exactly what
`migration/parity/lib/common.sh`'s `side_bin oracle` resolves to. It is a **release** build:

- path is `target/release/`, built by `migration/parity/build-oracle.sh` (`cargo build --release --workspace`)
- `[profile.release]` in the oracle workspace `Cargo.toml`: `lto = "thin"`, `codegen-units = 1`
  (opt-level defaults to 3, debug-assertions off, overflow checks off)
- `rustc 1.94.1 (e408947bf 2026-03-25)`, LLVM 21.1.8, linked with LLD 21.1.8
- ELF x86-64, dynamically linked, **not stripped** (symbol table retained; no DWARF, per release default)
- binary mtime 2026-08-02 18:22, 17 473 792 bytes

A `target/debug` tree also exists in the oracle checkout; it was **not** measured. Nothing in
this table is a debug-vs-release comparison.

`cargo` is denied in this repo and the oracle checkout is read-only — no build was run against
it. The already-present release binary was used as-is, with its git HEAD verified equal to the
pinned `ORACLE_PIE_SHA`.

---

## 2. Method

- Every invocation hermetic: `env -i HOME=$(mktemp -d) PATH=/usr/bin:/bin LANG=C.UTF-8`.
  A fresh empty `HOME` per replicate; the real `$HOME` and `~/.pie/` were never read.
  Verified: after all runs the temp `HOME` still contained **0 entries** — neither side writes
  or reads config on these code paths.
- Probes: `--version` and `--help`. Both do argument parsing and print; neither touches the
  network, a session store, or the TUI. Both sides emit byte-identical `--version` output
  (`pie 0.75.0`) and identically-shaped 38-line `--help`, so the two sides are doing the same
  work at the observable level.
- Wall clock from bash `$EPOCHREALTIME` (no `fork` for the clock), measured around the whole
  `env -i … <bin>` invocation. The `env` wrapper is inside the measured region for **both**
  sides; the `/bin/true` row below quantifies that floor.
- Sides taken **interleaved** inside one loop (oracle, TS, floor, oracle, TS, floor, …) so that
  load drift contaminates both sides equally rather than one block.
- 3 warm-up iterations per target, discarded. **n = 25** recorded iterations per target for the
  headline timing table.
- **Peak RSS via `/usr/bin/time -v`**, field *"Maximum resident set size (kbytes)"*, n = 12 per
  target, taken in a separate pass so `time`'s own overhead never lands in the wall-clock table.

---

## 3. Startup time

Primary replicate, n = 25 per row, interleaved, loadavg 7.32 → 8.75. All values **milliseconds**.

| Probe | Side | median | min | max |
|---|---|---:|---:|---:|
| `--version` | oracle (Rust, release) | **7.5** | 4.0 | 11.2 |
| `--version` | TS (`./pie` → node dist/cli.js) | **860.5** | 746.8 | 973.2 |
| `--help` | oracle (Rust, release) | **10.6** | 6.4 | 16.8 |
| `--help` | TS | **866.2** | 752.0 | 1023.5 |

Reference rows measured in the same interleaved loop, same conditions:

| Reference | median | min | max | what it bounds |
|---|---:|---:|---:|---|
| `/bin/true` under `env -i` | 2.2 | 1.1 | 3.5 | fork/exec + `env` wrapper floor, charged to both sides |
| `node --version` | 6.4 | 4.2 | 11.6 | Node binary load, before the JS bootstrap |
| `node -e ''` | 34.0 | 20.5 | 73.5 | full Node bootstrap, zero application code |

Median ratio TS : oracle is **≈ 115×** on `--version` and **≈ 82×** on `--help`. The oracle's
`--help` costs ~3 ms more than its `--version` (it formats 38 lines); the TS side shows no such
difference, because on that side the printing is lost in the noise of getting to `main()` at all.

### What dominates the TS side

Subtracting the reference rows from the 860.5 ms median:

| Component | ms | share |
|---|---:|---:|
| fork/exec + `env` | 2.2 | 0.3 % |
| Node binary load | ~4 | 0.5 % |
| Node JS bootstrap (to an empty script) | ~28 | 3.2 % |
| **Application module graph** | **~826** | **96 %** |

So Node itself accounts for ~34 ms. **Roughly 96 % of TS startup is loading this application's
own module graph**, before a single line of `--version` logic executes.

Counted directly with `NODE_V8_COVERAGE` on a real `pie --version` run:

| | count |
|---|---:|
| Scripts loaded to print a version string | **1 608** |
| — `node:` builtins | 192 |
| — own `packages/*/dist` | 292 |
| — `node_modules` | 1 123, across **27** distinct npm packages |
| On-disk files opened | 1 415 |
| **JavaScript parsed at startup** | **9.65 MiB** (5.64 MiB `node_modules` + 4.01 MiB own `dist`) |

Heaviest contributors by file count: `typebox` 668, `highlight.js` 193, `undici` 108, `yaml` 72.

`packages/coding-agent/src/cli.ts` is a static-ESM entry — it imports `./config.ts`,
`./core/http-dispatcher.ts` and `./main.ts` at module scope and calls `configureHttpDispatcher()`
before `main()`. There is no lazy path, so `--version` pays for the entire application graph,
including the HTTP stack and the syntax highlighter, neither of which it uses.

**How much of that is V8 compile?** Measured directly with `NODE_COMPILE_CACHE` (env var only —
no source change), same session, interleaved, n = 15 each:

| | median | min | max |
|---|---:|---:|---:|
| TS `--version`, compile cache **warm** (1 415 entries, 3.98 MB) | 712.0 | 641.4 | 875.7 |
| TS `--version`, no compile cache | 819.1 | 750.8 | 993.1 |

V8 compilation is therefore only ~107 ms, about **13 %**. The remaining ~87 % is module
*resolution, file reads, linking and evaluation* across 1 415 files. This matters for anyone
who later tries to fix it: a compile cache alone recovers roughly one eighth of the cost.
The graph size is the cost.

---

## 4. Peak resident memory

`/usr/bin/time -v` → *"Maximum resident set size (kbytes)"*, n = 12 per row.

| Probe | Side | median | min | max |
|---|---|---:|---:|---:|
| `--version` | oracle | **5.75 MiB** (5 888 KiB) | 5 504 | 6 016 |
| `--version` | TS | **150.4 MiB** (154 032 KiB) | 148 816 | 160 848 |
| `--help` | oracle | **8.39 MiB** (8 596 KiB) | 8 392 | 8 812 |
| `--help` | TS | **152.3 MiB** (156 004 KiB) | 147 428 | 160 948 |

Reference:

| Reference | peak RSS |
|---|---:|
| `/bin/true` | 1.88 MiB (1 920 KiB) |
| `node --version` | 18.6 MiB (19 072 KiB) |
| `node -e ''` | 41.9 MiB (42 860 KiB) |

Median ratio TS : oracle is **≈ 26×** on `--version`, **≈ 18×** on `--help`. Node's own floor is
41.9 MiB; the application graph adds ~108 MiB on top of it. RSS was the most stable quantity
measured — spread under ±5 % — and, unlike wall time, is essentially insensitive to the
machine's background load.

---

## 5. Footprint — what each side actually carries

| | oracle (Rust) | TS |
|---|---|---|
| Shipped executable | one ELF, **16.66 MiB** (17 473 792 B), dynamically linked, not stripped | `./pie`, a **486-byte** `/bin/sh` shim that `exec node …/dist/cli.js` |
| Compiled output tree | (inside the binary) | `packages/*/dist` = **20.57 MiB**, 336 `.js` files across 5 packages |
| Dependency tree on disk | (inside the binary) | `node_modules` = **264.2 MiB**, 319 installed packages |
| Declared direct prod deps | — | 19 (+1 optional) in `@pie/coding-agent` |
| **Touched at startup** | mmaps 1 file | opens **1 415 files**, parses **9.65 MiB** of JS |

`dist` sizes include `.d.ts` and source maps, which are shipped but not loaded at runtime; the
9.65 MiB "parsed at startup" figure is the load-bearing one.

---

## 6. Honest reading — what these numbers do and do not tell you

**Stated plainly: the TypeScript side is dramatically slower to start.** ~860 ms versus ~8 ms is
roughly **115× the oracle's startup**, and ~150 MiB versus ~6 MiB is roughly **26× its resident
memory**. That is not a rounding difference and it is not noise — the gap is two orders of
magnitude, far outside the ±5 % measurement spread. It should not be softened.

**What dominates it is known and specific**, not vague "Node is slow": 96 % of the wall time is
loading a 1 608-script module graph — 1 415 files, 9.65 MiB of JavaScript — to print a version
string. Only ~13 % of even that is V8 compilation; the rest is resolving, reading, linking and
evaluating the graph. The `--version` path pays for `undici`, `highlight.js` and `typebox`
because `cli.ts` imports the whole application statically. Node's own bootstrap (34 ms, 42 MiB)
is a small minority of both totals.

**What these numbers do not tell you, and this file makes no claim about:**

- Nothing about **steady-state behaviour**. `--version`/`--help` exercise argument parsing and
  process start, full stop. They say nothing about token streaming throughput, tool-call
  latency, TUI render cost, session load/save, or memory under a long conversation — the
  regimes where this program actually spends its life.
- Nothing about whether ~860 ms is **acceptable for the product**. That depends on how often a
  user pays it and against what baseline, and **that has not been measured here**. No claim of
  acceptability is made, and none should be read in. The honest statement is: the cost is
  large, its cause is identified, and its product impact is unquantified.
- Nothing about **a fix**. The compile-cache result bounds one candidate remedy at ~13 %;
  anything larger would have to attack the graph itself (lazy imports on the CLI entry path).
  That is out of scope for a phase-19 record.
- Nothing about **Rust as a target**. Nobody should read the oracle column as a goal. A
  single-binary AOT-compiled program starting faster than a 1 415-module interpreted one is the
  expected outcome of the architectural choice already made, not a defect discovered here.

---

## 7. Caveats — why this is a record and not a benchmark

1. **Different languages, different startup models.** AOT-compiled statically-analysed Rust
   with one mmap'd binary versus a JIT runtime resolving and evaluating 1 415 ESM modules at
   every process start. These are not comparable implementations of the same strategy; the
   ratio is a property of the architecture, not of code quality on either side.
2. **Oracle build profile.** Release (`lto="thin"`, `codegen-units=1`, rustc 1.94.1) — checked,
   and stated in §1. It is not a debug build. But it is also not the same *kind* of artifact as
   `node dist/cli.js`: there is no "release mode" applied to the TS side (no bundling, no
   minification, no `bun build --compile`, which `package.json` offers as `build:binary` but
   which was **not** used here). A bundled or single-file TS build would produce different, and
   probably much better, numbers. **The TS side is measured in its unbundled development-shaped
   output form.**
3. **Single machine, single session.** One Xeon W-2245, one kernel, one Node build (v22.22.1).
   Nothing here generalises to other hardware, other Node versions, or containers. Node v24
   (the dev shell version) was not measured and would likely differ.
4. **No warm-cache control, and no cold measurement at all.** The host has no passwordless
   sudo, so `/proc/sys/vm/drop_caches` is unwritable, and `vmtouch` is not installed. A genuine
   cold-page-cache measurement was therefore **not achievable**, and none is reported. Every
   number above is warm-page-cache, after 3 discarded warm-ups. The requested "cold vs warm"
   comparison is replaced by the `NODE_COMPILE_CACHE` experiment (§3), which is the closest
   available proxy and shows the first-run penalty is ~13 %, not the dominant term.
5. **The machine was never quiet.** A competing `vitest` process ran at ~1 full core for the
   whole session; loadavg was 7–13 on 16 cores and 198/251 GiB of RAM was in use. Interleaving
   the sides inside one loop shares that contamination evenly, and the `min` columns are the
   least-contended estimates, but no run happened on an idle box.
6. **`env -i` overhead is inside both timings**, quantified by the `/bin/true` floor at 2.2 ms
   median. It is ~29 % of the oracle's 7.5 ms and ~0.3 % of the TS side's 860 ms — i.e. it
   inflates the oracle's number proportionally far more than the TS one, which if anything
   makes the reported ratio *conservative* (the true ratio is larger).
7. **Two probes only.** `--version` and `--help` were chosen precisely because they do no I/O
   beyond argument parsing, which makes them clean and repeatable — and also makes them
   unrepresentative of anything the program does in anger.

---

## 8. Measurement trust log

One measurement was found untrustworthy and handled:

- **Replicate 1, TS `--version`: median 1 327.9 ms (min 865.4, max 1 670.8).** The loadavg rose
  from 6.09 to 13.39 *during* that block; the distribution was visibly bimodal, and it
  contradicted TS `--help` in the same replicate (863.8 ms) even though `--help` provably does
  strictly more work. Physically impossible ordering ⇒ contamination, not signal.
  **Action:** discarded as the headline value, re-run as replicate 2 under a stable loadavg
  (7.32 → 8.75). Replicate 2 gives 860.5 ms for `--version` and 866.2 ms for `--help` — the two
  now agree, which is the expected result since both load the identical module graph. An
  independent replicate 3 gave 819.1 ms. Cross-replicate spread ≈ ±5 %, so the headline is good
  to about ±50 ms — which does not change any conclusion at a 100× gap.
- Everything else is reported as measured. Replicate 1's RSS figures were retained (RSS is
  load-insensitive and its spread was under ±5 %).

**Raw samples** (one value per line; `.ms` = wall-clock milliseconds, `.rss` = peak RSS in KiB)
were written to the session scratchpad, not to this repo:
`…/scratchpad/p19perf/raw{,2,3}/`. Nothing under `packages/`, `migration/` (other than this
file) or the oracle checkout was modified; no `git add` or `git commit` was performed.
