The empty-`end_turn` continuation prompt is persisted with the reply that follows it (Append-only step 3), so the next turn replays the request the model saw; a degraded turn whose reply to it was dropped drops the prompt too. It carries a structural `harness` tag on its text block — `continuation`, `volume_nudge` or `truncation_notice` — validated with the message content; untagged rows read unchanged.

- The volume-cluster nudge is recognized by its tag, not its wording.
- The web history and the Observer drop `continuation` and `volume_nudge` rows and keep the truncation notice.
- `findUserMessageByInbound` takes the newest row on the cursor with no `tool_result` or tagged block; it and `snapToPairBoundary` share one turn-row rule, `isTurnRowContent`, built from `HARNESS_ROW_TAGS`.
- `snapToPairBoundary` keeps a tagged user row with the row before it, and the OpenAI-compatible adapter merges consecutive user messages.
- A pipeline stage that degrades before keeping any message fails with its degrade reason instead of an empty insert.

See design/prompt-caching.md → Stored shapes.
