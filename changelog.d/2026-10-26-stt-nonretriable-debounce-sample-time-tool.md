**A voice message with no STT provider configured fails its turn without retrying.** `transcribe-voice` throws `NonRetriableError`: the voice resolver returns no bundle only for absent or invalid config, which a retry finds unchanged.

**`debounceWaitMs` records at most one sample per fire.** Each debounce function records after its last step, the one bare-body spot a clean run executes once; `.agents/rules/inngest.md` names that spot next to recording inside steps. The native sample is the time from the burst's last event to the `inbound/ready` emit.

**`get_current_time`'s description points at the turn context**, which carries the minute each user message was handled, not the system prompt. The tool table's digest changes, so each conversation opens one new cache epoch on deploy.
