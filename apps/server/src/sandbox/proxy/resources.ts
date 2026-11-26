/**
 * Resource limits on a container create: the task's `ResourceLimits` are
 * injected where the create sets none, and are the cap where it sets one
 * (design/sandbox.md → Proxy Design → Create policy). `null` and `0` mean
 * absent. A negative value is denied, because the API reads it as
 * unlimited.
 */

import { err, ok, Result } from "neverthrow";
import type { ResourceLimits } from "../types.js";
import type { CreateHostConfig } from "./body-schemas.js";
import { denied, type ProxyRejection } from "./rejection.js";

/** The daemon's CFS period when `CpuPeriod` is absent, in microseconds. */
const DEFAULT_CPU_PERIOD = 100_000;
const NANOS_PER_CPU = 1_000_000_000;

/** CPU as one quantity, in exactly one of the daemon's two forms. */
type CpuFields = { NanoCpus: number } | { CpuQuota: number; CpuPeriod?: number };

export type ResourceFields = {
  Memory: number;
  MemorySwap: number;
  PidsLimit: number;
} & CpuFields;

type ResourceRequest = Pick<
  CreateHostConfig,
  "Memory" | "MemorySwap" | "PidsLimit" | "NanoCpus" | "CpuQuota" | "CpuPeriod" | "ShmSize"
>;

/** The limits forwarded resource fields come to, as a child's row records them. */
export function effectiveLimits(fields: ResourceFields): ResourceLimits {
  return { cpus: cpusOf(fields), memory_bytes: fields.Memory, pids: fields.PidsLimit };
}

function cpusOf(cpu: CpuFields): number {
  return "NanoCpus" in cpu
    ? cpu.NanoCpus / NANOS_PER_CPU
    : cpu.CpuQuota / (cpu.CpuPeriod ?? DEFAULT_CPU_PERIOD);
}

/** The resource fields to forward in place of the request's. */
export function limitResources(
  host: ResourceRequest,
  limits: ResourceLimits,
): Result<ResourceFields, ProxyRejection> {
  return Result.combine([
    capped("HostConfig.Memory", host.Memory, limits.memory_bytes),
    capped("HostConfig.PidsLimit", host.PidsLimit, limits.pids),
    cpuQuantity(host, limits.cpus),
  ]).andThen(([memory, pids, cpu]) =>
    Result.combine([swapFor(host.MemorySwap, memory), shmWithin(host.ShmSize, memory)]).map(
      ([swap]) => ({ Memory: memory, MemorySwap: swap, PidsLimit: pids, ...cpu }),
    ),
  );
}

function capped(
  field: string,
  value: number | null | undefined,
  limit: number,
): Result<number, ProxyRejection> {
  const set = present(value);
  if (set === undefined) return ok(limit);
  if (set < 0) return err(denied(`${field} ${set} (unlimited)`));
  if (set > limit) return err(denied(`${field} ${set} above the task's limit of ${limit}`));
  return ok(set);
}

/**
 * The daemon refuses `NanoCpus` beside `CpuQuota`, so both together are
 * denied. With neither, `NanoCpus` is injected and a lone `CpuPeriod`
 * dropped, since a period means nothing without a quota.
 */
function cpuQuantity(host: ResourceRequest, cpus: number): Result<CpuFields, ProxyRejection> {
  const limit = BigInt(Math.round(cpus * NANOS_PER_CPU));
  const nano = present(host.NanoCpus);
  const quota = present(host.CpuQuota);
  const period = present(host.CpuPeriod);
  if (period !== undefined && period < 0) return err(denied(`HostConfig.CpuPeriod ${period}`));
  if (nano !== undefined && quota !== undefined) {
    return err(denied("HostConfig.NanoCpus together with HostConfig.CpuQuota"));
  }
  if (quota !== undefined) return quotaWithin(quota, period, limit);
  if (nano === undefined) return ok({ NanoCpus: Number(limit) });
  if (nano < 0) return err(denied(`HostConfig.NanoCpus ${nano}`));
  if (BigInt(nano) > limit) {
    return err(denied(`HostConfig.NanoCpus ${nano} above the task's limit of ${limit}`));
  }
  return ok({ NanoCpus: nano });
}

/** `quota / period` CPUs against the limit in nano-CPUs, compared exactly. */
function quotaWithin(
  quota: number,
  period: number | undefined,
  limit: bigint,
): Result<CpuFields, ProxyRejection> {
  if (quota < 0) return err(denied(`HostConfig.CpuQuota ${quota} (unlimited)`));
  const effective = BigInt(period ?? DEFAULT_CPU_PERIOD);
  if (BigInt(quota) * BigInt(NANOS_PER_CPU) > limit * effective) {
    return err(
      denied(`HostConfig.CpuQuota ${quota} per period ${effective} above the task's CPU limit`),
    );
  }
  return ok(period === undefined ? { CpuQuota: quota } : { CpuQuota: quota, CpuPeriod: period });
}

/** Swap equal to memory: no swap beyond the memory limit. */
function swapFor(swap: number | null | undefined, memory: number): Result<number, ProxyRejection> {
  const set = present(swap);
  return set === undefined || set === memory
    ? ok(memory)
    : err(denied(`HostConfig.MemorySwap ${set} other than HostConfig.Memory ${memory}`));
}

function shmWithin(shm: number | null | undefined, memory: number): Result<void, ProxyRejection> {
  const set = present(shm);
  return set !== undefined && set > memory
    ? err(denied(`HostConfig.ShmSize ${set} above HostConfig.Memory ${memory}`))
    : ok(undefined);
}

function present(value: number | null | undefined): number | undefined {
  return value === null || value === undefined || value === 0 ? undefined : value;
}
