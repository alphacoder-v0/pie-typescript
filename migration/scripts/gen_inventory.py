#!/usr/bin/env python3
"""gen_inventory.py — per-site gap inventory (kit Step 1, prompt 02).
Sites where Rust let you keep semantics in your head that TS demands a decision on.
guard column semantics (defined per RULEBOOK §2.4):
  allocation-guard  = panic!/unwrap/expect site — abort the operation (throw invariant)
  precondition-guard = Result/Option error path — record error, return oracle's partial result
  n/a               = non-error site (concurrency / numeric / serde / io)
Columns: site  construct  rulebook_ref  guard  note
"""
import os, re, sys
ORACLE = os.path.expandvars(os.path.expanduser(os.environ["ORACLE_PIE_DIR"]))
PATTERNS = [
    (r'tokio::spawn\b', 'tokio::spawn', '§2.2 detach()', 'n/a'),
    (r'spawn_blocking', 'spawn_blocking', '§2.2 plain-async', 'n/a'),
    (r'\bmpsc::', 'mpsc channel', '§2.2 AsyncQueue', 'n/a'),
    (r'\boneshot::', 'oneshot', '§2.2 withResolvers', 'n/a'),
    (r'\bselect!\s*[({]', 'select!', '§2.2 selectN+abort', 'n/a'),
    (r'\bbroadcast::', 'broadcast', '§2.2 event-bus', 'n/a'),
    (r'\bNotify\b', 'Notify', '§2.2 Signal', 'n/a'),
    (r'Mutex<', 'Mutex', '§2.2 await-in-critical-section test', 'n/a'),
    (r'\bu128\b', 'u128', '§2.1 bigint/site-specific', 'n/a'),
    (r'panic!\(', 'panic!', '§2.4 invariant()', 'allocation-guard'),
    (r'\.unwrap\(\)', 'unwrap', '§2.4 invariant()', 'allocation-guard'),
    (r'\.expect\(', 'expect', '§2.4 invariant()', 'allocation-guard'),
    (r'#\[serde\(untagged\)\]', 'serde untagged', '§2.1 ordered-union-parse', 'n/a'),
    (r'tag\s*=\s*"', 'serde tagged enum', '§2.1 discriminated-union', 'n/a'),
    (r'anyhow!|\.context\(|with_context', 'anyhow context', '§2.4 Error{cause}', 'precondition-guard'),
    (r'block_on', 'block_on', '§2.2 async-to-root', 'n/a'),
]
rows = []
for crate in ["mcp", "ai", "agent", "coding-agent"]:
    src = os.path.join(ORACLE, "crates", crate, "src")
    for root, dirs, files in os.walk(src):
        for f in sorted(files):
            if not f.endswith(".rs"): continue
            p = os.path.join(root, f)
            rel = os.path.relpath(p, ORACLE)
            for i, line in enumerate(open(p, encoding="utf-8", errors="replace"), 1):
                for pat, name, ref, guard in PATTERNS:
                    if re.search(pat, line):
                        note = line.strip()[:90].replace("\t", " ")
                        rows.append((f"{rel}:{i}", name, ref, guard, note))
with open("migration/inventory.tsv", "w") as f:
    f.write("# guard semantics: allocation-guard=panic/unwrap/expect (abort op, throw invariant); precondition-guard=Result/anyhow error path (record+partial result); n/a=non-error site\n")
    f.write("site\tconstruct\trulebook_ref\tguard\tnote\n")
    for r in rows: f.write("\t".join(r) + "\n")
import collections
c = collections.Counter(r[1] for r in rows)
print(f"inventory rows: {len(rows)}")
for k, v in c.most_common(): print(f"  {k}: {v}")
