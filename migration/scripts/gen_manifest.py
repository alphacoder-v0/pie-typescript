#!/usr/bin/env python3
"""gen_manifest.py — deterministic 3-way capability manifest for the pie→TS migration.

Classification policy (conservative, per THINKING.md risk #2):
- TS counterpart found (auto name-match or curated override) -> diff-port
  (NEVER auto-'reuse': an empty divergence set is discovered inside the phase, not assumed)
- no counterpart -> port
- explicit curated entries may set: reuse (verified trivial), excluded (with reason)
- Rust test files -> char-tests units bound to their crate's phase slice
Regenerable: preserves existing status column by unit_id on rerun.
"""
import os, re, sys, csv

ORACLE = os.path.expandvars(os.path.expanduser(os.environ["ORACLE_PIE_DIR"]))
REPO = os.getcwd()
OUT = "migration/manifest.tsv"

CRATE_PKG = {"mcp": "mcp", "ai": "ai", "agent": "agent", "coding-agent": "coding-agent"}
CRATE_PHASE = {"mcp": 6, "ai": 7, "agent": 8, "coding-agent": None}  # coding-agent per-module

def kebab(s): return s.replace("_", "-")

# ---- collect TS files per package (relative to packages/<p>/src) ----
ts_files = {}
for p in ["mcp", "ai", "agent", "coding-agent", "tui"]:
    base = os.path.join(REPO, "packages", p, "src")
    fl = []
    if os.path.isdir(base):
        for root, dirs, files in os.walk(base):
            dirs[:] = [d for d in dirs if d != "node_modules"]
            for f in files:
                if f.endswith(".ts"):
                    fl.append(os.path.relpath(os.path.join(root, f), base))
    ts_files[p] = sorted(fl)

def find_ts(pkg, rel_rs):
    """auto name-match: same relative dir preferred, else unique basename match"""
    d, b = os.path.split(rel_rs[:-3])  # strip .rs
    if b == "lib": cand_names = ["index.ts"]
    elif b == "mod": cand_names = [os.path.join("index.ts")]; d2 = d; d, b = os.path.split(d) if d else ("", ""); # mod.rs -> dir/index.ts
    else: cand_names = [kebab(b) + ".ts", kebab(b).replace("-generated", ".generated") + ".ts"]
    if b == "" and 'd2' in dir(): pass
    results = []
    for t in ts_files.get(pkg, []):
        td, tb = os.path.split(t)
        if tb in cand_names:
            results.append((0 if td == kebab(d) else 1, t))
    if not results: return None
    results.sort()
    same_dir = [t for pr, t in results if pr == 0]
    if same_dir: return same_dir[0]
    if len(results) == 1: return results[0][1]
    return None  # ambiguous -> require override or port

# mod.rs special: crates/X/src/a/b/mod.rs -> packages/X/src/a/b/index.ts
def find_mod_ts(pkg, rel_rs):
    d = os.path.dirname(rel_rs)
    cand = os.path.join(kebab(d), "index.ts") if d else "index.ts"
    return cand if cand in ts_files.get(pkg, []) else None

# ---- curated overrides: (crate, rel_rs) -> dict ----
OV = {}
def ov(crate, rel, **kw): OV[(crate, rel)] = kw
# agent crate semantic maps
ov("agent", "harness/env/native.rs", base="agent:harness/env/nodejs.ts")
# pie-only agent capabilities (audit-confirmed): explicit port
for r in ["harness/cost.rs","harness/notification_hook.rs","harness/permission.rs",
          "harness/trigger.rs","harness/trigger_runtime.rs"]:
    ov("agent", r, cls="port", why="pie-only harness capability (audit: TriggerRuntime/cost/permission/notification built into pie harness)")
# ai pie-only
# adjudicated 2026-08-03 (dual adversarial review of sample, third-ruling; see migration/reviews/manifest/):
ov("ai","vertex_provider.rs", base="ai:providers/google-vertex.ts",
   why="CONFIRMED by dual review: pie split pi google-vertex.ts; same env-var resolution (GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT/GOOGLE_CLOUD_LOCATION)")
ov("ai","bedrock_anthropic.rs", base="ai:providers/amazon-bedrock.ts",
   why="capability lives inside pi SDK-consuming bedrock provider; RULEBOOK §1 decides SDK-adopt vs hand-rolled port")
ov("ai","sigv4.rs", base="ai:bedrock-provider.ts",
   why="pi gets SigV4 from AWS SDK; RULEBOOK §1 decides SDK-adopt vs hand-rolled port")
ov("ai","vertex_adc.rs", cls="port", why="pie-only ADC service-account JWT exchange (closes pie#14 gap; pi baseline resolves token from env only)")
for r in ["event_stream.rs","utils/aws_eventstream.rs","utils/sse.rs"]:
    ov("ai", r, cls="port", why="header self-declares no 1:1 TS counterpart (TS side uses AWS SDK / eventsource-parser); RULEBOOK §1 decides adopt-vs-port")
ov("ai","utils/retry.rs", cls="port", why="no TS counterpart (SDKs retry for free); DIVERGENCE SITE: pie adds HTTP 409 to retry set (audit-confirmed DS4 adaptation)")
ov("ai","utils/abort.rs", cls="port", why="shared abort helpers; TS has native AbortSignal — likely thin port")
ov("ai","image_models_generated.rs", base="ai:image-models.generated.ts")
ov("ai","models_generated.rs", base="ai:models.generated.ts")
# coding-agent semantic maps (flat rust -> structured pi)
CA = "coding-agent"
m = {
 "agent_session.rs":"coding-agent:core/agent-session.ts",
 "auth.rs":"coding-agent:core/auth-storage.ts",
 "commands.rs":"coding-agent:core/slash-commands.ts",
 "config.rs":"coding-agent:config.ts",
 "main.rs":"coding-agent:main.ts",
 "markdown.rs":"tui:components/markdown.ts",
 "clipboard_image.rs":"coding-agent:utils/clipboard-image.ts",
 "images.rs":"coding-agent:utils/image-convert.ts",
 "templates.rs":"coding-agent:core/prompt-templates.ts",
 "skills.rs":"coding-agent:core/skills.ts",
 "resume_picker.rs":"coding-agent:cli/session-picker.ts",
 "export.rs":"coding-agent:core/export-html",
 "session/mod.rs":"coding-agent:core/session-manager.ts",
 "tui.rs":"coding-agent:modes/interactive/interactive-mode.ts",
 "spinner.rs":"tui:components/loader.ts",
}
for r, b in m.items(): ov(CA, r, base=b)
# pie-only coding-agent capabilities: explicit port with audit rationale
pie_only_ca = {
 "goal.rs":"'/goal' evaluator — pie product feature",
 "inbox.rs":"global inbox — pie loops/inbox closed loop",
 "triggers/cron.rs":"session cron (30s tick) — pie automation core",
 "triggers/dynamic.rs":"dynamic LLM-checked rules — pie automation core",
 "triggers/mcp_notification_hook.rs":"MCP push into trigger chain — pie automation core",
 "triggers/mod.rs":"trigger module glue",
 "tools/task.rs":"Task subagent tool v1 — pie built-in (pi keeps it an example)",
 "tools/memory.rs":"memory tool (~/.pie/memory) — pie feature",
 "tools/git.rs":"git tool — pie built-in tool surface",
 "tools/mcp_adapter.rs":"MCP tool adapter — pie built-in MCP",
 "tools/web_fetch.rs":"web_fetch tool — pie built-in",
 "tools/web_search.rs":"web_search tool — pie built-in",
 "tools/skill.rs":"skill tool","tools/install_skill.rs":"skill mgmt tool",
 "tools/remove_skill.rs":"skill mgmt tool","tools/set_skill_state.rs":"skill state tool",
 "tools/skill_builder.rs":"skill builder tool",
 "mcp_loader.rs":"user/project MCP config loader + spawn — pie built-in MCP",
 "lsp.rs":"LSP integration — pie feature","lsp_supervisor.rs":"LSP supervisor — pie feature",
 "hooks.rs":"hooks with opt-in gate — pie feature",
 "skills_state.rs":"skills enable/disable state — pie feature",
 "builtin_skills.rs":"bundled builtin skills — pie feature",
 "local_models.rs":"local model (DS4/ollama-style) detection — pie feature",
 "model_picker.rs":"interactive model picker TUI+WebUI (#223) — pie feature",
 "control_plane_prompt.rs":"control-plane prompt — pie trigger/automation prompt layer",
 "session_archive.rs":"session archive — pie feature",
 "extensions.rs":"unwired extension registry — port as-is (audit: dead code allowed)",
 "otlp.rs":"OTLP exporter — pie telemetry",
 "bug_report.rs":"bug report cmd — pie feature",
 "debug.rs":"debug utilities","logging.rs":"logging setup",
 "oauth.rs":"login flow orchestration (rejects inline key) — pie behavior",
 "history.rs":"persistent prompt history store (~/.pie/history, cap 1000, /history cmd); WIRES INTO tui editor in-memory history (review B note)","readline.rs":"line editor fallback",
 "mentions.rs":"@-mention resolution","model.rs":"model registry glue",
 "ui/mod.rs":"WebUI module glue — pie WebUI","ui/feed.rs":"WebUI feed — pie WebUI",
 "ui/kernel.rs":"WebUI kernel — pie WebUI","ui/listener.rs":"WebUI listener — pie WebUI",
 "ui/relay.rs":"WebUI relay — pie WebUI","ui/web.rs":"WebUI http server — pie WebUI",
}
for r, w in pie_only_ca.items(): ov(CA, r, cls="port", why=w)

rows = []
def add(unit, src, base, out, cls, phase, why):
    rows.append(dict(unit_id=unit, src_path=src, base_path=base or "-", out_path=out,
                     classification=cls, phase=phase, status="pending", rationale=why))

for crate, pkg in CRATE_PKG.items():
    srcdir = os.path.join(ORACLE, "crates", crate, "src")
    for root, dirs, files in os.walk(srcdir):
        dirs[:] = [d for d in dirs if d != "target"]
        for f in sorted(files):
            if not f.endswith(".rs"): continue
            rel = os.path.relpath(os.path.join(root, f), srcdir)
            src = f"crates/{crate}/src/{rel}"
            key = (crate, rel)
            o = OV.get(key, {})
            base = o.get("base")
            cls = o.get("cls")
            why = o.get("why", "")
            if base and ":" in base:
                bp, br = base.split(":"); base = f"packages/{bp}/src/{br}"
            if not cls:
                if base:
                    cls = "diff-port"; why = why or "curated semantic map to pi counterpart"
                else:
                    stem = rel[:-3]
                    hit = find_mod_ts(pkg, rel) if os.path.basename(rel)=="mod.rs" else find_ts(pkg, rel)
                    if rel == "lib.rs": hit = "index.ts" if "index.ts" in ts_files.get(pkg, []) else None
                    if hit:
                        base = f"packages/{pkg}/src/{hit}"; cls = "diff-port"
                        why = "auto name-match to pi counterpart (divergence set determined in-phase)"
                    else:
                        cls = "port"; why = why or "no pi counterpart found (name+curated search)"
            # phase assignment
            if crate != "coding-agent":
                ph = CRATE_PHASE[crate]
            else:
                if rel.startswith("tools/"): ph = 9
                elif rel.startswith("triggers/") or rel in ("inbox.rs",): ph = 10
                elif rel in ("goal.rs","skills.rs","skills_state.rs","builtin_skills.rs","hooks.rs"): ph = 11
                elif rel in ("session/mod.rs","session_archive.rs","config.rs","auth.rs","oauth.rs","mcp_loader.rs","lsp.rs","lsp_supervisor.rs","export.rs","history.rs"): ph = 12
                elif rel in ("tui.rs","readline.rs","spinner.rs","markdown.rs"): ph = 14
                elif rel.startswith("ui/"): ph = 15
                else: ph = 13
            # out_path: diff-port -> base (in-place edit target); port -> mirrored kebab path in pkg
            if cls == "diff-port" and base and base.endswith(".ts"):
                out = base
            else:
                stem = rel[:-3]
                d, b = os.path.split(stem)
                if b == "mod": d2 = kebab(d); out = f"packages/{pkg}/src/{d2}/index.ts" if d2 else f"packages/{pkg}/src/index.ts"
                elif b == "lib": out = f"packages/{pkg}/src/index.ts"
                elif b == "main": out = f"packages/{pkg}/src/main.ts"
                else: out = f"packages/{pkg}/src/{kebab(d)+'/' if d else ''}{kebab(b)}.ts"
            unit = f"{crate}/{rel[:-3]}"
            add(unit, src, base, out, cls, ph, why)
    # test files -> char-tests units
    for sub in ["tests"]:
        tdir = os.path.join(ORACLE, "crates", crate, sub)
        if os.path.isdir(tdir):
            for root, dirs, files in os.walk(tdir):
                for f in sorted(files):
                    if not f.endswith(".rs"): continue
                    rel = os.path.relpath(os.path.join(root, f), tdir)
                    if rel == "zz_audit_repro.rs" and crate == "coding-agent":
                        continue  # untracked audit probe, explicit excluded row below
                    ph = CRATE_PHASE[crate] or 13
                    add(f"{crate}/tests/{rel[:-3]}", f"crates/{crate}/{sub}/{rel}", "-",
                        f"packages/{pkg}/test/ported/{kebab(rel[:-3])}.test.ts",
                        "char-tests", ph, "Rust integration tests -> vitest characterization tests")
    edir = os.path.join(ORACLE, "crates", crate, "examples")
    if os.path.isdir(edir):
        for f in sorted(os.listdir(edir)):
            if not f.endswith(".rs"): continue
            add(f"{crate}/examples/{f[:-3]}", f"crates/{crate}/examples/{f}", "-", "-",
                "excluded", 0, "example/debug scaffolding; not product behavior (recorded exclusion)")
# workers reuse row
add("workers/fefe-hub", "workers/fefe-hub", "-", "workers/fefe-hub", "reuse", 15,
    "upstream directory is already TypeScript; copied verbatim at phase 1 (build+17 tests green)")
# zz_audit_repro.rs is an untracked audit artifact in the oracle checkout, not pie source: excluded
add("coding-agent/tests-untracked/zz_audit_repro", "crates/coding-agent/tests/zz_audit_repro.rs", "-", "-",
    "excluded", 0, "untracked local audit probe in oracle checkout (not part of pie@0a120dfd)")

# preserve status on regen
old = {}
if os.path.exists(OUT):
    with open(OUT) as f:
        for r in csv.DictReader(f, delimiter="\t"): old[r["unit_id"]] = r["status"]
for r in rows:
    if r["unit_id"] in old: r["status"] = old[r["unit_id"]]

with open(OUT, "w", newline="") as f:
    w = csv.DictWriter(f, lineterminator="\n", fieldnames=["unit_id","src_path","base_path","out_path","classification","phase","status","rationale"], delimiter="\t")
    w.writeheader()
    for r in sorted(rows, key=lambda r: (r["phase"] if isinstance(r["phase"],int) else 99, r["unit_id"])): w.writerow(r)
print(f"manifest rows: {len(rows)}")
import collections
ct = collections.Counter((r["src_path"].split("/")[1] if r["src_path"].startswith("crates") else "other", r["classification"]) for r in rows)
for k in sorted(ct): print(k, ct[k])
