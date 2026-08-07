# Translation Rulebook — Python (toml 0.10.2) → TypeScript

META-RULE: if two agents could answer a question differently, the answer goes
in this file. Read this whole document before writing any code. Read-only in
loops: amendments are queued, never self-applied.

## 0. Scope and posture
- Structure-preserving. One .py file -> one .ts file, same function/class
  boundaries, same control flow. You are translating, not improving.
- CHEAP-REFEREE VARIANT: tsc runs INSIDE the loop (strict mode). A draft that
  does not typecheck is not done. (This replaces "don't run the compiler" —
  documented Step 4 dissolution for cheap typecheckers.)
- First pass optimizes for behavioral fidelity, not performance. Mark known
  slow translations PERF(port): and move on.

## 1. Ecosystem
- ZERO runtime dependencies, matching the source. Node stdlib only.
- Target: ES2022 modules, strict tsconfig (committed at repo root).
- `any` is BANNED. Use `unknown` + narrowing. Each exception needs
  TODO(port): justification on the same line.

## 2. Constructs with no equivalent — canonical mappings
| Python | TypeScript |
|---|---|
| dict | Record<string, TomlValue> via plain object (JS preserves insertion order — this also makes ordered.py's OrderedDict variant a no-op shim; port it anyway, 1:1, with a comment) |
| None (data) | null — never undefined in data structures |
| optional parameter =None | param?: T in signatures |
| str/unicode | string |
| int / float (both) | number. TOML ints beyond Number.MAX_SAFE_INTEGER: TODO(port) marker, translate as number |
| datetime/date/time + TomlTz | TomlDateTime/TomlDate/TomlTime classes in tz.ts storing components + raw offset string; toISOString() for output. Do NOT use JS Date as the data model (mutability + ms precision loss) |
| TomlDecodeError(msg, doc, pos) | class TomlDecodeError extends Error {doc: string; pos: number; lineno: number; colno: number} — same fields, same construction sites |
| isinstance(x, T) chains | typeof / instanceof narrowing in the same order |
| io file objects in load() | load() accepts string path or array of paths only; file-like objects: TODO(port) marker + throw TypeError (parity scenarios do not exercise them) |

## 3. Escape hatch
- Markers: TODO(port): deferred decision · PERF(port): known slow · both greppable, exact format.
- Every translated file ends: // PORT STATUS: confidence=<high|medium|low> todos=<N>

## 4. Naming and output paths
- toml/<name>.py -> src/<name>.ts ; toml/__init__.py -> src/index.ts
- ALL function, class, method, and parameter names preserved EXACTLY from
  source (including snake_case). Parity debugging beats TS style. No renames.

## 5. Gap inventory
- Nullability and union-type contracts are looked up, not decided:
  migration/inventory.tsv. Site missing = inventory bug: flag, apply most
  conservative type, TODO(port), keep moving.

## AMENDMENT LOG (applied at gates by the human/orchestrator, never in-loop)
- A1 (post-inventory): S2 gains a row — InlineTableDict sentinel (decoder.py:631,
  dynamic multiple inheritance at :644, TS-inexpressible) -> Symbol brand:
  `const INLINE_TABLE = Symbol('toml.inline_table')` set on the plain object;
  `isInlineTable()` checks the brand. Chosen over a class because the value
  must satisfy both isTable() and the dict->plain-object mapping. Source:
  inventory UNKNOWN row encoder.py:227, confirmed by skeptic review.

- A2 (post-stress-test, 10 amendments from diff-report.md):
  1. S0: source defects are reproduced bug-for-bug, marked BUG(port): <repro> (3rd
     greppable marker). Parity asserts the defective output; fixes are post-parity.
  2. S2: any index access whose Python counterpart can raise IndexError must
     replicate the throw (bounds check) or carry a marker. Silent undefined is a defect.
  3. S2 float formatting: non-finite -> nan/inf/-inf exactly (no TODO allowed);
     exponent-form divergences (1e-05 vs 0.00001) accepted-with-marker, parity-normalized.
  4. S2 int/float dispatch: Number.isInteger (NOT isSafeInteger); integral floats
     lose ".0" — accepted, parity-normalized.
  5. S2: type-keyed dispatch dicts -> Map keyed by _py_type tags ('str','bool','int',
     'float','list') + constructor refs for classes; _py_type is a shared helper in tz.ts.
  6. isTable() positive definition: Object.getPrototypeOf(v) === Object.prototype || null
     — home module: decoder.ts, exported.
  7. None->null extension: null reaching dump_value renders "null" (Python "None") —
     accepted, parity-normalized; null inside inline tables is emitted, never skipped.
  8. S2 exceptions: encoder-side ValueError/TypeError -> Error/TypeError with
     byte-identical messages; messages are part of the parity surface.
  9. S2 no-analog types: Decimal -> drop (number path covers); numpy/pathlib encoder
     subclasses -> preserved as no-op shims with original names.
  10. _repr (%r emulation): shared helper in tz.ts with the diff-report control-char
      vectors as its fixture set; fan-out files import it, never re-derive it.
DEVIATION LOG: bakeoff re-round on fresh files folded into Step 3 first-unit
adherence review (budget scaling, dogfood only). Pilot likewise (see selection.md).
