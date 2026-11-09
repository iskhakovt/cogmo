import { create, type MessageInitShape } from "@bufbuild/protobuf";
import {
  JobErrorCode,
  JobEventSchema,
  type JobResult,
  JobResultSchema,
} from "@cogmo/connector-proto";
import { err, ok } from "neverthrow";
import { describe, expect, it } from "vitest";
import { completionOf, failureCodeOf, reportOf } from "./translate.js";

function result(init: MessageInitShape<typeof JobResultSchema>): JobResult {
  return create(JobResultSchema, init);
}

describe("completionOf", () => {
  it("maps each phase's result", () => {
    expect(completionOf("prepare", result({ result: { case: "prepared", value: {} } }))).toEqual(
      ok({ phase: "prepare" }),
    );
    expect(
      completionOf(
        "plan",
        result({ result: { case: "plan", value: { plan: "p", agentSessionId: "s" } } }),
      ),
    ).toEqual(ok({ phase: "plan", plan: "p", agentSessionId: "s" }));
    expect(
      completionOf("publish", result({ result: { case: "published", value: { headSha: "abc" } } })),
    ).toEqual(ok({ phase: "publish", headSha: "abc" }));
  });

  it("maps an execute result with usage, and one without", () => {
    expect(
      completionOf(
        "execute",
        result({
          result: {
            case: "executed",
            value: { usage: { inputTokens: 10n, outputTokens: 20n, costUsd: 0.5 } },
          },
        }),
      ),
    ).toEqual(ok({ phase: "execute", usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.5 } }));
    expect(completionOf("execute", result({ result: { case: "executed", value: {} } }))).toEqual(
      ok({ phase: "execute", usage: null }),
    );
  });

  it("maps a verify verdict that exited, one that timed out, and refuses one with neither", () => {
    expect(
      completionOf(
        "verify",
        result({
          result: {
            case: "verify",
            value: { outcome: { case: "exitCode", value: 0 }, outputTail: "ok" },
          },
        }),
      ),
    ).toEqual(ok({ phase: "verify", outcome: { kind: "exited", exitCode: 0 }, outputTail: "ok" }));
    expect(
      completionOf(
        "verify",
        result({
          result: {
            case: "verify",
            value: { outcome: { case: "timedOut", value: {} }, outputTail: "slow" },
          },
        }),
      ),
    ).toEqual(ok({ phase: "verify", outcome: { kind: "timed_out" }, outputTail: "slow" }));
    expect(
      completionOf("verify", result({ result: { case: "verify", value: { outputTail: "x" } } })),
    ).toEqual(err("a verify verdict carries no outcome"));
  });

  it("maps each release outcome, and refuses a release with none", () => {
    const released = (outcome: MessageInitShape<typeof JobResultSchema>) =>
      completionOf("release", result(outcome));
    expect(
      released({
        result: { case: "released", value: { outcome: { case: "removedClean", value: {} } } },
      }),
    ).toEqual(ok({ phase: "release", outcome: { kind: "removed_clean" } }));
    expect(
      released({
        result: {
          case: "released",
          value: {
            outcome: {
              case: "salvagedAndRemoved",
              value: { salvageRef: "refs/cogmo-wip/t", sha: "abc" },
            },
          },
        },
      }),
    ).toEqual(
      ok({
        phase: "release",
        outcome: { kind: "salvaged_and_removed", salvageRef: "refs/cogmo-wip/t", sha: "abc" },
      }),
    );
    expect(
      released({
        result: {
          case: "released",
          value: { outcome: { case: "kept", value: { reason: "push failed" } } },
        },
      }),
    ).toEqual(ok({ phase: "release", outcome: { kind: "kept", reason: "push failed" } }));
    expect(released({ result: { case: "released", value: {} } })).toEqual(
      err("a release result carries no outcome"),
    );
  });

  it("refuses a result whose case doesn't match the phase, or that has none", () => {
    expect(completionOf("plan", result({ result: { case: "prepared", value: {} } }))).toEqual(
      err("a plan job completes with a plan result, not prepared"),
    );
    expect(completionOf("prepare", result({}))).toEqual(
      err("a prepare job completes with a prepared result, not none"),
    );
  });
});

describe("failureCodeOf", () => {
  it.each([
    [JobErrorCode.UNSPECIFIED, "unspecified"],
    [JobErrorCode.AGENT_FAILED, "agent_failed"],
    [JobErrorCode.NO_PLAN, "no_plan"],
    [JobErrorCode.SESSION_LOST, "session_lost"],
    [JobErrorCode.BRANCH_CONFLICT, "branch_conflict"],
    [JobErrorCode.PUSH_AUTH_FAILED, "push_auth_failed"],
    [JobErrorCode.PUSH_FAILED, "push_failed"],
    [JobErrorCode.WORKSPACE_FAILED, "workspace_failed"],
    [JobErrorCode.JOB_CONFLICT, "job_conflict"],
    [JobErrorCode.UNSUPPORTED, "unsupported"],
  ])("maps code %i to %s", (code, expected) => {
    expect(failureCodeOf(code)).toBe(expected);
  });

  it("maps a code this build doesn't know to unknown", () => {
    // An open enum carries values from a newer connector.
    expect(failureCodeOf(99 as JobErrorCode)).toBe("unknown");
  });
});

describe("reportOf", () => {
  it("maps each event kind", () => {
    expect(
      reportOf(create(JobEventSchema, { seq: 1n, event: { case: "textDelta", value: "hi" } })),
    ).toEqual({ kind: "text_delta", text: "hi" });
    expect(
      reportOf(
        create(JobEventSchema, { seq: 1n, event: { case: "toolCall", value: { name: "Bash" } } }),
      ),
    ).toEqual({ kind: "tool_call", name: "Bash" });
    expect(
      reportOf(
        create(JobEventSchema, {
          seq: 1n,
          event: { case: "toolResult", value: { name: "Bash", ok: false, summary: "exit 1" } },
        }),
      ),
    ).toEqual({ kind: "tool_result", name: "Bash", ok: false, summary: "exit 1" });
  });

  it("maps usage, an absent count or cost to null", () => {
    expect(
      reportOf(
        create(JobEventSchema, {
          seq: 1n,
          event: { case: "usage", value: { inputTokens: 5n, costUsd: 0.25 } },
        }),
      ),
    ).toEqual({ kind: "usage", usage: { inputTokens: 5, outputTokens: null, costUsd: 0.25 } });
    expect(
      reportOf(create(JobEventSchema, { seq: 1n, event: { case: "usage", value: {} } })),
    ).toEqual({ kind: "usage", usage: { inputTokens: null, outputTokens: null, costUsd: null } });
  });

  it("returns null for an event of a kind this build doesn't know", () => {
    expect(reportOf(create(JobEventSchema, { seq: 1n }))).toBeNull();
  });
});
