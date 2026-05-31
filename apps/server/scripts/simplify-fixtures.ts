#!/usr/bin/env tsx
/**
 * Simplify recorded llmock fixture match keys.
 *
 * llmock records the full prompt as the match key, which includes timestamps,
 * UUIDs, and other run-specific data. This makes fixtures brittle on replay.
 *
 * This script trims match keys to stable substrings:
 * - userMessage: extract the last meaningful sentence/phrase
 * - inputText: keep as-is (embedding text is usually stable)
 *
 * Run after `pnpm test:record` to prepare fixtures for replay.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURE_DIR = "./test/fixtures/recorded";

function simplifyUserMessage(msg: string): string {
  // For extraction prompts: match on the input text content
  const textMatch = msg.match(/Text:\n(.+?)$/s);
  if (textMatch) return textMatch[1].trim();

  // For consolidation prompts: match on a stable prefix
  if (msg.includes("memory consolidation system")) return "memory consolidation system";

  // For short messages: keep as-is
  if (msg.length < 200) return msg;

  // Fallback: last 100 chars
  return msg.slice(-100);
}

function simplifyInputText(text: string): string {
  // Strip metadata suffixes like " | Involving: user (happened in March 2026) [blue]"
  const pipeIdx = text.indexOf(" | ");
  if (pipeIdx > 0) return text.slice(0, pipeIdx);
  return text;
}

const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json") && f !== ".gitkeep");

let modified = 0;
for (const file of files) {
  const path = join(FIXTURE_DIR, file);
  const data = JSON.parse(readFileSync(path, "utf-8"));

  for (const fixture of data.fixtures) {
    const match = fixture.match;
    let changed = false;

    if (
      match.userMessage &&
      typeof match.userMessage === "string" &&
      match.userMessage.length > 50
    ) {
      match.userMessage = simplifyUserMessage(match.userMessage);
      changed = true;
    }

    if (match.inputText && typeof match.inputText === "string") {
      const simplified = simplifyInputText(match.inputText);
      if (simplified !== match.inputText) {
        match.inputText = simplified;
        changed = true;
      }
    }

    if (changed) modified++;
  }

  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

console.log(`Processed ${files.length} fixtures, simplified ${modified} match keys`);
