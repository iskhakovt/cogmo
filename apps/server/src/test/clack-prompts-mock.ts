import { vi } from "vitest";

/**
 * The `@clack/prompts` surface the setup wizard calls, every member a spy. A
 * `vi.mock` factory: this module must not import `@clack/prompts` itself, or
 * it would load the real one while the mock is being built.
 */
export function clackPromptsMock() {
  return {
    confirm: vi.fn(),
    password: vi.fn(),
    text: vi.fn(),
    select: vi.fn(),
    autocomplete: vi.fn(),
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
    intro: vi.fn(),
    note: vi.fn(),
    outro: vi.fn(),
    log: { success: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    isCancel: vi.fn(() => false),
  };
}
