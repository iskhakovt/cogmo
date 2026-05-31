import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { AttachmentStore } from "../transport/attachment-store.js";
import { createDocumentTools, parseGeneratedDocumentPayload } from "./document-tools.js";
import type { Service } from "./service.js";

function stubService(): Service {
  const svc = mock<Service>();
  delete svc.coding;
  delete svc.skills;
  return svc;
}

function fakeAttachments(uploadedPath = "generated/abc.md"): AttachmentStore {
  return {
    upload: vi.fn().mockResolvedValue(uploadedPath),
    download: vi.fn(),
  };
}

describe("createDocumentTools", () => {
  it("returns a single send_document tool", () => {
    const tools = createDocumentTools(fakeAttachments());
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("send_document");
  });

  it("uploads with 'generated' prefix and returns JSON metadata", async () => {
    const attachments = fakeAttachments("generated/xyz.md");
    const [tool] = createDocumentTools(attachments);
    if (!tool) throw new Error("tool missing");

    const result = await tool.handler({ filename: "report.md", content: "# Hello" }, stubService());

    expect(attachments.upload).toHaveBeenCalledWith(
      Buffer.from("# Hello", "utf-8"),
      "text/markdown",
      "generated",
    );

    expect(JSON.parse(result)).toEqual({
      path: "generated/xyz.md",
      mediaType: "text/markdown",
      name: "report.md",
    });
  });

  it("infers mediaType from extension across the EXT_MIME map", async () => {
    const cases: Array<[string, string]> = [
      ["a.txt", "text/plain"],
      ["a.md", "text/markdown"],
      ["a.csv", "text/csv"],
      ["a.json", "application/json"],
      ["a.xml", "application/xml"],
      ["a.html", "text/html"],
      ["a.pdf", "application/pdf"],
      ["a.yaml", "application/yaml"],
      ["a.yml", "application/yaml"],
    ];
    for (const [filename, expected] of cases) {
      const attachments = fakeAttachments();
      const [tool] = createDocumentTools(attachments);
      if (!tool) throw new Error("tool missing");
      await tool.handler({ filename, content: "x" }, stubService());
      expect(attachments.upload).toHaveBeenCalledWith(expect.any(Buffer), expected, "generated");
    }
  });

  it("falls back to application/octet-stream for unknown extensions", async () => {
    const attachments = fakeAttachments();
    const [tool] = createDocumentTools(attachments);
    if (!tool) throw new Error("tool missing");

    await tool.handler({ filename: "weird.xyz", content: "x" }, stubService());

    expect(attachments.upload).toHaveBeenCalledWith(
      expect.any(Buffer),
      "application/octet-stream",
      "generated",
    );
  });

  it("falls back to application/octet-stream when filename has no extension", async () => {
    const attachments = fakeAttachments();
    const [tool] = createDocumentTools(attachments);
    if (!tool) throw new Error("tool missing");

    await tool.handler({ filename: "noext", content: "x" }, stubService());

    expect(attachments.upload).toHaveBeenCalledWith(
      expect.any(Buffer),
      "application/octet-stream",
      "generated",
    );
  });

  it("respects an explicit mediaType override", async () => {
    const attachments = fakeAttachments();
    const [tool] = createDocumentTools(attachments);
    if (!tool) throw new Error("tool missing");

    await tool.handler(
      { filename: "report.md", content: "x", mediaType: "application/x-custom" },
      stubService(),
    );

    expect(attachments.upload).toHaveBeenCalledWith(
      expect.any(Buffer),
      "application/x-custom",
      "generated",
    );
  });

  it("rejects empty filename via schema validation", async () => {
    const [tool] = createDocumentTools(fakeAttachments());
    if (!tool) throw new Error("tool missing");

    await expect(tool.handler({ filename: "", content: "x" }, stubService())).rejects.toThrow();
  });

  it("rejects empty content via schema validation", async () => {
    const [tool] = createDocumentTools(fakeAttachments());
    if (!tool) throw new Error("tool missing");

    await expect(tool.handler({ filename: "a.md", content: "" }, stubService())).rejects.toThrow();
  });

  it("is marked durable", () => {
    const [tool] = createDocumentTools(fakeAttachments());
    expect(tool?.durable).toBe(true);
  });
});

describe("parseGeneratedDocumentPayload", () => {
  it("parses a valid payload", () => {
    expect(
      parseGeneratedDocumentPayload(
        JSON.stringify({ path: "p/x.md", mediaType: "text/markdown", name: "x.md" }),
      ),
    ).toEqual({ path: "p/x.md", mediaType: "text/markdown", name: "x.md" });
  });

  it("returns null for non-JSON", () => {
    expect(parseGeneratedDocumentPayload("not json")).toBeNull();
  });

  it("returns null for non-object JSON", () => {
    expect(parseGeneratedDocumentPayload("[]")).toBeNull();
    expect(parseGeneratedDocumentPayload("42")).toBeNull();
    expect(parseGeneratedDocumentPayload("null")).toBeNull();
  });

  it("returns null when path missing", () => {
    expect(parseGeneratedDocumentPayload(JSON.stringify({ mediaType: "x", name: "y" }))).toBeNull();
  });

  it("returns null when mediaType missing", () => {
    expect(parseGeneratedDocumentPayload(JSON.stringify({ path: "x", name: "y" }))).toBeNull();
  });

  it("returns null when name missing", () => {
    expect(parseGeneratedDocumentPayload(JSON.stringify({ path: "x", mediaType: "y" }))).toBeNull();
  });

  it("returns null on wrong field types", () => {
    expect(
      parseGeneratedDocumentPayload(JSON.stringify({ path: 1, mediaType: "y", name: "z" })),
    ).toBeNull();
  });
});
