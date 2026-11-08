import { describe, expect, it } from "vitest";
import { canonicalJson, canonicalJsonAsSent } from "./canonical-json.js";

describe("canonicalJsonAsSent", () => {
  it("encodes a non-finite number as the null JSON sends, where canonicalJson keeps it distinct", () => {
    const value = { a: [Number.POSITIVE_INFINITY, Number.NaN], b: 1 };

    expect(canonicalJsonAsSent(value)).toBe('{"a":[null,null],"b":1}');
    expect(canonicalJsonAsSent(value)).toBe(canonicalJsonAsSent(JSON.parse(JSON.stringify(value))));
    expect(canonicalJson(value)).not.toBe(canonicalJson({ a: [null, null], b: 1 }));
  });

  it("sorts keys and keeps a parsed __proto__ key, as canonicalJson does", () => {
    const parsed = JSON.parse('{"z":1,"__proto__":{"a":1}}');

    expect(canonicalJsonAsSent(parsed)).toBe('{"__proto__":{"a":1},"z":1}');
    expect(canonicalJsonAsSent(parsed)).toBe(canonicalJson(parsed));
  });
});
