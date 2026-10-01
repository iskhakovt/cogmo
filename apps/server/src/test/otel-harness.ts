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
  type SpanExporter,
  type SpanProcessor,
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
 * telemetry, and `harness.startedSpanCount()` to count spans started,
 * whether or not they ended.
 *
 * `wrapExporter` puts an exporter wrapper between the span processor and the
 * in-memory exporter, so `getSpans()` returns what the wrapper exported —
 * how `otel.ts` wraps the OTLP exporter.
 */
export interface OtelHarness {
  getSpans(): ReadonlyArray<ReadableSpan>;
  startedSpanCount(): number;
  collectMetrics(): Promise<ResourceMetrics>;
  reset(): Promise<void>;
  shutdown(): Promise<void>;
}

export function setupOtelHarness(opts?: {
  wrapExporter?: (exporter: SpanExporter) => SpanExporter;
}): OtelHarness {
  const spanExporter = new InMemorySpanExporter();
  let started = 0;
  const startCounter: SpanProcessor = {
    onStart: () => {
      started++;
    },
    onEnd: () => {},
    forceFlush: async () => {},
    shutdown: async () => {},
  };
  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [
      new SimpleSpanProcessor(opts?.wrapExporter?.(spanExporter) ?? spanExporter),
      startCounter,
    ],
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
    startedSpanCount() {
      return started;
    },
    async collectMetrics() {
      const result = await metricReader.collect();
      return result.resourceMetrics;
    },
    async reset() {
      spanExporter.reset();
      started = 0;
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
