import { type TransportError, TransportErrorSchema } from "@cogmo/contracts";
import { describe, expect, it } from "vitest";

// The compile-time schema↔union parity guard lives next to the schema in
// `packages/contracts/src/transport-error-schema.ts`. This covers runtime parse
// behaviour for a representative of each field-shape.
const SAMPLES: TransportError[] = [
  { code: "identity_rejected" },
  { code: "session_not_found", sessionId: "s1" },
  { code: "profile_class_in_use", profileRefs: 2 },
  { code: "compartment_cap_exceeded", limit: 5, current: 5 },
  { code: "repo_in_use", name: "r", activeTasks: 1 },
  { code: "mcp_tool_not_found", serverId: "srv", toolName: "t" },
  { code: "skill_deploy_register_failed", pendingId: "p", reason: "boom" },
  { code: "evolution_unavailable" },
];

describe("TransportErrorSchema", () => {
  it.each(SAMPLES)("parses the $code variant", (sample) => {
    expect(TransportErrorSchema.parse(sample)).toEqual(sample);
  });

  it("rejects an unknown code", () => {
    expect(() => TransportErrorSchema.parse({ code: "not_a_real_code" })).toThrow();
  });

  it("rejects a known code missing its required field", () => {
    expect(() => TransportErrorSchema.parse({ code: "session_not_found" })).toThrow();
  });
});
