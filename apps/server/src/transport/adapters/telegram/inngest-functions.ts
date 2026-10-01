/** The Inngest functions a Telegram channel serves: coding progress, skills approval, pipeline gates, boundary-prompt cleanup. */

import type { Bot } from "grammy";
import { startCodingProgressSubscriber } from "../../../agent/coding/progress-subscriber.js";
import {
  boundaryResolvedEvent,
  codingTaskStart,
  pipelineGatePending,
  skillsDeployApprovalRequested,
} from "../../../inngest/events.js";
import type { AdapterDeps, AdapterSetupResult } from "../../adapter-module.js";
import { editResolvedBoundaryPrompt } from "./boundary-prompt-editor.js";
import { postPipelineGateKeyboard } from "./pipeline-gate-poster.js";
import { postSkillsApprovalKeyboard } from "./skills-approval-poster.js";

export function telegramFunctions(deps: AdapterDeps, bot: Bot): AdapterSetupResult["functions"] {
  const { inngest, channelId } = deps;
  // Coding-progress wiring — listen for coding/task/start, find the
  // Telegram session attached to the task's conversation, and subscribe
  // a per-task message renderer that edits in place as plan + execute
  // events stream through the registry.
  const functions: AdapterSetupResult["functions"] = [];
  if (deps.codingProgress) {
    const { codingStore, runInTx, transportStore, streamingRegistry } = deps.codingProgress;
    functions.push(
      inngest.createFunction(
        {
          id: `telegram-coding-progress-${channelId}`,
          triggers: [codingTaskStart],
          retries: 0,
          concurrency: { limit: 1, key: "event.data.taskId" },
        },
        async ({ event }) => {
          const taskId = event.data.taskId;
          const task = await runInTx((tx) => codingStore.getTask(tx, taskId));
          const taskConversationId = task?.conversationId;
          if (!taskConversationId) return { skipped: "no conversation" };

          const sessions = await runInTx((tx) =>
            transportStore.getActiveSessionsForConversation(tx, taskConversationId),
          );
          const tgSession = sessions.find((s) => s.channelId === channelId);
          if (!tgSession) return { skipped: "no telegram session for this conversation" };

          startCodingProgressSubscriber({
            taskId,
            chatId: Number(tgSession.platformAddress),
            goal: task.goal,
            bot: {
              sendMessage: (chatId, text, opts) => bot.api.sendMessage(chatId, text, opts),
              editMessageText: (chatId, messageId, text, opts) =>
                bot.api.editMessageText(chatId, messageId, text, opts),
            },
            registry: streamingRegistry,
          });
          return { subscribed: true };
        },
      ),
    );
  }

  // Skills approve-tier deploy gate — listen on
  // skills/deploy/approval-requested, post the inline keyboard message into
  // the originating conversation's session. The runner's register call has
  // already returned with status=pending_approval; the keyboard tap routes
  // straight to transport.skills.approveDeploy/denyDeploy.
  if (deps.skillsApproval) {
    const { skillStore, runInTx, transportStore } = deps.skillsApproval;
    functions.push(
      inngest.createFunction(
        {
          id: `telegram-skills-approval-${channelId}`,
          triggers: [skillsDeployApprovalRequested],
          retries: 0,
        },
        async ({ event }) =>
          postSkillsApprovalKeyboard({
            event: event.data,
            channelId,
            runInTx,
            skillStore,
            transportStore,
            sendMessage: (chatId, text, opts) => bot.api.sendMessage(chatId, text, opts),
          }),
      ),
    );
  }

  // Pipeline gate checkpoint — post the Approve / Cancel keyboard to this
  // channel's session on the run conversation when a run parks on a gate.
  // The gate's waiter owns the timeout, so a post that fails or never
  // happens cannot wedge the run.
  if (deps.pipelineGate) {
    const { runInTx, transportStore } = deps.pipelineGate;
    functions.push(
      inngest.createFunction(
        {
          id: `telegram-pipeline-gate-${channelId}`,
          triggers: [pipelineGatePending],
          retries: 0,
        },
        async ({ event }) =>
          postPipelineGateKeyboard({
            event: event.data,
            channelId,
            runInTx,
            transportStore,
            sendMessage: (chatId, text, opts) => bot.api.sendMessage(chatId, text, opts),
          }),
      ),
    );
  }

  // Boundary-prompt cleanup — listen on conversation/boundary/resolved and
  // rewrite the "Resume / Start fresh" prompt to its outcome, clearing the
  // keyboard. A button tap also drops the keyboard synchronously in its
  // callback handler; this listener owns the text edit and is the only path
  // that fires for a waiter-timeout resolution (no callback runs there).
  // Always registered — every Telegram channel can fire the boundary prompt.
  functions.push(
    inngest.createFunction(
      {
        id: `telegram-boundary-resolved-${channelId}`,
        triggers: [boundaryResolvedEvent],
        retries: 0,
      },
      async ({ event }) =>
        editResolvedBoundaryPrompt({
          event: event.data,
          channelId,
          editMessageText: (chatId, messageId, text, opts) =>
            bot.api.editMessageText(chatId, messageId, text, opts),
        }),
    ),
  );

  return functions;
}
