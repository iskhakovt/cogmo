// DIAGNOSTIC ONLY — branch diag/mcp-pipeline-timeout, never merged.

export function diag(...args: unknown[]): void {
  console.error(
    `[DIAG ${new Date().toISOString()} pid=${process.pid} slot=${process.env.VITEST_POOL_ID ?? "-"} app=${process.env.INNGEST_APP_ID ?? "-"}]`,
    ...args,
  );
}

/** Wrap an Inngest `step` so every method call, and every `step.run` body, is logged. */
export function diagStep<S extends object>(step: S, tag: string): S {
  return new Proxy(step, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      const name = String(prop);
      return (...args: unknown[]) => {
        const id = typeof args[0] === "string" ? args[0] : JSON.stringify(args[0]);
        diag(tag, `step.${name} called`, id);
        if (name === "run" && typeof args[1] === "function") {
          const body = args[1] as (...a: unknown[]) => Promise<unknown>;
          args[1] = async (...a: unknown[]) => {
            const t0 = Date.now();
            diag(tag, "step body start", id);
            try {
              const out = await body(...a);
              diag(tag, "step body end", id, `${Date.now() - t0}ms`);
              return out;
            } catch (err) {
              diag(tag, "step body threw", id, `${Date.now() - t0}ms`, String(err).slice(0, 500));
              throw err;
            }
          };
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}
