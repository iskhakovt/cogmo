Coding-task progress subscriber coalesces burst edits during streaming.
The throttle now measures from the start of an edit rather than its
completion, so stream events arriving while a Telegram edit is in
flight no longer queue redundant `editMessageText` calls onto the
serialization chain.
