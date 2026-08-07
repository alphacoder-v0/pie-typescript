# Stress-test file selection (criteria, not taste)
encoder.py (304 lines), score rationale:
- exercises amendment A1 (InlineTableDict sentinel, encoder.py:227) — newest, least-tested rule
- exercises 10/20 inventory rows incl. both UNKNOWN-class decisions
- contains 2 dead branches (87 py2 guard, 260 unreachable list) — tests the
  port-dead-code-1:1 posture
- dispatch table dump_funcs (135-141) — tests dict->object + function-map mapping
Rejected: decoder.py (1057 lines, too large for a diff the inspector can hold),
tz.py/ordered.py/__init__.py (too trivial to indict any rule).
Pilot run: FOLDED into Step 3's first unit for this scaled-down dogfood —
reviewers carry the adherence question there. Logged as a deviation.
