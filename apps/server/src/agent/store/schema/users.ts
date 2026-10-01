import { pgTable } from "drizzle-orm/pg-core";
import { pk, ts } from "../../../db/helpers.js";

export const users = pgTable("users", {
  id: pk(),
  createdAt: ts(),
});
