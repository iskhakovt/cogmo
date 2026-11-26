import type { Attributes } from "@opentelemetry/api";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger.js";
import type { CheckReading, LivenessCheck } from "./check.js";
import { type LivenessClock, LivenessRegistry } from "./registry.js";

const TICK_MS = 15_000;
const WALL = new Date("2026-11-19T09:00:15.000Z");

const PASS: CheckReading = { status: "pass", observedValue: 3 };

function warning(reason: string, detail: string | null = "raw"): CheckReading {
  return { status: "warn", reason, output: `${reason}: text`, observedValue: 90, detail };
}

/** A check that reports whatever the test last set. */
function settable(check: string, componentId: string, initial: CheckReading) {
  let reading = initial;
  const evaluate = vi.fn((_now: number) => reading);
  return {
    entry: { check, componentId, evaluate } satisfies LivenessCheck,
    set(next: CheckReading) {
      reading = next;
    },
    evaluate,
  };
}

let monotonic = 0;
const clock: LivenessClock = { monotonic: () => monotonic, wall: () => WALL };

let meterProvider: MeterProvider;
let reader: PeriodicExportingMetricReader;
const registries: LivenessRegistry[] = [];

function start(checks: ReadonlyArray<LivenessCheck>): LivenessRegistry {
  const registry = LivenessRegistry.start(checks, {
    meter: meterProvider.getMeter("test"),
    tickMs: TICK_MS,
    clock,
  });
  registries.push(registry);
  return registry;
}

async function gaugePoints(): Promise<ReadonlyArray<{ value: number; attributes: Attributes }>> {
  const { resourceMetrics } = await reader.collect();
  return resourceMetrics.scopeMetrics
    .flatMap(({ metrics }) => metrics)
    .filter(({ descriptor }) => descriptor.name === "cogmo.check.status")
    .flatMap(({ dataPoints }) =>
      dataPoints.map(({ value, attributes }) => ({ value: Number(value), attributes })),
    );
}

beforeEach(() => {
  vi.useFakeTimers();
  monotonic = 0;
  reader = new PeriodicExportingMetricReader({
    exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
    exportIntervalMillis: 60_000,
  });
  meterProvider = new MeterProvider({ readers: [reader] });
});

afterEach(async () => {
  for (const registry of registries.splice(0)) registry.stop();
  vi.useRealTimers();
  await meterProvider.shutdown();
});

describe("LivenessRegistry", () => {
  it("evaluates every check once when started, at the clock's monotonic now", () => {
    const telegram = settable("telegram:polling", "tg-1", PASS);
    monotonic = 42_000;

    const registry = start([telegram.entry]);

    expect(telegram.evaluate).toHaveBeenCalledExactlyOnceWith(42_000);
    expect(registry.results()).toEqual([
      { check: "telegram:polling", componentId: "tg-1", reading: PASS, time: WALL },
    ]);
  });

  it("reports pass with no checks", () => {
    const registry = start([]);

    expect(registry.status()).toBe("pass");
    expect(registry.results()).toEqual([]);
  });

  it("reports warn when any entry warns", () => {
    const registry = start([
      settable("telegram:polling", "tg-1", PASS).entry,
      settable("channels:adapter", "dc-1", warning("unsupported")).entry,
    ]);

    expect(registry.status()).toBe("warn");
  });

  it("evaluates again on each tick and serves the last tick between", () => {
    const telegram = settable("telegram:polling", "tg-1", PASS);
    const registry = start([telegram.entry]);
    telegram.set(warning("stale"));

    vi.advanceTimersByTime(TICK_MS - 1);
    expect(registry.status()).toBe("pass");

    vi.advanceTimersByTime(1);
    expect(registry.status()).toBe("warn");
    expect(telegram.evaluate).toHaveBeenCalledTimes(2);
  });

  it("hands out a snapshot a later tick doesn't change", () => {
    const telegram = settable("telegram:polling", "tg-1", PASS);
    const registry = start([telegram.entry]);
    const before = registry.results();
    telegram.set(warning("stale"));

    vi.advanceTimersByTime(TICK_MS);

    expect(before[0]?.reading).toEqual(PASS);
  });

  describe("verdict lines", () => {
    it("logs a warning, a reason change, and the clearing pass, once each", () => {
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
      const info = vi.spyOn(logger, "info").mockImplementation(() => {});
      try {
        const telegram = settable("telegram:polling", "tg-1", PASS);
        start([telegram.entry]);
        expect(warn).not.toHaveBeenCalled();
        expect(info).not.toHaveBeenCalled();

        telegram.set(warning("flapping"));
        vi.advanceTimersByTime(TICK_MS);
        vi.advanceTimersByTime(TICK_MS);
        telegram.set(warning("wedged"));
        vi.advanceTimersByTime(TICK_MS);
        telegram.set(PASS);
        vi.advanceTimersByTime(TICK_MS);
        vi.advanceTimersByTime(TICK_MS);

        expect(warn.mock.calls).toEqual([
          [
            {
              check: "telegram:polling",
              componentId: "tg-1",
              reason: "flapping",
              output: "flapping: text",
              detail: "raw",
            },
            "liveness check warn",
          ],
          [
            {
              check: "telegram:polling",
              componentId: "tg-1",
              reason: "wedged",
              output: "wedged: text",
              detail: "raw",
            },
            "liveness check warn",
          ],
        ]);
        expect(info.mock.calls).toEqual([
          [{ check: "telegram:polling", componentId: "tg-1" }, "liveness check pass"],
        ]);
      } finally {
        warn.mockRestore();
        info.mockRestore();
      }
    });

    it("logs a first reading that warns, without a detail it doesn't have", () => {
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
      try {
        start([settable("channels:adapter", "dc-1", warning("unsupported", null)).entry]);

        expect(warn).toHaveBeenCalledExactlyOnceWith(
          {
            check: "channels:adapter",
            componentId: "dc-1",
            reason: "unsupported",
            output: "unsupported: text",
          },
          "liveness check warn",
        );
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe("a check that throws", () => {
    it("reports check_error and logs it at error once per streak", () => {
      const error = vi.spyOn(logger, "error").mockImplementation(() => {});
      try {
        const bug = new Error("bug");
        const broken: LivenessCheck = {
          check: "telegram:polling",
          componentId: "tg-1",
          evaluate: () => {
            throw bug;
          },
        };
        const healthy = settable("crons:heartbeat", "ticker", PASS);

        const registry = start([broken, healthy.entry]);
        vi.advanceTimersByTime(TICK_MS);

        expect(registry.status()).toBe("warn");
        expect(registry.results().map(({ reading }) => reading)).toEqual([
          {
            status: "warn",
            reason: "check_error",
            output: "check_error: the check threw",
            observedValue: null,
            detail: null,
          },
          PASS,
        ]);
        expect(error).toHaveBeenCalledExactlyOnceWith(
          {
            check: "telegram:polling",
            componentId: "tg-1",
            reason: "check_error",
            output: "check_error: the check threw",
            err: bug,
          },
          "liveness check warn",
        );
      } finally {
        error.mockRestore();
      }
    });
  });

  describe("the cogmo.check.status gauge", () => {
    it("observes both states per entry with exactly check, component_id and status", async () => {
      start([
        settable("telegram:polling", "tg-1", warning("stale")).entry,
        settable("crons:heartbeat", "ticker", PASS).entry,
      ]);

      const points = await gaugePoints();

      expect(points).toHaveLength(4);
      expect(points).toEqual(
        expect.arrayContaining([
          {
            value: 0,
            attributes: { check: "telegram:polling", component_id: "tg-1", status: "pass" },
          },
          {
            value: 1,
            attributes: { check: "telegram:polling", component_id: "tg-1", status: "warn" },
          },
          {
            value: 1,
            attributes: { check: "crons:heartbeat", component_id: "ticker", status: "pass" },
          },
          {
            value: 0,
            attributes: { check: "crons:heartbeat", component_id: "ticker", status: "warn" },
          },
        ]),
      );
    });

    it("follows the last tick", async () => {
      const telegram = settable("telegram:polling", "tg-1", PASS);
      start([telegram.entry]);
      telegram.set(warning("stale"));
      vi.advanceTimersByTime(TICK_MS);

      expect(await gaugePoints()).toEqual(
        expect.arrayContaining([
          {
            value: 1,
            attributes: { check: "telegram:polling", component_id: "tg-1", status: "warn" },
          },
        ]),
      );
    });
  });

  describe("stop", () => {
    it("clears the tick and detaches the gauge, idempotently", async () => {
      const telegram = settable("telegram:polling", "tg-1", PASS);
      const registry = start([telegram.entry]);

      registry.stop();
      registry.stop();
      vi.advanceTimersByTime(10 * TICK_MS);

      expect(telegram.evaluate).toHaveBeenCalledOnce();
      expect(await gaugePoints()).toEqual([]);
    });
  });
});
