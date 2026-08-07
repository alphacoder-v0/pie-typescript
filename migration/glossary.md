# Glossary

Terms that recur throughout this repository, each with the single English rendering
used everywhere. Consistency matters more than elegance here: the same idea appearing
under three names costs a reader more than a slightly plain word does.

| Term | Rendering | Meaning |
|---|---|---|
| oracle | **oracle** | The upstream Rust implementation, treated as the executable specification. It is not a database and not a test double — it is the thing whose behavior this port must reproduce. Kept as-is because the repository uses it as a proper noun throughout. |
| gate | **gate** | A check wired into `npm run check` that fails the build. Distinct from a test: a gate guards a property of the repository (coverage, naming, evidence completeness), not the behavior of a function. |
| verdict | **verdict** | The decision recorded for one function: `existing-test`, `new-test`, `not-portable`, `dissolved-dependency`, or `oracle-stub`. |
| roster | **roster** | The fixed list of functions a gate checks against. Fixed is the point — a roster that grows or shrinks with the code cannot detect an omission. |
| hermetic | **hermetic** | A test run that reads and writes nothing outside its temporary directory. `bash test.sh` is the only hermetic entry point; running vitest directly is not hermetic on a machine that holds real credentials. |
| false green | **false green** | A check that passes for a reason unrelated to what it claims to verify. The recurring example: a count that returns zero because its input was empty. |
| escalate a repeated failure | **escalate a repeated failure into a rule** | After the same class of mistake happens a third time, stop correcting instances and change the rule that permitted them. |
| negative control | **negative control** | Deliberately breaking the condition a check guards, to prove the check can fail. A check never observed failing has not been shown to work. |
| divergence set | **divergence set** | The exact list of places where this implementation's output differs from the oracle's, each one declared and justified in advance. Parity passes when the observed set equals the declared set — not when it is empty. |
| behavioral evidence | **behavioral evidence** | A file and line where an assertion fails if the function is wrong. A function whose name merely exists in both codebases has no behavioral evidence. |
| spot check | **spot check** | Re-reading a sample by hand, with the sampling rule declared before any result is seen. |
| port | **port** | Rewriting upstream code in TypeScript while preserving observable behavior, including defects. |
| upstream | **upstream** | The two projects this repository derives from. See `NOTICE`. |
