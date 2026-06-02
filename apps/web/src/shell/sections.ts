/** The four top-level sections of the cockpit — drives the nav and the cmdk palette. */
export interface Section {
  to: string;
  label: string;
}

export const SECTIONS: readonly Section[] = [
  { to: "/chat", label: "Chat" },
  { to: "/memory", label: "Memory" },
  { to: "/agent", label: "Agent" },
  { to: "/system", label: "System" },
];
