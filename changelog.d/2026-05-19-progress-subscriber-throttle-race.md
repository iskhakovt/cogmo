Fix throttle race in `startCodingProgressSubscriber`. `lastEditAt` was
set inside the `pending.then(...)` callback — only updated *after* the
bot call resolved — and `CodingStreamingRegistry.publish()` is
fire-and-forget on listener promises, so handlers for back-to-back
events interleaved. Under slow network, every event arriving while an
edit was in flight read the stale `lastEditAt`, passed the throttle
check, and queued another `editMessageText` onto `pending`. The chain
still serialized sends so they didn't overlap on the wire, but the
throttle was effectively bypassed during burst traffic — the opposite
of what it exists to do.

The fix sets `lastEditAt = Date.now()` synchronously at the top of
`postOrEdit`, before chaining onto `pending`. Concurrent handlers
running while the edit is in flight now see the just-bumped timestamp
and skip. The throttle window is measured from the start of an edit
rather than its completion, which also drops the now-redundant
`messageId !== null` short-circuit in `maybeEdit` (initial `lastEditAt
= Number.NEGATIVE_INFINITY` lets the first event pass on its own).

Regression test in `progress-subscriber.test.ts` publishes three text
deltas synchronously at the same wall-clock tick and asserts exactly
one edit is dispatched — the old code emitted three.

Pre-existing latent bug; flagged by Gemini on PR #283 (the class→
function refactor preserved the body verbatim).
