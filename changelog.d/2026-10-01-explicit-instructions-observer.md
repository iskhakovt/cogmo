The Observer applies explicit instruction rules (Explicit instructions step 4).

- **Correction extraction** lists the user's instruction rules as set by the user and treats what a successful `rule_set` / `rule_remove` call recorded as handled; a new correction is dropped when a live instruction rule visible to the conversation covers its scope (global or the conversation's profile; every channel or the correction's). Reinforcing an instruction rule never promotes it. A contradicted learning rule is retired and counted in `corrections.retired`; a contradicted live rule is only logged, and one outside the active channels counts in `corrections.outOfScopeContradictionsSkipped`.
- **Memory extraction** skips recorded instructions and lists the `memory`-category rules visible to the staging profile. The prompt defines `memory` as what the assistant remembers, tracks or must not store.
- **The drain** asks the classifier whether a rule forbids each live or skill row; a withheld row is deleted without a retain, logged with its id and the rules that applied, and counted in `drained.withheld`.
- **Third-party profiles** never see the user's rules or other profiles' facts. Their extraction model gets no user rules, and where a user's `memory` rule binds the fire, memory extraction is skipped (`memories.skippedForUnseenRules`). Their drain classifies only rows their own profile staged; every other row, migration rows included, waits for a first-party fire (`drained.deferredToFirstParty`). The drain batch filters before its limit, so deferred rows never hold up the queue.
- `/reflect`, `/learned` and the web UI show retired, withheld, skipped and deferred counts.

The rule tools themselves come in step 3. See design/evolution.md → Explicit Instructions.
