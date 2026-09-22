import type { Counter, Histogram, MetricAttributes } from "@opentelemetry/api";
import { metrics } from "@opentelemetry/api";

// Lazy instrument access — `metrics.getMeter()` returns a no-op meter when
// no MeterProvider is registered, and the resulting instruments stay no-op
// forever (the API has no proxy meter that re-binds). In production the SDK
// is initialized via `--import ./otel.js` before any module loads, so the
// first instrument access already sees the real meter. In tests, the harness
// registers a provider in beforeEach, after `metrics.ts` has been imported —
// so we resolve instruments on first use, not at module load. Tests can clear
// the cache via `__resetMetricsForTests()` between runs.

interface Instruments {
  llmTokens: Counter;
  debounceWaitMs: Histogram;
  agentIterations: Histogram;
  memoryRecallFailures: Counter;
}

let cached: Instruments | null = null;

function instruments(): Instruments {
  if (cached) return cached;
  const meter = metrics.getMeter("cogmo");
  cached = {
    llmTokens: meter.createCounter("cogmo.llm.tokens", {
      description: "LLM tokens consumed",
      unit: "tokens",
    }),
    debounceWaitMs: meter.createHistogram("cogmo.debounce.wait_ms", {
      description: "Debounce wait time before message handling fires",
      unit: "ms",
    }),
    agentIterations: meter.createHistogram("cogmo.agent.iterations", {
      description: "LLM call iterations per agent loop turn",
    }),
    memoryRecallFailures: meter.createCounter("cogmo.memory.recall.failures", {
      description: "Auto-recall calls that failed and left the turn without recalled context",
      unit: "{failure}",
    }),
  };
  return cached;
}

/**
 * LLM token consumption — cumulative counter labeled by model, provider, and
 * type (input | output | cache_read | cache_create). Useful for cost
 * accounting; sum and rate queries in the backend.
 */
export const llmTokens = {
  add(value: number, attrs?: MetricAttributes): void {
    instruments().llmTokens.add(value, attrs);
  },
};

/**
 * Time inbound messages spent in the debounce window before firing
 * inbound/ready. Histogram so backends can derive p50/p95/max.
 */
export const debounceWaitMs = {
  record(value: number, attrs?: MetricAttributes): void {
    instruments().debounceWaitMs.record(value, attrs);
  },
};

/**
 * Iterations per agent loop turn, sampled once the turn's messages are
 * persisted — see the `persist-new-messages` step in `handle-message.ts` for
 * why that is the only place a durable function can take the sample exactly
 * once. A turn whose persist fails irrecoverably therefore contributes
 * nothing, so read the histogram as "turns that produced a persisted reply",
 * not "turns the loop ran". Spotting runaway loops near the iteration limit
 * (default 20) is the main use case.
 */
export const agentIterations = {
  record(value: number, attrs?: MetricAttributes): void {
    instruments().agentIterations.record(value, attrs);
  },
};

/**
 * Auto-recall failures, labeled by `bank_id`. The turn degrades to a system
 * prompt with no `# Recalled Context` block rather than failing, so a memory
 * outage otherwise shows up only as an agent that seems to have forgotten
 * things.
 *
 * Only the auto-recall path counts, because only it fails silently. The
 * `memory_recall` tool hands its failure to the model as an `is_error`
 * tool_result, which the reply usually relays in the same turn. Incremented
 * inside the `auto-recall` step body, so a re-invocation that replays the
 * cached step adds nothing.
 */
export const memoryRecallFailures = {
  add(value: number, attrs?: MetricAttributes): void {
    instruments().memoryRecallFailures.add(value, attrs);
  },
};

/** Test-only: drop the cached instruments so the next access re-resolves. */
export function __resetMetricsForTests(): void {
  cached = null;
}
