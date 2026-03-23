import { Inngest } from "inngest";

export const inngest = new Inngest({
  id: "assistant",
  isDev: process.env.INNGEST_DEV === "true" || process.env.INNGEST_DEV === "1",
});
