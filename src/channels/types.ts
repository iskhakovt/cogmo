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

/**
 * Channel adapter interface — the plugin contract for input/output transports.
 *
 * Each channel (CLI, Telegram, Slack, etc.) implements this interface.
 * The orchestrator and response handlers depend on this, never on concrete adapters.
 */
export interface Channel {
  readonly name: string;
  start(onMessage: (msg: InboundMessage) => void): void;
  write(text: string): void;
  stop(): void;
}
