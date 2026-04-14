import { describe, expect, it } from "vitest";
import { renderTelegramHtml } from "./render.js";

describe("renderTelegramHtml", () => {
  it("returns empty text for blank input", () => {
    expect(renderTelegramHtml("")).toEqual({ text: "" });
    expect(renderTelegramHtml("   ")).toEqual({ text: "" });
  });

  it("passes through plain text with HTML escaping", () => {
    const result = renderTelegramHtml("Hello & goodbye");
    expect(result.parseMode).toBe("HTML");
    expect(result.text).toContain("Hello &amp; goodbye");
  });

  it("escapes angle brackets in inline code", () => {
    const result = renderTelegramHtml("Use `x < 3` here");
    expect(result.text).toContain("&lt;");
  });

  it("converts bold", () => {
    const result = renderTelegramHtml("This is **bold** text");
    expect(result.text).toContain("<b>bold</b>");
  });

  it("converts italic", () => {
    const result = renderTelegramHtml("This is *italic* text");
    expect(result.text).toContain("<i>italic</i>");
  });

  it("converts strikethrough", () => {
    const result = renderTelegramHtml("This is ~~struck~~ text");
    expect(result.text).toContain("<s>struck</s>");
  });

  it("converts inline code", () => {
    const result = renderTelegramHtml("Use `npm install` here");
    expect(result.text).toContain("<code>npm install</code>");
  });

  it("converts code blocks", () => {
    const result = renderTelegramHtml("```typescript\nconst x = 1;\n```");
    expect(result.text).toContain("<pre>");
    expect(result.text).toContain("<code");
    expect(result.text).toContain("const x = 1;");
  });

  it("converts links", () => {
    const result = renderTelegramHtml("[click here](https://example.com)");
    expect(result.text).toContain('<a href="https://example.com">click here</a>');
  });

  it("converts headings to bold", () => {
    const result = renderTelegramHtml("# Heading 1\n\nSome text\n\n## Heading 2");
    expect(result.text).toContain("<b>Heading 1</b>");
    expect(result.text).toContain("<b>Heading 2</b>");
  });

  it("converts unordered lists to bullet points", () => {
    const result = renderTelegramHtml("- First\n- Second\n- Third");
    expect(result.text).toContain("• First");
    expect(result.text).toContain("• Second");
    expect(result.text).toContain("• Third");
  });

  it("converts blockquotes to native tag", () => {
    const result = renderTelegramHtml("> This is a quote");
    expect(result.text).toContain("<blockquote>");
    expect(result.text).toContain("This is a quote");
    expect(result.text).toContain("</blockquote>");
  });

  it("wraps tables in pre tags", () => {
    const result = renderTelegramHtml("| Name | Age |\n|------|-----|\n| Tim  | 30  |");
    expect(result.text).toContain("<pre>");
    expect(result.text).toContain("Tim");
    expect(result.text).toContain("30");
    // Should NOT contain raw table tags
    expect(result.text).not.toContain("<table");
    expect(result.text).not.toContain("<tr");
    expect(result.text).not.toContain("<td");
  });

  it("strips images", () => {
    const result = renderTelegramHtml("Text ![alt](https://img.png) more");
    expect(result.text).not.toContain("<img");
    expect(result.text).not.toContain("img.png");
  });

  it("strips horizontal rules", () => {
    const result = renderTelegramHtml("Before\n\n---\n\nAfter");
    expect(result.text).not.toContain("<hr");
    expect(result.text).toContain("Before");
    expect(result.text).toContain("After");
  });

  it("handles nested bold + italic", () => {
    const result = renderTelegramHtml("This is ***bold italic*** text");
    expect(result.text).toContain("<b>");
    expect(result.text).toContain("<i>");
  });

  it("handles emoji + bold adjacency (OpenClaw fix)", () => {
    const result = renderTelegramHtml("🔥**hot**");
    expect(result.text).toContain("<b>hot</b>");
    // Should not have raw asterisks
    expect(result.text).not.toContain("**");
  });

  it("strips unsupported HTML tags but keeps content", () => {
    const result = renderTelegramHtml("Normal text");
    // No divs, spans with classes, etc should appear
    expect(result.text).not.toMatch(/<div/);
    expect(result.text).not.toMatch(/<p>/);
  });

  it("does not collapse more than 2 newlines", () => {
    const result = renderTelegramHtml("# One\n\n\n\n# Two");
    // Should have at most 2 consecutive newlines
    expect(result.text).not.toMatch(/\n{3,}/);
  });

  it("handles code block with special characters", () => {
    const result = renderTelegramHtml("```\nif (x < 3 && y > 5) {}\n```");
    expect(result.text).toContain("<pre>");
    // Inside <pre><code>, marked handles escaping
    expect(result.text).toContain("x &lt; 3 &amp;&amp; y &gt; 5");
  });

  it("sets parseMode to HTML", () => {
    const result = renderTelegramHtml("hello");
    expect(result.parseMode).toBe("HTML");
  });
});
