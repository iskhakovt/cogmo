/**
 * The Drizzle stores every stage reads through. Stateless query objects, so
 * one set serves the whole process. The secrets store is built apart: it needs
 * the master key.
 */

import { DrizzleCodingStore } from "../agent/coding/store/index.js";
import { DrizzleModelCatalogStore } from "../agent/model-catalog/store/index.js";
import { DrizzlePipelineRunStore, DrizzlePipelineStore } from "../agent/pipeline/store/index.js";
import { DrizzleAgentStore } from "../agent/store/index.js";
import { DrizzleMcpStore } from "../mcp/store/index.js";
import { DrizzleSandboxStore } from "../sandbox/store/index.js";
import { DrizzleSkillStore } from "../skills/store/index.js";
import { DrizzleTransportStore } from "../transport/store/index.js";
import { DrizzleWebSessionStore } from "../web/store/index.js";

export interface Stores {
  agentStore: DrizzleAgentStore;
  transportStore: DrizzleTransportStore;
  sandboxStore: DrizzleSandboxStore;
  codingStore: DrizzleCodingStore;
  modelCatalogStore: DrizzleModelCatalogStore;
  pipelineStore: DrizzlePipelineStore;
  pipelineRunStore: DrizzlePipelineRunStore;
  mcpStore: DrizzleMcpStore;
  skillStore: DrizzleSkillStore;
  webSessionStore: DrizzleWebSessionStore;
}

export function createStores(): Stores {
  return {
    agentStore: new DrizzleAgentStore(),
    transportStore: new DrizzleTransportStore(),
    sandboxStore: new DrizzleSandboxStore(),
    codingStore: new DrizzleCodingStore(),
    modelCatalogStore: new DrizzleModelCatalogStore(),
    pipelineStore: new DrizzlePipelineStore(),
    pipelineRunStore: new DrizzlePipelineRunStore(),
    mcpStore: new DrizzleMcpStore(),
    skillStore: new DrizzleSkillStore(),
    webSessionStore: new DrizzleWebSessionStore(),
  };
}
