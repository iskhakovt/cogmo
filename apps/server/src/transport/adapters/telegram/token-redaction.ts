/**
 * The bot token masked in what the adapter writes: a Bot API error's text can
 * echo the bare token, which the logger's URL shapes miss
 * (design/liveness.md → Surface).
 */

import * as R from "remeda";

const REDACTED = "<redacted>";

export class TokenRedactor {
  /** The token raw and percent-encoded (`encodeURIComponent`). */
  readonly #forms: ReadonlyArray<string>;

  constructor(token: string) {
    this.#forms = R.unique([token, encodeURIComponent(token)]);
  }

  /** `value` with every form of the token masked. */
  text(value: string): string {
    return this.#forms.reduce((out, form) => out.replaceAll(form, REDACTED), value);
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
    if (!(value instanceof Error)) return value;
    const existing = copies.get(value);
    if (existing !== undefined) return existing;
    // A native error, as `value` is, with `value`'s prototype, so the logger
    // reads it as an error and names its type.
    const copy = new Error();
    Reflect.deleteProperty(copy, "stack");
    Object.setPrototypeOf(copy, Object.getPrototypeOf(value));
    copies.set(value, copy);
    // Own names, not keys: `message`, `stack` and `cause` are not enumerable,
    // and `stack` is an accessor.
    for (const key of Object.getOwnPropertyNames(value)) {
      Object.defineProperty(copy, key, {
        value: this.#copy(Reflect.get(value, key), copies),
        enumerable: Object.getOwnPropertyDescriptor(value, key)?.enumerable ?? false,
        writable: true,
        configurable: true,
      });
    }
    return copy;
  }
}
