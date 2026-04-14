import { Marked } from "marked";
import type { RenderedMessage } from "../../adapter-module.js";

/**
 * Convert canonical markdown to Telegram's HTML subset.
 *
 * Pipeline: preprocess → marked GFM→HTML → post-process (strip unsupported tags,
 * convert to Telegram-supported HTML subset).
 *
 * Informed by OpenClaw production issues:
 * - Tables → <pre> wrapping (Telegram can't render tables)
 * - Emoji + bold adjacency fix (emoji before ** breaks parsers)
 * - Native <blockquote> (Bot API 7.0+)
 *
 * Telegram supported HTML tags:
 * <b>, <i>, <s>, <u>, <code>, <pre>, <a href>, <blockquote>,
 * <tg-spoiler>, <span class="tg-spoiler">
 */

// --- Preprocessing ---

/**
 * Insert space between emoji and ** markers to prevent parser breakage.
 * OpenClaw fix: emoji codepoints directly before ** produce raw asterisks.
 */
const EMOJI_BOLD_RE = /(\p{Emoji_Presentation})\*\*/gu;

function preprocess(markdown: string): string {
  return markdown.replace(EMOJI_BOLD_RE, "$1 **");
}

// --- Marked setup ---

const marked = new Marked({ gfm: true, breaks: false });

// --- Post-processing ---

/** Escape HTML entities in text content. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Convert standard HTML from marked into Telegram's HTML subset.
 *
 * Strategy: regex-based tag replacement. This is intentionally not a DOM parser —
 * we need a fast, dependency-free transform on well-formed marked output.
 */
function telegramize(html: string): string {
  let result = html;

  // --- Block-level transforms (order matters) ---

  // Tables → wrap in <pre> (OpenClaw pattern: server-side table conversion)
  result = result.replace(/<table[\s\S]*?<\/table>/gi, (table) => {
    // Strip all HTML tags inside the table, preserve text content
    const text = table
      .replace(/<\/?(?:table|thead|tbody|tfoot|tr|th|td)[^>]*>/gi, "")
      .replace(/<br\s*\/?>/gi, "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join("\n");
    return `<pre>${escapeHtml(text)}</pre>`;
  });

  // Headings → bold + newlines
  result = result.replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, "\n<b>$1</b>\n");

  // Paragraphs → strip tags, add newlines (use \b to avoid matching <pre>)
  result = result.replace(/<p\b[^>]*>/gi, "");
  result = result.replace(/<\/p>/gi, "\n\n");

  // Blockquotes → native <blockquote> (Bot API 7.0+)
  // marked wraps content in <p>, which we already stripped
  result = result.replace(/<blockquote[^>]*>/gi, "<blockquote>");
  result = result.replace(/<\/blockquote>/gi, "</blockquote>");

  // Unordered lists
  result = result.replace(/<ul[^>]*>/gi, "");
  result = result.replace(/<\/ul>/gi, "\n");

  // Ordered lists
  result = result.replace(/<ol[^>]*>/gi, "");
  result = result.replace(/<\/ol>/gi, "\n");

  // List items — always bullets (Telegram renders both list types the same)
  result = result.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, content: string) => {
    const trimmed = content.replace(/\n+/g, " ").trim();
    return `• ${trimmed}\n`;
  });

  // <br> → newline
  result = result.replace(/<br\s*\/?>/gi, "\n");

  // <hr> → empty
  result = result.replace(/<hr\s*\/?>/gi, "");

  // --- Inline transforms ---

  // Bold: <strong> → <b>
  result = result.replace(/<strong[^>]*>/gi, "<b>");
  result = result.replace(/<\/strong>/gi, "</b>");

  // Italic: <em> → <i>
  result = result.replace(/<em[^>]*>/gi, "<i>");
  result = result.replace(/<\/em>/gi, "</i>");

  // Strikethrough: <del> → <s>
  result = result.replace(/<del[^>]*>/gi, "<s>");
  result = result.replace(/<\/del>/gi, "</s>");

  // Code: keep <code> and <pre> (already Telegram-compatible)
  // Preserve language class on code blocks for Telegram copy button
  // <pre><code class="language-ts"> → <pre><code class="language-ts">

  // Links: keep <a href="..."> (already Telegram-compatible)
  // Strip title attribute if present
  result = result.replace(/<a\s+href="([^"]*)"[^>]*>/gi, '<a href="$1">');

  // Images: strip (Telegram doesn't render inline images in text)
  result = result.replace(/<img[^>]*>/gi, "");

  // --- Cleanup: strip any remaining unsupported HTML tags ---
  // Keep: b, i, s, u, code, pre, a, blockquote, tg-spoiler, span
  const ALLOWED_TAGS = /^\/?(b|i|s|u|code|pre|a|blockquote|tg-spoiler|span)([\s>]|$)/i;
  result = result.replace(/<\/?([^>]+)>/g, (match, tagContent: string) => {
    if (ALLOWED_TAGS.test(tagContent)) return match;
    return "";
  });

  // Collapse excessive newlines (more than 2 → 2)
  result = result.replace(/\n{3,}/g, "\n\n");

  // Trim
  result = result.trim();

  return result;
}

/**
 * Render canonical markdown to Telegram HTML.
 *
 * Pure function — no I/O, no state. Safe to call from tests.
 */
export function renderTelegramHtml(markdown: string): RenderedMessage {
  if (!markdown.trim()) {
    return { text: "" };
  }

  const preprocessed = preprocess(markdown);
  const rawHtml = marked.parse(preprocessed) as string;
  const telegramHtml = telegramize(rawHtml);

  return {
    text: telegramHtml,
    parseMode: "HTML",
  };
}
