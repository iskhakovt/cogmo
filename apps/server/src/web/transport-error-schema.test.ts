import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type { TransportError } from "../transport/transport.js";
import { TransportErrorSchema } from "./transport-error-schema.js";

/**
 * Compile-time parity guard: the Zod schema and the TS union must be mutually
 * assignable. A new/renamed variant or field on either side fails typecheck
 * here (no runtime effect).
 */
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
function assertParity<_T extends true>(): void {}
assertParity<Mutual<TransportError, z.infer<typeof TransportErrorSchema>>>();

// One representative per field-shape (typed as TransportError, so each is also
// compile-checked to be a real variant).
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
