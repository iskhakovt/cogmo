import { describe, expect, it } from "vitest";
import { canonicalKeyOrder } from "./canonical-key-order.js";

describe("canonicalKeyOrder", () => {
  it("sorts object keys at every depth", () => {
    const value = { b: 1, a: { d: 2, c: { f: 3, e: 4 } } };

    expect(JSON.stringify(canonicalKeyOrder(value))).toBe('{"a":{"c":{"e":4,"f":3},"d":2},"b":1}');
  });

  it("keeps array order and sorts the objects inside arrays", () => {
    const value = { list: [3, { z: 1, y: 2 }, [{ b: 1, a: 2 }], 1] };

    expect(JSON.stringify(canonicalKeyOrder(value))).toBe(
      '{"list":[3,{"y":2,"z":1},[{"a":2,"b":1}],1]}',
    );
  });

  it("gives the same bytes for every emission order of the same key set", () => {
    const a = canonicalKeyOrder({ prompt: "p", model: "m", aspect_ratio: "1:1" });
    const b = canonicalKeyOrder({ aspect_ratio: "1:1", prompt: "p", model: "m" });
    const c = canonicalKeyOrder({ model: "m", aspect_ratio: "1:1", prompt: "p" });

    expect(JSON.stringify(a)).toBe('{"aspect_ratio":"1:1","model":"m","prompt":"p"}');
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(JSON.stringify(c)).toBe(JSON.stringify(a));
  });

  it("orders keys by UTF-16 code unit, as RFC 8785 does", () => {
    // Uppercase before lowercase, "_" between them, and a length-first order
    // (what jsonb stores) would put "b" before "aa".
    const value = { b: 1, aa: 2, _x: 3, Z: 4 };

    expect(Object.keys(canonicalKeyOrder(value))).toEqual(["Z", "_x", "aa", "b"]);
  });

  it("returns an equal value, leaving the input untouched", () => {
    const value = { b: [1, { d: null, c: true }], a: "x" };
    const before = JSON.stringify(value);

    const result = canonicalKeyOrder(value);

    expect(result).toEqual(value);
    expect(result).not.toBe(value);
    expect(JSON.stringify(value)).toBe(before);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "text"],
    ["a number", 42],
    ["a boolean", false],
  ])("passes %s through unchanged", (_label, value) => {
    expect(canonicalKeyOrder(value)).toBe(value);
  });

  it("keeps null values and empty containers", () => {
    const value = { b: null, a: {}, c: [] };

    expect(JSON.stringify(canonicalKeyOrder(value))).toBe('{"a":{},"b":null,"c":[]}');
  });

  it("keeps a parsed `__proto__` key as an own property", () => {
    // `JSON.parse` defines `__proto__` as an ordinary own key; assigning it
    // back onto an object literal would set the prototype instead and drop it.
    const value: unknown = JSON.parse('{"z":1,"__proto__":{"polluted":true}}');

    const result = canonicalKeyOrder(value);

    expect(JSON.stringify(result)).toBe('{"__proto__":{"polluted":true},"z":1}');
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });

  it("leaves non-plain objects as they are", () => {
    const date = new Date(0);

    expect(canonicalKeyOrder({ b: date, a: 1 }).b).toBe(date);
  });
});
