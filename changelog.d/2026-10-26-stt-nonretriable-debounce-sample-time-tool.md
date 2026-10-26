**A voice message with no STT provider configured fails its turn without retrying.** `transcribe-voice` throws `NonRetriableError`: the voice resolver returns no bundle only for absent or invalid config, which a retry finds unchanged.

**`debounceWaitMs` records at most one sample per fire.** Each debounce function records in its own `record-wait` step after the emit, so a replay doesn't record it again. The native sample is `Date.now() - event.ts` for the burst's last event, read in that step.

**`get_current_time`'s description points at the turn context**, which carries the minute each user message was handled, not the system prompt. The tool table's digest changes, so each conversation opens one new cache epoch on deploy.
