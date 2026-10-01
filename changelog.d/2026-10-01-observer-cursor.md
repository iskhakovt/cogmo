The Observer extracts only what it hasn't processed. `conversations` carries a cursor per extraction phase, `corrections_observed_through` and `memories_observed_through`, so an idle fire reads the messages after it, with the widest stored summary that ends before them and the last 10 earlier messages as labelled context. A re-read transcript no longer reinforces an old correction again or stores its facts again.

- **Chunks.** A window larger than a quarter of the extraction model's input budget is split at message boundaries; a fire extracts at most 3 chunks per phase and advances that phase's cursor after each, so a failed phase keeps its window for the next fire.
- **Retry-safe writes.** Each retained fact has a stable Hindsight document id from its chunk, so a re-run extraction replaces its own documents. Memory extraction fails its chunk on a failed model call instead of reporting nothing found.
- **Contradictions** key on the chunk: `steering_rules.contradicted_through_message_id` replaces the conversation marker, so a contradiction from any later chunk, including one in the same conversation, retires a rule an earlier one reset.
- **Held memories.** A third-party fire bound by a user's `memory` rule leaves the memories cursor where it is, so those messages stay unextracted rather than lost.
- **Nothing new.** A fire with both cursors caught up skips extraction and still drains; `/reflect` answers "Nothing new since the last reflection."

Migration 0068 adds the cursors and the marker. Existing conversations start with no cursor, so each one's next fire reads its whole history once, in chunks. See design/evolution.md → Observation Window.
