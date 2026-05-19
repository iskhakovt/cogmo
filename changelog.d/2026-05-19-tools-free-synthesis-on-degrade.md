Tools-free synthesis on degrade: the orchestrator now produces a
model-generated 1–3 sentence apology when a turn degrades, replacing
the fixed `"I had trouble generating a clean response — ..."` string.
Fires for every degrade path (Class C exhaustion, Class D fingerprint,
volume cluster, iteration cap). The synthesis call inherits the failing
turn's provider, runs with `tools: []` and `temperature: 0`, and is
bounded by a 5s wall-clock cap via `Promise.race`. On any failure
(timeout, refusal, provider outage, empty response), the orchestrator
falls back to the prior fixed string and emits
`agent.degrade.synthesis { ok: false, fallback: <reason> }` so the
forensic record names *why* synthesis failed; the user-facing path
never propagates the synthesis failure upward.

Subtype-aware system prompt — the model is told what stopped the
conversation in human-readable terms (e.g. `stream_truncation` → "your
response stream was truncated mid-tool-call and the recovery replay
also failed to parse", `null + iteration_cap` → "the conversation hit
its iteration-count limit before producing a final reply"). The
conversation history at the point of degrade is passed as `messages`
so the model can reference what the user actually asked for and what
was attempted.

New `temperature?: number` field on `ChatParams`; threaded through the
Anthropic and OpenAI-compat adapters (both `chat` and `chatStream`
paths, plus Anthropic's structured-output branch for consistency).
Default behavior unchanged when unset — provider's own default
applies.

Telemetry: `agent.degrade.synthesis` with `event`, `reason`, `subtype`,
`tokensIn`, `tokensOut`, `durationMs`, `ok: boolean`. On failure the
event also carries `fallback: "timeout" | "refusal" | "protocol" |
"error" | "empty_text"` and the original error message. Downstream
queries count failures as `event == "agent.degrade.synthesis" && ok ==
false`. The underlying `conversation/degraded` event still fires once
per degraded turn regardless of synthesis outcome — it carries the
`reason` and `subtype` from the loop, not from the synthesis.

Tests: 14 unit cases on `synthesizeDegradedReply` covering success,
timeout, refusal, generic provider error, empty response, telemetry
shape (ok=true and ok=false), refusal subtype fallback to the
refusal-specific fixed string, never-throws contract, and per-subtype
reason-text rendering. Plus updated `handle-message.test.ts` cases
pinning the wiring: synthesized text lands in the stream + persist,
synthesis runs with `tools: []` and `temperature: 0`, provider failure
falls back to the fixed string without aborting the turn, refusal
degrade with failing synthesis falls back to the refusal-specific
fixed string. Marker on `design/agent-resilience.md` →
"Tools-free synthesis on degrade" promoted from `[proposed]` to
`[confirmed]`.
