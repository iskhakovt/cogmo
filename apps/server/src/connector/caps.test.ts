import { create } from "@bufbuild/protobuf";
import { JobSchema } from "@cogmo/connector-proto";
import { expect, it } from "vitest";
import { jobCaps } from "./caps.js";

function verifySpec(timeoutSeconds: number) {
  return create(JobSchema, {
    jobId: "task-1/verify/d",
    taskId: "task-1",
    spec: { case: "verify", value: { command: "pnpm test", timeoutSeconds } },
  }).spec;
}

it("caps verify at its timeout plus 60 s", () => {
  expect(jobCaps(verifySpec(600))).toEqual({ totalMs: 660_000, idleMs: null });
});

it("holds a verify cap to the longest delay a timer takes", () => {
  expect(jobCaps(verifySpec(4_294_967_295)).totalMs).toBe(2_147_483_647);
});
