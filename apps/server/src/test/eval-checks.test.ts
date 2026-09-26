import { describe, expect, it } from "vitest";
import {
  type EvalFailure,
  REPLY_CHECKS,
  relativeTimeWords,
  staleStatus,
  summariseRates,
  wordCount,
} from "./eval-checks.js";

describe("REPLY_CHECKS", () => {
  describe("no-imperial-units", () => {
    const follows = REPLY_CHECKS["no-imperial-units"];

    it.each([
      "It stands at 1,345 m (4,411 ft) above sea level.",
      "A 4,411-foot climb.",
      "About 26.2 miles.",
      "Summer highs reach 90°F.",
      "Water boils at 212 degrees Fahrenheit.",
    ])("flags an imperial measurement: %s", (reply) => {
      expect(follows(reply)).toBe(false);
    });

    it.each([
      "Metric only, no Fahrenheit or feet.",
      "Temperatures are given in Celsius, not Fahrenheit.",
      "There are 3 left, a few feet of rope aside.",
      "It stands at 1,345 m above sea level and drops to -15 °C.",
    ])("passes a unit named without a measurement: %s", (reply) => {
      expect(follows(reply)).toBe(true);
    });
  });

  describe("max-100-words", () => {
    const follows = REPLY_CHECKS["max-100-words"];

    it("counts words, not whitespace-separated markdown", () => {
      expect(wordCount("**1. Evaporation** – the refrigerant absorbs heat")).toBe(6);
    });

    it("requires fewer than 100 words", () => {
      expect(follows(Array(99).fill("word").join(" "))).toBe(true);
      expect(follows(Array(100).fill("word").join(" "))).toBe(false);
    });

    it("ignores bullet markers and dashes when counting", () => {
      const reply = `${Array(98).fill("word").join(" ")}\n- – —\n* word`;
      expect(wordCount(reply)).toBe(99);
      expect(follows(reply)).toBe(true);
    });
  });

  it("no-list-lines flags bullet and numbered lines only", () => {
    const follows = REPLY_CHECKS["no-list-lines"];
    expect(follows("- first\n- second")).toBe(false);
    expect(follows("1. first")).toBe(false);
    expect(follows("Prose with a - dash, and 2 items.")).toBe(true);
  });

  it("no-bold flags strong emphasis only", () => {
    const follows = REPLY_CHECKS["no-bold"];
    expect(follows("A **bold** word.")).toBe(false);
    expect(follows("An *italic* word and a 2*3 product.")).toBe(true);
  });
});

describe("staleStatus", () => {
  const block = (content: string) => [{ key: "user_profile", content }];

  it("is absent when no line names the value", () => {
    expect(staleStatus(block("Location: Porto"), "Lisbon")).toBe("absent");
  });

  it("is past when every line naming the value marks it as history", () => {
    expect(staleStatus(block("Location: Porto (moved from Lisbon)"), "Lisbon")).toBe("past");
    expect(staleStatus(block("Role: at Monzo, previously Northwind"), "Northwind")).toBe("past");
    expect(
      staleStatus(
        block("Location: Porto (Europe/Lisbon) — recently relocated from Lisbon"),
        "(?<!Europe/)Lisbon",
      ),
    ).toBe("past");
  });

  it("is current when a line names the value without a past marker", () => {
    expect(staleStatus(block("Location: Lisbon"), "Lisbon")).toBe("current");
  });

  it("does not read a past marker inside a longer word", () => {
    expect(staleStatus(block("Location: Lisbon, leftover boxes"), "Lisbon")).toBe("current");
    expect(staleStatus(block("Location: Lisbon, wasabi fan"), "Lisbon")).toBe("current");
    expect(staleStatus(block("Project: NixOS migration, donee"), "NixOS")).toBe("current");
  });
});

describe("relativeTimeWords", () => {
  it("finds relative time words in order, lower-cased", () => {
    expect(
      relativeTimeWords("Location: Porto — Recently moved; left Northwind last month, 2 weeks ago"),
    ).toEqual(["recently", "last month", "ago"]);
    expect(relativeTimeWords("Tom visits next weekend; started this week, just")).toEqual([
      "next weekend",
      "this week",
      "just",
    ]);
  });

  it("passes absolute dates and words that only contain one", () => {
    expect(
      relativeTimeWords("Diagnosed coeliac (Sept 2026); adjusted plans; Justin; weekly review"),
    ).toEqual([]);
  });
});

describe("summariseRates", () => {
  interface Sample {
    repeat: number;
    group: string;
    hit: boolean;
  }
  const metrics = [{ name: "hits", of: () => true, hit: (s: Sample) => s.hit }];
  const sample = (repeat: number, hit: boolean): Sample => ({ repeat, group: "a", hit });
  const failure = (repeat: number): EvalFailure => ({ repeat, failure: "turn degraded" });

  it("counts every sample, then each repeat's own rate", () => {
    const samples = [sample(0, true), sample(0, false), sample(1, true), sample(1, true)];
    expect(summariseRates(metrics, { all: samples }, 2)).toEqual({
      completed: { all: "4/4 [2/2 2/2]" },
      hits: { all: "3/4 [1/2 2/2]" },
    });
  });

  it("counts a failed sample in `completed` and leaves it out of the other rows", () => {
    const samples = [sample(0, true), failure(0), sample(1, false)];
    expect(summariseRates(metrics, { all: samples }, 2)).toEqual({
      completed: { all: "2/3 [1/2 1/1]" },
      hits: { all: "1/2 [1/1 0/1]" },
    });
  });

  it("drops the per-repeat rates with one repeat", () => {
    expect(summariseRates(metrics, { all: [sample(0, true), failure(0)] }, 1)).toEqual({
      completed: { all: "1/2" },
      hits: { all: "1/1" },
    });
  });
});
