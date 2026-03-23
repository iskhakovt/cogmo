/**
 * Channel-agnostic inbound message.
 *
 * Every channel adapter translates its native message format into this.
 * Downstream code (orchestrator, agent) never sees channel-specific types.
 */
export interface InboundMessage {
  channel: string;
  chatId: string;
  userId: string;
  text: string;
  timestamp: Date;
}
