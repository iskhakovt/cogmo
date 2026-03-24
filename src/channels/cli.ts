import * as crypto from "node:crypto";
import * as readline from "node:readline";
import { logger } from "../logger.js";
import type { Channel, InboundMessage } from "./types.js";

/**
 * CLI channel adapter — stdin for input, stdout for output.
 *
 * Used for local testing without Telegram. Sends InboundMessage objects
 * via a callback (typically wired to send an Inngest event).
 */
export class CliChannel implements Channel {
  readonly name = "cli";
  private rl: readline.Interface | null = null;
  private chatId: string = crypto.randomUUID();

  /**
   * Start reading stdin. Each line becomes an InboundMessage
   * dispatched via the onMessage callback.
   */
  start(onMessage: (msg: InboundMessage) => void): void {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "> ",
    });

    this.rl.prompt();

    this.rl.on("line", (line) => {
      const text = line.trim();
      if (!text) {
        this.rl?.prompt();
        return;
      }

      if (text === "/new") {
        this.chatId = crypto.randomUUID();
        logger.info({ chatId: this.chatId }, "new chat session");
        this.rl?.prompt();
        return;
      }

      onMessage({
        channel: this.name,
        chatId: this.chatId,
        userId: "cli-user",
        text,
        timestamp: new Date(),
      });
    });

    this.rl.on("close", () => {
      logger.info("cli channel closed");
    });
  }

  /**
   * Write a response to stdout. Called by the cli-respond Inngest function.
   */
  write(text: string): void {
    console.log(`\n${text}\n`);
    this.rl?.prompt();
  }

  stop(): void {
    this.rl?.close();
    this.rl = null;
  }
}
