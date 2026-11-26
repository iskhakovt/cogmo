/**
 * The bot token masked in what the adapter writes: a Bot API error's text can
 * echo the bare token, which the logger's URL shapes miss
 * (design/liveness.md → Surface).
 */

import { REDACTED_BOT_TOKEN } from "../../../util/redact-secrets.js";

/**
 * The token raw or percent-encoded, a character at a time and in either hex
 * case, so `123:abc`, `123%3Aabc` and `123%3aabc` all match.
 */
function tokenPattern(token: string): RegExp {
  const source = [...token]
    .map((char) => {
      const encoded = encodeURIComponent(char);
      if (encoded === char) return RegExp.escape(char);
      const anyCase = encoded.replace(/[A-F]/g, (hex) => `[${hex}${hex.toLowerCase()}]`);
      return `(?:${RegExp.escape(char)}|${anyCase})`;
    })
    .join("");
  return new RegExp(source, "g");
}

/**
 * Every key pino's error serializer reads from `err`, and whether it
 * enumerates it: each `for…in` key does, and its own names and the three it
 * reads by name otherwise don't.
 */
function serializedKeys(err: Error): ReadonlyMap<string, boolean> {
  const keys = new Map<string, boolean>(
    [...Object.getOwnPropertyNames(err), "name", "message", "stack"].map((key) => [key, false]),
  );
  for (const key in err) keys.set(key, true);
  return keys;
}

export class TokenRedactor {
  readonly #pattern: RegExp;

  constructor(token: string) {
    this.#pattern = tokenPattern(token);
  }

  /** `value` with every form of the token masked. */
  text(value: string): string {
    return value.replace(this.#pattern, REDACTED_BOT_TOKEN);
  }

  /**
   * A copy of `err` for a log line's `err`, with every form of the token
   * masked in each string it carries: its message, stack and description, and
   * the same in a wrapped error or a cause. `err` itself is left unchanged.
   */
  error(err: unknown): unknown {
    return this.#copy(err, new Map());
  }

  #copy(value: unknown, copies: Map<Error, Error>): unknown {
    if (typeof value === "string") return this.text(value);
    if (Array.isArray(value)) return value.map((item: unknown) => this.#copy(item, copies));
    if (!(value instanceof Error)) return value;
    const existing = copies.get(value);
    if (existing !== undefined) return existing;
    // A native error, as `value` is, with `value`'s prototype, so the logger
    // reads it as an error and names its type.
    const copy = new Error();
    Reflect.deleteProperty(copy, "stack");
    Object.setPrototypeOf(copy, Object.getPrototypeOf(value));
    copies.set(value, copy);
    // Each key is read from `value`, where its getter works, and defined on
    // the copy as an own data property: a `DOMException`'s fields are getters
    // on its prototype that throw for any other receiver.
    for (const [key, enumerable] of serializedKeys(value)) {
      if (!(key in value)) continue;
      Object.defineProperty(copy, key, {
        value: this.#copy(Reflect.get(value, key), copies),
        enumerable,
        writable: true,
        configurable: true,
      });
    }
    return copy;
  }
}
