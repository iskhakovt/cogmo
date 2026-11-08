/// <reference path="../../test/vitest.d.ts" />

/**
 * The refusal a turn step raises, as `onFailure` receives it from a real
 * Inngest dev server. The unit test replays the SDK's serialization; this
 * pins the server's re-encoding of the step's and the function's errors,
 * which `mark-rejected-attachments` depends on.
 */

import { eventType, Inngest } from "inngest";
import { connect } from "inngest/connect";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fromStepTools } from "../inngest/durable.js";
import { createTurnStepRunner, failureCause } from "./turn-step-runner.js";

const refusedTurn = eventType("test/turn-step-runner.refused");

let connection: Awaited<ReturnType<typeof connect>>;
let client: Inngest;
const received = Promise.withResolvers<Error>();

beforeAll(async () => {
  client = new Inngest({ id: "turn-step-runner-itest", isDev: true });
  const refused = client.createFunction(
    {
      id: "refused-turn",
      triggers: [refusedTurn],
      retries: 0,
      onFailure: ({ error }) => {
        received.resolve(error);
      },
    },
    async ({ step }) => {
      const stepRun = createTurnStepRunner(fromStepTools(step).run, { cursor: "inbound-7" });
      await stepRun("llm-iter1", async () => {
        throw Object.assign(new Error("400 the PDF could not be read"), {
          name: "BadRequestError",
          status: 400,
        });
      });
    },
  );
  connection = await connect({ apps: [{ client, functions: [refused] }] });
});

afterAll(async () => {
  await connection?.close();
});

it("hands onFailure the refusal and the provider's error", { timeout: 60_000 }, async () => {
  await client.send({ name: refusedTurn.name, data: {} });

  const error = await received.promise;

  expect(error.name).toBe("NonRetriableError");
  const { refusal, cause } = failureCause(error);
  expect(refusal).toEqual({ status: 400, step: "llm-iter1", cursor: "inbound-7" });
  expect(cause).toMatchObject({
    name: "BadRequestError",
    message: "400 the PDF could not be read",
  });
});
