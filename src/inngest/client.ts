import { Inngest } from "inngest";

export const inngest = new Inngest({
  id: "cogmo",
  isDev: process.env.INNGEST_DEV === "true" || process.env.INNGEST_DEV === "1",
});
