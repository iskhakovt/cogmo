`DaytonaSandboxSession.execStreaming` now routes `attachStdin: true`
calls through a new PTY-based backend (`src/sandbox/daytona/exec-pty.ts`)
instead of the session-command HTTP path. Session-command stdin has no
remote-EOF channel — for `runAsync: true` commands the Daytona daemon
pins the FIFO open with a long-running `sleep` writer by design — so
any caller that relies on stdin EOF as a shutdown signal (notably
`claude --input-format stream-json`, where EOF is the documented
graceful-shutdown trigger) wedged forever, and the 5-minute idle
backstop was the only thing that broke the deadlock.

The PTY path uploads caller writes to `/tmp/cogmo-pty-stdin-<uuid>.bin`
via `fs.uploadFile` on `stdin.end()`, then runs one shell line through
the PTY: `exec <argv> < <stdinPath> 2> <stderrPath>`. The shell-level
redirect gives the child a real pipe FD on stdin (not a TTY), so EOF
arrives naturally when the file is exhausted; `exec` replaces the
shell so PTY exit equals target-binary exit, no marker parsing. Stderr
is redirected to a tmpfile and surfaced via the existing stderr
`Readable` after the child exits, keeping the PTY's combined onData
channel clean for the consumer's JSONL parser. `NO_COLOR=1` is set in
the PTY env block to suppress ANSI escapes that the CLI would emit
against an isatty stdout.

The session-command path keeps serving output-only execs (where its
demuxed stdout/stderr WS callbacks remain the right shape). The
`SessionCommandInputWritable` wrapper is gone, and
`startExecStreaming` now rejects `attachStdin: true` explicitly so a
caller that bypasses the session-level router gets a clear failure
instead of a silent hang.

Unit coverage lives in `src/sandbox/daytona/exec-pty.test.ts` (file
upload, exec line, env merge, idle/total timers, dispose, upload
failure). A live-Daytona end-to-end test sits in
`src/agent/coding/claude-cli-daytona.integration.test.ts` under
`describe.skip` — operator flips off the `.skip` and runs against
real `DAYTONA_API_KEY` + `ANTHROPIC_API_KEY` when verifying any change
to the PTY exec path. It stays skipped on default integration runs so
CI doesn't burn live API budget.
