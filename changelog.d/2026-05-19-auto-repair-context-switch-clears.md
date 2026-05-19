Auto-repair clear triggers wired on `/model` and `/profile`. Per the
design's "context switch ends cooldown" rationale, the model update
and the cooldown clear land in the same transaction so a partial
commit can't leave the conversation in a "switched profile/model but
still cooling down" state.

`transport.conversations.setProfile` always clears `cooldown_state` as
a side effect of the profile switch — same conversation row, single
UPDATE-shape tx, gated on `cooldownState !== null` to avoid per-call
pointless writes when the conversation was never cooling down.

`transport.profiles.update` gains an optional
`clearCooldownForConversation` argument. When set, the conversation's
ownership is verified BEFORE the profile update commits (so a wrong
conversationId aborts the whole tx rather than silently dropping the
clear), then `clearCooldown` runs alongside `updateProfile` in the
same `runInTx` block. Only `/model`'s call site passes the option;
other `profiles.update` callers (`/profile edit` and friends) are
unchanged. Cross-table same-tx is acceptable — both writes go through
the project's REPEATABLE READ transactor.

Telegram `handleModel` now passes
`clearCooldownForConversation: current.value.conversationId` on its
`profiles.update` call. `handleProfile` needs no change at the call
site — `setProfile`'s implementation handles the clear internally.

Tests pin both new behaviours: setProfile clears cooldown when set
and is a no-op when null; profiles.update gates the clear on the opt
being passed AND on ownership matching. Two negative cases pinned
(access_denied + conversation_not_found) verify ownership validation
fires before the profile update commits.

`### Clear triggers` in `design/agent-resilience.md` bumped from
`[proposed]` to `[confirmed]`.
