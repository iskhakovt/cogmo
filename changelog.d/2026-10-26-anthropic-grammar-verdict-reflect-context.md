**The Anthropic adapter remembers a schema its structured-output grammar rejected.** After the 400 for a schema past the grammar's compile limits, `chat` re-sends it on the tool path and keeps its digest (key order aside), so that adapter's later calls with the schema go straight to the tool path instead of paying the rejected round trip first. The verdict lives on the adapter, which the resolver keeps per model until restart.

**`ReflectOptions` drops `context`.** Hindsight deprecates the field (the server appends it to the query as `Additional context: …`), and no caller set it.
