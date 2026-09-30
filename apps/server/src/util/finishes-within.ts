/**
 * `true` if `work` resolves within `ms`, `false` if it is still pending then;
 * a rejection propagates. The deadline timer is cleared either way, and work
 * that finishes late is left running.
 */
export async function finishesWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([work.then(() => true), expired]);
  } finally {
    clearTimeout(timer);
  }
}
