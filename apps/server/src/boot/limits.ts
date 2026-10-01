/**
 * Coding-delegation sandboxes (devbase image). 2 cpu / 2 GiB fits
 * `claude` CLI + a TS compile + pnpm install. `disk_bytes` omitted —
 * Daytona's 3 GiB default has headroom over the ~1.5 GiB devbase image.
 * Read by the coding orchestrators and by the boot-time image warm, which
 * bakes them into the snapshot.
 */
export const DEFAULT_CODING_RESOURCE_LIMITS = {
  cpus: 2,
  memory_bytes: 2 * 1024 * 1024 * 1024,
  pids: 256,
} as const;
