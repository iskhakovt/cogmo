import { describe, expect, it } from "vitest";
import { ServiceUrlSchema } from "./env.js";

describe("ServiceUrlSchema", () => {
  it.each([
    "http://hindsight:8888",
    "https://gateway.internal/hindsight/",
    "http://inngest:8288/?tenant=a",
  ])("accepts %s", (value) => {
    expect(ServiceUrlSchema.safeParse(value).success).toBe(true);
  });

  it.each(["http://operator:s3cret@hindsight:8888", "http://operator@inngest:8288"])(
    "rejects %s without echoing it in the issue",
    (value) => {
      const result = ServiceUrlSchema.safeParse(value);

      expect(result.success).toBe(false);
      const issues = JSON.stringify(result.error?.issues);
      expect(issues).toMatch(/must not embed credentials/);
      expect(issues).not.toContain("s3cret");
      expect(issues).not.toContain("operator");
    },
  );

  it("still rejects a value that isn't a URL", () => {
    expect(ServiceUrlSchema.safeParse("not a url").success).toBe(false);
  });
});
