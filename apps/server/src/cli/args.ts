/**
 * cmd-ts argument parsers and value types shared by `cogmo` subcommands. A
 * decoder that throws fails the parse, and cmd-ts prints its message under
 * the offending argument. No decoder sees an empty string: `runCli` refuses
 * an empty argument, and cmd-ts reads `--flag=` as no value.
 */

import { extendType, multioption, oneOf, string, type Type } from "cmd-ts";

/**
 * A name or id, not blank. An option always consumes the token after it, so
 * without this check `--provider --all` reads `--all` as the provider's name.
 */
export function identifier(displayName: string): Type<string, string> {
  return extendType(string, {
    displayName,
    async from(value) {
      if (value.trim() === "") throw new Error(`expected a value, got "${value}"`);
      if (value.startsWith("-")) throw new Error(`expected a value, got the flag "${value}"`);
      return value;
    },
  });
}

/** Free text: may start with `-`, but not blank. */
export const text: Type<string, string> = extendType(string, {
  displayName: "text",
  async from(value) {
    if (value.trim() === "") throw new Error(`expected text, got "${value}"`);
    return value;
  },
});

/** Postgres `integer`'s maximum — the columns these counts are stored in. */
const INT4_MAX = 2_147_483_647;

/**
 * Decimal digits only — `Number()` alone would take `0x10`, `1e3` and `+5` —
 * from `min` (at least 0) up to Postgres `integer`'s maximum.
 */
export function intAtLeast(min: number): Type<string, number> {
  return extendType(string, {
    displayName: "int",
    async from(value) {
      const digits = value.trim();
      const n = /^\d+$/.test(digits) ? Number(digits) : Number.NaN;
      if (!(n >= min)) throw new Error(`expected an integer >= ${min}, got "${value}"`);
      if (n > INT4_MAX) throw new Error(`expected an integer <= ${INT4_MAX}, got "${value}"`);
      return n;
    },
  });
}

/** One of `values`, shown in help as `<displayName>`. */
export function choice<T extends string>(
  values: readonly T[],
  displayName: string,
): Type<string, T> {
  return { ...oneOf(values), displayName };
}

interface OptionalOptionConfig<T> {
  long: string;
  type: Type<string, T>;
  description: string;
}

/**
 * An option that may be omitted, resolving to `undefined` when it is.
 *
 * cmd-ts's `option({ type: optional(t) })` reads an option given with no
 * value — `--context` as the last token — as omitted, so a forgotten value
 * drops the setting without a word. `multioption` rejects a bare option,
 * so this builds on it and allows at most one occurrence.
 */
export function optionalOption<T>(config: OptionalOptionConfig<T>) {
  const { long, type, description } = config;
  const parser = multioption({
    long,
    description,
    type: {
      ...(type.displayName !== undefined && { displayName: type.displayName }),
      onMissing: () => undefined,
      async from(values: string[]): Promise<T | undefined> {
        const [value, ...extra] = values;
        if (extra.length > 0) {
          throw new Error(`Too many times provided. Expected 1, got: ${values.length}`);
        }
        return value === undefined ? undefined : type.from(value);
      },
    },
  });
  return {
    ...parser,
    helpTopics: () => parser.helpTopics().map((topic) => ({ ...topic, defaults: ["optional"] })),
  };
}
