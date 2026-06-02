/**
 * The four top-level sections of the cockpit — drives the nav and the cmdk palette.
 * `as const` keeps `to` as the literal-path union so `Link`/`navigate` type-check each
 * destination against the registered routes; a typo'd path is a compile error.
 */
export const SECTIONS = [
  { to: "/chat", label: "Chat" },
  { to: "/memory", label: "Memory" },
  { to: "/agent", label: "Agent" },
  { to: "/system", label: "System" },
] as const;

export type Section = (typeof SECTIONS)[number];
