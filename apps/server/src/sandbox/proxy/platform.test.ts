import { describe, expect, it } from "vitest";
import { isHostPlatform } from "./platform.js";

describe("isHostPlatform", () => {
  it.each([
    ["amd64", "linux"],
    ["amd64", "Linux/x86_64"],
    ["amd64", "linux/x86-64"],
    ["amd64", "linux/amd64/v1"],
    ["amd64", "x86_64"],
    ["arm64", "linux/arm64/v8"],
    ["arm64", "linux/arm64/v8.0"],
    ["arm64", "linux/aarch64/8"],
    ["arm64", "aarch64"],
    ["arm", "linux/arm"],
    ["arm", "linux/arm/v7"],
    ["arm", "linux/armhf"],
    ["arm", "arm"],
    ["386", "linux/i386"],
  ])("on %s, %s is the host", (arch, specifier) => {
    expect(isHostPlatform(specifier, { os: "linux", arch })).toBe(true);
  });
});
