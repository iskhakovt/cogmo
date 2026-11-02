/**
 * Host → tier-1 child: stop cooperative Python code (the interrupt buffer's
 * SIGINT). Its own module, so the child's main thread imports no validation
 * library (`child-entry.ts`).
 */
export const INTERRUPT_MESSAGE = { type: "interrupt" } as const;
