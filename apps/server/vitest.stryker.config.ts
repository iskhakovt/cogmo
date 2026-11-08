import { defineConfig } from "vitest/config";
import { UNIT_PROJECT } from "./vitest.config.js";

/** The `unit` project alone: the main config's integration and e2e projects
 * carry a Docker `globalSetup` a mutation run must not start. */
export default defineConfig(UNIT_PROJECT);
