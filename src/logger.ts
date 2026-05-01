import pino from "pino";
import { env } from "./env.js";

export const logger = pino({
  level: env.LOG_LEVEL,
  ...(env.NODE_ENV !== "production" && {
    transport: { target: "pino-pretty" },
  }),
});
