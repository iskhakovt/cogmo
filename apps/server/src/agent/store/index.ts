/**
 * The agent domain's stores, one per aggregate, and `AgentStore`: their
 * composition, for callers that span several.
 */

import { type CompartmentStore, DrizzleCompartmentStore } from "./compartments.js";
import { type ConversationStore, DrizzleConversationStore } from "./conversations.js";
import { type CoreMemoryStore, DrizzleCoreMemoryStore } from "./core-memory.js";
import { DrizzleEvolutionEventStore, type EvolutionEventStore } from "./evolution-events.js";
import { DrizzleImageProviderStore, type ImageProviderStore } from "./image-providers.js";
import { DrizzleLlmProviderStore, type LlmProviderStore } from "./llm-providers.js";
import { DrizzlePendingMemoryStore, type PendingMemoryStore } from "./pending-memories.js";
import { DrizzleProfileClassStore, type ProfileClassStore } from "./profile-classes.js";
import { DrizzleProfileStore, type ProfileStore } from "./profiles.js";
import { DrizzleScheduledTaskStore, type ScheduledTaskStore } from "./scheduled-tasks.js";
import { DrizzleSteeringRuleStore, type SteeringRuleStore } from "./steering-rules.js";
import { DrizzleSubAgentStore, type SubAgentStore } from "./sub-agents.js";
import { DrizzleTranscriptStore, type TranscriptStore } from "./transcript.js";
import { DrizzleUserStore, type UserStore } from "./users.js";
import { DrizzleVoiceConfigStore, type VoiceConfigStore } from "./voice-config.js";

export * from "./compartments.js";
export * from "./conversations.js";
export * from "./core-memory.js";
export * from "./evolution-events.js";
export * from "./image-providers.js";
export * from "./llm-providers.js";
export * from "./pending-memories.js";
export * from "./profile-classes.js";
export * from "./profiles.js";
export * from "./scheduled-tasks.js";
export * from "./steering-rules.js";
export * from "./sub-agents.js";
export * from "./transcript.js";
export * from "./users.js";
export * from "./voice-config.js";

/** Every agent-domain store. Depend on the narrow one a caller uses. */
export interface AgentStore
  extends UserStore,
    ProfileStore,
    ProfileClassStore,
    CompartmentStore,
    CoreMemoryStore,
    ConversationStore,
    TranscriptStore,
    SteeringRuleStore,
    PendingMemoryStore,
    ScheduledTaskStore,
    EvolutionEventStore,
    LlmProviderStore,
    ImageProviderStore,
    SubAgentStore,
    VoiceConfigStore {}

/** `AgentStore` over the per-aggregate Drizzle stores, each method delegating to its own. */
export class DrizzleAgentStore implements AgentStore {
  readonly #users = new DrizzleUserStore();
  readonly #profiles = new DrizzleProfileStore();
  readonly #profileClasses = new DrizzleProfileClassStore();
  readonly #compartments = new DrizzleCompartmentStore();
  readonly #coreMemory = new DrizzleCoreMemoryStore();
  readonly #conversations = new DrizzleConversationStore();
  readonly #transcript = new DrizzleTranscriptStore();
  readonly #steeringRules = new DrizzleSteeringRuleStore();
  readonly #pendingMemories = new DrizzlePendingMemoryStore();
  readonly #scheduledTasks = new DrizzleScheduledTaskStore();
  readonly #evolutionEvents = new DrizzleEvolutionEventStore();
  readonly #llmProviders = new DrizzleLlmProviderStore();
  readonly #imageProviders = new DrizzleImageProviderStore();
  readonly #subAgents = new DrizzleSubAgentStore();
  readonly #voiceConfig = new DrizzleVoiceConfigStore();

  readonly createUser = this.#users.createUser.bind(this.#users);
  readonly getFirstUser = this.#users.getFirstUser.bind(this.#users);

  readonly getProfile = this.#profiles.getProfile.bind(this.#profiles);
  readonly getDefaultProfile = this.#profiles.getDefaultProfile.bind(this.#profiles);
  readonly createProfile = this.#profiles.createProfile.bind(this.#profiles);
  readonly insertOrRecoverProfile = this.#profiles.insertOrRecoverProfile.bind(this.#profiles);
  readonly listProfiles = this.#profiles.listProfiles.bind(this.#profiles);
  readonly getProfileOwner = this.#profiles.getProfileOwner.bind(this.#profiles);
  readonly updateProfile = this.#profiles.updateProfile.bind(this.#profiles);
  readonly countProfileReferences = this.#profiles.countProfileReferences.bind(this.#profiles);
  readonly deleteProfile = this.#profiles.deleteProfile.bind(this.#profiles);
  readonly setProfileClass = this.#profiles.setProfileClass.bind(this.#profiles);

  readonly listProfileClasses = this.#profileClasses.listProfileClasses.bind(this.#profileClasses);
  readonly createProfileClass = this.#profileClasses.createProfileClass.bind(this.#profileClasses);
  readonly deleteProfileClass = this.#profileClasses.deleteProfileClass.bind(this.#profileClasses);
  readonly setProfileClassRestricted = this.#profileClasses.setProfileClassRestricted.bind(
    this.#profileClasses,
  );

  readonly listCustomCompartments = this.#compartments.listCustomCompartments.bind(
    this.#compartments,
  );
  readonly createCustomCompartment = this.#compartments.createCustomCompartment.bind(
    this.#compartments,
  );
  readonly deleteCustomCompartment = this.#compartments.deleteCustomCompartment.bind(
    this.#compartments,
  );

  readonly getCoreMemoryBlocks = this.#coreMemory.getCoreMemoryBlocks.bind(this.#coreMemory);
  readonly upsertCoreMemoryBlock = this.#coreMemory.upsertCoreMemoryBlock.bind(this.#coreMemory);
  readonly deleteCoreMemoryBlock = this.#coreMemory.deleteCoreMemoryBlock.bind(this.#coreMemory);
  readonly getCoreMemoryUpdateTimes = this.#coreMemory.getCoreMemoryUpdateTimes.bind(
    this.#coreMemory,
  );
  readonly listCoreMemoryKeys = this.#coreMemory.listCoreMemoryKeys.bind(this.#coreMemory);

  readonly createConversation = this.#conversations.createConversation.bind(this.#conversations);
  readonly getConversation = this.#conversations.getConversation.bind(this.#conversations);
  readonly writeCooldownState = this.#conversations.writeCooldownState.bind(this.#conversations);
  readonly clearCooldown = this.#conversations.clearCooldown.bind(this.#conversations);
  readonly setConversationVoiceMode = this.#conversations.setConversationVoiceMode.bind(
    this.#conversations,
  );
  readonly findMostRecentConversationForUserProfile =
    this.#conversations.findMostRecentConversationForUserProfile.bind(this.#conversations);
  readonly listConversationsForUser = this.#conversations.listConversationsForUser.bind(
    this.#conversations,
  );
  readonly setConversationProfile = this.#conversations.setConversationProfile.bind(
    this.#conversations,
  );
  readonly setAlias = this.#conversations.setAlias.bind(this.#conversations);
  readonly findConversationByAlias = this.#conversations.findConversationByAlias.bind(
    this.#conversations,
  );
  readonly getAliasForConversation = this.#conversations.getAliasForConversation.bind(
    this.#conversations,
  );
  readonly getConversationStats = this.#conversations.getConversationStats.bind(
    this.#conversations,
  );

  readonly insertMessage = this.#transcript.insertMessage.bind(this.#transcript);
  readonly findUserMessageByInbound = this.#transcript.findUserMessageByInbound.bind(
    this.#transcript,
  );
  readonly insertMessages = this.#transcript.insertMessages.bind(this.#transcript);
  readonly getLastAssistantMessage = this.#transcript.getLastAssistantMessage.bind(
    this.#transcript,
  );
  readonly listMessages = this.#transcript.listMessages.bind(this.#transcript);
  readonly getLatestSummary = this.#transcript.getLatestSummary.bind(this.#transcript);
  readonly insertOrRecoverTurnContext = this.#transcript.insertOrRecoverTurnContext.bind(
    this.#transcript,
  );
  readonly listTurnContexts = this.#transcript.listTurnContexts.bind(this.#transcript);
  readonly getLatestSystemPromptSnapshot = this.#transcript.getLatestSystemPromptSnapshot.bind(
    this.#transcript,
  );
  readonly insertOrRecoverSystemPromptSnapshot =
    this.#transcript.insertOrRecoverSystemPromptSnapshot.bind(this.#transcript);
  readonly insertOrRecoverSummary = this.#transcript.insertOrRecoverSummary.bind(this.#transcript);
  readonly getHistoryAfter = this.#transcript.getHistoryAfter.bind(this.#transcript);
  readonly getMessage = this.#transcript.getMessage.bind(this.#transcript);
  readonly getLastMessageTime = this.#transcript.getLastMessageTime.bind(this.#transcript);
  readonly getLastTokens = this.#transcript.getLastTokens.bind(this.#transcript);

  readonly getActiveRules = this.#steeringRules.getActiveRules.bind(this.#steeringRules);
  readonly hasChannelDefaults = this.#steeringRules.hasChannelDefaults.bind(this.#steeringRules);
  readonly insertSeedRule = this.#steeringRules.insertSeedRule.bind(this.#steeringRules);
  readonly getCorrections = this.#steeringRules.getCorrections.bind(this.#steeringRules);
  readonly getInstructionRules = this.#steeringRules.getInstructionRules.bind(this.#steeringRules);
  readonly hasInstructionRule = this.#steeringRules.hasInstructionRule.bind(this.#steeringRules);
  readonly upsertCorrection = this.#steeringRules.upsertCorrection.bind(this.#steeringRules);
  readonly contradictLearningRule = this.#steeringRules.contradictLearningRule.bind(
    this.#steeringRules,
  );
  readonly getMemoryRules = this.#steeringRules.getMemoryRules.bind(this.#steeringRules);
  readonly countActiveLearnedRules = this.#steeringRules.countActiveLearnedRules.bind(
    this.#steeringRules,
  );
  readonly replaceRules = this.#steeringRules.replaceRules.bind(this.#steeringRules);
  readonly setInstructionRule = this.#steeringRules.setInstructionRule.bind(this.#steeringRules);
  readonly retireRulesByText = this.#steeringRules.retireRulesByText.bind(this.#steeringRules);
  readonly listRules = this.#steeringRules.listRules.bind(this.#steeringRules);

  readonly stagePendingMemory = this.#pendingMemories.stagePendingMemory.bind(
    this.#pendingMemories,
  );
  readonly bulkStagePendingMemories = this.#pendingMemories.bulkStagePendingMemories.bind(
    this.#pendingMemories,
  );
  readonly getPendingMemories = this.#pendingMemories.getPendingMemories.bind(
    this.#pendingMemories,
  );
  readonly countPendingMemories = this.#pendingMemories.countPendingMemories.bind(
    this.#pendingMemories,
  );
  readonly deletePendingMemories = this.#pendingMemories.deletePendingMemories.bind(
    this.#pendingMemories,
  );

  readonly createScheduledTask = this.#scheduledTasks.createScheduledTask.bind(
    this.#scheduledTasks,
  );
  readonly createOrRecoverScheduledTask = this.#scheduledTasks.createOrRecoverScheduledTask.bind(
    this.#scheduledTasks,
  );
  readonly getScheduledTask = this.#scheduledTasks.getScheduledTask.bind(this.#scheduledTasks);
  readonly getScheduledTaskByIdempotencyKey =
    this.#scheduledTasks.getScheduledTaskByIdempotencyKey.bind(this.#scheduledTasks);
  readonly listScheduledTasks = this.#scheduledTasks.listScheduledTasks.bind(this.#scheduledTasks);
  readonly countScheduledTasks = this.#scheduledTasks.countScheduledTasks.bind(
    this.#scheduledTasks,
  );
  readonly lockDueScheduledTasks = this.#scheduledTasks.lockDueScheduledTasks.bind(
    this.#scheduledTasks,
  );
  readonly advanceScheduledTask = this.#scheduledTasks.advanceScheduledTask.bind(
    this.#scheduledTasks,
  );
  readonly setScheduledTaskEnabled = this.#scheduledTasks.setScheduledTaskEnabled.bind(
    this.#scheduledTasks,
  );
  readonly deleteScheduledTask = this.#scheduledTasks.deleteScheduledTask.bind(
    this.#scheduledTasks,
  );

  readonly recordEvolutionEvent = this.#evolutionEvents.recordEvolutionEvent.bind(
    this.#evolutionEvents,
  );
  readonly listEvolutionEvents = this.#evolutionEvents.listEvolutionEvents.bind(
    this.#evolutionEvents,
  );
  readonly getEvolutionEvent = this.#evolutionEvents.getEvolutionEvent.bind(this.#evolutionEvents);

  readonly listDistinctUserSelectableModels =
    this.#llmProviders.listDistinctUserSelectableModels.bind(this.#llmProviders);
  readonly isModelUserSelectable = this.#llmProviders.isModelUserSelectable.bind(
    this.#llmProviders,
  );
  readonly createProvider = this.#llmProviders.createProvider.bind(this.#llmProviders);
  readonly getProvider = this.#llmProviders.getProvider.bind(this.#llmProviders);
  readonly listProviders = this.#llmProviders.listProviders.bind(this.#llmProviders);
  readonly setProviderCacheDialect = this.#llmProviders.setProviderCacheDialect.bind(
    this.#llmProviders,
  );
  readonly deleteProvider = this.#llmProviders.deleteProvider.bind(this.#llmProviders);
  readonly addModelProvider = this.#llmProviders.addModelProvider.bind(this.#llmProviders);
  readonly setModelProviderExtraBody = this.#llmProviders.setModelProviderExtraBody.bind(
    this.#llmProviders,
  );
  readonly listProvidersForModel = this.#llmProviders.listProvidersForModel.bind(
    this.#llmProviders,
  );
  readonly listAllModelProviders = this.#llmProviders.listAllModelProviders.bind(
    this.#llmProviders,
  );
  readonly getNextModelProviderPosition = this.#llmProviders.getNextModelProviderPosition.bind(
    this.#llmProviders,
  );
  readonly removeModelProvidersByProvider = this.#llmProviders.removeModelProvidersByProvider.bind(
    this.#llmProviders,
  );
  readonly removeModelProvider = this.#llmProviders.removeModelProvider.bind(this.#llmProviders);
  readonly listAllModels = this.#llmProviders.listAllModels.bind(this.#llmProviders);

  readonly createImageProvider = this.#imageProviders.createImageProvider.bind(
    this.#imageProviders,
  );
  readonly getImageProvider = this.#imageProviders.getImageProvider.bind(this.#imageProviders);
  readonly findImageProviderByName = this.#imageProviders.findImageProviderByName.bind(
    this.#imageProviders,
  );
  readonly listImageProviders = this.#imageProviders.listImageProviders.bind(this.#imageProviders);
  readonly deleteImageProvider = this.#imageProviders.deleteImageProvider.bind(
    this.#imageProviders,
  );
  readonly createImageModel = this.#imageProviders.createImageModel.bind(this.#imageProviders);
  readonly upsertImageModelsByName = this.#imageProviders.upsertImageModelsByName.bind(
    this.#imageProviders,
  );
  readonly listImageModels = this.#imageProviders.listImageModels.bind(this.#imageProviders);
  readonly listImageModelsWithProvider = this.#imageProviders.listImageModelsWithProvider.bind(
    this.#imageProviders,
  );
  readonly deleteImageModel = this.#imageProviders.deleteImageModel.bind(this.#imageProviders);

  readonly listSubAgents = this.#subAgents.listSubAgents.bind(this.#subAgents);
  readonly createSubAgent = this.#subAgents.createSubAgent.bind(this.#subAgents);
  readonly deleteSubAgent = this.#subAgents.deleteSubAgent.bind(this.#subAgents);

  readonly getVoiceConfig = this.#voiceConfig.getVoiceConfig.bind(this.#voiceConfig);
  readonly upsertVoiceConfig = this.#voiceConfig.upsertVoiceConfig.bind(this.#voiceConfig);
  readonly deleteVoiceConfig = this.#voiceConfig.deleteVoiceConfig.bind(this.#voiceConfig);
}
