import { metrics, trace } from "@opentelemetry/api";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { __resetMetricsForTests } from "../metrics.js";

/**
 * In-memory OTel harness for unit and integration tests.
 *
 * Registers a BasicTracerProvider and MeterProvider as the global API
 * implementations.
 *
 * ProxyTracer caches its delegate on first resolution, so the harness must be
 * installed **before** any module under test creates its first span — call
 * `setupOtelHarness()` in `beforeAll`, **before** `bootstrap()`, then drain
 * between tests with `harness.reset()` in `beforeEach`. Shut down with
 * `harness.shutdown()` in `afterAll`. Swapping providers per test doesn't
 * work: the proxy's cached delegate keeps pointing at the first provider,
 * and subsequent tests see stale spans/meters.
 *
 * Use `harness.getSpans()` and `harness.collectMetrics()` to inspect emitted
 * telemetry.
 */
export interface OtelHarness {
  getSpans(): ReadonlyArray<ReadableSpan>;
  collectMetrics(): Promise<ResourceMetrics>;
  reset(): Promise<void>;
  shutdown(): Promise<void>;
}

export function setupOtelHarness(): OtelHarness {
  const spanExporter = new InMemorySpanExporter();
  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  });
  trace.setGlobalTracerProvider(tracerProvider);

  // DELTA temporality so collectMetrics() in each test returns only the
  // measurements made since the previous reset.
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    // Long interval — tests trigger collection manually via collectMetrics().
    exportIntervalMillis: 60_000,
  });
  const meterProvider = new MeterProvider({ readers: [metricReader] });
  metrics.setGlobalMeterProvider(meterProvider);
  __resetMetricsForTests();

  return {
    getSpans() {
      // Defensive copy — the exporter's internal array is mutated by
      // reset(); callers inspecting a snapshot between tests shouldn't see
      // their list cleared out from underneath them.
      return [...spanExporter.getFinishedSpans()];
    },
    async collectMetrics() {
      const result = await metricReader.collect();
      return result.resourceMetrics;
    },
    async reset() {
      spanExporter.reset();
      // Drain the SDK's internal accumulator so the next collect only sees
      // measurements made in the new test. Without this, DELTA exports stack
      // across tests because the counter remembers the previous data points.
      await metricReader.collect();
      metricExporter.reset();
    },
    async shutdown() {
      trace.disable();
      metrics.disable();
      await tracerProvider.shutdown();
      await meterProvider.shutdown();
    },
  };
}
