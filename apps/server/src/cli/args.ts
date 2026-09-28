/**
 * cmd-ts argument parsers and value types shared by `cogmo` subcommands. A
 * decoder that throws fails the parse, and cmd-ts prints its message under
 * the offending argument.
 */

import { extendType, multioption, string, type Type } from "cmd-ts";

/**
 * A name or id. An option always consumes the token after it, so without
 * this check `--provider --all` reads `--all` as the provider's name.
 */
export function identifier(displayName: string): Type<string, string> {
  return extendType(string, {
    displayName,
    async from(value) {
      if (value.length === 0) throw new Error("expected a value, got an empty string");
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

/** An integer no lower than `min`, with no trailing characters. */
export function intAtLeast(min: number): Type<string, number> {
  return extendType(string, {
    displayName: "int",
    async from(value) {
      const n = Number(value.trim());
      if (value.trim() === "" || !Number.isInteger(n) || n < min) {
        throw new Error(`expected an integer >= ${min}, got "${value}"`);
      }
      return n;
    },
  });
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
