Profiles now carry per-profile streaming-presentation knobs honored by `StreamingAdapter` (Telegram today). Two new columns on `profiles`:

- `stream_chunk_chars` (default 4000, CHECK 100..4000) — soft cap on a single message's source-text length before the adapter rotates to a fresh message. Lower it to get a "burst of short messages" UX where each reply lands as several smaller bubbles instead of one growing edit.
- `stream_edits` (default true) — when false, the adapter never edits a message mid-stream. It emits whole chunks on boundary / finish, drops in-message tool/status banners (they'd land stale and mid-paragraph), and falls back to the platform-native typing indicator (`sendChatAction("typing")`, refreshed every 3.5s) to signal progress while the stream is in flight. The error tail in `abort()` also emits as a fresh chunk rather than as an edit so it isn't silently dropped.

Set per profile via the new `/profile stream <name>` Telegram subcommand:

```
/profile stream conversational                       → show current prefs
/profile stream conversational chunk=500             → rotate every ~500 chars
/profile stream conversational edits=off             → append-only + typing indicator
/profile stream conversational chunk=500 edits=off   → both at once
```

Plumbing: `StreamingAdapter.openStream(addr, runId, opts?)` and `RoutingContext.streamOpts` now thread `{ chunkChars, allowEdits }` from the active profile (loaded once per turn in the orchestrator and reused by the voice resolver). Existing profiles keep today's behavior — the schema defaults match the prior hard-coded constants.
