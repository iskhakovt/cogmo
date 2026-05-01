import pino from "pino";
import { bootstrapEnv } from "./env-bootstrap.js";

export const logger = pino({
  level: bootstrapEnv.LOG_LEVEL,
  ...(bootstrapEnv.NODE_ENV !== "production" && {
    transport: { target: "pino-pretty" },
  }),
});
