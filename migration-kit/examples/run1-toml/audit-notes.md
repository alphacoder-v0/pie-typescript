# Inventory audit notes (skeptic round 1)
20/20 rows CONFIRMED, 0 refuted. Corrections applied to evidence quality, not types:
- 3 decoder rows: off-by-one citations (35->36, 148->149 x2; one recursive load call mislabeled as loads forward)
- encoder.py:197 row: "misbehaves identically" claim FALSE (Python raises TypeError at :188, JS for...in silently no-ops) -> divergence must carry TODO(port) in translation
- encoder.py:260 row: t must be declared Array<string|number|(string|number)[]> or the dead branch narrows to never under strict tsc
- encoder.py:203: recursive dump_sections call passes raw list elements -> cast + TODO(port) at that site
- encoder.py:302 row cited a nonexistent rulebook row; substantive claim (rulebook silent) true
