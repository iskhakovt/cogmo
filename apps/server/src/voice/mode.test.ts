import { describe, expect, it } from "vitest";
import { resolveVoiceMode } from "./mode.js";

const baseInput = {
  adapterSupportsVoice: true,
  voiceConfigPresent: true,
  conversationMode: null,
  profileMode: "auto" as const,
  lastInboundWasVoice: true,
};

describe("resolveVoiceMode", () => {
  // Hard gates — fail fast regardless of preference.

  it("returns false when adapter doesn't support voice", () => {
    expect(
      resolveVoiceMode({
        ...baseInput,
        adapterSupportsVoice: false,
        profileMode: "always",
      }),
    ).toBe(false);
  });

  it("returns false when voice config is absent", () => {
    expect(
      resolveVoiceMode({
        ...baseInput,
        voiceConfigPresent: false,
        profileMode: "always",
      }),
    ).toBe(false);
  });

  // Effective mode resolution — conversation overrides profile.

  it("conversation override takes precedence over profile default", () => {
    expect(
      resolveVoiceMode({
        ...baseInput,
        conversationMode: "never",
        profileMode: "always",
        lastInboundWasVoice: true,
      }),
    ).toBe(false);

    expect(
      resolveVoiceMode({
        ...baseInput,
        conversationMode: "always",
        profileMode: "never",
        lastInboundWasVoice: false,
      }),
    ).toBe(true);
  });

  it("falls back to profile mode when conversation override is null", () => {
    expect(
      resolveVoiceMode({
        ...baseInput,
        conversationMode: null,
        profileMode: "always",
        lastInboundWasVoice: false,
      }),
    ).toBe(true);

    expect(
      resolveVoiceMode({
        ...baseInput,
        conversationMode: null,
        profileMode: "never",
        lastInboundWasVoice: true,
      }),
    ).toBe(false);
  });

  // auto mode — mirrors inbound modality.

  it("auto + voice inbound → true", () => {
    expect(
      resolveVoiceMode({
        ...baseInput,
        profileMode: "auto",
        lastInboundWasVoice: true,
      }),
    ).toBe(true);
  });

  it("auto + text inbound → false", () => {
    expect(
      resolveVoiceMode({
        ...baseInput,
        profileMode: "auto",
        lastInboundWasVoice: false,
      }),
    ).toBe(false);
  });

  it("auto via conversation override mirrors inbound", () => {
    expect(
      resolveVoiceMode({
        ...baseInput,
        profileMode: "never",
        conversationMode: "auto",
        lastInboundWasVoice: true,
      }),
    ).toBe(true);
  });

  // always / never — ignore lastInboundWasVoice entirely.

  it("always ignores lastInboundWasVoice", () => {
    expect(
      resolveVoiceMode({
        ...baseInput,
        profileMode: "always",
        lastInboundWasVoice: false,
      }),
    ).toBe(true);
  });

  it("never ignores lastInboundWasVoice", () => {
    expect(
      resolveVoiceMode({
        ...baseInput,
        profileMode: "never",
        lastInboundWasVoice: true,
      }),
    ).toBe(false);
  });

  // Capability gates dominate even when preference says always.

  it("never voices when adapter unsupported, even with always", () => {
    expect(
      resolveVoiceMode({
        ...baseInput,
        adapterSupportsVoice: false,
        profileMode: "always",
        conversationMode: "always",
      }),
    ).toBe(false);
  });

  it("never voices when config absent, even with always", () => {
    expect(
      resolveVoiceMode({
        ...baseInput,
        voiceConfigPresent: false,
        profileMode: "always",
      }),
    ).toBe(false);
  });
});
