`observer.integration.test.ts` and `migrate-untagged-memories.integration.test.ts` each own a private `users` row instead of sharing the seeded `defaultUserId`, via a new `createIsolatedUser` helper in `src/test/`.

Both files write `pending_memories` for their user, and both scope assertions and cleanups by `user_id` — observer with `DELETE FROM pending_memories WHERE user_id = $1` and `SELECT count(*) ... WHERE user_id = $1`, migrate with staged rows it then counts. The integration tier runs files in parallel forks against one Postgres, so sharing a user pointed those clauses at each other's rows: observer's cleanup could drop what migrate staged (`expected 2, received 0`), and migrate's rows could inflate observer's count (`expected '1', received '3'`). Neither is deterministic; both files pass alone and as a pair, and the race needs the timing skew of the full tier.

Distinct users make the interference impossible rather than unlikely, which is the property worth having when the failure is a race — a green run proves little on its own. They are the only two files that touch `pending_memories`.

The row is a real insert because these tables carry an FK to `users.id`. The helper documents the hazard so the next integration test reaches for it rather than the seeded user, which is what `.claude/rules/testing.md` describes under "Postgres rows that other tests query".
