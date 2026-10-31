/**
 * A stand-in for grammY that records what `setup()` registers, for the
 * adapter's tests. Each test file installs it with
 * `vi.mock("grammy", async () => (await import("<relative path>/test/telegram/grammy-mock.js")).grammyModule)`
 * and calls `resetGrammyMock()` before each test.
 */

import { vi } from "vitest";

/**
 * Every handler `setup()` registered, keyed `command:<name>`, `on:<filter>`
 * or `callbackQuery:<pattern source>`.
 */
// biome-ignore lint/suspicious/noExplicitAny: each test drives a handler with a ctx built for that handler alone
export const handlers = new Map<string, any>();

type Handler = (ctx: unknown) => unknown;

export const mockBotApi = {
  sendMessage: vi.fn().mockResolvedValue({ message_id: 100 }),
  sendChatAction: vi.fn().mockResolvedValue(true),
  editMessageText: vi.fn().mockResolvedValue({}),
  editMessageReplyMarkup: vi.fn().mockResolvedValue({}),
  deleteMessage: vi.fn().mockResolvedValue(true),
  sendPhoto: vi.fn().mockResolvedValue({ message_id: 101 }),
  sendVoice: vi.fn().mockResolvedValue({ message_id: 102 }),
  sendAudio: vi.fn().mockResolvedValue({ message_id: 103 }),
  sendDocument: vi.fn().mockResolvedValue({ message_id: 104 }),
  getFile: vi.fn().mockResolvedValue({ file_path: "photos/file_1.jpg" }),
  setMyCommands: vi.fn().mockResolvedValue(true),
  getUpdates: vi.fn().mockResolvedValue([]),
};

// Commands belong on the composer `bot.drop(matchFilter(":forward_origin"))`
// returns, which records them under `command:<name>`. The bot refuses a
// command, and `drop` any other predicate, so a command a forwarded `/cmd`
// could run fails setup. grammY's routing past the composer is covered by
// forwarded.test.ts.
const forwardFilter = (): boolean => false;
export const commandComposer = {
  command: vi.fn((cmd: string, handler: Handler) => handlers.set(`command:${cmd}`, handler)),
};

/** The part of a grammY context the bot's middleware reads: the update's id, its chat and its sender. */
interface UpdateCtx {
  update: { update_id: number };
  chat?: { id: number; type: string };
  from?: { id: number };
}

type UpdateMiddleware = (ctx: UpdateCtx, next: () => Promise<void>) => Promise<void>;

/**
 * What the mocked `bot.start()` (the polling loop) and `bot.stop()` (the
 * offset confirmation) return, the middleware `bot.use()` registered, the
 * options the bot was built with, and the order the bot's middleware went
 * in (`use`, `drop`, `callbackQuery`, `on:<filter>`, `start`), which is the
 * order grammY runs it in. Reset before each test.
 */
export const botLifecycle = {
  polling: (): Promise<void> => Promise.resolve(),
  stop: (): Promise<void> => Promise.resolve(),
  middleware: [] as UpdateMiddleware[],
  options: undefined as unknown,
  registrations: [] as string[],
};

/**
 * Run one update from sender 1 in its private chat through the registered
 * middleware, then `handler`, as grammY composes them.
 */
export function runUpdate(updateId: number, handler: () => Promise<void>): Promise<void> {
  return compose(
    { update: { update_id: updateId }, chat: { id: 1, type: "private" }, from: { id: 1 } },
    handler,
  );
}

/** Run `ctx` through the registered middleware, then the handler registered under `key`. */
export function deliverUpdate(key: string, ctx: UpdateCtx): Promise<void> {
  const handler = handlers.get(key);
  if (handler === undefined) throw new Error(`no handler registered under ${key}`);
  return compose(ctx, () => handler(ctx));
}

function compose(ctx: UpdateCtx, handler: () => Promise<void>): Promise<void> {
  const run = (index: number): Promise<void> => {
    const middleware = botLifecycle.middleware[index];
    return middleware ? middleware(ctx, () => run(index + 1)) : handler();
  };
  return run(0);
}

// Grammy's InputFile wraps a Buffer — the test captures it so assertions can
// inspect the payload without needing the real grammy implementation.
class InputFile {
  constructor(
    public data: Buffer | Uint8Array,
    public filename?: string,
  ) {}
}

class MockBot {
  constructor(_token: string, options?: unknown) {
    botLifecycle.options = options;
  }
  api = mockBotApi;
  command = vi.fn((cmd: string) => {
    throw new Error(`/${cmd} registered on the bot, where a forwarded /${cmd} would run it`);
  });
  on = vi.fn((filter: string, handler: Handler) => {
    botLifecycle.registrations.push(`on:${filter}`);
    handlers.set(`on:${filter}`, handler);
  });
  callbackQuery = vi.fn((pattern: RegExp, handler: Handler) => {
    botLifecycle.registrations.push("callbackQuery");
    handlers.set(`callbackQuery:${pattern.source}`, handler);
  });
  drop = vi.fn((predicate: unknown) => {
    if (predicate !== forwardFilter) throw new Error("drop expects the forward_origin filter");
    botLifecycle.registrations.push("drop");
    return commandComposer;
  });
  catch = vi.fn();
  use = vi.fn((middleware: UpdateMiddleware) => {
    botLifecycle.registrations.push("use");
    botLifecycle.middleware.push(middleware);
  });
  // Real grammY returns a Promise<void> that resolves when bot.stop() is
  // called. The adapter awaits it on stop() to drain — without the
  // Promise return type, `attachPolling` errors with "Cannot read
  // properties of undefined (reading 'catch')".
  start = vi.fn(({ onStart }: { onStart?: () => void } = {}) => {
    botLifecycle.registrations.push("start");
    onStart?.();
    return botLifecycle.polling();
  });
  stop = vi.fn(() => botLifecycle.stop());
}

export const grammyModule = {
  Bot: MockBot,
  InputFile,
  matchFilter: vi.fn(() => forwardFilter),
};

export function resetGrammyMock(): void {
  handlers.clear();
  vi.clearAllMocks();
  botLifecycle.polling = () => Promise.resolve();
  botLifecycle.stop = () => Promise.resolve();
  botLifecycle.middleware = [];
  botLifecycle.options = undefined;
  botLifecycle.registrations = [];
}
