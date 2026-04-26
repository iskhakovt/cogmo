import { z } from "zod";

/**
 * Docker labels Cogmo injects on every container it creates or proxies.
 * Mirror of the lineage tracking in `containers` rows — the DB is authoritative,
 * labels enable orphan detection on the daemon side and survive Cogmo restarts.
 *
 * Schema is `Record<string, string>` because Docker labels are typed that way at the API
 * level; specific keys (`cogmo.managed`, `cogmo.instance`, `cogmo.root_task`,
 * `cogmo.parent`, `cogmo.depth`) are populated by the supervisor.
 */
export const ContainerLabelsSchema = z.record(z.string(), z.string());
export type ContainerLabels = z.infer<typeof ContainerLabelsSchema>;

/**
 * Resource caps applied via Docker `HostConfig`. `cpus` is fractional CPUs (1.5 = 1.5 cores);
 * `memory_bytes` and `pids` map directly to `Memory` and `PidsLimit`.
 */
export const ResourceLimitsSchema = z.object({
  cpus: z.number().positive(),
  memory_bytes: z.number().int().positive(),
  pids: z.number().int().positive(),
});
export type ResourceLimits = z.infer<typeof ResourceLimitsSchema>;
