# Copyright 2026 Anthropic PBC
# SPDX-License-Identifier: Apache-2.0
import sys, json, os
sys.path.insert(0, os.environ.get('TOML_SRC', '/tmp/dogfood/toml-src'))
import toml, datetime
def norm(v):
    import math
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)): return "nan" if math.isnan(v) else ("inf" if v>0 else "-inf")
    if isinstance(v, (datetime.datetime, datetime.date, datetime.time)): return v.isoformat()
    if isinstance(v, list): return [norm(x) for x in v]
    if isinstance(v, dict): return {k: norm(v[k]) for k in sorted(v)}
    return v
src = sys.stdin.read()
try:
    parsed = toml.loads(src)
    rt = toml.loads(toml.dumps(parsed))
    print(json.dumps({"parsed": norm(parsed), "roundtrip": norm(rt)}, ensure_ascii=False, separators=(",", ":")))
except Exception as e:
    print(json.dumps({"error": type(e).__name__ + ": " + str(e)}, separators=(",", ":")))
