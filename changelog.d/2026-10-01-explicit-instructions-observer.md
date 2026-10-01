The Observer applies explicit instruction rules (Explicit instructions step 4).

- **Correction extraction** lists the user's instruction rules as set by the user and treats what a successful `rule_set` / `rule_remove` call recorded as handled; a new correction matching a live instruction rule in the same scope is dropped. Reinforcing an instruction rule never promotes it. A contradicted learning rule is retired and counted in `corrections.retired`; a contradicted live rule is only logged, and one outside the active channels counts in `outOfScopeContradictionsSkipped`.
- **Memory extraction** skips recorded instructions and lists the `memory`-category rules visible to the staging profile. The prompt defines `memory` as what the assistant remembers, tracks or must not store.
- **The drain** asks the classifier whether a rule forbids each live or skill row; a withheld row is deleted without a retain, logged with its id and the rules that applied, and counted in `drained.withheld`.
- **Third-party profiles** never see the user's rules, so their extraction model gets none. Where a user's `memory` rule binds what such a fire would store, it stores nothing: memory extraction is skipped (`memories.skippedForUnseenRules`) and bound pending rows wait for a fire on a profile that sees the rule (`drained.deferredForUnseenRules`).
- `/reflect`, `/learned` and the web UI show retired, withheld and deferred counts.

The rule tools themselves come in step 3. See design/evolution.md → Explicit Instructions.
