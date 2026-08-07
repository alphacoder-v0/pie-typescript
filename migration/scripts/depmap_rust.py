#!/usr/bin/env python3
"""depmap_rust.py — deterministic module-level dependency map for pie's Rust crates.

Adapted from migration-kit scripts/depmap_* per prompt 01 (source-ecosystem adaptation).
Emits: edges.tsv (src<TAB>dst), order.txt (leaves-to-root topological), cycles.txt.
Granularity: one node per .rs file under crates/*/src (tests/ and examples/ excluded).
Edges: `use <crate>::path` and `mod name;` declarations resolved to file nodes.
Deterministic: pure text parse, sorted output, no agent judgment.
"""
import os, re, sys, collections

ORACLE = os.path.expandvars(os.path.expanduser(sys.argv[1]))
OUT = sys.argv[2]
CRATES = {"agent": "pie_agent", "ai": "pie_ai", "coding-agent": "pie_coding_agent", "mcp": "pie_mcp"}
# crate name aliases used in `use` statements (Cargo package names)
ALIAS = {}
for c in CRATES:
    cargo = os.path.join(ORACLE, "crates", c, "Cargo.toml")
    name = None
    for line in open(cargo, encoding="utf-8"):
        m = re.match(r'name\s*=\s*"([^"]+)"', line)
        if m: name = m.group(1); break
    ALIAS[name.replace("-", "_")] = c

nodes = {}  # module path key -> file relpath
for c in CRATES:
    src = os.path.join(ORACLE, "crates", c, "src")
    for root, dirs, files in os.walk(src):
        dirs[:] = [d for d in dirs if d != "target"]
        for f in files:
            if not f.endswith(".rs"): continue
            rel = os.path.relpath(os.path.join(root, f), ORACLE)
            modrel = os.path.relpath(os.path.join(root, f), src)[:-3]  # strip .rs
            parts = modrel.split(os.sep)
            if parts[-1] in ("mod", "lib", "main"): parts = parts[:-1]
            key = c + "::" + "::".join(parts) if parts else c
            nodes[key] = rel

edges = set()
use_re = re.compile(r'^\s*(?:pub\s+)?use\s+([A-Za-z0-9_:]+)')
mod_re = re.compile(r'^\s*(?:pub\s+)?mod\s+([A-Za-z0-9_]+)\s*;')
crate_path_re = re.compile(r'\bcrate::([A-Za-z0-9_]+(?:::[A-Za-z0-9_]+)*)')

def resolve(crate, path_parts):
    """resolve a module path to the deepest matching node key"""
    for i in range(len(path_parts), 0, -1):
        key = crate + "::" + "::".join(path_parts[:i])
        if key in nodes: return key
    return crate if crate in nodes else None

for key, rel in sorted(nodes.items()):
    crate = key.split("::")[0]
    text = open(os.path.join(ORACLE, rel), encoding="utf-8", errors="replace").read()
    deps = set()
    for m in crate_path_re.finditer(text):
        t = resolve(crate, m.group(1).split("::"))
        if t and t != key: deps.add(t)
    for line in text.splitlines():
        um = use_re.match(line)
        if um:
            segs = um.group(1).split("::")
            head = segs[0]
            if head in ALIAS:  # cross-crate use
                t = resolve(ALIAS[head], segs[1:]) or ALIAS[head]
                if t and t in nodes and t != key: deps.add(t)
    for d in sorted(deps): edges.add((key, d))

os.makedirs(OUT, exist_ok=True)
with open(f"{OUT}/edges.tsv", "w") as f:
    f.write("src\tdst\n")
    for a, b in sorted(edges): f.write(f"{a}\t{b}\n")

# topo order (leaves first = fewest deps first, Kahn on dep graph)
dep_of = collections.defaultdict(set); rdep = collections.defaultdict(set)
for a, b in edges: dep_of[a].add(b); rdep[b].add(a)
indeg = {n: len(dep_of[n]) for n in nodes}
queue = sorted([n for n in nodes if indeg[n] == 0])
order, seen = [], set()
while queue:
    n = queue.pop(0); order.append(n); seen.add(n)
    for r in sorted(rdep[n]):
        indeg[r] -= 1
        if indeg[r] == 0: queue.append(r)
    queue.sort()
cyc = sorted(set(nodes) - seen)
with open(f"{OUT}/order.txt", "w") as f:
    for n in order: f.write(n + "\t" + nodes[n] + "\n")
with open(f"{OUT}/cycles.txt", "w") as f:
    if cyc:
        f.write("# nodes in dependency cycles (leaves-to-root order not derivable):\n")
        for n in cyc: f.write(n + "\t" + nodes[n] + "\n")
print(f"nodes={len(nodes)} edges={len(edges)} ordered={len(order)} in-cycles={len(cyc)}")
