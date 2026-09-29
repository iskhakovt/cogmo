import { DataPointType } from "@opentelemetry/sdk-metrics";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { coreMemoryEdits, memoryRecallFailures } from "./metrics.js";
import { expectDefined } from "./test/assertions.js";
import { type OtelHarness, setupOtelHarness } from "./test/otel-harness.js";

describe("metrics", () => {
  let harness: OtelHarness;

  beforeAll(() => {
    harness = setupOtelHarness();
  });

  beforeEach(async () => {
    await harness.reset();
  });

  afterAll(async () => {
    await harness.shutdown();
  });

  it("exports auto-recall failures as a monotonic counter per bank", async () => {
    memoryRecallFailures.add(1, { bank_id: "user-1" });
    memoryRecallFailures.add(1, { bank_id: "user-1" });
    memoryRecallFailures.add(1, { bank_id: "user-2" });

    const result = await harness.collectMetrics();
    const metric = expectDefined(
      result.scopeMetrics
        .flatMap((s) => s.metrics)
        .find((m) => m.descriptor.name === "cogmo.memory.recall.failures"),
      "cogmo.memory.recall.failures",
    );
    expect(metric).toMatchObject({ dataPointType: DataPointType.SUM, isMonotonic: true });
    const byBank = Object.fromEntries(
      metric.dataPoints.map((p) => [String(p.attributes.bank_id), p.value]),
    );
    expect(byBank).toEqual({ "user-1": 2, "user-2": 1 });
  });

  it("exports core-memory edits as a monotonic counter per key, target and change", async () => {
    coreMemoryEdits.add(1, { key: "identity", target: "shared", change: "updated" });
    coreMemoryEdits.add(1, { key: "identity", target: "shared", change: "updated" });
    coreMemoryEdits.add(1, { key: "preferences", target: "class", change: "created" });

    const result = await harness.collectMetrics();
    const metric = expectDefined(
      result.scopeMetrics
        .flatMap((s) => s.metrics)
        .find((m) => m.descriptor.name === "cogmo.core_memory.edits"),
      "cogmo.core_memory.edits",
    );
    expect(metric).toMatchObject({
      descriptor: { unit: "{edit}" },
      dataPointType: DataPointType.SUM,
      isMonotonic: true,
    });
    expect(metric.dataPoints.map((p) => [p.attributes, p.value])).toEqual(
      expect.arrayContaining([
        [{ key: "identity", target: "shared", change: "updated" }, 2],
        [{ key: "preferences", target: "class", change: "created" }, 1],
      ]),
    );
    expect(metric.dataPoints).toHaveLength(2);
  });
});
