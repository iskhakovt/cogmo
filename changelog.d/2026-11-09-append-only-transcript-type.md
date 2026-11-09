Append-only step 9: the agent loop sends every request through a `Transcript` (`src/agent/transcript.ts`) rather than a bare message array, so a message a request carried can't be edited.

- `openTranscript` opens it once the turn's epoch is settled, from the rendered view compaction returns unchanged or rewritten. A rewritten view under a continued epoch throws, so only an epoch opening sends a rewrite.
- The loop adds messages with `append`, and changes only an unsent last message with `amendUnsent` (the truncation notice) or `discardUnsent` (an empty `end_turn`, a degraded or stuck iteration). Both throw on a sent message.
- `request()` returns the request and its transcript head, extended from the previous one, and records it as sent on every invocation, replays included.

No request, step or stored row changes. The history-repair warning now reads `transcript history invariants repaired`; a log query on the old `agent loop history invariants repaired` needs the new text.
