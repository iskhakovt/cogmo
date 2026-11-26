/**
 * A stand-in for grammY that records what `setup()` registers, for the
 * adapter's tests. Each test file installs it with
 * `vi.mock("grammy", async () => (await import("<relative path>/test/telegram/grammy-mock.js")).grammyModule)`
 * and calls `resetGrammyMock()` before each test.
 */

import { vi } from "vitest";

/** grammY's own error classes, so the adapter's `instanceof` checks see what grammY throws. */
const actual = await vi.importActual<typeof import("grammy")>("grammy");

/** The Bot API refusing a call to `method`, as grammY throws it. */
export function botApiError(
  method: string,
  code: number,
  description: string,
): InstanceType<typeof actual.GrammyError> {
  return new actual.GrammyError(
    `Call to '${method}' failed! (${code}: ${description})`,
    { ok: false, error_code: code, description },
    method,
    {},
  );
}

/**
 * Every handler `setup()` registered, keyed `command:<name>`, `on:<filter>`
 * or `callbackQuery:<pattern source>`.
 */
// biome-ignore lint/suspicious/noExplicitAny: each test drives a handler with a ctx built for that handler alone
export const handlers = new Map<string, any>();

type Handler = (ctx: unknown) => unknown;

/** A Bot API call as a transformer passes it on. */
type ApiCall = (method: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>;

/** A grammY API transformer: `prev` makes the call the transformer stands in front of. */
type Transformer = (
  prev: ApiCall,
  method: string,
  payload: unknown,
  signal?: AbortSignal,
) => Promise<unknown>;

/** The transformers installed with `bot.api.config.use`, in install order. Reset before each test. */
const transformers: Transformer[] = [];

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
  // Not a mock function, so a test listing the API calls made doesn't count
  // the adapter installing its transformer.
  config: {
    use: (...installed: Transformer[]): void => {
      transformers.push(...installed);
    },
  },
};

/**
 * Make one Bot API call through the installed transformers, as grammY chains
 * them, with `answer` standing in for grammY's client: it resolves with the
 * parsed reply or rejects with the request's failure.
 */
export function callThroughTransformers(
  method: string,
  answer: () => Promise<unknown>,
): Promise<unknown> {
  const call = transformers.reduce<ApiCall>(
    (prev, transformer) => (m, payload, signal) => transformer(prev, m, payload, signal),
    () => answer(),
  );
  return call(method, {});
}

// Commands belong on the composer `bot.drop(matchFilter(":forward_origin"))`
// returns, which records them under `command:<name>`. The bot refuses a
// command, and `drop` any other predicate, so a command a forwarded `/cmd`
// could run fails setup. grammY's routing past the composer is covered by
// forwarded.test.ts.
const forwardFilter = (): boolean => false;
export const commandComposer = {
  command: vi.fn((cmd: string, handler: Handler) => handlers.set(`command:${cmd}`, handler)),
};

/**
 * The part of a grammY context the bot's middleware reads: the update's id,
 * its chat and its sender. grammY hands on an update with no id too.
 */
interface UpdateCtx {
  update: { update_id?: number };
  chat?: { id: number; type: string };
  from?: { id: number };
}

type UpdateMiddleware = (ctx: UpdateCtx, next: () => Promise<void>) => Promise<void>;

/**
 * What the mocked `bot.start()` (the polling loop) and `bot.stop()` (the
 * offset confirmation) return, the middleware `bot.use()` registered, the
 * handler `bot.catch()` set, the options the bot was built with, and the
 * order the bot's middleware went in (`use`, `drop`, `callbackQuery`,
 * `on:<filter>`, `start` once per `bot.start()`), which is the order grammY
 * runs it in. `polling` gets a promise that resolves once `bot.stop()` is
 * called, and by default runs until then, as grammY's loop does. Reset
 * before each test.
 */
export const botLifecycle = {
  polling: (stopped: Promise<void>): Promise<void> => stopped,
  stop: (): Promise<void> => Promise.resolve(),
  middleware: [] as UpdateMiddleware[],
  errorHandler: undefined as ((err: { error: unknown; ctx?: unknown }) => unknown) | undefined,
  options: undefined as unknown,
  registrations: [] as string[],
};

/**
 * Run one update from sender 1 in its private chat through the registered
 * middleware, then `handler`, as grammY composes them. `undefined` stands for
 * an update with no id.
 */
export function runUpdate(
  updateId: number | undefined,
  handler: () => Promise<void>,
): Promise<void> {
  return compose(
    {
      update: updateId === undefined ? {} : { update_id: updateId },
      chat: { id: 1, type: "private" },
      from: { id: 1 },
    },
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
  /** Resolved by `stop()`, for the run the latest `start()` began. */
  #stopped = Promise.withResolvers<void>();
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
  catch = vi.fn((handler: (err: { error: unknown; ctx?: unknown }) => unknown) => {
    botLifecycle.errorHandler = handler;
  });
  use = vi.fn((middleware: UpdateMiddleware) => {
    botLifecycle.registrations.push("use");
    botLifecycle.middleware.push(middleware);
  });
  // As in grammY, the promise settles once the polling loop ends; the
  // adapter supervises it and awaits it on stop() to drain.
  start = vi.fn(({ onStart }: { onStart?: () => void } = {}) => {
    botLifecycle.registrations.push("start");
    this.#stopped = Promise.withResolvers<void>();
    onStart?.();
    return botLifecycle.polling(this.#stopped.promise);
  });
  stop = vi.fn(() => {
    this.#stopped.resolve();
    return botLifecycle.stop();
  });
}

export const grammyModule = {
  Bot: MockBot,
  GrammyError: actual.GrammyError,
  HttpError: actual.HttpError,
  InputFile,
  matchFilter: vi.fn(() => forwardFilter),
};

export function resetGrammyMock(): void {
  handlers.clear();
  vi.clearAllMocks();
  botLifecycle.polling = (stopped) => stopped;
  botLifecycle.stop = () => Promise.resolve();
  botLifecycle.middleware = [];
  botLifecycle.errorHandler = undefined;
  botLifecycle.options = undefined;
  transformers.length = 0;
  botLifecycle.registrations = [];
}
