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
 * Iterations per agent loop turn. Spotting runaway loops near the
 * iteration limit (default 20) is the main use case.
 */
export const agentIterations = {
  record(value: number, attrs?: MetricAttributes): void {
    instruments().agentIterations.record(value, attrs);
  },
};

/** Test-only: drop the cached instruments so the next access re-resolves. */
export function __resetMetricsForTests(): void {
  cached = null;
}
